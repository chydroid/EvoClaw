/**
 * EvoClaw v14 压测共享工具库。
 * 6 轮 × 4 任务，领域与 v12/v13 不重叠。
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { execSync, execFileSync } from 'child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const REPO_ROOT = path.resolve(__dirname, '../..');

const gatewayRequire = createRequire(path.join(REPO_ROOT, 'packages/gateway/package.json'));
const jwt = gatewayRequire('jsonwebtoken');

const envPath = path.join(REPO_ROOT, '.env');
const envVars = {};
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([^=]+)=([^#]*)$/);
  if (m) envVars[m[1].trim()] = m[2].trim();
}
export const JWT_SECRET = envVars.JWT_SECRET || 'change-me-to-a-random-secret-min-16-chars';
export const TOKEN = jwt.sign({ userId: 'test-user', roles: ['user', 'admin'] }, JWT_SECRET, { expiresIn: '24h' });
export const PORT = process.env.EvoClaw_PORT || envVars.EvoClaw_PORT || '27789';
export const RUN_START = Date.now();
export const WS = '/home/chy/EvoClaw/data/workspace';

export const FIXTURE_HASHES = new Map();

export function isFresh(p) { try { return fs.statSync(p).mtimeMs > RUN_START; } catch { return false; } }
export function readFileSafe(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function toSlash(p) { return String(p).replace(/\\/g, '/'); }
export function hashFile(p) { try { return execSync(`sha1sum ${p}`).toString().split(/\s+/)[0]; } catch { return 'MISSING'; } }
export function fileSize(p) { try { return fs.statSync(p).size; } catch { return -1; } }

export function apiRequest(method, endpoint, body, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `http://127.0.0.1:${PORT}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 0, data: { raw: data } }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('client timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 原始 HTTP 请求（用于 Round 2 服务集成测试）。 */
export function rawRequest({ port, method, path: reqPath, body, headers = {}, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: reqPath, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : null; } catch { /* raw */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed, raw: data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

export function listRecursive(d) {
  const out = [];
  try {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) out.push(...listRecursive(p));
      else out.push(p);
    }
  } catch { /* missing */ }
  return out;
}

