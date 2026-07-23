import turtle
import math

# 设置画布
t = turtle.Turtle()
t.speed(0)
t.pensize(2)
screen = turtle.Screen()
screen.bgcolor("black")
screen.title("❤️ 送给你一个爱心 ❤️")

# 颜色列表，从深红到亮红渐变
colors = ["#ff0040", "#ff1a4a", "#ff3366", "#ff4d80", "#ff6699", "#ff80b3"]

# 心形参数方程
def heart_x(t_val):
    return 16 * math.sin(t_val) ** 3

def heart_y(t_val):
    return 13 * math.cos(t_val) - 5 * math.cos(2 * t_val) - 2 * math.cos(3 * t_val) - math.cos(4 * t_val)

# 绘制填充爱心
t.penup()
t.goto(0, -100)
t.pendown()
t.color("#ff1a4a")
t.begin_fill()

t.penup()
# 先移动到起点
t_val = 0
t.goto(heart_x(t_val) * 12, heart_y(t_val) * 12)
t.pendown()

for t_val in range(0, 360):
    rad = math.radians(t_val)
    x = heart_x(rad) * 12
    y = heart_y(rad) * 12
    t.goto(x, y)

t.end_fill()

# 绘制外发光线条
for i in range(6):
    t.penup()
    t_val = 0
    t.goto(heart_x(t_val) * (12 + i * 1.5), heart_y(t_val) * (12 + i * 1.5))
    t.pendown()
    t.pencolor(colors[i % len(colors)])
    t.pensize(3 - i * 0.3)
    for t_val in range(0, 360):
        rad = math.radians(t_val)
        x = heart_x(rad) * (12 + i * 1.5)
        y = heart_y(rad) * (12 + i * 1.5)
        t.goto(x, y)

# 写文字
t.penup()
t.goto(0, -180)
t.pendown()
t.color("white")
t.write("❤️", align="center", font=("Arial", 36, "normal"))

t.penup()
t.goto(0, -220)
t.pendown()
t.color("#ff6699")
t.write("送给你呀 ♪", align="center", font=("Arial", 18, "normal"))

# 隐藏海龟
t.hideturtle()

# 点击关闭
screen.exitonclick()
