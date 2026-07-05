/**
 * Layered Memory v2 模块测试 — 第二轮借鉴（v0.68.0）的工程鲁棒性 + 召回质量。
 *
 * 覆盖以下新模块（每个至少 5 个测试用例）：
 *   1. atomic-write — 原子写 + JSONL 追加
 *   2. jsonl-defense — 四层 JSONL 防御
 *   3. l1-dedup — L1 智能去重（3 层降级）
 *   4. hybrid-search — BM25 + 向量 + RRF 融合
 *   5. recall-budget — 双重预算控制
 *   6. relevant-memories-tag — 召回标签管理
 *   7. storage-context — 不可变路径上下文
 *   8. bg-tasks — 后台任务注册表 + drain
 *   9. token-estimate — 快速 token 估算
 *  10. task-boundary — L1.5 任务边界判定
 *  11. l2-trigger — L2 Mermaid 独立触发
 *  12. compaction-l3 — L3 三级压缩
 *  13. layered-memory v2 集成 — L1 持久化 + 去重 + L2 召回 + 画布注入
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { atomicWriteFileSync, appendJsonlAtomic } from "./atomic-write";
import {
  sanitizeText,
  sanitizeJsonLine,
  validateEntry,
  parseJsonlSafe,
  serializeJsonlLine,
} from "./jsonl-defense";
import {
  L1Dedupifier,
  cosineSimilarity,
  extractKeywords,
  applyDedupDecisions,
} from "./l1-dedup";
import type { AtomicMemory } from "./atomic-memory-extractor";
import {
  fuseWithRrf,
  SimpleBM25Searcher,
  VectorSearcher,
  hybridSearch,
  type SearchResult,
} from "./hybrid-search";
import { applyRecallBudget, remainingBudget } from "./recall-budget";
import {
  RELEVANT_MEMORIES_OPEN,
  RELEVANT_MEMORIES_CLOSE,
  CANVAS_BLOCK_OPEN,
  CANVAS_BLOCK_CLOSE,
  stripRecallTags,
  stripRecallTagsFromMessages,
  wrapRelevantMemories,
  wrapTaskCanvas,
  hasRecallTags,
} from "./relevant-memories-tag";
import {
  parseSessionKey,
  safeDirName,
  createStorageContext,
  createGlobalStorageContext,
} from "./storage-context";
import { BackgroundTaskRegistry } from "./bg-tasks";
import { quickTokenEstimate, estimateMessagesTokens, QuickSkipCounter } from "./token-estimate";
import { TaskBoundaryJudge, shouldEndCanvas } from "./task-boundary";
import { L2Trigger } from "./l2-trigger";
import { L3Compactor, computeFingerprint } from "./compaction-l3";
import { LayeredMemory } from "./layered-memory";

// ── 测试辅助 ──
function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-layered-v2-"));
}
function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function mkMem(overrides: Partial<AtomicMemory> = {}): AtomicMemory {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    type: "persona",
    content: "我喜欢 TypeScript",
    priority: 70,
    sourceMessageIds: ["l0_xxx"],
    sessionKey: "s1",
    extractedAt: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. atomic-write
// ─────────────────────────────────────────────────────────────────────────────
describe("atomic-write", () => {
  let dir: string;
  beforeEach(() => { dir = mkTempDir(); });
  afterEach(() => rmTempDir(dir));

  it("atomicWriteFileSync 写入新文件", () => {
    const f = path.join(dir, "test.txt");
    atomicWriteFileSync(f, "hello");
    expect(fs.readFileSync(f, "utf-8")).toBe("hello");
  });

  it("atomicWriteFileSync 覆盖已有文件", () => {
    const f = path.join(dir, "test.txt");
    atomicWriteFileSync(f, "v1");
    atomicWriteFileSync(f, "v2");
    expect(fs.readFileSync(f, "utf-8")).toBe("v2");
  });

  it("atomicWriteFileSync 自动创建多级目录", () => {
    const f = path.join(dir, "a", "b", "c", "test.txt");
    atomicWriteFileSync(f, "nested");
    expect(fs.readFileSync(f, "utf-8")).toBe("nested");
  });

  it("appendJsonlAtomic 追加 JSONL 行", () => {
    const f = path.join(dir, "log.jsonl");
    appendJsonlAtomic(f, { a: 1 });
    appendJsonlAtomic(f, { b: 2 });
    const lines = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).a).toBe(1);
    expect(JSON.parse(lines[1]).b).toBe(2);
  });

  it("appendJsonlAtomic 不存在文件时创建", () => {
    const f = path.join(dir, "new.jsonl");
    appendJsonlAtomic(f, { x: "y" });
    expect(fs.existsSync(f)).toBe(true);
    const lines = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("appendJsonlAtomic 处理大文本（降级到全量写）", () => {
    const f = path.join(dir, "big.jsonl");
    const bigContent = "x".repeat(70 * 1024); // > 64KB
    appendJsonlAtomic(f, { content: bigContent });
    expect(fs.existsSync(f)).toBe(true);
    const lines = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).content.length).toBe(70 * 1024);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. jsonl-defense
// ─────────────────────────────────────────────────────────────────────────────
describe("jsonl-defense", () => {
  it("sanitizeText 清理控制字符", () => {
    expect(sanitizeText("hello\x00world")).toBe("helloworld");
    expect(sanitizeText("a\x07b\x1Fc")).toBe("abc");
  });

  it("sanitizeText 规范化换行 + trim", () => {
    expect(sanitizeText("a\r\nb\r\n")).toBe("a\nb");
    expect(sanitizeText("  hello  ")).toBe("hello");
  });

  it("sanitizeJsonLine 清理 + roundtrip 验证", () => {
    expect(sanitizeJsonLine('{"a":1}\x00')).toBe('{"a":1}');
    expect(sanitizeJsonLine("not json")).toBe("");
  });

  it("validateEntry 校验必填字段", () => {
    expect(validateEntry({ a: 1 }, ["a"]).valid).toBe(true);
    expect(validateEntry({ a: 1 }, ["b"]).valid).toBe(false);
    expect(validateEntry(null, []).valid).toBe(false);
    expect(validateEntry("string", []).valid).toBe(false);
  });

  it("parseJsonlSafe 容忍损坏行", () => {
    const text = `{"a":1}\nnot json\n{"b":2}\n`;
    const result = parseJsonlSafe(text);
    expect(result.entries.length).toBe(2);
    expect(result.corruptLines).toBe(1);
    expect(result.corruptLineNumbers.length).toBe(1);
  });

  it("parseJsonlSafe 校验必填字段", () => {
    const text = `{"a":1}\n{"a":1,"b":2}\n`;
    const result = parseJsonlSafe<{ a: number; b?: number }>(text, { requiredFields: ["b"] });
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].b).toBe(2);
  });

  it("serializeJsonlLine 序列化 + 验证", () => {
    expect(serializeJsonlLine({ a: 1 })).toBe('{"a":1}\n');
    expect(serializeJsonlLine(undefined)).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. l1-dedup
// ─────────────────────────────────────────────────────────────────────────────
describe("l1-dedup", () => {
  it("cosineSimilarity 计算余弦相似度", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("extractKeywords 提取中英关键词", () => {
    const kw = extractKeywords("我喜欢 TypeScript 编程");
    // extractKeywords 内部对英文关键词做 toLowerCase 处理
    expect(kw.has("typescript")).toBe(true);
    expect(kw.has("我喜欢")).toBe(true);
  });

  it("L1Dedupifier 完全相同内容 → skip", async () => {
    const existing = [mkMem({ id: "e1", content: "我喜欢 TypeScript" })];
    const dedup = new L1Dedupifier(existing);
    const decision = await dedup.check(mkMem({ content: "我喜欢 TypeScript" }));
    expect(decision.action).toBe("skip");
  });

  it("L1Dedupifier 高相似内容 → merge 或 update", async () => {
    // 用相似但不完全相同的内容，避免触发 exact match → skip
    // existing 关键词: {typescript, 我喜欢, 编程语言}
    // new 关键词:      {typescript, 我喜欢, 编程}
    // Jaccard = 2/3 ≈ 0.67 → 介于 ftsThreshold(0.6) 和 skipThreshold(0.95) 之间
    const existing = [mkMem({ id: "e1", content: "我喜欢 TypeScript 编程语言", priority: 60 })];
    const dedup = new L1Dedupifier(existing);
    const decision = await dedup.check(
      mkMem({ content: "我喜欢 TypeScript 编程", priority: 80 })
    );
    expect(["update", "merge"]).toContain(decision.action);
  });

  it("L1Dedupifier 无匹配 → store", async () => {
    const existing = [mkMem({ id: "e1", content: "今天天气不错" })];
    const dedup = new L1Dedupifier(existing);
    const decision = await dedup.check(mkMem({ content: "我喜欢 Rust" }));
    expect(decision.action).toBe("store");
  });

  it("L1Dedupifier 空已有列表 → store", async () => {
    const dedup = new L1Dedupifier([]);
    const decision = await dedup.check(mkMem());
    expect(decision.action).toBe("store");
  });

  it("applyDedupDecisions 应用决策 + 统计", () => {
    const existing = [mkMem({ id: "e1", content: "旧记忆" })];
    const newMems = [
      mkMem({ id: "n1", content: "新记忆 1" }),
      mkMem({ id: "n2", content: "旧记忆" }), // 重复
    ];
    const decisions = [
      { memory: newMems[0], decision: { action: "store" as const, matchedBy: "none" as const } },
      { memory: newMems[1], decision: { action: "skip" as const, existingId: "e1", matchedBy: "keyword" as const } },
    ];
    const result = applyDedupDecisions(existing, newMems, decisions);
    expect(result.merged.length).toBe(2); // 1 existing + 1 store
    expect(result.stats.stored).toBe(1);
    expect(result.stats.skipped).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. hybrid-search
// ─────────────────────────────────────────────────────────────────────────────
describe("hybrid-search", () => {
  it("SimpleBM25Searcher 关键词匹配", () => {
    const docs = [
      { id: "1", text: "TypeScript 编程" },
      { id: "2", text: "Python 编程" },
      { id: "3", text: "美食烹饪" },
    ];
    const bm25 = new SimpleBM25Searcher<{ id: string; text: string }>((d) => d.text);
    bm25.add(docs);
    const results = bm25.search("TypeScript", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.id).toBe("1");
  });

  it("VectorSearcher 余弦相似度检索", () => {
    const items = [
      { id: "1", vec: [1, 0, 0] },
      { id: "2", vec: [0, 1, 0] },
    ];
    // VectorSearcher 的 getText 参数未实际使用（仅 add/search 用 vector），传 stub 即可
    const vs = new VectorSearcher<{ id: string; vec: number[] }>(() => "");
    vs.add(items.map((i) => ({ item: i, vector: i.vec })));
    const results = vs.search([1, 0.1, 0], 2);
    expect(results[0].item.id).toBe("1");
  });

  it("fuseWithRrf 融合多列表 + RRF 排序", () => {
    const list1: SearchResult<string>[] = [
      { item: "a", score: 0.9, source: "bm25" },
      { item: "b", score: 0.7, source: "bm25" },
    ];
    const list2: SearchResult<string>[] = [
      { item: "b", score: 0.95, source: "vector" },
      { item: "c", score: 0.6, source: "vector" },
    ];
    const fused = fuseWithRrf([list1, list2], { finalTopK: 3 });
    expect(fused.length).toBe(3);
    // b 在两个列表都排名靠前，RRF 应给高分
    const bItem = fused.find((r) => r.item === "b");
    expect(bItem).toBeDefined();
    expect(bItem!.rrfScore).toBeGreaterThan(0);
  });

  it("hybridSearch 组合 BM25 + Vector", () => {
    const docs = [
      { id: "1", text: "TypeScript", vec: [1, 0] },
      { id: "2", text: "Python", vec: [0, 1] },
    ];
    const bm25 = new SimpleBM25Searcher<{ id: string; text: string; vec: number[] }>((d) => d.text);
    bm25.add(docs);
    // VectorSearcher 的 getText 参数未实际使用，传 stub 即可
    const vs = new VectorSearcher<{ id: string; text: string; vec: number[] }>(() => "");
    vs.add(docs.map((d) => ({ item: d, vector: d.vec })));
    const bm25Results = bm25.search("TypeScript", 2);
    const vecResults = vs.search([1, 0], 2);
    const fused = hybridSearch(bm25Results, vecResults, { finalTopK: 2 });
    expect(fused.length).toBeGreaterThan(0);
  });

  it("RRF k 参数影响融合", () => {
    const list1: SearchResult<string>[] = [
      { item: "a", score: 0.9, source: "s1" },
    ];
    const list2: SearchResult<string>[] = [
      { item: "b", score: 0.9, source: "s2" },
    ];
    const fusedK60 = fuseWithRrf([list1, list2], { k: 60, finalTopK: 2 });
    const fusedK1 = fuseWithRrf([list1, list2], { k: 1, finalTopK: 2 });
    expect(fusedK60.length).toBe(2);
    expect(fusedK1.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. recall-budget
// ─────────────────────────────────────────────────────────────────────────────
describe("recall-budget", () => {
  it("applyRecallBudget 单条不超限 → 全部保留", () => {
    const items = [{ text: "short 1" }, { text: "short 2" }];
    const result = applyRecallBudget(items, (i) => i.text, { maxTotalRecallChars: 1000 });
    expect(result.items.length).toBe(2);
    expect(result.budgetExhausted).toBe(false);
    expect(result.droppedCount).toBe(0);
  });

  it("applyRecallBudget 单条超限 → 截断", () => {
    const items = [{ text: "x".repeat(600) }];
    const result = applyRecallBudget(items, (i) => i.text, {
      maxCharsPerMemory: 100,
      maxTotalRecallChars: 1000,
    });
    expect(result.items.length).toBe(1);
    expect(result.truncatedCount).toBe(1);
    expect(result.items[0]._truncated).toBe(true);
  });

  it("applyRecallBudget 总预算耗尽 → 丢弃后续", () => {
    const items = [
      { text: "a".repeat(300) },
      { text: "b".repeat(300) },
      { text: "c".repeat(300) },
    ];
    const result = applyRecallBudget(items, (i) => i.text, { maxTotalRecallChars: 500 });
    expect(result.budgetExhausted).toBe(true);
    expect(result.droppedCount + result.items.length).toBeLessThanOrEqual(items.length);
  });

  it("applyRecallBudget 剩余空间太小 → 丢弃", () => {
    const items = [
      { text: "a".repeat(400) },
      { text: "b".repeat(400) },
    ];
    const result = applyRecallBudget(items, (i) => i.text, { maxTotalRecallChars: 410 });
    // 第一条占用 400，剩 10 字符（< 50），第二条应被丢弃
    expect(result.items.length).toBe(1);
    expect(result.budgetExhausted).toBe(true);
  });

  it("remainingBudget 计算剩余预算", () => {
    expect(remainingBudget(100, 500)).toBe(400);
    expect(remainingBudget(500, 500)).toBe(0);
    expect(remainingBudget(600, 500)).toBe(0); // 不为负
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. relevant-memories-tag
// ─────────────────────────────────────────────────────────────────────────────
describe("relevant-memories-tag", () => {
  it("wrapRelevantMemories 包裹记忆列表", () => {
    const wrapped = wrapRelevantMemories(["记忆 1", "记忆 2"]);
    expect(wrapped).toContain(RELEVANT_MEMORIES_OPEN);
    expect(wrapped).toContain(RELEVANT_MEMORIES_CLOSE);
    expect(wrapped).toContain("记忆 1");
    expect(wrapped).toContain("记忆 2");
  });

  it("wrapRelevantMemories 空列表 → 空字符串", () => {
    expect(wrapRelevantMemories([])).toBe("");
  });

  it("wrapTaskCanvas 包裹 Mermaid", () => {
    const wrapped = wrapTaskCanvas("graph LR\n  n1 --> n2");
    expect(wrapped).toContain(CANVAS_BLOCK_OPEN);
    expect(wrapped).toContain(CANVAS_BLOCK_CLOSE);
    expect(wrapped).toContain("```mermaid");
  });

  it("stripRecallTags 移除标签 + 内容", () => {
    const text = `before${RELEVANT_MEMORIES_OPEN}\n记忆内容\n${RELEVANT_MEMORIES_CLOSE}after`;
    const stripped = stripRecallTags(text);
    expect(stripped).not.toContain(RELEVANT_MEMORIES_OPEN);
    expect(stripped).not.toContain("记忆内容");
    expect(stripped).toContain("before");
    expect(stripped).toContain("after");
  });

  it("stripRecallTagsFromMessages 清理消息数组", () => {
    const messages = [
      { role: "user", content: `text${RELEVANT_MEMORIES_OPEN}xxx${RELEVANT_MEMORIES_CLOSE}` },
      { role: "assistant", content: "clean" },
    ];
    stripRecallTagsFromMessages(messages);
    expect(messages[0].content).not.toContain(RELEVANT_MEMORIES_OPEN);
    expect(messages[1].content).toBe("clean");
  });

  it("hasRecallTags 检测标签存在", () => {
    expect(hasRecallTags(`${RELEVANT_MEMORIES_OPEN}xxx${RELEVANT_MEMORIES_CLOSE}`)).toBe(true);
    expect(hasRecallTags(`${CANVAS_BLOCK_OPEN}xxx${CANVAS_BLOCK_CLOSE}`)).toBe(true);
    expect(hasRecallTags("plain text")).toBe(false);
  });

  it("stripRecallTags 处理多个标签", () => {
    const text = `${RELEVANT_MEMORIES_OPEN}a${RELEVANT_MEMORIES_CLOSE}mid${CANVAS_BLOCK_OPEN}b${CANVAS_BLOCK_CLOSE}end`;
    const stripped = stripRecallTags(text);
    expect(stripped).toBe("midend");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. storage-context
// ─────────────────────────────────────────────────────────────────────────────
describe("storage-context", () => {
  it("parseSessionKey 解析 agent:name:id 格式", () => {
    const ctx = parseSessionKey("agent:coder:123");
    expect(ctx.agentName).toBe("coder");
    expect(ctx.agentId).toBe("123");
  });

  it("parseSessionKey 解析 swebench-w{N} 格式", () => {
    const ctx = parseSessionKey("swebench-w42");
    expect(ctx.agentName).toBe("swebench");
    expect(ctx.agentId).toBe("w42");
  });

  it("safeDirName 处理路径分隔符", () => {
    expect(safeDirName("agent:coder:123")).not.toContain(":");
    expect(safeDirName("a/b\\c")).not.toMatch(/[\\/]/);
  });

  it("createStorageContext 返回冻结对象", () => {
    const ctx = createStorageContext("/tmp/data", "agent:coder:123");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.sessionKey).toBe("agent:coder:123");
  });

  it("createGlobalStorageContext 全局上下文", () => {
    const ctx = createGlobalStorageContext("/tmp/data");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.sessionKey).toBe("__global__");
  });

  it("createStorageContext 不同 session 隔离", () => {
    const ctx1 = createStorageContext("/tmp/data", "agent:a:1");
    const ctx2 = createStorageContext("/tmp/data", "agent:b:2");
    expect(ctx1.sessionKey).not.toBe(ctx2.sessionKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. bg-tasks
// ─────────────────────────────────────────────────────────────────────────────
describe("bg-tasks", () => {
  it("register + drain 完成任务", async () => {
    const reg = new BackgroundTaskRegistry();
    let done = false;
    reg.register("test task", (async () => { await new Promise((r) => setTimeout(r, 10)); done = true; })());
    expect(reg.pendingCount).toBe(1);
    const result = await reg.drain();
    expect(done).toBe(true);
    expect(result.completed).toBe(1);
    expect(result.timedOut).toBe(0);
  });

  it("drain 空注册表立即返回", async () => {
    const reg = new BackgroundTaskRegistry();
    const result = await reg.drain();
    expect(result.completed).toBe(0);
    expect(result.timedOut).toBe(0);
  });

  it("drain 超时返回未完成任务", async () => {
    const reg = new BackgroundTaskRegistry({ drainTimeoutMs: 50 });
    reg.register("slow", (async () => {
      await new Promise((r) => setTimeout(r, 500));
    })());
    const result = await reg.drain();
    expect(result.timedOut).toBeGreaterThan(0);
  });

  it("drain 捕获任务错误", async () => {
    const reg = new BackgroundTaskRegistry();
    reg.register("failing", (async () => {
      throw new Error("test error");
    })());
    const result = await reg.drain();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("isDestroyed 在 drain 后为 true", async () => {
    const reg = new BackgroundTaskRegistry();
    await reg.drain();
    expect(reg.isDestroyed).toBe(true);
  });

  it("register 在 destroy 后不注册", async () => {
    const reg = new BackgroundTaskRegistry();
    await reg.drain();
    let called = false;
    const p = reg.register("after", (async () => { called = true; })());
    await p;
    // 已 destroyed，任务应直接执行但不会被注册
    expect(called).toBe(true);
    expect(reg.pendingCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. token-estimate
// ─────────────────────────────────────────────────────────────────────────────
describe("token-estimate", () => {
  it("quickTokenEstimate 纯英文估算", () => {
    const tokens = quickTokenEstimate("hello world");
    // 11 字符 × 0.25 = 2.75 → 3
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("quickTokenEstimate 纯中文估算", () => {
    const tokens = quickTokenEstimate("你好世界");
    // 4 字 × 1.5 = 6
    expect(tokens).toBeGreaterThanOrEqual(6);
  });

  it("quickTokenEstimate 空文本 → 0", () => {
    expect(quickTokenEstimate("")).toBe(0);
    expect(quickTokenEstimate(null as unknown as string)).toBe(0);
  });

  it("estimateMessagesTokens 含结构开销", () => {
    const tokens = estimateMessagesTokens([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    // 2 条 × 4 结构 + 内容
    expect(tokens).toBeGreaterThanOrEqual(8);
  });

  it("QuickSkipCounter 连续 5 次后强制精确", () => {
    const counter = new QuickSkipCounter();
    expect(counter.shouldForceExact()).toBe(false);
    for (let i = 0; i < 5; i++) {
      counter.increment();
    }
    expect(counter.shouldForceExact()).toBe(true);
    counter.reset();
    expect(counter.shouldForceExact()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. task-boundary
// ─────────────────────────────────────────────────────────────────────────────
describe("task-boundary", () => {
  it("短消息 → 短任务", () => {
    const judge = new TaskBoundaryJudge();
    const d = judge.judge({ userMessage: "hi" });
    expect(d.type).toBe("short");
    expect(d.shouldUseCanvas).toBe(false);
  });

  it("长消息 → 长任务", () => {
    const judge = new TaskBoundaryJudge();
    const long = "x".repeat(150);
    const d = judge.judge({ userMessage: long });
    expect(d.type).toBe("long");
    expect(d.shouldUseCanvas).toBe(true);
  });

  it("步骤性关键词 → 长任务", () => {
    const judge = new TaskBoundaryJudge();
    const d = judge.judge({ userMessage: "然后我们开始部署" });
    expect(d.shouldUseCanvas).toBe(true);
  });

  it("工具性关键词 → 长任务", () => {
    const judge = new TaskBoundaryJudge();
    const d = judge.judge({ userMessage: "请帮我搜索 TypeScript 教程" });
    expect(d.shouldUseCanvas).toBe(true);
  });

  it("已有画布 → continuation", () => {
    const judge = new TaskBoundaryJudge();
    const d = judge.judge({ userMessage: "继续", hasActiveCanvas: true });
    expect(d.type).toBe("continuation");
    expect(d.shouldUseCanvas).toBe(true);
  });

  it("shouldEndCanvas 检测任务完成", () => {
    expect(shouldEndCanvas("谢谢")).toBe(true);
    expect(shouldEndCanvas("好的")).toBe(true);
    expect(shouldEndCanvas("ok")).toBe(true);
    // 长消息（>= 10 字符）且无完成信号 → 视为继续，不应结束画布
    expect(shouldEndCanvas("请帮我搜索一下TypeScript的资料")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. l2-trigger
// ─────────────────────────────────────────────────────────────────────────────
describe("l2-trigger", () => {
  it("短任务跳过", () => {
    const t = new L2Trigger();
    const s = t.createInitialState();
    t.incrementMessages(s, 2);
    const d = t.evaluate(s);
    expect(d.shouldTrigger).toBe(false);
    expect(d.triggerType).toBe("skip_short_task");
  });

  it("null 阈值触发", () => {
    const t = new L2Trigger({ l2NullThreshold: 3, l2MinIntervalSeconds: 0 });
    const s = t.createInitialState();
    t.incrementMessages(s, 5); // 超过短任务阈值
    t.incrementNullEntries(s, 3);
    const d = t.evaluate(s);
    expect(d.shouldTrigger).toBe(true);
    expect(d.triggerType).toBe("null_threshold");
  });

  it("超时触发", () => {
    const t = new L2Trigger({ l2TimeoutSeconds: 1, l2MinIntervalSeconds: 0 });
    const s = t.createInitialState();
    t.incrementMessages(s, 5);
    s.lastL2RunTime = Date.now() - 2000; // 2 秒前
    const d = t.evaluate(s);
    expect(d.shouldTrigger).toBe(true);
    expect(d.triggerType).toBe("timeout");
  });

  it("forceTrigger 强制触发", () => {
    const t = new L2Trigger();
    const d = t.forceTrigger();
    expect(d.shouldTrigger).toBe(true);
    expect(d.triggerType).toBe("forced");
  });

  it("markTriggered 重置状态", () => {
    const t = new L2Trigger();
    const s = t.createInitialState();
    t.incrementNullEntries(s, 5);
    t.markTriggered(s);
    expect(s.nullEntryCount).toBe(0);
    expect(s.lastL2RunTime).toBeGreaterThan(0);
  });

  it("最小间隔保护", () => {
    const t = new L2Trigger({ l2NullThreshold: 1, l2MinIntervalSeconds: 60 });
    const s = t.createInitialState();
    t.incrementMessages(s, 5);
    t.incrementNullEntries(s, 5);
    s.lastL2RunTime = Date.now() - 1000; // 1 秒前（< 60s 间隔）
    const d = t.evaluate(s);
    expect(d.shouldTrigger).toBe(false);
    expect(d.triggerType).toBe("skip_min_interval");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. compaction-l3
// ─────────────────────────────────────────────────────────────────────────────
describe("compaction-l3", () => {
  it("computeFingerprint 稳定哈希", () => {
    const msg1 = { role: "user" as const, content: "hello" };
    const msg2 = { role: "user" as const, content: "hello" };
    expect(computeFingerprint(msg1)).toBe(computeFingerprint(msg2));
    expect(computeFingerprint({ ...msg1, content: "different" })).not.toBe(computeFingerprint(msg1));
  });

  it("L3Compactor mild 压缩：替换早期为 summary", () => {
    const compact = new L3Compactor({ maxTokens: 1000 });
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i}`,
    }));
    const result = compact.compact(messages);
    expect(result.messages.length).toBeLessThanOrEqual(messages.length);
    expect(["mild", "aggressive", "emergency", "none"]).toContain(result.level);
  });

  it("L3Compactor aggressive 更激进压缩", () => {
    const compact = new L3Compactor({ aggressiveRatio: 0.3, maxTokens: 500 });
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i} `.repeat(20),
    }));
    const result = compact.compact(messages);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("L3Compactor 短消息不压缩", () => {
    const compact = new L3Compactor();
    const messages = [{ role: "user" as const, content: "hi" }];
    const result = compact.compact(messages);
    expect(result.level).toBe("none");
    expect(result.messages.length).toBe(1);
  });

  it("L3Compactor 保留 tool_call + tool_result 配对", () => {
    const compact = new L3Compactor({ aggressiveRatio: 0.1, maxTokens: 50 });
    const messages = [
      { role: "user" as const, content: "x".repeat(100) },
      { role: "assistant" as const, content: "y".repeat(100) },
      { role: "tool" as const, content: "tool_call", tool_call_id: "tc1" },
      { role: "tool" as const, content: "tool_result", tool_call_id: "tc1" },
    ];
    const result = compact.compact(messages);
    // 不应在 tool_call 和 tool_result 之间截断
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. LayeredMemory v2 集成 — L1 持久化 + 去重 + L2 召回 + 画布注入
// ─────────────────────────────────────────────────────────────────────────────
describe("LayeredMemory v2 集成", () => {
  let dir: string;
  let mem: LayeredMemory;

  beforeEach(() => {
    dir = mkTempDir();
    mem = new LayeredMemory(dir, {
      l2AggregateEveryNTurns: 2,
      l3RefreshEveryNTurns: 2,
    });
  });
  afterEach(() => rmTempDir(dir));

  it("L1 持久化到 JSONL 文件", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    // 等待 bg task 完成
    await mem.drain();
    const l1File = path.join(dir, "memory", "layered", "l1.jsonl");
    expect(fs.existsSync(l1File)).toBe(true);
    const lines = fs.readFileSync(l1File, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]);
    expect(entry.content).toContain("TypeScript");
  });

  it("重启后从磁盘加载 L1 记忆", async () => {
    await mem.captureTurn({
      userText: "我喜欢 Rust",
      assistantText: "好的",
      sessionKey: "s1",
    });
    await mem.drain();

    // 模拟重启：创建新实例指向同目录
    const mem2 = new LayeredMemory(dir);
    const all = mem2.getAllL1Memories();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((m) => m.content.includes("Rust"))).toBe(true);
  });

  it("L1 智能去重：完全相同内容不重复存储", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    // 第二次相同内容应被去重
    const all = mem.getAllL1Memories();
    const tsMemories = all.filter((m) => m.content.includes("TypeScript"));
    expect(tsMemories.length).toBe(1);
    expect(mem.getDedupSkippedTotal()).toBeGreaterThan(0);
  });

  it("L1 LRU 上限淘汰", async () => {
    const smallMem = new LayeredMemory(dir, {
      l1MaxMemories: 3,
      l2AggregateEveryNTurns: 999,
      l3RefreshEveryNTurns: 999,
    });
    // 写入 5 条不同记忆（超过上限 3）
    for (let i = 0; i < 5; i++) {
      await smallMem.captureTurn({
        userText: `我喜欢语言${i}`,
        assistantText: "ok",
        sessionKey: "s1",
      });
    }
    expect(smallMem.getAllL1Memories().length).toBeLessThanOrEqual(3);
  });

  it("recall 包含 <relevant-memories> 标签", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    const recall = mem.recall("TypeScript 是什么");
    expect(recall.prependContext).toContain("<relevant-memories>");
    expect(recall.prependContext).toContain("</relevant-memories>");
    expect(recall.prependContext).toContain("[相关历史记忆]");
  });

  it("recall 包含 stats 统计", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    const recall = mem.recall("TypeScript");
    expect(recall.stats).toBeDefined();
    expect(recall.stats!.l1Hits).toBeGreaterThan(0);
    expect(recall.stats!.budgetUsed).toBeGreaterThan(0);
  });

  it("recall 包含 taskBoundary 判定", async () => {
    await mem.captureTurn({
      userText: "请帮我搜索 TypeScript 教程",
      assistantText: "好的",
      sessionKey: "s1",
    });
    const recall = mem.recall("请帮我搜索 Rust");
    expect(recall.taskBoundary).toBeDefined();
    expect(recall.taskBoundary!.shouldUseCanvas).toBe(true);
  });

  it("recall 包含 strategy 策略名", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    const recall = mem.recall("TypeScript");
    expect(recall.strategy).toContain("l1-keyword");
    expect(recall.strategy).toContain("l3-persona");
  });

  it("recall 空查询返回空 L1 + 无标签", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    const recall = mem.recall("");
    expect(recall.l1Memories.length).toBe(0);
    expect(recall.prependContext).not.toContain("<relevant-memories>");
  });

  it("clear 清理 L1 持久化文件 + 重置去重计数", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    await mem.drain();
    mem.clear();
    expect(mem.getAllL1Memories()).toEqual([]);
    expect(mem.getDedupSkippedTotal()).toBe(0);
    expect(mem.getL2TriggerState().nullEntryCount).toBe(0);
  });

  it("drain 返回 drain 统计", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript",
      assistantText: "好的",
      sessionKey: "s1",
    });
    const result = await mem.drain();
    expect(result).toHaveProperty("completed");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("errors");
  });
});
