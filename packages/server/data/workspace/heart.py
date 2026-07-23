"""
用 matplotlib 画一颗爱心 ❤️
运行: python heart.py
"""

import numpy as np
import matplotlib.pyplot as plt

# 心形参数方程
t = np.linspace(0, 2 * np.pi, 1000)

x = 16 * np.sin(t) ** 3
y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)

plt.figure(figsize=(8, 6), facecolor='white')
plt.plot(x, y, color='hotpink', linewidth=3, label='心❤️')

# 填充红色
plt.fill(x, y, color='hotpink', alpha=0.6)

# 美化
plt.axis('equal')
plt.axis('off')
plt.title('送给你的❤️', fontsize=18, color='crimson', fontfamily='sans-serif')

plt.tight_layout()
plt.savefig('heart.png', dpi=200, bbox_inches='tight')
print("✅ 已生成 heart.png，快去看看吧♪")

plt.show()
