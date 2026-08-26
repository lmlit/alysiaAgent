/**
 * ★ 昔涟控制台入口 UI(浏览器侧自执行脚本,仿 dsh-whale-widget 的 WIDGET_JS 注入)
 * 功能:右下角悬浮球 → 面板抽屉(画像 / 会话两个页,一期)
 * 样式:全部使用 --dsw-alias-* token(皮肤联动),缺失时回退 Cyrene 粉紫默认
 * 数据:经同源反代 /alysia-api/* → server 6185
 */

/** 生成注入浏览器的控制台脚本(mountPath 为静态资源挂载路径) */
export function buildConsoleWidgetJs(mountPath: string): string {
  // ★ 脚本内部禁止反引号/嵌套 ${},避免与外部模板插值冲突
  return `(function () {
  if (window.__alysiaConsole) return
  window.__alysiaConsole = true

  var MOUNT = ${JSON.stringify(mountPath)}
  var ICON_BG = 'linear-gradient(135deg, var(--dsw-alias-brand-primary, #ec4899), var(--dsw-alias-brand-primary-new-colorprimary-new-color, #8b5cf6))'
  var PANEL_BG = 'var(--dsw-alias-bg-layer-2, #181432)'
  var BORDER = 'var(--dsw-alias-border-l2, rgba(255,255,255,.08))'
  var TEXT = 'var(--dsw-alias-label-text-primary, #f3eefb)'
  var TEXT_DIM = 'var(--dsw-alias-label-text-secondary, rgba(243,238,251,.55))'
  var ROW_BG = 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.05))'
  var ACCENT = 'var(--dsw-alias-brand-primary, #ec4899)'

  var style = document.createElement('style')
  style.textContent = [
    '#alysia-console-root{position:fixed;right:20px;bottom:20px;z-index:9998;font-family:inherit}',
    '#alysia-console-root *{box-sizing:border-box}',
    '.alysia-console-fab{width:46px;height:46px;border-radius:50%;border:1px solid ' + BORDER + ';background:' + ICON_BG + ';color:#fff;font-size:20px;font-weight:800;cursor:pointer;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform .18s ease;user-select:none}',
    '.alysia-console-fab:hover{transform:scale(1.08)}',
    '.alysia-console-panel{position:fixed;right:20px;bottom:76px;width:min(400px,calc(100vw - 40px));max-height:70vh;display:flex;flex-direction:column;background:' + PANEL_BG + ';border:1px solid ' + BORDER + ';border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}',
    '.alysia-console-panel.open{opacity:1;transform:none;pointer-events:auto}',
    '.alysia-console-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid ' + BORDER + '}',
    '.alysia-console-head h3{margin:0;font-size:14px;font-weight:700;color:' + TEXT + ';flex:1}',
    '.alysia-console-close{width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:' + TEXT_DIM + ';cursor:pointer;font-size:14px}',
    '.alysia-console-close:hover{background:' + ROW_BG + '}',
    '.alysia-console-tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid ' + BORDER + '}',
    '.alysia-console-tab{padding:5px 12px;border:none;border-radius:8px;background:transparent;color:' + TEXT_DIM + ';cursor:pointer;font-size:12px;font-weight:600}',
    '.alysia-console-tab.active{background:' + ROW_BG + ';color:' + ACCENT + '}',
    '.alysia-console-body{padding:12px 16px;overflow-y:auto;color:' + TEXT + ';font-size:12px;line-height:1.6}',
    '.alysia-console-row{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;margin-bottom:8px;background:' + ROW_BG + ';border-radius:10px}',
    '.alysia-console-row .k{color:' + TEXT_DIM + ';white-space:nowrap}',
    '.alysia-console-row .v{text-align:right;word-break:break-all}',
    '.alysia-console-loading{color:' + TEXT_DIM + ';text-align:center;padding:18px 0}',
    '.alysia-console-err{color:#f87171;font-size:11px;padding:8px 12px;border:1px solid rgba(248,113,113,.3);border-radius:10px;margin-bottom:8px}',
    '.alysia-console-empty{color:' + TEXT_DIM + ';text-align:center;padding:22px 0}'
  ].join('\\n')
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.id = 'alysia-console-root'
  root.innerHTML =
    '<button class="alysia-console-fab" title="昔涟控制台">昔</button>' +
    '<div class="alysia-console-panel">' +
      '<div class="alysia-console-head"><h3>昔涟控制台</h3>' +
        '<button class="alysia-console-close" title="关闭">×</button></div>' +
      '<div class="alysia-console-tabs">' +
        '<button class="alysia-console-tab active" data-page="profile">画像</button>' +
        '<button class="alysia-console-tab" data-page="sessions">会话</button>' +
      '</div>' +
      '<div class="alysia-console-body"></div>' +
    '</div>'
  document.body.appendChild(root)

  var fab = root.querySelector('.alysia-console-fab')
  var panel = root.querySelector('.alysia-console-panel')
  var body = root.querySelector('.alysia-console-body')
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.alysia-console-tab'))
  var open = false

  function api(path) {
    return fetch('/alysia-api' + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (data) {
        if (data && data.error && typeof data.error === 'string' && !data.status) throw new Error(data.error)
        return data
      })
  }
  function row(k, v) {
    return '<div class="alysia-console-row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'
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

  function show() {
    open = true
    panel.classList.add('open')
    ;(pages[tabs.find(function (t) { return t.classList.contains('active') }).dataset.page] || renderProfile)()
  }
  function hide() { open = false; panel.classList.remove('open') }

  fab.addEventListener('click', function () { open ? hide() : show() })
  root.querySelector('.alysia-console-close').addEventListener('click', hide)
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active') })
      t.classList.add('active')
      ;(pages[t.dataset.page] || renderProfile)()
    })
  })
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) hide() })
})()`
}
