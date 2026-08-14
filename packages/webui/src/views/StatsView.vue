<script setup lang="ts">
import { statsApi } from '../api/modules';
import { useAsync, SectionCard, Table, EmptyState } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await statsApi.get()) as any);

function rowsOf(): Array<Record<string, unknown>> {
  if (!data.value?.perSession) return [];
  return Object.entries(data.value.perSession as Record<string, any>).map(([sid, s]) => ({
    sessionId: sid,
    tokens: s.totalTokens ?? s.tokens ?? 0,
    input: s.totalInput ?? 0,
    output: s.totalOutput ?? 0,
    messageCount: s.messageCount ?? 0,
  }));
}
</script>

<template>
  <div class="page">
    <SectionCard title="Token 统计" icon="📊">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <template v-else-if="data">
        <div class="stats">
          <div class="stat"><div class="stat-num">{{ data.global?.tokens ?? 0 }}</div><div class="stat-lbl">总用量</div></div>
          <div class="stat"><div class="stat-num">{{ data.global?.input ?? 0 }}</div><div class="stat-lbl">输入</div></div>
          <div class="stat"><div class="stat-num">{{ data.global?.output ?? 0 }}</div><div class="stat-lbl">输出</div></div>
        </div>
        <EmptyState v-if="!rowsOf().length" text="暂无会话用量" />
        <Table
          v-else
          :rows="rowsOf()"
          :columns="[{ key: 'sessionId', label: '会话' }, { key: 'tokens', label: 'Token', width: '90px' }, { key: 'input', label: '输入', width: '80px' }, { key: 'output', label: '输出', width: '80px' }, { key: 'messageCount', label: '消息', width: '60px' }]"
        />
      </template>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { background: var(--aw-bg-input); border: 1px solid var(--aw-border); border-radius: var(--aw-radius-md); padding: 16px; text-align: center; }
.stat-num { font-size: 26px; font-weight: 800; background: var(--aw-grad-brand); -webkit-background-clip: text; background-clip: text; color: transparent; font-family: var(--aw-font-code); }
.stat-lbl { margin-top: 4px; font-size: var(--aw-fs-xs); color: var(--aw-text-faint); }
</style>
