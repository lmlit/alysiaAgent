# 博客资产 SOP（头像 / favicon / 心情）

> status: current · updated: 2026-10-21 · audience: human（内部文档）
> 仓库：`blog/`（Fuwari 主题）· 线上：基站 `/p/alysia-blog/`

---

## 1. 头像：**必须用 alysia 官方图，不要用下载的插画**

| 项 | 值 |
|---|---|
| **源** | `cyrene-assets/avatars/cyrene-avatar.png`（1200×1200 PNG，1.9MB） |
| **产物** | `blog/src/assets/images/cyrene.webp`（1200×1200，约 200KB） |
| **引用** | `blog/src/config.ts` → `profileConfig.avatar` |
| **转换** | `PIL` 缩放 + `WEBP quality=88, method=6` |

```bash
# 重新生成头像（源图换了才需要）
python .tmp/cyrene-avatar.py     # 见仓库内该脚本，或按上表手工转
```

⚠️ **不要**：
- 用 `demo-avatar.png` / `demo-banner.png`（Fuwari 自带 Demo，已从 `src/assets/images` 删除）
- 用网上下的插画当头像 —— 她的形象只有 `cyrene-assets/` 这一份，换图必须换源
- 把 `site:` 写成真实服务器地址（公开仓，IP 在 `.git/alysia-secret-patterns` 里，pre-commit 会拦）

---

## 2. favicon：从**脸部**裁切，不是整图缩放

整图缩放会把半身像压成"看不清是什么"。正确做法是裁脸部再圆形：

| 项 | 值 |
|---|---|
| 裁切框 | `(200, 150, 760, 710)`（560×560，以脸为中心） |
| 遮罩 | 椭圆圆形，抗锯齿缩放到 512 再降到目标尺寸 |
| 尺寸 | 32 / 128 / 180 / 192（light + dark 各一套，共 8 张） |
| 位置 | `blog/public/favicon/favicon-{light,dark}-{size}.png` |

⚠️ favicon 缓存极顽固：改完要**关掉标签页重开**，`Ctrl+Shift+R` 不一定够。

---

## 3. 心情：这是**她更新心情的前端出口**

### 机制

```
blog/src/data/mood.json          ← 她（或人）更新这里
        ↓ 构建时读取（不是运行时请求 API）
blog/src/utils/mood.ts           ← 心情 → 文案 / 颜色 / CSS filter
        ↓
Profile.astro                    ← 头像套 filter + 显示「此刻：xx」
```

### mood.json 格式

```json
{
  "mood": "calm",
  "updatedAt": "2026-10-21T00:40:00+08:00",
  "note": "刚把今天的字写完"
}
```

`mood` 取值（见 `utils/mood.ts` 的 `MOODS`）：
`happy` 开心 / `calm` 平静 / `tired` 有点累 / `sad` 低落 / `excited` 兴奋 / `lonely` 想你 / `sleepy` 困了

未知值回退 `calm`（不报错 —— 她写错一个词不该让整站构建失败）。

### 为什么用 CSS 滤镜而不是一堆表情图

一张官方头像 + 按心情调色，比维护 8 张表情图省得多，也不会出现"某张图和她现在的人设不符"。
代价是表情不变、只有色调明度在动 —— 但"她今天的颜色"本来就是最容易被感到的那一层。

### 生效条件

**静态站：改完 mood.json 必须重新构建 + 部署。**

```powershell
# 仓库根目录
$env:ALYSIA_DEPLOY_HOST = "root@<host>"   # 见 docs/SERVER-ACCESS-SOP.md
powershell -File blog/deploy.ps1
```

### 写入端（**待接**）

现在 `mood.json` 是**手动**更新的。她自己的心情在服务端 `ai_life_state.mood`（`mood_value`，8h 回归）。
自动同步的合理做法是：`deploy.ps1` 构建前用 ssh 读一次服务端 mood → 写 `mood.json`，
这样"部署"就等于"把她此刻的心情带上站"。**目前没做**，别以为它已经在同步。

---

## 4. 发布流程（2026-10-21 定稿）

**只有一条路，别再手工 cp 文件。**

