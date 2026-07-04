/**
 * Layered Memory 综合测试 — L0/L1/L2/L3 + 符号记忆画布。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { ConversationRecorder } from "./conversation-recorder";
import { AtomicMemoryExtractor } from "./atomic-memory-extractor";
import { SceneBlockAggregator } from "./scene-block-aggregator";
import { PersonaProfileGenerator } from "./persona-profile";
import { SymbolicMemoryCanvas } from "./symbolic-memory-canvas";
import { LayeredMemory } from "./layered-memory";

// ── 测试辅助 ──
function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-layered-mem-"));
}
function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// L0 ConversationRecorder
// ─────────────────────────────────────────────────────────────────────────────
describe("ConversationRecorder (L0)", () => {
  let dir: string;
  let recorder: ConversationRecorder;

  beforeEach(() => {
    dir = mkTempDir();
    recorder = new ConversationRecorder(dir);
  });
  afterEach(() => rmTempDir(dir));

  it("记录消息并按会话保存到 JSONL 文件", () => {
    const msg = recorder.record({
      role: "user",
      content: "你好",
      sessionKey: "s1",
    });
    expect(msg.id).toMatch(/^l0_/);
    expect(msg.timestamp).toBeGreaterThan(0);

    const file = path.join(dir, "memory", "layered", "conversations", "s1.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).content).toBe("你好");
  });

  it("loadRecent 返回会话最近 N 条消息", () => {
    for (let i = 0; i < 5; i++) {
      recorder.record({ role: "user", content: `msg${i}`, sessionKey: "s1" });
    }
    const recent = recorder.loadRecent("s1", 3);
    expect(recent.length).toBe(3);
    expect(recent[0].content).toBe("msg2");
    expect(recent[2].content).toBe("msg4");
  });

  it("loadRecent 不存在的会话返回空数组", () => {
    expect(recorder.loadRecent("nonexistent")).toEqual([]);
  });

  it("listSessions 按最近修改时间倒序列出会话", () => {
    recorder.record({ role: "user", content: "a", sessionKey: "s1" });
    // 等待 mtime 差异
    const future = Date.now() + 2000;
    const file1 = path.join(dir, "memory", "layered", "conversations", "s1.jsonl");
    fs.utimesSync(file1, new Date(future - 5000), new Date(future - 5000));
    recorder.record({ role: "user", content: "b", sessionKey: "s2" });
    const sessions = recorder.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0]).toBe("s2"); // 更晚修改的排前面
  });

  it("search 跨会话全文搜索", () => {
    recorder.record({ role: "user", content: "我喜欢 TypeScript", sessionKey: "s1" });
    recorder.record({ role: "user", content: "Python 也还行", sessionKey: "s2" });
    const results = recorder.search("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("deleteSession 删除指定会话", () => {
    recorder.record({ role: "user", content: "x", sessionKey: "s1" });
    recorder.deleteSession("s1");
    expect(recorder.loadRecent("s1")).toEqual([]);
  });

  it("清空所有会话", () => {
    recorder.record({ role: "user", content: "a", sessionKey: "s1" });
    recorder.record({ role: "user", content: "b", sessionKey: "s2" });
    recorder.clear();
    expect(recorder.listSessions()).toEqual([]);
  });

  it("对 sessionKey 中的特殊字符做路径安全处理", () => {
    // 含路径分隔符的 sessionKey 不能逃逸 conversations/ 目录
    recorder.record({ role: "user", content: "x", sessionKey: "../escape" });
    const sessions = recorder.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]).not.toContain("..");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 AtomicMemoryExtractor
// ─────────────────────────────────────────────────────────────────────────────
describe("AtomicMemoryExtractor (L1)", () => {
  let extractor: AtomicMemoryExtractor;

  beforeEach(() => {
    extractor = new AtomicMemoryExtractor();
  });

  it("从中文偏好消息中提取 persona 类型记忆", () => {
    const msgs = [
      {
        id: "m1", role: "user" as const, content: "我喜欢用 TypeScript 写后端",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    expect(memories.length).toBeGreaterThan(0);
    const persona = memories.find((m) => m.type === "persona");
    expect(persona).toBeDefined();
    expect(persona!.content).toContain("TypeScript");
    expect(persona!.priority).toBeGreaterThanOrEqual(65);
  });

  it("从英文偏好消息中提取 persona 类型记忆", () => {
    const msgs = [
      {
        id: "m1", role: "user" as const, content: "I prefer using dark theme",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    const persona = memories.find((m) => m.type === "persona");
    expect(persona).toBeDefined();
    expect(persona!.content.toLowerCase()).toContain("dark");
  });

  it("从事件描述中提取 episodic 类型记忆", () => {
    const msgs = [
      {
        id: "m1", role: "user" as const, content: "我昨天部署了 v0.66.9 到生产环境",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    const episodic = memories.find((m) => m.type === "episodic");
    expect(episodic).toBeDefined();
    expect(episodic!.content).toContain("v0.66.9");
  });

  it("从指令消息中提取 instruction 类型记忆", () => {
    const msgs = [
      {
        id: "m1", role: "user" as const, content: "以后所有 PR 都必须通过 typecheck",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    const inst = memories.find((m) => m.type === "instruction");
    expect(inst).toBeDefined();
    expect(inst!.priority).toBeGreaterThanOrEqual(85);
  });

  it("跳过 assistant 消息", () => {
    const msgs = [
      { id: "m1", role: "assistant" as const, content: "我喜欢 TypeScript", timestamp: Date.now(), sessionKey: "s1" },
      { id: "m2", role: "user" as const, content: "我喜欢 TypeScript", timestamp: Date.now(), sessionKey: "s1" },
    ];
    const memories = extractor.extract(msgs);
    expect(memories.length).toBe(1);
    expect(memories[0].sourceMessageIds).toEqual(["m2"]);
  });

  it("跳过工具性请求（帮我...）", () => {
    const msgs = [
      { id: "m1", role: "user" as const, content: "帮我安装技能", timestamp: Date.now(), sessionKey: "s1" },
    ];
    const memories = extractor.extract(msgs);
    expect(memories.length).toBe(0);
  });

  it("对同一句话只匹配一个规则，避免重复", () => {
    const msgs = [
      // "我喜欢" 命中 persona，"今天" 命中 episodic —— 应该有两个独立记忆
      {
        id: "m1", role: "user" as const,
        content: "我喜欢 TypeScript。今天我部署了 v0.66.9",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    expect(memories.length).toBe(2);
    const types = new Set(memories.map((m) => m.type));
    expect(types.has("persona")).toBe(true);
    expect(types.has("episodic")).toBe(true);
  });

  it("包含具体技术名词的优先级更高", () => {
    const msgs = [
      {
        id: "m1", role: "user" as const,
        content: "我喜欢用 TypeScript",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    expect(memories[0].priority).toBeGreaterThanOrEqual(75); // 70+5
  });

  it("只从用户消息中提取，且消息太短 (<4) 跳过", () => {
    const msgs = [
      { id: "m1", role: "user" as const, content: "hi", timestamp: Date.now(), sessionKey: "s1" },
    ];
    const memories = extractor.extract(msgs);
    expect(memories.length).toBe(0);
  });

  it("对复杂多句消息按句子切分提取", () => {
    const msgs = [
      {
        id: "m1", role: "user" as const,
        content: "我喜欢 TypeScript。我讨厌 PHP。",
        timestamp: Date.now(), sessionKey: "s1",
      },
    ];
    const memories = extractor.extract(msgs);
    expect(memories.length).toBe(2);
    expect(memories.some((m) => m.content.includes("TypeScript"))).toBe(true);
    expect(memories.some((m) => m.content.includes("PHP"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 SceneBlockAggregator
// ─────────────────────────────────────────────────────────────────────────────
describe("SceneBlockAggregator (L2)", () => {
  let dir: string;
  let agg: SceneBlockAggregator;

  beforeEach(() => {
    dir = mkTempDir();
    agg = new SceneBlockAggregator(dir);
  });
  afterEach(() => rmTempDir(dir));

  function makeL1(opts: {
    id: string;
    type: "persona" | "episodic" | "instruction";
    content: string;
    priority: number;
    sessionKey: string;
    sourceTimestamp: number;
  }) {
    return {
      id: opts.id,
      type: opts.type,
      content: opts.content,
      priority: opts.priority,
      sourceMessageIds: [opts.id],
      sessionKey: opts.sessionKey,
      extractedAt: opts.sourceTimestamp,
      metadata: { sourceTimestamp: opts.sourceTimestamp },
    };
  }

  it("空输入返回空数组", () => {
    expect(agg.aggregate([])).toEqual([]);
  });

  it("同一会话 + 时间窗口内的记忆聚合成一个情境", () => {
    const base = Date.now();
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
      makeL1({ id: "m2", type: "episodic", content: "今天部署了 v1", priority: 70, sessionKey: "s1", sourceTimestamp: base + 60_000 }),
    ];
    const scenes = agg.aggregate(memories);
    expect(scenes.length).toBe(1);
    expect(scenes[0].memories.length).toBe(2);
  });

  it("不同会话切到不同情境", () => {
    const base = Date.now();
    // 用没有共享关键词的内容，避免 topicOverlap 把它们合并
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
      makeL1({ id: "m2", type: "persona", content: "我讨厌 PHP", priority: 80, sessionKey: "s2", sourceTimestamp: base + 60_000 }),
    ];
    const scenes = agg.aggregate(memories, { topicOverlapThreshold: 2 });
    expect(scenes.length).toBe(2);
  });

  it("超过时间窗口切到新情境", () => {
    const base = Date.now();
    // 用没有共享关键词的内容，避免 topicOverlap 把它们合并
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
      // 2 小时后，不同主题
      makeL1({ id: "m2", type: "persona", content: "我讨厌 PHP", priority: 80, sessionKey: "s1", sourceTimestamp: base + 2 * 3600_000 }),
    ];
    const scenes = agg.aggregate(memories, { timeWindowMs: 30 * 60_000, topicOverlapThreshold: 2 });
    expect(scenes.length).toBe(2);
  });

  it("writeSceneFiles 写入 Markdown 文件", () => {
    const base = Date.now();
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
    ];
    const scenes = agg.aggregate(memories);
    const paths = agg.writeSceneFiles(scenes);
    expect(paths.length).toBe(1);
    expect(fs.existsSync(paths[0])).toBe(true);
    const md = fs.readFileSync(paths[0], "utf-8");
    expect(md).toContain("scene_id:");
    expect(md).toContain("## Persona");
    expect(md).toContain("我喜欢 TypeScript");
  });

  it("loadScene 加载已写入的情境", () => {
    const base = Date.now();
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
    ];
    const scenes = agg.aggregate(memories);
    agg.writeSceneFiles(scenes);

    const loaded = agg.loadScene(scenes[0].sceneId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sceneName).toBe(scenes[0].sceneName);
    expect(loaded!.memories.length).toBe(1);
    expect(loaded!.memories[0].content).toBe("我喜欢 TypeScript");
  });

  it("search 关键词搜索情境块", () => {
    const base = Date.now();
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
    ];
    const scenes = agg.aggregate(memories);
    agg.writeSceneFiles(scenes);

    const results = agg.search("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0].memories[0].content).toContain("TypeScript");
  });

  it("情境命名包含关键词", () => {
    const base = Date.now();
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript 和 React", priority: 80, sessionKey: "s1", sourceTimestamp: base }),
    ];
    const scenes = agg.aggregate(memories);
    // 关键词在命名时会被小写化（用于重叠比较），但应包含原词的不区分大小写形式
    expect(scenes[0].sceneName.toLowerCase()).toContain("typescript");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 PersonaProfileGenerator
// ─────────────────────────────────────────────────────────────────────────────
describe("PersonaProfileGenerator (L3)", () => {
  let dir: string;
  let gen: PersonaProfileGenerator;

  beforeEach(() => {
    dir = mkTempDir();
    gen = new PersonaProfileGenerator(dir);
  });
  afterEach(() => rmTempDir(dir));

  function makeL1(opts: {
    id: string;
    type: "persona" | "episodic" | "instruction";
    content: string;
    priority: number;
  }) {
    return {
      id: opts.id,
      type: opts.type,
      content: opts.content,
      priority: opts.priority,
      sourceMessageIds: [opts.id],
      sessionKey: "s1",
      extractedAt: Date.now(),
    };
  }

  it("从 persona 记忆中提取画像，分类到 tech_stack / identity / preference", () => {
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢用 TypeScript", priority: 80 }),
      makeL1({ id: "m2", type: "persona", content: "我是后端工程师", priority: 75 }),
      makeL1({ id: "m3", type: "persona", content: "我喜欢简洁代码", priority: 70 }),
    ];
    const profile = gen.refresh(memories);
    expect(profile.version).toBe(1);
    expect(profile.entries.length).toBe(3);
    const topics = new Set(profile.entries.map((e) => e.topic));
    expect(topics.has("tech_stack")).toBe(true);
    expect(topics.has("identity")).toBe(true);
    expect(topics.has("preference")).toBe(true);
  });

  it("instruction 类型进入长期指令分组", () => {
    const memories = [
      makeL1({ id: "m1", type: "instruction", content: "以后代码必须通过 typecheck", priority: 90 }),
    ];
    const profile = gen.refresh(memories);
    expect(profile.entries.length).toBe(1);
    expect(profile.entries[0].topic).toBe("instruction");
  });

  it("episodic 类型不进入画像", () => {
    const memories = [
      makeL1({ id: "m1", type: "episodic", content: "今天部署了 v1", priority: 80 }),
    ];
    const profile = gen.refresh(memories);
    expect(profile.entries.length).toBe(0);
  });

  it("低于优先级阈值的记忆被过滤", () => {
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 30 }),
    ];
    const profile = gen.refresh(memories, { minPriority: 50 });
    expect(profile.entries.length).toBe(0);
  });

  it("相似内容去重合并", () => {
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript 编程语言", priority: 70 }),
      makeL1({ id: "m2", type: "persona", content: "我喜欢 TypeScript 后端开发", priority: 75 }),
    ];
    const profile = gen.refresh(memories);
    // 两条都含 "TypeScript" 和 "喜欢"，应合并
    const techStack = profile.entries.filter((e) => e.topic === "tech_stack");
    expect(techStack.length).toBe(1);
    expect(techStack[0].priority).toBe(75); // 取更高优先级
  });

  it("renderMarkdown 输出带分组的 Markdown", () => {
    const memories = [
      makeL1({ id: "m1", type: "persona", content: "我喜欢用 TypeScript", priority: 80 }),
      makeL1({ id: "m2", type: "instruction", content: "代码必须通过 typecheck", priority: 90 }),
    ];
    gen.refresh(memories);
    const md = gen.renderMarkdown();
    expect(md).toContain("# 用户画像");
    expect(md).toContain("## 技术栈");
    expect(md).toContain("## 长期指令");
    expect(md).toContain("TypeScript");
  });

  it("刷新时版本号递增", () => {
    gen.refresh([makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80 })]);
    const v1 = gen.getCurrent()!.version;
    gen.refresh([makeL1({ id: "m2", type: "persona", content: "我喜欢 Python", priority: 80 })]);
    const v2 = gen.getCurrent()!.version;
    expect(v2).toBeGreaterThan(v1);
  });

  it("构造时从磁盘加载已有画像", () => {
    gen.refresh([makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80 })]);
    const v1 = gen.getCurrent()!.version;

    // 重新构造
    const gen2 = new PersonaProfileGenerator(dir);
    expect(gen2.getCurrent()).not.toBeNull();
    expect(gen2.getCurrent()!.version).toBe(v1);
  });

  it("containsKeyword 判断画像是否包含关键词", () => {
    gen.refresh([makeL1({ id: "m1", type: "persona", content: "我喜欢 TypeScript", priority: 80 })]);
    expect(gen.containsKeyword("TypeScript")).toBe(true);
    expect(gen.containsKeyword("Java")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SymbolicMemoryCanvas
// ─────────────────────────────────────────────────────────────────────────────
describe("SymbolicMemoryCanvas", () => {
  let canvas: SymbolicMemoryCanvas;

  beforeEach(() => {
    canvas = new SymbolicMemoryCanvas();
  });

  it("start 初始化新画布并返回 user_request 节点", () => {
    const node = canvas.start("s1", "安装技能");
    expect(node.type).toBe("user_request");
    expect(node.label).toBe("安装技能");
  });

  it("addNode 添加节点并自动编号", () => {
    canvas.start("s1", "用户请求");
    const n2 = canvas.addNode("tool_call", "marketplace.install");
    expect(n2.id).toBe("n2");
  });

  it("connect 创建边", () => {
    canvas.start("s1", "用户请求");
    const n2 = canvas.addNode("tool_call", "install");
    const edge = canvas.connect("n1", "n2", "调用");
    expect(edge).not.toBeNull();
    expect(edge!.from).toBe("n1");
    expect(edge!.to).toBe("n2");
    expect(edge!.label).toBe("调用");
  });

  it("connectToLast 自动连接到最后一个节点", () => {
    canvas.start("s1", "用户请求");
    const n2 = canvas.connectToLast("tool_call", "install", "调用");
    expect(n2).not.toBeNull();
    expect(n2!.id).toBe("n2");
    const c = canvas.getCanvas()!;
    expect(c.edges.length).toBe(1);
    expect(c.edges[0].from).toBe("n1");
    expect(c.edges[0].to).toBe("n2");
  });

  it("render 输出合法 Mermaid 图", () => {
    canvas.start("s1", "安装技能");
    canvas.connectToLast("tool_call", "marketplace.install");
    const mermaid = canvas.render();
    expect(mermaid).toContain("graph LR");
    expect(mermaid).toContain("n1");
    expect(mermaid).toContain("n2");
    expect(mermaid).toContain("-->");
  });

  it("长标签被截断", () => {
    const longLabel = "a".repeat(120);
    canvas.start("s1", longLabel);
    const c = canvas.getCanvas()!;
    expect(c.nodes[0].label.length).toBeLessThanOrEqual(80);
  });

  it("超过最大节点数时自动裁剪", () => {
    canvas = new SymbolicMemoryCanvas({ maxNodes: 5 });
    canvas.start("s1", "起点");
    for (let i = 0; i < 10; i++) {
      canvas.connectToLast("tool_call", `step${i}`);
    }
    const c = canvas.getCanvas()!;
    // 裁剪后节点数应不超过 maxNodes 的 1.x 倍（裁剪 1/3）
    expect(c.nodes.length).toBeLessThanOrEqual(10);
  });

  it("render 包含 sourceMessageId 的 refs 注释", () => {
    canvas.start("s1", "用户请求");
    canvas.addNode("tool_call", "install", { sourceMessageId: "l0_abc123" });
    const mermaid = canvas.render();
    expect(mermaid).toContain("%% refs:");
    expect(mermaid).toContain("n2 = L0/l0_abc123");
  });

  it("clear 清空画布", () => {
    canvas.start("s1", "x");
    canvas.clear();
    expect(canvas.getCanvas()).toBeNull();
  });

  it("injectIntoMessages 把画布作为 user 消息注入", () => {
    canvas.start("s1", "安装技能");
    canvas.connectToLast("tool_call", "install");
    const messages: unknown[] = [];
    const injected = canvas.injectIntoMessages(messages);
    expect(injected).not.toBeNull();
    expect(messages.length).toBe(1);
    const msg = messages[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(msg.role).toBe("user");
    expect(msg.content[0].text).toContain("mermaid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LayeredMemory 集成测试
// ─────────────────────────────────────────────────────────────────────────────
describe("LayeredMemory 集成测试", () => {
  let dir: string;
  let mem: LayeredMemory;

  beforeEach(() => {
    dir = mkTempDir();
    mem = new LayeredMemory(dir, {
      l2AggregateEveryNTurns: 2,  // 加快 L2 触发
      l3RefreshEveryNTurns: 2,    // 加快 L3 触发
    });
  });
  afterEach(() => rmTempDir(dir));

  it("captureTurn 写入 L0 + 提取 L1", async () => {
    const result = await mem.captureTurn({
      userText: "我喜欢用 TypeScript 写后端",
      assistantText: "好的，已记录",
      sessionKey: "s1",
    });
    expect(result.l0Messages.length).toBe(2); // user + assistant
    expect(result.l1Memories.length).toBeGreaterThan(0);
    const persona = result.l1Memories.find((m) => m.type === "persona");
    expect(persona).toBeDefined();
    expect(persona!.content).toContain("TypeScript");
  });

  it("多轮对话后触发 L2 聚合", async () => {
    await mem.captureTurn({ userText: "我喜欢 TypeScript", assistantText: "好的", sessionKey: "s1" });
    await mem.captureTurn({ userText: "我讨厌 PHP", assistantText: "好的", sessionKey: "s1" });
    // 第 2 turn 应触发 L2 聚合
    expect(mem.getTurnCount()).toBe(2);
    const scenes = mem.getAggregator().listScenes();
    expect(scenes.length).toBeGreaterThan(0);
  });

  it("多轮对话后触发 L3 画像刷新", async () => {
    await mem.captureTurn({ userText: "我喜欢 TypeScript", assistantText: "好的", sessionKey: "s1" });
    await mem.captureTurn({ userText: "我是后端工程师", assistantText: "好的", sessionKey: "s1" });
    // 第 2 turn 应触发 L3 画像刷新
    const profile = mem.getPersonaGenerator().getCurrent();
    expect(profile).not.toBeNull();
    expect(profile!.entries.length).toBeGreaterThan(0);
  });

  it("recall 返回 L1 + L3 上下文", async () => {
    await mem.captureTurn({ userText: "我喜欢用 TypeScript", assistantText: "好的", sessionKey: "s1" });
    await mem.captureTurn({ userText: "我是后端工程师", assistantText: "好的", sessionKey: "s1" });
    await mem.captureTurn({ userText: "测试第三轮", assistantText: "好的", sessionKey: "s1" });

    const recall = mem.recall("TypeScript 是什么");
    // 应该召回 L1 中的 TypeScript 相关记忆
    expect(recall.l1Memories.length).toBeGreaterThan(0);
    expect(recall.l1Memories.some((m) => (m as { content: string }).content.includes("TypeScript"))).toBe(true);
    // L3 画像应该不为空
    expect(recall.personaProfile).not.toBeNull();
    expect(recall.prependContext).toContain("[相关历史记忆]");
    expect(recall.appendSystemContext).toContain("[用户画像]");
  });

  it("recall 空查询返回 L3 画像（无 L1）", async () => {
    await mem.captureTurn({ userText: "我喜欢 TypeScript", assistantText: "好的", sessionKey: "s1" });
    const recall = mem.recall("");
    // 空查询无关键词匹配，但应有 L3 画像（如果触发刷新）
    expect(recall.l1Memories.length).toBe(0);
  });

  it("startCanvas 启动符号画布", () => {
    const canvas = mem.startCanvas("s1", "安装技能");
    expect(canvas.nodes.length).toBe(1);
    expect(canvas.nodes[0].type).toBe("user_request");
  });

  it("getCanvas 返回符号画布实例", () => {
    mem.startCanvas("s1", "安装技能");
    const canvas = mem.getCanvas();
    expect(canvas).not.toBeNull();
  });

  it("clear 清空所有层", async () => {
    await mem.captureTurn({ userText: "我喜欢 TypeScript", assistantText: "好的", sessionKey: "s1" });
    mem.clear();
    expect(mem.getAllL1Memories()).toEqual([]);
    expect(mem.getTurnCount()).toBe(0);
  });

  it("跨会话累积 L1 记忆", async () => {
    await mem.captureTurn({ userText: "我喜欢 TypeScript", assistantText: "好的", sessionKey: "s1" });
    await mem.captureTurn({ userText: "我喜欢 Python", assistantText: "好的", sessionKey: "s2" });
    const allL1 = mem.getAllL1Memories();
    expect(allL1.length).toBe(2);
    // 跨会话 recall 应能命中
    const recall = mem.recall("TypeScript");
    expect(recall.l1Memories.some((m) => (m as { content: string }).content.includes("TypeScript"))).toBe(true);
  });

  it("端到端：多轮对话后召回 + 画布注入", async () => {
    // Round 1
    await mem.captureTurn({
      userText: "我喜欢用 TypeScript 写后端。以后所有 PR 必须通过 typecheck。",
      assistantText: "好的，已记录你的偏好和指令。",
      sessionKey: "s1",
    });
    // Round 2 - 触发 L2 + L3
    await mem.captureTurn({
      userText: "我昨天部署了 v0.66.9 到生产环境",
      assistantText: "明白了。",
      sessionKey: "s1",
    });

    // 召回
    const recall = mem.recall("我之前说过什么部署");
    expect(recall.l1Memories.length).toBeGreaterThan(0);
    // 应命中 episodic 记忆
    const episodic = recall.l1Memories.find((m) => (m as { type: string }).type === "episodic");
    expect(episodic).toBeDefined();

    // 启动画布
    const canvas = mem.startCanvas("s1", "用户请求：查询部署状态");
    expect(canvas.nodes[0].label).toContain("查询部署状态");
  });
});
