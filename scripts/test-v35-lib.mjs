/**
 * EvoClaw v35 压测共享库 —— 10 项「真实办公/工程交付」级复杂多步任务，领域与 v12–v34 零重叠：
 *   T1  依赖许可证合规审计（Python，SPDX 归一 + 策略门禁 + 退出码）
 *   T2  事故时间线重建（Python，JSONL/nginx/syslog 三源归一 + UTC 排序 + RCA）
 *   T3  无障碍(a11y)静态审计（Python，html.parser + 规则分级 + 报告）
 *   T4  日历 RRULE 展开（Node，RFC5545 子集 + DST + EXDATE）
 *   T5  邮箱分诊（Python，mbox 线程归并 + 分类 + 行动清单）
 *   T6  OpenAPI 子集 lint（Node，$ref/operationId/参数/响应规则）
 *   T7  备份归档校验与恢复（Python，manifest sha256 + 篡改检出 + 安全解包）
 *   T8  Dockerfile 静态分析（Python，指令解析 + 安全/体积规则）
 *   T9  发布计划与 CHANGELOG（Node，conventional commits → semver + 幂等 apply）
 *   T10 INI → TOML 配置迁移（Python，重命名/默认值/类型校验 + dry-run diff）
 *
 * 参考实现只用于 harness 自校准与对交付物的独立复算（不复用被测产物）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'node:crypto';
import { writeFixture, FIXTURE_HASHES, canon as canonShared, pyReadTextLiteral, REPO_ROOT } from './v14/lib.mjs';

export { pyReadTextLiteral };
export { FIXTURE_HASHES };
export const WS = '/home/chy/EvoClaw/data/workspace';
export const D = (n) => `${WS}/v35-t${n}`;
export const REF_DIR = path.resolve(REPO_ROOT, 'tests-tmp/v35-ref');
export const canon = canonShared;
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const sha256file = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 路径级 JSON 差异（诊断用，口径同 sameJson）。 */
export function jsonDiff(expected, actual, max = 5) {
  const out = [];
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? 'undefined' : s.length > 72 ? s.slice(0, 72) + '…' : s;
  };
  const walk = (e, a, p) => {
    if (out.length >= max) return;
    const arrE = Array.isArray(e), arrA = Array.isArray(a);
    if (arrE || arrA) {
      if (!arrE || !arrA) { out.push(`${p}: 类型不符 ${brief(e)}→${brief(a)}`); return; }
      if (e.length !== a.length) out.push(`${p}.length: ${e.length}→${a.length}`);
      for (let i = 0; i < Math.max(e.length, a.length) && out.length < max; i++) walk(e[i], a[i], `${p}[${i}]`);
      return;
    }
    const objE = e && typeof e === 'object', objA = a && typeof a === 'object';
    if (objE || objA) {
      if (!objE || !objA) { out.push(`${p}: 类型不符 ${brief(e)}→${brief(a)}`); return; }
      for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
        if (out.length >= max) return;
        if (!(k in e)) out.push(`${p}.${k}: 多余字段 = ${brief(a[k])}`);
        else if (!(k in a)) out.push(`${p}.${k}: 缺失字段（期望 ${brief(e[k])}）`);
        else walk(e[k], a[k], `${p}.${k}`);
      }
      return;
    }
    if (e !== a) out.push(`${p}: ${brief(e)}→${brief(a)}`);
  };
  walk(expected, actual, '$');
  return out;
}
export const diffNote = (actual, expected, max = 5) => jsonDiff(expected, actual, max).join(' | ');

/** Python 模块装载片段（按文件路径 importlib 装载，避免内置模块名遮蔽）。 */
export function pyLoadModule(alias, file) {
  return `import importlib.util as _ilu\n` +
    `_spec = _ilu.spec_from_file_location(${JSON.stringify(alias)}, ${JSON.stringify(file)})\n` +
    `m = _ilu.module_from_spec(_spec)\n` +
    `_spec.loader.exec_module(m)`;
}

