/**
 * Copyright: (c) 2016 Max Klein
 * License: MIT
 */

(function (window, document, BUNDLED_RESOURCES) {
	'use strict';

	var GRAVITY = -1000;

	var PLAYER_SPEED = 300;
	var PLAYER_CLIMB_SPEED = 50;
	var JUMP_OFF_SPEED = 500;

	var PLAYER_JETPACK_ACCEL = 700;
	var JETPACK_TIME = 20;
	var COINS_FOR_JETPACK = 20;

	var COIN_APPEAR_TIME = 0.5;
	var COIN_DISAPPEAR_TIME = 0.3;
	var COIN_DESPAWN_TIME = 0.5;
	var COIN_SPAWN_DELAY = 2;

	var STOP = 0;
	var LEFT = -1;
	var RIGHT = 1;

	var PLATFORM_HEIGHT = 10;
	var SHOW_PLATFORMS = false;

	// Persistent global state
	// var global = window.bmGlobal = window.bmGlobal || {};

	document.body.style.overflow = 'hidden';

	var Storage = (function () {
		var queuedStorageActions = [];
		var storageLoaded = false;
		var nextQueryId = 0;
		var queryCallbacks = {};
		window.addEventListener('message', function (evt) {
			var origin = evt.origin || evt.originalEvent.origin;
			var source = evt.source;
			var data = evt.data;

			if(source !== storageIFrame.contentWindow) return;

			if(typeof data !== 'object') return;

			var type = data.type;

			if(type === 'storage ready') {
				storageLoaded = true;
				var actions = queuedStorageActions.splice(0);
				sendStorageActions(actions);
			} else if(type === 'query result') {
				var queryId = data.queryId;
				if(queryCallbacks.hasOwnProperty(queryId)) {
					var callback = queryCallbacks[queryId];
					delete queryCallbacks[queryId];
					callback(data.result);
				}
			}
		});

		var storageIFrame = document.createElement('iframe');
		storageIFrame.style.display = 'none';
		storageIFrame.src = 'https://jonathan-scholz.de/bm/storage.html?name=stickfigure-game';
		document.body.appendChild(storageIFrame);

		function sendStorageActions(actions) {
			storageIFrame.contentWindow.postMessage({
				type: 'actions',
				actions: actions
			}, '*');
		}

		function Transaction() {
			this.actions = [];
		}

		Transaction.prototype.commit = function () {
			var actions = this.actions.splice(0);
			if(storageLoaded) {
				sendStorageActions(actions);
			} else {
				queuedStorageActions.push.apply(queuedStorageActions, actions);
			}
		};

		Transaction.prototype.set = function (property, value) {
			this.actions.push([
				'set',
				property,
				value
			]);
			return this;
		};

		Transaction.prototype.add = function (property, amount) {
			this.actions.push([
				'add',
				property,
				amount
			]);
			return this;
		};

		function startQuery(properties, callback) {
			var queryId = nextQueryId;
			nextQueryId++;
			queryCallbacks[queryId] = callback;
			var action = ['query', queryId, properties];
			if(storageLoaded) {
				sendStorageActions([action]);
			} else {
				queuedStorageActions.push(action);
			}
		}

		return {
			Transaction: Transaction,
			query: startQuery
		}
	})();

	var canvas = document.createElement('canvas');
	canvas.style.position = 'fixed';
	canvas.style.top = canvas.style.bottom = canvas.style.left = canvas.style.right = '0';
	canvas.style.zIndex = '999999';
	document.body.appendChild(canvas);
	var ctx = canvas.getContext('2d');

	var $score;

	var width = 0;
	var height = 0;
	var halfWidth = 0;

	var lastTimestamp = 0;
	var deltaTime = 0;

	var resources;

	var player;
	var platforms;
	var platformScoreSum;
	var coins = [];
	var coinsToSpawn = [];
	var coinTime = 0;
	var score = 0;
	var coinsForJetpack = 0;

	function clamp(v, a, b) {
		return v < a ? a : v > b ? b : v;
	}

	//region resources

	const resourceLoaders = {
		'json': function (name, cb) {
			try {
				cb(null, JSON.parse(atob(BUNDLED_RESOURCES[name])));
			} catch(e) {
				cb(new Error(`Failed to decode Base64 string: ${name}: ${e.message}`));
			}
		},
		'png': function (name, cb) {
			const img = new Image();
			img.onload = function () {
				cb(null, img);
			};
			img.onerror = function () {
				cb(new Error('Image failed to load'));
			};
			try {
				img.src = 'data:image/png;base64,' + BUNDLED_RESOURCES[name];
			} catch(e) {
				cb(e);
			}
		}
	};

	function loadResources(resources, cb) {
		var count = resources.length;
		var loaded = 0;
		var failed = false;
		var results = {};
		for(var i = 0; i < count; i++) {
			var data = resources[i];
			var name = data[0];
			var type = data[1];
			if(!resourceLoaders.hasOwnProperty(type)) {
				failed = true;
				cb(new Error('No resource loader for type ' + type));
				return;
			}
			(function (name) {
				resourceLoaders[type](name, function (err, data) {
					if(failed) return;

					if(err) {
						failed = true;
						cb(err);
						return;
					}

					results[name] = data;
					loaded++;
					if(loaded == count) {
						cb(null, results);
					}
				});
			})(name);
		}
	}

	//endregion
	//region Rect

	function platformScore(platform) {
		var yScore = clamp(2 * (0.5 - Math.abs((platform.top / height) - 0.5)), 0, 1);
		var lenScore = clamp((platform.x2 - platform.x1) / width, 0, 1);
		return lenScore + yScore;
	}

	function Platform(x1, x2, top) {
		this.x1 = x1;
		this.x2 = x2;
		this.top = top;

		this.score = platformScore(this);
	}

	//endregion
	//region Sprite

	function Sprite(img, data) {
		this.img = img;
		this.anims = data['animations'];
		this.defaultFrameDuration = data['frameDuration'];
		this.defaultAnim = data['defaultAnimation'];
		this.w = data['width'];
		this.h = data['height'];

		this.animName = null;
		this.anim = null;
		this.t = 0;
		this.frameDuration = 0;
		this.row = 0;
		this.col = 0;
		this.maxCol = 0;
		this.frameX = 0;
		this.frameY = 0;

		this.setAnimation(this.defaultAnim);
	}

	Sprite.prototype.setAnimation = function (name) {
		if(name == this.animName) return;
		this.animName = name;
		this.anim = this.anims[name];
		this.t = 0;
		this.frameDuration = this.anim['frameDuration'] || this.defaultFrameDuration;
		this.row = this.anim.row;
		this.col = 0;
		this.maxCol = this.anim.length - 1;
		this.frameX = 0;
		this.frameY = this.h * this.row;
	};

	Sprite.prototype.draw = function (x, y) {
		this.t += deltaTime;
		if(this.t >= this.frameDuration) {
			this.t = 0;
			this.col++;
			if(this.col > this.maxCol) {
				this.col = 0;
			}
			this.frameX = this.w * this.col;
		}

		ctx.drawImage(
			this.img,
			this.frameX, this.frameY,
			this.w, this.h,
			x, y,
			this.w, this.h
		);
	};

	//endregion
	//region ParticleEffect

	function Particle(x, y, vx, vy, endTime, color) {
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.endTime = endTime;
		this.color = color;
	}

	function ParticleEffect(x, y, vx, vy, particlesPerSecond, particleLifeTime, gravity, colors) {
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.particleInterval = 1 / particlesPerSecond;
		this.lifeTime = particleLifeTime;
		this.gravity = gravity;
		this.colors = colors;

		this.t = 0;
		this.acc = 0;
		this.particles = [];
		this.particleCount = 0;

		this.enabled = true;
	}

	ParticleEffect.prototype.draw = function () {
		this.t += deltaTime;
		var n = this.particleCount;
		while(n--) {
			var particle = this.particles[n];
			if(this.t >= particle.endTime) {
				if(this.particleCount > 1) {
					this.particles[n] = this.particles[this.particleCount - 1];
					this.particles[this.particleCount - 1] = particle;
				}
				if(this.particleCount > 0) {
					this.particleCount--;
				}
			} else {
				particle.vy += this.gravity * deltaTime;
				particle.x += particle.vx * deltaTime;
				particle.y += particle.vy * deltaTime;
			}
		}
		if(this.enabled) {
			this.acc += deltaTime;
			while(this.acc > this.particleInterval) {
				this.acc -= this.particleInterval;

				var x = this.x + 10 * (Math.random() * 2 - 1);
				var y = this.y + 10 * (Math.random() * 2 - 1);
				var vx = this.vx + 50 * (Math.random() * 2 - 1);
				var vy = this.vy + 50 * (Math.random() * 2 - 1);
				var endTime = this.t + this.lifeTime;
				var color = this.colors[Math.floor(Math.random() * this.colors.length)];

				var particle;
				if(this.particleCount < this.particles.length) {
					particle = this.particles[this.particleCount];
					particle.x = x;
					particle.y = y;
					particle.vx = vx;
					particle.vy = vy;
					particle.endTime = endTime;
					particle.color = color;
				} else {
					particle = new Particle(x, y, vx, vy, endTime, color);
					this.particles.push(particle);
				}
				this.particleCount++;
			}
		}

		var n = this.particleCount;
		while(n--) {
			var particle = this.particles[n];
			ctx.fillStyle = particle.color;
			ctx.globalAlpha = (particle.endTime - this.t) / this.lifeTime;
			ctx.fillRect(particle.x, height - particle.y, 5, 5);
		}
		ctx.globalAlpha = 1;
	};

	//endregion
	//region Coin

	var coinParticleColors = [
		'#ff2413',
		'#ffa313',
		'#ffdb13',
		'#baff13',
		'#13ffa9',
		'#10adff',
		'#8d13ff',
		'#ff136c'
	];

	function Coin(x, y, sprite) {
		this.sprite = sprite;
		this.w = sprite.w;
		this.h = sprite.h;
		this.x1 = x - this.w / 2;
		this.x2 = x + this.w / 2;
		this.y1 = y + this.h / 2;
		this.y2 = y - this.h / 2;
		this.t = 0;
		this.phase = 0;
		this.collectible = false;
		this.deletable = false;

		this.particleEffect = new ParticleEffect(x, y, 0, 0, 100, 0.5, 0, coinParticleColors);
	}

	Coin.prototype.setCollected = function () {
		this.collectible = false;
		this.phase = 2;
		this.particleEffect.enabled = true;
	};

	Coin.prototype.draw = function () {
		if(this.phase == 0) {
			this.t += deltaTime;

			if(this.t > COIN_APPEAR_TIME) {
				this.t = 0;
				this.phase = 1;
				this.particleEffect.enabled = false;
				this.collectible = true;
			}
		} else if(this.phase == 1) {
			this.sprite.draw(this.x1, height - this.y1);
		} else if(this.phase == 2) {
			this.t += deltaTime;

			if(this.t > COIN_DISAPPEAR_TIME) {
				this.t = 0;
				this.phase = 3;
				this.particleEffect.enabled = false;
			}
		} else if(this.phase == 3) {
			this.t += deltaTime;

			if(this.t > COIN_DESPAWN_TIME) {
				this.t = 0;
				this.phase = 4;
				this.particleEffect.enabled = false;
				this.deletable = true;
			}
		}
		this.particleEffect.draw();
	};

	function randomCoin() {
		var sprite = new Sprite(resources['img/rainbow-coin.png'], resources['img/rainbow-coin.json']);
		var x, y;
		var i = 0;
		do {
			if(i++ > 100) throw new Error('Failed to place coin after 100 tries');
			var platform = randomPlatform();
			y = platform.top + sprite.h / 2;
			x = platform.x1 + Math.random() * (platform.x2 - platform.x1);
		} while(x < 0 || x > width || y < 0 || y > height);
		return new Coin(x, y, sprite);
	}

	//endregion
	//region Player

	var playerParticleColors = [
		'#ff2413',
		'#ffdb13'
	];

	function Player(x, y, sprite, jetpackSprite) {
		this.sprite = sprite;
		this.jetpackSprite = jetpackSprite;

		this.x = x;
		this.y = y;
		this.vx = 0;
		this.vy = 0;
		this.w = sprite.w;
		this.h = sprite.h;
		this.onGround = true;
		this.climbing = false;
		this.jetpack = false;
		this.jetpackActive = false;
		this.dir = STOP;
		this.jetpackTime = 0;
		this.jetpackWidth = jetpackSprite.w;
		this.jetpackHeight = jetpackSprite.h;
		this.jetpackOffset = this.h / 2 + this.jetpackHeight / 2;

		this.jetpackEffect = new ParticleEffect(x, y + this.h / 2, 0, -100, 80, 0.4, GRAVITY, playerParticleColors);
		this.jetpackEffect.enabled = false;
	}

	Player.prototype.setAnimation = function () {
		var dir = this.dir;
		this.jetpackEffect.enabled = this.jetpackActive;
		if(this.climbing) {
			this.sprite.setAnimation('climb');
		} else if(this.onGround) {
			if(dir == STOP) {
				this.sprite.setAnimation('idle');
			} else if(dir == LEFT) {
				this.sprite.setAnimation('run-left');
			} else if(dir == RIGHT) {
				this.sprite.setAnimation('run-right');
			}
		} else {
			if(dir == STOP) {
				this.sprite.setAnimation('jump');
			} else if(dir == LEFT) {
				this.sprite.setAnimation('jump-left');
			} else if(dir == RIGHT) {
				this.sprite.setAnimation('jump-right');
			}
		}
	};

	Player.prototype.setMovementDirection = function (dir) {
		if(dir == this.dir) return;
		this.dir = dir;
		if(dir == STOP) {
			this.vx = 0;
		} else if(dir == LEFT) {
			this.vx = -PLAYER_SPEED;
		} else if(dir == RIGHT) {
			this.vx = PLAYER_SPEED;
		}
		this.setAnimation();
	};

	Player.prototype.spaceDown = function () {
		if(this.jetpack) {
			this.jetpackActive = true;
			this.onGround = false;
			this.setAnimation();
		} else if(this.onGround) {
			this.vy = JUMP_OFF_SPEED;
			this.onGround = false;
			this.setAnimation();
		}
	};

	Player.prototype.spaceUp = function () {
		if(this.jetpack) {
			this.jetpackActive = false;
			this.onGround = false;
			this.setAnimation();
		}
	};

	Player.prototype.setClimbing = function (climb) {
		if(climb != this.climbing) {
			this.climbing = climb;
			this.vy = 0;
			this.setAnimation();
		}
	};

	Player.prototype.enableJetpack = function () {
		this.jetpackTime = 0;
		if(!this.jetpack) {
			this.jetpack = true;
			this.setAnimation();
		}
	};

	Player.prototype.update = function () {
		if(this.jetpack) {
			this.jetpackTime += deltaTime;
			if(this.jetpackTime > JETPACK_TIME) {
				this.jetpack = false;
				this.jetpackActive = false;
				this.onGround = false;
				this.setAnimation();
			}
		}

		if(this.jetpackActive) {
			this.vy += PLAYER_JETPACK_ACCEL * deltaTime;
			this.y += this.vy * deltaTime;
			this.x += this.vx * deltaTime;
		} else if(this.climbing) {
			// this.x += this.vx * deltaTime;
			this.y -= PLAYER_CLIMB_SPEED * deltaTime;
		} else {
			this.vy += GRAVITY * deltaTime;
			this.x += this.vx * deltaTime;
			this.y += this.vy * deltaTime;
		}

		var hw = this.w / 2;
		if(this.x - hw < 0) {
			this.x = hw;
		} else if(this.x + hw > width) {
			this.x = width - hw;
		}

		var standing = false;

		if(this.y < 0) {
			this.y = 0;
			this.vy = 0;
			standing = true;
			if(!this.onGround) {
				this.onGround = true;
				this.setAnimation();
			}
			if(this.climbing) {
				this.climbing = false;
				this.setAnimation();
			}
		}

		var playerX1 = this.x - hw;
		var playerX2 = this.x + hw;
		var playerY1 = this.y;
		var playerY2 = this.y + this.h;
		if(!this.jetpackActive) {
			var n = platforms.length;
			if(this.climbing) {
				var hasGrip = false;
				while(n--) {
					var platform = platforms[n];
					if(playerX2 >= platform.x1 && playerX1 <= platform.x2 && playerY1 <= platform.top && playerY2 >= platform.top) {
						hasGrip = true;
						break;
					}
				}
				if(!hasGrip) {
					this.climbing = false;
					this.onGround = false;
					this.setAnimation();
				}
			} else {
				while(n--) {
					var platform = platforms[n];
					if(this.vy < 0 && playerX2 >= platform.x1 && playerX1 <= platform.x2 && playerY1 <= platform.top && playerY1 >= platform.top - PLATFORM_HEIGHT) {
						this.y = platform.top;
						this.vy = 0;
						standing = true;
						if(!this.onGround) {
							this.onGround = true;
							this.setAnimation();
						}
						break;
					}
				}
			}
		}

		if(!standing && this.onGround) {
			this.onGround = false;
			this.setAnimation();
		}

		var n = coins.length;
		while(n--) {
			var coin = coins[n];
			if(coin.deletable) {
				coins.splice(n, 1);
			} else if(coin.collectible && playerX2 >= coin.x1 && playerX1 <= coin.x2 && playerY1 <= coin.y1 && playerY2 >= coin.y2) {
				score++;
				new Storage.Transaction()
					.add('score', 1)
					.commit();
				$score.innerHTML = score;

				coin.setCollected();
				coinsToSpawn.push(randomCoin());

				coinsForJetpack++;
				if(coinsForJetpack >= COINS_FOR_JETPACK) {
					coinsForJetpack = 0;
					this.enableJetpack();
				}
			}
		}
	};

	Player.prototype.draw = function () {
		this.jetpackEffect.x = this.x;
		this.jetpackEffect.y = this.y + this.h / 2 - this.jetpackHeight / 2;
		this.jetpackEffect.draw();

		if(this.jetpack) {
			this.jetpackSprite.draw(this.x - this.jetpackWidth / 2, height - this.y - this.jetpackOffset);
		}

		this.sprite.draw(this.x - this.w / 2, height - this.y - this.h);
	};

	//endregion

	// function getVisibleElements() {
	// 	var height = window.innerHeight;
	// 	var width = window.innerWidth;
	// 	var elements = document.body.getElementsByTagName('*');
	// 	var visibleElements = [];
	// 	for(var i = 0; i < elements.length; i++) {
	// 		var element = elements[i];
	// 		var rect = element.getBoundingClientRect();
	// 		if(rect.bottom >= 0 && rect.right >= 0 && rect.top <= height && rect.left <= width) {
	// 			if(element.offsetWidth || element.offsetHeight || element.getClientRects().length) {
	// 				var computedStyle = getComputedStyle(element);
	// 				if(computedStyle.visibility === 'visible') {
	// 					visibleElements.push(element);
	// 				}
	// 			}
	// 		}
	// 	}
	// 	return visibleElements;
	// }

	//region map

	var rWalkable = /\S+/g;

	function getTextNodeRects(textNode) {
		var rects = [];
		var range = document.createRange();
		// range.selectNodeContents(textNode);
		var text = textNode.data;
		var match;
		rWalkable.lastIndex = 0;
		while(match = rWalkable.exec(text)) {
			range.setStart(textNode, match.index);
			range.setEnd(textNode, match.index + match[0].length);
			rects.push.apply(rects, range.getClientRects());
		}
		return rects;
	}

	function mayBeVisible(el) {
		var rect = el.getBoundingClientRect();
		if(rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
			return false;
		}

		if(!el.offsetWidth && !el.offsetHeight) {
			return false;
		}

		if(!el.getClientRects().length) {
			return false;
		}

		return true;
	}

	function isVisible(el, style) {
		if(style.visibility !== 'visible') {
			return false;
		}

		if(+style.opacity == 0) {
			return false;
		}

		return true;
	}

	function getElementPlatforms(el, style) {
		var platforms = [];

		if(style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
			var clientRects = el.getClientRects();
			for(var i = 0; i < clientRects.length; i++) {
				var rect = clientRects[i];
				platforms.push(new Platform(rect.left, rect.right, height - rect.top));
				platforms.push(new Platform(rect.left, rect.right, height - rect.bottom));
			}
		}

		// if(style.backgroundImage !== 'none') {
		//
		// }

		// if(style.borderTopStyle !== 'none') {
		// 	var w = +style.borderTopWidth.slice(0, -2);
		//
		// 	if(w > 0) {
		//
		// 	}
		// }

		return platforms;
	}

	function _getPlatforms(node, platforms) {
		var childNodes = node.childNodes;

		var textNodes = [];

		for(var i = 0; i < childNodes.length; i++) {
			var childNode = childNodes[i];

			if(childNode.nodeType == Node.TEXT_NODE) {
				textNodes.push(childNode);
			}

			// Only element nodes
			if(childNode.nodeType != Node.ELEMENT_NODE) continue;

			var childTextNodes = _getPlatforms(childNode, platforms);

			if(!mayBeVisible(childNode)) continue;

			var style = getComputedStyle(childNode);

			if(!isVisible(childNode, style)) continue;

			for(var j = 0; j < childTextNodes.length; j++) {
				var rects = getTextNodeRects(childTextNodes[j]);
				for(var k = 0; k < rects.length; k++) {
					var rect = rects[k];
					platforms.push(new Platform(rect.left, rect.left + rect.width, height - rect.top));
				}
			}

			platforms.push.apply(platforms, getElementPlatforms(childNode, style));
		}

		return textNodes;
	}

	function buildMap() {
		var newPlatforms = [];
		var newScoreSum = 0;
		_getPlatforms(document, newPlatforms);
		newPlatforms.forEach(function (platform) {
			newScoreSum += platform.score;
		});
		platforms = newPlatforms;
		platformScoreSum = newScoreSum;
	}

	function randomPlatform() {
		var target = Math.random() * platformScoreSum;
		var sum = 0;
		for(var i = 0; i < platforms.length; i++) {
			var platform = platforms[i];
			sum += platform.score;
			if(sum >= target) {
				return platform;
			}
		}
		throw new Error('No random platform found!?');
	}

	//endregion

	function draw(timestamp) {
		requestAnimationFrame(draw);

		if(lastTimestamp) {
			deltaTime = (timestamp - lastTimestamp) * .001;
		}
		lastTimestamp = timestamp;

		if(coinsToSpawn.length > 0) {
			coinTime += deltaTime;

			if(coinTime > COIN_SPAWN_DELAY) {
				coinTime = 0;
				coins.push(coinsToSpawn.shift());
			}
		}

		player.update();

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		if(SHOW_PLATFORMS) {
			ctx.strokeStyle = 'black';
			ctx.lineWidth = 1;
			ctx.beginPath();
			for(var i = 0; i < platforms.length; i++) {
				var platform = platforms[i];
				//ctx.strokeRect(platform.x1, height - platform.top, platform.x2 - platform.x1, PLATFORM_HEIGHT);
				ctx.moveTo(platform.x1, height - platform.top);
				ctx.lineTo(platform.x2, height - platform.top);
			}
			ctx.stroke();
		}

		for(var i = 0; i < coins.length; i++) {
			coins[i].draw();
		}

		player.draw();
	}

	function resize() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;

		width = canvas.width;
		height = canvas.height;

		halfWidth = width / 2;
	}

	// var resizeTimeout;
	// window.addEventListener('resize', function () {
	// 	clearTimeout(resizeTimeout);
	// 	resizeTimeout = setTimeout(resize, 50);
	// });

	resize();

	var $scoreContainer = document.createElement('div');
	$scoreContainer.style.position = 'fixed';
	$scoreContainer.style.top = '20px';
	$scoreContainer.style.right = '20px';
	$scoreContainer.style.zIndex = '999999';
	$scoreContainer.style.padding = '15px 20px';
	$scoreContainer.style.color = '#fff';
	$scoreContainer.style.backgroundColor = 'rgba(100, 100, 100, 0.5)';
	$scoreContainer.style.font = '30px "Comic Sans", "Comic Sans MS", cursive';
	$scoreContainer.style.textShadow = '0 0 5px rgba(100, 100, 100, 0.7)';
	$score = document.createElement('span');
	$score.style.verticalAlign = 'middle';
	$score.textContent = '0';
	$scoreContainer.appendChild($score);

	loadResources([
		['img/stickfigure.png', 'png'],
		['img/stickfigure.json', 'json'],
		['img/rainbow-coin.png', 'png'],
		['img/rainbow-coin.json', 'json'],
		['img/jetpack.png', 'png'],
		['img/jetpack.json', 'json'],
		['img/large-rainbow-coin.png', 'png']
	], function (err, _resources) {
		if(err) {
			console.error(err);
			return;
		}

		resources = _resources;

		var $scoreImg = document.createElement('span');
		$scoreImg.style.display = 'inline-block';
		$scoreImg.style.marginLeft = '0.3em';
		$scoreImg.style.width = '1em';
		$scoreImg.style.height = '1em';
		$scoreImg.style.verticalAlign = 'middle';
		$scoreImg.style.backgroundPosition = 'center';
		$scoreImg.style.backgroundRepeat = 'no-repeat';
		$scoreImg.style.backgroundSize = 'contain';
		$scoreImg.style.backgroundImage = 'url("' + resources['img/large-rainbow-coin.png'].src + '")';
		$scoreContainer.appendChild($scoreImg);
		document.body.appendChild($scoreContainer);

		Storage.query(['score'], function (result) {
			if(typeof result['score'] === 'number') {
				if(score > 0) {
					new Storage.Transaction()
						.add('score', score)
						.commit();
				}
				score += result['score'];
				$score.innerHTML = score;
			}
		});

		for(var i = 0; i < 3; i++) {
			coinsToSpawn.push(randomCoin());
		}

		var stickfigureSprite = new Sprite(resources['img/stickfigure.png'], resources['img/stickfigure.json']);
		var jetpackSprite = new Sprite(resources['img/jetpack.png'], resources['img/jetpack.json']);
		player = new Player(width / 2, 0, stickfigureSprite, jetpackSprite);

		requestAnimationFrame(draw);

		var leftDown = false;
		var rightDown = false;
		var downDown = false;
		var spaceDown = false;

		window.addEventListener('keydown', function (evt) {
			var doneSomething = true;

			var keyCode = evt.keyCode;
			switch(keyCode) {
				case 37:
					if(leftDown) break;
					leftDown = true;
					player.setMovementDirection(LEFT);
					break;
				case 39:
					if(rightDown) break;
					rightDown = true;
					player.setMovementDirection(RIGHT);
					break;
				case 38: // Prevent up-key from scrolling the page
					break;
				case 40:
					if(downDown) break;
					downDown = true;
					player.setClimbing(true);
					break;
				case 32:
					if(spaceDown) break;
					spaceDown = true;
					player.spaceDown();
					break;
				default:
					doneSomething = false;
			}

			if(doneSomething) {
				evt.preventDefault();
				evt.stopPropagation();
			}
		}, true);

		window.addEventListener('keyup', function (evt) {
			var doneSomething = true;

			var keyCode = evt.keyCode;
			switch(keyCode) {
				case 37:
					leftDown = false;
					player.setMovementDirection(rightDown ? RIGHT : STOP);
					break;
				case 39:
					rightDown = false;
					player.setMovementDirection(leftDown ? LEFT : STOP);
					break;
				case 40:
					downDown = false;
					player.setClimbing(false);
					break;
				case 32:
					spaceDown = false;
					player.spaceUp();
					break;
				default:
					doneSomething = false;
			}

			if(doneSomething) {
				evt.preventDefault();
				evt.stopPropagation();
			}
		}, true);
	});

	buildMap();

})(window, document, {
'img/coin.json': 'ewogICJ3aWR0aCI6IDIwLAogICJoZWlnaHQiOiAyMCwKICAiZGVmYXVsdEFuaW1hdGlvbiI6ICJpZGxlIiwKICAiZnJhbWVEdXJhdGlvbiI6IDAuMSwKICAiYW5pbWF0aW9ucyI6IHsKICAgICJpZGxlIjogewogICAgICAicm93IjogMCwKICAgICAgImxlbmd0aCI6IDYKICAgIH0KICB9Cn0=',
'img/coin.png': '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',
'img/jetpack.json': 'ewogICJ3aWR0aCI6IDI1LAogICJoZWlnaHQiOiAzMCwKICAiZGVmYXVsdEFuaW1hdGlvbiI6ICJpZGxlIiwKICAiZnJhbWVEdXJhdGlvbiI6IDAuNiwKICAiYW5pbWF0aW9ucyI6IHsKICAgICJlcXVpcHBlZCI6IHsKICAgICAgInJvdyI6IDAsCiAgICAgICJsZW5ndGgiOiAxCiAgICB9LAogICAgImlkbGUiOiB7CiAgICAgICJyb3ciOiAxLAogICAgICAibGVuZ3RoIjogMgogICAgfQogIH0KfQ==',
'img/jetpack.png': 'iVBORw0KGgoAAAANSUhEUgAAADIAAAA8CAYAAAAkNenBAAAFMElEQVRo3u2ZT2gUVxzHP2939k9G7UoXgstuJKaai4o9lFrYWszB4sVLDqUUFB6IPfQWEFGKp95Ke7H20NYOFMFCIQf1sDYWQiUVCaWKdsEIllpFiC5qLLvZnd15PWQmnczOmog7b0Xyg4HZ/b3fb97v+36/9+f74FWW28ViTqddNyQW0pkDwOTtYvHgcwZx0LU70ItARKAz+4BxwAAawKdDU1OfryCIw8BnQBJoAqNDU1PnejYiDnzhBgGQsIUYuzwysv9ZDi6PjOy3hRgDEu5fhuunN6l1q1jcqWDIP1qGUhvWNptHbheLgx1GYnBts3nEUGqDf3QVDN0qFndqD0RKKRRciEE8mHcpx9l60zSPhhnfNM2jKcfZKtqdxhVckFIKrYEcm5k5bUAm7KtxINtoHAozzjYah+IdCs+AzLGZmdNaA3mcSFxTCymx+DixGApoCNF8lEyqMONHyaRqCNH0t/c/jxOJa7oCMQC+3rSpvO/+fadv+3Zhmqao9veTfPoUgNr8vPHrzExTSrkbOADkgWngj1/q9dZ7w8NGXzoNQGPdOszZWarVqqpdv67O5XJlJif1BQKkf9u2zXlzx454zTQXAsgtrG337t3jQSolgBKQctu/D9QepFLir2yWfD6/6LCWy1GtVrmqlEOlktY+a1UqFSVEW5U0Hz586LVLBXR9gJibm8NdO/6vESGoVCqqpyt7UL9+/Xqvo78DNeAp8DfwE9AyF0YwRo/FWJyBslkh2odEGMZCE8uy3pJS5izLuu8ppZQNVy8CIyKy2ayoVCr0JLVs225Lh2QyufjuDyJM74lt26qnqTU/P9+2JIR1NCQQsYyfntcIjUbjhfTaa6SDKLduhJTyQ2CDT3fVm6Hc9U+8NIF4he1PrVar5Y3cSWCt22EH+AcQqVSqLbVC/GivkbYCDVlbltWH+dE6Ikq1fz+RSLhHFT4JSa2fbdtuz0elepZatwBqtRpKqSUo1+t1AGVZ1o9BYymlp18SRK1Ww+9XZyBxIF4ul0VfX19rdnZWxWIxNm7caExPT3v6MIlPT0+za9cu7ty503Qch/7+flEul2OeT92BNIFvgY/Pnz8fL5VKAOzZs4dCoVAFvutg/xVw8MyZM+bExIQBsHfvXnILG85vgnuwyEVKKaSUZiaTuRE4UqhCoXBlYGBgc5jdwMDA5kKhcCVok8lkbkgpTZ0nRL8cD3ZICPGv+36pg82lQDv/c7xX02+QYKgrpdZ4h8EO9o/cAl8D1AO6wV7xWrt971tCZpywo97uwO+g3SSrsiqvoKyy8c/BxncbrFig0T7gFDAMnHRZ9pU4P+xu84eBU66fZ7XvOlja2fiowNLOxkcFllY2PkqwtLHxUYOljY2PGixtbPzjROLa67b90ZLTZCyGcBwPrHgnsNa1Wq2kUobX3i8eWNrY+KjBMvyUaQc23qAzG+/Mzc2Rz+ebfiKjAxsfKVha2fgory4WO7ASNh54w7Ks1yzLGrQs6wMfGRfKxq90m9QNsJaklm3bKp1OixCS2gvmhdj4KK8utLLxUV5daGfjowLrpWDjuwHWy8DGdwUsI4RFF8ux7cvpn8XGRwWWdjY+KrC0s/FRgaWTjY8ULJ1sfKRgeYFcB8bGx8ffffLkyVbPw8TEBIVC4YYQ4kTYFy5evHhCKfXO3bt33/b+K5VKZDKZP0dHR8fc7Qa6ry4iZeN1Xl18H2g873s/2yGQsx3aK9efNrD80+8P7tOJjQ+TL92HFdp14+oiFeZP943S6tXFcvIfZMg5vE/6TUsAAAAASUVORK5CYII=',
'img/large-rainbow-coin.png': 'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAY30lEQVR42u2dd3Rc1Z3HP/eV0cyoayTZcpNkC8sGbEoAEwcwhAWHJJCQgglhFycBnAQ2m0MOLZQASwmwJyGEbnpLSEI4wYEEUiBwEiBZ22B73ZALlm1ZZVRGM5r63t0/5o0tWTOvSGNBdn3PGXMOeuW++/19f+3+7r1wsB1sB9vBdrAdbAfb/4kmPoqdkv9Zo8Q+jtY5F2XjFMxj/8K3UtUsi1cwLR4gkAigpkoQaRUMBZJCZTOz+JM8iS2iEV0aVJsRGlK95vShnsSMvnB7fW/0/iULrrn/X6MvKfN3dcg5u/dkzvzkG8ZH7du1jwwIhAQPEWIeqrlTnmIEuDGjMrsyBasXgcwjQWLYfzVpYArBIKUMiQA7tAbe1YRiBkWQWtGqYN7VKrfcFRMButWavn698Vb++89PLtX+y3dF+VUdh87COMgQQF4cKmUxc6mhkSjXEJJHpeugswp2lkPUZ4Fh01MDha2ykd/zSd7jUGIE815vIjAMHbOvDn37dGoScWYr/0N/uvYb5ZUdG6+O3rD5lBM39vy/ZIi8PtTEQo6jlAWYXEYd0AhIAUgUAxQThLT+ly27BBlUDMReJuVrChKFDJAEU9DX28JfU62ogdQjzcoa7ozc/eyClfK3l6Vv27Dk+Nff/X/BEPnlUIhPcTZTOJcaTiVk9UJaPyQZAT2lsLMSBkrAFPY9TaOySbbwCieznlaGCBS+3lCgrwa2tkDnZMjoIAWGzL6jrnIbjcb2dZnagUduSF716skLN62fyPFRJhSMH4a+wL/wCyp5gBCnUgWY1k+OlBLVBFW6k5is3GtkUDHHImMCVAVUAT0DzawcOuXw9u5jf3xF7JmfL3nngUvlzRM3ThOisuT3QiEaeZoKjkOlBt0CwATU0aMjkKgSNCOrsuzGWAAmCkmhk5a6BYjDTTk6itEKTrFu74tNZUCdPK8jMeuHxxy34JKz1751+gvzvt3+T88QeX1oKXPZTBWfQqUmr5u0/yBbYCgmKNINQ/b3ucavrIUAaarE0lWl7dHD5qx898J3l73w8PP/1IDIG0IvcgiPUbIfECNHMu9YaRJKjGFqSxaGQ6KQxEcKHyYC6Tja3oysgY4e02vCv/z62efcvCHxTwWIPDqUHb+bQhtp4cyCX+lgqFUTdDPLEndWxERgWo+XbijlHhQTSiNQPiDE/AfmlCxdEjUAbvzdVepHnyGf4Bh5Z6iHmbQW/HDFWUpVE3yZLChCOstxBp00ugVH8RgiATUDwSj4o1kBmf9qqXLZopg0tzbf8kX5zaLa4aI9TBJS+B7n0MQDVFFpC4Zq/UThERNIVMuGCBeDJpAIIUFKiyHF8egF4EtCRV+WJaoBpgLT1gTpHzzvykMG6mdd3Fax9KGWO2IfGUAkIcEy/pXp3EUllY5f6IIhigRdgmY6e1oSLJdXsdhRvPBKmBCIQkUY/ENWsApIBaq2lBH/+aIviVhAu2ijvnT5nFsGPhoq6xQ+Twl34KPKlcipw95sM3aKmVVdzgxR9jPmskisB8WAsn6o7AVfYqT6lBoEtlVTseKYz9c//YnHLtp+eemHDog8JHQCSe4iQ/2+aNvOOFi8dPFmVVpelrQfNBOB4Zkh0pXs6KksIMEIaOnRt0kflGwLEVxx/NnTnj36ka/Ji7QPDRA5K9QIPEiGGXsjbjdvVN2pLSH32RBhk8cyUUjhw7A3TN4tuwRfHCr6IRDL2o+8l/nAv70a8/lPL5l376xr73/l38bsfY3PhggeBQ4dHvy6UlcuGSIYlmBkZAAupeStZyfx3ss1DPbqaFPDaF/bAwvrPSgkZ/vhS4E/ljXswk59alCxtYKO55f94M7Xqm+YcIbIltD9wCfBYkbGpep29LBGGvZCbc3va3jj0SkM7PFjplRS2wwqb3wHrWPcdnWEDSsZyrq8etKF+61Aw+oqLjlvhzGhgMiW0IXAN10zY/jbtGG8FM4yXChKb/vbaP9BMaBs1W535BDuVKaWydoRxXCnDE0VDnupVrnpu78dmhBAZEuoFbg/j2V1BkYZpq6EByDzjMRgT35tq/fG3T1PSsf3CzMLhp60MgZu+6tlWPhkmf+xH9zywgEFRLaEFOAn5MnRunJucvZDdXe9FDaTU4X+YDr4yYJ9xsCFyAvT+km3siPxkaBc9Isjnqg/6brrfj39QDLkMstuiFGBnguvaS9DXDpC0qNGdOc7Wa6bC5EXMutZqYaX90v8xAkSZWZ8e81Jb+3605ESX9EBkS2hWcCFgF5Q8p0k04NBh+xMoRSeRtu9h6W4gzn3frcMUTDxEyVAlEA6wTGb2qdffv7ySwEev/Y2xy/w4vZ+FzikoCrSHeAdDohLMZBy3/StW5NT9/Rqal7aRHJSGYmmauJz6onOayDVWD2sH6ZlpaUzQ0U2TeI6EUmaUiL4GUIRBqVxwz+/rWPZTc/d8ubSJVf/oyiAyJbQccDpeYdy/4EWDjksDwyRYqTKSsUFm96sYt2rNex5P1DQVVZ6h9B7hyjb0AW/25S9d1IZAwub6D95FkONLVkwnMTeAsMUzoUWeyN7UgSJ4iOOQKKZaUI96dlH3dd4EjB+QCxDfg4w29FYO6ksxbvaMQUkYoK3V9Tz91/WkYiOLZb1dUape2EddS+sI95UR8e/fI7Bqhn2365kayAyPrcsyRr0IIP4SGbnZ4RCQ3iAGc2bv3Png7e/dfmyK/82XobMA04rykB7BEQKeOe1an796BQSUb1oAV9gezczH36Y8Lwd7Fx0he37DTX7M11lFiQ6KXRSVlFS7g8ZyraXzjj8kWlNwN/Ga9RPAuYXJR3iITPeO6Bx849m8uzdjUUFY3gLrX2V8u1v2zIk7YdEEAzNmSUCE50EJQyhDk9dKAozu3cxPbTyqz964ropY2aIbAlNhQLTsN7zXiNBsQFm264Srrm3mc5wCQe6afEBW4akdEgGrPItV6k6c+90stgvoEl2Tvv09GcmNwO7x8qQZuAUd1lAj/ahwNetawvynTtaJgQME0F0ynx7QPwwVJ4FxVQLgyKtf7MVYqnR8/qqwtztXTQntx56zvp7NM+AyJaQH1hMsaZ592dFHvC27vJz1d3NDCUmpsK1a+E5pCsbHAGJVsFQWdaWuLEj+YssBIF0P71V/ocW3+1rGIvKCrpWVy7UkFNgF4srXHtPE/Hk+MDoPv9Iuj4/H70jgr+9H/+2XvzbeinZHUHriaEYkvjUKnpOXkzf5CUwZN/djA6RaojUQN1uKw0v7QHJzV+OmnnWBY1rYc5vAvGxADIDOMI1GE4qS9qD8uDzDXT2Oqup5mMGOPZL3by+vIGuLaV5pTpTHSBTHSB+6KT8D0n4oX0GbHcG2NAgWgkDtRAPQnAQZIHMrxjGEJFvtk4otIR38fKlkcvvnX3T9y/5zvWGK5UlW0IqcLKnjNg45h7bO328/GaN7TWlNWnOvaONJbdvY+axURTFDfo2fxeFy0n3BzheBr31WdWV0aTtcxWrBl8UkF5FxsnsmXRFcNVU3QtDFHKTT24YorrP4OZrv3m9FmmDaElphvPvep/qqSmX/oKw74aQ+1InDiG4AFIl0FcHg1WQ9gl8STt1ZYx0eUcF0YJpGyCkeVNZAviEa0C08THkzVUVtn8/+rM9VE9JuX6eY13WiLy+cw2XqWbZ0V8PqYAkEBN7y4H2j0NUDGyLCxSFlq49VHWXGF68rKlAjWtAdJepkzy59J5+lZ5+e9tRWpXxmMt1Wz3hsqBumPub9uUnlbAyvQrGXqNe6GFVqV5+cV38x14AOdp9ZGUB4pQ0LDBt2t3nPFWwckUdkS7NI0McRtj0kMa1WBIPZtVXodtyKktxrC2WpHdPvcCLyjrUk/0ocZnFzcMQw3CW0L7dJSz/+lwOP62PWQsGmHRI3EXHHBgipLeZL2llfhW7j8tVhpn2j1YkFR8ESr0AcojrjuoWIGMMH+pq0q6uSydUVq+oZfWKWvvnPfUuNS9uJDmlguSUChIttUSOnU6yucbGjrhPdkob9z6rAAxnJahAfUdKeAFkhieD7sfT1OzwNqkmzfTJCdr3+IuWENAGEmgDCUo3dMGf2pjy4Nska4P0fXouPWcfjhHQh3nH7hf4uJsTkVZIaH9VbSTqKXXS4PrrfcNU1hgzvV9Z3HnA0yQlPUNMfnIlc899mklPvgMZ6cmG5DSdM37C2fsXgoqkN0DceViKxQ6/C0BsIvXFC/v55LG9E5K/UpMGk5/9By133Iuvr8sTGLkKFHu/xV1pRtAY8gRImbuvs9ihuwgKhX0/r/p6O2cumrg1+6Xbd9Dys8vx9X7gyqBnPWWZrY2QhYJR94VmPlKeAHFXtqJZ0PldBIYO1YKqAt89bxe3XLqV6ZPiEwKKHuujecX3URMRF35vtvpdKZjHklb8I10Bo5HxBIh3D8tNptdFkdXx8wZ57MZN/OelWzjqyH403TygoPgH9zDljXudvXsDtBQomfxqK8eQfWCMbY1KIS8rZcm9vf3wkU3S67hdd+YuMBZw3PxBmj8+yBa/wrr1pezaGKRra5D+Dh+DPRrJIk7r1mz+Iz1HfYl43SGFVZaRXbCjZpwiH7mfBOZvmQJDXwiQqCMgOZfX58Kge/AuR4RZAnS/Scvxg8z6+OCIZzz+zdnseT846r7ucw8nfGorpes6qfpzG+Vr97h6X+3qX9F++tWFJdcqulYzloF38LKcvi5VwCoUAqQXqHXt8rpVfB6ywVIBI+f7ewFTV0jOrCU5s5besw6j/J0dzPjha2gR++Xlldv+SruRBjU/87R0liGaYUXt2C0icpbAITXoyYZ0eE4qiiKCYeVLTeFuUZYdEQcXzGDrbWcgVXupUdNxAt3vF3R51bRVBZ/J/x45qgfSNpcVKSnzBMgO13ksr6vI3KzLsNIUpvXz3kYORnxOPb2LZzveFQhvy9sZIUFP268TEda/ucWnwqF/PRXeAHnfE0OU4qqrnEowlGHpinEWWg+c2Oys7Qa7CjJES1tur2knAnIvMLZTACZ0NfikF0DWux5gZRz6xCaJZyr7APHuQI5+UXJKhXOcm47nH2iZVVU5g14oh4W1ANUxEjEFkcZ4zAsgq1wzZCwqy0UzxH4MKUra0UkQRGGHMpNliHCIpVwJjxDoU3c+5QWQXZanZR+HDF+e5l212zLEsH5jCwtHv6hs1U7HuzL+ioIehshtFVXQvcqyI2MtzxY2fev31XDOTcH/8AKIBP7qChCVca0VzPfqnP0wxFgZMvImrS/O5KecSZ+obsz/qWbWqKtpbHJZDCvUEIV3tjNN2uon8+YRDaoXQEzgz46AqIxpiYEb+d6rssbJDb1zkObLV6D3DjmkqgSxqfPza1m5b728vbpSSOPDQCs8JIZk51zYchTuvSzRFjaA1127vGLMwltQZclxsUOCYVLz0gYOufhXBLf1Od412LgA05/f8Asza9QVw0kYcnWLSoGyJokpAuiTO+6MH92e9hKp52KR9yhUvTi8WtHLbkh5JOy9zaX8/JV6NmwNMJTUqK9J0np4lKZFA0xaMIjwkLZSYilqXvwf6n61Fv+uiOv7uj92buEUXI4hptO+KwoGGmahXJI0aQtNZd49k+/4LOcbXgEZAlZgV07qhR0F4om31pRz7b1NI8ja0e2n4zU/vFZLoCLDnJP7mXNSH9MOjxXKbOxtoV9vIOSRU72tpxGbMs+++9L5cyVgoJFByx+HpCU75sGO04eCPICnXBaiLZyQLaFXgKvyXiegGFtTLf/1FNtgJh7RWP1iLatfrEXzmZRWp0nElKJlexM1jexc9B1HMBQzm/G1lzdhVWVlV4mI/eCK61VU9ycufvRW/+5CgDiFdduA12wN+zhaJKbyQYf74oZMSmGgs6R4YFROZctZdyB9QedAVQWp2jsZ2R22fWTwjQ4ODZMNTfVs881c/7PDLs2MaUhFW3iXpbbGFVeMuHbYPbF40feQdN0GG4+i7Ut3kymrdWebMuQtH3Vt1KVCyaSdL7efv2Gb3XvcVFO9Aawh3zpDr+pqPwDrqlP4SwwSyYkDxtBVOj7zZXqaz0ek3bPT0NylcdKUkMKPibpvnt002Vo3jfZw4zOXXfDV3U7RhFNbC/xh3AzJJw0qfPWMzokBQhN0n3kYG+9bRviEUxHCvTQJaU3fGs7TTyYqGfSRnpbUiDbFdqz7xs7tjmPi2Jm2sClbQr8gu5pqdrEH6rwzukmmFZ55qd52ScKY7cTUCvpOb6V38WwyoXIYKAcPW2qN2GPRxSkNaTSSBEmjZ79HpukIVbMj3XL35csu+Nu4AbFA+btsCb0KtHAA9vr92lmdnHjUAD//fR1vrKrEMMeuwkxdJXbYJKJHTyXysWkk5tSPzD+MwStUjGymV3HchEZgoJPCT5psRX9a8RGu1Tev/vbON/iLC63hoV93kd1AoPVAqJSW6QmuvaidSGwX/725lL9vK2Nbl5+eTh+xXp1UQiBcyELPufPoWLqgqH1TzGGpE9N+6tZAJ04pKUqQUiEW1BNrWhoevH7JRf94/NrbxNKbr5ZFAUS0hbfIltDDwK3k2xGoSK2i1OCEj0VoPSnCzgoY9O8rwc2kBNIERZM8dWn+Iodh8XXR+iRMiyEutuIy0CxA/CR0Hytbp7Xf/vRF9/AMOIExlkjiR8CfR1UTFzm5KLA2kdlvCaDmk+h+iaq5eUIRXPXcIFlb/Sku9s0yUUgSIEEp2/1Nva8vnHbqGoHr5V+eABFtYRPJfyCsA7QO0Pk843+sLOrThWGB4aLQTwIp/MRkuVx5Qe+bN990tqczRzwbaLElvAn49oE8LEnIfSfsjA2O8azQzdMXY998unDx7kzGz2vnkVh60zWf98zGMQ3Y++HlSJ4osqreK8ECz8ez7PcE6UAQ6enBirv9ziyPTLDu0wPm1fd8LjgmB2LMw/Z2eClJ1nOASm8V97vw5ZF/uyVOw2eb3KlPYWZZ4niWiQkdR/Vz988ax+y3jy+mUDiHKL0HSm0JbMat0B8UxV4tjfBhPQSHTpdnIDIzQsMXH7xxPFuNjw+Qh1hPD99iiIgrFeBhEkuR9meHlNflX5uYqivFNlLIibubvV+tyTfF4aQfkYJEUx/KF19+bu0lW27+1uInjQ8FEEFYcifP087VxB1A8TCzmGOG3XgdftpoYpolCoMfm+rgT5tZH1aYY9GFecFINvcydObbL+w8b9U3HhPLM+NTOuM2wWGD/+IhPuD7xIjYfpDHw7js5r9aT4xw8oW7CVSm0AMmJXN1+m49gUx9mTsLrZoevzOPgGQgMbOP6FnvvNB53ltfW95057hP2SnKxlQiGc7Im0MPcCX9NHEfZVQUZIgHva04sOT4r3Rx3Fe66KSeP7CI92nYu4qpIJSKVairGp77NOJaEwZbBuALv3+u6/x3v/FwY3GOPCpaolAQNsTt4Wd4nzMYJDrubIbYt2+u04VpNDJSxUBxXgMrzGFGwZthzxl3xYA9R0SoXPrQDW3ff/n85UUCo6iA7G1reEt8O1xOPz02NfuupNHWyxoWiA0RICLKMNCcX6HIfStvXHYoV98rrBrftYsj5p2vVwp/y/qbnxZPZ4o5fEUHRPwxnM0F/nu4jt38lXxLJzzkT6QNmAJp5Y58GFJzeQ6uJeKq4T4W2XeZXHXJ5uSjz1WqAN864/Gin8F+QE/6FFeET2Ary0gR9ryzvtwPwwJjnUYjSjmDImgdeeQC6FzltEPkmTvRQlNS9DWYvV3XP/fbp29t9R/IMTvgZ+GKH4SXs5ZW+niFDH1jnSQqtDY8jcYQftLS5bGrFkOEathKh5SgqBnK9HC0umn1Bv+1tx/5k4u/ctaBHq8J2f5T3BUOA5+Sj4eWoHIp5SykAgUF+/J26RxUptCJEiQhSqxaKKfjpXOZy1wsMvJ6U2bFtCa4i1pt99rWqjcfePKY793HBDWNCWxiafg5+e+hNziNzzHEZ/Dx2dEH3LsP7E3ryNU4AVJuz1EaHnUq+4AfdcB93cAjNyavfHXRMZsn9ID7CQUEQPw03MFPeUBeFvoNp7CQNMeQ4UrqEfgZcXSSG3OTtjb3zki94IKbQq6vlAoZU6D5U8yqWMOkSN+z4Wr524vSt21YcvTr7y5i4pvgQ27yyyE/53AYtTSR4HomMV9WSAZLYGcFdAchlWeVlgAyKGylkT9wEu9xGBHKbD8pdwClHAqi75hGZb/K/PRaYyBdd2FJTffmq6I/2HzKiRt7Pszx0D5sQMQvwwl+yUpJaBVP8BemoopNfKakkuvKZ9AU8UFSy7+ZULZ0MxsQSpkLJnP78eR2z80Gigomk2U3hya2M6Onf0AMVd5+V8ktj5yh/0p/QVuyRzkS4xU+/KbxEWmCsOQCegDkgzWPiwDPqAYi6sc84k8sTZXz9UQlLYkKKhKlaOkSKWIqe9efK0h8Mls3WCZjhMwIDalec/pQT2JGX7i9vjd6/5IF19x/nLlBCWUG5PTUBxk+rhv3AfdxsB1sB9vBdrAdbAfbwVbk9r8uOlYtzojLLQAAAABJRU5ErkJggg==',
'img/rainbow-coin.png': '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',
'img/rainbow-coin.json': 'ewogICJ3aWR0aCI6IDIwLAogICJoZWlnaHQiOiAyMCwKICAiZGVmYXVsdEFuaW1hdGlvbiI6ICJpZGxlIiwKICAiZnJhbWVEdXJhdGlvbiI6IDAuMSwKICAiYW5pbWF0aW9ucyI6IHsKICAgICJpZGxlIjogewogICAgICAicm93IjogMCwKICAgICAgImxlbmd0aCI6IDgKICAgIH0KICB9Cn0=',
'img/stickfigure.json': 'ewogICJ3aWR0aCI6IDI1LAogICJoZWlnaHQiOiA0MCwKICAiZGVmYXVsdEFuaW1hdGlvbiI6ICJpZGxlIiwKICAiZnJhbWVEdXJhdGlvbiI6IDAuMSwKICAiYW5pbWF0aW9ucyI6IHsKICAgICJpZGxlIjogewogICAgICAicm93IjogMCwKICAgICAgImxlbmd0aCI6IDIsCiAgICAgICJmcmFtZUR1cmF0aW9uIjogMC44CiAgICB9LAogICAgImp1bXAiOiB7CiAgICAgICJyb3ciOiAxLAogICAgICAibGVuZ3RoIjogMQogICAgfSwKICAgICJqdW1wLXJpZ2h0IjogewogICAgICAicm93IjogMiwKICAgICAgImxlbmd0aCI6IDEKICAgIH0sCiAgICAianVtcC1sZWZ0IjogewogICAgICAicm93IjogMywKICAgICAgImxlbmd0aCI6IDEKICAgIH0sCiAgICAicnVuLXJpZ2h0IjogewogICAgICAicm93IjogNCwKICAgICAgImxlbmd0aCI6IDcsCiAgICAgICJmcmFtZUR1cmF0aW9uIjogMC4wNAogICAgfSwKICAgICJydW4tbGVmdCI6IHsKICAgICAgInJvdyI6IDUsCiAgICAgICJsZW5ndGgiOiA3LAogICAgICAiZnJhbWVEdXJhdGlvbiI6IDAuMDQKICAgIH0sCiAgICAiY2xpbWIiOiB7CiAgICAgICJyb3ciOiA2LAogICAgICAibGVuZ3RoIjogNiwKICAgICAgImZyYW1lRHVyYXRpb24iOiAwLjEKICAgIH0KICB9Cn0=',
'img/stickfigure.png': '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',
});