export function runNodeTest(file, timeoutMs = 90000) {
  try {
    const out = execSync(`timeout 80 node --test ${JSON.stringify(file)} 2>&1`, { timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  }
}

export function runNodeCheck(file) {
  try {
    execSync(`timeout 20 node --check ${JSON.stringify(file)}`, { timeout: 30000, stdio: 'pipe' });
    return { ok: true, detail: `✓check ${path.basename(file)}` };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString().slice(-200);
    return { ok: false, detail: `✗check ${path.basename(file)} ${out.replace(/\n/g, ' ')}` };
  }
}

export function runBashN(file) {
  try {
    execSync(`timeout 20 bash -n ${JSON.stringify(file)}`, { timeout: 30000, stdio: 'pipe' });
    return { ok: true, detail: `✓bash-n ${path.basename(file)}` };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString().slice(-200);
    return { ok: false, detail: `✗bash-n ${path.basename(file)} ${out.replace(/\n/g, ' ')}` };
  }
}

export function runNodeWithCode(dir, args, timeoutMs = 90000) {
  try {
    const out = execSync(`timeout 80 node ${args} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { code: typeof e.status === 'number' ? e.status : 124, out };
  }
}

export function runNodeScript(dir, args, timeoutMs = 90000) {
  const r = runNodeWithCode(dir, args, timeoutMs);
  return { ok: r.code === 0, out: r.out, code: r.code };
}

/** 在隔离进程中 require 被测模块并求值。 */
export function runProbe(dir, moduleRel, body, timeoutMs = 40000) {
  const tmp = `/tmp/v14-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;
  const target = path.join(dir, moduleRel);
  const code = `const m = require(${JSON.stringify(target)});\nconst out = (async () => { ${body} })();\nPromise.resolve(out).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error('PROBE_ERR', e && e.stack || e);process.exit(2)});\n`;
  fs.writeFileSync(tmp, code);
  try {
    const out = execSync(`timeout 30 node ${tmp}`, { cwd: dir, encoding: 'utf8', timeout: timeoutMs }).toString().trim();
    return { ok: true, value: JSON.parse(out.split('\n').pop()) };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { ok: false, out: out.slice(-400).replace(/\n/g, ' ') };
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

/** 运行 Python 校验脚本（-I 隔离模式，路径经 argv 传入）。 */
export function runPy(dir, scriptBody, args = [], timeoutMs = 60000) {
  const tmp = `/tmp/v14-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  fs.writeFileSync(tmp, scriptBody);
  try {
    const out = execFileSync('python3', ['-I', tmp, ...args.map(String)], { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString().trim();
    try { return { ok: true, value: JSON.parse(out.split('\n').pop()), out }; }
    catch { return { ok: true, value: null, out }; }
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { ok: false, out: out.slice(-500).replace(/\n/g, ' ') };
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

/**
 * Python 读文件片段（v19 Task 2 教训）：裸 `open()` 默认 universal newlines 会把 \r\n→\n
 * 翻译，CSV/换行敏感交付物会被错杀。统一用此片段替代裸 open(path).read()。
 * 用法：脚本内 `text = ${pyReadTextLiteral('sys.argv[2]')}` 等拼入 argv 路径表达式。
 */
export const pyReadTextLiteral = (pathExpr) =>
  `open(${pathExpr}, encoding='utf-8', newline='').read()`;

export function writeFixture(relDir, rel, content) {
  const p = path.join(relDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  FIXTURE_HASHES.set(p, hashFile(p));
  return p;
}

/** 冻结夹具哈希校验：任何修改/删除都判失败。 */
export function frozenCheck(task) {
  if (!task.frozen || !task.frozen.length) return { ok: true, detail: '' };
  const bad = [];
  for (const rel of task.frozen) {
    const p = path.join(task.dir, rel);
    if (FIXTURE_HASHES.get(p) !== hashFile(p)) bad.push(rel);
  }
  return bad.length ? { ok: false, detail: `✗frozen 被改动: ${bad.join(',')}` } : { ok: true, detail: '' };
}

export function verifyDeliverables(dir, items, receipts) {
  const parts = [];
  let ok = true;
  const st = (p) => { try { return fs.statSync(p); } catch { return null; } };
  const base = (p) => toSlash(p).split('/').pop();
  const fresh = (p) => { const s = st(p); return !!s && s.mtimeMs > RUN_START; };
  const allFiles = listRecursive(dir);
  for (const it of items) {
    const cand = it.file
      ? [path.join(dir, it.file)]
      : allFiles.filter((p) => it.regex.test(base(p)) && (!it.exts || it.exts.some((e) => base(p).endsWith(e))) && !(it.exclude && it.exclude.test(base(p))));
    let probe;
    if (it.minCount) {
      const hits = cand.filter((p) => st(p));
      const freshHits = hits.filter(fresh);
      probe = freshHits[0] || hits[0];
      if (freshHits.length < it.minCount) {
        ok = false; parts.push(`✗${it.regex.source.slice(0, 14)} fresh ${freshHits.length}/${it.minCount}`); continue;
      }
    } else if (it.file) {
      probe = cand[0];
      if (!st(probe)) {
        const landed = (receipts || []).find((r) => typeof r.path === 'string' && base(r.path) === base(probe) && st(r.path));
        ok = false; parts.push(landed ? `✗${base(probe)} 落点漂移→${landed.path}` : `✗${base(probe)} 缺失`); continue;
      }
      if (!fresh(probe)) { ok = false; parts.push(`✗${base(probe)} 陈旧`); continue; }
    } else {
      probe = cand.find(fresh) || cand[0];
      if (!probe || !st(probe)) {
        const landed = (receipts || []).find((r) => typeof r.path === 'string' && it.regex.test(base(r.path)) && (!it.exts || it.exts.some((e) => base(r.path).endsWith(e))) && st(r.path));
        ok = false; parts.push(landed ? `✗${it.regex.source.slice(0, 14)} 落点漂移→${landed.path}` : `✗${it.regex.source.slice(0, 14)} 缺失`); continue;
      }
      if (!fresh(probe)) { ok = false; parts.push(`✗${base(probe)} 陈旧`); continue; }
    }
    if (it.minBytes && st(probe).size < it.minBytes) {
      ok = false; parts.push(`✗${base(probe)} ${st(probe).size}B<${it.minBytes}`); continue;
    }
    if (it.minLines) {
      let n = 0;
      try { n = Number(execSync(`wc -l < ${JSON.stringify(probe)}`).toString().trim()); } catch { n = 0; }
      if (n < it.minLines) {
        ok = false; parts.push(`✗${base(probe)} 行数 ${n}<${it.minLines}`); continue;
      }
    }
    parts.push(`✓${base(probe)}`);
  }
  return { ok, detail: parts.join(' ') };
}

export async function invariantCheck(task, r) {
  const inv = verifyDeliverables(task.dir, task.deliverables, r.receipts || []);
  const fz = frozenCheck(task);
  const ex = task.exec ? await task.exec(task.dir) : { ok: true, detail: '' };
  const q = task.quality ? task.quality(task.dir, r) : [];
  const qBad = q.filter((x) => !x[1]).length;
  const ok = inv.ok && fz.ok && ex.ok;
  const qd = q.length ? ` quality=[${q.map(([n, b]) => (b ? '' : '✗') + n).join(' ')}]${qBad ? ` (${qBad}项未达标)` : ''}` : '';
  return { ok, detail: `inv=[${inv.detail}]${fz.detail ? ' ' + fz.detail : ''}${ex.detail ? ` ${ex.detail}` : ''}${qd}` };
}

// ─────────────────────────── 九模块 stats ───────────────────────────
const STATS_ENDPOINTS = {
  concurrent: ['/api/agent/concurrent-stats', (s) => s.executed + s.batches],
  persistence: ['/api/agent/persistence-stats', (s) => s.maybePersistCalls],
  middleware: ['/api/agent/middleware-stats', (s) => s.resultTransformApplications],
  recording: ['/api/agent/recording-stats', (s) => s.totalRecordings],
  schema: ['/api/agent/schema-sanitizer-stats', (s) => s.calls],
  coercer: ['/api/agent/coercer-stats', (s) => s.calls],
  iterationPolicy: ['/api/agent/iteration-policy-stats', (s) => s.applications],
  rateGuard: ['/api/agent/rate-guard-stats', (s) => s.checks],
};

export async function snapshotStats() {
  const snap = {};
  for (const [key, [ep, pick]] of Object.entries(STATS_ENDPOINTS)) {
    try {
      const r = await apiRequest('GET', ep, null, 15000);
      snap[key] = { value: pick(r.data.stats || r.data.report || {}), raw: r.data };
    } catch (e) { snap[key] = { value: null, error: String(e.message || e) }; }
  }
  return snap;
}

/**
 * 运行一轮任务。
 * @param {{round:number,title:string,outTag:string,seed?:()=>void}} roundCfg
 * @param {Array} tasks
 */
async function safeCheck(task, r) {
  try { return await task.check(r); }
  catch (e) { return { ok: false, detail: 'check 异常: ' + String((e && e.message) || e).slice(0, 300) }; }
}

export async function runRound(roundCfg, tasks) {
  const { round, title, outTag, seed } = roundCfg;
  console.log('='.repeat(80));
  console.log(`EvoClaw v14 压测 — Round ${round}: ${title} (${tasks.length} 任务)`);
  console.log(`Server: http://127.0.0.1:${PORT}  WS: ${WS}`);
  console.log('='.repeat(80) + '\n');

  const filter = process.env.TASK_FILTER
    ? new Set(process.env.TASK_FILTER.split(',').map((s) => parseInt(s.trim(), 10)))
    : null;

  for (const t of tasks) {
    if (filter !== null && !filter.has(t.id)) continue;
    try { fs.rmSync(t.dir, { recursive: true, force: true }); } catch {}
  }
  if (seed) seed();
  console.log(`🧼 已清空 ${filter === null ? tasks.length : filter.size} 个输出目录并写入夹具（${FIXTURE_HASHES.size} 个冻结文件）\n`);

  const before = await snapshotStats();
  const results = [];
  const out = path.join(__dirname, filter === null
    ? `test-results-v14-${outTag}.json`
    : `test-results-v14-${outTag}-r${process.env.TASK_FILTER.replace(/,/g, '-')}.json`);
  const save = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString(), before }, null, 2));
  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 1200000;
  const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS) || 45000;

  for (const task of tasks) {
    if (filter !== null && !filter.has(task.id)) continue;
    const sessionId = `v14-task-${task.id}-${Date.now()}`;
    console.log(`[Task ${task.id}] ${task.name} (${task.type})`);
    console.log('-'.repeat(60));
    const startTime = Date.now();
    let timedOut = false;
    let reply = '';
    let tokens = 0;
    const receipts = [];
    let resp;
    try {
      resp = await apiRequest('POST', '/api/chat', { message: task.prompt, sessionId, stream: false });
    } catch (err) {
      timedOut = true;
      console.log(`⚠️  客户端超时（${err.message}），转延迟核验（窗口 ${VERIFY_WINDOW_MS / 1000}s）`);
      resp = { status: 0, data: { reply: '' } };
    }
    reply = resp.data?.reply || '';
    tokens = resp.data?.tokensUsed || 0;
    for (const f of resp.data?.files || []) receipts.push(f);
    if (resp.status !== 200 && resp.status !== 0) console.log(`⚠️  HTTP ${resp.status}`);

    const duration = Date.now() - startTime;
    const isCheckpointReply = /⏳|检查点|后台继续|继续执行/.test(reply);
    let verdict = await safeCheck(task, { reply, tokens, duration, receipts });
    let verifyWaited = 0;
    while (!verdict.ok && verifyWaited < VERIFY_WINDOW_MS && (timedOut || isCheckpointReply)) {
      await sleep(VERIFY_POLL_MS);
      verifyWaited += VERIFY_POLL_MS;
      verdict = await safeCheck(task, { reply, tokens, duration, receipts });
    }
    const delayNote = verifyWaited > 0 ? ` [延迟核验 ${Math.round(verifyWaited / 1000)}s${timedOut ? '，客户端超时→后台完成' : '，⏳→后台完成'}]` : '';
    const status = verdict.ok ? 'success' : timedOut ? 'error' : 'regression';

    results.push({
      id: task.id, round: task.round, name: task.name, type: task.type, expect: task.expect,
      status, duration: duration + verifyWaited, tokens,
      detail: `${verdict.detail}${delayNote}`,
      replyPreview: reply.slice(0, 300).replace(/\n/g, ' '),
    });
    save();
    console.log(`${verdict.ok ? '✅' : '❌'} ${status.toUpperCase()} (${((duration + verifyWaited) / 1000).toFixed(1)}s, tokens=${tokens})`);
    console.log(`   ${results[results.length - 1].detail}`);
    console.log(`   preview: ${results[results.length - 1].replyPreview}...`);
    console.log('\n');
  }

  const after = await snapshotStats();
  const globalChecks = [];
  for (const key of Object.keys(STATS_ENDPOINTS)) {
    const b = before[key]?.value, a = after[key]?.value;
    const hard = key !== 'concurrent';
    if (b == null || a == null) { globalChecks.push([`stats:${key}`, false, '不可读', hard]); continue; }
    globalChecks.push([`stats:${key}`, a > b, `${b}→${a}${hard ? '' : '（依赖模型同轮并发调用，仅供参考）'}`, hard]);
  }

  let titleChecks = [];
  try {
    const s = await apiRequest('GET', '/api/sessions', null, 20000);
    const sessions = (s.data?.sessions || []).filter((x) => {
      if (!String(x.sessionId).startsWith('v14-task-')) return false;
      const created = Date.parse(x.createdAt || '');
      return Number.isFinite(created) && created >= RUN_START;
    });
    const missing = sessions.filter((x) => !x.title || x.titleSource !== 'derived');
    titleChecks = sessions.length
      ? [['session-title', missing.length === 0, `本轮${sessions.length}会话, 缺标题/非derived=${missing.length}`, true]]
      : [['session-title', false, '本轮无 v14 会话', true]];
  } catch (e) {
    titleChecks = [['session-title', false, String(e.message || e), true]];
  }

  console.log('='.repeat(80));
  console.log('全局断言');
  console.log('='.repeat(80));
  for (const [name, ok, detail] of [...globalChecks, ...titleChecks]) console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);

  console.log('\n' + '='.repeat(80));
  console.log(`V14 ROUND ${round} SUMMARY`);
  console.log('='.repeat(80));
  const pass = results.filter((r) => r.status === 'success').length;
  console.log(`Total: ${results.length} | pass: ${pass} | regression: ${results.filter((r) => r.status === 'regression').length} | error: ${results.filter((r) => r.status === 'error').length}`);
  for (const r of results) {
    console.log(`  ${r.id}. ${r.name} [${r.status}] ${(r.duration / 1000).toFixed(1)}s tokens=${r.tokens ?? 0}`);
    console.log(`      ${r.detail}`);
  }
  const globalOk = globalChecks.concat(titleChecks).every(([, ok, , hard]) => !hard || ok);
  console.log(`\n全局断言: ${globalOk ? 'PASS' : 'FAIL'}`);
  save();
  console.log(`\nResults saved: ${out}`);
  process.exit(pass === results.length && globalOk ? 0 : 1);
}

export function defineChecks(tasks) {
  for (const t of tasks) t.check = (r) => invariantCheck(t, r);
  return tasks;
}

export function logTail(serverLog = '/tmp/evoclaw-v14-server.log', n = 40) {
  try { return execSync(`tail -n ${n} ${serverLog}`, { encoding: 'utf8' }).toString(); } catch { return ''; }
}
