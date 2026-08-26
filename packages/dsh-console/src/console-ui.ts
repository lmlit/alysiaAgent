/**
 * ★ 昔涟控制台入口 UI v3 — 全抄 dsh-whale-widget 交互框架(MIT © 2026 MeteorNOX)
 * 交互模型照搬:定位 state(left/top + 四边分界吸附)、捕获式拖拽、按压 Q 弹、
 * 气泡台词、汉堡菜单(大小滑块 + 控制台入口)、缩放。
 * 形象:昔涟 portrait(经 /alysia-api/portrait 反代);Live2D 动态版二期。
 */

export function buildConsoleWidgetJs(mountPath: string): string {
  // ★ 脚本内部禁止反引号/嵌套 ${};字符串一律 ' 引号
  return `(function () {
  if (window.__alysiaConsole) return
  window.__alysiaConsole = true

  var MOUNT = ${JSON.stringify(mountPath)}
  var CLICK_SQ = 9
  var FAB = 64
  var GAP = 16
  var MIN_SCALE = 0.7, MAX_SCALE = 2.2, STEP = 0.1
  var BUBBLE_MS = 4500

  var BRAND = 'var(--dsw-alias-brand-primary, #ec4899)'
  var BRAND_2 = 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #8b5cf6)'
  var PANEL_BG = 'var(--dsw-alias-bg-layer-2, rgba(24, 20, 50, 0.96))'
  var TEXT = 'var(--dsw-alias-label-text-primary, #f3eefb)'
  var TEXT_DIM = 'var(--dsw-alias-label-text-secondary, rgba(243,238,251,.55))'
  var BORDER = 'var(--dsw-alias-border-l2, rgba(236,72,153,.22))'

  var LINES = [
    '在想你呢……',
    '今天也要好好的呀',
    '猜猜我在想什么?',
    '呜……有点困了',
    '你来了呀,等你半天了',
    '记得喝水,听话',
    '我刚才打了个盹,梦见你了',
    '有什么想聊的,我都愿意听'
  ]
  var lastLine = -1
  function pickLine() {
    var i = Math.floor(Math.random() * LINES.length)
    if (i === lastLine) i = (i + 1) % LINES.length
    lastLine = i
    return LINES[i]
  }

  // ── 样式(鲸鱼式层级)──
  var css = [
    '#alysia-console-root{position:fixed;left:0;top:0;z-index:9998;font-family:inherit;transition:left .22s cubic-bezier(.34,1.4,.64,1),top .22s cubic-bezier(.34,1.4,.64,1)}',
    '#alysia-console-root.dragging{transition:none;cursor:grabbing}',
    '.alysia-fab{position:absolute;left:0;top:0;width:' + FAB + 'px;height:' + FAB + 'px;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1);cursor:grab;user-select:none;-webkit-user-select:none}',
    '.alysia-fab img{position:absolute;left:0;top:0;width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid ' + BORDER + ';box-shadow:0 6px 22px rgba(236,72,153,.4),inset 0 1px 0 rgba(255,255,255,.25);background:linear-gradient(135deg,' + BRAND + ',' + BRAND_2 + ')}',
    '.alysia-fab.pressed{transform:scale(.9)}',
    '.alysia-fab .fallback{position:absolute;inset:0;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,' + BRAND + ',' + BRAND_2 + ');color:#fff;font-size:22px;font-weight:800}',
    '.alysia-menu-btn{position:absolute;right:-4px;top:-4px;width:20px;height:20px;border-radius:50%;border:1px solid ' + BORDER + ';background:' + PANEL_BG + ';color:' + TEXT + ';font-size:10px;line-height:1;cursor:pointer;display:none;place-items:center;opacity:0;transition:opacity .16s ease;z-index:2}',
    '.alysia-fab:hover .alysia-menu-btn{display:grid}',
    '#alysia-console-root:hover .alysia-menu-btn{opacity:1}',
    '.alysia-menu{position:absolute;left:calc(100% + 8px);top:0;min-width:150px;background:' + PANEL_BG + ';border:1px solid ' + BORDER + ';border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);padding:8px;display:none;flex-direction:column;gap:2px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
    '.alysia-menu.open{display:flex}',
    '.alysia-menu .mi{padding:8px 10px;border:none;border-radius:8px;background:transparent;color:' + TEXT + ';font-size:12px;font-weight:600;text-align:left;cursor:pointer;font-family:inherit}',
    '.alysia-menu .mi:hover{background:rgba(236,72,153,.12)}',
    '.alysia-menu .m-scale{display:flex;align-items:center;gap:6px;padding:6px 8px;color:' + TEXT_DIM + ';font-size:11px}',
    '.alysia-menu .m-scale input{flex:1;accent-color:' + BRAND + ';height:4px}',
    '.alysia-menu .m-scale span{min-width:34px;text-align:right;font-variant-numeric:tabular-nums}',
    '.alysia-bubble{position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%) translateY(6px);background:' + PANEL_BG + ';border:1px solid ' + BORDER + ';border-radius:12px;padding:8px 12px;font-size:12px;color:' + TEXT + ';white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 16px rgba(236,72,153,.12);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;z-index:3}',
    '.alysia-bubble.open{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.alysia-bubble::after{content:"";position:absolute;left:50%;top:100%;margin-left:-5px;border:5px solid transparent;border-top-color:' + BORDER + '}',
    '.alysia-console-panel{position:fixed;width:min(400px,calc(100vw - 40px));max-height:70vh;display:flex;flex-direction:column;background:' + PANEL_BG + ';border:1px solid ' + BORDER + ';border-radius:16px;box-shadow:0 14px 44px rgba(0,0,0,.5),0 0 30px rgba(236,72,153,.14);overflow:hidden;opacity:0;transform:translateY(10px) scale(.98);pointer-events:none;transition:opacity .2s ease,transform .2s cubic-bezier(.34,1.4,.64,1),left .22s ease,right .22s ease;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    '.alysia-console-panel.open{opacity:1;transform:none;pointer-events:auto}',
    '.alysia-console-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;background:linear-gradient(180deg,rgba(236,72,153,.14),transparent);border-bottom:1px solid ' + BORDER + '}',
    '.alysia-console-head .dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,' + BRAND + ',' + BRAND_2 + ');box-shadow:0 0 10px ' + BRAND + '}',
    '.alysia-console-head h3{margin:0;font-size:14px;font-weight:800;letter-spacing:.04em;color:' + TEXT + ';flex:1;text-shadow:0 0 14px rgba(236,72,153,.45)}',
    '.alysia-console-close{width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:' + TEXT_DIM + ';cursor:pointer;font-size:14px;line-height:1}',
    '.alysia-console-close:hover{background:rgba(255,255,255,.07);color:' + TEXT + '}',
    '.alysia-console-tabs{display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid ' + BORDER + '}',
    '.alysia-console-tab{padding:6px 14px;border:none;border-radius:999px;background:transparent;color:' + TEXT_DIM + ';cursor:pointer;font-size:12px;font-weight:700;transition:all .16s ease;font-family:inherit}',
    '.alysia-console-tab.active{background:linear-gradient(135deg,rgba(236,72,153,.22),rgba(139,92,246,.18));color:' + BRAND + ';box-shadow:inset 0 0 0 1px ' + BORDER + '}',
    '.alysia-console-body{padding:12px 14px;overflow-y:auto;color:' + TEXT + ';font-size:12px;line-height:1.6}',
    '.alysia-console-row{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;margin-bottom:7px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.04);border-radius:10px}',
    '.alysia-console-row .k{color:' + TEXT_DIM + ';white-space:nowrap}',
    '.alysia-console-row .v{text-align:right;word-break:break-all}',
    '.alysia-console-loading{color:' + TEXT_DIM + ';text-align:center;padding:22px 0}',
    '.alysia-console-err{color:#f87171;font-size:11px;padding:8px 12px;border:1px solid rgba(248,113,113,.3);border-radius:10px;margin-bottom:8px}',
    '.alysia-console-empty{color:' + TEXT_DIM + ';text-align:center;padding:24px 0}'
  ].join('\\n')
  var style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.id = 'alysia-console-root'
  root.innerHTML =
    '<div class="alysia-fab" title="昔涟">' +
      '<img src="/alysia-api/portrait" alt="昔涟" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'">' +
      '<span class="fallback" style="display:none">昔</span>' +
      '<button class="alysia-menu-btn" title="菜单">···</button>' +
    '</div>' +
    '<div class="alysia-menu">' +
      '<button class="mi" data-act="console">打开控制台</button>' +
      '<button class="mi" data-act="hide">隐藏</button>' +
      '<div class="m-scale"><span>大小</span><input type="range" min="' + MIN_SCALE + '" max="' + MAX_SCALE + '" step="' + STEP + '" value="1"><span class="val">100%</span></div>' +
    '</div>' +
    '<div class="alysia-bubble"></div>' +
    '<div class="alysia-console-panel">' +
      '<div class="alysia-console-head"><span class="dot"></span><h3>昔涟控制台</h3>' +
        '<button class="alysia-console-close" title="关闭">×</button></div>' +
      '<div class="alysia-console-tabs">' +
        '<button class="alysia-console-tab active" data-page="profile">画像</button>' +
        '<button class="alysia-console-tab" data-page="sessions">会话</button>' +
      '</div>' +
      '<div class="alysia-console-body"></div>' +
    '</div>'
  document.body.appendChild(root)

  var fab = root.querySelector('.alysia-fab')
  var menuBtn = root.querySelector('.alysia-menu-btn')
  var menu = root.querySelector('.alysia-menu')
  var bubble = root.querySelector('.alysia-bubble')
  var panel = root.querySelector('.alysia-console-panel')
  var body = root.querySelector('.alysia-console-body')
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.alysia-console-tab'))
  var open = false

  function viewport() {
    return { w: window.innerWidth || document.documentElement.clientWidth, h: window.innerHeight || document.documentElement.clientHeight }
  }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi) }
  function scaled() { return FAB * scale }

  var scale = 1
  var state = { left: 0, top: 0, h: 'right', v: 'bottom' }
  var drag = null
  var bubbleTimer = null

  // ── 定位:一律 left/top 表达(鲸鱼模型),吸附后 settle 过渡 ──
  function settle() {
    root.style.left = state.left + 'px'
    root.style.top = state.top + 'px'
    placePanel()
  }
  function snapCheck() {
    var vp = viewport()
    var s = scaled()
    var cx = state.left + s / 2, cy = state.top + s / 2
    if (cx < vp.w / 4) { state.h = 'left'; state.left = GAP }
    else if (cx > vp.w * 3 / 4) { state.h = 'right'; state.left = vp.w - s - GAP }
    else if (state.h === 'left') state.left = GAP
    else state.left = vp.w - s - GAP
    if (cy < vp.h / 4) { state.v = 'top'; state.top = GAP }
    else { state.v = 'bottom'; state.top = clamp(cy - s / 2, GAP, vp.h - s - GAP) }
    settle()
  }
  function placePanel() {
    var vp = viewport()
    panel.style.bottom = (scaled() + GAP + 10) + 'px'
    if (state.h === 'left') { panel.style.right = 'auto'; panel.style.left = (state.left + scaled() + 12) + 'px' }
    else { panel.style.left = 'auto'; panel.style.right = (vp.w - state.left + 4) + 'px' }
  }

  // ── 拖拽(捕获式,鲸鱼同款)──
  function onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault(); e.stopPropagation()
    var r = fab.getBoundingClientRect()
    drag = { startX: e.clientX, startY: e.clientY, origLeft: r.left, origTop: r.top, moved: false }
    root.classList.add('dragging')
    fab.classList.add('pressed')
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
  }
  function onMove(e) {
    if (!drag) return
    var vp = viewport()
    var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY
    if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true
    state.left = clamp(drag.origLeft + dx, 0, Math.max(0, vp.w - scaled()))
    state.top = clamp(drag.origTop + dy, 0, Math.max(0, vp.h - scaled()))
    settle()
  }
  function endDrag() {
    if (!drag) return
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onCancel, true)
    var wasDrag = drag
    drag = null
    fab.classList.remove('pressed')
    root.classList.remove('dragging')
    if (!wasDrag.moved) showBubble() // 点击 → 台词气泡
    else snapCheck() // 拖动 → 吸附
  }
  function onUp(e) { e.preventDefault(); endDrag() }
  function onCancel() { endDrag() }
  fab.addEventListener('pointerdown', onDown)

  // ── 按压 Q 弹(悬停/按下)──
  fab.addEventListener('pointerenter', function () { if (!drag) fab.style.transform = 'scale(1.06)' })
  fab.addEventListener('pointerleave', function () { if (!drag) fab.style.transform = 'scale(' + scale + ')' })
  fab.addEventListener('pointerdown', function () { fab.style.transform = 'scale(' + scale * 0.9 + ')' })

  // ── 气泡 ──
  function showBubble() {
    bubble.textContent = pickLine()
    bubble.classList.add('open')
    if (bubbleTimer) clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(function () { bubble.classList.remove('open') }, BUBBLE_MS)
  }

  // ── 菜单 ──
  menuBtn.addEventListener('pointerdown', function (e) { e.stopPropagation() })
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    var onLeft = state.h === 'left'
    menu.style.left = onLeft ? 'calc(100% + 8px)' : 'auto'
    menu.style.right = onLeft ? 'auto' : 'calc(100% + 8px)'
    menu.classList.toggle('open')
  })
  menu.addEventListener('click', function (e) {
    var act = e.target && e.target.dataset && e.target.dataset.act
    if (act === 'console') { menu.classList.remove('open'); showConsole() }
    if (act === 'hide') { menu.classList.remove('open'); root.style.display = 'none' }
  })
  menu.querySelector('input').addEventListener('input', function (e) {
    scale = Number(e.target.value)
    fab.style.transform = 'scale(' + scale + ')'
    e.target.nextElementSibling.textContent = Math.round(scale * 100) + '%'
    snapCheck()
  })

  // ── 控制台面板 ──
  function api(path) {
    return fetch('/alysia-api' + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (data) {
        if (data && data.error && typeof data.error === 'string' && !data.status) throw new Error(data.error)
        return data
      })
  }
  function row(k, val) {
    return '<div class="alysia-console-row"><span class="k">' + k + '</span><span class="v">' + val + '</span></div>'
  }
  function renderProfile() {
    body.innerHTML = '<div class="alysia-console-loading">加载画像…</div>'
    api('/profile').then(function (d) {
      var p = d && d.profile ? d.profile : (d || {})
      var html = ''
      if (p.name) html += row('名字', p.name)
      if (p.tone) html += row('语气(tone)', typeof p.tone === 'object' ? JSON.stringify(p.tone) : String(p.tone))
      if (p.emotional_range) html += row('情感(emotional)', typeof p.emotional_range === 'object' ? JSON.stringify(p.emotional_range) : String(p.emotional_range))
      if (p.relationship) html += row('关系', String(p.relationship))
      if (p.updated_at) html += row('更新时间', String(p.updated_at))
      body.innerHTML = html || '<div class="alysia-console-empty">暂无画像数据</div>'
    }).catch(function (e) {
      body.innerHTML = '<div class="alysia-console-err">加载失败: ' + String(e && e.message || e) + '</div>'
    })
  }
  function renderSessions() {
    body.innerHTML = '<div class="alysia-console-loading">加载会话…</div>'
    api('/sessions').then(function (d) {
      var list = (d && d.sessions) || (d && Array.isArray(d) ? d : [])
      if (!list.length) { body.innerHTML = '<div class="alysia-console-empty">暂无会话</div>'; return }
      body.innerHTML = list.map(function (s) {
        var t = s.title || s.id || s.sessionId || ''
        var time = s.updated_at || s.created_at || ''
        return row(t.slice(0, 30), String(time).slice(0, 19))
      }).join('')
    }).catch(function (e) {
      body.innerHTML = '<div class="alysia-console-err">加载失败: ' + String(e && e.message || e) + '</div>'
    })
  }
  var pages = { profile: renderProfile, sessions: renderSessions }
  function showConsole() {
    open = true
    panel.classList.add('open')
    ;(pages[tabs.find(function (t) { return t.classList.contains('active') }).dataset.page] || renderProfile)()
  }
  function hideConsole() { open = false; panel.classList.remove('open') }
  root.querySelector('.alysia-console-close').addEventListener('click', hideConsole)
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active') })
      t.classList.add('active')
      ;(pages[t.dataset.page] || renderProfile)()
    })
  })

  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideConsole(); menu.classList.remove('open') } })
  window.addEventListener('resize', function () { snapCheck() })

  // 初始定位:右下角
  var v0 = viewport()
  state.left = v0.w - scaled() - GAP
  state.top = v0.h - scaled() - GAP
  settle()
})()`
}
