<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ value: unknown; collapsed?: boolean }>();
const open = ref(!props.collapsed);

const text = computed(() => {
  try {
    return JSON.stringify(props.value, null, 2);
  } catch {
    return String(props.value);
  }
});
</script>

<template>
  <div class="json">
    <button class="json-toggle" @click="open = !open">{{ open ? '▾' : '▸' }} JSON</button>
    <pre v-if="open" class="json-pre">{{ text }}</pre>
  </div>
</template>

<style scoped>
.json { margin-top: 8px; }
.json-toggle {
  font-size: var(--aw-fs-xs); color: var(--aw-text-faint);
  background: none; border: none; padding: 2px 0;
}
.json-toggle:hover { color: var(--aw-accent); }
.json-pre {
  font-family: var(--aw-font-code); font-size: 12px;
  background: var(--aw-bg-input); border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-sm); padding: 10px;
  overflow-x: auto; color: var(--aw-text-dim); line-height: 1.5;
  max-height: 320px; overflow-y: auto;
}
</style>
