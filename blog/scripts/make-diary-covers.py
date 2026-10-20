"""给日记生成封面：按 mood 从素材库挑图（★ 2026-10-21，change: add-daily-diary）。

为什么按心情选图：日记每天一篇，用同一张封面会显得敷衍；但每篇手挑也不现实。
心情是日记自带的元数据（`ai_life_diaries.mood`），用它做映射最省且一致。

映射与 `blog/scripts/sync-diaries.mjs` 里的 MOOD_COVER **必须一致** ——
那边只负责把图片文件名写进 frontmatter，这边决定图片本身。
"""
import json
import os
from PIL import Image, ImageEnhance

LIB = "blog/assets-source"
RAW = f"{LIB}/raw"
POSTS = "blog/src/content/posts"
W, H = 1200, 630

# mood -> (素材 id, 亮度, 饱和, 叠色, 强度)
MOOD_STYLE = {
    "happy":   ("18", 1.05, 1.06, (255, 250, 252), 0.06),
    "excited": ("07", 1.06, 1.08, (255, 252, 250), 0.05),
    "calm":    ("05", 1.02, 1.02, (250, 250, 255), 0.06),
    "lonely":  ("19", 0.98, 0.98, (238, 232, 248), 0.10),
    "tired":   ("12", 0.94, 0.96, (240, 232, 226), 0.12),
    "sleepy":  ("13", 0.88, 0.90, (224, 222, 244), 0.16),
    "sad":     ("21", 0.86, 0.88, (220, 218, 242), 0.18),
}
DEFAULT = MOOD_STYLE["calm"]


def crop_cover(im, y_anchor=0.25):
    w, h = im.size
    target = W / H
    if w / h > target:
        nw = int(h * target)
        x0 = (w - nw) // 2
        im = im.crop((x0, 0, x0 + nw, h))
    else:
        nh = int(w / target)
        y0 = int((h - nh) * y_anchor)
        im = im.crop((0, y0, w, y0 + nh))
    return im.resize((W, H), Image.LANCZOS)


manifest = json.load(open(f"{LIB}/manifest.json", encoding="utf-8"))
by_id = {i["id"]: i for i in manifest["items"]}

# 扫现有日记 md，从 tags 里取 mood（sync-diaries 把 mood 写进 tags[0]）
import re

count = 0
for f in sorted(os.listdir(POSTS)):
    if not (f.startswith("diary-") and f.endswith(".md")):
        continue
    date = f[len("diary-"):-3]
    text = open(f"{POSTS}/{f}", encoding="utf-8").read()
    m = re.search(r"^tags:\s*\[(.*?)\]", text, re.M)
    mood = (m.group(1).strip().strip('"') if m else "") or "calm"
    art_id, bright, sat, color, strength = MOOD_STYLE.get(mood, DEFAULT)
    if art_id not in by_id:
        print("缺素材", art_id)
        continue

    im = Image.open(f"{RAW}/{by_id[art_id]['file']}").convert("RGB")
    im = crop_cover(im)
    im = ImageEnhance.Brightness(im).enhance(bright)
    im = ImageEnhance.Color(im).enhance(sat)
    im = Image.blend(im, Image.new("RGB", im.size, color), strength)

    out = f"{POSTS}/diary-{date}.webp"
    im.save(out, "WEBP", quality=86, method=6)
    count += 1
    print(f"✓ diary-{date}.webp  mood={mood}  <- {art_id}")

print(f"共 {count} 张")
