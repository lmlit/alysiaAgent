<script setup lang="ts">
import { ref } from 'vue';
import { lifeApi } from '../api/modules';
import { LayoutGrid, Plus } from 'lucide-vue-next';
import { useAsync, SectionCard, LoadingBlock, Table, EmptyState, Tag, ConfirmButton } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await lifeApi.templates()) as any);

// ★ 手动新增模板(weight 固定 2,走 LLM 校验)
const activity = ref('');
const type = ref<'internal' | 'chat'>('internal');
const addMsg = ref('');
const addBusy = ref(false);

async function add() {
  if (!activity.value.trim()) return;
  addBusy.value = true;
  addMsg.value = '';
  try {
    const r = (await lifeApi.addTemplate(activity.value.trim(), type.value)) as any;
    addMsg.value = r.ok ? `已加入模板池:${activity.value.trim()}` : `未加入:${r.reason ?? '未知原因'}`;
    if (r.ok) {
      activity.value = '';
      reload();
    }
  } catch (e: unknown) {
    addMsg.value = `添加失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    addBusy.value = false;
  }
}

async function remove(id: string) {
  await lifeApi.removeTemplate(id);
  reload();
}
</script>

<template>
  <div class="page">
    <SectionCard title="生活模板池" :icon="LayoutGrid" hint="LLM 事件生成失败时的兜底活动;self = 昔涟自己发明的日常">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <LoadingBlock v-if="loading" />
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

    <SectionCard title="新增模板" :icon="Plus" hint="手动加一个日常活动(weight 固定 2;模糊内容会被 LLM 校验拒掉)">
      <div class="add-row">
        <input v-model="activity" class="add-input" placeholder="活动描述,如:对着窗台的多肉发呆" @keydown.enter="add" />
        <select v-model="type" class="add-select">
          <option value="internal">独处(不推送)</option>
          <option value="chat">分享(可推送)</option>
        </select>
        <button class="btn primary" :disabled="addBusy || !activity.trim()" @click="add">
          {{ addBusy ? '添加中…' : '添加' }}
        </button>
      </div>
      <div v-if="addMsg" class="add-msg">{{ addMsg }}</div>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 800px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.add-row { display: flex; gap: 10px; align-items: center; }
.add-input {
  flex: 1; background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 8px 12px; font-size: var(--aw-fs-md); font-family: inherit;
}
.add-input:focus { outline: none; border-color: var(--aw-border-gold); }
.add-select {
  background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 8px 10px; font-size: var(--aw-fs-sm); font-family: inherit;
}
.btn { font-size: var(--aw-fs-sm); padding: 8px 16px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover:not(:disabled) { color: var(--aw-text); border-color: var(--aw-border-strong); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.primary { color: var(--aw-gold); border-color: var(--aw-border-gold); background: rgba(232, 196, 106, 0.1); }
.add-msg { margin-top: 10px; font-size: var(--aw-fs-sm); color: var(--aw-text-dim); }
</style>
