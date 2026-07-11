// computer-backend.ts — Computer Use 桌面控制后端抽象接口
// 借鉴 hermes-agent/tools/computer_use_tool.py 的分层设计：
//   抽象后端接口 + 平台实现，使工具层与具体 I/O 解耦。
// 后端只负责"执行原子桌面操作"；安全控制（坐标校验/按键白名单/速率限制）
// 由工具注册层 (computer-use-tools.ts) 负责。

/** 鼠标按键 */
export type MouseButton = "left" | "right" | "middle";

/** 滚动方向 */
export type ScrollDirection = "up" | "down";

/** 窗口边界 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口信息 */
export interface WindowInfo {
  id: string;
  title: string;
  bounds: WindowBounds;
}

/** 屏幕尺寸 */
export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * 计算机控制后端抽象接口 — 支持多平台桌面自动化。
 *
 * 实现顺序约定：
 *  1. robotjs-backend（若 robotjs 可用，跨平台，性能最佳）
 *  2. nut-js-backend（若 nut.js 可用，现代替代方案）
 *  3. native-backend（系统原生命令：Windows=PowerShell, macOS=cliclick/screencapture, Linux=xdotool/scrot）
 *
 * isAvailable() 必须无副作用且不抛异常：用于 checkFn 服务门控。
 */
export interface ComputerBackend {
  /** 后端名称（如 "robotjs" / "nut-js" / "native"） */
  readonly name: string;

  /** 截取屏幕，返回 PNG 图像 Buffer */
  screenshot(): Promise<Buffer>;

  /** 鼠标点击 */
  mouseClick(x: number, y: number, button: MouseButton, doubleClick: boolean): Promise<void>;

  /** 移动鼠标到坐标 */
  mouseMove(x: number, y: number): Promise<void>;

  /** 拖拽（按下→移动→释放） */
  mouseDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;

  /** 滚动（amount 为滚动量，单位由实现定义，通常为"格"或"行"） */
  mouseScroll(x: number, y: number, direction: ScrollDirection, amount: number): Promise<void>;

  /** 输入文本（逐字符，处理 Unicode） */
  keyType(text: string): Promise<void>;

  /** 按组合键，如 ["ctrl", "c"]；顺序为按下→释放 */
  keyPress(keys: string[]): Promise<void>;

  /** 列出窗口（平台不支持时可不实现） */
  windowList?(): Promise<WindowInfo[]>;

  /** 聚焦窗口（平台不支持时可不实现） */
  windowFocus?(windowId: string): Promise<void>;

  /** 获取屏幕尺寸 */
  getScreenSize(): Promise<ScreenSize>;

  /**
   * 后端是否可用。必须无副作用、不抛异常。
   * 用于工具注册时的服务门控 (checkFn)。
   */
  isAvailable(): boolean;
}
