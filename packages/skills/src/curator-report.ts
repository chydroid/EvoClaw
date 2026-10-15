import { atomicWriteFile, CrossProcessLock } from "@evoclaw/infrastructure";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { EvolutionRecord, SkillUsageStats } from "./skill-curator";

/**
 * Hermes 对标 P3：Curator 完整报告链路。
 * 每次 runCycle 结束后写入 <reportDir>/run.json（最近一次运行快照）
 * 与 <reportDir>/REPORT.md（人类可读），并给每个技能打上
 * consolidated-vs-pruned 分类：
 * - consolidated：保留为活跃（本次未过期，或过期但被 pinned 豁免的也计入保留侧）
 * - pruned：本次被归档（永不删除，仅移出活跃目录）
 * - pinned-exempt：过期但因 pinned 豁免归档的技能
 */

export type SkillClassification = "consolidated" | "pruned" | "pinned-exempt";

export interface CuratorSkillOutcome {
  skillName: string;
  classification: SkillClassification;
  reason: string;
}

export interface EvolutionStatsSnapshot {
  totalTracked: number;
  totalExtractions: number;
  totalImprovements: number;
  totalDeprecations: number;
  averageVersionsPerSkill: number;
}

export interface CuratorRunReport {
  runId: string;
  trigger: "timer" | "manual";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** 本次扫描到的技能目录总数。 */
  scanned: number;
  outcomes: CuratorSkillOutcome[];
  archived: string[];
  expired: string[];
  evolutionStats: EvolutionStatsSnapshot;
  usageTotals: { active: number; archived: number; totalTracked: number };
  recentRecords: EvolutionRecord[];
}

function countByClassification(outcomes: CuratorSkillOutcome[]): Record<SkillClassification, number> {
  const counts: Record<SkillClassification, number> = {
    consolidated: 0,
    pruned: 0,
    "pinned-exempt": 0,
  };
  for (const o of outcomes) counts[o.classification] += 1;
  return counts;
}

/** 生成 REPORT.md 内容（Markdown）。 */
export function renderCuratorReportMarkdown(report: CuratorRunReport): string {
  const counts = countByClassification(report.outcomes);
  const lines: string[] = [];
  lines.push("# Skill Curator 运行报告");
  lines.push("");
  lines.push(`- runId: \`${report.runId}\``);
  lines.push(`- 触发方式: ${report.trigger === "timer" ? "后台定时（24h cron 代理）" : "手动"}`);
  lines.push(`- 开始: ${report.startedAt}`);
  lines.push(`- 结束: ${report.finishedAt}（耗时 ${report.durationMs} ms）`);
  lines.push(`- 扫描技能: ${report.scanned}；consolidated: ${counts.consolidated}；pruned: ${counts.pruned}；pinned-exempt: ${counts["pinned-exempt"]}`);
  lines.push("");
  lines.push("## 分类明细（consolidated vs pruned）");
  lines.push("");
  lines.push("| 技能 | 分类 | 原因 |");
  lines.push("|---|---|---|");
  for (const o of report.outcomes) {
    lines.push(`| ${o.skillName} | ${o.classification} | ${o.reason} |`);
  }
  if (report.outcomes.length === 0) lines.push("| （无） | - | - |");
  lines.push("");
  lines.push("## 进化统计");
  lines.push("");
  lines.push(`- 追踪技能: ${report.evolutionStats.totalTracked}`);
  lines.push(`- 提取 / 改进 / 弃用: ${report.evolutionStats.totalExtractions} / ${report.evolutionStats.totalImprovements} / ${report.evolutionStats.totalDeprecations}`);
  lines.push(`- 平均版本数: ${report.evolutionStats.averageVersionsPerSkill}`);
  lines.push(`- 使用统计: active ${report.usageTotals.active} / archived ${report.usageTotals.archived}（共 ${report.usageTotals.totalTracked}）`);
  lines.push("");
  lines.push("## 本次归档（pruned，可 restore）");
  lines.push("");
  if (report.archived.length > 0) {
    for (const name of report.archived) lines.push(`- ${name}`);
  } else {
    lines.push("- （无）");
  }
  lines.push("");
  lines.push("## 最近进化记录");
  lines.push("");
  if (report.recentRecords.length > 0) {
    for (const r of report.recentRecords) {
      lines.push(`- ${r.timestamp} \`${r.type}\` **${r.skillName}**：${r.description}`);
    }
  } else {
    lines.push("- （无）");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 原子写入 run.json + REPORT.md 到 reportDir。
 * 遵守 AGENTS.md：CrossProcessLock + atomicWriteFile，绝不 raw writeFileSync。
 */
export async function writeCuratorReport(reportDir: string, report: CuratorRunReport): Promise<void> {
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const lock = new CrossProcessLock(reportDir, "curator-report");
  await lock.withLock(async () => {
    await atomicWriteFile(path.join(reportDir, "run.json"), JSON.stringify(report, null, 2));
    await atomicWriteFile(path.join(reportDir, "REPORT.md"), renderCuratorReportMarkdown(report));
  });
}

/** 汇总 usage 统计为报告所需的计数。 */
export function summarizeUsage(stats: Map<string, SkillUsageStats>): CuratorRunReport["usageTotals"] {
  let active = 0;
  let archived = 0;
  for (const s of stats.values()) {
    if (s.status === "archived") archived += 1;
    else active += 1;
  }
  return { active, archived, totalTracked: stats.size };
}

/** 生成新 runId。 */
export function newCuratorRunId(): string {
  return `curator-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
