import math
import os

# 爱心参数方程: x = 16 sin³(t), y = 13 cos(t) - 5 cos(2t) - 2 cos(3t) - cos(4t)
# 在终端用字符画出来

def draw_heart(scale=1.0, fill_char="♥"):
    width = 60
    height = 30
    
    # 创建画布
    canvas = [[" "] * width for _ in range(height)]
    
    # 爱心参数方程
    points = []
    for t in [i * 0.01 for i in range(0, 628)]:  # 0 到 2π
        x = 16 * (math.sin(t) ** 3)
        y = 13 * math.cos(t) - 5 * math.cos(2*t) - 2 * math.cos(3*t) - math.cos(4*t)
        points.append((x, y))
    
    # 缩放到画布
    for x, y in points:
        sx = int((x * scale + 18) / 36 * (width - 1))
        sy = int((12 - y * scale) / 24 * (height - 1))
        if 0 <= sx < width and 0 <= sy < height:
            canvas[sy][sx] = fill_char
    
    return "\n".join("".join(row) for row in canvas)

# 小爱心
print("小小的爱心:")
print(draw_heart(0.6, "♥"))
print()

# 大一点的爱心
print("大大的爱心:")
print(draw_heart(0.9, "♥"))
print()

# 用文字拼的简版爱心
print("文字爱心:")
lines = [
    "   ♥♥♥♥     ♥♥♥♥",
    " ♥♥♥♥♥♥♥ ♥♥♥♥♥♥♥",
    "♥♥♥♥♥♥♥♥♥♥♥♥♥♥♥♥",
    " ♥♥♥♥♥♥♥♥♥♥♥♥♥♥",
    "  ♥♥♥♥♥♥♥♥♥♥♥♥",
    "   ♥♥♥♥♥♥♥♥♥♥",
    "    ♥♥♥♥♥♥♥♥",
    "     ♥♥♥♥♥♥",
    "      ♥♥♥♥",
    "       ♥♥",
    "        ♥"
]
for line in lines:
    print(line)
