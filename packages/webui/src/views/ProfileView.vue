<script setup lang="ts">
import { profileApi } from '../api/modules';
import { User } from 'lucide-vue-next';
import { useAsync, SectionCard, JsonView, EmptyState } from '../components/common';

const { data, loading, error, reload } = useAsync(async () => (await profileApi.get()) as Record<string, unknown>);
</script>

<template>
  <div class="page">
    <SectionCard title="用户画像" :icon="User" hint="ProfileStore — 用户事实带来源与置信度">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <div v-else-if="error" class="hint err">{{ error }}</div>
      <JsonView v-else :value="data" />
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.hint.err { color: var(--aw-danger); }
</style>
