"""把头像裁成 favicon 各尺寸（覆盖 Fuwari 默认的 8 张）。

为什么裁成圆形：favicon 在标签页里是方的，但这张图是二次元头像，
方形缩到 32px 会显得糊；圆形裁切更像"头像"。
"""
import os
from PIL import Image, ImageDraw

SRC = "blog/src/assets/images/avatar.webp"
OUT = "blog/public/favicon"
SIZES = [32, 128, 180, 192]

os.makedirs(OUT, exist_ok=True)
img = Image.open(SRC).convert("RGBA")

# 居中正方形裁切
w, h = img.size
side = min(w, h)
img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))

# 圆角遮罩（留一点边，避免贴边被切）
mask = Image.new("L", (side * 4, side * 4), 0)
d = ImageDraw.Draw(mask)
d.ellipse((0, 0, side * 4 - 1, side * 4 - 1), fill=255)
mask = mask.resize((side, side), Image.LANCZOS)

for size in SIZES:
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tmp = img.copy()
    tmp.putalpha(mask)
    tmp = tmp.resize((size, size), Image.LANCZOS)
    out.paste(tmp, (0, 0), tmp)
    for theme in ("light", "dark"):
        path = f"{OUT}/favicon-{theme}-{size}.png"
        out.save(path, "PNG")
        print(f"✓ {path}")