/** 在隔离进程中运行一段 node 驱动代码（cwd=dir）。 */
export function runNodeDriver(dir, code, timeoutMs = 60000) {
  const tmp = `/tmp/v35-driver-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;
  fs.writeFileSync(tmp, code);
  try {
    const out = execSync(`timeout 50 node ${JSON.stringify(tmp)} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

export function runNodeIn(dir, args, timeoutMs = 60000) {
  try {
    const out = execSync(`timeout 50 node ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

export function runNodeTestIn(dir, file) {
  try {
    const out = execSync(`timeout 80 node --test ${JSON.stringify(file)} 2>&1`, { cwd: dir, timeout: 90000, encoding: 'utf8' }).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  }
}

export function pyRun(dir, args, timeoutMs = 90000) {
  try {
    const out = execSync(`timeout 80 python3 ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

/**
 * 在 cwd=`cwd` 下运行脚本（脚本本身可在别处，用绝对路径传参）。
 * 泛化核验专用：让 report.json 落在泛化临时目录，而不是覆盖真实任务目录里的 report.json。
 */
export function pyRunCwd(cwd, scriptPath, args = [], timeoutMs = 90000) {
  try {
    const out = execSync(`timeout 80 python3 ${[scriptPath, ...args].map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

/** 同 pyRunCwd，Node 版。 */
export function runNodeCwd(cwd, scriptPath, args = [], timeoutMs = 60000) {
  try {
    const out = execSync(`timeout 50 node ${[scriptPath, ...args].map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

export function tmpDir(tag) {
  const d = `/tmp/v35-check-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
export function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}
export function extractJson(out) {
  const s = String(out).trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let r = tryParse(s);
  if (r !== null) return r;
  const starts = ['{', '['].map((ch) => s.indexOf(ch)).filter((i) => i >= 0).sort((a, b) => a - b);
  for (const st of starts) {
    const close = s[st] === '{' ? '}' : ']';
    const en = s.lastIndexOf(close);
    if (en > st) { r = tryParse(s.slice(st, en + 1)); if (r !== null) return r; }
  }
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    r = tryParse(t);
    if (r !== null) return r;
  }
  return null;
}
export const fileJson = (dir, file) => extractJson(fs.readFileSync(path.join(dir, file), 'utf-8'));
export const readFileSafe = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
export const lastLineJson = (out) => {
  const lines = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
  }
  return null;
};

// ═════════════════════════════ T1: 依赖许可证合规审计 ═════════════════════════════
/** 依赖树（含传递依赖重复项）与许可证策略。 */
export const T1_DEPS = {
  packages: [
    { name: 'app-core', version: '1.0.0', license: 'MIT', deps: ['left-pad', 'gpl-lib', 'unknown-pkg'] },
    { name: 'left-pad', version: '1.3.0', license: 'MIT', deps: [] },
    { name: 'gpl-lib', version: '2.0.0', license: 'GPL-3.0', deps: ['mit-helper'] },
    { name: 'mit-helper', version: '0.9.1', license: 'Apache-2.0', deps: [] },
    { name: 'unknown-pkg', version: '0.0.1', license: 'UNKNOWN', deps: [] },
    { name: 'lgpl-tool', version: '3.1.0', license: 'LGPL-2.1', deps: [] },
    { name: 'apache-util', version: '2.2.0', license: 'Apache-2.0', deps: ['left-pad'] },
    { name: 'bsd-kit', version: '1.1.0', license: 'BSD-3-Clause', deps: [] },
    { name: 'weird-license', version: '0.1.0', license: 'WTFPL', deps: [] },
    { name: 'mit-helper', version: '0.9.1', license: 'Apache-2.0', deps: [] },
  ],
};
export const T1_POLICY = {
  allow: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'],
  deny: ['GPL-3.0', 'AGPL-3.0'],
  unknown: 'fail',
};
/** SPDX 归一：去空白、大小写不敏感、`MIT License` → `MIT`、`Apache 2.0` → `Apache-2.0`。 */
export function t1NormLicense(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  const aliases = {
    'mit license': 'MIT', 'mit': 'MIT',
    'apache 2.0': 'Apache-2.0', 'apache-2.0': 'Apache-2.0', 'apache license 2.0': 'Apache-2.0',
    'bsd-3-clause': 'BSD-3-Clause', 'bsd 3-clause': 'BSD-3-Clause',
    'gpl-3.0': 'GPL-3.0', 'gplv3': 'GPL-3.0', 'gpl 3.0': 'GPL-3.0',
    'agpl-3.0': 'AGPL-3.0', 'lgpl-2.1': 'LGPL-2.1', 'lgpl 2.1': 'LGPL-2.1',
    'isc': 'ISC', 'wtfpl': 'WTFPL', 'unknown': 'UNKNOWN',
  };
  const low = s.toLowerCase();
  if (aliases[low]) return aliases[low];
  // 规范化形态：保留原始大小写但把空格换成 - 作为兜底
  return s.replace(/\s+/g, '-');
}

/**
 * T1 参考结果。去重键 = name@version（重复条目只计一次）。
 * 遍历全部包（含未被引用的），因为审计的是「依赖清单」而非可达图。
 */
export function t1Ref(deps = T1_DEPS, policy = T1_POLICY) {
  const allow = new Set(policy.allow.map(t1NormLicense));
  const deny = new Set(policy.deny.map(t1NormLicense));
  const seen = new Set();
  const rows = [];
  for (const p of deps.packages) {
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lic = t1NormLicense(p.license);
    let status;
    if (deny.has(lic)) status = 'denied';
    else if (allow.has(lic)) status = 'allowed';
    else status = 'unknown';
    rows.push({ name: p.name, version: p.version, license: lic, status });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const allowed = rows.filter((r) => r.status === 'allowed').map((r) => `${r.name}@${r.version}`);
  const denied = rows.filter((r) => r.status === 'denied').map((r) => ({ name: r.name, version: r.version, license: r.license }));
  const unknown = rows.filter((r) => r.status === 'unknown').map((r) => ({ name: r.name, version: r.version, license: r.license }));
  const exitCode = denied.length > 0 || (policy.unknown === 'fail' && unknown.length > 0) ? 1 : 0;
  return {
    allowed, denied, unknown,
    summary: { total: rows.length, allowed: allowed.length, denied: denied.length, unknown: unknown.length },
    exitCode,
  };
}

// ═════════════════════════════ T2: 事故时间线重建 ═════════════════════════════
/**
 * 三源日志（时间口径各不相同）：
 *  - app.jsonl：ISO8601 带偏移（+02:00）
 *  - nginx.log：CLF `01/May/2024:10:00:05 +0200`
 *  - syslog：`May  1 10:00:10 host svc[pid]: msg`（无年份，本地时区 = UTC+2）
 * 统一换算成 UTC 后按时间排序。syslog 年份按给定年份补全。
 */
export const T2_YEAR = 2024;
export const T2_APP_JSONL = [
  { ts: '2024-05-01T10:00:00+02:00', level: 'info', service: 'api', msg: 'deploy v2.3.0 started' },
  { ts: '2024-05-01T10:00:06+02:00', level: 'error', service: 'api', msg: 'connection pool exhausted' },
  { ts: '2024-05-01T10:00:12+02:00', level: 'error', service: 'api', msg: 'upstream timeout' },
  { ts: '2024-05-01T10:00:20+02:00', level: 'warn', service: 'worker', msg: 'retry backlog=120' },
  { ts: '2024-05-01T10:00:31+02:00', level: 'info', service: 'api', msg: 'rollback v2.2.9 started' },
].map((r) => JSON.stringify(r)).join('\n') + '\n';

export const T2_NGINX = [
  '10.0.0.5 - - [01/May/2024:10:00:03 +0200] "GET /health HTTP/1.1" 200 15',
  '10.0.0.6 - - [01/May/2024:10:00:07 +0200] "POST /api/orders HTTP/1.1" 502 173',
  '10.0.0.6 - - [01/May/2024:10:00:09 +0200] "POST /api/orders HTTP/1.1" 502 173',
  '10.0.0.7 - - [01/May/2024:10:00:25 +0200] "GET /api/orders/42 HTTP/1.1" 504 0',
].join('\n') + '\n';

export const T2_SYSLOG = [
  'May  1 10:00:02 web01 kernel: [12345.678] Out of memory: Killed process 4242 (node)',
  'May  1 10:00:15 web01 systemd[1]: api.service: Main process exited, code=killed, status=9/KILL',
  'May  1 10:00:28 web01 systemd[1]: api.service: Scheduled restart job, restart counter is at 3.',
  'May  1 10:00:40 web01 systemd[1]: Started api.service.',
].join('\n') + '\n';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
/** syslog 月日时分秒 + 固定 UTC 偏移（分钟）→ UTC ISO。msg 去掉 `proc[pid]:` 前缀。 */
function syslogToUtc(line, year, tzOffsetMin) {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]) + 1;
  const localMs = Date.UTC(year, mon - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return {
    utc: new Date(localMs - tzOffsetMin * 60000).toISOString(),
    host: m[6], msg: m[7].replace(/^\S+:\s+/, ''),
  };
}
function nginxToUtc(line) {
  const m = /\[(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})\]/.exec(line);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2]) + 1;
  const sign = m[7] === '-' ? -1 : 1;
  const offMin = sign * (Number(m[8]) * 60 + Number(m[9]));
  const localMs = Date.UTC(Number(m[3]), mon - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const st = /\s(\d{3})\s+\d+$/.exec(line);
  return { utc: new Date(localMs - offMin * 60000).toISOString(), status: st ? Number(st[1]) : null, raw: line };
}
/** 解析 app.jsonl 的 ts（带偏移）→ UTC ISO。 */
function isoToUtc(s) {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * T2 参考时间线。events 统一 {utc, source, service, level, msg}，按 utc 升序（同刻按 source 名稳定）。
 * RCA：first_error_utc = 最早 level=error 或 nginx 5xx 的事件；error_count = 这两类事件总数；
 * affected_services = 出现 error 的 service 去重排序（nginx 事件记 service='nginx'，syslog 记 host 的服务名或 'system'）。
 */
export function t2Ref({ year = T2_YEAR, tzOffsetMin = 120 } = {}) {
  const events = [];
  for (const line of T2_APP_JSONL.trim().split('\n')) {
    const r = JSON.parse(line);
    events.push({ utc: isoToUtc(r.ts), source: 'app', service: r.service, level: r.level, msg: r.msg });
  }
  for (const line of T2_NGINX.trim().split('\n')) {
    const p = nginxToUtc(line);
    if (!p) continue;
    events.push({ utc: p.utc, source: 'nginx', service: 'nginx', level: p.status >= 500 ? 'error' : 'info', msg: `HTTP ${p.status}`, status: p.status });
  }
  for (const line of T2_SYSLOG.trim().split('\n')) {
    const p = syslogToUtc(line, year, tzOffsetMin);
    if (!p) continue;
    const isErr = /Killed process|exited, code=|OOM|Out of memory/i.test(p.msg);
    events.push({ utc: p.utc, source: 'syslog', service: 'system', level: isErr ? 'error' : 'info', msg: p.msg });
  }
  events.sort((a, b) => a.utc.localeCompare(b.utc) || a.source.localeCompare(b.source));
  const errs = events.filter((e) => e.level === 'error');
  const services = [...new Set(errs.map((e) => e.service))].sort();
  return {
    events: events.map((e) => ({ utc: e.utc, source: e.source, service: e.service, level: e.level, msg: e.msg })),
    rca: {
      first_error_utc: errs.length ? errs[0].utc : null,
      error_count: errs.length,
      affected_services: services,
    },
  };
}

// ═════════════════════════════ T3: 无障碍(a11y)静态审计 ═════════════════════════════
export const T3_PAGES = {
  'index.html': `<!DOCTYPE html>
<html>
<head><title>Home</title></head>
<body>
  <h1>Welcome</h1>
  <h3>Skipped h2</h3>
  <img src="logo.png">
  <img src="chart.png" alt="Sales chart">
  <button></button>
  <button aria-label="Close">×</button>
  <a href="/about">About</a>
  <a href="/contact"></a>
  <input type="text" name="q">
  <label for="email">Email</label><input id="email" type="email">
  <div id="dup">a</div><div id="dup">b</div>
</body>
</html>
`,
  'about.html': `<!DOCTYPE html>
<html lang="en">
<head><title>About</title></head>
<body>
  <h1>About</h1>
  <h2>Team</h2>
  <img src="team.jpg" alt="">
  <button>Submit</button>
  <form><input type="text" aria-label="search"></form>
</body>
</html>
`,
};

/** T3 规则（按严重度分 error/warning）。参考实现按行号/元素顺序定位。 */
export const T3_RULES = [
  { id: 'img-alt', severity: 'error', desc: 'img 必须有非空 alt（alt="" 视为装饰性，允许）' },
  { id: 'button-name', severity: 'error', desc: 'button 必须有文本或 aria-label' },
  { id: 'link-name', severity: 'error', desc: 'a 必须有文本或 aria-label' },
  { id: 'input-label', severity: 'error', desc: 'input 必须有关联 label 或 aria-label' },
  { id: 'heading-skip', severity: 'warning', desc: '标题层级不得跳跃（h1→h3 违规）' },
  { id: 'duplicate-id', severity: 'error', desc: 'id 必须唯一' },
  { id: 'html-lang', severity: 'warning', desc: '<html> 必须有 lang 属性' },
];

/** 极简 HTML 元素抽取（参考实现用正则，只覆盖测试夹具形态）。 */
function t3Elements(html) {
  const els = [];
  const lines = html.split('\n');
  let lineNo = 0;
  const re = /<(img|button|a|input|h[1-6]|html|div)\b([^>]*)>/gi;
  for (const line of lines) {
    lineNo += 1;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const attrs = m[2] || '';
      const get = (name) => {
        const mm = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
        return mm ? mm[1] : null;
      };
      els.push({ tag: m[1].toLowerCase(), attrs, line: lineNo, alt: get('alt'), ariaLabel: get('aria-label'), id: get('id'), lang: get('lang'), type: get('type'), href: get('href') });
    }
  }
  return els;
}
function t3TextAfter(html, el) {
  // 取该元素开标签后到闭合标签之间的文本（同夹具形态：单行）
  const line = html.split('\n')[el.line - 1] || '';
  const open = line.indexOf('<');
  const close = line.indexOf('>', open);
  const end = line.toLowerCase().indexOf(`</${el.tag}`, close);
  const between = end >= 0 ? line.slice(close + 1, end) : line.slice(close + 1);
  return between.replace(/<[^>]*>/g, '').trim();
}

/** T3 参考结果：按 file 分组，violations 按 line 升序、同 line 按 ruleId。 */
export function t3Ref(pages = T3_PAGES) {
  const report = {};
  for (const [file, html] of Object.entries(pages)) {
    const els = t3Elements(html);
    const viol = [];
    // html lang
    const htmlEl = els.find((e) => e.tag === 'html');
    if (htmlEl && !htmlEl.lang) viol.push({ line: htmlEl.line, ruleId: 'html-lang', severity: 'warning' });
    // heading order
    let prevLevel = 0;
    for (const e of els.filter((x) => /^h[1-6]$/.test(x.tag))) {
      const lvl = Number(e.tag[1]);
      if (prevLevel > 0 && lvl > prevLevel + 1) viol.push({ line: e.line, ruleId: 'heading-skip', severity: 'warning' });
      prevLevel = lvl;
    }
    const idCount = new Map();
    for (const e of els) {
      if (e.id) {
        idCount.set(e.id, (idCount.get(e.id) || 0) + 1);
        if (idCount.get(e.id) === 2) viol.push({ line: e.line, ruleId: 'duplicate-id', severity: 'error' });
      }
    }
    for (const e of els) {
      if (e.tag === 'img' && e.alt === null) viol.push({ line: e.line, ruleId: 'img-alt', severity: 'error' });
      if (e.tag === 'button' && !e.ariaLabel && !t3TextAfter(html, e)) viol.push({ line: e.line, ruleId: 'button-name', severity: 'error' });
      if (e.tag === 'a' && !e.ariaLabel && !t3TextAfter(html, e)) viol.push({ line: e.line, ruleId: 'link-name', severity: 'error' });
      if (e.tag === 'input' && !e.ariaLabel) {
        const hasLabel = e.id && new RegExp(`<label[^>]*\\bfor\\s*=\\s*"${e.id}"`, 'i').test(html);
        if (!hasLabel) viol.push({ line: e.line, ruleId: 'input-label', severity: 'error' });
      }
    }
    viol.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
    report[file] = { violations: viol, errorCount: viol.filter((v) => v.severity === 'error').length, warningCount: viol.filter((v) => v.severity === 'warning').length };
  }
  const totals = { pages: Object.keys(report).length, errors: 0, warnings: 0 };
  for (const r of Object.values(report)) { totals.errors += r.errorCount; totals.warnings += r.warningCount; }
  return { pages: report, totals };
}

// ═════════════════════════════ T4: 日历 RRULE 展开 ═════════════════════════════
/**
 * RRULE 子集（RFC 5545）：FREQ=DAILY|WEEKLY|MONTHLY、INTERVAL、COUNT、UNTIL、
 * BYDAY（周：MO..SU，逗号分隔）、EXDATE。展开为本地时区的日期时间（保留 DTSTART 的钟点）。
 * DST 语义：以 IANA 时区解释本地墙钟时间；春季不存在的 02:30 顺延到 03:30；
 * 秋季重复的 02:30 取第一次（offset 较小的一次）。
 */
export const T4_TZ = 'Europe/Berlin';
export const T4_CASES = [
  {
    name: 'weekly-tue-count',
    dtstart: '2024-01-02T09:00:00', // 周二
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=4',
    exdate: [],
  },
  {
    name: 'daily-until',
    dtstart: '2024-02-27T08:00:00',
    rrule: 'FREQ=DAILY;UNTIL=20240301T080000Z', // UTC 截止
    exdate: ['2024-02-29T08:00:00'],
  },
  {
    name: 'monthly-31',
    dtstart: '2024-01-31T12:00:00',
    rrule: 'FREQ=MONTHLY;COUNT=4',
    exdate: [],
  },
  {
    name: 'dst-spring',
    dtstart: '2024-03-29T02:30:00', // 周五；3/31 02:30 不存在
    rrule: 'FREQ=DAILY;COUNT=4',
    exdate: [],
  },
];

/**
 * T4 参考实现（纯 JS，用固定偏移规则模拟 Europe/Berlin 的 2024 年 DST）。
 * Berlin 2024：CET=UTC+1（冬），CEST=UTC+2（夏）；3/31 02:00→03:00 切换，10/27 03:00→02:00。
 * 输出：每个 case 的展开列表（本地 ISO 无偏移），以及 UTC 毫秒时间戳用于交叉校验。
 */
const BERLIN_DST_START = Date.UTC(2024, 2, 31, 1, 0, 0); // 2024-03-31 01:00Z = 02:00 CET→CEST
const BERLIN_DST_END = Date.UTC(2024, 9, 27, 1, 0, 0);   // 2024-10-27 01:00Z = 03:00 CEST→CET
function berlinOffsetHours(utcMs) {
  return utcMs >= BERLIN_DST_START && utcMs < BERLIN_DST_END ? 2 : 1;
}
/** 本地墙钟（Berlin）→ UTC 毫秒；春季不存在的墙钟顺延 +1h。 */
function berlinLocalToUtcMs(localStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(localStr);
  if (!m) return null;
  const naiveMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // 先假设冬令时 +1，再看该 UTC 是否落在夏令时区间
  for (const guess of [1, 2]) {
    const utc = naiveMs - guess * 3600000;
    if (berlinOffsetHours(utc) === guess) {
      // 春季：若墙钟落在 02:00-03:00 空洞，正常 +1 假设会得到 01:xxZ，其偏移应为 1，但 03:00 后为 2。
      return utc;
    }
  }
  // 空洞：02:30 不存在 → 顺延 +1h 到 03:30 本地（offset 2）→ UTC = (naive+1h) - 2h = naive - 1h
  return naiveMs - 3600000;
}
function utcMsToBerlinLocal(utcMs) {
  const off = berlinOffsetHours(utcMs);
  const d = new Date(utcMs + off * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(s) {
  const out = {};
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    out[k.toUpperCase()] = v;
  }
  return out;
}

export function t4ExpandCase(c) {
  const rule = parseRrule(c.rrule);
  const freq = rule.FREQ;
  const interval = rule.INTERVAL ? Number(rule.INTERVAL) : 1;
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const untilUtcMs = rule.UNTIL ? (() => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(rule.UNTIL);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  })() : null;
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map((d) => WEEKDAY[d]) : null;
  const exdates = new Set(c.exdate.map((e) => berlinLocalToUtcMs(e)));

  // 起始墙钟
  const startLocal = c.dtstart;
  const sm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(startLocal);
  const hh = +sm[4], mi = +sm[5], ss = +sm[6];
  const startDateMs = Date.UTC(+sm[1], +sm[2] - 1, +sm[3]);

  const results = [];
  const dayMs = 86400000;
  let cursorDay = startDateMs;
  let guard = 0;
  let n = 0;
  const localOf = (dayMsVal) => {
    const d = new Date(dayMsVal);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(hh)}:${p(mi)}:${p(ss)}`;
  };
  const emit = (dayMsVal) => {
    const local = localOf(dayMsVal);
    const utc = berlinLocalToUtcMs(local);
    if (exdates.has(utc)) return false; // 跳过（不计入 count），继续展开
    results.push({ local: utcMsToBerlinLocal(utc), utc: new Date(utc).toISOString() });
    n += 1;
    return count != null && n >= count;
  };

  if (freq === 'DAILY') {
    let day = cursorDay;
    while (guard++ < 1000) {
      const stop = emit(day);
      if (stop) break;
      day += dayMs * interval;
      if (untilUtcMs != null) {
        const cur = berlinLocalToUtcMs(localOf(day));
        if (cur > untilUtcMs) break;
      }
    }
  } else if (freq === 'WEEKLY') {
    // BYDAY 指定周几；从 start 起按 interval 周步进
    const days = byday || [new Date(startDateMs).getUTCDay()];
    // 找到 start 所在周的周一
    const startDow = new Date(startDateMs).getUTCDay();
    const mondayOffset = (startDow + 6) % 7; // MO=0
    let weekMonday = startDateMs - mondayOffset * dayMs;
    while (guard++ < 1000) {
      let stop = false;
      for (const dow of days.slice().sort((a, b) => a - b)) {
        const day = weekMonday + ((dow + 6) % 7) * dayMs;
        if (day < startDateMs) continue;
        if (untilUtcMs != null && berlinLocalToUtcMs(localOf(day)) > untilUtcMs) { stop = true; break; }
        if (emit(day)) { stop = true; break; }
      }
      if (stop) break;
      weekMonday += 7 * dayMs * interval;
      if (untilUtcMs != null && berlinLocalToUtcMs(localOf(weekMonday)) > untilUtcMs) break;
    }
  } else if (freq === 'MONTHLY') {
    const base = new Date(startDateMs);
    const dayOfMonth = base.getUTCDate();
    let monthIdx = 0;
    while (guard++ < 1000) {
      const y = base.getUTCFullYear();
      const mo = base.getUTCMonth() + monthIdx * interval;
      const firstOfMonth = new Date(Date.UTC(y, mo, 1));
      const daysInMonth = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() + 1, 0)).getUTCDate();
      // 该月无此日（如 31 号遇 2 月）→ 跳过该月
      if (dayOfMonth <= daysInMonth) {
        const day = Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth(), dayOfMonth);
        if (untilUtcMs != null && berlinLocalToUtcMs(localOf(day)) > untilUtcMs) break;
        if (emit(day)) break;
      }
      monthIdx += 1;
    }
  }
  return results;
}

export function t4Ref(cases = T4_CASES) {
  const out = {};
  for (const c of cases) out[c.name] = t4ExpandCase(c);
  return out;
}

// ═════════════════════════════ T5: 邮箱分诊 ═════════════════════════════
/**
 * mbox 邮件集：按 In-Reply-To / References 归并成线程；每条邮件分类
 * （action_required / fyi / spam）；输出每线程最新状态 + 全局行动清单。
 */
export const T5_MESSAGES = [
  { id: 'm1', from: 'alice@corp.com', to: 'team@corp.com', subject: 'Q3 budget review', date: '2024-06-03T09:00:00Z', inReplyTo: null, references: [], body: 'Please review the attached Q3 budget and reply by Friday.' },
  { id: 'm2', from: 'bob@corp.com', to: 'alice@corp.com', subject: 'Re: Q3 budget review', date: '2024-06-03T11:30:00Z', inReplyTo: 'm1', references: ['m1'], body: 'Looks good to me. Approved.' },
  { id: 'm3', from: 'carol@corp.com', to: 'team@corp.com', subject: 'Re: Q3 budget review', date: '2024-06-03T14:00:00Z', inReplyTo: 'm1', references: ['m1'], body: 'I have a question about line 42, can we discuss?' },
  { id: 'm4', from: 'newsletter@shop.io', to: 'alice@corp.com', subject: '50% OFF today only!', date: '2024-06-04T08:00:00Z', inReplyTo: null, references: [], body: 'Unsubscribe here. Big sale!' },
  { id: 'm5', from: 'dave@corp.com', to: 'team@corp.com', subject: 'Standup notes', date: '2024-06-04T09:15:00Z', inReplyTo: null, references: [], body: 'FYI: standup notes for today are in the wiki.' },
  { id: 'm6', from: 'carol@corp.com', to: 'alice@corp.com', subject: 'Re: Q3 budget review', date: '2024-06-04T10:00:00Z', inReplyTo: 'm3', references: ['m1', 'm3'], body: 'Can you confirm the numbers on line 42 by EOD? Action needed.' },
];
/** 分类规则（确定性）：
 *  spam：from 域名为 newsletter@ 或 body 含 "unsubscribe"（大小写不敏感）；
 *  action_required：body 含 "reply by" / "action needed" / "can you confirm" / "please review"（大小写不敏感）；
 *  fyi：其余。
 */
export function t5Classify(msg) {
  const body = msg.body.toLowerCase();
  if (/newsletter@/.test(msg.from) || body.includes('unsubscribe')) return 'spam';
  if (/reply by|action needed|can you confirm|please review/.test(body)) return 'action_required';
  return 'fyi';
}
export function t5Ref(messages = T5_MESSAGES) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  // 线程根：沿 inReplyTo/references 找最早根
  const rootOf = (m) => {
    let cur = m;
    const seen = new Set();
    while (cur.inReplyTo && byId.has(cur.inReplyTo) && !seen.has(cur.inReplyTo)) {
      seen.add(cur.inReplyTo);
      cur = byId.get(cur.inReplyTo);
    }
    return cur.id;
  };
  const threads = new Map();
  for (const m of messages) {
    const root = rootOf(m);
    if (!threads.has(root)) threads.set(root, []);
    threads.get(root).push(m);
  }
  const threadOut = [];
  for (const [root, msgs] of threads) {
    msgs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = msgs[msgs.length - 1];
    const classifications = [...new Set(msgs.map(t5Classify))].sort();
    // 线程状态：任一 action_required → action_required；否则全 spam → spam；否则 fyi
    let status;
    if (classifications.includes('action_required')) status = 'action_required';
    else if (classifications.every((c) => c === 'spam')) status = 'spam';
    else status = 'fyi';
    threadOut.push({
      root, subject: byId.get(root).subject, messageCount: msgs.length,
      latestFrom: latest.from, latestDate: latest.date, status,
    });
  }
  threadOut.sort((a, b) => a.root.localeCompare(b.root));
  // 行动清单：所有 action_required 邮件（按日期）
  const actions = messages.filter((m) => t5Classify(m) === 'action_required')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date }));
  const counts = { action_required: 0, fyi: 0, spam: 0 };
  for (const m of messages) counts[t5Classify(m)] += 1;
  return { threads: threadOut, actions, counts };
}

