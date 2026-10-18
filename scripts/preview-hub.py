#!/usr/bin/env python3
# preview-hub.py —— 生成「基站」首页：把她发布过的**每一个页面**列成卡片。
#
# ★ 为什么要生成而不是手写：
#   「她每做一个新东西」都要能在总入口里被看到，而不是每次让人给她一个新地址。
#   手写的首页一定会腐烂（新项目忘了加、删了没删）。
#
# ★ 2026-10-18 修正：原先**按项目**出卡（一个项目一张）。用户指出「基站列表没有更新」——
#   她在同一个项目里加了第二个页面（slow-clock.html），基站上看不到。
#   ⇒ 现在**按页面**列：`public/` 下每个 .html 都是一张卡（标题取该文件的 <title>）。
#     `index.html` 的地址是 `/p/<项目>/`，其它页面是 `/p/<项目>/<文件名>`。
#
# 输入：/root/alysia/config.yml 的 projects.*（服务端登记的项目）
# 判据：<workspace>/public/ 下有 .html ⇒ 这些页面"已发布"
# 产出：
#   /srv/alysia-preview/p/<id>   → 符号链接到 <workspace>/public（只读地对外）
#   /srv/alysia-preview/index.html → 卡片墙（一页一卡）
#
# ⚠️ 它不是 web 服务，只是**生成器**：由 systemd timer 每 10s 跑一次（幂等）。
# ⚠️ 以 root 跑：她要发布只能写自己工作区的 public/，**碰不到基站**（边界没破）。

import os
import re
import shutil
import sys
import html
import json
from datetime import datetime

CONFIG = "/root/alysia/config.yml"
OUT_ROOT = "/srv/alysia-preview"
PREFIX = "p"  # 页面 URL 前缀：/p/<id>/
# ★ 2026-10-18（change: `fix-receipt-link-to-produced-page`）：
#   `w/<id>` = **只读预览通道**，符号链接到工作区根目录（不是 `public/`）。
#   为什么要有它：`allowPublish` 默认 false ⇒ 多数轮次的产物**没进 `public/`**，
#   于是"回执给她刚做的那个页面"这条契约（§11 契约 38）会指向 404。
#   预览通道让"还没上线"的页面也点得开，又**不**等于自动发布（没动 public/）。
#   ⚠️ 只 serve 白名单扩展名 + 屏蔽隐藏/敏感路径，见 `preview-serve.py`。
PREVIEW_PREFIX = "w"

