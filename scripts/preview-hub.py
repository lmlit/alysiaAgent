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
from datetime import datetime

CONFIG = "/root/alysia/config.yml"
OUT_ROOT = "/srv/alysia-preview"
PREFIX = "p"  # 页面 URL 前缀：/p/<id>/

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
  <p>她做的东西都放在这里，每一个都点得开。</p>
</header>
{body}
<footer>共 {count} 个页面 · 自动生成于 {now} · 她只负责内容，这里不收集任何信息</footer>
</div></body></html>
"""

CARD = """<a class="card" href="{href}">
  <p class="t">{title}</p>
  <div class="id">{pid}{suffix}</div>
  <div class="meta"><span>更新于 {mtime}</span><span>打开 →</span></div>
</a>"""


def main() -> int:
    projects = load_projects()
    os.makedirs(OUT_ROOT, exist_ok=True)
    prefix_dir = os.path.join(OUT_ROOT, PREFIX)

    pages = []
    wanted_links = set()

    for pid, conf in projects.items():
        if not isinstance(conf, dict):
            continue
        ws = conf.get("workspace")
        if not isinstance(ws, str) or not ws:
            continue
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
        if not htmls:
            continue  # 还没发布过

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
        for name in htmls:
            full = os.path.join(public, name)
            is_index = name == "index.html"
            pages.append(
                {
                    "id": pid,
                    "title": page_title(full, name if not is_index else pid),
                    "href": f"/{PREFIX}/{pid}/" if is_index else f"/{PREFIX}/{pid}/{name}",
                    "suffix": "" if is_index else f"/{name}",
                    "mtime": os.path.getmtime(full),
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

    pages.sort(key=lambda p: -p["mtime"])
    pages = pages[:MAX_PAGES]

    if pages:
        body = '<div class="grid">\n' + "\n".join(
            CARD.format(
                href=p["href"],
                title=html.escape(p["title"]),
                pid=html.escape(p["id"]),
                suffix=html.escape(p["suffix"]),
                mtime=html.escape(human_time(p["mtime"])),
            )
            for p in pages
        ) + "\n</div>"
    else:
        body = '<div class="empty">还什么都没有。让她做一个吧。</div>'

    out = HUB_HTML.format(
        css=HUB_CSS,
        body=body,
        count=len(pages),
        now=datetime.now().strftime("%Y-%m-%d %H:%M"),
    )
    tmp = os.path.join(OUT_ROOT, ".index.html.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(out)
    os.replace(tmp, os.path.join(OUT_ROOT, "index.html"))  # 原子替换，避免读到半个页面
    print("hub: %d page(s) → %s" % (len(pages), [p["href"] for p in pages]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