// ═════════════════════════════ T6: OpenAPI 子集 lint ═════════════════════════════
/**
 * OpenAPI 3.0 子集校验。规则（按 code 排序输出）：
 *  - ref-missing：$ref 指向的本地组件不存在（`#/components/...`）
 *  - ref-unused：components 下定义未被任何 $ref 引用
 *  - opid-missing：每个 operation（get/put/post/delete/patch）缺 operationId
 *  - opid-duplicate：operationId 重复
 *  - param-path-mismatch：path 模板变量 {x} 与 parameters 的 in:path 名称集合不一致
 *  - response-missing：operation 缺 responses 或 responses 为空
 *  - tag-undeclared：operation 使用了顶层未声明的 tag
 */
export const T6_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Shop API', version: '1.0.0' },
  tags: [{ name: 'orders' }, { name: 'users' }],
  paths: {
    '/orders/{id}': {
      get: {
        operationId: 'getOrder', tags: ['orders'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
      delete: {
        // 缺 operationId
        tags: ['orders'],
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { 204: { description: 'deleted' } },
      },
    },
    '/users': {
      get: { operationId: 'listUsers', tags: ['users'], responses: { 200: { description: 'ok' } } },
      post: { operationId: 'createUser', tags: ['admin'], responses: {} },
    },
    '/users/{userId}/items': {
      get: {
        operationId: 'listUserItems',
        tags: ['users'],
        parameters: [{ name: 'user_id', in: 'path', required: true }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Order: { type: 'object', properties: { id: { type: 'string' }, total: { $ref: '#/components/schemas/Money' } } },
      Money: { type: 'object', properties: { cents: { type: 'integer' } } },
      Unused: { type: 'object' },
      Item: { type: 'object', properties: { sku: { type: 'string' }, price: { $ref: '#/components/schemas/DoesNotExist' } } },
    },
  },
};

/** 深度遍历收集所有 $ref 字符串与 operation 元信息。 */
function t6Walk(node, cb) {
  if (Array.isArray(node)) { node.forEach((x) => t6Walk(x, cb)); return; }
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') cb(node.$ref);
    for (const [k, v] of Object.entries(node)) t6Walk(v, cb);
  }
}
function t6RefTargetExists(spec, ref) {
  if (!ref.startsWith('#/')) return true; // 远程 ref 不校验
  const parts = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = spec;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

export function t6Ref(spec = T6_SPEC) {
  const issues = [];
  const add = (code, where) => issues.push({ code, where });
  const refs = [];
  t6Walk(spec.paths, (r) => refs.push(r));
  t6Walk(spec.components, (r) => refs.push(r));
  // ref-missing
  for (const r of refs) if (!t6RefTargetExists(spec, r)) add('ref-missing', r);
  // ref-unused：components 下的每个定义
  const usedRefs = new Set(refs);
  for (const section of Object.keys(spec.components || {})) {
    for (const name of Object.keys(spec.components[section])) {
      const refStr = `#/components/${section}/${name}`;
      if (!usedRefs.has(refStr)) add('ref-unused', refStr);
    }
  }
  // operations
  const opIds = new Map();
  const declaredTags = new Set((spec.tags || []).map((t) => t.name));
  for (const [p, item] of Object.entries(spec.paths)) {
    const pathVars = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${p}`;
      if (!op.operationId) add('opid-missing', where);
      else {
        if (opIds.has(op.operationId)) add('opid-duplicate', op.operationId);
        opIds.set(op.operationId, where);
      }
      if (!op.responses || Object.keys(op.responses).length === 0) add('response-missing', where);
      for (const tag of op.tags || []) if (!declaredTags.has(tag)) add('tag-undeclared', `${where}:${tag}`);
      const pathParams = (op.parameters || []).filter((x) => x && x.in === 'path').map((x) => x.name).sort();
      if (JSON.stringify(pathParams) !== JSON.stringify(pathVars)) add('param-path-mismatch', where);
    }
  }
  issues.sort((a, b) => a.code.localeCompare(b.code) || a.where.localeCompare(b.where));
  return { issues, summary: { total: issues.length, byCode: issues.reduce((acc, i) => (acc[i.code] = (acc[i.code] || 0) + 1, acc), {}) } };
}

// ═════════════════════════════ T7: 备份归档校验与恢复 ═════════════════════════════
/**
 * 备份包 = 目录树 + manifest.json（每个文件的 sha256 + size）。
 * 任务：实现 verify（校验完整性、检出篡改/缺失/多余）与 restore（安全解包到目标目录，
 * 拒绝路径穿越 ../ 与绝对路径、拒绝符号链接）。夹具含一个被篡改的文件 + 一个多余文件。
 */
export const T7_FILES = [
  { rel: 'data/a.txt', content: 'alpha content\n' },
  { rel: 'data/b.txt', content: 'bravo content\n' },
  { rel: 'data/sub/c.txt', content: 'charlie\n' },
  { rel: 'config/app.ini', content: '[db]\nhost=localhost\nport=5432\n' },
];
/** manifest 记录（生成时基于原始内容）。 */
export function t7Manifest(files = T7_FILES) {
  const entries = {};
  for (const f of files) {
    entries[f.rel] = { sha256: sha256hex(Buffer.from(f.content, 'utf8')), size: Buffer.byteLength(f.content, 'utf8') };
  }
  return { version: 1, files: entries };
}
/** 篡改：a.txt 内容被改；extra.txt 是 manifest 未登记的多余文件。 */
export const T7_TAMPERED = { 'data/a.txt': 'ALPHA CONTENT (tampered)\n' };
export const T7_EXTRA = { 'data/extra.txt': 'not in manifest\n' };
/** 恶意归档成员（用于安全解包测试）。 */
export const T7_EVIL_MEMBERS = ['../escape.txt', '/etc/abs.txt', 'data/../../escape2.txt'];

/** T7 verify 参考：status ∈ ok | modified | missing | extra。 */
export function t7VerifyRef(manifest, actualFiles) {
  // actualFiles: { rel: Buffer }
  const issues = [];
  const seen = new Set();
  for (const [rel, meta] of Object.entries(manifest.files)) {
    seen.add(rel);
    if (!(rel in actualFiles)) { issues.push({ rel, status: 'missing' }); continue; }
    const buf = actualFiles[rel];
    const sha = sha256hex(buf);
    if (sha !== meta.sha256 || buf.length !== meta.size) issues.push({ rel, status: 'modified' });
  }
  for (const rel of Object.keys(actualFiles)) {
    if (!seen.has(rel)) issues.push({ rel, status: 'extra' });
  }
  issues.sort((a, b) => a.rel.localeCompare(b.rel) || a.status.localeCompare(b.status));
  return { ok: issues.length === 0, issues, summary: { total: issues.length } };
}

// ═════════════════════════════ T8: Dockerfile 静态分析 ═════════════════════════════
/**
 * Dockerfile 规则（按 code 排序）：
 *  - latest-tag：FROM 使用 :latest 或无 tag（除 scratch）
 *  - no-user：最终 stage 未设置非 root USER
 *  - add-instead-copy：使用 ADD（除解压 tar 的合理场景也警告）
 *  - apt-no-clean：apt-get install 后未 rm -rf /var/lib/apt/lists
 *  - curl-pipe-sh：RUN 里 curl|sh 或 wget|sh
 *  - secret-env：ENV/ARG 出现疑似密钥（KEY/SECRET/TOKEN/PASSWORD）
 *  - many-layers：RUN 指令数 > 阈值（层数膨胀）
 *  - workdir-missing：最终 stage 无 WORKDIR
 */
export const T8_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:latest AS build
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

FROM ubuntu:22.04
ADD app.tar.gz /app
ENV API_SECRET=hardcoded-secret-value
RUN apt-get update && apt-get install -y curl python3
RUN curl -sSL https://example.com/install.sh | sh
RUN echo one
RUN echo two
RUN echo three
RUN echo four
RUN echo five
CMD ["node", "/app/server.js"]
`;
export const T8_MAX_RUN = 4;

export function t8Ref(dockerfile = T8_DOCKERFILE, maxRun = T8_MAX_RUN) {
  const lines = dockerfile.split('\n');
  const issues = [];
  const add = (code, line) => issues.push({ code, line });
  // 拆分 stage
  const stages = [];
  let cur = null;
  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const instr = m[1].toUpperCase();
    const args = m[2];
    if (instr === 'FROM') {
      const image = args.split(/\s+/)[0];
      cur = { image, instrs: [], lineNo, user: null, workdir: null, runCount: 0, aptClean: true, hasAdd: false, secrets: [], curlPipe: false };
      stages.push(cur);
      const tag = image.includes(':') ? image.split(':').pop() : '';
      if (image !== 'scratch' && (!tag || tag === 'latest')) add('latest-tag', lineNo);
      continue;
    }
    if (!cur) continue;
    cur.instrs.push({ instr, args, lineNo });
    if (instr === 'USER') cur.user = args.trim();
    if (instr === 'WORKDIR') cur.workdir = args.trim();
    if (instr === 'ADD') cur.hasAdd = true;
    if (instr === 'ENV' || instr === 'ARG') {
      const kv = args.split('=');
      if (kv.length >= 2 && /(KEY|SECRET|TOKEN|PASSWORD)/i.test(kv[0])) cur.secrets.push(lineNo);
    }
    if (instr === 'RUN') {
      cur.runCount += 1;
      if (/\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i.test(args)) cur.curlPipe = true;
      if (/apt-get\s+install/.test(args)) {
        if (!/rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(args)) cur.aptClean = false;
      }
    }
  }
  const final = stages[stages.length - 1];
  if (final) {
    if (!final.user || final.user === 'root' || final.user === '0') add('no-user', final.lineNo);
    if (!final.workdir) add('workdir-missing', final.lineNo);
    if (final.hasAdd) add('add-instead-copy', final.lineNo);
    if (!final.aptClean) add('apt-no-clean', final.lineNo);
    if (final.curlPipe) add('curl-pipe-sh', final.lineNo);
    for (const l of final.secrets) add('secret-env', l);
    if (final.runCount > maxRun) add('many-layers', final.lineNo);
  }
  issues.sort((a, b) => a.code.localeCompare(b.code) || a.line - b.line);
  return { issues, summary: { total: issues.length, byCode: issues.reduce((acc, i) => (acc[i.code] = (acc[i.code] || 0) + 1, acc), {}) } };
}

// ═════════════════════════════ T9: 发布计划与 CHANGELOG ═════════════════════════════
/**
 * 从 conventional commits 推导下一个版本，并生成 CHANGELOG 条目。
 * 规则（从 v1.2.3 起）：
 *  - 任一 `feat!:` / `fix!:` / 任意类型带 `!` 或 body 含 `BREAKING CHANGE:` → major
 *  - 否则任一 `feat:` → minor
 *  - 否则任一 `fix:` / `perf:` → patch
 *  - 否则无版本变更（保持原版本）
 * 版本递增后，主版本/次版本/补丁对应位置归零。
 * CHANGELOG 分组顺序固定：Breaking / Features / Bug Fixes / Performance / Other（仅含非空组）。
 */
export const T9_BASE_VERSION = '1.2.3';
export const T9_COMMITS = [
  { subject: 'feat(api): add pagination to /orders' },
  { subject: 'fix(api): handle null customer id' },
  { subject: 'docs: update README' },
  { subject: 'feat(ui): dark mode toggle' },
  { subject: 'perf(db): add index on orders.ts' },
  { subject: 'chore: bump deps' },
];

/** 解析一条 commit：`type(scope)!: subject`。返回 {type, scope, breaking, subject}。 */
export function t9ParseCommit(c) {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(c.subject);
  if (!m) return { type: 'other', scope: null, breaking: false, subject: c.subject };
  return { type: m[1], scope: m[2] || null, breaking: m[3] === '!' || !!c.breaking, subject: m[4] };
}
export function t9Bump(version, commits) {
  const parsed = commits.map(t9ParseCommit);
  const breaking = parsed.some((p) => p.breaking);
  const feat = parsed.some((p) => p.type === 'feat');
  const fix = parsed.some((p) => p.type === 'fix' || p.type === 'perf');
  const [maj, min, pat] = version.split('.').map(Number);
  let next = version, level = 'none';
  if (breaking) { next = `${maj + 1}.0.0`; level = 'major'; }
  else if (feat) { next = `${maj}.${min + 1}.0`; level = 'minor'; }
  else if (fix) { next = `${maj}.${min}.${pat + 1}`; level = 'patch'; }
  return { next, level };
}
export function t9Ref(version = T9_BASE_VERSION, commits = T9_COMMITS) {
  const { next, level } = t9Bump(version, commits);
  const parsed = commits.map(t9ParseCommit);
  const groups = { breaking: [], features: [], fixes: [], perf: [], other: [] };
  for (const p of parsed) {
    const line = p.scope ? `**${p.scope}:** ${p.subject}` : p.subject;
    if (p.breaking) groups.breaking.push(line);
    else if (p.type === 'feat') groups.features.push(line);
    else if (p.type === 'fix') groups.fixes.push(line);
    else if (p.type === 'perf') groups.perf.push(line);
    else groups.other.push(line);
  }
  const headings = { breaking: 'Breaking Changes', features: 'Features', fixes: 'Bug Fixes', perf: 'Performance', other: 'Other' };
  const ordered = ['breaking', 'features', 'fixes', 'perf', 'other'].filter((k) => groups[k].length);
  return { version: next, level, groups, headings: ordered.map((k) => headings[k]) };
}

// ═════════════════════════════ T10: INI → TOML 配置迁移 ═════════════════════════════
/**
 * 把 INI 迁移到 TOML，带重命名映射、默认值补全、类型校验（int/bool/str）。
 * 规则：
 *  - 节名映射：`[server]`→`server`，`[db]`→`database`（重命名表）；未映射节保留原名。
 *  - 键重命名：`host`→`hostname`（仅 server 节）、`pool`→`pool_size`（仅 database 节）。
 *  - 类型：`port`/`pool_size` 为 int；`debug`/`ssl` 为 bool；其余 str。
 *  - 默认值：database.pool_size 缺失补 10；server.timeout 缺失补 30。
 *  - 校验失败（如 port 非整数）→ 记入 errors，不中止（收集全部）。
 * 输出：迁移后的结构化对象 + dry-run diff（每个变更一行）。
 */
export const T10_INI = `[server]
host = 0.0.0.0
port = 8080
debug = true

[db]
host = db.internal
pool = 20
ssl = false

[logging]
level = info
`;
export const T10_DEFAULTS = { 'server.timeout': 30, 'database.pool_size': 10 };
export const T10_TYPES = { 'server.port': 'int', 'database.pool_size': 'int', 'server.debug': 'bool', 'database.ssl': 'bool' };
export const T10_SECTION_MAP = { server: 'server', db: 'database', logging: 'logging' };
export const T10_KEY_MAP = { 'server.host': 'hostname', 'db.host': 'hostname', 'db.pool': 'pool_size' };

/** 解析 INI（简单 key=value，忽略空行/注释）。 */
export function t10ParseIni(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sm = /^\[([^\]]+)\]$/.exec(line);
    if (sm) { section = sm[1].trim(); out[section] = {}; continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && section) out[section][kv[1].trim()] = kv[2].trim();
  }
  return out;
}
function t10Coerce(type, raw) {
  if (type === 'int') {
    if (!/^-?\d+$/.test(String(raw))) return { error: `not an int: ${raw}` };
    return { value: Number(raw) };
  }
  if (type === 'bool') {
    const s = String(raw).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return { value: true };
    if (s === 'false' || s === '0' || s === 'no') return { value: false };
    return { error: `not a bool: ${raw}` };
  }
  return { value: String(raw) };
}
export function t10Ref(ini = T10_INI, { defaults = T10_DEFAULTS, types = T10_TYPES, sectionMap = T10_SECTION_MAP, keyMap = T10_KEY_MAP } = {}) {
  const parsed = t10ParseIni(ini);
  const result = {};
  const errors = [];
  const changes = [];
  for (const [rawSection, kv] of Object.entries(parsed)) {
    const section = sectionMap[rawSection] || rawSection;
    if (!result[section]) result[section] = {};
    for (const [rawKey, rawVal] of Object.entries(kv)) {
      const fullRaw = `${rawSection}.${rawKey}`;
      const newKey = keyMap[fullRaw] || rawKey;
      const fullNew = `${section}.${newKey}`;
      const type = types[fullNew] || 'str';
      const c = t10Coerce(type, rawVal);
      if (c.error) { errors.push({ key: fullNew, error: c.error }); continue; }
      result[section][newKey] = c.value;
      if (section !== rawSection || newKey !== rawKey) changes.push(`rename ${fullRaw} -> ${fullNew}`);
      else changes.push(`keep ${fullNew}=${JSON.stringify(c.value)}`);
    }
  }
  for (const [dotted, dv] of Object.entries(defaults)) {
    const [section, key] = dotted.split('.');
    if (!result[section]) result[section] = {};
    if (!(key in result[section])) {
      result[section][key] = dv;
      changes.push(`default ${dotted}=${JSON.stringify(dv)}`);
    }
  }
  changes.sort();
  return { config: result, errors, changes, ok: errors.length === 0 };
}

// ═════════════════════════════ seed ═════════════════════════════
function writeText(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function writeFixtureFile(dir, rel, content) {
  const p = writeText(dir, rel, content);
  FIXTURE_HASHES.set(p, createHash('sha1').update(content, 'utf8').digest('hex'));
  return p;
}

/** 构造 T7 的备份目录（含 manifest + 被篡改文件 + 多余文件）。 */
export function seedT7(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const backup = path.join(root, 'backup');
  for (const f of T7_FILES) writeFixtureFile(backup, f.rel, f.content);
  // manifest 基于原始内容
  const man = t7Manifest();
  writeFixtureFile(backup, 'manifest.json', JSON.stringify(man, null, 2) + '\n');
  // 篡改 + 多余
  for (const [rel, content] of Object.entries(T7_TAMPERED)) writeFixtureFile(backup, rel, content);
  for (const [rel, content] of Object.entries(T7_EXTRA)) writeFixtureFile(backup, rel, content);
  // 恶意归档成员清单（供安全解包测试）
  writeFixtureFile(root, 'evil_members.txt', T7_EVIL_MEMBERS.join('\n') + '\n');
  return backup;
}

export function seed() {
  // T1
  writeFixtureFile(D(1), 'deps.json', JSON.stringify(T1_DEPS, null, 2) + '\n');
  writeFixtureFile(D(1), 'policy.json', JSON.stringify(T1_POLICY, null, 2) + '\n');

  // T2
  writeFixtureFile(D(2), 'app.jsonl', T2_APP_JSONL);
  writeFixtureFile(D(2), 'nginx.log', T2_NGINX);
  writeFixtureFile(D(2), 'syslog.log', T2_SYSLOG);
  writeFixtureFile(D(2), 'meta.json', JSON.stringify({ year: T2_YEAR, tzOffsetMin: 120 }, null, 2) + '\n');

  // T3
  for (const [file, html] of Object.entries(T3_PAGES)) writeFixtureFile(D(3), file, html);
  writeFixtureFile(D(3), 'rules.json', JSON.stringify(T3_RULES, null, 2) + '\n');

  // T4
  writeFixtureFile(D(4), 'cases.json', JSON.stringify({ tz: T4_TZ, cases: T4_CASES }, null, 2) + '\n');

  // T5
  writeFixtureFile(D(5), 'messages.json', JSON.stringify(T5_MESSAGES, null, 2) + '\n');

  // T6
  writeFixtureFile(D(6), 'openapi.json', JSON.stringify(T6_SPEC, null, 2) + '\n');

  // T7
  seedT7(D(7));

  // T8
  writeFixtureFile(D(8), 'Dockerfile', T8_DOCKERFILE);
  writeFixtureFile(D(8), 'limits.json', JSON.stringify({ maxRun: T8_MAX_RUN }, null, 2) + '\n');

  // T9
  writeFixtureFile(D(9), 'commits.json', JSON.stringify({ baseVersion: T9_BASE_VERSION, commits: T9_COMMITS }, null, 2) + '\n');

  // T10
  writeFixtureFile(D(10), 'config.ini', T10_INI);
  writeFixtureFile(D(10), 'migration.json', JSON.stringify({
    sectionMap: T10_SECTION_MAP, keyMap: T10_KEY_MAP, defaults: T10_DEFAULTS, types: T10_TYPES,
  }, null, 2) + '\n');
}

export function saveFixtureHashes(file = `${WS}/v35-fixture-hashes.json`) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURE_HASHES), null, 2));
}
export function loadFixtureHashes(file = `${WS}/v35-fixture-hashes.json`) {
  if (!fs.existsSync(file)) return;
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8')))) FIXTURE_HASHES.set(k, v);
}

