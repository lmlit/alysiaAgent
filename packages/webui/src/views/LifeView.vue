<script setup lang="ts">
import { lifeApi } from '../api/modules';
import { useAsync, SectionCard, Table, EmptyState, Tag } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await lifeApi.snapshot()) as any);

function fmt(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="page">
    <SectionCard title="她现在" icon="🌸">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <template v-else-if="data">
        <div class="stats">
          <div class="stat"><div class="stat-num">{{ data.snapshot?.intimacy ?? '—' }}</div><div class="stat-lbl">亲密度</div></div>
          <div class="stat"><div class="stat-num emoji">{{ { 平静: '😌', 开心: '😊', 困: '😪', 低落: '😔' }[data.snapshot?.mood as string] ?? '🌸' }}</div><div class="stat-lbl">心情 · {{ data.snapshot?.mood || '未知' }}</div></div>
          <div class="stat wide"><div class="stat-num act">{{ data.snapshot?.currentActivity || '发呆中' }}</div><div class="stat-lbl">此刻在做什么</div></div>
        </div>
      </template>
    </SectionCard>

    <SectionCard title="近 7 天生活事件" icon="📜">
      <EmptyState v-if="data && !data.events?.length" text="还没有生活事件" />
      <Table
        v-else-if="data"
        :rows="(data.events as Record<string, unknown>[]) ?? []"
        :columns="[{ key: 'createdAt', label: '时间', width: '110px' }, { key: 'type', label: '类型', width: '80px' }, { key: 'content', label: '内容' }]"
      >
        <template #createdAt="{ row }">{{ fmt(row.createdAt as string) }}</template>
        <template #type="{ row }">
          <Tag :tone="row.type === 'chat' ? 'gold' : 'default'">{{ row.type === 'chat' ? '推送' : '独处' }}</Tag>
        </template>
        <template #content="{ row }">{{ row.content }}</template>
      </Table>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 20px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
.stat { background: var(--aw-bg-input); border: 1px solid var(--aw-border); border-radius: var(--aw-radius-md); padding: 18px; text-align: center; }
.stat.wide { grid-column: 1 / -1; }
.stat-num { font-size: 30px; font-weight: 800; background: var(--aw-grad-brand); -webkit-background-clip: text; background-clip: text; color: transparent; }
.stat-num.emoji { background: none; -webkit-background-clip: unset; color: var(--aw-text); font-size: 26px; }
.stat-num.act { font-size: 18px; }
.stat-lbl { margin-top: 6px; font-size: var(--aw-fs-xs); color: var(--aw-text-faint); }
</style>
