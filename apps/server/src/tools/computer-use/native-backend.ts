// native-backend.ts — 使用系统原生命令的 ComputerBackend 实现
// 默认实现（无需原生编译）。借鉴 hermes-agent/computer_use_tool.py 的平台分发思路。
//
// 平台工具链：
//   Windows: PowerShell + .NET (System.Windows.Forms / System.Drawing / user32.dll P/Invoke)
//   macOS:   screencapture + cliclick
//   Linux:   xdotool + scrot/import
//
// 约束：所有外部命令通过 execFileSync 执行（非 execSync），带超时与 stdio:"pipe"。
// isAvailable() 无副作用、不抛异常，用于 checkFn 服务门控。

import { execFileSync } from "child_process";
import type {
  ComputerBackend,
  MouseButton,
  ScrollDirection,
  ScreenSize,
  WindowInfo,
} from "./computer-backend";

const EXEC_TIMEOUT_MS = 10_000;

/** 缓存可用性检测结果，避免每次 checkFn 都 execFileSync 阻塞事件循环 */
let availabilityCache: boolean | null = null;

/** 检查给定命令是否可在 PATH 中执行（which/where） */
function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [cmd], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Windows PowerShell 执行：使用 -EncodedCommand 避免 shell 引号转义问题。
 *  返回 stdout（Buffer 或解码为字符串）。 */
function runPowerShell(script: string): string {
  // PowerShell -EncodedCommand 接收 UTF-16LE 的 base64
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdio: "pipe", timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  return out.toString("utf8").trim();
}

function isWindows(): boolean {
  return process.platform === "win32";
}
function isMacos(): boolean {
  return process.platform === "darwin";
}
function isLinux(): boolean {
  return process.platform === "linux";
}

// ── Windows PowerShell 脚本片段 ──

/** 加载 .NET 程序集（Windows Forms / Drawing） */
const PS_LOAD_FORMS =
  "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;";

/** Windows 截图 PowerShell 脚本：截取主屏 → PNG → base64 输出到 stdout */
const PS_SCREENSHOT = `${PS_LOAD_FORMS}
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
$ms = New-Object System.IO.MemoryStream;
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()));`;

/** Windows 获取屏幕尺寸 */
const PS_SCREENSIZE = `${PS_LOAD_FORMS}
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
[Console]::Out.Write("$($b.Width)x$($b.Height)");`;

/** Windows 鼠标操作 PowerShell 脚本（P/Invoke user32.dll SetCursorPos + mouse_event） */
function psMouseScript(
  x: number,
  y: number,
  button: MouseButton,
  doubleClick: boolean,
): string {
  const flags: string[] = [];
  const downUp = (dn: string, up: string) => {
    flags.push(dn, up);
    if (doubleClick) flags.push(dn, up);
  };
  if (button === "left") downUp("0x0002", "0x0004");
  else if (button === "right") downUp("0x0008", "0x0010");
  else downUp("0x0020", "0x0040"); // middle

  return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, IntPtr dwExtraInfo);
}
"@
[WinMouse]::SetCursorPos(${x}, ${y});
${flags.map((f) => `[WinMouse]::mouse_event(${f}, 0, 0, 0, [IntPtr]::Zero);`).join("\n")}`;
}

/** Windows 鼠标移动脚本 */
function psMouseMoveScript(x: number, y: number): string {
  return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinMouseM {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
[WinMouseM]::SetCursorPos(${x}, ${y});`;
}

/** Windows 拖拽脚本：移动到起点 → 按下 → 移动到终点 → 释放 */
function psMouseDragScript(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinDrag {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, IntPtr dwExtraInfo);
}
"@
[WinDrag]::SetCursorPos(${fromX}, ${fromY});
Start-Sleep -Milliseconds 50;
[WinDrag]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero);
[WinDrag]::SetCursorPos(${toX}, ${toY});
Start-Sleep -Milliseconds 50;
[WinDrag]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero);`;
}

/** Windows 滚动脚本：mouse_event MOUSEEVENTF_WHEEL (0x0800)，dwData 为 amount*WHEEL_DELTA(120) */
function psMouseScrollScript(
  x: number,
  y: number,
  direction: ScrollDirection,
  amount: number,
): string {
  const delta = (direction === "up" ? 1 : -1) * Math.max(1, Math.floor(amount)) * 120;
  return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinWheel {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
}
"@
[WinWheel]::SetCursorPos(${x}, ${y});
[WinWheel]::mouse_event(0x0800, 0, 0, ${delta}, [IntPtr]::Zero);`;
}

