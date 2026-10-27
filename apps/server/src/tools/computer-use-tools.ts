// computer-use-tools.ts — Computer Use 桌面控制工具集注册
// 借鉴 hermes-agent/tools/computer_use_tool.py：让 Agent 控制桌面
// （截图 / 鼠标 / 键盘 / 窗口管理）。
//
// 分层：
//   - 后端抽象 (computer-backend.ts) → 平台实现 (native/robotjs/nut-js)
//   - 工具层（本文件）：安全控制 + 工具注册
//
// 安全控制：
//   1. 坐标校验：确保 x/y 在屏幕范围内，防止越界
//   2. 按键白名单：禁止危险组合键（ctrl+alt+del 等）
//   3. 速率限制：每会话滑动窗口限流，防滥用
//   4. 会话隔离：每个 sessionId 独立的速率计数器与屏幕尺寸缓存
//   5. checkFn 服务门控：后端不可用时不注册/不暴露工具

import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry } from "@evoclaw/core";
import type {
  ComputerBackend,
  MouseButton,
  ScreenSize,
  ScrollDirection,
} from "./computer-use/computer-backend";
import { NativeComputerBackend } from "./computer-use/native-backend";
import { RobotJsComputerBackend } from "./computer-use/robotjs-backend";
import { NutJsComputerBackend } from "./computer-use/nut-js-backend";

export type { ComputerBackend, MouseButton, ScreenSize, ScrollDirection } from "./computer-use/computer-backend";
export { NativeComputerBackend } from "./computer-use/native-backend";
export { RobotJsComputerBackend } from "./computer-use/robotjs-backend";
export { NutJsComputerBackend } from "./computer-use/nut-js-backend";

/** 工具依赖 */
export interface ComputerUseToolDeps {
  executor: AgentModelExecutor;
  /** 显式注入后端（测试/自定义用）。优先级最高。 */
  backend?: ComputerBackend;
  /** 服务注册表：从中解析 "computerBackend" 服务（次优先） */
  registry?: ServiceRegistry;
}

// ── 安全：按键白名单 / 黑名单 ──

/** 允许的按键名（小写）。未在此集合中的按键将被拒绝。 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // 修饰键
  "ctrl", "control", "shift", "alt", "cmd", "command", "win", "meta", "super",
  // 字母（单字符）
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  // 数字
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  // 功能键
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  // 编辑/导航键
  "enter", "return", "tab", "space", "backspace", "delete", "del",
  "esc", "escape", "up", "down", "left", "right", "home", "end",
  "pageup", "pagedown", "pgup", "pgdn",
  // 符号
  "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`",
]);

/** 危险组合键黑名单（排序后的小写键集合，用 "+" 连接作为键） */
const BLOCKED_COMBOS: ReadonlySet<string> = new Set([
  "alt+ctrl+delete",       // Windows 安全屏幕 / 锁定
  "ctrl+alt+delete",
  "alt+ctrl+del",
  "ctrl+alt+del",
  "ctrl+shift+escape",     // Windows 任务管理器
  "ctrl+shift+esc",
  "alt+f4",                // 关闭窗口（高风险，可能关闭正在编辑的内容）
  "cmd+q",                 // macOS 退出应用
  "cmd+option+esc",        // macOS 强制退出
  "cmd+alt+esc",
  "win+l",                 // Windows 锁屏
  "super+l",
  "meta+l",
  "ctrl+alt+sysrq",
]);

/** 校验按键序列：白名单 + 危险组合黑名单 */
function validateKeySequence(keys: string[]): { ok: boolean; error?: string } {
  if (keys.length === 0) {
    return { ok: false, error: "至少需要一个按键" };
  }
  // 白名单校验
  for (const k of keys) {
    const lower = k.toLowerCase().trim();
    if (!lower) {
      return { ok: false, error: `空按键名: "${k}"` };
    }
    if (!ALLOWED_KEYS.has(lower)) {
      return { ok: false, error: `按键不在白名单中: "${k}"（仅允许字母/数字/功能键/方向键等）` };
    }
  }
  // 黑名单校验：排序后规范化比较
  const normalized = keys.map((k) => k.toLowerCase().trim());
  // 修饰键排序，普通键放最后
  const modifiers = new Set(["ctrl", "control", "shift", "alt", "cmd", "command", "win", "meta", "super"]);
  const mods = normalized.filter((k) => modifiers.has(k)).sort();
  const others = normalized.filter((k) => !modifiers.has(k)).sort();
  const comboKey = [...mods, ...others].join("+");
  if (BLOCKED_COMBOS.has(comboKey)) {
    return { ok: false, error: `危险组合键被禁止: ${keys.join("+")}` };
  }
  return { ok: true };
}

