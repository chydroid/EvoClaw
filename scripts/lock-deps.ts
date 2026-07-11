#!/usr/bin/env node
/**
 * 依赖锁定检查脚本
 * 检查 packages 与 apps 子目录下各 package.json 中的版本范围，
 * 报告使用 ^/~/> 等范围版本的非内部依赖。
 *
 * 用法:
 *   npx tsx scripts/lock-deps.ts [--fix] [--json] [--allow <file>]
 *
 * 退出码:
 *   0 — 所有依赖均精确锁定 (或 --fix 已修复)
 *   1 — 仍存在范围版本依赖
 *   2 — 脚本执行出错
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 类型定义 ----------

interface CliArgs {
  fix: boolean;
  json: boolean;
  allowFile: string | undefined;
}

type DepType = 'dependencies' | 'devDependencies' | 'optionalDependencies';

interface PkgRangeIssue {
  package: string; // workspace 包名 (如 @evoclaw/core)
  path: string; // 相对项目根的 package.json 路径
  dep: string; // 依赖名
  depType: DepType;
  currentRange: string; // 如 ^9.0.0
  suggestedVersion: string; // 如 9.0.0；空表示不可自动修复
  fixable: boolean;
}

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [k: string]: unknown;
}

// ---------- 常量 ----------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEP_TYPES: readonly DepType[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

// 可自动修复 (剥离前缀即得精确版本) 的范围前缀
const FIXABLE_PREFIXES = ['^', '~'];

// ---------- 参数解析 ----------

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { fix: false, json: false, allowFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') {
      args.fix = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--allow') {
      args.allowFile = argv[i + 1];
      i++;
    } else if (a.startsWith('--allow=')) {
      args.allowFile = a.slice('--allow='.length);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        [
          '用法: tsx scripts/lock-deps.ts [选项]',
          '',
          '选项:',
          '  --fix          将 ^X.Y.Z / ~X.Y.Z 改为 X.Y.Z (精确锁定)',
          '  --json         输出 JSON 格式',
          '  --allow <file> 白名单文件 (每行一个包名，# 开头为注释)',
          '  -h, --help     显示帮助',
          '',
          '退出码: 0=所有依赖已精确锁定, 1=仍存在范围版本, 2=执行出错',
        ].join('\n') + '\n',
      );
      process.exit(0);
    }
  }
  return args;
}

// ---------- 版本范围判定 ----------

/**
 * 判断版本字符串是否为范围版本 (非精确、非协议引用)。
 * 跳过 workspace: / file: / link: / git / http 协议依赖。
 */
function isRangeVersion(v: string): boolean {
  if (v.startsWith('workspace:')) return false;
  if (v.startsWith('file:')) return false;
  if (v.startsWith('link:')) return false;
  if (v.startsWith('npm:')) {
    // npm:pkg@range —— 检查内部范围
    const inner = v.slice('npm:'.length);
    const at = inner.lastIndexOf('@');
    const ver = at >= 0 ? inner.slice(at + 1) : inner;
    return isRangeVersion(ver);
  }
  if (
    v.startsWith('git+') ||
    v.startsWith('git:') ||
    v.startsWith('github:') ||
    v.startsWith('http://') ||
    v.startsWith('https://')
  ) {
    return false;
  }
  // 以数字开头且无范围前缀 → 精确版本 (如 1.2.3, 1.0.0-alpha)
  if (/^\d/.test(v) && !FIXABLE_PREFIXES.includes(v[0])) return false;
  // 其余 (*, x, latest, ^, ~, >, <, >=, <=) 均视为范围
  return true;
}

/** 剥离范围前缀，返回精确版本。仅对 ^ / ~ 前缀有效。 */
function stripRangePrefix(v: string): string {
  if (v.startsWith('^') || v.startsWith('~')) return v.slice(1);
  return v;
}

// ---------- 文件发现 ----------