# 一页一卡；防御性上限（万一有人往 public/ 里塞几千个文件）
MAX_PAGES = 200

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def load_projects():
    try:
        import yaml  # noqa
    except ImportError:
        print("!! 缺 pyyaml", file=sys.stderr)
        return {}
    try:
        with open(CONFIG, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except FileNotFoundError:
        print(f"!! 读不到 {CONFIG}", file=sys.stderr)
        return {}
    projects = cfg.get("projects") or {}
    return projects if isinstance(projects, dict) else {}


def page_title(html_path: str, fallback: str) -> str:
    try:
        with open(html_path, encoding="utf-8", errors="ignore") as f:
            head = f.read(4096)
        m = TITLE_RE.search(head)
        if m:
            t = re.sub(r"<[^>]+>", "", m.group(1)).strip()
            if t:
                return t
    except OSError:
        pass
    return fallback


def human_time(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


HUB_CSS = """
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(1200px 600px at 20% -10%,#3a2b45,transparent),radial-gradient(900px 500px at 110% 10%,#2b3b46,transparent),#14121a;color:#efe9f4;
     font-family:system-ui,-apple-system,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7}
.wrap{max-width:1000px;margin:0 auto;padding:72px 24px 96px}
header h1{margin:0 0 8px;font-size:clamp(28px,5vw,44px);font-weight:600;letter-spacing:.02em}
header p{margin:0;color:#b9aec7}
.grid{margin-top:44px;display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
a.card{display:block;padding:22px 22px 18px;border-radius:18px;text-decoration:none;color:inherit;
  background:linear-gradient(160deg,rgba(255,255,255,.09),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.10);
  transition:transform .18s ease,border-color .18s ease,background .18s ease}
a.card:hover{transform:translateY(-3px);border-color:rgba(255,190,220,.45);background:linear-gradient(160deg,rgba(255,190,220,.14),rgba(255,255,255,.04))}
.card .t{font-size:19px;font-weight:600;margin:0 0 6px}
.card .id{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9d8fae}
.card .meta{margin-top:14px;font-size:12px;color:#8d819c;display:flex;justify-content:space-between;gap:10px}
.empty{margin-top:44px;padding:36px;border-radius:18px;border:1px dashed rgba(255,255,255,.18);color:#a99cb8;text-align:center}
.site{margin-top:26px}
.site a.card.head{display:block}
.site .chips{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
.chip{font-size:12.5px;padding:5px 12px;border-radius:999px;text-decoration:none;color:#cfc2e0;
  border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);transition:border-color .15s ease,color .15s ease}
.chip:hover{border-color:rgba(255,190,220,.5);color:#fff}
header .more{margin-top:12px;font-size:14px}
header .more a{color:#c9b6e4;text-decoration:none;border-bottom:1px dashed rgba(201,182,228,.5)}
footer{margin-top:56px;font-size:12px;color:#7d7289}
"""

HUB_HTML = """<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>昔涟的基站</title>
<style>{css}</style>
</head><body><div class="wrap">
<header>
  <h1>昔涟的基站</h1>
  <p>她做完的东西都在这儿，按<strong>站</strong>放。一个站里的页面，进站里找。</p>
  <p class="more"><a href="/pages">{allhint}</a></p>
</header>
{body}
<footer>共 {site_count} 个站 · {count} 个页面 · 自动生成于 {now} · 她只负责内容，这里不收集任何信息</footer>
</div></body></html>
"""

# ★ 2026-10-18 改（用户原话：「这里应该只放上线的，还有就是，有些是作为**子页面**的吧，
#   比如昔涟的日记」）：
#   上一版把 `public/` 里的每个 .html 平铺成一张卡 —— 于是「昔涟·写字的地方」这个站
#   和它的五篇日记（`essay-*.html`）、「关于我」并排，看起来像六个网站。
#   ⇒ 首页改成**一级：站**（一个项目一张卡），**二级：站内页面**（卡片里的小链接）。
#   判据没变：站 = `public/index.html` 存在（契约 34）。
SITE_CARD = """<div class="site">
  <a class="card head" href="{href}">
    <p class="t">{title}</p>
    <div class="id">{pid}</div>
    <div class="meta"><span>{n} 个页面</span><span>更新于 {mtime}</span><span>打开 →</span></div>
  </a>
  <div class="chips">{chips}</div>
</div>"""

CHIP = """<a class="chip" href="{href}">{label}</a>"""

# ★ 2026-10-18（change: `collect-produced-page-links`）：
#   用户原话「要不我们**单独开个地方放产出的网页链接**进去？」。
#   基站首页只列**已发布**的页面（契约 34 的判据是 `public/`），于是"她刚做的、还没上线的那页"
#   在总入口里根本不存在 —— 只能靠回执里那条链接，滚过去就找不着了。
#   所以多生成一页 `/pages`（= `/pages.html`，`serve.py` 会把无后缀的 `/pages` 301 过去）：
#   **同一份工作区里所有她做的页面**，已上线与预览并列，各自直链，最新在前。
#   ⚠️ 只读派生：不写 `public/`、不改她的文件，纯展示。
PAGES_HTML = """<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>她做过的页面</title>
<style>{css}</style>
</head><body><div class="wrap">
<header>
  <h1>她做过的页面</h1>
  <p>按时间倒序。<strong>已上线</strong>的走 <code>/p/</code>，<strong>还没上线的</strong>走只读预览 <code>/w/</code> —— 一样点得开。</p>
  <p class="more"><a href="/">← 回基站</a></p>
</header>
{body}
<footer>共 {count} 个页面（已上线 {published_n} · 预览 {draft_n}）· 自动生成于 {now}</footer>
</div></body></html>
"""

PAGE_ROW = """<a class="row" href="{href}">
  <p class="t">{title}</p>
  <div class="meta"><span class="badge {kind_class}">{kind}</span><span>{pid}</span><span>{mtime}</span></div>
  <code class="url">{url}</code>
</a>"""

PAGES_CSS = HUB_CSS + """
a.row{display:block;margin:14px 0;padding:18px 20px;border-radius:16px;text-decoration:none;color:inherit;
  background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.09);
  transition:transform .15s ease,border-color .15s ease}
a.row:hover{transform:translateY(-2px);border-color:rgba(255,190,220,.45)}
a.row .t{font-size:18px;font-weight:600;margin:0 0 8px}
a.row .meta{display:flex;gap:12px;align-items:center;font-size:12px;color:#8d819c}
a.row .url{display:block;margin-top:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9d8fae;word-break:break-all}
.badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid transparent}
.badge.live{color:#bfe6c8;border-color:rgba(120,220,150,.35);background:rgba(120,220,150,.10)}
.badge.draft{color:#f3d6a8;border-color:rgba(240,190,120,.35);background:rgba(240,190,120,.10)}
"""


def collect_workspace_pages(ws: str):
    """工作区**根目录**的页面（她的成品都在这儿；`drafts/` 是草稿，不算产出）。

    ⚠️ 不递归：`drafts/`、`.tmp/`、`vendor/` 里的 html 不是"她做出来的页面"。
    """
    out = []
    try:
        entries = sorted(os.listdir(ws))
    except OSError:
        return out
    for name in entries:
        if not name.lower().endswith(".html") or name.startswith("."):
            continue
        full = os.path.join(ws, name)
        if not os.path.isfile(full):
            continue
        out.append(name)
    return out



def main() -> int:
    projects = load_projects()
    os.makedirs(OUT_ROOT, exist_ok=True)
    prefix_dir = os.path.join(OUT_ROOT, PREFIX)
    preview_dir = os.path.join(OUT_ROOT, PREVIEW_PREFIX)

    sites = []
    all_pages = []
    wanted_links = set()
    wanted_previews = set()
    # 站点的对外基址（从任一已登记项目的 publicUrl 推断：`…/p/<id>/` → `…`）
    base_url = ""
    for conf in projects.values():
        if isinstance(conf, dict) and isinstance(conf.get("publicUrl"), str):
            pu = conf["publicUrl"].strip()
            m = re.match(r"^(.*)/%s/[^/]+/?$" % PREFIX, pu)
            if m:
                base_url = m.group(1)
                break

    for pid, conf in projects.items():
        if not isinstance(conf, dict):
            continue
        ws = conf.get("workspace")
        if not isinstance(ws, str) or not ws:
            continue

        # ★ 预览通道：只要工作区在就建（**不看** public/ 有没有东西）——
        #   它就是给"还没发布"的页面用的。
        if os.path.isdir(ws):
            wanted_previews.add(pid)
            os.makedirs(preview_dir, exist_ok=True)
            wlink = os.path.join(preview_dir, pid)
            if not (os.path.islink(wlink) and os.path.realpath(wlink) == os.path.realpath(ws)):
                if os.path.islink(wlink) or os.path.isfile(wlink):
                    os.unlink(wlink)
                elif os.path.isdir(wlink):
                    shutil.rmtree(wlink)
                try:
                    os.symlink(ws, wlink)
                except OSError as exc:
                    print("!! 建预览链接失败 %s: %s" % (wlink, exc), file=sys.stderr)
                    wanted_previews.discard(pid)

        public = os.path.join(ws, "public")
        if not os.path.isdir(public):
            continue

        # 该项目发布过的页面（只取顶层 .html；不递归，避免把别人的产物也列上）
        try:
            entries = sorted(os.listdir(public))
        except OSError:
            continue
        htmls = [
            e for e in entries
            if e.lower().endswith(".html") and not e.startswith(".") and os.path.isfile(os.path.join(public, e))
        ]
        published_names = set(htmls)

        # ★ 全量产物（含未上线）：工作区根目录里她自己做的每一页
        for name in collect_workspace_pages(ws):
            full = os.path.join(ws, name)
            is_pub = name in published_names
            if is_pub:
                href = f"/{PREFIX}/{pid}/" if name == "index.html" else f"/{PREFIX}/{pid}/{name}"
            else:
                href = f"/{PREVIEW_PREFIX}/{pid}/{name}"
            all_pages.append(
                {
                    "pid": pid,
                    "name": name,
                    "title": page_title(full, name),
                    "href": href,
                    "url": base_url + href,
                    "kind": "live" if is_pub else "draft",
                    "mtime": os.path.getmtime(full),
                }
            )

        if not htmls:
            continue  # 还没发布过 ⇒ 基站首页不列它（/pages 里照旧有预览）

        wanted_links.add(pid)
        link = os.path.join(prefix_dir, pid)
        if not (os.path.islink(link) and os.path.realpath(link) == os.path.realpath(public)):
            if os.path.islink(link) or os.path.isfile(link):
                os.unlink(link)
            elif os.path.isdir(link):
                shutil.rmtree(link)
            os.symlink(public, link)

        # index.html 优先，其余按修改时间新→旧
        htmls.sort(key=lambda e: (e != "index.html", -os.path.getmtime(os.path.join(public, e))))
        chips = []
        newest = 0.0
        for name in htmls:
            full = os.path.join(public, name)
            is_index = name == "index.html"
            mt = os.path.getmtime(full)
            newest = max(newest, mt)
            chips.append(
                {
                    "href": f"/{PREFIX}/{pid}/" if is_index else f"/{PREFIX}/{pid}/{name}",
                    "label": "首页" if is_index else page_title(full, name),
                }
            )
        # 站名取站点首页的 <title>（没有就退回项目 id）
        site_title = page_title(os.path.join(public, "index.html"), pid)
        sites.append(
            {
                "pid": pid,
                "title": site_title,
                "href": f"/{PREFIX}/{pid}/",
                "chips": chips,
                "n": len(chips),
                "mtime": newest,
            }
        )

    # 清掉已下线/改名的项目（基站的"自动"必须包括**移除**）
    if os.path.isdir(prefix_dir):
        for name in os.listdir(prefix_dir):
            if name not in wanted_links:
                victim = os.path.join(prefix_dir, name)
                if os.path.islink(victim):
                    os.unlink(victim)
                elif os.path.isdir(victim):
                    shutil.rmtree(victim)
    if os.path.isdir(preview_dir):
        for name in os.listdir(preview_dir):
            if name not in wanted_previews:
                victim = os.path.join(preview_dir, name)
                if os.path.islink(victim):
                    os.unlink(victim)
                elif os.path.isdir(victim):
                    shutil.rmtree(victim)

    sites.sort(key=lambda s: -s["mtime"])

    if sites:
        body = "\n".join(
            SITE_CARD.format(
                href=s["href"],
                title=html.escape(s["title"]),
                pid=html.escape(s["pid"]),
                n=s["n"],
                mtime=html.escape(human_time(s["mtime"])),
                chips="".join(CHIP.format(href=c["href"], label=html.escape(c["label"])) for c in s["chips"]),
            )
            for s in sites
        )
        page_count = sum(s["n"] for s in sites)
    else:
        body = '<div class="empty">还什么都没有。让她做一个吧。</div>'
        page_count = 0

    draft_n = sum(1 for p in all_pages if p["kind"] == "draft")
    allhint = (
        f"她的全部产出（含还没上线的 {draft_n} 个预览）→"
        if draft_n > 0
        else "她的全部产出（含预览）→"
    )
    out = HUB_HTML.format(
        css=HUB_CSS,
        body=body,
        count=page_count,
        site_count=len(sites),
        allhint=allhint,
        now=datetime.now().strftime("%Y-%m-%d %H:%M"),
    )
    write_atomic(os.path.join(OUT_ROOT, "index.html"), out)
    print("hub: %d 站 / %d 页 → %s" % (len(sites), page_count, [s["href"] for s in sites]))

    # ── /pages：全部产物（含未上线）────────────────────────────────
    all_pages.sort(key=lambda p: -p["mtime"])
    all_pages = all_pages[:MAX_PAGES]
    if all_pages:
        rows = "\n".join(
            PAGE_ROW.format(
                href=p["href"],
                title=html.escape(p["title"]),
                kind="已上线" if p["kind"] == "live" else "预览",
                kind_class=p["kind"],
                pid=html.escape(p["pid"]),
                mtime=html.escape(human_time(p["mtime"])),
                url=html.escape(p["url"] or p["href"]),
            )
            for p in all_pages
        )
    else:
        rows = '<div class="empty">还什么都没有。让她做一个吧。</div>'
    live_n = sum(1 for p in all_pages if p["kind"] == "live")
    out2 = PAGES_HTML.format(
        css=PAGES_CSS,
        body=rows,
        count=len(all_pages),
        published_n=live_n,
        draft_n=len(all_pages) - live_n,
        now=datetime.now().strftime("%Y-%m-%d %H:%M"),
    )
    write_atomic(os.path.join(OUT_ROOT, "pages.html"), out2)

    # ★ 2026-10-19（change: `let-her-query-what-she-made`）：
    #   机器可读的同一份清单 —— 她在**聊天里**要回答"那页在哪/给我链接"时用，
    #   而不是为了问一个网址去**新建一个任务**（真机证据：她建过一个"核实地址"的任务）。
    #   ⚠️ 容器读不到宿主目录 ⇒ 由宿主 runner 每轮把这份 json 传给服务端（见 `/api/host/pages`）。
    index = [
        {
            "projectId": p["pid"],
            "file": p["name"],
            "title": p["title"],
            "url": p["url"] or p["href"],
            "published": p["kind"] == "live",
            "updatedAt": datetime.fromtimestamp(p["mtime"]).strftime("%Y-%m-%dT%H:%M:%S"),
        }
        for p in all_pages
    ]
    write_atomic(
        os.path.join(OUT_ROOT, "pages.json"),
        json.dumps({"generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), "pages": index},
                   ensure_ascii=False, indent=2) + "\n",
    )
    print("pages: %d 个（已上线 %d / 预览 %d）· json 已写" % (len(all_pages), live_n, len(all_pages) - live_n))
    return 0


def write_atomic(path: str, content: str) -> None:
    """先写 `.tmp` 再 `os.replace`：timer 每 10s 跑一次，读者可能正在打开（契约 35）。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


if __name__ == "__main__":
    raise SystemExit(main())
