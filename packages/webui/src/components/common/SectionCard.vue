<script setup lang="ts">
defineProps<{ title: string; icon?: string; hint?: string }>();
</script>

<template>
  <section class="card">
    <header class="card-head">
      <span v-if="icon" class="card-icon">{{ icon }}</span>
      <h3 class="card-title">{{ title }}</h3>
      <span v-if="hint" class="card-hint">{{ hint }}</span>
      <div class="card-actions"><slot name="actions" /></div>
    </header>
    <div class="card-body"><slot /></div>
  </section>
</template>

<style scoped>
.card {
  background: var(--aw-bg-card);
  border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-lg);
  box-shadow: var(--aw-shadow-card);
  overflow: hidden;
  transition: border-color var(--aw-dur) var(--aw-ease);
}
.card:hover { border-color: var(--aw-border-strong); }
.card-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--aw-border);
}
.card-icon { font-size: 16px; }
.card-title { font-size: var(--aw-fs-lg); font-weight: 700; }
.card-hint { font-size: var(--aw-fs-xs); color: var(--aw-text-faint); margin-left: 4px; }
.card-actions { margin-left: auto; display: flex; gap: 8px; }
.card-body { padding: 16px 18px; }
</style>
