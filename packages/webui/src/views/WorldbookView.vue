<script setup lang="ts">
import { worldbookApi } from '../api/modules';
import { BookOpen } from 'lucide-vue-next';
import { useAsync, SectionCard, Table, EmptyState, Tag, ConfirmButton } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await worldbookApi.list()) as any);

async function remove(id: string) {
  await worldbookApi.remove(id);
  reload();
}

function fmt(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="page">
    <SectionCard title="世界书条目" :icon="BookOpen" hint="source=self 为昔涟自写(自进化审计面);删错可凭日志找回">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <EmptyState v-else-if="data && !data.entries?.length" text="世界书是空的" />
      <Table
        v-else-if="data"
        :rows="(data.entries as Record<string, unknown>[]) ?? []"
        :columns="[{ key: 'triggerKeys', label: '触发词', width: '130px' }, { key: 'content', label: '内容' }, { key: 'source', label: '来源', width: '80px' }, { key: 'createdAt', label: '写入时间', width: '130px' }, { key: 'op', label: '', width: '80px' }]"
      >
        <template #triggerKeys="{ row }">
          <span v-for="k in row.triggerKeys" :key="k" class="kw">{{ k }}</span>
        </template>
        <template #source="{ row }">
          <Tag :tone="row.source === 'self' ? 'cyan' : 'default'">{{ row.source === 'self' ? '✨自写' : 'seed' }}</Tag>
        </template>
        <template #createdAt="{ row }">{{ fmt(row.createdAt as string) }}</template>
        <template #op="{ row }">
          <ConfirmButton label="删" confirmText="确认删除?" danger :on-confirm="() => remove(row.id as string)" />
        </template>
      </Table>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 1000px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.kw { display: inline-block; font-size: var(--aw-fs-xs); padding: 2px 7px; margin: 1px 3px 1px 0; border-radius: 6px; background: rgba(232, 196, 106, 0.1); border: 1px solid rgba(232, 196, 106, 0.25); color: var(--aw-gold); }
</style>
