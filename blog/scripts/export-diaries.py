#!/usr/bin/env python3
"""导出她的日记为 JSON（★ 2026-10-21，change: add-daily-diary）。

由 `blog/deploy.ps1` 在构建前通过 ssh 调用：读服务端 SQLite → stdout 输出 JSON，
本地再喂给 `sync-diaries.mjs` 生成 markdown。

为什么在服务端读而不是本地连库：库在服务器上，本地没有副本；
而"把整个库拉回本地"既慢又危险（里面还有别的东西）。

只读，不改任何数据。
"""
import json
import sqlite3
import sys

# 与 compose 挂载一致（见 docs/SERVER-ACCESS-SOP.md §0）
DB = "/root/alysia/data/alysia.db"
LIMIT = 90  # 最近 90 篇；再老的先在库里躺着


def main() -> int:
    try:
        conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    except Exception as e:  # noqa: BLE001
        # ⚠️ 读不到就输出 [] 而不是报错退出：博客构建不该因为"今天没日记"而失败
        print("[]")
        print(f"export-diaries: db open failed: {e}", file=sys.stderr)
        return 0

    try:
        rows = conn.execute(
            "SELECT date, content, mood, mood_value FROM ai_life_diaries "
            "ORDER BY date DESC LIMIT ?",
            (LIMIT,),
        ).fetchall()
    except sqlite3.OperationalError as e:
        # 表还没建（旧库）也不能让构建挂掉
        print("[]")
        print(f"export-diaries: query failed: {e}", file=sys.stderr)
        return 0
    finally:
        conn.close()

    out = [
        {
            "date": r[0],
            "content": r[1],
            "mood": r[2] or "",
            "moodValue": r[3] if r[3] is not None else 0,
        }
        for r in rows
    ]
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
