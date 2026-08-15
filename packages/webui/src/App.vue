<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useAppStore, THEMES } from './stores/app';
import { modules } from './modules';
import { Heart, Sparkle, Clapperboard } from 'lucide-vue-next';

const app = useAppStore();
const online = ref(false);

let pingTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
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
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-orb"><Sparkle :size="16" stroke-width="2.2" /></span>
        <span class="brand-name">ALYSIA</span>
      </div>
      <nav class="nav">
        <RouterLink
          v-for="m in modules"
          :key="m.id"
          :to="m.path"
          class="nav-item"
          active-class="active"
        >
          <component :is="m.icon" :size="16" stroke-width="1.8" class="nav-icon" />
          <span>{{ m.title }}</span>
        </RouterLink>
      </nav>
      <div class="sidebar-foot">
        <div class="conn" :class="online ? 'up' : 'down'">
          <span class="dot"></span>{{ online ? '服务在线' : '服务离线' }}
        </div>
      </div>
    </aside>

    <header class="topbar">
      <div class="topbar-title">
        <RouterLink to="/chat" class="topbar-link">昔涟</RouterLink>
      </div>
      <div class="topbar-right">
        <span v-if="app.intimacy !== null" class="pill" :title="'亲密度'">
          <Heart :size="11" stroke-width="2" class="heart" /> {{ app.intimacy }}
        </span>
        <span v-if="app.activeRole" class="pill" :title="'激活角色'">
          <Clapperboard :size="11" stroke-width="2" /> {{ app.activeRole }}
        </span>
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
  grid-template-columns: var(--aw-sidebar-w) 1fr;
  grid-template-rows: var(--aw-topbar-h) 1fr;
  grid-template-areas: 'sidebar topbar' 'sidebar content';
  height: 100vh;
  position: relative;
  z-index: 1;
}

.sidebar {
  grid-area: sidebar;
  background: var(--aw-bg-raised);
  border-right: 1px solid var(--aw-border);
  display: flex;
  flex-direction: column;
  padding: 16px 10px;
}

.brand {
  display: flex; align-items: center; gap: 10px;
  padding: 4px 10px 18px;
  border-bottom: 1px solid var(--aw-border);
  margin-bottom: 12px;
}
.brand-orb {
  width: 30px; height: 30px; border-radius: 50%;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--aw-gold-2), var(--aw-gold));
  color: var(--aw-text-invert);
  font-size: 14px;
}
.brand-name {
  font-weight: 800; letter-spacing: 0.14em; font-size: 15px;
  color: var(--aw-gold-2);
}

.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; padding-top: 4px; }
.nav-item {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: var(--aw-radius-md);
  color: var(--aw-text-dim); font-size: var(--aw-fs-md);
  transition: all var(--aw-dur) var(--aw-ease);
}
.nav-item:hover { background: var(--aw-bg-hover); color: var(--aw-text); text-decoration: none; }
.nav-item.active {
  background: var(--aw-bg-active);
  color: var(--aw-gold);
}
.nav-item.active::before {
  content: '';
  position: absolute; left: -10px; top: 22%; bottom: 22%; width: 2px;
  border-radius: 1px;
  background: var(--aw-gold);
}
.nav-icon { width: 18px; flex: 0 0 18px; }
.nav-item.active .nav-icon { color: var(--aw-gold); }

.sidebar-foot { padding-top: 12px; border-top: 1px solid var(--aw-border); }
.conn { display: flex; align-items: center; gap: 8px; font-size: var(--aw-fs-sm); color: var(--aw-text-faint); padding: 0 10px; }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; }
.conn.up .dot { background: var(--aw-success); box-shadow: 0 0 8px var(--aw-success); }
.conn.down .dot { background: var(--aw-danger); box-shadow: 0 0 8px var(--aw-danger); }

.topbar {
  grid-area: topbar;
  display: flex; align-items: center; gap: 12px;
  padding: 0 20px;
  background: var(--aw-bg-raised);
  border-bottom: 1px solid var(--aw-border);
  backdrop-filter: blur(10px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); /* 内顶高光 */
}
.topbar-title { font-size: var(--aw-fs-lg); font-weight: 700; }
.topbar-link { color: var(--aw-text); }
.topbar-link:hover { color: var(--aw-gold); text-decoration: none; }
.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

.pill {
  font-size: var(--aw-fs-xs); padding: 4px 10px; border-radius: var(--aw-radius-full);
  background: var(--aw-bg-card); border: 1px solid var(--aw-border);
  color: var(--aw-text-dim);
}

.theme-select {
  background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 5px 10px; font-size: var(--aw-fs-sm); font-family: inherit;
}

.content {
  grid-area: content;
  overflow-y: auto;
  padding: 24px 28px;
}
</style>
