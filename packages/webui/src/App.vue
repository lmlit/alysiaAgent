<script setup lang="ts">
/**
 * ★ 8-15 布局大改(webui-visual-redesign,方案 A:图标 Dock 侧栏)
 *  - Dock 侧栏 56px,悬停展开 190px 显示文字;顶部昔涟头像位(portrait.png,无则金 orb)
 *  - 顶栏:Cyrene 式玻璃胶囊元信息(「昔涟 · 状态 · 亲密度」)
 *  - 聊天页沉浸:Dock 自动收起,chat 视图占满全屏(自带会话列表)
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAppStore, THEMES } from './stores/app';
import { modules } from './modules';
import { Heart, Sparkle, Clapperboard, Minus, X } from 'lucide-vue-next';

const app = useAppStore();
const online = ref(false);
const dockOpen = ref(false);
/** ★ 昔涟形象位:GET /api/portrait(服务端 data/portrait.<ext>),hover 可图形化更换 */
const portraitSrc = ref('');
const portraitBusy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function pickPortrait() {
  fileInput.value?.click();
}

// ── 窗口控制(模板里不能写 TS 断言,统一走方法)──
function winMinimize() {
  (window as any).appWindow?.minimize();
}
function winClose() {
  (window as any).appWindow?.close();
}

// ── ★ 顶栏拖窗(照抄 Cyrene:pointerdown 记录 → rAF 节流增量 moveBy)
//   不用 setPointerCapture(Windows 上 pointerup 丢失会导致 capture 泄漏拦截点击);
//   加 4px 位移阈值,区分点击与拖动
let dragLast: { x: number; y: number } | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragActive = false;
let dragRaf: number | null = null;
let dragPending = { dx: 0, dy: 0 };

function onTopbarDown(e: PointerEvent) {
  const aw = (window as any).appWindow;
  if (!aw?.moveBy) return; // 浏览器形态不拖
  const target = e.target as HTMLElement;
  if (target.closest('.win-btns, .theme-select')) return; // 交互元素不拖
  dragLast = { x: e.screenX, y: e.screenY };
  dragStart = { x: e.screenX, y: e.screenY };
  dragActive = false;
}

function onTopbarMove(e: PointerEvent) {
  const aw = (window as any).appWindow;
  if (!aw?.moveBy) return;
  // ★ 关键:没按住左键绝不拖——pointerup 丢失(移出窗口松开)后 dragLast 残留,
  //   纯 hover 的 pointermove 会把窗口拖飞(用户实测:鼠标移上去窗口就往屏幕外跑)
  if (!(e.buttons & 1)) {
    dragLast = null;
    dragStart = null;
    dragActive = false;
    return;
  }
  if (!dragLast || !dragStart) return;
  // 位移超过阈值才开始拖(点击不触发)
  if (!dragActive) {
    const dist = Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y);
    if (dist < 4) return;
    dragActive = true;
  }
  dragPending.dx += e.screenX - dragLast.x;
  dragPending.dy += e.screenY - dragLast.y;
  dragLast = { x: e.screenX, y: e.screenY };
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => {
    aw.moveBy(dragPending.dx, dragPending.dy);
    dragPending = { dx: 0, dy: 0 };
    dragRaf = null;
  });
}

function onTopbarUp() {
  if (dragRaf) cancelAnimationFrame(dragRaf);
  dragRaf = null;
  dragLast = null;
  dragStart = null;
  dragActive = false;
  dragPending = { dx: 0, dy: 0 };
}

async function onPortraitFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return;
  portraitBusy.value = true;
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const r = (await fetch('/api/portrait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: base64, ext: file.type.replace('image/', '') }),
    }).then(res => res.json())) as { ok: boolean; url?: string };
    if (r.ok && r.url) portraitSrc.value = r.url;
  } catch { /* 静默 */ }
  finally {
    portraitBusy.value = false;
  }
}

// ★ Dock 全页面保持可见(聊天页也不例外——导航可访问性优先;
//   "沉浸"由 chat 视图内部双栏实现)
const shellClass = computed(() => ({
  'dock-open': dockOpen.value,
}));

let pingTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  fetch('/api/portrait', { method: 'HEAD' })
    .then(r => { if (r.ok) portraitSrc.value = '/api/portrait?v=' + Date.now(); })
    .catch(() => {});
  app.ping().then(ok => { online.value = ok; });
  app.refreshMeta();
  pingTimer = setInterval(() => {
    app.ping().then(ok => { online.value = ok; });
  }, 15_000);
});

