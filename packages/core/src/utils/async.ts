export function isAsyncGenerator<T>(obj: unknown): obj is AsyncGenerator<T, void, void> {
  return obj != null && typeof obj === 'object' && Symbol.asyncIterator in obj;
}
