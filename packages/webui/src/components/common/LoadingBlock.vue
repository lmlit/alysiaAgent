<script setup lang="ts">
withDefaults(defineProps<{ rows?: number }>(), { rows: 3 });
</script>

<template>
  <div class="skel" aria-busy="true" aria-label="加载中">
    <div v-for="i in rows" :key="i" class="skel-row" :style="{ width: `${88 - (i % 3) * 14}%` }"></div>
  </div>
</template>

<style scoped>
.skel { display: flex; flex-direction: column; gap: 10px; padding: 6px 0; }
.skel-row {
  height: 14px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--aw-bg-input) 25%, var(--aw-bg-hover) 50%, var(--aw-bg-input) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s var(--aw-ease) infinite;
}
@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
</style>
