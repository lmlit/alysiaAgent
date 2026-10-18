/**
 * `AlysiaCore` 的构造选项与能力开关。
 *
 * ★ 2026-10-01 从 `src/index.ts` 抽出（change: modularize-core-assembly）——
 *   `modules/` 下的模块要消费 `AlysiaFeatures`，若从 `index.ts` 导入会形成
 *   循环依赖（index.ts 反过来 import modules）。`index.ts` 仍原样 re-export，
 *   `import { AlysiaFeatures } from '@alysia/core'` 不变。
 */

import type { DeepPartial, SamplingConfig } from './provider/sampling.js';

/** 控制 AlysiaCore 启动时激活的能力模块 */
export interface AlysiaFeatures {
  /** 编程模式：启用 shell + filesystem 工具 + CodeContextStore。
   *  服务端默认 false，桌面端设置为 true。 */
  codeMode?: boolean;
  /** Shell 执行工具（需 codeMode）。默认 true（当 codeMode 开启时）。 */
  shell?: boolean;
  /** 文件系统工具 — write/read/list（需 codeMode）。默认 true（当 codeMode 开启时）。 */
  filesystem?: boolean;
  /** 流式输出（LLM 逐 token 推送，桌面端 Live2D 口型同步需要）。默认 false。 */
  streaming?: boolean;
}

export interface AlysiaCoreOptions {
  dbPath: string;
  ownerId: string;
  workspaceDir: string;
  llmConfig: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  embedConfig: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** 能力开关。未提供时全部使用默认值（codeMode=false）。 */
  features?: AlysiaFeatures;
  /** ★ 8-10 采样参数统一配置（与 DEFAULT_SAMPLING 深合并，缺省走默认 floor）。
   *  对应 config.yml 的 sampling: 节。 */
  sampling?: DeepPartial<SamplingConfig>;
  /**
   * 已登记的**委托项目 id**（★ 2026-10-17，change: `add-project-task-delegation`）。
   *
   * **空/缺省 ⇒ 不注册委托工具**（配置即能力开关，见 `tools/project-tasks.ts`）。
   * ⚠️ 只放**id**：工作目录与 dsh profile 是**服务端配置**，由 runner 从认领响应里拿，
   *    core 不持有宿主路径（它连容器里都看不到）。
   */
  projectIds?: string[];
  /**
   * 执行窗口（★ change: gate-project-tasks-to-offpeak）。
   * 高峰时段（工作日 9-12 / 14-18）只排队不执行；节假日表由配置给（不内置，猜错更糟）。
   */
  projectTasks?: { holidays?: string[]; peakWindows?: Array<[number, number]> };
  /**
   * ★ 2026-10-19（change: `let-her-query-what-she-made`）：她做过的页面清单（只读投影）。
   *
   * 数据由宿主 runner 推上来（容器看不到宿主目录）。缺省 ⇒ 不注册
   * `list_my_pages` / `find_page` —— 没有数据就别给她假能力。
   */
  hostPages?: () => {
    generatedAt: string;
    receivedAt?: string;
    pages: Array<{
      projectId: string;
      file: string;
      title: string;
      url: string;
      published: boolean;
      updatedAt: string;
    }>;
  } | null;
}
