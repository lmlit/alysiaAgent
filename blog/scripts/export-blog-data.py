#!/usr/bin/env python3
"""导出博客需要的服务端数据（★ 2026-10-21，change: `sync-mood-to-blog`）。

一次 ssh 拿全：`{"diaries": [...], "mood": {...}}`。

为什么合并成一个脚本：deploy.ps1 每次都要 ssh，一次连上拿全比开两次便宜，
而且**同一时刻**读出来的心情与日记不会互相矛盾。

只读，不改任何数据；任何失败都输出可用的空结构 + 退出码 0
（博客构建不该因为服务端没数据而失败）。
"""
import json
import sqlite3
import sys

DB = "/root/alysia/data/alysia.db"
DIARY_LIMIT = 90


def connect_ro():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def read_diaries(conn):
    try:
        rows = conn.execute(
            "SELECT date, content, mood, mood_value FROM ai_life_diaries "
            "ORDER BY date DESC LIMIT ?",
            (DIARY_LIMIT,),
        ).fetchall()
        return [
            {
                "date": r[0],
                "content": r[1],
                "mood": r[2] or "",
                "moodValue": r[3] if r[3] is not None else 0,
            }
            for r in rows
        ]
    except sqlite3.OperationalError as e:
        print(f"export-blog-data: diaries unavailable: {e}", file=sys.stderr)
        return []


def read_mood(conn):
    """心情：mood 词 + 数值 + 氛围描述。

    ⚠️ `mood_note` 是她自己写的一句话（如"刚把今天的字写完"），
       会显示在博客侧栏 —— 这也是**公开**内容，与日记同理。
    """
    try:
        row = conn.execute(
            "SELECT mood, mood_value, mood_note, current_activity, updated_at "
            "FROM ai_life_state WHERE id = 1"
        ).fetchone()
    except sqlite3.OperationalError as e:
        print(f"export-blog-data: state unavailable: {e}", file=sys.stderr)
        return {}

    if not row:
        return {}
    return {
        "mood": row[0] or "",
        "moodValue": row[1] if row[1] is not None else 0,
        "note": row[2] or "",
        "activity": row[3] or "",
        "updatedAt": row[4] or "",
    }


def read_letters(conn):
    """信：不按日，想写才写（可能很久没有一封）"""
    try:
        rows = conn.execute(
            "SELECT date, content, mood FROM ai_life_letters ORDER BY date DESC LIMIT 60"
        ).fetchall()
        return [{"date": r[0], "content": r[1], "mood": r[2] or ""} for r in rows]
    except sqlite3.OperationalError as e:
        print(f"export-blog-data: letters unavailable: {e}", file=sys.stderr)
        return []


# ── ★ 2026-10-21（change: `add-works-gallery`）：她生成的页面 ──────────────
#   数据源不是 DB，而是 runner 工作区：/srv/alysia-runner/<项目>/public/
#   基站已经把 public/ 挂到 /p/<projectId>/ 对外可访问，所以这里只需要目录清单。
RUNNER_ROOT = "/srv/alysia-runner"

import os
import re


def _read_title_desc(path):
    """从 html 里取 <title> 与 meta description（取不到就给空，不猜）"""
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            html = f.read(20000)
    except OSError:
        return "", ""
    t = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    d = re.search(r'<meta\s+name=["\']description["\']\s+content=["\'](.*?)["\']', html, re.S | re.I)
    clean = lambda s: re.sub(r"\s+", " ", s).strip() if s else ""
    return clean(t.group(1) if t else ""), clean(d.group(1) if d else "")


def read_works():
    """列出她的作品：每个项目的 public/ 下的 html 页面。

    ⚠️ 排除 `alysia-blog` —— 那是博客自己，写在"作品"里会自我指涉。
    """
    works = []
    try:
        projects = sorted(os.listdir(RUNNER_ROOT))
    except OSError as e:
        print(f"export-blog-data: runner root unavailable: {e}", file=sys.stderr)
        return works

    for pid_dir in projects:
        base = os.path.join(RUNNER_ROOT, pid_dir)
        pub = os.path.join(base, "public")
        if not os.path.isdir(pub):
            continue

        project_id = pid_dir
        meta_path = os.path.join(base, ".alysia-project.json")
        if os.path.isfile(meta_path):
            try:
                with open(meta_path, encoding="utf-8") as f:
                    project_id = json.load(f).get("projectId") or pid_dir
            except (OSError, ValueError):
                pass

        if project_id == "alysia-blog":
            continue

        pages = []
        for name in sorted(os.listdir(pub)):
            if not name.endswith(".html"):
                continue
            path = os.path.join(pub, name)
            title, desc = _read_title_desc(path)
            try:
                mtime = int(os.path.getmtime(path))
            except OSError:
                mtime = 0
            pages.append(
                {
                    "file": name,
                    "title": title or name.replace(".html", ""),
                    "description": desc,
                    "updatedAt": mtime,
                }
            )

        if pages:
            works.append({"projectId": project_id, "pages": pages})

    return works


def main() -> int:
    out = {"diaries": [], "letters": [], "mood": {}, "works": []}
    try:
        conn = connect_ro()
    except Exception as e:  # noqa: BLE001
        print(f"export-blog-data: db open failed: {e}", file=sys.stderr)
        # 库打不开也要把作品带出去（它不依赖 DB）
        out["works"] = read_works()
        json.dump(out, sys.stdout, ensure_ascii=False)
        return 0

    try:
        out["diaries"] = read_diaries(conn)
        out["letters"] = read_letters(conn)
        out["mood"] = read_mood(conn)
    finally:
        conn.close()

    out["works"] = read_works()
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
