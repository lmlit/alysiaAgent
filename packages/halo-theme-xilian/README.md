# halo-theme-xilian —— 昔涟 · 纸笺

给「昔涟」用的 Halo 2 主题：**纸质淡墨 + 日记流**。

## ⚠️ 许可（先看这条）

本主题是 **「绿野 Luye」(theme-luye) 的派生作品**，原项目 GPL-3.0：

- 原作者：Ron567 — <https://github.com/ReganQing/Luye>
- 设计参考：Ron567 个人主页 aboutme

**依 GPL-3.0，本主题同样以 GPL-3.0 发布**（`LICENSE` 随附，`NOTICE` 记录改动）。
GPL 只覆盖本目录，与仓库其余代码是“聚合”关系，不影响其他部分的选择。

## 相对上游改了什么

| 层 | Luye | 本主题 |
|---|---|---|
| 配色 | 深绿玻璃拟态 `#0E1F17 → #08120E` | **纸色** `#FBF7EF → #EFE7D8` + 墨色 `#2B2A28` |
| 强调色 | `#7DD9A6` 荧光绿 | **雾青** `#4F7A74` |
| 卡片 | 深色玻璃 | **浅纸片**（`rgba(255,255,255,.62)`，保留毛玻璃） |
| 字体 | 无衬线为主 | **中文衬线优先**（Noto Serif SC / 宋体） |
| 首页列表 | 网格卡 / 纵向列表 | 新增 **`diary` 日记流**（日期在左 + 竖轴 + 只留 4 行）并设为默认 |
| 栏目导航 | 无 | 新增 **栏目条**（读 Halo 分类，显示「日常 · 5 / 留白 · 0」） |
| 默认关掉 | —— | 数据徽章行、精选专题、在线字体（国内慢） |
| 文案 | 技术博客口吻 | 日记口吻（「把日子过成能写下的一句话」「读读我写的」） |

未改：模板结构与 JS 行为、`page_about.html`、天气粒子特效。

## 目录

```
theme.yaml            # 元数据（name: theme-xilian, version, requires）
settings.yaml         # 后台设置项（含 posts.layout = diary）
NOTICE / LICENSE      # GPL-3 合规
templates/
  index.html          # 首页：Hero + 栏目条 + 日记流
  post.html page.html archives.html category.html tag.html ...
  assets/css/style.css    # 设计令牌在 :root，换色只改这里
  assets/js/weather.js    # 晴/雨/雪 Canvas 粒子（可关）
```

## 本地预览与发布

主题装在本地 Halo（`http://localhost:8090`，Halo 2.27.1 / Java 21 直跑）：

```powershell
# 1) 打包（zip 内第一层必须是 theme-xilian/）
# 2) 上传：POST /apis/api.console.halo.run/v1alpha1/themes/install （multipart，字段名 file）
# 3) 启用：PUT  /apis/api.console.halo.run/v1alpha1/themes/theme-xilian/activation
# 4) 新默认生效：PUT .../reset-config；模板有改：PUT .../invalidate-cache 再 PUT .../reload
```

⚠️ **换版本不能直接覆盖**：先 `DELETE /apis/theme.halo.run/v1alpha1/themes/theme-xilian`
（**注意不是** console 路径），等它从列表消失后再装新的，否则 install 会 400。

## 两个栏目

用 Halo 分类实现，不改代码：

- `日常`（slug `daily`）—— 公开日记
- `留白`（slug `blank`）—— 信、随手记（还没写）

栏目条自动显示分类与文章数。

## 更新记录（相对 Luye 的进一步改动）

| 版本 | 改动 |
|---|---|
| 0.2.0 | 新增 `diary` 日记流布局并设为默认；关掉数据徽章 / 精选专题 / 在线字体 |
| 0.3.0 | 首页「栏目」导航条（读分类，显示 `日常 · 5 / 留白 · 0`） |
| 0.4.0 | 作者卡片与页脚去掉上游作者（Ron567 / ReganQing），换成昔涟的介绍 |
| 0.5.0 | 移除页脚 `Powered by Halo`；文章页改日记体（大号日期 + 窄栏衬线正文 + 上/下篇） |
| 0.6.0 | 导航固定为「首页 / 归档 / 日常 / 留白 / 栏目」 |

### 两个已知的 Halo 侧限制（写在这里免得下次再撞）

1. **menus API 不可用**：`/apis/api.halo.run/v1alpha1/menus*` 与 console 的 menus 端点都返回 404，
   后台改菜单无法通过 REST 落地 ⇒ 导航直接写进 `templates/modules/header.html`。
2. **日记的 publishTime 要对齐日记当天**：日记写的是「昨天」，发布时刻是今天；
   不对齐的话日期戳会显示错的日子。发布时把 `spec.publishTime` 设成「那天 22:00 +08:00」。
