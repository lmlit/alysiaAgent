<script setup lang="ts">
import { stickersApi } from '../api/modules';
import { useAsync, SectionCard, EmptyState } from '../components/common';

const { data, loading, reload } = useAsync(async () => (await stickersApi.list()) as any);
</script>

<template>
  <div class="page">
    <SectionCard title="表情包" icon="😊" hint="她在文案里写 [表情包:名字] 时会发送对应图片">
      <template #actions><button class="btn" @click="reload">刷新</button></template>
      <div v-if="loading" class="hint">加载中…</div>
      <EmptyState v-else-if="data && !data.stickers?.length" text="还没有表情包" />
      <div v-else-if="data" class="grid">
        <div v-for="s in data.stickers" :key="s.name" class="sticker-card">
          <img v-if="s.path" :src="`/api/stickers/file/${encodeURIComponent(s.name)}`" class="sticker-img" :alt="s.name" loading="lazy" />
          <div class="sticker-name">[表情包:{{ s.name }}]</div>
        </div>
      </div>
    </SectionCard>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.btn { font-size: var(--aw-fs-sm); padding: 5px 12px; border-radius: var(--aw-radius-sm); border: 1px solid var(--aw-border); background: var(--aw-bg-input); color: var(--aw-text-dim); }
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.hint { color: var(--aw-text-faint); padding: 12px 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 14px; }
.sticker-card { text-align: center; padding: 12px; background: var(--aw-bg-input); border: 1px solid var(--aw-border); border-radius: var(--aw-radius-md); }
.sticker-img { width: 72px; height: 72px; object-fit: contain; }
.sticker-name { margin-top: 8px; font-size: var(--aw-fs-xs); color: var(--aw-text-faint); word-break: break-all; }
</style>
