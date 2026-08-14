<script setup lang="ts" generic="T extends Record<string, unknown>">
defineProps<{
  rows: T[];
  columns: Array<{ key: string; label: string; width?: string }>;
}>();
</script>

<template>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th v-for="c in columns" :key="c.key" :style="c.width ? { width: c.width } : undefined">{{ c.label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td v-for="c in columns" :key="c.key">
            <slot :name="c.key" :row="row">{{ row[c.key] ?? '—' }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--aw-fs-md); }
.tbl th {
  text-align: left; font-size: var(--aw-fs-xs); font-weight: 600;
  color: var(--aw-text-faint); text-transform: uppercase; letter-spacing: 0.06em;
  padding: 8px 12px; border-bottom: 1px solid var(--aw-border);
  white-space: nowrap;
}
.tbl td {
  padding: 10px 12px; border-bottom: 1px solid var(--aw-border);
  color: var(--aw-text-dim); vertical-align: middle;
}
.tbl tr:hover td { background: var(--aw-bg-hover); color: var(--aw-text); }
.tbl tr:last-child td { border-bottom: none; }
</style>
