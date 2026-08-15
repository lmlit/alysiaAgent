<script setup lang="ts">
/**
 * ★ 8-15 布局大改(webui-visual-redesign,方案 A:图标 Dock 侧栏)
 *  - Dock 侧栏 56px,悬停展开 190px 显示文字;顶部昔涟头像位(portrait.png,无则金 orb)
 *  - 顶栏:Cyrene 式玻璃胶囊元信息(「昔涟 · 状态 · 亲密度」)
 *  - 聊天页沉浸:Dock 自动收起,chat 视图占满全屏(自带会话列表)
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAppStore, THEMES } from './stores/app';
import { modules } from './modules';
import { Heart, Sparkle, Clapperboard } from 'lucide-vue-next';

const app = useAppStore();
const route = useRoute();
const online = ref(false);
const dockOpen = ref(false);
/** ★ 昔涟形象位:public/portrait.png(用户可放喜欢的图),存在则显示为头像 */
const portraitSrc = ref('');

// 聊天页沉浸:Dock 收起
const isChat = computed(() => route.path === '/chat');
const shellClass = computed(() => ({
  'dock-open': dockOpen.value && !isChat.value,
  'chat-immersive': isChat.value,
}));

let pingTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  fetch('/portrait.png', { method: 'HEAD' })
    .then(r => { if (r.ok) portraitSrc.value = '/portrait.png'; })
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
      <!-- 昔涟头像位:public/portrait.png(用户可替换),无则金 orb -->
      <RouterLink to="/chat" class="dock-avatar" :title="'昔涟'">
        <img v-if="portraitSrc" :src="portraitSrc" class="avatar-img" alt="昔涟" />
        <span v-else class="avatar-orb"><Sparkle :size="15" stroke-width="2" /></span>
        <span class="dock-label">{{ dockOpen ? '昔涟' : '' }}</span>
      </RouterLink>

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

    <!-- 顶栏:Cyrene 式胶囊元信息 -->
    <header class="topbar">
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
.shell.chat-immersive { grid-template-columns: 0px 1fr; }
.shell.chat-immersive .dock { opacity: 0; pointer-events: none; }

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
  width: 40px; height: 40px; flex: 0 0 40px;
  border-radius: 50%;
  display: grid; place-items: center;
  overflow: hidden;
  border: 1px solid var(--aw-border-gold);
  transition: all var(--aw-dur) var(--aw-ease);
}
.dock-avatar:hover { border-color: var(--aw-gold-2); }
.avatar-img { width: 100%; height: 100%; object-fit: cover; }
.avatar-orb {
  width: 100%; height: 100%;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--aw-gold-2), var(--aw-gold));
  color: var(--aw-text-invert);
}
.dock-label { font-size: var(--aw-fs-sm); color: var(--aw-text-dim); }

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
.dock-item.active { background: var(--aw-bg-active); color: var(--aw-gold-2); }
.dock-item.active::before {
  content: '';
  position: absolute; left: -8px; top: 28%; bottom: 28%; width: 2px;
  border-radius: 1px;
  background: var(--aw-gold);
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
  -webkit-app-region: drag; /* Electron 窗口可拖拽 */
  user-select: none;
}
.title-capsule {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 14px;
  border-radius: var(--aw-radius-full);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--aw-border);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  white-space: nowrap;
}
.capsule-name { font-weight: 700; font-size: var(--aw-fs-md); letter-spacing: 0.04em; color: var(--aw-gold-2); }
.capsule-sep { width: 1px; height: 12px; background: var(--aw-border-strong); }
.capsule-state { font-size: var(--aw-fs-xs); color: var(--aw-text-dim); }
.capsule-state.up { color: var(--aw-success); }
.capsule-state.down { color: var(--aw-danger); }
.capsule-intimacy, .capsule-role {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--aw-fs-xs); color: var(--aw-text-dim);
}
.topbar-right { margin-left: auto; -webkit-app-region: no-drag; }
.theme-select {
  background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 4px 10px; font-size: var(--aw-fs-sm); font-family: inherit;
}

.content {
  grid-area: content;
  position: relative; /* 聊天视图 absolute 填充锚点 */
  overflow-y: auto;
  padding: 24px 28px;
}
.chat-immersive .content { padding: 0; overflow: hidden; }
</style>
