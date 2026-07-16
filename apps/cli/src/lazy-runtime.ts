/**
 * 延迟加载运行时模块的工具。
 *
 * 对标 OpenClaw `src/shared/lazy-runtime.ts`：
 *   - 库模式入口（library.ts）通过此工具按需 `import()` 重型依赖
 *   - 避免库导入即触发整条依赖链加载，保持 CLI 启动速度
 *   - 每个模块只加载一次，后续调用复用缓存
 */

/**
 * 创建一个延迟加载的运行时模块包装。
 *
 * @example
 *   const loadFoo = createLazyRuntimeModule(() => import("./foo.js"));
 *   const foo = await loadFoo();           // 首次加载
 *   const foo2 = await loadFoo();          // 复用缓存
 *   foo.doSomething();
 *
 * @param loader 模块加载函数，返回 Promise<T>
 * @returns 一个 async 函数，调用后返回已加载的模块
 */
export function createLazyRuntimeModule<T>(loader: () => Promise<T>): () => Promise<T> {
  let cached: T | undefined;
  let pending: Promise<T> | undefined;

  return async function loadRuntimeModule(): Promise<T> {
    // 已缓存则直接返回
    if (cached !== undefined) {
      return cached;
    }
    // 正在加载中则复用 pending Promise，避免重复加载
    if (pending) {
      return pending;
    }
    pending = loader().then((mod) => {
      cached = mod;
      pending = undefined;
      return mod;
    });
    return pending;
  };
}
