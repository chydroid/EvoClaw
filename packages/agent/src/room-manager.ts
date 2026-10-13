/**
 * RoomManager — P1-1 Bot Mode 群聊房间管理。
 *
 * 对标 Hermes Bot Mode"命名智能体社会 + 群聊房间 + @mention 编排"：
 * - Room 实体：绑定某条 channel 的 groupId 与一组 AgentConfig 成员
 * - resolveSpeaker：@mention 命中优先，否则走 selectorFn（默认轮询）
 * - 持久化：atomicWriteFile → data/rooms/{id}.json（遵守 AGENTS.md 原子写约束）
 *
 * 双 schema 约束（roadmap P1-1 风险项）：Room 成员直接引用
 * `AgentRouter.AgentConfig`，不牵动核心 `Agent` 类，池 worker 维持匿名。
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { atomicWriteFileSync } from "@evoclaw/core";
import type { AgentConfig } from "./agent-router";
import type { ChatTurn, SelectorFn } from "./multi-agent-patterns";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 群聊房间实体 */
export interface Room {
  /** 唯一房间 ID */
  id: string;
  /** 挂在哪条 channel（webchat/telegram/discord...） */
  channel: string;
  /** ChannelMessage.groupId */
  groupId: string;
  /** 成员 agent（引用 AgentConfig.id） */
  agentIds: string[];
  /** 对话历史（复用 GroupChat.ChatTurn 结构） */
  history: ChatTurn[];
  /** @mention 未命中时的发言者选择策略（默认轮询） */
  selectorFn?: SelectorFn;
  /** 创建时间戳 */
  createdAt: number;
}

/** Room 创建入参（id/history 由 RoomManager 生成/初始化） */
export type RoomSpec = Omit<Room, "id" | "history" | "createdAt">;

/** @mention 路由入参 */
export interface ResolveSpeakerInput {
  text: string;
  /** 发言者标识（用于默认轮询的记忆与去重，可选） */
  from?: string;
}

// ─── RoomManager ──────────────────────────────────────────────────────────────

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** (channel, groupId) → roomId 快速索引 */
  private groupIndex = new Map<string, string>();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.join(dataDir, "rooms");
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ── 房间 CRUD ──

  /** 创建房间并持久化（原子写） */
  createRoom(spec: RoomSpec): Room {
    const room: Room = {
      ...spec,
      id: `room_${randomUUID()}`,
      history: [],
      createdAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    this.groupIndex.set(this.groupKey(room.channel, room.groupId), room.id);
    this.persist(room);
    process.stdout.write(`[RoomManager] Created room "${room.id}" (${room.channel}/${room.groupId}) with ${room.agentIds.length} agent(s)\n`);
    return room;
  }

  /** 按 (channel, groupId) 查找房间（未命中返回 null，调用方回退默认 agent） */
  getRoomByGroup(channel: string, groupId: string): Room | null {
    const roomId = this.groupIndex.get(this.groupKey(channel, groupId));
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  listRooms(): Room[] {
    return [...this.rooms.values()];
  }

  removeRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.groupIndex.delete(this.groupKey(room.channel, room.groupId));
    this.rooms.delete(roomId);
    try {
      fs.unlinkSync(this.roomFile(roomId));
    } catch {
      // best-effort 删除，不影响内存态一致性
    }
    return true;
  }

  // ── @mention 路由 ──

  /**
   * 解析下一条消息应由哪个 agent 发言：
   * 1. 先解析 @agentName / @agentId → 命中成员即返回（mention 优先）
   * 2. 未命中则调用 room.selectorFn（可选），否则默认轮询（按 history 末尾发言者推进）
   *
   * 未解析出任何可用成员时返回 null（调用方维持默认 agent 行为，向后兼容）。
   */
  resolveSpeaker(roomId: string, message: ResolveSpeakerInput): string | null {
    const room = this.rooms.get(roomId);
    if (!room || room.agentIds.length === 0) return null;

    // 1. @mention 命中（正则 @(\w+)，匹配成员名或 id）
    const mentioned = parseAgentMentions(message.text, room.agentIds);
    if (mentioned.length > 0) {
      return mentioned[0];
    }

    // 2. 自定义 selector（注入时用 GroupChat 同款 SelectorFn 语义，简化为同步返回 agentId）
    if (room.selectorFn) {
      const speaker = room.selectorFn(
        room.agentIds.map((id) => ({ id, name: id, role: "member", systemPrompt: "" })),
        room.history,
        message.text,
      );
      // SelectorFn 为 async 返回 AgentSpeaker | undefined；RoomManager 侧仅取同步可用结果
      const resolved = speaker && typeof speaker === "object" ? (speaker as { id?: string }).id : undefined;
      if (resolved && room.agentIds.includes(resolved)) return resolved;
    }

    // 3. 默认轮询：从 history 末尾发言者的下一位开始
    const lastSpeaker = room.history.length > 0 ? room.history[room.history.length - 1].agentId : null;
    const idx = lastSpeaker ? room.agentIds.indexOf(lastSpeaker) : -1;
    return room.agentIds[(idx + 1) % room.agentIds.length];
  }

  /** 追加一轮对话到房间历史并持久化（原子写） */
  appendTurn(roomId: string, turn: ChatTurn): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.history.push(turn);
    this.persist(room);
  }

  // ── 持久化 ──

  /** 从 data/rooms/ 加载已持久化房间（server 启动时调用，重建内存索引） */
  loadAll(): number {
    if (!fs.existsSync(this.dataDir)) return 0;
    let count = 0;
    for (const file of fs.readdirSync(this.dataDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dataDir, file), "utf-8");
        const room = JSON.parse(raw) as Room;
        this.rooms.set(room.id, room);
        this.groupIndex.set(this.groupKey(room.channel, room.groupId), room.id);
        count++;
      } catch {
        process.stderr.write(`[RoomManager] Failed to load room file ${file}\n`);
      }
    }
    return count;
  }

  private persist(room: Room): void {
    try {
      atomicWriteFileSync(this.roomFile(room.id), JSON.stringify(room, null, 2));
    } catch (err) {
      process.stderr.write(
        `[RoomManager] Failed to persist room "${room.id}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private roomFile(roomId: string): string {
    return path.join(this.dataDir, `${roomId}.json`);
  }

  private groupKey(channel: string, groupId: string): string {
    return `${channel}::${groupId}`;
  }
}

/**
 * 解析文本中 @agentName / @agentId 形式的提及（P1-1 @mention 路由）。
 * 仅匹配 `agentIds` 中的成员（按 name/id），避免误伤普通 @ 符号用法。
 */
export function parseAgentMentions(text: string, agentIds: string[]): string[] {
  if (!text) return [];
  const mentionRegex = /@([A-Za-z0-9_-]+)/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const candidate = match[1];
    if (agentIds.includes(candidate)) {
      found.add(candidate);
    }
  }
  return [...found];
}
