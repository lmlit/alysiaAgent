/**
 * 跨页面共享的 Live2D 实例（模块级单例）
 *
 * change: live2d-persist-across-pages
 *
 * ★ 为什么要做成模块单例，而不是放在 React 里的 useRef：
 *   1. **跨路由不重建** —— 页面组件会卸载，模块不会。`/life` → `/dashboard` 时
 *      模型资源（9MB 贴图）完全不动，只重算缩放。
 *   2. **扛住 StrictMode 双挂载** —— 放 ref 里的话 dev 下 effect 跑两遍会加载两次模型。
 *      单例天然幂等。
 *
 * ★ 实现依据（已实测）：canvas 在 DOM 里换父节点，WebGL context 与已绘内容都保得住
 *   （连"摘出文档再插回"都不丢）。所以这里**持有一份 canvas 全程不 destroy**，
 *   靠 portal 把它搬进当前页面的槽位。见 change proposal 的验证数据。
 */
import type { Live2DManager } from './manager'
import type { InteractionController } from './interaction'
import type { ExpressionResetController } from './expression-reset'
import type { MouthSyncController } from './mouth-sync'
import type { findAction } from './actions'

export type Live2DStatus = 'loading' | 'ready' | 'fallback'

/** 对外接口（保留自 webui：`play_live2d_action` 工具与后续 TTS 口型要用） */
export type Live2DApi = {
  playAction: (
    aliasOrTarget:
      | string
      | { kind: string; group?: string; motionName?: string; name?: string },
  ) => Promise<boolean>
  startMouth: (durationMs: number) => void
  stopMouth: () => void
  dispose: () => void
}

const MODEL_PATH = '/models/cyrene/Cyrene.model3.json'

let canvasEl: HTMLCanvasElement | null = null
let manager: Live2DManager | null = null
let interaction: InteractionController | null = null
let expressionReset: ExpressionResetController | null = null
let mouthSync: MouthSyncController | null = null
let status: Live2DStatus = 'loading'
let started = false
let lastSize = { w: 0, h: 0 }

const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

function setStatus(next: Live2DStatus): void {
  if (status === next) return
  status = next
  emit()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getStatus(): Live2DStatus {
  return status
}

/**
 * 绑定那块**唯一**的 canvas（由 `Live2DLayer` 渲染并持有，本模块只管用）。
 * 全程不 destroy —— 换页时它只是被搬个位置。
 */
export function bindCanvas(canvas: HTMLCanvasElement): void {
  canvasEl = canvas
}

/** 按容器适配尺寸（幂等；未加载完只记下来，等 load 完再套用） */
export function fitTo(width: number, height: number): void {
  if (width <= 0 || height <= 0) return
  if (lastSize.w === width && lastSize.h === height) return
  lastSize = { w: width, h: height }
  if (canvasEl && !manager) {
    // 还没接上模型，先把画布尺寸记下（避免用 1×1 初始化）
    canvasEl.width = width
    canvasEl.height = height
  }
  manager?.fitTo(width, height)
}

/**
 * 幂等启动：装 Cubism 运行时 → 动态 import → 初始化。
 *
 * ★ 顺序不能反：`pixi-live2d-display/cubism4` 在**模块求值阶段**就检查
 *   全局 `Live2DCubismCore`，先 import 再加载运行时会直接抛错（实测踩过）。
 */
export function ensureStarted(canvas: HTMLCanvasElement): void {
  canvasEl = canvas
  if (started) return
  started = true

  void (async () => {
    try {
      const { ensureCubismRuntime } = await import('./runtime')
      await ensureCubismRuntime()
      const { Live2DManager } = await import('./manager')

      const [{ InteractionController }, { ExpressionResetController }, { MouthSyncController }, { findAction }] =
        await Promise.all([
          import('./interaction'),
          import('./expression-reset'),
          import('./mouth-sync'),
          import('./actions'),
        ])

      const m = new Live2DManager({
        canvas,
        width: lastSize.w || 200,
        height: lastSize.h || 260,
        modelPath: MODEL_PATH,
        fit: 'fill',
        onLoad: () => {
          // 首帧真正渲染出来再算 ready，避免"球淡出了、模型还没画上来"的空窗
          requestAnimationFrame(() => {
            if (lastSize.w) m.fitTo(lastSize.w, lastSize.h)
            setStatus('ready')
          })
        },
        onError: (err) => {
          console.error('[Live2D] 模型加载失败', err)
          setStatus('fallback')
        },
      })
      manager = m
      await m.init()

      const model = m.getModel()
      if (model) {
        interaction = new InteractionController(canvas, model, m.getHitAreaDefs(), {})
        expressionReset = new ExpressionResetController(model)
        mouthSync = new MouthSyncController(model)
      }

      // 对外接口：与 webui 的 window.live2d 保持一致（工具/TTS 口型驱动）
      const api: Live2DApi = {
        playAction: async (arg) => {
          if (!manager) return false
          if (typeof arg === 'string') {
            const action = findAction(arg)
            if (!action) return false
            await manager.playAction(action.target)
            return true
          }
          await manager.playAction(arg as never)
          return true
        },
        startMouth: (ms) => mouthSync?.start(ms),
        stopMouth: () => mouthSync?.stop(),
        dispose: () => __resetForTests(),
      }
      ;(window as unknown as { live2d?: Live2DApi }).live2d = api
    } catch (err) {
      console.error('[Live2D] 初始化失败，将退回暖光球', err)
      started = false // 允许重试
      setStatus('fallback')
    }
  })()
}

/** 释放实例（供 window.live2d.dispose / 测试复位；下次 ensureStarted 会重建） */
export function __resetForTests(): void {
  expressionReset?.dispose?.()
  interaction?.dispose?.()
  mouthSync?.dispose?.()
  manager?.dispose()
  manager = null
  interaction = null
  expressionReset = null
  mouthSync = null
  // canvasEl 不清空 —— 它由 React 持有，只是 Pixi 不再往上面渲染
  started = false
  lastSize = { w: 0, h: 0 }
  const w = window as unknown as { live2d?: Live2DApi }
  if (w.live2d) delete w.live2d
  setStatus('loading')
}
