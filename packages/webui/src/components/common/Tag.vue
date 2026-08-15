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
.gold { color: var(--aw-gold-2); border-color: var(--aw-border-gold); background: var(--aw-bg-active); }
.cyan { color: var(--aw-text); border-color: var(--aw-border-strong); background: var(--aw-bg-hover); }
.rose { color: var(--aw-danger); border-color: rgba(217, 116, 111, 0.35); background: rgba(217, 116, 111, 0.07); }
</style>
