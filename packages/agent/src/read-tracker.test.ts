import { describe, it, expect, beforeEach } from "vitest";
import { ReadTracker, CONSECUTIVE_READ_BLOCK } from "./read-tracker";

/** per-session 读追踪回归测试（对标 hermes file_tools_read_tracking 语义）。 */
describe("ReadTracker — dedup stub → BLOCK", () => {
  let rt: ReadTracker;
  beforeEach(() => {
    ReadTracker.resetInstance();
    rt = ReadTracker.getInstance();
  });

  it("首次读 → allow；同 version 二次读 → stub；第三次 → block", () => {
    const sid = "s1";
    // 首读：allow，然后记账
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("allow");
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    // 二次读（文件未变）：stub
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("stub");
    // stub 不调 noteReadServed（内容没回给模型）；再读 → block
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("block");
  });

  it("文件 version 变化 → 重新 allow（stub 不得吞掉新内容）", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("stub");
    // 文件被写 → noteWriteServed 使 dedup 失效
    rt.noteWriteServed(sid, "/f.txt", "v2");
    expect(rt.checkBeforeRead(sid, "/f.txt", "v2", 1, undefined).action).toBe("allow");
  });

  it("offset/limit 不同的读不互吞", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, 10);
    rt.noteReadServed(sid, "/f.txt", "v1", 1, 10, 10, 100, false);
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 11, 10).action).toBe("allow");
  });

  it("version 未知（null）→ 永不 dedup（宁多读不误 stub）", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", null, 1, undefined);
    rt.noteReadServed(sid, "/f.txt", null, 1, undefined, 10, 10, false);
    expect(rt.checkBeforeRead(sid, "/f.txt", null, 1, undefined).action).toBe("allow");
  });
});

describe("ReadTracker — 连续循环检测", () => {
  let rt: ReadTracker;
  beforeEach(() => {
    ReadTracker.resetInstance();
    rt = ReadTracker.getInstance();
  });

  it("同 key 连续读计数递增，换 key 重置", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    const v2 = rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    expect(v2.consecutive).toBe(2);
    const v3 = rt.checkBeforeRead(sid, "/g.txt", "v1", 1, undefined);
    expect(v3.consecutive).toBe(1);
  });

  it("连续读达到 4 次 → noteReadServed 使 dedup 失效（硬拒后读真失败）", () => {
    const sid = "s1";
    for (let i = 0; i < CONSECUTIVE_READ_BLOCK; i++) {
      rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    }
    // 记账时 consecutive>=4 → dedup 被清，之后 dedup 不再生效
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("allow");
  });

  it("notifyOtherToolCall 重置连续计数（hermes notify_other_tool_call）", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    rt.notifyOtherToolCall(sid);
    const v = rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    expect(v.consecutive).toBe(1);
  });
});

describe("ReadTracker — 覆盖账与全文基线", () => {
  let rt: ReadTracker;
  beforeEach(() => {
    ReadTracker.resetInstance();
    rt = ReadTracker.getInstance();
  });

  it("单次全文读 → 建基线，整文件覆盖放行", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).toBeNull();
  });

  it("分页读覆盖满 → 建基线（对标 hermes contiguous paging）", () => {
    const sid = "s1";
    rt.noteReadServed(sid, "/f.txt", "v1", 1, 5, 5, 10, false);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).not.toBeNull();
    rt.noteReadServed(sid, "/f.txt", "v1", 6, 5, 10, 10, false);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).toBeNull();
  });

  it("截断页不作全文证据", () => {
    const sid = "s1";
    // 16K 截断：endLine 报了 10 但 truncated=true
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, true);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).not.toBeNull();
  });

  it("version 变化后旧覆盖账作废，须重读", () => {
    const sid = "s1";
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).toBeNull();
    // 外部修改 → version v2，旧基线失效
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v2")).not.toBeNull();
    rt.noteReadServed(sid, "/f.txt", "v2", 1, undefined, 12, 12, false);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v2")).toBeNull();
  });

  it("不存在的文件 → 覆盖检查放行（net-new）", () => {
    const sid = "s1";
    expect(rt.checkOverwriteBaseline(sid, "/new.txt", false, null)).toBeNull();
  });

  it("部分读（未到末行）→ 无基线", () => {
    const sid = "s1";
    rt.noteReadServed(sid, "/f.txt", "v1", 1, 5, 5, 100, false);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).not.toBeNull();
  });

  it("写成功 → noteWriteServed 建基线 + 连续 modify 自放行", () => {
    const sid = "s1";
    rt.noteWriteServed(sid, "/f.txt", "v5");
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v5")).toBeNull();
  });
});

describe("ReadTracker — 压缩边界 advanceGeneration", () => {
  let rt: ReadTracker;
  beforeEach(() => {
    ReadTracker.resetInstance();
    rt = ReadTracker.getInstance();
  });

  it("advanceGeneration 后：dedup 保留但首次读回全文（generation served 清空）", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("stub");

    rt.advanceGeneration(sid);
    // dedup map 仍在（version 匹配），但 generationServed 空 → allow
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("allow");
    // 记账后再次读 → 恢复 stub（本 generation 已 served）
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("stub");
  });

  it("advanceGeneration 清 dedupHits（硬 BLOCK 计数重启）", () => {
    const sid = "s1";
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined);
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined); // stub（hits=1）
    rt.advanceGeneration(sid);
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    // 新 generation：第一次重复读又是 stub（hits=1），不是直接 block
    expect(rt.checkBeforeRead(sid, "/f.txt", "v1", 1, undefined).action).toBe("stub");
  });

  it("基线在 advanceGeneration 后保留（写前检查不受压缩影响）", () => {
    const sid = "s1";
    rt.noteReadServed(sid, "/f.txt", "v1", 1, undefined, 10, 10, false);
    rt.advanceGeneration(sid);
    expect(rt.checkOverwriteBaseline(sid, "/f.txt", true, "v1")).toBeNull();
  });

  it("无 sessionId → 全会话重置", () => {
    rt.noteReadServed("a", "/f.txt", "v1", 1, undefined, 10, 10, false);
    rt.noteReadServed("b", "/g.txt", "v1", 1, undefined, 10, 10, false);
    rt.advanceGeneration();
    expect(rt.checkBeforeRead("a", "/f.txt", "v1", 1, undefined).action).toBe("allow");
    expect(rt.checkBeforeRead("b", "/g.txt", "v1", 1, undefined).action).toBe("allow");
  });
});

describe("ReadTracker — edit 失败计数", () => {
  let rt: ReadTracker;
  beforeEach(() => {
    ReadTracker.resetInstance();
    rt = ReadTracker.getInstance();
  });

  it("连续失败计数递增，成功清零", () => {
    const sid = "s1";
    expect(rt.recordEditFailure(sid, "/f.txt")).toBe(1);
    expect(rt.recordEditFailure(sid, "/f.txt")).toBe(2);
    expect(rt.recordEditFailure(sid, "/f.txt")).toBe(3);
    rt.clearEditFailures(sid, "/f.txt");
    expect(rt.recordEditFailure(sid, "/f.txt")).toBe(1);
  });

  it("noteWriteServed 也清失败计数", () => {
    const sid = "s1";
    rt.recordEditFailure(sid, "/f.txt");
    rt.recordEditFailure(sid, "/f.txt");
    rt.noteWriteServed(sid, "/f.txt", "v2");
    expect(rt.recordEditFailure(sid, "/f.txt")).toBe(1);
  });
});
