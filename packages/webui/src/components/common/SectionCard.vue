<script setup lang="ts">
import type { Component } from 'vue';
defineProps<{ title: string; icon?: Component; hint?: string }>();
</script>

<template>
  <section class="card">
    <header class="card-head">
      <span v-if="icon" class="card-icon"><component :is="icon" :size="16" stroke-width="1.8" /></span>
      <h3 class="card-title">{{ title }}</h3>
      <span v-if="hint" class="card-hint">{{ hint }}</span>
      <div class="card-actions"><slot name="actions" /></div>
    </header>
    <div class="card-body"><slot /></div>
  </section>
</template>

<style scoped>
.card {
  position: relative;
  background: var(--aw-bg-card);
  border: 1px solid var(--aw-border);
  border-radius: var(--aw-radius-lg);
  box-shadow: var(--aw-shadow-card);
  overflow: hidden;
  transition: border-color var(--aw-dur) var(--aw-ease), box-shadow var(--aw-dur) var(--aw-ease), transform var(--aw-dur) var(--aw-ease);
}
.card::before {
  content: '';
  position: absolute; inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(160deg, var(--aw-border-gold), transparent 30%, transparent 70%, var(--aw-border-strong));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity var(--aw-dur) var(--aw-ease);
  pointer-events: none;
}
.card:hover {
  border-color: var(--aw-border-strong);
  box-shadow: var(--aw-shadow-card), var(--aw-shadow-glow);
  transform: translateY(-1px);
}
.card:hover::before { opacity: 1; }
.card-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--aw-border);
}
.card-icon {
  display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: 8px;
  background: var(--aw-bg-active);
  color: var(--aw-gold);
}
.card-title { font-size: var(--aw-fs-lg); font-weight: 700; letter-spacing: 0.01em; }
.card-hint { font-size: var(--aw-fs-xs); color: var(--aw-text-faint); margin-left: 4px; }
.card-actions { margin-left: auto; display: flex; gap: 8px; }
.card-body { padding: 16px 18px; }
</style>
