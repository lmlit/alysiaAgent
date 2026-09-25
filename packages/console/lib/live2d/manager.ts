import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { HitAreaDef } from "./interaction";
import { type Live2DTarget } from "./actions";

export type { HitAreaDef } from "./interaction";

/**
 * ★ 迁移适配（change: migrate-live2d-to-console）：下面两处原本写死"桌宠窗口"尺寸。
 *
 * 原代码的假设是 **Electron 桌宠窗口**：那个窗口就是模型的容器，
 * 所以它用 `window.innerWidth/innerHeight` 当画布尺寸、用写死的 400×500 当基准缩放。
 * Electron 已砍，现在是**浏览器里的一块 hero 区域**——`window` 是整个视口，
 * 照搬会导致 canvas 被撑成视口大小、模型跑到可视区外（实测：canvas 变 756×488，
 * 而容器只有 203×260，画面上什么都不显示）。
 *
 * 现在一律以**构造时传入的 width/height（= 容器尺寸）**为准。
 * 若将来还有"窗口即容器"的场景，把尺寸传进来即可，不必再读 window。
 */
const BASE_WIDTH = 400;
const BASE_HEIGHT = 500;

export interface Live2DManagerOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  modelPath: string;
  onLoad?: () => void;
  onError?: (err: Error) => void;
  /** 缩放策略：默认「填满容器」；'no-upscale' 保留原桌宠行为（绝不放大） */
  fit?: 'fill' | 'no-upscale';
}

export interface Live2DResourceMetrics {
  appActive: boolean;
  modelLoaded: boolean;
  disposed: boolean;
  tickerStarted: boolean | null;
  stageChildren: number | null;
  textureCacheSize: number | null;
  rendererType: "webgl" | "unknown" | null;
  drawingBufferWidth: number | null;
  drawingBufferHeight: number | null;
}

interface MotionEntry {
  Name?: string;
  File?: string;
  Expression?: string;
  [k: string]: unknown;
}

interface ModelJsonShape {
  HitAreas?: { Name?: string; Id?: string; Motion?: string }[];
  Motions?: Record<string, MotionEntry[]>;
}

function buildHitAreaDefs(json: ModelJsonShape): HitAreaDef[] {
  const out: HitAreaDef[] = [];
  const hitAreas = json.HitAreas ?? [];
  const motions = json.Motions ?? {};
  for (const area of hitAreas) {
    const name = area.Name;
    const id = area.Id;
    const trigger = area.Motion;
    if (!name || !id || !trigger) continue;
    const sep = trigger.indexOf(":");
    if (sep <= 0) continue;
    const group = trigger.substring(0, sep);
    const motionName = trigger.substring(sep + 1);
    const list = motions[group];
    const motionIndex = list ? list.findIndex((m) => m.Name === motionName) : -1;
    const motion = motionIndex >= 0 && list ? list[motionIndex] : undefined;
    const expressionName = motion?.Expression;
    out.push({ name, id, group, motionName, motionIndex, expressionName });
  }
  return out;
}

function buildMotionIndexMap(json: ModelJsonShape): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const motions = json.Motions ?? {};
  for (const [group, list] of Object.entries(motions)) {
    const inner = new Map<string, number>();
    list.forEach((entry, i) => {
      const name = entry?.Name;
      if (typeof name === "string" && name.length > 0) inner.set(name, i);
    });
    out.set(group, inner);
  }
  return out;
}

export class Live2DManager {
  private app: PIXI.Application | null = null;
  private model: Live2DModel | null = null;
  private hitAreaDefs: HitAreaDef[] = [];
  /** group -> motionName -> index in internalModel.motionManager.definitions[group]. */
  private motionIndexMap: Map<string, Map<string, number>> = new Map();
  private options: Live2DManagerOptions;
  private disposed = false;
  private initPromise: Promise<void> | null = null;
  /** Scale that fits the model into the base window (zoom=1.0). Cached once
   *  at load so applyZoom can multiply it by the user's zoom factor. */
  private baseScale = 1;

  /**
   * ★ 模型**未缩放**时的尺寸（加载完成、scale 还是 1 时记下来）。
   *
   * 不能用 `model.width` 现算：Pixi 的 `.width` 返回的是**已应用 scale 之后**的边界宽度，
   * 拿它当分母会形成反馈——每次按新容器重算缩放，都会在上一次的基础上再乘一遍，
   * 几百毫秒内就把模型放大成一个特写（实测踩过这件事）。
   */
  private modelBaseWidth = 1;
  private modelBaseHeight = 1;
  /** Current zoom factor (1.0 = default). Window size is driven separately by
   *  the main process; this only scales the model relative to baseScale. */
  private zoom = 1;

