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

## 2.5 素材库与封面（2026-10-21）

### 素材库在哪

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `blog/assets-source/raw/` | 22 张原图（第三方美术，约 30MB） | ❌ gitignored |
| `blog/assets-source/manifest.json` | 每张的自动标签（尺寸/方向/色调/题材/可否做封面） | ✅ 入库 |
| `blog/src/content/posts/<slug>.webp` | 裁切压缩后的成品封面（1200×630） | ✅ 入库 |

**为什么要 manifest 而不是只有图**：图不能进仓库（体积 + 版权），但"我有哪些可用素材、
哪些带水印不能用"这个知识必须留下 —— 否则下次又得重新爬一遍再踩同样的坑。

### 怎么爬（可复现）

来源：`commons.moegirl.org.cn/Category:昔涟` + `zh.moegirl.org.cn/昔涟`。
**MediaWiki API 被 Cloudflare 拦**（`api.php` 返回 0 条），只能抓 HTML 再正则提直链：

```
https://storage.moegirl.org.cn/moegirl/commons/...  → 直链
```

抓的时候带 `User-Agent` + `Referer`（否则可能 403）。过滤掉 `logo|CC-BY|avatars|icon`。

### manifest 的标签是怎么来的（自动，不靠眼睛）

`orientation`（横/竖/方，按宽高比）、`brightness`、`hue`、`temperature`（冷暖）、
`themes`（从文件名推：立绘/CG/光锥/壁纸/贺图/日记/合影）、`cover_ok`（横图 且宽≥1200 且非 logo）。

⚠️ `cover_ok` **不等于"能用"**。实测 22 张里 `cover_ok=11`，但里面：
- `11` 央视新闻水印
- `17` B 站字幕（"下一次又一次…"）
- `01/02/10/15` 群像或海报
- `09/16/18` 群像战斗 CG

**真正"纯单角色横图"只有 `07`（粉紫天空）和 `12`（黄昏草地）两张。**
所以只能补竖图裁上部：`05/13/19`（光锥/剧情立绘）与 `21`（立绘，紫粉星空）。

### 选图流程（别靠文件名猜）

```
1. python .tmp/make-candidates.py     → .tmp/candidates.jpg（横图候选，图上标 id）
2. python .tmp/make-candidates2.py    → .tmp/candidates2.jpg（竖图候选）
3. 人眼过一遍，记下每个 slug 用哪张 id
4. 改 blog/scripts/make-covers.py 的 PLAN，再跑
```

⚠️ **文件名和内容对不上是常态**：`16 在永无止境的轮回的尽头` 其实是群像战斗 CG，
`13 光锥·故事的下一页` 和 `19 故事的下一页` 是同一张图的两个版本（会看起来重复）。
**必须看图，不能看名字。**

### 当前 5 张的分配

| 随笔 | 素材 id | 内容 |
|---|---|---|
| 早上那十分钟 | 05 | 光锥·爱如此刻永恒（粉白蓝，明亮） |
| 窗台上那盆绿 | 07 | 前瞻壁纸（粉紫天空，飞起） |
| 迷迷的午睡 | 19 | 故事的下一页（暖调人像 + 鸟） |
| 等一盏灯亮起来 | 12 | 星穹铁道（黄昏草地） |
| 把一天收好 | 21 | 立绘（紫粉星空，压暗冷调） |

### 版权

插画版权属 **miHoYo**，萌百按其 **CC BY-NC-SA** 收录。
本博客是**个人非商业**用途；**商用或公开推广前必须换图或取得授权**。
仓库只放裁切压缩后的封面（约 340KB），原图在 gitignored 的 `raw/`。

### 卡片布局（双列网格）

| 改了什么 | 在哪 |
|---|---|
| 列表容器：单列 → `grid grid-cols-1 lg:grid-cols-2` | `blog/src/components/PostPage.astro` |
| 卡片：左文右图 → **上图下文**（`order-first` + `aspect-video`） | `blog/src/components/PostCard.astro` |

⚠️ PostCard 原本把封面 `absolute` 贴在右侧 28% 宽。放进双列网格后会被挤成一条竖图（等于白放），
所以必须同时改成整宽 16:9。**只改 grid 不改卡片，等于没改。**

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
