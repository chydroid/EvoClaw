#!/usr/bin/env node
/**
 * OSV 漏洞检查脚本
 * 解析 pnpm-lock.yaml 中所有外部依赖，并查询 OSV API 检测已知漏洞。
 *
 * 用法:
 *   npx tsx scripts/osv-check.ts [--json] [--severity LOW|MEDIUM|HIGH|CRITICAL]
 *
 * 退出码:
 *   0 — 未发现 HIGH/CRITICAL 漏洞
 *   1 — 发现 HIGH 或 CRITICAL 漏洞
 *   2 — 脚本执行出错
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// ---------- 类型定义 ----------

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type SeverityOrUnknown = Severity | 'UNKNOWN';

interface CliArgs {
  json: boolean;
  severity: Severity | undefined;
}

interface PkgRef {
  name: string;
  version: string;
}

interface OsvRangeEvent {
  introduced?: string;
  fixed?: string;
}

interface OsvRange {
  type?: string;
  events?: OsvRangeEvent[];
}

interface OsvAffected {
  package?: { name: string; ecosystem: string };
  ranges?: OsvRange[];
  database_specific?: { severity?: string; [k: string]: unknown } | undefined;
}

interface OsvSeverity {
  type?: string;
  score?: string;
}

interface OsvVulnerability {
  id: string;
  summary?: string;
  affected?: OsvAffected[];
  severity?: OsvSeverity[];
  database_specific?: { severity?: string; [k: string]: unknown } | undefined;
  references?: Array<{ url?: string }>;
}

interface OsvResponse {
  vulns?: OsvVulnerability[];
}

interface Finding {
  id: string;
  package: string;
  version: string;
  severity: SeverityOrUnknown;
  summary: string;
  fixedVersions: string[];
  url: string;
}

interface CacheEntry {
  result: OsvResponse;
  timestamp: number;
}

interface CacheFile {
  id: string;
  entries: Record<string, CacheEntry>;
}

// ---------- 常量 ----------

const OSV_API = 'https://api.osv.dev/v1/query';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const CONCURRENCY = 10;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SEVERITY_RANK: Record<SeverityOrUnknown, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

// ---------- 参数解析 ----------

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, severity: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--severity') {
      const v = argv[i + 1];
      const upper = v?.toUpperCase();
      if (upper === 'LOW' || upper === 'MEDIUM' || upper === 'HIGH' || upper === 'CRITICAL') {
        args.severity = upper;
        i++;
      } else {
        throw new Error(`--severity 需要一个值 (LOW|MEDIUM|HIGH|CRITICAL)，得到: ${v ?? '(空)'}`);
      }
    } else if (a.startsWith('--severity=')) {
      const v = a.slice('--severity='.length).toUpperCase();
      if (v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL') {
        args.severity = v;
      } else {
        throw new Error(`无效的 --severity 值: ${v}`);
      }
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        [
          '用法: tsx scripts/osv-check.ts [选项]',
          '',
          '选项:',
          '  --json                       输出 JSON 格式',
          '  --severity <LOW|MEDIUM|HIGH|CRITICAL>  仅显示该级别及以上的漏洞',
          '  -h, --help                   显示帮助',
          '',
          '退出码: 0=正常, 1=发现 HIGH/CRITICAL 漏洞, 2=执行出错',
        ].join('\n') + '\n',
      );
      process.exit(0);
    }
  }
  return args;
}

// ---------- lockfile 解析 ----------

/**
 * 解析 pnpm-lock.yaml 的 packages 段，提取 (name, version) 列表。
 * pnpm v9 的 packages 段形如:
 *   'name@version':           # 作用域包带 @ 前缀，必须加引号
 *     resolution: {...}
 *
 * 部分键含 peer-deps 后缀: 'zod@3.25.0(typescript@5.9.3)'
 * 需要正确切分 name 与 version。
 */
