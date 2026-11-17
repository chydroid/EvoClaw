import { describe, it, expect } from "vitest";
import {
  extractRequiredDeliverables,
  findMissingDeliverables,
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
