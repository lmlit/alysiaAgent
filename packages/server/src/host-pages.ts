/**
 * 宿主页面清单的**进程内缓存**（★ 2026-10-19，change: `let-her-query-what-she-made`）。
 *
 * ## 为什么需要它
 *
 * 真机证据：她为了"给用户一个网址"去**新建了一个任务**（`15:53 核实 island.html 当前真实的
 * 对外可访问地址…请自己用 curl 打开验证`）。那是错的 —— 她需要一个**只读查询**能力。
 *
 * ## 数据怎么来
 *
 * 页面清单是宿主上的文件（`/srv/alysia-preview/pages.json`，基站生成器每 10s 重建），
 * 容器里**看不到宿主路径**。所以由宿主 runner 每次轮询时 `POST /api/host/pages` 推上来，
 * 这里只做"存最新一份"。
 *
 * ⚠️ 这是**只读投影**，不是真相源：真相是 `pages.json` / `public/`。
 *    所以工具输出里必须带 `generatedAt`，让她（和用户）知道"这是几分钟前的"。
 */

/** 单个页面（与 `scripts/preview-hub.py` 写出的 `pages.json` 对齐） */
export interface HostPage {
  projectId: string;
  file: string;
  title: string;
  url: string;
  /** 是否已在 `public/`（= 上线） */
  published: boolean;
  updatedAt: string;
}

export interface HostPagesIndex {
  /** 清单生成时间（ISO，宿主时区） */
  generatedAt: string;
  pages: HostPage[];
  /** 服务端**收到**它的时间（服务端时区，用来判"这份多旧"） */
  receivedAt?: string;
}

let current: HostPagesIndex | null = null;

/** 解析并校验一次上报（形状不对就返回 null —— 宁可不更新，也不要存半份坏数据） */
export function parseHostPagesInput(raw: unknown): HostPagesIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as { generatedAt?: unknown; pages?: unknown };
  if (!Array.isArray(b.pages)) return null;
  const pages: HostPage[] = [];
  for (const item of b.pages) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const projectId = typeof p.projectId === 'string' ? p.projectId : '';
    const file = typeof p.file === 'string' ? p.file : '';
    const url = typeof p.url === 'string' ? p.url : '';
    if (!projectId || !file || !url) continue; // 缺字段的条目直接丢，不猜
    pages.push({
      projectId,
      file,
      title: typeof p.title === 'string' && p.title ? p.title : file,
      url,
      published: p.published === true,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
    });
  }
  return {
    generatedAt: typeof b.generatedAt === 'string' ? b.generatedAt : '',
    pages,
  };
}

export const hostPagesCache = {
  set(index: HostPagesIndex): void {
    current = { ...index, receivedAt: new Date().toISOString() };
  },
  get(): HostPagesIndex | null {
    return current;
  },
  /** 测试用 */
  clear(): void {
    current = null;
  },
};
