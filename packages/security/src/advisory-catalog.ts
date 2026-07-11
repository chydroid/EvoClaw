/**
 * Advisory Catalog — 已知安全公告目录。
 *
 * 对齐 hermes-agent 的 security_audit_startup.py 中 advisory 检测部分：
 * - 维护已知受影响包的公告列表
 * - detectCompromised() 读取当前项目依赖，匹配受影响包
 *
 * 语义版本比较采用简化实现（major.minor.patch），避免引入额外依赖。
 */

import fs from "fs";
import path from "path";

/** 公告严重程度 */
export type AdvisorySeverity = "low" | "moderate" | "high" | "critical";

/** 安全公告 */
export interface Advisory {
  /** 公告 ID（如 "EVOCLAW-ADV-001"） */
  id: string;
  /** 包名 */
  package: string;
  /** 受影响版本范围（如 "<3.3.6" 或 ">=1.4.44 <1.4.5"） */
  affectedVersions: string;
  /** 描述 */
  description: string;
  /** 严重程度 */
  severity: AdvisorySeverity;
  /** 修复建议 */
  recommendation: string;
}

/** 已知安全公告列表 */
export const ADVISORIES: Advisory[] = [
  {
    id: "EVOCLAW-ADV-001",
    package: "event-stream",
    affectedVersions: "<3.3.6",
    description: "恶意依赖注入：event-stream 3.3.6 之前版本包含恶意 flatmap-stream 子依赖",
    severity: "critical",
    recommendation: "升级到 3.3.6 或更高版本，或移除该依赖",
  },
  {
    id: "EVOCLAW-ADV-002",
    package: "colors",
    affectedVersions: ">=1.4.44 <=1.4.49",
    description: "原型污染漏洞：colors 1.4.44-1.4.49 范围存在原型污染风险",
    severity: "high",
    recommendation: "升级到 1.4.50 或更高版本",
  },
];

/**
 * 检测当前项目中安装的受影响包。
 * 读取 process.cwd()/package.json 的 dependencies 和 devDependencies，
 * 与 ADVISORIES 对比，返回匹配的公告列表。
 */
export function detectCompromised(): Advisory[] {
  const installed = readInstalledPackages();
  const found: Advisory[] = [];
  for (const advisory of ADVISORIES) {
    const version = installed[advisory.package];
    if (version && isVersionAffected(version, advisory.affectedVersions)) {
      found.push(advisory);
    }
  }
  return found;
}

/** 读取当前项目 package.json 中的依赖（dependencies + devDependencies） */
function readInstalledPackages(): Record<string, string> {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
  } catch {
    return {};
  }
}

/**
 * 判断版本是否在受影响范围内。
 * 支持格式："<1.2.3", ">=1.2.3 <1.3.0", "<=1.2.3", ">1.2.3", "=1.2.3", "1.2.3"
 */
function isVersionAffected(version: string, range: string): boolean {
  const conditions = range.split(/\s+/).filter((s) => s.length > 0);
  for (const cond of conditions) {
    const match = cond.match(/^(>=|<=|>|<|=)?(.+)$/);
    if (!match) continue;
    const op = match[1] ?? "=";
    const target = match[2];
    const cmp = compareSemver(version, target);
    if (op === "<" && !(cmp < 0)) return false;
    if (op === "<=" && !(cmp <= 0)) return false;
    if (op === ">" && !(cmp > 0)) return false;
    if (op === ">=" && !(cmp >= 0)) return false;
    if (op === "=" && cmp !== 0) return false;
  }
  return true;
}

/** 解析语义版本字符串（支持 ^ 和 ~ 前缀） */
function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^[~^]/, "");
  const parts = clean.split(".").map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** 比较两个语义版本：返回 -1 / 0 / 1 */
function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseSemver(a);
  const [bMajor, bMinor, bPatch] = parseSemver(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}
