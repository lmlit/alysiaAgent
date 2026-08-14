<script setup lang="ts">
/**
 * ★ 8-15 Live2D 小人(Electron 全功能,照抄 Cyrene 渲染层)
 * 模型:public/models/cyrene/;渲染:pixi.js 7 + pixi-live2d-display
 * 通过 window.live2d 接口供桌宠窗口/聊天视图驱动(动作/口型)
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { Live2DManager } from '../../live2d/manager';
import { InteractionController } from '../../live2d/interaction';
import { ExpressionResetController } from '../../live2d/expression-reset';
import { MouthSyncController } from '../../live2d/mouth-sync';
import { findAction } from '../../live2d/actions';

const props = withDefaults(defineProps<{
  width?: number;
  height?: number;
  interactive?: boolean;
  zoom?: number;
}>(), { width: 300, height: 380, interactive: true, zoom: 1 });

const canvasEl = ref<HTMLCanvasElement | null>(null);
const emit = defineEmits<{ (e: 'ready'): void }>();

let manager: Live2DManager | null = null;
let interaction: InteractionController | null = null;
let expressionReset: ExpressionResetController | null = null;
let mouthSync: MouthSyncController | null = null;

/** 暴露全局接口:动作工具/桌宠窗口驱动 */
interface Live2DWindowApi {
  playAction: (aliasOrTarget: string | { kind: string; group?: string; motionName?: string; name?: string }) => Promise<boolean>;
  startMouth: (durationMs: number) => void;
  stopMouth: () => void;
  dispose: () => void;
}

onMounted(async () => {
  if (!canvasEl.value) return;
  // live2dcubismcore 全局脚本(index.html 已引)
  try {
    manager = new Live2DManager({
      canvas: canvasEl.value,
      width: props.width,
      height: props.height,
      modelPath: 'models/cyrene/Cyrene.model3.json',
      onLoad: () => emit('ready'),
    });
    await manager.init();
    manager.applyZoom(props.zoom);

    const model = manager.getModel();
    if (props.interactive && model) {
      interaction = new InteractionController(canvasEl.value, model, manager.getHitAreaDefs(), {});
      expressionReset = new ExpressionResetController(model);
    }
    if (model) mouthSync = new MouthSyncController(model);

    const api: Live2DWindowApi = {
      playAction: async (arg) => {
        if (!manager) return false;
        if (typeof arg === 'string') {
          const action = findAction(arg);
          if (!action) return false;
          await manager.playAction(action.target);
          return true;
        }
        await manager.playAction(arg as any);
        return true;
      },
      startMouth: (ms) => mouthSync?.start(ms),
      stopMouth: () => mouthSync?.stop(),
      dispose: () => dispose(),
    };
    (window as any).live2d = api;
  } catch (e) {
    console.error('[Live2D] init failed:', e);
  }
});

function dispose() {
  expressionReset?.dispose?.();
  interaction?.dispose?.();
  mouthSync?.dispose?.();
  manager?.dispose();
  manager = null;
}

onUnmounted(dispose);
</script>

<template>
  <div class="l2d-wrap" :style="{ width: `${width}px`, height: `${height}px` }">
    <canvas ref="canvasEl" :width="width" :height="height" class="l2d-canvas"></canvas>
  </div>
</template>

<style scoped>
.l2d-wrap { position: relative; overflow: hidden; }
.l2d-canvas { width: 100%; height: 100%; display: block; }
</style>
