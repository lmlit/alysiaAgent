"""从素材库给 5 篇随笔各配一张**不同**的封面（★ 2026-10-21）。

选择依据（来自 blog/assets-source/manifest.json 的自动标签 + 人工挑）：
  16 在永无止境的轮回的尽头  黄昏草地，暖金，人像居中
  18 成为昨日的明天          粉紫天空，飞起，明亮
  17 黄金史诗·风堇            暖橙，侧脸
  12 昔涟·星穹铁道            粉紫冷调，站姿
  07 昔涟前瞻壁纸            冷调宽幅

排除：01/02（bilibili 水印）、09/10/11/15（群像/界面）、03/04/22（图标/签名）、
      05/13/14/19/20（竖版 UI 卡）、06（竖版日记）

每张按 16:9 裁切（xAnchor/yAnchor 控制取景中心），再做一次统一的轻微调色，
保证并排看是同一套视觉，但每张主角和构图都不同。
"""
import json
import os
from PIL import Image, ImageEnhance

LIB = "blog/assets-source"
RAW = f"{LIB}/raw"
OUT = "blog/src/content/posts"
W, H = 1200, 630

# slug -> (素材 id, x 取景 0-1, y 取景 0-1, 亮度, 饱和, 叠色, 叠加强度)
#
# ⚠️ 2026-10-21 修订：横图里**只有 07、12 是纯单角色**，其余是群像/界面/带 B 站水印
#    （17 带字幕、11 带央视水印、01/02/10/15 是群像或海报）。
#    所以补 3 张竖版人像（05、13、19）裁上部 —— 单角色比群像更适合当随笔封面。
PLAN = {
    "morning": ("05", 0.50, 0.05, 1.06, 1.02, (255, 252, 253), 0.06),
    "green":   ("07", 0.50, 0.30, 1.02, 1.04, (240, 250, 244), 0.07),
    "mimi":    ("19", 0.50, 0.08, 1.02, 1.02, (255, 244, 228), 0.08),
    "lamp":    ("12", 0.55, 0.35, 1.00, 1.03, (255, 236, 214), 0.10),
    "close":   ("21", 0.46, 0.34, 0.90, 0.94, (222, 220, 244), 0.16),
}


def crop_to(im, x_anchor, y_anchor):
    w, h = im.size
    target = W / H
    if w / h > target:
        nw = int(h * target)
        x0 = int((w - nw) * x_anchor)
        im = im.crop((x0, 0, x0 + nw, h))
    else:
        nh = int(w / target)
        y0 = int((h - nh) * y_anchor)
        im = im.crop((0, y0, w, y0 + nh))
    return im.resize((W, H), Image.LANCZOS)


manifest = json.load(open(f"{LIB}/manifest.json", encoding="utf-8"))
by_id = {i["id"]: i for i in manifest["items"]}

used = set()
for slug, (art_id, xa, ya, bright, sat, color, strength) in PLAN.items():
    if art_id not in by_id:
        print("缺素材", art_id)
        continue
    if art_id in used:
        raise SystemExit(f"素材重复使用：{art_id}")
    used.add(art_id)

    src = f"{RAW}/{by_id[art_id]['file']}"
    im = Image.open(src).convert("RGB")
    im = crop_to(im, xa, ya)
    im = ImageEnhance.Brightness(im).enhance(bright)
    im = ImageEnhance.Color(im).enhance(sat)
    overlay = Image.new("RGB", im.size, color)
    im = Image.blend(im, overlay, strength)

    p = f"{OUT}/{slug}.webp"
    im.save(p, "WEBP", quality=88, method=6)
    print(f"✓ {slug:<8} <- 素材 {art_id}《{by_id[art_id]['title']}》  {os.path.getsize(p)//1024}KB")
