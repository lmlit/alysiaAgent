/**
 * Cubism 4 运行时（`live2dcubismcore.min.js`）加载器 —— 单例。
 *
 * ★ 为什么必须独立成模块、且必须在 **任何 Live2D 模块 import 之前** 调完：
 *
 *   `pixi-live2d-display/cubism4` 在**模块求值阶段**就检查全局 `Live2DCubismCore`，
 *   缺失直接抛 "Could not find Cubism 4 runtime"。也就是说
 *   「先 import 模块、再在 effect 里加载运行时」是**必然失败**的顺序：
 *
 *       import { Live2DManager } from './manager'   // ← 这里就炸了
 *       useEffect(() => { await loadRuntime(); ... })
 *
 *   正确顺序：`await ensureCubismRuntime()` → **然后** `await import('...live2d-canvas')`。
 *   见 `components/xilian-figure.tsx`。
 *
 *   （webui 没这问题，因为它在 index.html 里用 <script> 保证了加载顺序；
 *     Next 下没有那个静态保证，只能显式控制。）
 *
 * 顺带好处：不做 Live2D 的页面完全不必下载这个脚本。
 */

type CubismGlobal = { Live2DCubismCore?: unknown };

let loading: Promise<void> | null = null;

export function ensureCubismRuntime(): Promise<void> {
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Cubism 运行时只能在浏览器加载'));
      return;
    }
    if ((window as unknown as CubismGlobal).Live2DCubismCore) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = '/live2dcubismcore.min.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // 失败要允许重试——否则一次网络抖动就把 Live2D 永久废掉
      loading = null;
      reject(new Error('Cubism 运行时加载失败 (/live2dcubismcore.min.js)'));
    };
    document.head.appendChild(script);
  });

  return loading;
}
