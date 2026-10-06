import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SessionArchiveStore,
  computeKeepFromIndex,
  DEFAULT_WINDOW_ROUNDS,
  ARCHIVE_TAG,
  type ArchiveTurn,
  type LongTermLike,
} from "./session-archive";
import type { MemoryEntry, MemorySearchQuery, MemorySearchResult } from "@evoclaw/core";

/** 构造 user/assistant 交替的历史 */
function makeTurns(rounds: number): ArchiveTurn[] {
  const out: ArchiveTurn[] = [];
  for (let i = 1; i <= rounds; i++) {
    out.push({ role: "user", content: `第${i}轮提问`, timestamp: new Date(2026, 0, i).toISOString() });
    out.push({ role: "assistant", content: `第${i}轮回答`, timestamp: new Date(2026, 0, i).toISOString() });
  }
  return out;
}

/** 内存版 long-term store，记录写入条目并支持 tags 检索 */
function makeFakeLongTerm(): LongTermLike & { entries: MemoryEntry[] } {
  const entries: MemoryEntry[] = [];
  return {
    entries,
    async store(entry: MemoryEntry) {
      const withId = { ...entry, id: `mem-${entries.length + 1}` };
      entries.push(withId);
      return withId;
    },
    async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
      let out = entries;
      if (query.tags?.length) {
        out = out.filter((e) => query.tags!.every((t) => e.metadata.tags.includes(t)));
      }
      if (query.query) {
        const q = query.query;
        const matched = out.filter((e) => e.content.includes(q));
        if (matched.length > 0) out = matched;
      }
      return out.slice(0, query.limit ?? out.length).map((entry) => ({
        entry,
        score: 1,
        matchedFields: ["content"],
      }));
    },
  };
}

describe("computeKeepFromIndex", () => {
  it("user 消息不足轮数时全部保留", () => {
    const roles = ["user", "assistant", "user", "assistant"];
    expect(computeKeepFromIndex(roles, 10)).toBe(0);
  });

  it("恰好保留最近 N 轮（含其后的 assistant）", () => {
    const roles = makeTurns(15).map((t) => t.role); // 15 轮
    const keepFrom = computeKeepFromIndex(roles, 10);
    // 第 6 轮 user 的下标 = (6-1)*2 = 10
    expect(keepFrom).toBe(10);
    const kept = roles.slice(keepFrom);
    expect(kept.filter((r) => r === "user").length).toBe(10);
  });

  it("轮数 <= 0 时不限制", () => {
    const roles = makeTurns(3).map((t) => t.role);
    expect(computeKeepFromIndex(roles, 0)).toBe(0);
    expect(computeKeepFromIndex(roles, -1)).toBe(0);
  });

  it("空历史返回 0", () => {
    expect(computeKeepFromIndex([], 10)).toBe(0);
  });

  it("默认窗口为 10 轮", () => {
    expect(DEFAULT_WINDOW_ROUNDS).toBe(10);
  });
});

