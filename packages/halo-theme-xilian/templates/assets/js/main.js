/* 绿野 Luye · 主题交互脚本
 * 移动端导航 / 滚动显现 / 返回顶部 / 导航高亮 / 阅读时间
 */
(function () {
  'use strict';

  // ---------- 移动端导航 ----------
  var toggle = document.getElementById('nav-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      document.body.classList.toggle('nav-open');
    });
    // 点击菜单项后收起
    var links = document.querySelectorAll('.nav-center a');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function () {
        document.body.classList.remove('nav-open');
      });
    }
  }

  // ---------- 返回顶部 ----------
  var toTop = document.getElementById('to-top');
  if (toTop) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          toTop.classList.toggle('show', window.scrollY > window.innerHeight * 0.6);
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ---------- 滚动显现（尊重 prefers-reduced-motion，CSS 侧亦有兜底） ----------
  // 仅在脚本执行到这里后启用隐藏初始状态，脚本失败时内容仍保持可见。
  document.documentElement.classList.add('reveal-ready');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.10 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  // ---------- 导航高亮（按路径匹配） ----------
  try {
    var path = window.location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('.nav-center a').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') { return; }
      var ap;
      try {
        ap = new URL(href, window.location.origin).pathname.replace(/\/+$/, '') || '/';
      } catch (e) { return; }
      if (new URL(href, window.location.origin).origin === window.location.origin && ap === path) {
        a.classList.add('active');
      }
    });
  } catch (e) { /* 忽略 */ }

  // ---------- 阅读时间 ----------
  var postContent = document.querySelector('.post-content');
  var readingTimeEl = document.querySelector('.reading-time');
  if (postContent && readingTimeEl) {
    var text = postContent.textContent || postContent.innerText || '';
    text = text.replace(/\s+/g, '');
    var cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    var nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ');
    var words = nonCjk.split(/\s+/).filter(function (w) { return w.length > 0; }).length;
    var minutes = Math.ceil(cjk / 400 + words / 200);
    if (minutes < 1) minutes = 1;
    var textEl = readingTimeEl.querySelector('.reading-time-text');
    if (textEl) textEl.textContent = minutes + ' 分钟阅读';
    readingTimeEl.removeAttribute('hidden');
  }
})();
