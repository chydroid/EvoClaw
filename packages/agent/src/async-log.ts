/**
 * 共享异步日志缓冲（P0-2：原 llm-caller 内部实现提升为独立模块）
 *
 * 背景：process.stdout.write / process.stderr.write 是同步 I/O，
 * 热路径高频调用（每轮 5-15 条）会阻塞单线程事件循环。
 * 引入 16ms 批量刷新队列，将同步 I/O 变异步，每轮省 ~5-15ms。
 *
 * 设计：
 * - stdout / stderr 各自独立队列，避免错误日志被普通日志阻塞
 * - 16ms 批量刷新（~60fps），unref 防止定时器挂起进程退出
 * - 仅供热循环内使用；启动期一次性日志可保留同步写
 */

const _stdoutQueue: string[] = [];
const _stderrQueue: string[] = [];
let _stdoutTimer: ReturnType<typeof setTimeout> | null = null;
let _stderrTimer: ReturnType<typeof setTimeout> | null = null;

function flushQueue(queue: string[], write: (s: string) => void): void {
  const batch = queue.join("\n");
  queue.length = 0;
  if (batch) write(batch + "\n");
}

/** 异步缓冲写 stdout（16ms 批量刷新） */
export function asyncLog(msg: string): void {
  _stdoutQueue.push(msg);
  if (!_stdoutTimer) {
    _stdoutTimer = setTimeout(() => {
      _stdoutTimer = null;
      flushQueue(_stdoutQueue, (s) => process.stdout.write(s));
    }, 16);
    if (_stdoutTimer.unref) _stdoutTimer.unref();
  }
}

/** 异步缓冲写 stderr（16ms 批量刷新） */
export function asyncErr(msg: string): void {
  _stderrQueue.push(msg);
  if (!_stderrTimer) {
    _stderrTimer = setTimeout(() => {
      _stderrTimer = null;
      flushQueue(_stderrQueue, (s) => process.stderr.write(s));
    }, 16);
    if (_stderrTimer.unref) _stderrTimer.unref();
  }
}

/** 测试钩子：立即冲刷两个队列（仅测试用） */
export function flushLogQueues(): void {
  flushQueue(_stdoutQueue, (s) => process.stdout.write(s));
  flushQueue(_stderrQueue, (s) => process.stderr.write(s));
}