function parseLockfilePackages(content: string): PkgRef[] {
  const lines = content.split('\n');
  const pkgs: PkgRef[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (!inPackages) {
      if (line === 'packages:') inPackages = true;
      continue;
    }
    // packages 段的条目缩进 2 个空格；遇到非缩进的非空行表示已离开该段
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      inPackages = false;
      continue;
    }
    const quoted = /^  '([^']+)':\s*$/.exec(line);
    const unquoted = !quoted ? /^  ([^'\s][^:]*?):\s*$/.exec(line) : null;
    const key = quoted?.[1] ?? unquoted?.[1];
    if (!key || !key.includes('@')) continue;
    const split = splitPackageKey(key);
    if (split) pkgs.push(split);
  }
  return pkgs;
}

/** 将 lockfile 的包键拆分为 name 与 version，处理作用域与 peer-deps 后缀。 */
function splitPackageKey(key: string): PkgRef | undefined {
  let sep: number;
  if (key.startsWith('@')) {
    // 作用域包: @scope/name@version —— 分隔符是第一个 / 之后的 @
    const slashIdx = key.indexOf('/');
    if (slashIdx < 0) return undefined;
    sep = key.indexOf('@', slashIdx + 1);
  } else {
    sep = key.indexOf('@');
  }
  if (sep < 0) return undefined;
  const name = key.slice(0, sep);
  let version = key.slice(sep + 1);
  // 剥离 peer-deps 后缀: 3.25.0(typescript@5.9.3) -> 3.25.0
  const parenIdx = version.indexOf('(');
  if (parenIdx > 0) version = version.slice(0, parenIdx);
  if (!name || !version) return undefined;
  return { name, version };
}

// ---------- OSV 查询 ----------

async function queryOsv(name: string, version: string): Promise<OsvResponse> {
  const body = JSON.stringify({
    package: { name, ecosystem: 'npm' },
    version,
  });
  const res = await fetch(OSV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`OSV API ${res.status} ${res.statusText} for ${name}@${version}`);
  }
  const data = (await res.json()) as OsvResponse;
  return data;
}

// ---------- 严重程度 ----------

function normalizeSeverity(raw: string | undefined): SeverityOrUnknown {
  if (!raw) return 'UNKNOWN';
  const u = raw.toUpperCase();
  if (u === 'CRITICAL') return 'CRITICAL';
  if (u === 'HIGH') return 'HIGH';
  if (u === 'MODERATE' || u === 'MEDIUM') return 'MEDIUM';
  if (u === 'LOW') return 'LOW';
  // 形如数字的 CVSS 分数
  const n = Number(raw);
  if (!Number.isNaN(n) && n > 0) return cvssScoreToSeverity(n);
  return 'UNKNOWN';
}

function cvssScoreToSeverity(score: number): Severity {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  return 'LOW';
}

function pickSeverity(vuln: OsvVulnerability): SeverityOrUnknown {
  // 1. database_specific.severity (GitHub advisory 提供的字符串级别)
  const ds = vuln.database_specific?.severity;
  if (ds) return normalizeSeverity(ds);
  // 2. affected[].database_specific.severity
  for (const aff of vuln.affected ?? []) {
    const s = aff.database_specific?.severity;
    if (s) return normalizeSeverity(s);
  }
  // 3. CVSS 分数
  for (const sev of vuln.severity ?? []) {
    if (sev.score) {
      const n = Number(sev.score);
      if (!Number.isNaN(n) && n > 0) return cvssScoreToSeverity(n);
    }
  }
  return 'UNKNOWN';
}

function pickUrl(vuln: OsvVulnerability): string {
  for (const ref of vuln.references ?? []) {
    if (ref.url) return ref.url;
  }
  return `https://osv.dev/vulnerability/${vuln.id}`;
}

