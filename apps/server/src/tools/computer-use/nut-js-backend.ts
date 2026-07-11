// nut-js-backend.ts — 基于 nut.js (nut-tree-fork) 的 ComputerBackend 实现
// nut.js 是现代 Node.js 桌面自动化库，原生模块，比 robotjs 更活跃。
// 需要安装 @nut-tree-fork/nut-js 或 nut.js 并原生编译。
//
// 策略：动态 import；若不可用则 isAvailable() 返回 false，
// 工具注册层会回退到 native-backend。

import type {
  ComputerBackend,
  MouseButton,
  ScrollDirection,
  ScreenSize,
} from "./computer-backend";

/** nut.js 最小类型描述 */
interface NutJSLike {
  screen: {
    capture(): Promise<{ toPNG(): Buffer }>;
    width(): Promise<number>;
    height(): Promise<number>;
  };
  mouse: {
    setPosition(p: { x: number; y: number }): Promise<void>;
    getPosition(): Promise<{ x: number; y: number }>;
    click(button: number): Promise<void>;
    doubleClick(button: number): Promise<void>;
    pressButton(button: number): Promise<void>;
    releaseButton(button: number): Promise<void>;
    scrollDown(amount: number): Promise<void>;
    scrollUp(amount: number): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    key(key: string): Promise<void>;
    pressKey(key: string): Promise<void>;
    releaseKey(key: string): Promise<void>;
  };
  Button: { LEFT: number; RIGHT: number; MIDDLE: number };
}

/** 按键名 → nut.js 按键名 */
function normalizeNutKey(key: string): string {
  const k = key.toLowerCase();
  const map: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    ctrl: "LeftControl",
    shift: "LeftShift",
    alt: "LeftAlt",
    cmd: "LeftSuper",
    win: "LeftSuper",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    space: "Space",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  };
  return map[k] ?? k.toUpperCase();
}

export class NutJsComputerBackend implements ComputerBackend {
  readonly name = "nut-js";
  private nut: NutJSLike | null = null;
  private probeFailed = false;

  private async getNut(): Promise<NutJSLike> {
    if (this.nut) return this.nut;
    if (this.probeFailed) throw new Error("nut.js not available");
    try {
      // 用 string 变量避免 TS 静态解析未安装的 nut-js 类型声明 (TS2307)
      const moduleName: string = "@nut-tree-fork/nut-js";
      const mod = (await import(moduleName)) as unknown as NutJSLike;
      this.nut = mod;
      return this.nut;
    } catch {
      // 尝试备选包名
      try {
        const moduleName2: string = "nut.js";
        const mod2 = (await import(moduleName2)) as unknown as NutJSLike;
        this.nut = mod2;
        return this.nut;
      } catch {
        this.probeFailed = true;
        throw new Error("nut.js module not installed or failed to load");
      }
    }
  }

  isAvailable(): boolean {
    if (this.nut) return true;
    if (this.probeFailed) return false;
    // 异步加载无法在同步 checkFn 中完成，首次返回 false；
    // 调用方应在 init 时预热（await getNut()）。
    return false;
  }

  async screenshot(): Promise<Buffer> {
    const n = await this.getNut();
    const img = await n.screen.capture();
    return img.toPNG();
  }

  async mouseMove(x: number, y: number): Promise<void> {
    const n = await this.getNut();
    await n.mouse.setPosition({ x, y });
  }

  async mouseClick(
    x: number,
    y: number,
    button: MouseButton,
    doubleClick: boolean,
  ): Promise<void> {
    const n = await this.getNut();
    await n.mouse.setPosition({ x, y });
    const btnNum = button === "left" ? n.Button.LEFT : button === "right" ? n.Button.RIGHT : n.Button.MIDDLE;
    if (doubleClick) {
      await n.mouse.doubleClick(btnNum);
    } else {
      await n.mouse.click(btnNum);
    }
  }

  async mouseDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    const n = await this.getNut();
    await n.mouse.setPosition({ x: fromX, y: fromY });
    await n.mouse.pressButton(n.Button.LEFT);
    await n.mouse.setPosition({ x: toX, y: toY });
    await n.mouse.releaseButton(n.Button.LEFT);
  }

  async mouseScroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    const n = await this.getNut();
    await n.mouse.setPosition({ x, y });
    const amt = Math.max(1, Math.floor(amount));
    if (direction === "up") {
      await n.mouse.scrollUp(amt);
    } else {
      await n.mouse.scrollDown(amt);
    }
  }

  async keyType(text: string): Promise<void> {
    const n = await this.getNut();
    await n.keyboard.type(text);
  }

  async keyPress(keys: string[]): Promise<void> {
    if (keys.length === 0) throw new Error("keyPress requires at least one key");
    const n = await this.getNut();
    const normalized = keys.map(normalizeNutKey);
    // 先按下所有键，再按相反顺序释放
    for (const k of normalized) {
      await n.keyboard.pressKey(k);
    }
    for (let i = normalized.length - 1; i >= 0; i--) {
      await n.keyboard.releaseKey(normalized[i]);
    }
  }

  async getScreenSize(): Promise<ScreenSize> {
    const n = await this.getNut();
    const [w, h] = await Promise.all([n.screen.width(), n.screen.height()]);
    return { width: w, height: h };
  }
}
