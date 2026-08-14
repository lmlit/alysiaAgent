/** 全局应用状态:连接状态/主题/活跃角色/亲密度 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { sysApi } from '../api/modules';

const THEME_KEY = 'aw-theme';
export const THEMES = ['stardust', 'dawn', 'midnight'] as const;
export type ThemeName = (typeof THEMES)[number];

export const useAppStore = defineStore('app', () => {
  const connected = ref(false);
  const theme = ref<ThemeName>((localStorage.getItem(THEME_KEY) as ThemeName) || 'stardust');
  const activeRole = ref('');
  const intimacy = ref<number | null>(null);
  const lastHeartbeat = ref(0);

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme.value);
    localStorage.setItem(THEME_KEY, theme.value);
  }
  applyTheme();

  function setTheme(t: ThemeName) {
    theme.value = t;
    applyTheme();
  }

  async function ping(): Promise<boolean> {
    try {
      const h = await sysApi.health();
      connected.value = h.status === 'ok';
    } catch {
      connected.value = false;
    }
    return connected.value;
  }

  /** 顶部徽章数据(角色/亲密度)——失败静默(非关键路径) */
  async function refreshMeta() {
    try {
      const roles = await import('../api/modules').then(m => m.rolesApi.list());
      activeRole.value = roles.activeRole ?? '';
      const life = await import('../api/modules').then(m => m.lifeApi.snapshot());
      intimacy.value = life.snapshot?.intimacy ?? null;
      lastHeartbeat.value = Date.now();
    } catch { /* 服务未起时静默 */ }
  }

  return { connected, theme, activeRole, intimacy, lastHeartbeat, setTheme, ping, refreshMeta };
});