function extractFinding(pkg: PkgRef, vuln: OsvVulnerability): Finding {
  const fixedVersions: string[] = [];
  for (const aff of vuln.affected ?? []) {
    for (const range of aff.ranges ?? []) {
      for (const ev of range.events ?? []) {
        if (ev.fixed) fixedVersions.push(ev.fixed);
      }
    }
  }
  return {
    id: vuln.id,
    package: pkg.name,
    version: pkg.version,
    severity: pickSeverity(vuln),
    summary: vuln.summary ?? '',
    fixedVersions: [...new Set(fixedVersions)],
    url: pickUrl(vuln),
  };
}

// ---------- 缓存 ----------

function loadCache(path: string): CacheFile {
  if (!existsSync(path)) return { id: randomUUID(), entries: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { id: randomUUID(), entries: {} };
    }
    return { id: parsed.id ?? randomUUID(), entries: parsed.entries };
  } catch {
    return { id: randomUUID(), entries: {} };
  }
}

function saveCache(path: string, cache: CacheFile): void {
  writeFileSync(path, JSON.stringify(cache, null, 2), 'utf8');
}

// ---------- 并发控制 ----------

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const lockPath = resolve(ROOT, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    console.error(`未找到 pnpm-lock.yaml: ${lockPath}`);
    process.exit(2);
  }
  const lockContent = readFileSync(lockPath, 'utf8');
  const allPkgs = parseLockfilePackages(lockContent);

  // 跳过 workspace 内部包并去重
  const seen = new Set<string>();
  const pkgs: PkgRef[] = [];
  for (const p of allPkgs) {
    if (p.name.startsWith('@evoclaw/')) continue;
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pkgs.push(p);
  }

  // 加载缓存
  const cachePath = resolve(ROOT, '.osv-cache.json');
  const cache = loadCache(cachePath);
  const now = Date.now();

  const findings: Finding[] = [];
  let queried = 0;
  let cached = 0;
  const errors: string[] = [];

  await mapWithConcurrency(pkgs, CONCURRENCY, async (pkg) => {
    const cacheKey = `${pkg.name}@${pkg.version}`;
    const entry = cache.entries[cacheKey];
    if (entry && now - entry.timestamp < CACHE_TTL_MS) {
      cached++;
      for (const v of entry.result.vulns ?? []) {
        findings.push(extractFinding(pkg, v));
      }
      return;
    }
    try {
      const result = await queryOsv(pkg.name, pkg.version);
      cache.entries[cacheKey] = { result, timestamp: now };
      queried++;
      for (const v of result.vulns ?? []) {
        findings.push(extractFinding(pkg, v));
      }
    } catch (e) {
      errors.push(`${pkg.name}@${pkg.version}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  saveCache(cachePath, cache);

  // 按严重程度过滤展示
  const filtered = args.severity
    ? findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[args.severity as Severity])
    : findings;

  filtered.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          totalPackages: pkgs.length,
          queried,
          cached,
          errors,
          vulnerabilities: filtered,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('\n=== OSV 漏洞检查 ===');
    console.log(`检查包数: ${pkgs.length} (新查询 ${queried}, 缓存命中 ${cached})`);
    if (errors.length > 0) {
      console.log(`查询失败: ${errors.length}`);
      for (const e of errors) console.log(`  - ${e}`);
    }
    console.log(`发现漏洞: ${filtered.length}\n`);
    for (const f of filtered) {
      console.log(`[${f.severity}] ${f.id}`);
      console.log(`  包: ${f.package}@${f.version}`);
      if (f.fixedVersions.length > 0) {
        console.log(`  修复版本: ${f.fixedVersions.join(', ')}`);
      }
      if (f.summary) console.log(`  摘要: ${f.summary}`);
      console.log(`  参考: ${f.url}\n`);
    }
    if (filtered.length === 0) {
      console.log('未发现漏洞。');
    }
  }

  // 退出码以全部发现为准 (不受 --severity 过滤影响)，发现 HIGH/CRITICAL 即 exit 1
  const hasHighCritical = findings.some(
    (f) => f.severity === 'HIGH' || f.severity === 'CRITICAL',
  );
  process.exit(hasHighCritical ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