onUnmounted(() => {
  if (pingTimer) clearInterval(pingTimer);
});
</script>

<template>
  <div class="shell" :class="shellClass">
    <!-- ★ Dock 侧栏:56px 图标条,悬停展开;聊天页收起 -->
    <aside class="dock" @mouseenter="dockOpen = true" @mouseleave="dockOpen = false">
      <!-- 昔涟头像位:图形化更换(hover 出现按钮);展开时显示完整名字 -->
      <div class="dock-avatar" :title="'昔涟'">
        <img v-if="portraitSrc" :src="portraitSrc" class="avatar-img" alt="昔涟" />
        <span v-else class="avatar-orb"><Sparkle :size="15" stroke-width="2" /></span>
        <button class="avatar-edit" :disabled="portraitBusy" @click.prevent="pickPortrait">
          {{ portraitBusy ? '…' : '换图' }}
        </button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden-input" @change="onPortraitFile" />
        <span v-if="dockOpen" class="avatar-name">昔涟</span>
      </div>

      <div class="dock-divider"></div>

      <nav class="dock-nav">
        <RouterLink
          v-for="m in modules"
          :key="m.id"
          :to="m.path"
          class="dock-item"
          active-class="active"
          :title="m.title"
        >
          <component :is="m.icon" :size="18" stroke-width="1.8" class="dock-icon" />
          <span class="dock-label">{{ dockOpen ? m.title : '' }}</span>
        </RouterLink>
      </nav>

      <div class="dock-foot">
        <span class="conn-dot" :class="online ? 'up' : 'down'" :title="online ? '服务在线' : '服务离线'"></span>
      </div>
    </aside>

    <!-- 顶栏:Cyrene 式胶囊元信息 + 手动拖窗 -->
    <header
      class="topbar"
      @pointerdown="onTopbarDown"
      @pointermove="onTopbarMove"
      @pointerup="onTopbarUp"
      @pointerleave="onTopbarUp"
    >
      <div class="title-capsule">
        <span class="capsule-name">昔涟</span>
        <span class="capsule-sep"></span>
        <span class="capsule-state" :class="online ? 'up' : 'down'">{{ online ? '在线' : '离线' }}</span>
        <template v-if="app.intimacy !== null">
          <span class="capsule-sep"></span>
          <span class="capsule-intimacy"><Heart :size="11" stroke-width="2" /> {{ app.intimacy }}</span>
        </template>
        <template v-if="app.activeRole">
          <span class="capsule-sep"></span>
          <span class="capsule-role"><Clapperboard :size="11" stroke-width="2" /> {{ app.activeRole }}</span>
        </template>
      </div>
      <div class="topbar-right">
        <select v-model="app.theme" class="theme-select" @change="app.setTheme(app.theme)">
          <option v-for="t in THEMES" :key="t" :value="t">
            {{ { stardust: '星穹', dawn: '晨光', midnight: '午夜' }[t] }}
          </option>
        </select>
        <!-- ★ 自定义标题栏窗口按钮(Electron 渲染层经 preload IPC) -->
        <div class="win-btns">
          <button class="win-btn" title="最小化" @click="winMinimize">
            <Minus :size="14" stroke-width="2" />
          </button>
          <button class="win-btn close" title="关闭" @click="winClose">
            <X :size="14" stroke-width="2" />
          </button>
        </div>
      </div>
    </header>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 56px 1fr;
  grid-template-rows: 58px 1fr;
  grid-template-areas: 'dock topbar' 'dock content';
  height: 100vh;
  position: relative;
  z-index: 1;
  transition: grid-template-columns var(--aw-dur) var(--aw-ease);
}
.shell.dock-open { grid-template-columns: 190px 1fr; }
/* 聊天页沉浸:Dock 收起 */

