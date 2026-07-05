/**
 * StorageContext — 不可变路径上下文，多 session / 多 agent 隔离。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/offload/storage.ts` StorageContext：
 * - 把所有数据路径集中到一个不可变对象，避免散落字符串拼接
 * - `Object.freeze()` 冻结，防止运行时被篡改
 * - 支持 `agent:<name>:<id>` 格式的 sessionKey，自动隔离 worker 目录
 * - `parseSessionKey` 处理 `swebench-w{N}` worker 隔离
 *
 * 与 EvoClaw 已有 `dataDir` 拼接的区别：
 * - 旧代码：每个模块自己 `path.join(dataDir, "memory", "layered", ...)`
 * - 新代码：统一从 StorageContext 取路径，保证一致性 + 可测试性
 */

import * as path from "path";

/** StorageContext 不可变路径上下文。 */
export interface StorageContext {
  /** 数据根目录。 */
  readonly dataRoot: string;
  /** 当前 session 的数据目录（含 sessionKey 隔离）。 */
  readonly dataDir: string;
  /** 引用文件目录（工具结果原文）。 */
  readonly refsDir: string;
  /** Mermaid 文件目录。 */
  readonly mmdsDir: string;
  /** offload JSONL 文件路径。 */
  readonly offloadJsonl: string;
  /** 状态文件路径。 */
  readonly stateFile: string;
  /** L0 对话文件目录。 */
  readonly conversationsDir: string;
  /** L1 记忆文件路径（JSONL）。 */
  readonly l1File: string;
  /** L2 场景块目录。 */
  readonly scenesDir: string;
  /** L3 画像文件路径。 */
  readonly personaFile: string;
  /** 画布快照文件路径。 */
  readonly canvasFile: string;
  /** 原始 sessionKey。 */
  readonly sessionKey: string;
  /** 解析后的 agent 名（若有）。 */
  readonly agentName?: string;
  /** 解析后的 agent ID（若有）。 */
  readonly agentId?: string;
}

/**
 * 解析 sessionKey 为 agent name + id。
 * 支持格式：
 *   - `agent:<name>:<id>` → { agentName, agentId }
 *   - `swebench-w{N}` → { agentName: "swebench", agentId: "w{N}" }
 *   - 普通字符串 → 原样返回
 */
export function parseSessionKey(sessionKey: string): {
  sessionKey: string;
  agentName?: string;
  agentId?: string;
} {
  // agent:<name>:<id>
  const agentMatch = sessionKey.match(/^agent:([^:]+):(.+)$/);
  if (agentMatch) {
    return {
      sessionKey,
      agentName: agentMatch[1],
      agentId: agentMatch[2],
    };
  }
  // swebench-w{N}
  const swebenchMatch = sessionKey.match(/^(swebench)-w(\d+)$/);
  if (swebenchMatch) {
    return {
      sessionKey,
      agentName: swebenchMatch[1],
      agentId: `w${swebenchMatch[2]}`,
    };
  }
  return { sessionKey };
}

/**
 * 把 sessionKey 转换为安全的目录名（防止路径穿越）。
 */
export function safeDirName(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64) || "default";
}

/**
 * 创建不可变 StorageContext。
 *
 * @param dataRoot 数据根目录
 * @param sessionKey 会话键
 * @returns 冻结的 StorageContext 对象
 */
export function createStorageContext(dataRoot: string, sessionKey: string): StorageContext {
  const parsed = parseSessionKey(sessionKey);
  const safeKey = safeDirName(sessionKey);

  // 多 session 隔离：每个 sessionKey 独立子目录
  const dataDir = path.join(dataRoot, "memory", "layered", "sessions", safeKey);
  const refsDir = path.join(dataDir, "refs");
  const mmdsDir = path.join(dataDir, "mmds");
  const conversationsDir = path.join(dataDir, "conversations");
  const scenesDir = path.join(dataDir, "scene_blocks");

  const ctx: StorageContext = {
    dataRoot,
    dataDir,
    refsDir,
    mmdsDir,
    offloadJsonl: path.join(dataDir, "offload.jsonl"),
    stateFile: path.join(dataDir, "state.json"),
    conversationsDir,
    l1File: path.join(dataDir, "l1.jsonl"),
    scenesDir,
    personaFile: path.join(dataRoot, "memory", "layered", "persona.md"), // 画像全局共享
    canvasFile: path.join(dataDir, "canvas.json"),
    sessionKey,
    agentName: parsed.agentName,
    agentId: parsed.agentId,
  };

  return Object.freeze(ctx);
}

/**
 * 创建全局共享的 StorageContext（不按 session 隔离）。
 *
 * 用于兼容旧版本的全局数据布局（升级时数据迁移用）。
 */
export function createGlobalStorageContext(dataRoot: string): StorageContext {
  const dataDir = path.join(dataRoot, "memory", "layered");
  const ctx: StorageContext = {
    dataRoot,
    dataDir,
    refsDir: path.join(dataDir, "refs"),
    mmdsDir: path.join(dataDir, "mmds"),
    offloadJsonl: path.join(dataDir, "offload.jsonl"),
    stateFile: path.join(dataDir, "state.json"),
    conversationsDir: path.join(dataDir, "conversations"),
    l1File: path.join(dataDir, "l1.jsonl"),
    scenesDir: path.join(dataDir, "scene_blocks"),
    personaFile: path.join(dataDir, "persona.md"),
    canvasFile: path.join(dataDir, "canvas.json"),
    sessionKey: "__global__",
  };
  return Object.freeze(ctx);
}
