/**
 * 命令可用性探测（跨平台、健壮）
 *
 * ## 为什么不能直接用 `where` / `which`
 *
 * 真实事故（2026-10-07）：用户用 pwsh 装好 `mineru-open-api` 后，技能仍然报
 * `Required binary "mineru-open-api" is not found in PATH`，点「一键安装缺失工具」也无反应。
 *
 * 根因是原实现只依赖 `execFileSync("where", [bin])`，而这条路径在真实环境里
 * **对任何二进制都失败**，包括确定已安装的 `node` / `python`：
 *
 *   1. `spawnSync where EBUSY`
 *      —— WorkBuddy 注入的 shim 目录（`.../cli/vendor/shim/safe-bin`）会让
 *         spawn 同步调用失败，而 `execFileSync` 正是同步 spawn。
 *   2. `process.env.PATH` 本身可能是畸形的：实测出现裸 `C` 段（驱动器相对路径）
 *      与被截断的条目，任何基于 PATH 拼接的方案都必须能容忍。
 *   3. Windows 上 npm 全局包落在 `%APPDATA%\npm`、pip 用户包落在
 *      `%APPDATA%\Python\PythonXY\Scripts`，这两个目录**常常不在 PATH 里**。
 *      用户「装过了」却检测不到，多半就是这种情况。
 *
 * 因此本模块采取「多路探测，任一命中即视为存在」：
 *   ① 直接尝试执行 `--version`（最权威）
 *   ② 扫描 PATH 各目录（按平台补齐可执行扩展名）
 *   ③ 扫描 Windows 常见的用户级安装目录（npm/pip）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** Windows 上可执行文件的扩展名候选（PATHEXT 常见值） */
const WIN_EXTENSIONS = ["", ".exe", ".cmd", ".bat", ".com", ".ps1"];

/** Windows 上 npm / pip 常用的用户级安装目录（常常不在 PATH 中） */
function windowsExtraDirs(): string[] {
  const dirs: string[] = [];
  const push = (p?: string) => {
    if (p && !dirs.includes(p)) dirs.push(p);
  };
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  push(appData ? path.join(appData, "npm") : undefined);
  if (appData) {
    // pip 用户级安装：%APPDATA%\Python\PythonXY\Scripts
    const pyRoot = path.join(appData, "Python");
    try {
      for (const entry of fs.readdirSync(pyRoot)) {
        push(path.join(pyRoot, entry, "Scripts"));
      }
    } catch {
      /* 目录不存在时忽略 */
    }
  }
  if (localAppData) {
    push(path.join(localAppData, "Microsoft", "WindowsApps"));
    push(path.join(localAppData, "Programs", "Python"));
  }
  return dirs;
}

/** 把 PATH 切成目录列表；容忍畸形条目（空串、裸驱动器、不可解析） */
function pathDirs(): string[] {
  const raw = String(process.env.PATH || "").split(path.delimiter);
  const out: string[] = [];
  for (const p of raw) {
    const trimmed = p.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    // 裸驱动器（如 `C`）是驱动器相对路径，既危险又无法命中，直接丢弃
    if (/^[A-Za-z]$/.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** 在单个目录里找可执行文件 */
function findInDir(dir: string, bin: string): string | null {
  const exts = process.platform === "win32" ? WIN_EXTENSIONS : ["", ".sh"];
  for (const ext of exts) {
    const candidate = path.join(dir, bin + ext);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* 继续试下一个扩展名 */
    }
  }
  return null;
}

/**
 * 探测命令是否可用。
 * @returns 可用时返回解析到的绝对路径；不可用时返回 null
 */
export function findExecutable(bin: string): string | null {
  const name = String(bin || "").trim();
  if (!name) return null;
  // 已经是绝对路径且存在 → 直接可用
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    try {
      if (fs.statSync(name).isFile()) return name;
    } catch {
      return null;
    }
  }

  const isWin = process.platform === "win32";

  // ① 直接执行探测（最权威）。用 spawnSync 异步版本不可用，这里用 execFileSync；
  //    即便 EBUSY 失败也只是这一路失败，会继续走 ② ③。
  try {
    const probe = isWin ? "where.exe" : "which";
    const out = execFileSync(probe, [name], {
      stdio: "pipe",
      timeout: 5000,
      windowsHide: true,
    })
      .toString()
      .trim();
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  } catch {
    /* 继续走目录扫描 */
  }

  // ② 扫描 PATH
  for (const dir of pathDirs()) {
    const hit = findInDir(dir, name);
    if (hit) return hit;
  }

  // ③ Windows 用户级安装目录（npm / pip）
  if (isWin) {
    for (const dir of windowsExtraDirs()) {
      const hit = findInDir(dir, name);
      if (hit) return hit;
    }
  }

  return null;
}

/** 布尔版：命令是否可用 */
export function commandExists(bin: string): boolean {
  return findExecutable(bin) !== null;
}