```
blog/deploy.ps1                      ← 在仓库根目录跑
  1. npm run build（dist/）           ⚠️ 构建前设 BLOG_SITE，见下
  2. tar 打包 → scp 到服务器 /tmp
  3. 服务器：旧 public/ → backups/public-<时间戳>，新产物解包到 public/
  4. 远端 publish.sh --check         结构 / base 前缀 / 非模板原样 / 正文长度
```

```powershell
# 仓库根目录（PowerShell，注意 PS5.1 的坑见 §5）
$env:ALYSIA_DEPLOY_HOST = "root@<host>"                       # 见 docs/SERVER-ACCESS-SOP.md
$env:BLOG_SITE          = "http://<host>:3389/p/alysia-blog/" # 否则 sitemap/canonical 指向 localhost
powershell -File blog/deploy.ps1

# 只推已有产物（不重新构建）
powershell -File blog/deploy.ps1 -SkipBuild
```

**发布成功的判据**（`publish.sh` 会逐条打勾，任一不过即非零退出）：
1. `index.html` 存在、`_astro/` 有 css、`posts/` 下有文章
2. 所有资源路径带 `/p/alysia-blog` 前缀（不带就整站裸奔）
3. 不是模板原样（无 `Lorem Ipsum`、无 `demo-avatar`、首页有「昔涟」）
4. 每篇文章页 ≥ 8KB

⚠️ **不要把"我构建成功了"当发布成功**。博客挂在基站子路径下，
`base` 一旦漏配，本地 `dist/` 完全正常、线上全 404。

### 回滚

```bash
# 服务器上
ls /srv/alysia-runner/blog/backups/          # public-<时间戳> 每部署一次一份
rm -rf /srv/alysia-runner/blog/public
mv /srv/alysia-runner/blog/backups/public-<时间戳> /srv/alysia-runner/blog/public
```

### 截图验收

服务器上有现成相机：`/srv/alysia-runner/blog/shot.sh`。

```bash
ssh <host> "cd /srv/alysia-runner/blog && ./shot.sh http://127.0.0.1:3389/p/alysia-blog/ --name check --size 1280,1400 --light"
# 产物 shots/check.png，scp 回来自己看
```

⚠️ 它**默认按深色拍**（headless 的 color-scheme 与真实浏览器相反），要看浅色必须加 `--light`。

---

## 5. 视觉改哪里（cyrene.css）

主题视觉集中在 **`blog/src/styles/cyrene.css`**（由 `Layout.astro` 引入），不要散在组件里改。

| 想改什么 | 改哪里 |
|---|---|
| 底色 | `--paper-light` / `--paper-dark` |
| 她的颜色（粉） | `--rose-*` 系列 |
| 拱窗位置/大小 | `.cyrene-window` 的 `right` / `bottom` / `width` |
| 毛玻璃强度 | `.card-base` 的 `background` 透明度 + `backdrop-filter` 的 `blur()` |
| 光波速度 | `@keyframes cyrene-drift`（42s）与 `cyrene-drift-rev`（58s） |

⚠️ **层级陷阱**（踩过一次）：装饰层（拱窗、光波）用 `z-index -1` 会被 body 的不透明背景**整个盖住**，等于没画。
Fuwari 内容层是 `z-30`，装饰要放在 **0 / 1 / 10** 这一档，才是"背景之上、内容之下"。

⚠️ 尊重 `prefers-reduced-motion`：所有动画都在该媒体查询下关闭，别删这段。

---

## 6. 踩过的坑

| 坑 | 表现 | 正解 |
|---|---|---|
| 漏了 `base: "/p/alysia-blog"` | 页面全裸，资源 404 | 必须设 base（挂在基站子路径） |
| 删了 `site` | 构建报 `Invalid URL` | 保留 `site`，值从 `BLOG_SITE` 环境变量注入 |
| 用 npm 装 Fuwari 依赖 | `only-allow pnpm` 失败 | 用 pnpm；且 `blog/pnpm-workspace.yaml` 要独立声明 `packages: ['.']`，否则装到仓库根 |
| PS5.1 写脚本 | 中文被按 GBK 解析、BOM 破坏 bash 首行 | `.ps1` 存 UTF-8 **with BOM**；远端脚本用 base64 传 |
| 把 IP 写进代码 | pre-commit 拦截 | 从 `ALYSIA_DEPLOY_HOST` / `BLOG_SITE` 读 |
