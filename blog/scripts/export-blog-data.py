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


def main() -> int:
    out = {"diaries": [], "mood": {}}
    try:
        conn = connect_ro()
    except Exception as e:  # noqa: BLE001
        print(f"export-blog-data: db open failed: {e}", file=sys.stderr)
        json.dump(out, sys.stdout, ensure_ascii=False)
        return 0

    try:
        out["diaries"] = read_diaries(conn)
        out["mood"] = read_mood(conn)
    finally:
        conn.close()

    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
