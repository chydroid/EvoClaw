/**
 * release-prepare：P3 发布流水线的本地第 1 阶段（Hermes 对标 P3-6 设计 §四）。
 *
 * 职责（只做本地可验证的部分，tag/镜像/receipt 属 CI 阶段见路线图 P3-6）：
 * 1. 按 CHANGELOG.md 成文的 patch-only 规则计算下一个版本号（可 --version 显式指定
 *    minor/major 破坏性升级）；
 * 2. 校验 CHANGELOG.md 已存在对应头条 `## [X.Y.Z] - 今天`，且条目含「根因/修法」
 *    与「验证/测试」两类小节——防漏写 changelog 直接发版；
 * 3. 校验通过后用原子写（temp + fsync + rename，AGENTS.md 约束）更新根 package.json。
 *
 * 用法：
 *   node scripts/release-prepare.mjs            # patch 递增 + 校验 + 写入
 *   node scripts/release-prepare.mjs --dry-run  # 只校验，不写
 *   node scripts/release-prepare.mjs --version 0.93.0   # 显式版本（minor/major）
 */
import { readFileSync, writeFileSync, existsSync, renameSync, fsyncSync, openSync, closeSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** patch-only 递增（CHANGELOG.md 版本升级规则）。 */
export function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`版本号格式非法：${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * 校验 CHANGELOG 条目：头条存在（日期为 today）且正文含根因类 + 验证类小节。
 * 返回 { ok, reasons[] }。
 */
export function validateChangelog(changelogText, version, today) {
  const reasons = [];
  const header = `## [${version}] - ${today}`;
  const idx = changelogText.indexOf(header);
  if (idx === -1) {
    // 宽容：日期可能不是今天（补发），先找无日期约束的头条
    const loose = changelogText.search(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m"));
    if (loose === -1) {
      reasons.push(`CHANGELOG.md 缺少条目头 "${header}"`);
      return { ok: false, reasons };
    }
    reasons.push(`WARN: 条目头日期不是今天（${today}）`);
  }
  // 截取该条目正文（到下一个 ## [ 头条或文件尾）
  const start = idx !== -1 ? idx : changelogText.search(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m"));
  const rest = changelogText.slice(start + 1);
  const nextEntry = rest.search(/\n## \[/);
  const body = nextEntry === -1 ? rest : rest.slice(0, nextEntry);

  const hasRootCause = /根因|修法|改动|问题/.test(body);
  const hasVerification = /验证|测试|实测/.test(body);
  if (!hasRootCause) reasons.push("条目缺少「根因 / 改动」类内容");
  if (!hasVerification) reasons.push("条目缺少「验证 / 测试」类内容");
  if (body.trim().length < 80) reasons.push("条目正文过短（<80 字符），疑似占位");

  const hard = reasons.filter((r) => !r.startsWith("WARN"));
  return { ok: hard.length === 0, reasons };
}

/** 原子写（temp + fsync + rename）。 */
export function atomicWrite(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

/**
 * 执行准备流程。
 * @param {{cwd?: string, version?: string, dryRun?: boolean, today?: string}} opts
 */
export function prepare(opts = {}) {
  const cwd = opts.cwd ?? ROOT;
  const pkgPath = join(cwd, "package.json");
  const changelogPath = join(cwd, "CHANGELOG.md");
  if (!existsSync(pkgPath)) throw new Error(`未找到 ${pkgPath}`);
  if (!existsSync(changelogPath)) throw new Error(`未找到 ${changelogPath}`);

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const current = pkg.version;
  const target = opts.version ?? bumpPatch(current);
  if (target === current && !opts.version) throw new Error("版本号未变化");

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const changelog = readFileSync(changelogPath, "utf-8");
  const { ok, reasons } = validateChangelog(changelog, target, today);
  if (!ok) {
    return { ok: false, current, target, reasons, written: false };
  }

  if (opts.dryRun) {
    return { ok: true, current, target, reasons, written: false, dryRun: true };
  }

  pkg.version = target;
  mkdirSync(dirname(pkgPath), { recursive: true });
  atomicWrite(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return { ok: true, current, target, reasons, written: true };
}

// CLI 入口（直接运行时才执行）
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const vi = args.indexOf("--version");
  const explicit = vi !== -1 ? args[vi + 1] : undefined;
  try {
    const r = prepare({ dryRun, version: explicit });
    for (const reason of r.reasons) console.log(`  - ${reason}`);
    if (!r.ok) {
      console.error(`\n✗ release-prepare 失败：请先在 CHANGELOG.md 补写 "## [${r.target}] - <日期>" 条目（根因/改动/验证三段式），再重跑。`);
      process.exit(1);
    }
    console.log(`✓ ${r.current} → ${r.target}${r.written ? "（package.json 已原子写入）" : "（dry-run，未写入）"}`);
    console.log(`下一步：git add package.json CHANGELOG.md && git commit -m "release: v${r.target}" && git tag v${r.target}`);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
