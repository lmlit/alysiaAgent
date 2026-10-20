"""用可用的两张官方插画，按时段调色，生成 5 张随笔封面。

为什么不是 5 张不同图：下载到的 6 张里只有 a（黄昏草地）和 b（粉紫天空）适合做封面
（其余是群像/战斗/带字幕截图）。与其凑 5 张风格不一的图，不如 2 张底图 + 时段调色 ——
这样 5 张卡片并排时是**同一个世界**的不同时间。
"""
import os
from PIL import Image, ImageEnhance

SRC = ".tmp/cyrene-art"
OUT = "blog/src/content/posts"
W, H = 1200, 630

# (随笔, 底图, 纵向裁切锚点 0=上 1=下, 色温偏移(+暖/-冷), 亮度, 饱和, 叠加色, 叠加强度)
PLANS = {
    "morning": ("b.img", 0.15, +6,   1.06, 1.04, (255, 252, 250), 0.10),
    "green":   ("b.img", 0.45, -4,   1.00, 1.02, (240, 250, 240), 0.10),
    "mimi":    ("a.img", 0.35, +12,  1.04, 1.02, (255, 240, 224), 0.12),
    "lamp":    ("a.img", 0.55, -6,   0.98, 0.98, (238, 226, 248), 0.14),
    "close":   ("a.img", 0.70, -18,  0.82, 0.88, (36, 30, 52),    0.30),
}


def crop_cover(im, anchor):
    w, h = im.size
    target_ratio = W / H
    if w / h > target_ratio:          # 太宽 → 裁左右
        nw = int(h * target_ratio)
        x0 = (w - nw) // 2
        im = im.crop((x0, 0, x0 + nw, h))
    else:                              # 太高 → 裁上下，anchor 控制取哪一段
        nh = int(w / target_ratio)
        y0 = int((h - nh) * anchor)
        im = im.crop((0, y0, w, y0 + nh))
    return im.resize((W, H), Image.LANCZOS)


def tint(im, color, strength):
    overlay = Image.new("RGB", im.size, color)
    return Image.blend(im, overlay, strength)


def warm_shift(im, amount):
    """amount>0 偏暖，<0 偏冷（只动红/蓝通道，温和）"""
    r, g, b = im.split()
    r = r.point(lambda v: min(255, int(v + amount)))
    b = b.point(lambda v: min(255, int(v - amount)))
    return Image.merge("RGB", (r, g, b))


for name, (src, anchor, warm, bright, sat, color, strength) in PLANS.items():
    im = Image.open(os.path.join(SRC, src)).convert("RGB")
    im = crop_cover(im, anchor)
    im = warm_shift(im, warm)
    im = ImageEnhance.Brightness(im).enhance(bright)
    im = ImageEnhance.Color(im).enhance(sat)
    im = tint(im, color, strength)
    p = f"{OUT}/{name}.webp"
    im.save(p, "WEBP", quality=88, method=6)
    print(f"✓ {p}  {os.path.getsize(p)//1024}KB  (底图 {src})")