// ── 安全：速率限制（滑动窗口） ──

interface RateBucket {
  timestamps: number[];
}

const RATE_LIMIT_MAX_OPS = 60;          // 每窗口最大操作数
const RATE_LIMIT_WINDOW_MS = 60_000;    // 1 分钟窗口
/** sessionRateBuckets 最大容量，防止无界会话导致内存耗尽 */
const MAX_RATE_BUCKETS = 1000;

const sessionRateBuckets = new Map<string, RateBucket>();

/** 速率限制检查；sessionId 为空时使用 "default" */
function checkRateLimit(sessionId: string): { ok: boolean; error?: string } {
  const sid = sessionId || "default";
  const now = Date.now();
  let bucket = sessionRateBuckets.get(sid);
  if (!bucket) {
    bucket = { timestamps: [] };
    sessionRateBuckets.set(sid, bucket);
    // LRU 式裁剪：超过容量时删除最早的桶，防止无界会话导致内存耗尽
    if (sessionRateBuckets.size > MAX_RATE_BUCKETS) {
      const oldestKey = sessionRateBuckets.keys().next().value;
      if (oldestKey !== undefined) sessionRateBuckets.delete(oldestKey);
    }
  }
  // 清除过期时间戳
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.timestamps.length >= RATE_LIMIT_MAX_OPS) {
    const oldest = bucket.timestamps[0];
    const retryIn = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000);
    return {
      ok: false,
      error: `速率限制：每分钟最多 ${RATE_LIMIT_MAX_OPS} 次桌面操作，请 ${retryIn} 秒后重试`,
    };
  }
  bucket.timestamps.push(now);
  return { ok: true };
}

// ── 安全：坐标校验 ──

/** 屏幕尺寸缓存（每会话） */
const screenSizeCache = new Map<string, ScreenSize>();
/** screenSizeCache 最大容量，防止无界会话导致内存耗尽 */
const MAX_SCREEN_SIZE_CACHE = 1000;

async function getValidScreenSize(
  backend: ComputerBackend,
  sessionId: string,
): Promise<ScreenSize> {
  const sid = sessionId || "default";
  const cached = screenSizeCache.get(sid);
  if (cached) return cached;
  const size = await backend.getScreenSize();
  screenSizeCache.set(sid, size);
  // LRU 式裁剪：超过容量时删除最早的条目
  if (screenSizeCache.size > MAX_SCREEN_SIZE_CACHE) {
    const oldestKey = screenSizeCache.keys().next().value;
    if (oldestKey !== undefined) screenSizeCache.delete(oldestKey);
  }
  return size;
}

/** 校验坐标在屏幕范围内（允许 -1 容差，因部分平台 0-indexed 边界） */
function validateCoords(
  x: number,
  y: number,
  size: ScreenSize,
): { ok: boolean; error?: string } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: `坐标无效: x=${x}, y=${y}（必须为有限数字）` };
  }
  if (x < 0 || y < 0) {
    return { ok: false, error: `坐标越界: x=${x}, y=${y}（不能为负数）` };
  }
  if (x >= size.width || y >= size.height) {
    return { ok: false, error: `坐标越界: x=${x}, y=${y}（屏幕尺寸 ${size.width}x${size.height}）` };
  }
  return { ok: true };
}

// ── 后端选择 ──

/** 从候选中选择第一个可用的后端；都不行则返回 null */
function resolveBackend(
  explicit: ComputerBackend | undefined,
  registry: ServiceRegistry | undefined,
): ComputerBackend | null {
  if (explicit) return explicit;
  // 从服务注册表解析
  if (registry) {
    try {
      const fromReg = registry.resolveService<ComputerBackend>("computerBackend");
      if (fromReg && fromReg.isAvailable()) return fromReg;
    } catch { /* 服务未注册 */ }
  }
  // 候选顺序：robotjs > nut-js > native
  const candidates: ComputerBackend[] = [
    new RobotJsComputerBackend(),
    new NutJsComputerBackend(),
    new NativeComputerBackend(),
  ];
  for (const c of candidates) {
    try {
      if (c.isAvailable()) return c;
    } catch { /* 继续尝试下一个 */ }
  }
  return null;
}

// ── 工具注册主函数 ──

