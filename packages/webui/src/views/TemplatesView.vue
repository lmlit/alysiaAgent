<script setup lang="ts">
import { lifeApi } from '../api/modules';
import { useAsync, SectionCard, Table, EmptyState, Tag, ConfirmButton } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await lifeApi.templates()) as any);

async function remove(id: string) {
  await lifeApi.removeTemplate(id);
  reload();
}
</script>

<template>
  <div class="page">
    <SectionCard title="生活模板池" icon="🧩" hint="LLM 事件生成失败时的兜底活动;self = 昔涟自己发明的日常">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <EmptyState v-else-if="data && !data.templates?.length" text="模板池是空的" />
      <Table
        v-else-if="data"
        :rows="(data.templates as Record<string, unknown>[]) ?? []"
        :columns="[{ key: 'activity', label: '活动' }, { key: 'type', label: '类型', width: '70px' }, { key: 'weight', label: '权重', width: '60px' }, { key: 'source', label: '来源', width: '80px' }, { key: 'op', label: '', width: '80px' }]"
      >
        <template #type="{ row }">
          <Tag :tone="row.type === 'chat' ? 'gold' : 'default'">{{ row.type === 'chat' ? '推送' : '独处' }}</Tag>
        </template>
        <template #source="{ row }">
          <Tag :tone="row.source === 'self' ? 'cyan' : 'default'">{{ row.source === 'self' ? '✨自写' : 'seed' }}</Tag>
        </template>
        <template #op="{ row }">
          <ConfirmButton label="删" confirmText="确认删除?" danger :on-confirm="() => remove(row.id as string)" />
        </template>
      </Table>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 800px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
</style>
