<script setup lang="ts">
import { sessionApi } from '../api/modules';
import { useAsync, SectionCard, Table, EmptyState, Tag } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await sessionApi.list()) as any);

function fmt(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function isWebui(sid: string) {
  return sid.startsWith('webui:');
}
</script>

<template>
  <div class="page">
    <SectionCard title="会话" icon="🕘" hint="webui: 前缀为 WebUI 聊天会话,与 QQ 通道隔离">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <EmptyState v-else-if="data && !data.sessions?.length" text="还没有会话" />
      <Table
        v-else-if="data"
        :rows="(data.sessions as Record<string, unknown>[]) ?? []"
        :columns="[{ key: 'sessionId', label: '会话 ID' }, { key: 'kind', label: '通道', width: '80px' }, { key: 'messageCount', label: '消息数', width: '70px' }, { key: 'lastActive', label: '最近活跃', width: '130px' }]"
      >
        <template #kind="{ row }">
          <Tag :tone="isWebui(row.sessionId as string) ? 'cyan' : 'default'">{{ isWebui(row.sessionId as string) ? 'WebUI' : 'QQ' }}</Tag>
        </template>
        <template #lastActive="{ row }">{{ fmt(row.lastActive as string) }}</template>
      </Table>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
</style>
