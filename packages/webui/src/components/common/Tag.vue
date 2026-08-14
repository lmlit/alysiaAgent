<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'default' | 'gold' | 'cyan' | 'rose' }>(), { tone: 'default' });
</script>

<template>
  <span class="tag" :class="tone"><slot /></span>
</template>

<style scoped>
.tag {
  display: inline-block;
  font-size: 11px; padding: 2px 8px; border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--aw-border);
  color: var(--aw-text-faint);
  white-space: nowrap;
}
.gold { color: var(--aw-gold); border-color: rgba(232, 196, 106, 0.3); background: rgba(232, 196, 106, 0.08); }
.cyan { color: var(--aw-cyan); border-color: rgba(103, 232, 249, 0.3); background: rgba(103, 232, 249, 0.06); }
.rose { color: var(--aw-rose); border-color: rgba(249, 168, 212, 0.3); background: rgba(249, 168, 212, 0.06); }
</style>
