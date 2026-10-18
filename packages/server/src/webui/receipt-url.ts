/**
 * 回执地址的选择（★ 2026-10-18，change: `fix-receipt-link-to-produced-page`）。
 *
 * 契约来源：`openspec/specs/project-tasks/spec.md` §11 **契约 38**
 *
 *   > `projects.<id>.publicUrl = <base>/p/<id>/`。
 *   > 回执与推送带的是**她刚做的那个页面**，不是基站根 —— 用户问"给我链接"时要一步到位。
 *
 * 真机事故（10-18 23:04，QQ）：用户点回执里的 `…/p/alysia-toys/` 看到的是凌晨做的
 * 「月光花园」，不是刚做的海岛。根因不是文案，是**地址选错了对象**：
 * 一直用项目级 `publicUrl`（恒定），而不是本轮产物页。
 *
 * ★ 为什么服务端只做校验、拼地址在 runner：
 *   容器里的服务端**看不见宿主工作区**，判不了"哪个页面是这一轮做的"、也判不了
 *   "它有没有进 `public/`"。runner 两个都能看见（契约 68：判据取文件事实）。
 *   服务端在这里的职责只有一条：**只接受由该项目 `publicUrl` 派生的地址**，
 *   不接受任何越界的串（防止回传被伪造/写坏）。
 */

/** 页面产物（runner 上报的形状） */
export interface ProjectTaskArtifact {
  /** 工作区相对路径，如 `island.html` */
  path?: unknown;
  /** 是否已在 `public/`（即"已发布"） */
  published?: unknown;
  /** runner 拼好的绝对地址（必须由 publicUrl 派生） */
  url?: unknown;
}

/**
 * 合法地址前缀：项目 `publicUrl` 的目录，以及它的 `/w/` 预览兄弟
 * （`/p/<id>/` ⇄ `/w/<id>/` —— 基站的两个前缀，见 `scripts/preview-hub.py`）。
 */
export function allowedUrlPrefixes(publicUrl: string): string[] {
  const base = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  if (!base) return [];
  const dir = base.endsWith('/') ? base : `${base}/`;
  const out = [dir];
  const m = /^(.*)\/p\/([^/]+)\/?$/.exec(base);
  if (m) out.push(`${m[1]}/w/${m[2]}/`);
  return out;
}

/**
 * 选回执/推送里该带的地址。
 *
 * 规则（按优先级）：
 *   1. 本轮产物页的 `url`，且**必须**落在合法前缀内 ⇒ 用它（契约 38 的"一步到位"）
 *   2. 否则回落项目门牌 `publicUrl`（**不许**编一个地址）
 *
 * ⚠️ 回落是**如实**的回落：调用方（回执正文）仍会说清"这一轮做到了哪一步"，
 *   所以"门牌 ≠ 新页面"不会被伪装成"这就是新页面"。
 */
export function pickPageUrl(publicUrl: string | undefined, artifacts: unknown): string | undefined {
  const base = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  const list = Array.isArray(artifacts) ? (artifacts as ProjectTaskArtifact[]) : [];
  const prefixes = allowedUrlPrefixes(base);

  for (const a of list) {
    const url = a && typeof a.url === 'string' ? a.url.trim() : '';
    if (!url) continue;
    if (!prefixes.some(p => url.startsWith(p))) continue; // 越界 ⇒ 只当没看见，不报错
    return url;
  }
  return base || undefined;
}
