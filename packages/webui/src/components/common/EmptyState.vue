<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <div class="empty">{{ text }}</div>
</template>

<style scoped>
.empty {
  padding: 40px 0; text-align: center;
  color: var(--aw-text-faint); font-size: var(--aw-fs-md);
}
</style>
