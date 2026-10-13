/**
 * P1-1 Bot Mode RoomManager：@mention 路由 + 房间生命周期测试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { RoomManager, parseAgentMentions } from "./room-manager";

describe("P1-1 RoomManager", () => {
  let tmpDir: string;
  let manager: RoomManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-manager-test-"));
    manager = new RoomManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── createRoom / getRoomByGroup ──

  it("createRoom 生成 id/history/createdAt，getRoomByGroup 命中", () => {
    const room = manager.createRoom({
      channel: "telegram",
      groupId: "grp-1",
      agentIds: ["a1", "a2"],
    });
    expect(room.id).toMatch(/^room_/);
    expect(room.history).toEqual([]);
    expect(room.createdAt).toBeTypeOf("number");

    const found = manager.getRoomByGroup("telegram", "grp-1");
    expect(found?.id).toBe(room.id);
    // 不同 channel/groupId 未命中
    expect(manager.getRoomByGroup("telegram", "grp-2")).toBeNull();
    expect(manager.getRoomByGroup("discord", "grp-1")).toBeNull();
  });

  it("createRoom 持久化到 data/rooms/{id}.json，loadAll 可重建", () => {
    const room = manager.createRoom({
      channel: "webchat",
      groupId: "g-9",
      agentIds: ["x"],
    });
    const file = path.join(tmpDir, "rooms", `${room.id}.json`);
    expect(fs.existsSync(file)).toBe(true);

    const fresh = new RoomManager(tmpDir);
    const loaded = fresh.loadAll();
    expect(loaded).toBe(1);
    expect(fresh.getRoomByGroup("webchat", "g-9")?.id).toBe(room.id);
  });

  // ── resolveSpeaker ──

  it("@mention 命中成员 agentId 优先", () => {
    const room = manager.createRoom({
      channel: "telegram",
      groupId: "g",
      agentIds: ["alice", "bob"],
    });
    expect(manager.resolveSpeaker(room.id, { text: "@bob do it" })).toBe("bob");
  });

  it("无 @mention 时按 history 末尾发言者轮询推进", () => {
    const room = manager.createRoom({
      channel: "telegram",
      groupId: "g",
      agentIds: ["a", "b", "c"],
    });
    // 初始（history 空）→ 从 index 0 开始
    expect(manager.resolveSpeaker(room.id, { text: "hello" })).toBe("a");
    // a 发言后 → b
    manager.appendTurn(room.id, { agentId: "a", agentName: "a", role: "a", content: "hi", timestamp: Date.now() });
    expect(manager.resolveSpeaker(room.id, { text: "next" })).toBe("b");
    // b 发言后 → c；c 发言后 → 轮回到 a
    manager.appendTurn(room.id, { agentId: "b", agentName: "b", role: "b", content: "yo", timestamp: Date.now() });
    expect(manager.resolveSpeaker(room.id, { text: "next" })).toBe("c");
    manager.appendTurn(room.id, { agentId: "c", agentName: "c", role: "c", content: "sup", timestamp: Date.now() });
    expect(manager.resolveSpeaker(room.id, { text: "next" })).toBe("a");
  });

  it("未知 roomId / 空成员房间 resolveSpeaker 返回 null", () => {
    expect(manager.resolveSpeaker("nope", { text: "x" })).toBeNull();
    const empty = manager.createRoom({ channel: "t", groupId: "g", agentIds: [] });
    expect(manager.resolveSpeaker(empty.id, { text: "x" })).toBeNull();
  });

  // ── parseAgentMentions ──

  it("parseAgentMentions 只匹配 agentIds 内的成员，忽略普通 @ 用法", () => {
    expect(parseAgentMentions("@alice please", ["alice", "bob"])).toEqual(["alice"]);
    // @carol 不在成员列表 → 不返回
    expect(parseAgentMentions("@carol and @bob", ["alice", "bob"])).toEqual(["bob"]);
    // 空文本
    expect(parseAgentMentions("", ["alice"])).toEqual([]);
  });
});
