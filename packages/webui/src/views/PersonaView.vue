<script setup lang="ts">
import { reactive } from 'vue';
import { personaApi } from '../api/modules';
import { useAsync, SectionCard } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await personaApi.get()) as any);
const toast = reactive({ text: '', show: false });
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function notice(text: string) {
  toast.text = text;
  toast.show = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.show = false; }, 2500);
}

async function adjust(param: string, delta: number) {
  const r = (await personaApi.adjust(param, delta, 'WebUI 手动调整')) as any;
  if (r.applied) {
    notice(`已调整 ${param} → ${r.newValue ?? ''}`);
    reload();
  } else {
    notice(`调整被护栏拦截: ${r.reason ?? '未知'}`);
  }
}

const knobMeta: Array<{ key: string; label: string; desc: string }> = [
  { key: 'decay_rate', label: '遗忘速度', desc: '0=不忘, 1=秒忘' },
  { key: 'importance_threshold', label: '重要阈值', desc: '0=什么都记, 1=只记大事' },
  { key: 'recency_weight', label: '近期权重', desc: '0=念旧, 1=只认最近' },
  { key: 'confirmation_bias', label: '固执度', desc: '0=随风倒, 1=从不改变看法' },
  { key: 'retention_bias', label: '正负偏向', desc: '-1=只记坏, +1=只记好' },
];
</script>

<template>
  <div class="page">
    <SectionCard title="人格参数" icon="🌙" hint="3 维度 × 4 参数,5 道护栏保护">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <template v-else-if="data">
        <div class="grid">
          <div v-for="(group, gk) in ({ tone: data.tone, speechStyle: data.speechStyle, emotionalRange: data.emotionalRange } as Record<string, Record<string, number>>)" :key="gk" class="dim-card">
            <h4 class="dim-title">{{ { tone: '语气 tone', speechStyle: '说话风格', emotionalRange: '情感幅度' }[gk] }}</h4>
            <div v-for="(v, pk) in group" :key="pk" class="param-row">
              <span class="param-name">{{ pk }}</span>
              <div class="param-bar"><div class="param-fill" :style="{ width: `${Math.max(4, Math.min(100, (v + 1) * 50))}%` }"></div></div>
              <span class="param-val">{{ v.toFixed(2) }}</span>
              <button class="mini" @click="adjust(`${gk}.${pk}`, -0.05)">−</button>
              <button class="mini" @click="adjust(`${gk}.${pk}`, 0.05)">+</button>
            </div>
          </div>
        </div>
      </template>
    </SectionCard>

    <SectionCard title="记忆旋钮" icon="🎛️" hint="实时调节她'怎么记'">
      <div v-if="data?.memoryConfig" class="knobs">
        <div v-for="k in knobMeta" :key="k.key" class="knob-row">
          <div class="knob-info">
            <span class="knob-label">{{ k.label }}</span>
            <span class="knob-desc">{{ k.desc }}</span>
          </div>
          <input
            type="range" min="0" max="1" step="0.05"
            :value="data.memoryConfig[k.key] ?? 0"
            @change="async (e) => { await adjust(`memoryConfig.${k.key}`, Number((e.target as HTMLInputElement).value) - (data.memoryConfig[k.key] ?? 0)); }"
          />
          <span class="knob-val">{{ (data.memoryConfig[k.key] ?? 0).toFixed(2) }}</span>
        </div>
      </div>
    </SectionCard>

    <transition name="fade">
      <div v-if="toast.show" class="toast">{{ toast.text }}</div>
    </transition>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 20px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.dim-card { background: var(--aw-bg-input); border: 1px solid var(--aw-border); border-radius: var(--aw-radius-md); padding: 14px; }
.dim-title { font-size: var(--aw-fs-md); margin-bottom: 10px; color: var(--aw-gold); }
.param-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: var(--aw-fs-sm); }
.param-name { width: 84px; color: var(--aw-text-dim); font-size: var(--aw-fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.param-bar { flex: 1; height: 6px; background: var(--aw-bg-card); border-radius: 3px; overflow: hidden; }
.param-fill { height: 100%; background: var(--aw-grad-brand); border-radius: 3px; transition: width var(--aw-dur) var(--aw-ease); }
.param-val { width: 42px; text-align: right; color: var(--aw-text-faint); font-size: var(--aw-fs-xs); font-family: var(--aw-font-code); }
.mini { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); font-size: 13px; line-height: 1; }
.mini:hover { color: var(--aw-accent); border-color: var(--aw-accent); }
.knobs { display: flex; flex-direction: column; gap: 14px; }
.knob-row { display: flex; align-items: center; gap: 14px; }
.knob-info { width: 200px; }
.knob-label { font-size: var(--aw-fs-md); color: var(--aw-text); }
.knob-desc { display: block; font-size: var(--aw-fs-xs); color: var(--aw-text-faint); }
.knob-row input[type='range'] { flex: 1; accent-color: var(--aw-gold); }
.knob-val { width: 40px; text-align: right; font-family: var(--aw-font-code); color: var(--aw-text-dim); font-size: var(--aw-fs-sm); }
.toast {
  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
  background: var(--aw-bg-raised); border: 1px solid var(--aw-border-gold);
  color: var(--aw-gold); padding: 10px 20px; border-radius: var(--aw-radius-full);
  box-shadow: var(--aw-shadow-glow); font-size: var(--aw-fs-sm); z-index: 100;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
