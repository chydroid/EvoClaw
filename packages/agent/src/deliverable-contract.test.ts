import { describe, it, expect } from "vitest";
import {
  extractRequiredDeliverables,
  findMissingDeliverables,
  evaluateDeliverables,
  countAssertionLines,
  extractFrozenInputs,
  snapshotFrozenInputs,
  findFrozenMutations,
} from "./deliverable-contract";

// ═══════════════════════════════════════════════════════════
// 交付物契约：从用户原始任务文本抽取「必交产物」，供回合结束前做
// 存在性核验。对标 Hermes kanban 的 artifacts 验收语义：
// 完成状态由产物是否存在决定，而不是由模型措辞决定。
// ═══════════════════════════════════════════════════════════
describe("extractRequiredDeliverables", () => {
  it("抽取任务目录下的交付文件，相对路径解析到任务绝对目录", () => {
    const msg = [
      "你是工程师。在 /home/chy/EvoClaw/data/workspace/v14-diff/ 下交付 diff.js（CommonJS），",
      "并输出 patch.diff 与 applied.txt。",
    ].join("");
    const specs = extractRequiredDeliverables(msg, "/fallback/workspace");
    expect(specs.map((s) => s.path)).toEqual([
      "/home/chy/EvoClaw/data/workspace/v14-diff/diff.js",
      "/home/chy/EvoClaw/data/workspace/v14-diff/patch.diff",
      "/home/chy/EvoClaw/data/workspace/v14-diff/applied.txt",
    ]);
  });

  it("排除夹具文件（fixtures/ 路径与同名裸名都不算交付物）", () => {
    const msg = "在 /tmp/task/ 下交付 scan.js；夹具 fixtures/config.json（禁止修改），config.json 作为输入。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/task/scan.js"]);
  });

  it("没有交付意图时不启用（纯问答）", () => {
    const msg = "解释一下 /tmp/x/graph.js 里 topoSort 的算法复杂度。";
    expect(extractRequiredDeliverables(msg, "/tmp/ws")).toEqual([]);
  });

  it("排除 URL 与版本号形态的 token", () => {
    const msg = "交付 notes.md；参考 https://example.com/docs/api.json 与 Node v1.2.3。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/ws/notes.md"]);
  });

  it("任务无绝对目录时解析到工作区根，并去重", () => {
    const msg = "创建 report.md，然后更新 report.md 的结论段。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/ws/report.md"]);
  });

  // ★ v26 smoke 实证：任务原文写 `data/workspace/...`，工具会剥前缀落到
  //   workspace 根下；契约核验若照拼会得到 `<ws>/data/workspace/...` 双前缀，
  //   误报「契约未满足」触发无谓续跑。
  it("data/workspace/ 前缀先剥离再按 workspace 根解析（无双前缀）", () => {
    const ws = "/home/chy/EvoClaw/data/workspace";
    const specs = extractRequiredDeliverables(
      "在 data/workspace/v26-smoke2/a.txt 写入 v1。",
      ws,
    );
    expect(specs.map((s) => s.path)).toEqual([`${ws}/v26-smoke2/a.txt`]);
  });

  it("绝对任务目录下，带 workspace 前缀的 token 仍按 workspace 根解析", () => {
    const ws = "/home/chy/EvoClaw/data/workspace";
    const specs = extractRequiredDeliverables(
      "在 /home/chy/EvoClaw/data/workspace/v26-t9/ 交付 gql.py，并写入 data/workspace/v26-t9/report.json。",
      ws,
    );
    expect(specs.map((s) => s.path)).toEqual([
      `${ws}/v26-t9/gql.py`,
      `${ws}/v26-t9/report.json`,
    ]);
  });

  it("绝对路径交付物原样保留", () => {
    const msg = "交付 /tmp/abc/out/results.json 与 /tmp/abc/out/summary.md。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual([
      "/tmp/abc/out/results.json",
      "/tmp/abc/out/summary.md",
    ]);
  });

  it("技术名（node.js 等）不作为交付物", () => {
    const msg = "交付 index.js，使用 node.js 实现，可参考 vue.js 写法。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/ws/index.js"]);
  });

  it("裸文件名只在其子句含交付意图时计入（参考输入文件不算交付物）", () => {
    const msg = "参考 graph.js 的写法，交付 report.md。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/ws/report.md"]);
  });

  it("命令行占位目录（OUTDIR/BACKUP_DIR）不算交付物", () => {
    // v15 Task 3 实测：命令行用法里的 OUTDIR/backup.tar.gz 被误当必交文件，
    // 回合结束反复提示契约未满足。
    const msg = "在 /tmp/task/ 下交付 backup.sh 与 restore.sh；运行 backup.sh SRC OUTDIR，写出 OUTDIR/manifest.json 与 OUTDIR/backup.tar.gz。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual([
      "/tmp/task/backup.sh",
      "/tmp/task/restore.sh",
    ]);
  });

  it("fixtures/ 提及之后的同子句子路径也是输入（sub/c.txt 不算交付物）", () => {
    // v15 Task 3 实测：夹具目录后括号内列出 sub/c.txt，带路径分隔符被直接信任。
    const msg = "在 /tmp/task/ 下交付 out.md；夹具 fixtures/data/（a.txt、sub/c.txt）由我提供，禁止修改。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/task/out.md"]);
  });

  it("支持 .prom 产物", () => {
    const msg = "交付 metrics.py 与 metrics.prom。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/ws/metrics.py", "/tmp/ws/metrics.prom"]);
  });

  it("中文序号「1）file」后的 token 也能识别", () => {
    const msg = "在 /tmp/task/ 下生成：1）report.json（内容由脚本生成）。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.map((s) => s.path)).toEqual(["/tmp/task/report.json"]);
  });
});