/** 转义 SendKeys 特殊字符：{ } [ ] ( ) + ^ % ~ */
function escapeSendKeys(text: string): string {
  return text.replace(/([{}[\]()+\^%~])/g, "{$1}");
}

/** Windows 输入文本：SendKeys.SendWait（先转义特殊字符） */
function psKeyTypeScript(text: string): string {
  const escaped = escapeSendKeys(text);
  return `${PS_LOAD_FORMS}
[System.Windows.Forms.SendKeys]::SendWait("${escaped}");`;
}

/** 按键名 → SendKeys 表示法 */
const KEY_SENDKEYS_MAP: Record<string, string> = {
  ctrl: "^",
  shift: "+",
  alt: "%",
  enter: "{ENTER}",
  esc: "{ESC}",
  escape: "{ESC}",
  tab: "{TAB}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  space: " ",
  win: "{LWIN}",
  cmd: "{LWIN}",
};

/** Windows 按组合键：ctrl/shift/alt 作为前缀修饰键，最后一个键为普通键 */
function psKeyPressScript(keys: string[]): string {
  const parts: string[] = [];
  let prefix = "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i].toLowerCase();
    const mapped = KEY_SENDKEYS_MAP[k];
    if (mapped === "^" || mapped === "+" || mapped === "%") {
      prefix += mapped;
    } else if (mapped) {
      parts.push(prefix + mapped);
      prefix = "";
    } else {
      // 单字符键直接用
      const ch = keys[i].length === 1 ? keys[i] : keys[i].toLowerCase();
      parts.push(prefix + ch);
      prefix = "";
    }
  }
  if (prefix) parts.push(prefix); // 仅修饰键
  const expr = parts.map((p) => `"${p}"`).join(",");
  return `${PS_LOAD_FORMS}
[System.Windows.Forms.SendKeys]::SendWait(${expr});`;
}

// ── cliclick 按键映射 (macOS) ──
/** 按键名 → cliclick 按键代码 */
function cliclickKeyCode(key: string): string | null {
  const k = key.toLowerCase();
  const map: Record<string, string> = {
    ctrl: "ctrl",
    shift: "shift",
    alt: "alt",
    cmd: "cmd",
    enter: "return",
    return: "return",
    esc: "esc",
    escape: "esc",
    tab: "tab",
    backspace: "delete",
    delete: "forwarddelete",
    del: "forwarddelete",
    up: "arrow_up",
    down: "arrow_down",
    left: "arrow_left",
    right: "arrow_right",
    home: "home",
    end: "end",
    pageup: "page_up",
    pagedown: "page_down",
    space: "space",
  };
  return map[k] ?? (key.length === 1 ? k : null);
}

// ── 后端实现 ──

export class NativeComputerBackend implements ComputerBackend {
  readonly name = "native";

  isAvailable(): boolean {
    if (availabilityCache !== null) return availabilityCache;
    try {
      if (isWindows()) {
        // Windows 自带 powershell.exe
        const ok = commandExists("powershell.exe");
        availabilityCache = ok;
        return ok;
      }
      if (isMacos()) {
        // screencapture 系统自带；cliclick 需 brew install
        availabilityCache = commandExists("screencapture") && commandExists("cliclick");
        return availabilityCache;
      }
      if (isLinux()) {
        availabilityCache = commandExists("xdotool") && commandExists("scrot");
        return availabilityCache;
      }
      availabilityCache = false;
      return false;
    } catch {
      availabilityCache = false;
      return false;
    }
  }