describe("SessionArchiveStore", () => {
  let tmpDir: string;
  let store: SessionArchiveStore;
  let longTerm: ReturnType<typeof makeFakeLongTerm>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-archive-"));
    store = new SessionArchiveStore(tmpDir);
    longTerm = makeFakeLongTerm();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("超出窗口的历史被写入长期记忆，且带归档 tag", async () => {
    const turns = makeTurns(15);
    const r = await store.archiveOlderTurns("sess-1", turns, longTerm, 10);

    expect(r.keepFrom).toBe(10);
    expect(r.newlyArchived).toBe(10); // 前 5 轮 = 10 条
    expect(longTerm.entries.length).toBe(10);
    expect(longTerm.entries.every((e) => e.metadata.tags.includes(ARCHIVE_TAG))).toBe(true);
    expect(longTerm.entries[0].content).toContain("第1轮提问");
    // 窗口内的最后 10 轮不被归档
    expect(longTerm.entries.some((e) => e.content.includes("第10轮提问"))).toBe(false);
    expect(longTerm.entries.some((e) => e.content.includes("第6轮提问"))).toBe(false);
  });

  it("幂等：重复调用不会重复归档", async () => {
    const turns = makeTurns(15);
    await store.archiveOlderTurns("sess-1", turns, longTerm, 10);
    const second = await store.archiveOlderTurns("sess-1", turns, longTerm, 10);

    expect(second.newlyArchived).toBe(0);
    expect(longTerm.entries.length).toBe(10);
  });

  it("游标持久化：换新实例仍不重复归档", async () => {
    const turns = makeTurns(15);
    await store.archiveOlderTurns("sess-2", turns, longTerm, 10);
    const fresh = new SessionArchiveStore(tmpDir);
    const r = await fresh.archiveOlderTurns("sess-2", turns, longTerm, 10);
    expect(r.newlyArchived).toBe(0);
    expect(longTerm.entries.length).toBe(10);
  });

  it("历史增长时只归档新增的旧轮次", async () => {
    await store.archiveOlderTurns("sess-3", makeTurns(15), longTerm, 10);
    // 增长到 20 轮：活动窗口右移为第 11~20 轮，新增归档的是第 6~10 轮
    const grown = makeTurns(20);
    const r = await store.archiveOlderTurns("sess-3", grown, longTerm, 10);
    expect(r.keepFrom).toBe(20);
    expect(r.newlyArchived).toBe(10); // 第 6~10 轮，共 5 轮 = 10 条
    expect(longTerm.entries.length).toBe(20);
    // 第 10 轮刚被归档进窗口外，第 11 轮仍留在活动窗口内
    expect(longTerm.entries.some((e) => e.content.includes("第10轮提问"))).toBe(true);
    expect(longTerm.entries.some((e) => e.content.includes("第11轮提问"))).toBe(false);
  });

  it("transcript 被重写变短时游标被夹住，不越界", async () => {
    await store.archiveOlderTurns("sess-4", makeTurns(30), longTerm, 10);
    // 模拟 compaction 重写成很短的 transcript
    const r = await store.archiveOlderTurns("sess-4", makeTurns(3), longTerm, 10);
    expect(r.keepFrom).toBe(0);
    expect(r.newlyArchived).toBe(0);
  });

  it("历史不足窗口时不产生任何归档", async () => {
    const r = await store.archiveOlderTurns("sess-5", makeTurns(4), longTerm, 10);
    expect(r.keepFrom).toBe(0);
    expect(r.newlyArchived).toBe(0);
    expect(longTerm.entries.length).toBe(0);
  });

  it("空内容条目被跳过，不写入空记忆", async () => {
    const turns: ArchiveTurn[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "   " },
      ...makeTurns(15),
    ];
    await store.archiveOlderTurns("sess-6", turns, longTerm, 10);
    expect(longTerm.entries.every((e) => e.content.trim().length > 0)).toBe(true);
  });

  it("longTerm 不可用时静默降级，不抛异常", async () => {
    const r = await store.archiveOlderTurns("sess-7", makeTurns(15), undefined, 10);
    expect(r.newlyArchived).toBe(0);
    expect(r.keepFrom).toBe(10);
  });

  it("store 抛错时不推进游标，保留可重试性", async () => {
    let calls = 0;
    const flaky: LongTermLike = {
      async store(e: MemoryEntry) {
        calls++;
        if (calls > 2) throw new Error("disk full");
        return e;
      },
      async search() { return []; },
    };
    const r = await store.archiveOlderTurns("sess-8", makeTurns(15), flaky, 10);
    expect(r.newlyArchived).toBe(2); // 失败后 break
    expect(store.readArchivedCount("sess-8")).toBe(2);
  });

  it("recallArchived 只返回本会话的归档条目", async () => {
    await store.archiveOlderTurns("sess-mine", makeTurns(15), longTerm, 10);
    await store.archiveOlderTurns("sess-other", makeTurns(15), longTerm, 10);
    expect(longTerm.entries.length).toBe(20);

    const recalled = await store.recallArchived(longTerm, "sess-mine", "第1轮提问", 10);
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled.every((r) => r.entry.metadata.sessionId === "sess-mine")).toBe(true);
  });

  it("recallArchived 在无 longTerm / 空 query 时安全返回", async () => {
    expect(await store.recallArchived(undefined, "s", "q")).toEqual([]);
    expect(await store.recallArchived(longTerm, "s", "")).toEqual([]);
  });

  it("sessionId 含非法文件名字符时不会逃逸目录", async () => {
    const evil = "../../etc/passwd";
    await store.archiveOlderTurns(evil, makeTurns(15), longTerm, 10);
    const markerDir = path.join(tmpDir, "session-archive");
    const files = fs.readdirSync(markerDir);
    expect(files.length).toBe(1);
    // 清洗后不含路径分隔符，也不含 ".."，无法穿越目录
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain("\\");
    expect(files[0]).not.toContain("..");
    expect(path.resolve(markerDir, files[0]).startsWith(path.resolve(markerDir))).toBe(true);
  });

  it("清洗后同名但不同的 sessionId 不碰撞", async () => {
    await store.archiveOlderTurns("a.b", makeTurns(15), longTerm, 10);
    await store.archiveOlderTurns("a_b", makeTurns(15), longTerm, 10);
    const files = fs.readdirSync(path.join(tmpDir, "session-archive"));
    expect(files.length).toBe(2);
    // 各自只归档一次，不因文件名碰撞而互相覆盖游标
    expect(store.readArchivedCount("a.b")).toBe(10);
    expect(store.readArchivedCount("a_b")).toBe(10);
  });
});