  constructor(options: Live2DManagerOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    const { canvas, width, height } = this.options;
    this.app = new PIXI.Application({
      view: canvas,
      width,
      height,
      // ★ 迁移修正：原代码这里还有个 `transparent: true`，但 Pixi v7 的
      //   IApplicationOptions 没这个字段（v6 遗留，被静默忽略）——
      //   真正让背景透明的是下一行 backgroundAlpha: 0。
      //   webui 从不类型检查（build 脚本是裸 `vite build`，不跑 tsc），所以一直没暴露。
      backgroundAlpha: 0,
      antialias: true,
      // Preserve the drawing buffer so callers can read pixels back out of
      // it at any time (e.g. the click-through controller sampling the alpha
      // under the cursor to decide transparent vs. opaque). Without this the
      // WebGL framebuffer is cleared after each frame and readPixels is UB.
      preserveDrawingBuffer: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    try {
      await this.loadModel();
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      if (this.app) {
        this.app.destroy(false, { children: true, texture: true });
        this.app = null;
      }
    }
  }

  private async loadModel(): Promise<void> {
    const { modelPath } = this.options;
    // Kick off the Live2D load and the raw JSON fetch in parallel so the
    // hit-area / motion index map is ready the moment the model is.
    const modelPromise = Live2DModel.from(modelPath, {
      ticker: this.app!.ticker,
      autoHitTest: false,
      autoFocus: false,
    });
    const jsonPromise = fetch(modelPath).then((r) => {
      if (!r.ok) throw new Error("Failed to fetch " + modelPath + ": " + r.status);
      return r.json() as Promise<ModelJsonShape>;
    });
    let model: Live2DModel;
    let json: ModelJsonShape;
    try {
      [model, json] = await Promise.all([modelPromise, jsonPromise]);
    } catch (err) {
      // A JSON fetch failure can race with a successful Cubism load. Wait for
      // that model and destroy it before propagating the error so its textures
      // never survive an unsuccessful initialization attempt.
      const loadedModel = await modelPromise.catch(() => null);
      loadedModel?.destroy();
      throw err;
    }
    if (!this.app || this.disposed) {
      model.destroy();
      return;
    }
    this.model = model;
    this.hitAreaDefs = buildHitAreaDefs(json);
    this.motionIndexMap = buildMotionIndexMap(json);
    this.app.stage.addChild(this.model);
    this.model.anchor.set(0.5, 0.5);
    // 趁 scale 还是 1，把未缩放的基准尺寸记下来（后续所有缩放都以它为分母）
    this.modelBaseWidth = this.model.width || 1;
    this.modelBaseHeight = this.model.height || 1;
    // baseScale is always computed against the *base* window size, never the
    // current (possibly zoomed) one. The main process resizes the window to
    // base × zoom before the renderer loads, so reading the live window here
    // would fold zoom into baseScale and then applyZoom would double-count
    // it. Using fixed base dimensions keeps baseScale zoom-invariant.
    // ★ 迁移适配：基准缩放按**容器尺寸**算，不再用写死的桌宠窗口尺寸
    const boxW = this.options.width || BASE_WIDTH;
    const boxH = this.options.height || BASE_HEIGHT;
    const baseScaleX = boxW / this.modelBaseWidth;
    const baseScaleY = boxH / this.modelBaseHeight;
    // ★ 迁移适配：原为 `Math.min(baseScaleX, baseScaleY, 1.0)` —— 上限 1.0 是
    //   桌宠窗口的"绝不放大"策略。hero 区要的是**填满**，否则模型只占一小块。
    //   `fit` 选项让调用方选：hero 用默认（填满），要保原行为传 'no-upscale'。
    this.baseScale =
      this.options.fit === 'no-upscale'
        ? Math.min(baseScaleX, baseScaleY, 1.0)
        : Math.min(baseScaleX, baseScaleY);
    this.applyZoom(this.zoom);
    this.options.onLoad?.();
  }

  /**
   * ★ 迁移适配（change: live2d-persist-across-pages）：
   * 实例跨页面共享后，容器尺寸会随页面变化（`/life` 320 → `/dashboard` 230 → `/` 380）。
   * 换盒子时只需**重算缩放 + 重设 renderer 尺寸**，模型资源完全不用重载。
   *
   * 这是"持久化"能省掉 9MB 重载的关键：尺寸适配与资源加载被解耦了。
   */
  fitTo(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
    if (!this.model) return;
    // 分母必须是**未缩放**的基准尺寸，否则每次重算都在上一次结果上再乘一遍（会放大到爆）
    const s = Math.min(width / this.modelBaseWidth, height / this.modelBaseHeight);
    this.baseScale = this.options.fit === 'no-upscale' ? Math.min(s, 1.0) : s;
    this.applyZoom(this.zoom);
  }

  /**
   * Apply the user's zoom factor on top of the cached base scale. The window
   * itself is resized separately by the main process (window = base × zoom),
   * so this just sets model scale = baseScale × zoom and re-centres it in the
   * (now resized) canvas. Reads the live window size rather than the stale
   * constructor options, since the main process has already resized the
   * window by the time this is invoked. Proportions never change, so the
   * model always fills the window and is never clipped.
   */
  applyZoom(zoom: number): void {
    this.zoom = zoom;
    if (!this.model) return;
    this.model.scale.set(this.baseScale * zoom);
    // ★ 迁移适配：原为 `this.resize(window.innerWidth, window.innerHeight)`——
    //   那是"窗口即容器"的 Electron 假设。浏览器里 window 是整个视口，
    //   这么做会把画布撑到视口大小、模型跑出可见区。改为按容器尺寸。
    this.resize(this.options.width, this.options.height);
  }

  getModel(): Live2DModel | null {
    return this.model;
  }

  /**
   * The underlying WebGL rendering context, or null before init/disposed.
   * Used by the click-through controller to sample pixel alpha under the
   * cursor (transparent -> click passes through, opaque -> capture).
   *
   * `app.renderer` is typed as the abstract `IRenderer`; only the concrete
   * WebGL `Renderer` exposes `.gl`, so we narrow with an instanceof check.
   */
  getGL(): WebGL2RenderingContext | null {
    const renderer = this.app?.renderer;
    return renderer instanceof PIXI.Renderer ? renderer.gl : null;
  }

  getHitAreaDefs(): HitAreaDef[] {
    return this.hitAreaDefs;
  }

  getResourceMetrics(): Live2DResourceMetrics {
    const gl = this.getGL();
    const textureCache = (PIXI as unknown as { utils?: { TextureCache?: Record<string, unknown> } }).utils?.TextureCache;
    return {
      appActive: this.app !== null,
      modelLoaded: this.model !== null,
      disposed: this.disposed,
      tickerStarted: this.app ? Boolean((this.app.ticker as unknown as { started?: boolean }).started) : null,
      stageChildren: this.app ? ((this.app.stage as unknown as { children?: unknown[] }).children?.length ?? null) : null,
      textureCacheSize: textureCache ? Object.keys(textureCache).length : null,
      rendererType: gl ? "webgl" : this.app ? "unknown" : null,
      drawingBufferWidth: gl?.drawingBufferWidth ?? null,
      drawingBufferHeight: gl?.drawingBufferHeight ?? null,
    };
  }

  /**
   * Play a Live2D motion or expression described by a catalog target.
   *
   * - motion target: looks up the motion's index in the group's
   *   internalModel.motionManager.definitions and calls model.motion().
   *   Falls back to model.expression(motionName) if the motion isn't
   *   registered (matches the same fallback the hit-area controller uses).
   * - expression target: calls model.expression(name) directly.
   *
   * Swallows errors so a broken animation never crashes the renderer.
   * No-op when this.model is null (pet window not yet ready).
   */
  async playAction(target: Live2DTarget): Promise<void> {
    if (!this.model) return;
    try {
      if (target.kind === "motion") {
        const inner = this.motionIndexMap.get(target.group);
        const index = inner?.get(target.motionName);
        if (typeof index === "number") {
          await this.model.motion(target.group, index);
          return;
        }
        // Not registered as a motion — fall back to expression semantics.
        await this.model.expression(target.motionName);
        return;
      }
      // expression target
      await this.model.expression(target.name);
    } catch (err) {
      console.warn("[Cyrene] playAction failed", target, err);
    }
  }

  resize(width: number, height: number): void {
    if (!this.app) return;
    this.app.renderer.resize(width, height);
    if (this.model) {
      this.model.x = width / 2;
      this.model.y = height / 2;
    }
  }

  /**
   * Pause the PIXI ticker. Stops all per-frame controllers (AutoBreath,
   * EyeBlink, MouseTracking, Physics) from advancing. The model freezes
   * on its last rendered frame.
   *
   * Used while the user is dragging the window, so that the Windows DWM
   * "drag image" stays bit-identical to the live canvas content -- this
   * kills the ghosting/flicker that transparent Electron windows show
   * during a drag on Windows.
   */
  pause(): void {
    if (this.app) this.app.ticker.stop();
  }

  /** Resume the PIXI ticker. See pause(). */
  resume(): void {
    if (!this.app) return;
    this.app.render();
    this.app.ticker.start();
  }

    dispose(): void {
    this.disposed = true;
    if (this.model) {
      this.model.destroy();
      this.model = null;
    }
    if (this.app) {
      this.app.destroy(false, { children: true, texture: true });
      this.app = null;
    }
  }
}