// ═════════════════════════════ 自校准 ═════════════════════════════
export function selfCheck() {
  const bad = [];
  // T1 手算锚点：9 个唯一包；denied=GPL-3.0(gpl-lib)；unknown=LGPL/WTFPL/UNKNOWN
  const r1 = t1Ref();
  if (r1.summary.total !== 9) bad.push('T1 包数 ' + r1.summary.total + ' != 9');
  if (r1.summary.denied !== 1) bad.push('T1 denied 漂移: ' + r1.summary.denied);
  if (r1.summary.unknown !== 3) bad.push('T1 unknown 漂移: ' + r1.summary.unknown);
  if (r1.exitCode !== 1) bad.push('T1 退出码漂移');
  if (t1NormLicense('MIT License') !== 'MIT' || t1NormLicense('Apache 2.0') !== 'Apache-2.0') bad.push('T1 SPDX 归一漂移');

  // T2 手算锚点：3 源共 13 条事件；最早错误 = syslog OOM 08:00:02Z
  const r2 = t2Ref();
  if (r2.events.length !== 13) bad.push('T2 事件数 ' + r2.events.length + ' != 13');
  if (r2.rca.first_error_utc !== '2024-05-01T08:00:02.000Z') bad.push('T2 first_error ' + r2.rca.first_error_utc);
  if (JSON.stringify(r2.rca.affected_services) !== '["api","nginx","system"]') bad.push('T2 services 漂移: ' + JSON.stringify(r2.rca.affected_services));
  const sorted = r2.events.every((e, i) => i === 0 || e.utc >= r2.events[i - 1].utc);
  if (!sorted) bad.push('T2 事件未按 UTC 升序');

  // T3 手算锚点：errors=5, warnings=2
  const r3 = t3Ref();
  if (r3.totals.errors !== 5 || r3.totals.warnings !== 2) bad.push('T3 计数漂移: ' + JSON.stringify(r3.totals));
  if (r3.pages['index.html'].violations.filter((v) => v.ruleId === 'img-alt').length !== 1) bad.push('T3 img-alt 应仅 1 处（带 alt 的不算）');

  // T4 锚点
  const r4 = t4Ref();
  if (r4['weekly-tue-count'].length !== 4) bad.push('T4 weekly count 漂移');
  if (r4['monthly-31'].map((x) => x.local).join(',') !== '2024-01-31T12:00:00,2024-03-31T12:00:00,2024-05-31T12:00:00,2024-07-31T12:00:00') bad.push('T4 monthly-31 漂移: ' + r4['monthly-31'].map((x) => x.local).join(','));
  if (r4['daily-until'].length !== 3) bad.push('T4 daily-until 应 3 条（EXDATE 跳过 1 条）: ' + r4['daily-until'].length);
  if (r4['dst-spring'][2].local !== '2024-03-31T03:30:00') bad.push('T4 DST 空洞顺延漂移: ' + r4['dst-spring'][2].local);

  // T5 锚点
  const r5 = t5Ref();
  if (r5.threads.length !== 3) bad.push('T5 线程数 ' + r5.threads.length + ' != 3');
  if (r5.threads.find((t) => t.root === 'm1').messageCount !== 4) bad.push('T5 m1 线程应 4 条');
  if (r5.counts.action_required !== 2) bad.push('T5 action_required 漂移: ' + r5.counts.action_required);
  if (r5.counts.spam !== 1) bad.push('T5 spam 漂移');

  // T6 锚点
  const r6 = t6Ref();
  if (r6.issues.length !== 6) bad.push('T6 问题数 ' + r6.issues.length + ' != 6');
  for (const code of ['opid-missing', 'param-path-mismatch', 'ref-missing', 'ref-unused', 'response-missing', 'tag-undeclared']) {
    if (!r6.summary.byCode[code]) bad.push('T6 缺规则 ' + code);
  }

  // T7 锚点
  const man = t7Manifest();
  const actual = {};
  for (const f of T7_FILES) actual[f.rel] = Buffer.from(f.content, 'utf8');
  if (!t7VerifyRef(man, actual).ok) bad.push('T7 原始文件应校验通过');
  actual['data/a.txt'] = Buffer.from(T7_TAMPERED['data/a.txt'], 'utf8');
  actual['data/extra.txt'] = Buffer.from(T7_EXTRA['data/extra.txt'], 'utf8');
  const r7 = t7VerifyRef(man, actual);
  if (r7.summary.total !== 2 || !r7.issues.find((i) => i.status === 'modified') || !r7.issues.find((i) => i.status === 'extra')) bad.push('T7 篡改/多余检出漂移: ' + JSON.stringify(r7.issues));

  // T8 锚点：8 类各 1
  const r8 = t8Ref();
  if (r8.summary.total !== 8) bad.push('T8 问题数 ' + r8.summary.total + ' != 8');
  for (const code of ['latest-tag', 'no-user', 'add-instead-copy', 'apt-no-clean', 'curl-pipe-sh', 'secret-env', 'many-layers', 'workdir-missing']) {
    if (r8.summary.byCode[code] !== 1) bad.push('T8 规则 ' + code + ' 漂移');
  }

  // T9 锚点
  const r9 = t9Ref();
  if (r9.version !== '1.3.0' || r9.level !== 'minor') bad.push('T9 版本漂移: ' + r9.version + '/' + r9.level);
  if (t9Bump('1.2.3', [{ subject: 'feat!: drop v1 API' }]).level !== 'major') bad.push('T9 breaking 未判 major');
  if (t9Bump('1.2.3', [{ subject: 'fix: x' }]).next !== '1.2.4') bad.push('T9 patch 漂移');
  if (t9Bump('1.2.3', [{ subject: 'docs: y' }]).level !== 'none') bad.push('T9 无变更应 none');

  // T10 锚点
  const r10 = t10Ref();
  if (!r10.ok) bad.push('T10 应无错误: ' + JSON.stringify(r10.errors));
  if (r10.config.database.pool_size !== 20 || r10.config.server.hostname !== '0.0.0.0') bad.push('T10 重命名漂移: ' + JSON.stringify(r10.config));
  if (r10.config.server.timeout !== 30) bad.push('T10 默认值漂移');
  const bad10 = t10Ref('[server]\nport = abc\n');
  if (bad10.ok || !bad10.errors.length) bad.push('T10 类型校验未生效');

  return bad;
}