export function registerComputerUseTools(deps: ComputerUseToolDeps): () => void {
  const { executor, registry } = deps;
  const backend = resolveBackend(deps.backend, registry);

  // checkFn：后端可用时才暴露工具
  const checkFn = (): boolean => {
    if (!backend) return false;
    try {
      return backend.isAvailable();
    } catch {
      return false;
    }
  };

  const unregistered: string[] = [];

  // ── 内部 handler：由 computer_use 复合工具的分发器调用 ──
  // 每个 handler 保留原 inline arrow 的逻辑体（逐字搬运），仅将内联箭头改为命名函数，
  // 仍闭包捕获上方 backend / checkRateLimit / getValidScreenSize / validateCoords / validateKeySequence。

  // 原 computer_screenshot — 截取屏幕
  async function handleComputerScreenshot(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    try {
      const buf = await backend.screenshot();
      const size = await getValidScreenSize(backend, sessionId);
      return {
        image: buf.toString("base64"),
        format: "png",
        width: size.width,
        height: size.height,
        size: buf.length,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_mouse_click — 鼠标点击
  async function handleComputerMouseClick(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const x = Number(params.x);
    const y = Number(params.y);
    const buttonStr = String(params.button || "left");
    const button: MouseButton = buttonStr === "right" ? "right" : buttonStr === "middle" ? "middle" : "left";
    const doubleClick = String(params.doubleClick || "false") === "true";
    try {
      const size = await getValidScreenSize(backend, sessionId);
      const coordCheck = validateCoords(x, y, size);
      if (!coordCheck.ok) return { success: false, error: coordCheck.error };
      await backend.mouseClick(x, y, button, doubleClick);
      return { success: true, x, y, button, doubleClick };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_mouse_move — 移动鼠标
  async function handleComputerMouseMove(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const x = Number(params.x);
    const y = Number(params.y);
    try {
      const size = await getValidScreenSize(backend, sessionId);
      const coordCheck = validateCoords(x, y, size);
      if (!coordCheck.ok) return { success: false, error: coordCheck.error };
      await backend.mouseMove(x, y);
      return { success: true, x, y };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_mouse_drag — 拖拽
  async function handleComputerMouseDrag(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const fromX = Number(params.fromX);
    const fromY = Number(params.fromY);
    const toX = Number(params.toX);
    const toY = Number(params.toY);
    try {
      const size = await getValidScreenSize(backend, sessionId);
      const c1 = validateCoords(fromX, fromY, size);
      if (!c1.ok) return { success: false, error: `起点${c1.error}` };
      const c2 = validateCoords(toX, toY, size);
      if (!c2.ok) return { success: false, error: `终点${c2.error}` };
      await backend.mouseDrag(fromX, fromY, toX, toY);
      return { success: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_mouse_scroll — 滚动
  async function handleComputerMouseScroll(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const x = Number(params.x);
    const y = Number(params.y);
    const directionStr = String(params.direction || "down");
    const direction: ScrollDirection = directionStr === "up" ? "up" : "down";
    // 安全：Number() 对非数字字符串返回 NaN，会传播到 PowerShell 导致异常行为。
    // 使用 ?? 避免 0 被折叠为默认值，再用 Number.isFinite 防御 NaN/Infinity。
    const amountRaw = Number(params.amount ?? 3);
    const amount = Number.isFinite(amountRaw) ? amountRaw : 3;
    try {
      const size = await getValidScreenSize(backend, sessionId);
      const coordCheck = validateCoords(x, y, size);
      if (!coordCheck.ok) return { success: false, error: coordCheck.error };
      await backend.mouseScroll(x, y, direction, amount);
      return { success: true, x, y, direction, amount };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_key_type — 输入文本
  async function handleComputerKeyType(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const text = String(params.text || "");
    if (!text) return { success: false, error: "text 不能为空" };
    // 文本长度限制（防滥用）
    const MAX_TEXT_LEN = 2000;
    if (text.length > MAX_TEXT_LEN) {
      return { success: false, error: `文本过长（${text.length} > ${MAX_TEXT_LEN}），请分段输入` };
    }
    try {
      await backend.keyType(text);
      return { success: true, length: text.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_key_press — 按组合键
  async function handleComputerKeyPress(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const keysStr = String(params.keys || "");
    const keys = keysStr.split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) return { success: false, error: "keys 不能为空" };
    // 按键白名单 + 危险组合黑名单校验
    const keyCheck = validateKeySequence(keys);
    if (!keyCheck.ok) return { success: false, error: keyCheck.error };
    try {
      await backend.keyPress(keys);
      return { success: true, keys };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_window_list — 列出窗口
  async function handleComputerWindowList(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    try {
      if (!backend.windowList) {
        return { windows: [], supported: false };
      }
      const windows = await backend.windowList();
      return { windows, supported: true, count: windows.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 原 computer_window_focus — 聚焦窗口
  async function handleComputerWindowFocus(params: Record<string, unknown>): Promise<unknown> {
    if (!backend || !backend.isAvailable()) return { success: false, error: "ComputerBackend 不可用" };
    const sessionId = String(params.sessionId || "default");
    const rate = checkRateLimit(sessionId);
    if (!rate.ok) return { success: false, error: rate.error };
    const windowId = String(params.windowId || "");
    if (!windowId) return { success: false, error: "windowId 不能为空" };
    try {
      if (!backend.windowFocus) {
        return { success: false, error: "当前后端不支持窗口聚焦" };
      }
      await backend.windowFocus(windowId);
      return { success: true, windowId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 复合工具：computer_use — 桌面控制（合并原 9 个 computer_* 工具）
  executor.registerTool(
    "computer_use",
    {
      name: "computer_use",
      description:
        "桌面控制复合工具（computer use）。action=screenshot 截取屏幕返回 base64 PNG 与屏幕尺寸；" +
        "action=click 在 (x,y) 点击鼠标（button: left/right/middle，doubleClick: true/false）；" +
        "action=move 移动鼠标到 (x,y)；" +
        "action=drag 从 (fromX,fromY) 拖拽到 (toX,toY)；" +
        "action=scroll 在 (x,y) 滚动滚轮（direction: up/down，amount 默认 3）；" +
        "action=type 输入文本 text（支持中文/Unicode，最长 2000 字符）；" +
        "action=press 按组合键 keys（逗号分隔，如 ctrl,c；危险组合键被拒绝）；" +
        "action=window_list 列出可见窗口（标题/ID/边界）；" +
        "action=window_focus 聚焦指定窗口 windowId。" +
        "English: composite desktop control tool — screenshot / mouse click, move, drag, scroll / " +
        "text input / key combos / window list & focus.",
      parameters: {
        action: {
          type: "string",
          description: "操作类型（默认 screenshot）",
          required: true,
          enum: [
            "screenshot", "click", "move", "drag", "scroll",
            "type", "press", "window_list", "window_focus",
          ],
        },
        sessionId: { type: "string", description: "会话 ID（用于隔离，可选）", required: false },
        x: { type: "number", description: "X 坐标（像素）", required: false },
        y: { type: "number", description: "Y 坐标（像素）", required: false },
        button: { type: "string", description: "鼠标键：left(默认) / right / middle", required: false },
        doubleClick: { type: "string", description: "是否双击：true/false（默认 false）", required: false },
        fromX: { type: "number", description: "起点 X 坐标（像素）", required: false },
        fromY: { type: "number", description: "起点 Y 坐标（像素）", required: false },
        toX: { type: "number", description: "终点 X 坐标（像素）", required: false },
        toY: { type: "number", description: "终点 Y 坐标（像素）", required: false },
        direction: { type: "string", description: "滚动方向：up / down", required: false },
        amount: { type: "number", description: "滚动量（格数，默认 3）", required: false },
        text: { type: "string", description: "要输入的文本", required: false },
        keys: { type: "string", description: '组合键，逗号分隔，如 "ctrl,c" 或 "enter"', required: false },
        windowId: { type: "string", description: "窗口 ID（来自 computer_window_list）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "screenshot");
      if (action === "screenshot") return await handleComputerScreenshot(params);
      if (action === "click") return await handleComputerMouseClick(params);
      if (action === "move") return await handleComputerMouseMove(params);
      if (action === "drag") return await handleComputerMouseDrag(params);
      if (action === "scroll") return await handleComputerMouseScroll(params);
      if (action === "type") return await handleComputerKeyType(params);
      if (action === "press") return await handleComputerKeyPress(params);
      if (action === "window_list") return await handleComputerWindowList(params);
      if (action === "window_focus") return await handleComputerWindowFocus(params);
      return { success: false, error: `未知 computer_use action: ${action}（仅支持 screenshot / click / move / drag / scroll / type / press / window_list / window_focus）` };
    },
    checkFn,
  );
  unregistered.push("computer_use");

  // 返回反注册函数
  return () => {
    for (const name of unregistered) {
      try {
        executor.unregisterTool(name);
      } catch { /* 工具可能未注册 */ }
    }
    // 清理会话缓存
    sessionRateBuckets.clear();
    screenSizeCache.clear();
  };
}

// ── 内部安全函数导出（供测试） ──
export const __test__ = {
  validateKeySequence,
  validateCoords,
  checkRateLimit,
  RATE_LIMIT_MAX_OPS,
  RATE_LIMIT_WINDOW_MS,
  resetRateLimit: (): void => {
    sessionRateBuckets.clear();
    screenSizeCache.clear();
  },
};
