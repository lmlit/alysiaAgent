"""用 alysia 官方头像（cyrene-avatar.png）替换博客头像与 favicon。

- 头像：转 webp（原图 1.9MB → 目标 <300KB），保留 1200 方图
- favicon：**从脸部裁切**（原图是半身，直接中心裁会切到胸口），再圆形遮罩
"""
import os
from PIL import Image, ImageDraw

SRC = "cyrene-assets/avatars/cyrene-avatar.png"
IMG_DIR = "blog/src/assets/images"
FAV_DIR = "blog/public/favicon"

os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(FAV_DIR, exist_ok=True)

src = Image.open(SRC).convert("RGB")
print("原图:", src.size)

# ── 头像：直接转 webp ─────────────────────────────────────────
avatar = src.resize((1200, 1200), Image.LANCZOS)
out_avatar = f"{IMG_DIR}/cyrene.webp"
avatar.save(out_avatar, "WEBP", quality=88, method=6)
print(f"头像: {out_avatar}  {os.path.getsize(out_avatar)//1024}KB")

# ── favicon：脸部区域裁切（原图 1200 方图，脸约在左中偏上）──────
box = (200, 150, 760, 710)   # 560x560，以脸为中心
face = src.crop(box).resize((512, 512), Image.LANCZOS)

mask = Image.new("L", (512 * 4, 512 * 4), 0)
d = ImageDraw.Draw(mask)
d.ellipse((0, 0, 512 * 4 - 1, 512 * 4 - 1), fill=255)
mask = mask.resize((512, 512), Image.LANCZOS)

for size in (32, 128, 180, 192):
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tmp = face.convert("RGBA")
    tmp.putalpha(mask)
    tmp = tmp.resize((size, size), Image.LANCZOS)
    out.paste(tmp, (0, 0), tmp)
    for theme in ("light", "dark"):
        p = f"{FAV_DIR}/favicon-{theme}-{size}.png"
        out.save(p, "PNG")
print("favicon: 8 张已生成（脸部裁切 + 圆形）")
