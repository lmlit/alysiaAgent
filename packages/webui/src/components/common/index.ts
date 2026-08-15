/** 通用组件池(PRD §8.1 扩展点:二期编程模式复用其基础) */
export { default as SectionCard } from './SectionCard.vue';
export { default as JsonView } from './JsonView.vue';
export { default as ConfirmButton } from './ConfirmButton.vue';
export { default as EmptyState } from './EmptyState.vue';
export { default as Tag } from './Tag.vue';
export { default as Table } from './Table.vue';
export { default as LoadingBlock } from './LoadingBlock.vue';

/** 数据加载组合式函数:loading/error/data */
import { ref } from 'vue';

export function useAsync<T>(loader: () => Promise<T>) {
  const data = ref<T | null>(null);
  const loading = ref(true);
  const error = ref('');
  const reload = async () => {
    loading.value = true;
    error.value = '';
    try {
      data.value = await loader();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  };
  reload();
  return { data, loading, error, reload };
}
