/**
 * ★ 8-15 桌宠页入口(Electron 透明窗口加载,照抄 Cyrene 渲染层)
 * 手动实例化 live2d 控制器,暴露 window.live2d 供 IPC 驱动
 */
import { Live2DManager } from './live2d/manager';
import { InteractionController } from './live2d/interaction';
import { ExpressionResetController } from './live2d/expression-reset';
import { MouthSyncController } from './live2d/mouth-sync';
import { findAction } from './live2d/actions';

const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
document.getElementById('pet')?.appendChild(canvas);

const manager = new Live2DManager({
  canvas,
  width: window.innerWidth,
  height: window.innerHeight,
  modelPath: 'models/cyrene/Cyrene.model3.json',
  onLoad: () => console.log('[Pet] model loaded'),
});

manager.init().then(() => {
  manager.applyZoom(1);
  const model = manager.getModel();
  if (!model) return;
  const interaction = new InteractionController(canvas, model, manager.getHitAreaDefs(), {});
  const expressionReset = new ExpressionResetController(model);
  const mouthSync = new MouthSyncController(model);

  (window as any).live2d = {
    playAction: async (arg: string | { kind: string; group?: string; motionName?: string; name?: string }) => {
      if (typeof arg === 'string') {
        const action = findAction(arg);
        if (!action) return false;
        await manager.playAction(action.target);
        return true;
      }
      await manager.playAction(arg as any);
      return true;
    },
    startMouth: (ms: number) => mouthSync.start(ms),
    stopMouth: () => mouthSync.stop(),
    dispose: () => {
      expressionReset.dispose();
      interaction.dispose();
      mouthSync.dispose();
      manager.dispose();
    },
  };
  console.log('[Pet] live2d api ready');
}).catch((e) => console.error('[Pet] init failed:', e));

window.addEventListener('resize', () => {
  manager.resize?.(window.innerWidth, window.innerHeight);
});

// ── 拖窗(照抄 Cyrene 拖窗段:pointerdown 记录偏移 → moveTo;区分点击与拖动)──
let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let moved = false;
let downPos = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  moved = false;
  downPos = { x: e.screenX, y: e.screenY };
  dragOffsetX = e.screenX - window.screenX;
  dragOffsetY = e.screenY - window.screenY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dist = Math.hypot(e.screenX - downPos.x, e.screenY - downPos.y);
  if (dist > 5) moved = true; // 超过点击阈值才算拖动
  if (moved) window.moveTo(e.screenX - dragOffsetX, e.screenY - dragOffsetY);
});

canvas.addEventListener('pointerup', () => { dragging = false; });