/** 交叉校验：任务核验器里的硬编码期望必须由参考实现复算得出。 */
export const PROBE_VECTORS = {
  t1Total: 9, t1Exit: 1,
  t2Events: 13, t2FirstError: '2024-05-01T08:00:02.000Z',
  t3Errors: 5, t3Warnings: 2,
  t4Weekly: 4, t4Dst: '2024-03-31T03:30:00',
  t5Threads: 3, t5Actions: 2,
  t6Issues: 6,
  t7Issues: 2,
  t8Issues: 8,
  t9Version: '1.3.0',
  t10Pool: 20,
};
export function crossCheck() {
  const bad = [];
  const p = PROBE_VECTORS;
  if (t1Ref().summary.total !== p.t1Total || t1Ref().exitCode !== p.t1Exit) bad.push('cross t1');
  if (t2Ref().events.length !== p.t2Events || t2Ref().rca.first_error_utc !== p.t2FirstError) bad.push('cross t2');
  if (t3Ref().totals.errors !== p.t3Errors || t3Ref().totals.warnings !== p.t3Warnings) bad.push('cross t3');
  if (t4Ref()['weekly-tue-count'].length !== p.t4Weekly || t4Ref()['dst-spring'][2].local !== p.t4Dst) bad.push('cross t4');
  if (t5Ref().threads.length !== p.t5Threads || t5Ref().counts.action_required !== p.t5Actions) bad.push('cross t5');
  if (t6Ref().issues.length !== p.t6Issues) bad.push('cross t6');
  if (t8Ref().issues.length !== p.t8Issues) bad.push('cross t8');
  if (t9Ref().version !== p.t9Version) bad.push('cross t9');
  if (t10Ref().config.database.pool_size !== p.t10Pool) bad.push('cross t10');
  return bad;
}
