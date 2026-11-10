/**
 * 远程技能安装安全门（对标 hermes-agent tools/skills_guard.py 的 community 信任级）。
 *
 * 背景：`SkillValidator.securityScan` 只扫 SKILL.md 内嵌的 scripts/hooks，
 * 技能包里的**支撑文件**（.js/.py/.sh/.json）、不可见 Unicode、AST 危险模式
 * 从未被检查；`@evoclaw/security` 的 `scanSkill` 覆盖这些面，但此前零调用点。
 *
 * 落点：只在**远程 marketplace 安装**（网络来源 = 不可信）拦截；本地/内置技能
 * 沿用现有 validator，避免把「curl … | bash」这类内置安装说明误杀（实测
 * data/skills 10 个技能里 4 个会被威胁正则命中）。
 *
 * 语义（fail-closed）：扫描命中阻断类威胁 → 拒绝；扫描器自身异常（目录不可读等）
 * → 同样拒绝——宁可拒装，不可在「不知道内容是什么」的情况下注册进索引。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BLOCKING_THREAT_KINDS,
  hasBlockingThreats,
  scanSkill,
  type SkillScanResult,
} from "@evoclaw/security";

export interface InstallScanVerdict {
  /** 是否拒绝安装 */
  blocked: boolean;
  /** 拒绝原因（blocked=true 时必有） */
  reason?: string;
  /** 完整扫描结果（扫描器异常时缺失） */
  scan?: SkillScanResult;
}

/**
 * 扫描待安装技能目录，给出是否放行。
 *
 * 结构问题 / AST 发现只记录不阻断：它们可能是正常工程代码，阻断会误杀；
 * 阻断只认威胁库中的确定性危险类别（见 BLOCKING_THREAT_KINDS）。
 */
export function scanDownloadedSkill(skillDir: string): InstallScanVerdict {
  try {
    const scan = scanSkill(skillDir);
    if (hasBlockingThreats(scan.threats)) {
      const details = scan.threats
        .filter((t) => BLOCKING_THREAT_KINDS.has(t.kind))
        .slice(0, 5)
        .map((t) => `${t.kind}${t.filePath ? `@${t.filePath}` : ""}: ${t.description}`)
        .join("; ");
      return { blocked: true, reason: details, scan };
    }
    return { blocked: false, scan };
  } catch (err) {
    return {
      blocked: true,
      reason: `security scan failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 把被拒绝的技能目录移入隔离区（归档，不删除）。
 *
 * 返回隔离后的路径；移动失败返回 null（调用方仍应拒绝安装，只是无归档路径）。
 */
export function quarantineSkillDir(
  skillDir: string,
  quarantineRoot: string,
  label: string,
): string | null {
  try {
    const safeLabel =
      String(label || "skill").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "skill";
    const dest = path.join(quarantineRoot, `${safeLabel}-${Date.now()}`);
    fs.mkdirSync(quarantineRoot, { recursive: true });
    fs.renameSync(skillDir, dest);
    return dest;
  } catch {
    return null;
  }
}
