/**
 * useApiCall — 统一 API 调用 Hook
 *
 * 自动处理 fetch 错误、toast 反馈、loading 状态、乐观更新+回滚。
 * 替代页面中重复的 `fetch(...).catch(() => { /* ignore *\/ })` 模式。
 *
 * 用法：
 *   const { call, loading, error } = useApiCall();
 *
 *   // 基本调用（自动 toast 错误）
 *   const data = await call(() => fetch("/api/sessions"), { errorMessage: "加载会话失败" });
 *
 *   // 乐观更新+回滚
 *   await call(
 *     () => fetch("/api/sessions/default/sid", { method: "PATCH", ... }),
 *     {
 *       errorMessage: "重命名失败",
 *       optimistic: () => setSessions(prev => prev.map(...)),
 *       rollback: () => setSessions(prev => prev.map(...)),
 *     }
 *   );
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { showToast } from "./shared";

export interface ApiCallOptions {
  /** 失败时显示的错误消息（为空则不显示 toast） */
  errorMessage?: string;
  /** 成功时显示的提示消息 */
  successMessage?: string;
  /** 乐观更新：在请求发出前立即执行 */
  optimistic?: () => void;
  /** 回滚：请求失败时恢复状态 */
  rollback?: () => void;
  /** 是否静默（不显示任何 toast），默认 false */
  silent?: boolean;
}

export interface UseApiCallResult {
  /** 当前是否有请求在进行 */
  loading: boolean;
  /** 最后一次错误（null 表示无错误） */
  error: string | null;
  /**
   * 执行一个 API 调用。
   * @param fetchFn 返回 Promise<T> 的函数
   * @param options 调用选项
   * @returns fetchFn 的返回值，失败时返回 null
   */
  call: <T>(fetchFn: () => Promise<T>, options?: ApiCallOptions) => Promise<T | null>;
  /** 重置错误状态 */
  clearError: () => void;
}

export function useApiCall(): UseApiCallResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const call = useCallback(async <T,>(
    fetchFn: () => Promise<T>,
    options: ApiCallOptions = {},
  ): Promise<T | null> => {
    const { errorMessage, successMessage, optimistic, rollback, silent } = options;

    // 乐观更新：请求发出前立即执行
    if (optimistic) {
      try { optimistic(); } catch { /* 乐观更新失败不应阻止请求 */ }
    }

    setLoading(true);
    setError(null);

    try {
      const result = await fetchFn();

      if (successMessage && !silent && mountedRef.current) {
        showToast(successMessage, "success");
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const displayMsg = errorMessage || msg;

      if (mountedRef.current) {
        setError(displayMsg);
        if (!silent) {
          showToast(displayMsg, "error");
        }
      }

      // 回滚：恢复乐观更新前的状态
      if (rollback) {
        try { rollback(); } catch { /* 回滚失败不额外处理 */ }
      }

      return null;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, call, clearError };
}

/**
 * usePolling — 安全的轮询 Hook，组件卸载时自动停止。
 *
 * @param fn 轮询函数，返回 Promise<void>
 * @param intervalMs 轮询间隔（毫秒）
 * @param enabled 是否启用
 */
export function usePolling(
  fn: () => Promise<void>,
  intervalMs: number,
  enabled: boolean = true,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    timer = setInterval(async () => {
      if (cancelled) return;
      try {
        await fnRef.current();
      } catch {
        // 轮询错误静默处理，避免刷屏
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [intervalMs, enabled]);
}
