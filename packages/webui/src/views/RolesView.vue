<script setup lang="ts">
import { ref } from 'vue';
import { rolesApi } from '../api/modules';
import { useAsync, SectionCard, Table, Tag, EmptyState } from '../components/common';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const { data, loading, reload } = useAsync(async () => (await rolesApi.list()) as any);
const importText = ref('');
const importMsg = ref('');
const importBusy = ref(false);

async function doSwitch(roleId: string) {
  await rolesApi.switch(roleId);
  reload();
  app.refreshMeta();
}

async function doImport() {
  importBusy.value = true;
  importMsg.value = '';
  try {
    const pkg = JSON.parse(importText.value);
    const r = (await rolesApi.import(pkg)) as any;
    importMsg.value = r?.role ? `导入成功: ${r.role} (${r.worldbookCount} 条世界书)` : `导入结果: ${JSON.stringify(r)}`;
    importText.value = '';
    reload();
    app.refreshMeta();
  } catch (e: unknown) {
    importMsg.value = `导入失败: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    importBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <SectionCard title="角色" icon="🎭" hint="角色包 = 人格参数 + 系统提示 + 世界书">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <EmptyState v-else-if="data && !data.roles?.length" text="还没有角色" />
      <Table
        v-else-if="data"
        :rows="(data.roles as Record<string, unknown>[]) ?? []"
        :columns="[{ key: 'name', label: '名称' }, { key: 'role', label: 'ID' }, { key: 'worldbookCount', label: '世界书', width: '70px' }, { key: 'state', label: '状态', width: '80px' }, { key: 'op', label: '', width: '90px' }]"
      >
        <template #state="{ row }">
          <Tag :tone="row.isActive ? 'gold' : 'default'">{{ row.isActive ? '激活' : '休眠' }}</Tag>
        </template>
        <template #op="{ row }">
          <button v-if="!row.isActive" class="btn" @click="doSwitch(row.role as string)">切换</button>
        </template>
      </Table>
    </SectionCard>

    <SectionCard title="导入角色包" icon="📥">
      <textarea v-model="importText" class="import-ta" placeholder="粘贴角色包 JSON…" rows="6"></textarea>
      <div class="import-row">
        <button class="btn primary" :disabled="importBusy || !importText.trim()" @click="doImport">
          {{ importBusy ? '导入中…' : '导入' }}
        </button>
        <span v-if="importMsg" class="import-msg">{{ importMsg }}</span>
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
.import-ta {
  width: 100%; background: var(--aw-bg-input); color: var(--aw-text);
  border: 1px solid var(--aw-border); border-radius: var(--aw-radius-sm);
  padding: 10px; font-family: var(--aw-font-code); font-size: 12px;
  resize: vertical;
}
.import-row { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.import-msg { font-size: var(--aw-fs-sm); color: var(--aw-text-dim); }
</style>
