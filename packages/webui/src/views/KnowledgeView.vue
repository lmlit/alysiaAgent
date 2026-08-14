<script setup lang="ts">
import { ref } from 'vue';
import { knowledgeApi } from '../api/modules';
import { Library, Upload } from 'lucide-vue-next';
import { useAsync, SectionCard, Table, Tag, EmptyState, ConfirmButton } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await knowledgeApi.list()) as any);
const title = ref('');
const content = ref('');
const msg = ref('');
const busy = ref(false);

async function doImport() {
  if (!title.value.trim() || !content.value.trim()) return;
  busy.value = true;
  msg.value = '';
  try {
    const r = (await knowledgeApi.importDoc({ title: title.value.trim(), content: content.value })) as any;
    msg.value = r.deduplicated ? '内容重复,已跳过' : `导入成功: ${r.chunks ?? '?'} 个分块`;
    title.value = '';
    content.value = '';
    reload();
  } catch (e: unknown) {
    msg.value = `导入失败: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

async function remove(id: string) {
  await knowledgeApi.remove(id);
  reload();
}

function fmt(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="page">
    <SectionCard title="知识库" :icon="Library" hint="RAG:去重 → 分块(500/50) → 向量检索">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <EmptyState v-else-if="data && !data.docs?.length" text="还没有知识文档" />
      <Table
        v-else-if="data"
        :rows="(data.docs as Record<string, unknown>[]) ?? []"
        :columns="[{ key: 'title', label: '标题' }, { key: 'chunkCount', label: '分块', width: '60px' }, { key: 'source', label: '来源', width: '90px' }, { key: 'createdAt', label: '导入时间', width: '130px' }, { key: 'op', label: '', width: '80px' }]"
      >
        <template #source="{ row }">
          <Tag>{{ row.source || 'manual' }}</Tag>
        </template>
        <template #createdAt="{ row }">{{ fmt(row.createdAt as string) }}</template>
        <template #op="{ row }">
          <ConfirmButton label="删" confirmText="确认删除?" danger :on-confirm="() => remove(row.id as string)" />
        </template>
      </Table>
    </SectionCard>

    <SectionCard title="导入知识" :icon="Upload">
      <input v-model="title" class="input" placeholder="标题" />
      <textarea v-model="content" class="import-ta" placeholder="文档内容…" rows="6"></textarea>
      <div class="import-row">
        <button class="btn primary" :disabled="busy || !title.trim() || !content.trim()" @click="doImport">
          {{ busy ? '导入中…' : '导入' }}
        </button>
        <span v-if="msg" class="import-msg">{{ msg }}</span>
      </div>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.btn.primary { color: var(--aw-gold); border-color: var(--aw-border-gold); background: rgba(232, 196, 106, 0.1); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.input {
  width: 100%; background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 8px 12px; margin-bottom: 10px; font-size: var(--aw-fs-md); font-family: inherit;
}
.import-ta {
  width: 100%; background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 10px; font-family: var(--aw-font-code); font-size: 12px; resize: vertical;
}
.import-row { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.import-msg { font-size: var(--aw-fs-sm); color: var(--aw-text-dim); }
</style>
