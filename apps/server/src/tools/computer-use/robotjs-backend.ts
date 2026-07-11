// robotjs-backend.ts — 基于 robotjs 的 ComputerBackend 实现
// robotjs 是 Node.js 跨平台桌面自动化库，性能优于 native-backend，
// 但需要原生编译 (node-gyp)，可能无法在所有环境安装。
//
// 策略：动态 import robotjs；若不可用则 isAvailable() 返回 false，
// 工具注册层会回退到 native-backend。

import type {
  ComputerBackend,
  MouseButton,
  ScrollDirection,
  ScreenSize,
} from "./computer-backend";

/** robotjs 的最小类型描述（避免引入 @types/robotjs 依赖） */
interface RobotJSLike {
  getScreenSize(): { width: number; height: number };
  screenCapture(): { image: Buffer } | Buffer;
  moveMouse(x: number, y: number): void;
  mouseClick(button?: "left" | "right" | "middle", double?: boolean): void;
  mouseToggle(down: string, button?: "left" | "right" | "middle"): void;
  scrollMouse(x: number, y: number): void;
  typeString(text: string): void;
  keyTap(key: string, modifier?: string[]): void;
}

/** robotjs 按键名规范化（小写 + 去空格） */
function normalizeRobotKey(key: string): string {
  const k = key.toLowerCase().replace(/\s/g, "");
  const map: Record<string, string> = {
    enter: "enter",
    return: "enter",
    esc: "escape",
    escape: "escape",
    backspace: "backspace",
    delete: "delete",
    del: "delete",
    pageup: "pageup",
    pagedown: "pagedown",
    cmd: "command",
    win: "command",
    ctrl: "control",
    space: "space",
  };
  return map[k] ?? k;
}

export class RobotJsComputerBackend implements ComputerBackend {
  readonly name = "robotjs";
  private robot: RobotJSLike | null = null;
  private probeFailed = false;

  /** 动态加载 robotjs；加载失败则标记 probeFailed */
  private async getRobot(): Promise<RobotJSLike> {
    if (this.robot) return this.robot;
    if (this.probeFailed) throw new Error("robotjs not available");
    try {
      // 用 string 变量避免 TS 静态解析未安装的 robotjs 类型声明 (TS2307)
      const moduleName: string = "robotjs";
      const mod = (await import(moduleName)) as unknown as { default?: RobotJSLike } & RobotJSLike;
      this.robot = mod.default ?? (mod as RobotJSLike);
      return this.robot;
    } catch {
      this.probeFailed = true;
      throw new Error("robotjs module not installed or failed to load");
    }
  }

  isAvailable(): boolean {
    // 同步探测：isAvailable 用于 checkFn，不能 await。
    // 这里返回上次已知状态；首次调用时尝试同步 require 失败则返回 false。
    if (this.robot) return true;
    if (this.probeFailed) return false;
    try {
      // 同步 require 风格探测（ESM 下 require 可能不可用，用 try 包裹）
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = (globalThis as { require?: NodeRequire }).require;
      if (req) {
        const mod = req("robotjs") as RobotJSLike;
        this.robot = mod;
        return true;
      }
      return false;
    } catch {
      this.probeFailed = true;
      return false;
    }
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.getRobot();
    const result = r.screenCapture();
    // robotjs screenCapture 返回 { image: Buffer } 或直接 Buffer（依版本）
    if (Buffer.isBuffer(result)) return result;
    return result.image;
  }

  async mouseMove(x: number, y: number): Promise<void> {
    const r = await this.getRobot();
    r.moveMouse(x, y);
  }

  async mouseClick(
    x: number,
    y: number,
    button: MouseButton,
    doubleClick: boolean,
  ): Promise<void> {
    const r = await this.getRobot();
    r.moveMouse(x, y);
    r.mouseClick(button, doubleClick);
  }

  async mouseDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    const r = await this.getRobot();
    r.moveMouse(fromX, fromY);
    r.mouseToggle("down", "left");
    r.moveMouse(toX, toY);
    r.mouseToggle("up", "left");
  }

  async mouseScroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    const r = await this.getRobot();
    r.moveMouse(x, y);
    const amt = (direction === "up" ? 1 : -1) * Math.max(1, Math.floor(amount));
    r.scrollMouse(amt, 0);
  }

  async keyType(text: string): Promise<void> {
    const r = await this.getRobot();
    r.typeString(text);
  }

  async keyPress(keys: string[]): Promise<void> {
    if (keys.length === 0) throw new Error("keyPress requires at least one key");
    const r = await this.getRobot();
    const last = normalizeRobotKey(keys[keys.length - 1]);
    const modifiers = keys.slice(0, -1).map(normalizeRobotKey);
    r.keyTap(last, modifiers.length > 0 ? modifiers : undefined);
  }

  async getScreenSize(): Promise<ScreenSize> {
    const r = await this.getRobot();
    const s = r.getScreenSize();
    return { width: s.width, height: s.height };
  }
}
