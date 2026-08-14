<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  label: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
}>();
const pending = ref(false);
const armed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function click() {
  if (!armed.value) {
    armed.value = true;
    timer = setTimeout(() => { armed.value = false; }, 3000);
    return;
  }
  if (timer) clearTimeout(timer);
  armed.value = false;
  pending.value = true;
  try {
    await props.onConfirm();
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <button
    class="btn"
    :class="[armed ? 'armed' : '', danger ? 'danger' : '']"
    :disabled="pending"
    @click="click"
  >
    {{ pending ? '…' : (armed ? (confirmText ?? '确认删除?') : label) }}
  </button>
</template>

<style scoped>
.btn {
  font-size: var(--aw-fs-sm); padding: 5px 12px;
  border-radius: var(--aw-radius-sm);
  border: 1px solid var(--aw-border);
  background: var(--aw-bg-input); color: var(--aw-text-dim);
  transition: all var(--aw-dur) var(--aw-ease);
}
.btn:hover { color: var(--aw-text); border-color: var(--aw-border-strong); }
.btn.armed { background: rgba(248, 113, 113, 0.15); color: var(--aw-danger); border-color: var(--aw-danger); }
.btn.danger:hover { color: var(--aw-danger); border-color: var(--aw-danger); }
</style>
