/**
 * Copyright: (c) 2016 Max Klein
 * License: MIT
 */

(function (window, document) {
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
				cb(e);
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

})(window, document);