describe("findMissingDeliverables", () => {
  it("按注入的 exists 返回缺失项，去重且保持顺序", () => {
    const specs = [
      { raw: "a.js", path: "/w/a.js" },
      { raw: "b.md", path: "/w/b.md" },
      { raw: "a.js", path: "/w/a.js" },
    ];
    const missing = findMissingDeliverables(specs, (p) => p.endsWith("a.js"));
    expect(missing).toEqual(["/w/b.md"]);
  });

  it("exists 抛异常按缺失处理（fail-closed）", () => {
    const specs = [{ raw: "x.js", path: "/w/x.js" }];
    const missing = findMissingDeliverables(specs, () => {
      throw new Error("EACCES");
    });
    expect(missing).toEqual(["/w/x.js"]);
  });

  it("全部存在时返回空数组", () => {
    const specs = [{ raw: "x.js", path: "/w/x.js" }];
    expect(findMissingDeliverables(specs, () => true)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 验收阈值：任务写明的「≥300 字节」「至少 8 个断言」是硬验收指标，
// 空壳 README / 只写 2 个断言的自测在压测里反复被判负。
// ═══════════════════════════════════════════════════════════
describe("extractRequiredDeliverables — 阈值抽取", () => {
  it("抽取文件旁写明的字节下限", () => {
    const msg = "在 /tmp/t/ 下交付 README.md（≥300 字节）；交付 report.json（≥700 字节）。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    const readme = specs.find((s) => s.path.endsWith("README.md"));
    const report = specs.find((s) => s.path.endsWith("report.json"));
    expect(readme?.minBytes).toBe(300);
    expect(report?.minBytes).toBe(700);
  });

  it("抽取测试文件的断言数下限", () => {
    const msg = "在 /tmp/t/ 下交付 test_sat.py：python3 test_sat.py 退出码 0，至少 8 个断言，覆盖单元传播。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs[0]?.minAssertions).toBe(8);
  });

  it("阈值不跨文件串绑：README 的大小阈值不落到测试文件上", () => {
    const msg = "交付 a.py。交付 README.md（≥300 字节）。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    const readme = specs.find((s) => s.path.endsWith("README.md"));
    const py = specs.find((s) => s.path.endsWith("a.py"));
    expect(readme?.minBytes).toBe(300);
    expect(py?.minBytes).toBeUndefined();
  });

  it("无阈值文本不产生阈值字段", () => {
    const msg = "交付 notes.md 与 index.js。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs.every((s) => s.minBytes === undefined && s.minAssertions === undefined)).toBe(true);
  });

  it("同一文件多次出现时取最严格阈值", () => {
    const msg = "交付 report.json。细则：report.json（≥900 字节）。";
    const specs = extractRequiredDeliverables(msg, "/tmp/ws");
    expect(specs).toHaveLength(1);
    expect(specs[0].minBytes).toBe(900);
  });
});

describe("countAssertionLines", () => {
  it("与压测 harness 同口径：断言样式行计数，跳过 import/require", () => {
    const src = [
      "import assert from 'node:assert';",
      "const assert = require('assert');",
      "assert.strictEqual(a, 1);",
      "assert.deepEqual(b, c);",
      "expect(x).toBe(2);",
      "ok(true);",
      "// 这是注释，不算",
      "",
    ].join("\n");
    expect(countAssertionLines(src)).toBe(4);
  });

  it("空内容返回 0", () => {
    expect(countAssertionLines("")).toBe(0);
  });
});

describe("evaluateDeliverables", () => {
  const files = new Map<string, Buffer>([
    ["/w/ok.md", Buffer.from("x".repeat(400))],
    ["/w/small.md", Buffer.from("短")],
    ["/w/t.py", Buffer.from(["assert a", "assert b"].join("\n"))],
  ]);
  const readFile = (p: string) => files.get(p) ?? null;

  it("缺失/未达大小/断言不足分别给出结构化 issue", () => {
    const issues = evaluateDeliverables(
      [
        { raw: "gone.md", path: "/w/gone.md" },
        { raw: "small.md", path: "/w/small.md", minBytes: 300 },
        { raw: "t.py", path: "/w/t.py", minAssertions: 8 },
        { raw: "ok.md", path: "/w/ok.md", minBytes: 300 },
      ],
      { readFile },
    );
    expect(issues).toEqual([
      { kind: "missing", raw: "gone.md", path: "/w/gone.md" },
      { kind: "undersized", raw: "small.md", path: "/w/small.md", actualBytes: 3, minBytes: 300 },
      { kind: "under_asserted", raw: "t.py", path: "/w/t.py", actualAssertions: 2, minAssertions: 8 },
    ]);
  });

  it("readFile 抛异常按缺失处理（fail-closed）", () => {
    const issues = evaluateDeliverables(
      [{ raw: "x.js", path: "/w/x.js" }],
      { readFile: () => { throw new Error("EACCES"); } },
    );
    expect(issues).toEqual([{ kind: "missing", raw: "x.js", path: "/w/x.js" }]);
  });

  it("无阈值的现有文件不产生 issue", () => {
    expect(evaluateDeliverables([{ raw: "ok.md", path: "/w/ok.md" }], { readFile })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 冻结输入：「冻结夹具/禁止修改」的输入在回合开始快照，回合结束比对。
// 压测反复出现「改夹具让测试变绿」——存在性/阈值检查都发现不了。
// ═══════════════════════════════════════════════════════════
describe("extractFrozenInputs", () => {
  it("只收集冻结信号所在句子里的文件", () => {
    const msg = [
      "在 /tmp/t/ 下交付 parse.py。",
      "冻结夹具：`config.toml`（合法）、`bad.toml`（含重复键）。禁止修改夹具。",
      "必须交付（缺一不可）：parse.py、test_parse.py、README.md、report.json。",
    ].join("\n");
    const frozen = extractFrozenInputs(msg, "/tmp/ws");
    expect(frozen.map((f) => f.path)).toEqual([
      "/tmp/t/config.toml",
      "/tmp/t/bad.toml",
    ]);
  });

  it("无冻结信号时不收集（交付物清单不会被当成冻结输入）", () => {
    const msg = "在 /tmp/t/ 下交付 a.py 与 README.md。";
    expect(extractFrozenInputs(msg, "/tmp/ws")).toEqual([]);
  });

  it("英文 read-only / frozen fixture 同样识别", () => {
    const msg = "Deliver parser.py. Frozen fixture: `cases.json` — read-only, do not modify.";
    const frozen = extractFrozenInputs(msg, "/tmp/ws");
    expect(frozen.map((f) => f.path)).toEqual(["/tmp/ws/cases.json"]);
  });

  it("去重：同一夹具在多个冻结句子中出现只登记一次", () => {
    const msg = "冻结夹具：`a.json`。禁止修改夹具 a.json。";
    expect(extractFrozenInputs(msg, "/tmp/ws")).toHaveLength(1);
  });

  it("★ 安全边界：工作区/任务目录之外的冻结路径不纳入（还原会越界写盘）", () => {
    const msg = "任务目录 /tmp/t/。禁止修改 /etc/passwd 与 /tmp/t/keep.json。";
    const frozen = extractFrozenInputs(msg, "/tmp/ws");
    expect(frozen.map((f) => f.path)).toEqual(["/tmp/t/keep.json"]);
  });

  it("工作区内的绝对路径仍纳入", () => {
    const msg = "冻结夹具：`/tmp/ws/fixtures/a.json`，禁止修改。";
    const frozen = extractFrozenInputs(msg, "/tmp/ws");
    expect(frozen.map((f) => f.path)).toEqual(["/tmp/ws/fixtures/a.json"]);
  });
});

describe("snapshotFrozenInputs / findFrozenMutations", () => {
  it("未改动不报；改动/删除分别识别", () => {
    const store = new Map<string, Buffer>([
      ["/w/a.json", Buffer.from("{\"a\":1}")],
      ["/w/b.json", Buffer.from("{\"b\":2}")],
      ["/w/c.json", Buffer.from("{\"c\":3}")],
    ]);
    const read = (p: string) => store.get(p) ?? null;
    const snaps = snapshotFrozenInputs(
      [
        { raw: "a.json", path: "/w/a.json" },
        { raw: "b.json", path: "/w/b.json" },
        { raw: "c.json", path: "/w/c.json" },
      ],
      read,
    );
    expect(snaps).toHaveLength(3);

    store.set("/w/b.json", Buffer.from("{\"b\":99}"));
    store.delete("/w/c.json");
    const mutations = findFrozenMutations(snaps, read);
    expect(mutations.map((m) => [m.path, m.kind])).toEqual([
      ["/w/b.json", "modified"],
      ["/w/c.json", "missing"],
    ]);
    // 快照保留原始内容，供还原
    expect(mutations[0].snapshot.content?.toString()).toBe("{\"b\":2}");
  });

  it("快照时就不存在的文件不纳入（无法保护）", () => {
    const snaps = snapshotFrozenInputs([{ raw: "x.json", path: "/w/x.json" }], () => null);
    expect(snaps).toEqual([]);
  });

  it("超大文件只记哈希、不保留内容（避免占内存）", () => {
    const big = Buffer.alloc(1_000_001, 0x61);
    const snaps = snapshotFrozenInputs([{ raw: "big.bin", path: "/w/big.bin" }], () => big);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].content).toBeUndefined();
    expect(snaps[0].hash).toHaveLength(64);
  });
});