/* ── Dock ── */
.dock {
  grid-area: dock;
  background: var(--aw-bg-raised);
  border-right: 1px solid var(--aw-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 0;
  overflow: hidden;
  white-space: nowrap;
  transition: opacity var(--aw-dur) var(--aw-ease);
}
.dock-avatar {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  height: 40px;
  padding: 0 4px;
}
.dock-avatar .avatar-img, .dock-avatar .avatar-orb {
  width: 40px; height: 40px; flex: 0 0 40px;
  border-radius: 50%;
}
.avatar-img { object-fit: cover; display: block; }
.avatar-orb { display: grid; place-items: center; }
.avatar-name {
  font-weight: 600; font-size: var(--aw-fs-md);
  letter-spacing: var(--aw-letter-spacing);
  color: var(--aw-text-strong);
  text-shadow: 0 0 16px rgba(236, 72, 153, 0.35);
  white-space: nowrap;
}
.avatar-edit {
  position: absolute; left: 4px; top: 0;
  width: 40px; height: 40px;
  display: grid; place-items: center;
  font-size: 10px; font-weight: 700;
  background: rgba(8, 10, 12, 0.62);
  color: var(--aw-pink-2);
  border: none; border-radius: 50%;
  opacity: 0;
  transition: opacity var(--aw-dur) var(--aw-ease);
}
.dock-avatar:hover .avatar-edit { opacity: 1; }
.hidden-input { display: none; }

.dock-divider {
  width: 28px; height: 1px;
  background: var(--aw-border);
  margin: 14px 0;
  flex: 0 0 1px;
}

.dock-nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.dock-item {
  position: relative;
  width: 40px; height: 40px; flex: 0 0 40px;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  border-radius: var(--aw-radius-md);
  color: var(--aw-text-dim);
  transition: all var(--aw-dur) var(--aw-ease);
}
.dock-item:hover { background: var(--aw-bg-hover); color: var(--aw-text); text-decoration: none; }
.dock-item.active {
  background: var(--aw-bg-active);
  color: var(--aw-pink-2);
  box-shadow: var(--aw-glow-soft);
}
.dock-item.active::before {
  content: '';
  position: absolute; left: -8px; top: 28%; bottom: 28%; width: 2px;
  border-radius: 1px;
  background: var(--aw-grad-brand);
}
.dock-icon { flex: 0 0 18px; }
.dock-label { flex: 1; text-align: left; overflow: hidden; }

.dock-foot { margin-top: auto; }
.conn-dot { display: block; width: 8px; height: 8px; border-radius: 50%; margin: 0 auto; }
.conn-dot.up { background: var(--aw-success); }
.conn-dot.down { background: var(--aw-danger); }

/* ── 顶栏(Cyrene 式胶囊)── */
.topbar {
  grid-area: topbar;
  display: flex; align-items: center; gap: 12px;
  padding: 0 18px 0 22px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.015));
  border-bottom: 1px solid var(--aw-border);
  user-select: none;
  cursor: grab; /* 拖拽手感提示 */
}
.topbar:active { cursor: grabbing; }
.title-capsule {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 14px;
  border-radius: var(--aw-radius-full);
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--aw-border-strong);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), var(--aw-glow-soft);
  white-space: nowrap;
}
.capsule-name {
  font-weight: 600; font-size: var(--aw-fs-md);
  letter-spacing: var(--aw-letter-spacing);
  color: var(--aw-text-strong);
  text-shadow: 0 0 16px rgba(236, 72, 153, 0.35); /* Cyrene 名字发光 */
}
.capsule-sep { width: 1px; height: 12px; background: var(--aw-border-strong); }
.capsule-state { font-size: var(--aw-fs-xs); color: var(--aw-text-dim); }
.capsule-state.up { color: var(--aw-success); }
.capsule-state.down { color: var(--aw-danger); }
.capsule-intimacy, .capsule-role {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--aw-fs-xs); color: var(--aw-text-dim);
}
.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.theme-select {
  background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 4px 10px; font-size: var(--aw-fs-sm); font-family: inherit;
}
/* 自定义标题栏窗口按钮(Cyrene 式) */
.win-btns { display: flex; gap: 2px; }
.win-btn {
  width: 34px; height: 28px;
  display: grid; place-items: center;
  background: none; border: none; border-radius: 6px;
  color: var(--aw-text-dim);
  transition: all var(--aw-dur) var(--aw-ease);
}
.win-btn:hover { background: var(--aw-bg-hover); color: var(--aw-text); }
.win-btn.close:hover { background: rgba(248, 113, 113, 0.16); color: var(--aw-danger); }

.content {
  grid-area: content;
  position: relative; /* 聊天视图 absolute 填充锚点 */
  overflow-y: auto;
  padding: 24px 28px;
}
</style>