  async screenshot(): Promise<Buffer> {
    if (isWindows()) {
      const b64 = runPowerShell(PS_SCREENSHOT);
      return Buffer.from(b64, "base64");
    }
    if (isMacos()) {
      // screencapture -x 静默截屏，-t png 输出 png；写到 stdout
      const buf = execFileSync("screencapture", ["-x", "-t", "png", "-"], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      return buf;
    }
    if (isLinux()) {
      // scrot 写到 stdout 用 -
      const buf = execFileSync("scrot", ["-z", "-"], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      return buf;
    }
    throw new Error(`screenshot not supported on platform: ${process.platform}`);
  }

  async mouseClick(
    x: number,
    y: number,
    button: MouseButton,
    doubleClick: boolean,
  ): Promise<void> {
    if (isWindows()) {
      runPowerShell(psMouseScript(x, y, button, doubleClick));
      return;
    }
    if (isMacos()) {
      // cliclick: c:x,y = 单击；dc:x,y = 双击；rc: 右键；mc: 中键
      const prefix = doubleClick ? "d" : "";
      const btn = button === "left" ? "c" : button === "right" ? "rc" : "mc";
      execFileSync("cliclick", [`${prefix}${btn}:${x},${y}`], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    if (isLinux()) {
      // 先移动再点击；button 映射 1=left 2=middle 3=right
      const btnNum = button === "left" ? 1 : button === "middle" ? 2 : 3;
      execFileSync("xdotool", ["mousemove", String(x), String(y)], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      const clickArgs = ["click", String(btnNum)];
      if (doubleClick) clickArgs.push("--repeat", "2");
      execFileSync("xdotool", clickArgs, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
      return;
    }
    throw new Error(`mouseClick not supported on platform: ${process.platform}`);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    if (isWindows()) {
      runPowerShell(psMouseMoveScript(x, y));
      return;
    }
    if (isMacos()) {
      execFileSync("cliclick", [`m:${x},${y}`], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    if (isLinux()) {
      execFileSync("xdotool", ["mousemove", String(x), String(y)], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    throw new Error(`mouseMove not supported on platform: ${process.platform}`);
  }

  async mouseDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    if (isWindows()) {
      runPowerShell(psMouseDragScript(fromX, fromY, toX, toY));
      return;
    }
    if (isMacos()) {
      // cliclick: dd: 按下，du: 释放，配合 m: 移动
      execFileSync(
        "cliclick",
        [`dd:${fromX},${fromY}`, `m:${toX},${toY}`, `du:${toX},${toY}`],
        { stdio: "pipe", timeout: EXEC_TIMEOUT_MS },
      );
      return;
    }
    if (isLinux()) {
      // xdotool: mousemove → mousedown 1 → mousemove → mouseup 1
      execFileSync("xdotool", ["mousemove", String(fromX), String(fromY)], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      execFileSync("xdotool", ["mousedown", "1"], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      execFileSync("xdotool", ["mousemove", String(toX), String(toY)], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      execFileSync("xdotool", ["mouseup", "1"], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    throw new Error(`mouseDrag not supported on platform: ${process.platform}`);
  }

  async mouseScroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    const amt = Math.max(1, Math.floor(amount));
    if (isWindows()) {
      runPowerShell(psMouseScrollScript(x, y, direction, amt));
      return;
    }
    if (isMacos()) {
      // cliclick scroll: 正数向上，负数向下
      const delta = direction === "up" ? amt : -amt;
      execFileSync("cliclick", [`m:${x},${y}`, `scroll:${delta}`], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    if (isLinux()) {
      // xdotool click 4=up 5=down，重复 amt 次
      const btn = direction === "up" ? 4 : 5;
      execFileSync("xdotool", ["mousemove", String(x), String(y)], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      for (let i = 0; i < amt; i++) {
        execFileSync("xdotool", ["click", String(btn)], {
          stdio: "pipe",
          timeout: EXEC_TIMEOUT_MS,
        });
      }
      return;
    }
    throw new Error(`mouseScroll not supported on platform: ${process.platform}`);
  }

  async keyType(text: string): Promise<void> {
    if (isWindows()) {
      runPowerShell(psKeyTypeScript(text));
      return;
    }
    if (isMacos()) {
      // cliclick t:"text"
      execFileSync("cliclick", [`t:${text}`], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    if (isLinux()) {
      execFileSync("xdotool", ["type", "--", text], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    throw new Error(`keyType not supported on platform: ${process.platform}`);
  }

  async keyPress(keys: string[]): Promise<void> {
    if (keys.length === 0) throw new Error("keyPress requires at least one key");
    if (isWindows()) {
      runPowerShell(psKeyPressScript(keys));
      return;
    }
    if (isMacos()) {
      // cliclick: kd:ctrl kp:c ku:ctrl
      const codes = keys.map((k) => cliclickKeyCode(k));
      if (codes.some((c) => c === null)) {
        throw new Error(`Unsupported key in: ${keys.join("+")}`);
      }
      const seq: string[] = [];
      const heldDown: string[] = [];
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i] as string;
        const isModifier = ["ctrl", "shift", "alt", "cmd"].includes(keys[i].toLowerCase());
        if (isModifier) {
          seq.push(`kd:${code}`);
          heldDown.push(`ku:${code}`);
        } else {
          seq.push(`kp:${code}`);
        }
      }
      seq.push(...heldDown.reverse());
      execFileSync("cliclick", seq, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
      return;
    }
    if (isLinux()) {
      // xdotool key ctrl+c
      const xdoKeys = keys.map((k) => k.toLowerCase());
      execFileSync("xdotool", ["key", xdoKeys.join("+")], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    throw new Error(`keyPress not supported on platform: ${process.platform}`);
  }

  async windowList(): Promise<WindowInfo[]> {
    if (isMacos()) {
      // osascript 获取可见窗口列表
      const script =
        'tell application "System Events" to get name of every process whose visible is true';
      const out = execFileSync("osascript", ["-e", script], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      })
        .toString("utf8")
        .trim();
      return out.split(", ").map((title, idx) => ({
        id: String(idx),
        title,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      }));
    }
    if (isLinux()) {
      // wmctrl -l
      const out = execFileSync("wmctrl", ["-l"], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      })
        .toString("utf8")
        .trim();
      if (!out) return [];
      return out.split("\n").map((line) => {
        const id = line.slice(0, 10).trim();
        const rest = line.slice(11).trim();
        const title = rest.split(/\s{2,}/).slice(1).join(" ") || rest;
        return {
          id,
          title,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        };
      });
    }
    // Windows 窗口列表需要更复杂的 EnumWindows，暂不支持，返回空
    return [];
  }

  async windowFocus(windowId: string): Promise<void> {
    if (isLinux()) {
      execFileSync("wmctrl", ["-i", "-a", windowId], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    if (isMacos()) {
      execFileSync("open", ["-a", windowId], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      });
      return;
    }
    throw new Error(`windowFocus not supported on platform: ${process.platform}`);
  }

  async getScreenSize(): Promise<ScreenSize> {
    if (isWindows()) {
      const out = runPowerShell(PS_SCREENSIZE);
      const [w, h] = out.split("x").map((n) => parseInt(n, 10));
      if (!Number.isFinite(w) || !Number.isFinite(h)) {
        throw new Error(`Failed to parse screen size: ${out}`);
      }
      return { width: w, height: h };
    }
    if (isMacos()) {
      const out = execFileSync(
        "osascript",
        ["-e", 'tell application "Finder" to get bounds of window of desktop'],
        { stdio: "pipe", timeout: EXEC_TIMEOUT_MS },
      )
        .toString("utf8")
        .trim();
      // "0, 0, 2560, 1440"
      const parts = out.split(",").map((s) => parseInt(s.trim(), 10));
      return { width: parts[2] - parts[0], height: parts[3] - parts[1] };
    }
    if (isLinux()) {
      const out = execFileSync("xdotool", ["getdisplaygeometry"], {
        stdio: "pipe",
        timeout: EXEC_TIMEOUT_MS,
      })
        .toString("utf8")
        .trim();
      const [w, h] = out.split(/\s+/).map((n) => parseInt(n, 10));
      return { width: w, height: h };
    }
    throw new Error(`getScreenSize not supported on platform: ${process.platform}`);
  }
}

/** 重置可用性缓存（仅供测试使用） */
export function resetNativeBackendAvailabilityCache(): void {
  availabilityCache = null;
}
