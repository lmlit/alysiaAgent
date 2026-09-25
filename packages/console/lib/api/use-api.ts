'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client';

export type ApiState<T> = {
  data: T | null;
  loading: boolean;
  /** 面向用户的可读错误文案（同时已 console.error 过，见 client.ts） */
  error: string | null;
  /** 401 —— 交给 TokenGate 处理，页面不用展示 */
  unauthorized: boolean;
  reload: () => void;
};

/**
 * 只读数据获取 hook：loading / error / reload 三件套。
 *
 * - 请求竞态：后发请求用序号作废先前响应（切页/重试不会串数据）
 * - 卸载后不 setState
 * - 不吞错：错误同时进 console 与界面
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [nonce, setNonce] = useState(0);

  // 用 ref 存 fetcher，避免把它放进依赖导致每次渲染都重新请求
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    fetcherRef
      .current()
      .then((res) => {
        if (seq !== seqRef.current || !mountedRef.current) return;
        setData(res);
        setUnauthorized(false);
      })
      .catch((err: unknown) => {
        if (seq !== seqRef.current || !mountedRef.current) return;
        if (err instanceof ApiError) {
          if (err.status === 401) setUnauthorized(true);
          setError(err.message);
        } else {
          console.error('[useApi] 未预期的错误', err);
          setError(err instanceof Error ? err.message : '未知错误');
        }
      })
      .finally(() => {
        if (seq !== seqRef.current || !mountedRef.current) return;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, unauthorized, reload };
}
