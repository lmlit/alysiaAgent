/* 绿野 Luye · 背景天气系统（晴 / 雨 / 雪）
 * 移植自 Ron567 个人主页 weather.js，适配全屏 fixed 画布。
 * defer 加载，不阻塞解析；画布位于内容之下（z-index 0），pointer-events:none。
 * 默认关闭；仅在天气激活时运行 rAF 循环；localStorage 持久化用户选择。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'luye-weather';
  var MODES = ['sun', 'rain', 'snow'];
  var DPR_CAP = 1.5;
  var REF_AREA = 1440 * 900; // 粒子基数按此面积标定
  var BASE_COUNT = { sun: 60, rain: 130, snow: 150 };
  var MAX_DT = 50; // ms，钳制标签页切换后的时间跳变

  var canvas = null;
  var ctx = null;
  var mode = 'off';
  var particles = [];
  var rafId = null;
  var lastTime = 0;
  var width = 0;
  var height = 0;
  var sunSprite = null;
  var shaftSprite = null;
  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reducedMotion = !!(motionQuery && motionQuery.matches);

  // ---------- 持久化 ----------
  function readStoredMode() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return MODES.indexOf(v) !== -1 ? v : 'off';
    } catch (e) {
      return 'off';
    }
  }

  function storeMode(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (e) { /* 存储不可用（隐私模式等）：仅本次会话有效 */ }
  }

  // ---------- 画布生命周期 ----------
  function ensureCanvas() {
    if (canvas) { return; }
    canvas = document.createElement('canvas');
    canvas.id = 'weather-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild || null);
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) { return; }
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (mode !== 'off') {
      buildParticles(mode);
      if (reducedMotion) { drawFrame(); }
    }
  }

  // ---------- 粒子构建 ----------
  function rand(min, max) { return min + Math.random() * (max - min); }

  function scaledCount(base) {
    var area = width * height;
    if (area <= 0) { return base; }
    return Math.max(24, Math.round(base * area / REF_AREA));
  }

  function buildParticles(kind) {
    var n = scaledCount(BASE_COUNT[kind]);
    var list = [];
    var i;
    if (kind === 'sun') {
      for (i = 0; i < n; i++) {
        list.push({
          x: rand(0, width), y: rand(0, height),
          r: rand(1.2, 3.4),
          vx: rand(-6, 6), vy: rand(-9, -2),
          phase: rand(0, Math.PI * 2), sway: rand(8, 26),
          alpha: rand(0.10, 0.32), size: rand(14, 34)
        });
      }
    } else if (kind === 'rain') {
      for (i = 0; i < n; i++) {
        list.push({
          x: rand(-40, width + 40), y: rand(-height, height),
          len: rand(14, 30),
          speed: rand(900, 1400), slant: rand(60, 110),
          alpha: rand(0.12, 0.30)
        });
      }
    } else if (kind === 'snow') {
      for (i = 0; i < n; i++) {
        list.push({
          x: rand(0, width), y: rand(-height, height),
          r: rand(0.9, 2.9),
          speed: rand(28, 78),
          phase: rand(0, Math.PI * 2), sway: rand(18, 46),
          alpha: rand(0.35, 0.85)
        });
      }
    }
    particles = list;
  }

  // ---------- 渲染 ----------
  function getSunSprite() {
    if (sunSprite) { return sunSprite; }
    sunSprite = document.createElement('canvas');
    sunSprite.width = 64;
    sunSprite.height = 64;
    var c = sunSprite.getContext('2d');
    var g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(246, 233, 178, 0.9)');
    g.addColorStop(0.35, 'rgba(233, 222, 160, 0.35)');
    g.addColorStop(1, 'rgba(233, 222, 160, 0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    return sunSprite;
  }

  function getShaftSprite() {
    if (shaftSprite) { return shaftSprite; }
    var w = 256, h = 1024;
    shaftSprite = document.createElement('canvas');
    shaftSprite.width = w;
    shaftSprite.height = h;
    var c = shaftSprite.getContext('2d');
    var lateral = c.createLinearGradient(0, 0, w, 0);
    lateral.addColorStop(0, 'rgba(233, 222, 160, 0)');
    lateral.addColorStop(0.5, 'rgba(233, 222, 160, 0.9)');
    lateral.addColorStop(1, 'rgba(233, 222, 160, 0)');
    c.fillStyle = lateral;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out';
    var vertical = c.createLinearGradient(0, 0, 0, h);
    vertical.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vertical.addColorStop(0.7, 'rgba(0, 0, 0, 0.75)');
    vertical.addColorStop(1, 'rgba(0, 0, 0, 1)');
    c.fillStyle = vertical;
    c.fillRect(0, 0, w, h);
    return shaftSprite;
  }

  function drawLightShafts(t) {
    var sprite = getShaftSprite();
    var i, cx, shaftW;
    for (i = 0; i < 3; i++) {
      cx = width * (0.18 + i * 0.3) + Math.sin(t * 0.05 + i * 2.1) * width * 0.04;
      shaftW = width * 0.14;
      ctx.save();
      ctx.translate(cx, 0);
      ctx.rotate(0.10);
      ctx.globalAlpha = 0.08;
      ctx.drawImage(sprite, -shaftW / 2, -height * 0.02, shaftW, height * 1.04);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawFrame() {
    if (!ctx) { return; }
    ctx.clearRect(0, 0, width, height);
    var t = performance.now() / 1000;
    var i, p, dx;
    if (mode === 'sun') {
      drawLightShafts(t);
      var sprite = getSunSprite();
      for (i = 0; i < particles.length; i++) {
        p = particles[i];
        dx = p.x + Math.sin(t * 0.35 + p.phase) * p.sway;
        ctx.globalAlpha = p.alpha;
        ctx.drawImage(sprite, dx - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    } else if (mode === 'rain') {
      ctx.strokeStyle = 'rgb(174, 205, 224)';
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      for (i = 0; i < particles.length; i++) {
        p = particles[i];
        var k = p.len / p.speed;
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.slant * k, p.y - p.len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (mode === 'snow') {
      ctx.fillStyle = '#FFFFFF';
      for (i = 0; i < particles.length; i++) {
        p = particles[i];
        dx = p.x + Math.sin(t * 0.6 + p.phase) * p.sway;
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(dx, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------- 动画循环 ----------
  // 热循环内有意原地修改粒子坐标（每帧新建对象会造成 GC 压力）。
  function update(dt) {
    var i, p;
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      if (mode === 'sun') {
        p.y += p.vy * dt;
        p.x += p.vx * dt;
        if (p.y < -20) { p.y = height + 20; p.x = rand(0, width); }
        if (p.x < -20) { p.x = width + 20; } else if (p.x > width + 20) { p.x = -20; }
      } else if (mode === 'rain') {
        p.y += p.speed * dt;
        p.x += p.slant * dt;
        if (p.y > height + 40) { p.y = rand(-120, -40); p.x = rand(-40, width + 40); }
      } else if (mode === 'snow') {
        p.y += p.speed * dt;
        if (p.y > height + 6) { p.y = rand(-60, -6); p.x = rand(0, width); }
      }
    }
  }

  function tick(now) {
    rafId = null;
    if (mode === 'off') { return; }
    var dt = Math.max(0, Math.min(now - lastTime, MAX_DT)) / 1000;
    lastTime = now;
    update(dt);
    drawFrame();
    rafId = window.requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId === null && !reducedMotion && !document.hidden) {
      lastTime = performance.now();
      rafId = window.requestAnimationFrame(tick);
    }
  }

  function stopLoop() {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ---------- 状态机 ----------
  function setMode(next, persist) {
    if (MODES.indexOf(next) === -1) { next = 'off'; }
    mode = next;
    if (persist !== false) { storeMode(mode); }
    updateControls();
    if (mode === 'off') {
      stopLoop();
      particles = [];
      if (ctx) { ctx.clearRect(0, 0, width, height); }
      return;
    }
    ensureCanvas();
    buildParticles(mode);
    if (reducedMotion) {
      drawFrame(); // 减少动态偏好：仅绘制一帧静态画面
    } else {
      stopLoop();
      startLoop();
    }
  }

  // ---------- 控件 ----------
  function updateControls() {
    var btns = document.querySelectorAll('.weather-btn');
    for (var i = 0; i < btns.length; i++) {
      var active = btns[i].getAttribute('data-weather') === mode;
      btns[i].classList.toggle('active', active);
      btns[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function bindControls() {
    var btns = document.querySelectorAll('.weather-btn');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var w = btn.getAttribute('data-weather');
          setMode(w === mode ? 'off' : w);
        });
      })(btns[i]);
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopLoop();
    } else if (mode !== 'off' && !reducedMotion) {
      startLoop();
    }
  });

  function onMotionChange(e) {
    reducedMotion = e.matches;
    if (mode === 'off') { return; }
    if (reducedMotion) { stopLoop(); drawFrame(); }
    else { startLoop(); }
  }
  if (motionQuery) {
    if (motionQuery.addEventListener) { motionQuery.addEventListener('change', onMotionChange); }
    else if (motionQuery.addListener) { motionQuery.addListener(onMotionChange); }
  }

  // ---------- 初始化 ----------
  function init() {
    bindControls();
    setMode(readStoredMode(), false); // 恢复存储状态，不回写
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