function findPackageJsonFiles(): string[] {
  const results: string[] = [];
  for (const dir of ['packages', 'apps']) {
    const base = resolve(ROOT, dir);
    if (!existsSync(base)) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      // 跳过 node_modules 等无关目录
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const pkgPath = resolve(base, ent.name, 'package.json');
      if (existsSync(pkgPath)) results.push(pkgPath);
    }
  }
  return results;
}

// ---------- 白名单 ----------

function loadAllowlist(path: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!path || !existsSync(path)) return set;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    set.add(trimmed);
  }
  return set;
}

// ---------- 主流程 ----------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const allowlist = loadAllowlist(args.allowFile);
  const files = findPackageJsonFiles();
  const issues: PkgRangeIssue[] = [];

  if (args.allowFile && !existsSync(args.allowFile)) {
    console.error(`白名单文件不存在: ${args.allowFile}`);
    process.exit(2);
  }

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    let json: PkgJson;
    try {
      json = JSON.parse(content) as PkgJson;
    } catch {
      console.error(`无法解析 JSON: ${file}`);
      continue;
    }
    const pkgName = json.name ?? file;
    let modifiedContent = content;

    for (const depType of DEP_TYPES) {
      const deps = json[depType];
      if (!deps || typeof deps !== 'object') continue;
      for (const [dep, range] of Object.entries(deps)) {
        // 跳过 workspace 内部包
        if (dep.startsWith('@evoclaw/')) continue;
        if (!isRangeVersion(range)) continue;
        if (allowlist.has(dep)) continue;

        const fixable = FIXABLE_PREFIXES.includes(range[0]);
        const suggested = fixable ? stripRangePrefix(range) : '';

        issues.push({
          package: pkgName,
          path: relative(ROOT, file),
          dep,
          depType,
          currentRange: range,
          suggestedVersion: suggested,
          fixable,
        });

        if (args.fix && fixable) {
          // 定向替换: "dep": "range" -> "dep": "exact"
          // 仅替换值，保留键与缩进；同名同版本会一并替换 (deps/devDeps 中重复出现亦正确)
          const escDep = escapeRegex(dep);
          const escRange = escapeRegex(range);
          const re = new RegExp(`("${escDep}"\\s*:\\s*)"${escRange}"`, 'g');
          modifiedContent = modifiedContent.replace(re, `$1"${suggested}"`);
        }
      }
    }

    if (args.fix && modifiedContent !== content) {
      writeFileSync(file, modifiedContent, 'utf8');
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          totalChecked: files.length,
          issues,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('\n=== 依赖锁定检查 ===');
    console.log(`检查 package.json 文件数: ${files.length}`);
    console.log(`使用范围版本的依赖: ${issues.length}\n`);
    if (issues.length > 0) {
      const grouped = new Map<string, PkgRangeIssue[]>();
      for (const iss of issues) {
        const arr = grouped.get(iss.package) ?? [];
        arr.push(iss);
        grouped.set(iss.package, arr);
      }
      for (const [pkg, pkgIssues] of grouped) {
        console.log(`[${pkg}]`);
        for (const iss of pkgIssues) {
          const suggest = iss.suggestedVersion
            ? `  建议: ${iss.suggestedVersion}`
            : '  (不可自动修复，需手动确认精确版本)';
          console.log(`  ${iss.depType}: ${iss.dep}`);
          console.log(`    当前: ${iss.currentRange}${suggest}`);
        }
        console.log('');
      }
    } else {
      console.log('所有依赖均已精确锁定。');
    }
    if (args.fix) {
      const fixed = issues.filter((i) => i.fixable).length;
      console.log(`已应用 --fix: 修复 ${fixed} 个依赖为精确版本。`);
    }
  }

  // --fix 后若仍有不可修复项或残留范围，仍退出 1
  const remaining = args.fix ? issues.filter((i) => !i.fixable).length : issues.length;
  process.exit(remaining > 0 ? 1 : 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
