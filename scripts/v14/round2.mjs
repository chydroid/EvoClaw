/**
 * Round 2 — HTTP 服务与客户端可靠性
 *  5. 零依赖 JSON API 服务（持久化 + 分页 + 状态码）
 *  6. 重试/退避/熔断客户端（注入时钟）
 *  7. OpenAPI 契约校验器
 *  8. Webhook 签名 + 幂等 + 死信投递
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import {
  WS, defineChecks, runProbe, runNodeTest, runNodeWithCode, readFileSafe, writeFixture,
} from './lib.mjs';

const D5 = `${WS}/v14-http-api`;
const D6 = `${WS}/v14-retry-client`;
const D7 = `${WS}/v14-api-contract`;
const D8 = `${WS}/v14-webhook`;

const OPENAPI = {
  openapi: '3.0.0',
  info: { title: 'Items API', version: '1.0.0' },
  paths: {
    '/items': {
      post: {
        requestBody: { required: true, schema: { type: 'object', required: ['name', 'qty'], properties: { name: { type: 'string' }, qty: { type: 'integer' }, status: { type: 'string', enum: ['active', 'archived'] } } } },
        responses: { 201: {} },
      },
    },
    '/items/{id}': { get: { responses: { 200: {} } } },
  },
};
const CONTRACT_CASES = [
  { caseId: 'c1', method: 'post', path: '/items', requestBody: { name: 'a', qty: 1 }, response: { status: 201, body: {} } },
  { caseId: 'c2', method: 'post', path: '/items', requestBody: { qty: 1 }, response: { status: 201, body: {} } },
  { caseId: 'c3', method: 'post', path: '/items', requestBody: { name: 'a', qty: '1' }, response: { status: 201, body: {} } },
  { caseId: 'c4', method: 'post', path: '/items', requestBody: { name: 'a', qty: 1, status: 'bad' }, response: { status: 201, body: {} } },
  { caseId: 'c5', method: 'post', path: '/items', requestBody: { name: 'a', qty: 1 }, response: { status: 500, body: {} } },
  { caseId: 'c6', method: 'get', path: '/items/1', response: { status: 200, body: {} } },
  { caseId: 'c7', method: 'get', path: '/items/1', response: { status: 404, body: {} } },
  { caseId: 'c8', method: 'post', path: '/items', requestBody: { name: 3, qty: 1 }, response: { status: 201, body: {} } },
];
const EXPECTED_VIOLATIONS = [
  { caseId: 'c2', rule: 'missing_required', field: 'name' },
  { caseId: 'c3', rule: 'type', field: 'qty' },
  { caseId: 'c4', rule: 'enum', field: 'status' },
  { caseId: 'c5', rule: 'undocumented_status', field: 'status' },
  { caseId: 'c7', rule: 'undocumented_status', field: 'status' },
  { caseId: 'c8', rule: 'type', field: 'name' },
];

function seed() {
  writeFixture(D7, 'fixtures/openapi.json', JSON.stringify(OPENAPI, null, 2));
  writeFixture(D7, 'fixtures/cases.json', JSON.stringify(CONTRACT_CASES, null, 2));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function freePortSync() {
  const out = execFileSync('python3', ['-I', '-c', "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"], { encoding: 'utf8' }).trim();
  return Number(out);
}

function curl(port, method, p, body) {
  const args = ['-sS', '--max-time', '10', '-w', '\n%{http_code}', '-X', method, `http://127.0.0.1:${port}${p}`];
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8' });
    const idx = out.lastIndexOf('\n');
    const status = Number(out.slice(idx + 1).trim());
    const raw = out.slice(0, idx);
    let parsed; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
    return { status, body: parsed, raw };
  } catch (e) {
    return { status: -1, body: null, raw: String(e.message || e) };
  }
}

function startServer(dir, port, dataDir) {
  const child = spawn('node', ['server.js', '--port', String(port), '--data-dir', dataDir], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  return { child, getOut: () => ({ stdout, stderr }) };
}

function stopServer(srv) {
  try { srv.child.kill('SIGTERM'); } catch {}
  sleepSync(600);
  if (!srv.child.killed) { try { srv.child.kill('SIGKILL'); } catch {} }
  sleepSync(200);
}

function waitReady(port) {
  for (let i = 0; i < 60; i++) {
    const r = curl(port, 'GET', '/api/items');
    if (r.status === 200) return true;
    sleepSync(150);
  }
  return false;
}

function integrationCheck(dir) {
  const port = freePortSync();
  const dataDir = path.join(dir, 'tmpdata');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
  let srv = startServer(dir, port, dataDir);
  if (!waitReady(port)) { stopServer(srv); const o = srv.getOut(); return { ok: false, detail: '服务未就绪 ' + (o.stderr || o.stdout).slice(-200).replace(/\n/g, ' ') }; }
  const fails = [];
  const OK = (cond, msg) => { if (!cond) fails.push(msg); };
  const empty = curl(port, 'GET', '/api/items');
  OK(empty.status === 200 && empty.body?.total === 0 && Array.isArray(empty.body?.items), `初始列表 ${empty.status}/${empty.raw.slice(0, 80)}`);
  const bad = curl(port, 'POST', '/api/items', { name: '', qty: 1, status: 'active' });
  OK(bad.status === 400, `空 name 应 400，得 ${bad.status}`);
  const badStatus = curl(port, 'POST', '/api/items', { name: 'x', qty: 1, status: 'bogus' });
  OK(badStatus.status === 400, `非法 status 应 400，得 ${badStatus.status}`);
  const i1 = curl(port, 'POST', '/api/items', { name: 'one', qty: 1, status: 'active' });
  const i2 = curl(port, 'POST', '/api/items', { name: 'two', qty: 2, status: 'active' });
  const i3 = curl(port, 'POST', '/api/items', { name: 'three', qty: 3, status: 'archived' });
  OK(i1.status === 201 && i1.body?.id === 1, `创建1 ${i1.status}/${i1.raw.slice(0, 80)}`);
  OK(i2.status === 201 && i2.body?.id === 2, `创建2 ${i2.status}`);
  OK(i3.status === 201 && i3.body?.id === 3, `创建3 ${i3.status}`);
  const page = curl(port, 'GET', '/api/items?limit=2&offset=1');
  OK(page.status === 200 && page.body?.total === 3 && page.body?.items?.length === 2 && page.body.items[0].id === 2, `分页 ${JSON.stringify(page.body).slice(0, 120)}`);
  const filt = curl(port, 'GET', '/api/items?status=active');
  OK(filt.status === 200 && filt.body?.total === 2, `状态过滤 ${JSON.stringify(filt.body).slice(0, 120)}`);
  const one = curl(port, 'GET', '/api/items/2');
  OK(one.status === 200 && one.body?.id === 2, `取单项 ${one.status}`);
  const miss = curl(port, 'GET', '/api/items/99');
  OK(miss.status === 404, `不存在应 404，得 ${miss.status}`);
  const patched = curl(port, 'PATCH', '/api/items/1', { qty: 5 });
  OK(patched.status === 200 && patched.body?.qty === 5, `PATCH ${patched.status}/${patched.raw.slice(0, 80)}`);
  const patchMiss = curl(port, 'PATCH', '/api/items/99', { qty: 5 });
  OK(patchMiss.status === 404, `PATCH 不存在应 404，得 ${patchMiss.status}`);
  const del = curl(port, 'DELETE', '/api/items/2');
  OK(del.status === 204, `DELETE 应 204，得 ${del.status}`);
  const delMiss = curl(port, 'DELETE', '/api/items/2');
  OK(delMiss.status === 404, `重复 DELETE 应 404，得 ${delMiss.status}`);
  stopServer(srv);
  // 重启验证持久化
  srv = startServer(dir, port, dataDir);
  if (!waitReady(port)) { stopServer(srv); return { ok: false, detail: '重启后服务未就绪 ' + (srv.getOut().stderr || '').slice(-200).replace(/\n/g, ' ') }; }
  const after = curl(port, 'GET', '/api/items');
  OK(after.status === 200 && after.body?.total === 2, `重启后 total=${after.body?.total}`);
  const item1 = curl(port, 'GET', '/api/items/1');
  OK(item1.status === 200 && item1.body?.qty === 5, `重启后 qty=${item1.body?.qty}`);
  stopServer(srv);
  return { ok: fails.length === 0, detail: fails.length ? 'exec=集成失败: ' + fails.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓12项 HTTP 语义 + 重启持久化' };
}

const tasks = defineChecks([
  {
    id: 5, round: 2, name: '零依赖 JSON API 服务', type: '服务端/API',
    prompt: `你是后端工程师。在 ${D5}/ 下交付零第三方依赖的 Node HTTP 服务：
1）server.js（CommonJS）：\`node server.js --port <端口> --data-dir <目录>\`，监听 127.0.0.1；启动后向 stdout 打印一行 "READY <端口>"。数据持久化到 <目录>/items.json（数组），重启后自动加载。
2）资源 item：{"id":整数,"name":字符串,"qty":整数,"status":"active"|"archived"}。id 从现有最大值 +1 递增。
3）端点：
   - GET /api/items：支持 status、limit（默认 20）、offset（默认 0）查询参数；返回 {"total":符合条件的总数,"items":[{...}]}，按 id 升序。
   - POST /api/items：body 必须含 name（1-50 字符）、qty（≥0 整数）、status（active/archived）；非法返回 400 {"error":"..."}；成功 201 返回完整 item。
   - GET /api/items/:id：200 item 或 404 {"error":"..."}。
   - PATCH /api/items/:id：可部分更新 name/qty/status，校验规则同上；200 返回更新后 item；不存在 404；非法 400。
   - DELETE /api/items/:id：成功 204（无 body），不存在 404。
   - 非法 JSON body 返回 400；未知路由 404。所有响应 Content-Type: application/json（204 除外）。
4）server.test.js（node --test，≥6 用例）覆盖创建/校验/分页/404/更新/删除（可复用同类逻辑但必须真实启动服务）。
5）README.md（≥250 字节）：端点、状态码、持久化说明。
6）必须真实启动服务并用 curl 或脚本完成至少一次创建+列表+更新+删除，把结果写进回复。`,
    expect: 'server.js + server.test.js + README.md（12 项 HTTP 语义）',
    dir: D5,
    deliverables: [
      { file: 'server.js', minBytes: 1200 },
      { file: 'server.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => integrationCheck(dir),
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'server.js'));
      return [['持久化', /items\.json|writeFile|rename/i.test(s)], ['分页参数', /offset|limit/i.test(s)], ['状态码', /404|204|400/i.test(s)]];
    },
  },
  {
    id: 6, round: 2, name: '重试/退避/熔断客户端', type: '客户端/可靠性',
    prompt: `你是可靠性工程师。在 ${D6}/ 下交付可注入时钟的 HTTP 客户端模块 client.js（CommonJS，无第三方依赖）：
1）导出 createClient(options)，options 可含：fetchImpl、now（返回毫秒）、sleep（返回 Promise）、maxAttempts（默认4）、baseDelayMs（默认50）、maxDelayMs（默认500）、breakerThreshold（默认3）、breakerCooldownMs（默认60000）。
2）fetchImpl(url, opts) 需返回 {status, headers:{get(name)}, text():Promise<string>}。client.request(url, opts) 返回 Promise<{status, body, attempts}>。
   - body = text() 尝试 JSON.parse，失败保留字符串。
   - fetchImpl 抛错、status=429 或 5xx 时**重试**；其他 4xx 直接返回（不重试）。
   - 第 n 次失败后的等待：base = min(baseDelayMs * 2^(n-1), maxDelayMs)；若响应头 Retry-After（秒）存在则 wait = min(max(base, retryAfter*1000), maxDelayMs)；通过注入的 sleep(wait) 等待。
   - 达到 maxAttempts 仍失败时抛出 Error，err.code='RETRY_EXHAUSTED'。
3）连续失败熔断（按 request 调用计，不按单次重试计）：连续 breakerThreshold 个 request 最终失败 → 打开断路器；打开期间新 request 立即 reject，err.code='CIRCUIT_OPEN'，不得调用 fetch。now() - openedAt ≥ breakerCooldownMs 后进入半开：允许 1 次探测，成功则关闭，失败则重新打开。
4）client.stats() 返回 {requests, fetchCalls, retries, breakerOpens}。
5）client.test.js（node --test，≥6 用例）覆盖成功、重试、非重试 4xx、耗尽、熔断打开/半开恢复。
6）README.md（≥200 字节）说明重试与熔断语义。`,
    expect: 'client.js + client.test.js + README.md（行为探针）',
    dir: D6,
    deliverables: [
      { file: 'client.js', minBytes: 1500 },
      { file: 'client.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 200 },
    ],
    exec: (dir) => {
      const probe = `
        const mkRes = (status, text, retryAfter) => ({ status, headers: { get: (n) => String(n).toLowerCase()==='retry-after' ? (retryAfter === undefined ? null : String(retryAfter)) : null }, text: async () => text });
        const results = {};
        // A 成功
        {
          const c = m.createClient({ fetchImpl: async () => mkRes(200, '{"ok":true}'), now: () => 0, sleep: async () => {} });
          const r = await c.request('http://x/a'); results.A = { status: r.status, body: r.body, attempts: r.attempts, stats: c.stats() };
        }
        // B 两次抛错后成功
        {
          const sleeps = []; let calls = 0;
          const c = m.createClient({ fetchImpl: async () => { calls++; if (calls <= 2) throw new Error('net'); return mkRes(200, 'ok'); }, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
          const r = await c.request('http://x/b'); results.B = { status: r.status, attempts: r.attempts, sleeps, calls, stats: c.stats() };
        }
        // C 400 不重试
        {
          let calls = 0;
          const c = m.createClient({ fetchImpl: async () => { calls++; return mkRes(400, 'bad'); }, now: () => 0, sleep: async () => {} });
          const r = await c.request('http://x/c'); results.C = { status: r.status, attempts: r.attempts, calls };
        }
        // D 429 Retry-After=2 封顶
        {
          const sleeps = []; let calls = 0;
          const c = m.createClient({ fetchImpl: async () => { calls++; if (calls === 1) return mkRes(429, 'slow', 2); return mkRes(200, 'ok'); }, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
          const r = await c.request('http://x/d'); results.D = { attempts: r.attempts, sleeps };
        }
        // E 持续失败耗尽
        {
          const sleeps = []; let calls = 0;
          const c = m.createClient({ fetchImpl: async () => { calls++; return mkRes(500, 'err'); }, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
          let errCode = null; try { await c.request('http://x/e'); } catch (e) { errCode = e.code; }
          results.E = { errCode, calls, sleeps };
        }
        // F 熔断 + 半开
        {
          let t = 0; let calls = 0; let healthy = false;
          const c = m.createClient({ fetchImpl: async () => { calls++; if (!healthy) throw new Error('down'); return mkRes(200, 'ok'); }, now: () => t, sleep: async () => {}, maxAttempts: 2 });
          const errs = [];
          for (let i = 0; i < 3; i++) { try { await c.request('http://x/f'); errs.push('resolved'); } catch (e) { errs.push(e.code); } }
          const callsBeforeOpen = calls;
          let openErr = null; try { await c.request('http://x/f'); } catch (e) { openErr = e.code; }
          const callsAfterOpen = calls;
          t = 60001; healthy = true;
          const rec = await c.request('http://x/f');
          const rec2 = await c.request('http://x/f');
          results.F = { errs, openErr, callsBeforeOpen, callsAfterOpen, rec: { status: rec.status, attempts: rec.attempts }, rec2: { status: rec2.status }, stats: c.stats() };
        }
        return results;
      `;
      const p = runProbe(dir, 'client.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      if (v.A.status !== 200 || v.A.body?.ok !== true || v.A.attempts !== 1) bad.push(`A 成功 ${JSON.stringify(v.A)}`);
      if (v.B.status !== 200 || v.B.attempts !== 3 || JSON.stringify(v.B.sleeps) !== '[50,100]') bad.push(`B 重试 ${JSON.stringify(v.B)}`);
      if (v.C.status !== 400 || v.C.attempts !== 1 || v.C.calls !== 1) bad.push(`C 4xx ${JSON.stringify(v.C)}`);
      if (v.D.attempts !== 2 || JSON.stringify(v.D.sleeps) !== '[500]') bad.push(`D 429 ${JSON.stringify(v.D)}`);
      if (v.E.errCode !== 'RETRY_EXHAUSTED' || v.E.calls !== 4 || JSON.stringify(v.E.sleeps) !== '[50,100,200]') bad.push(`E 耗尽 ${JSON.stringify(v.E)}`);
      if (JSON.stringify(v.F.errs) !== '["RETRY_EXHAUSTED","RETRY_EXHAUSTED","RETRY_EXHAUSTED"]') bad.push(`F 前三次 ${JSON.stringify(v.F.errs)}`);
      if (v.F.openErr !== 'CIRCUIT_OPEN' || v.F.callsAfterOpen !== v.F.callsBeforeOpen) bad.push(`F 开路 ${JSON.stringify(v.F)}`);
      if (v.F.rec?.status !== 200 || v.F.rec2?.status !== 200) bad.push(`F 半开恢复 ${JSON.stringify(v.F)}`);
      const t = runNodeTest(path.join(dir, 'client.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓重试序列/429封顶/耗尽/熔断半开/node-test 全过' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'client.js'));
      return [['退避', /Math\.min|2\s*\*\*|baseDelay/i.test(s)], ['熔断', /CIRCUIT_OPEN|breaker/i.test(s)], ['Retry-After', /retry-after/i.test(s)]];
    },
  },
  {
    id: 7, round: 2, name: 'OpenAPI 契约校验器', type: 'API/契约',
    prompt: `你是 API 质量工程师。在 ${D7}/ 下交付 OpenAPI 契约校验器，夹具 fixtures/openapi.json（3.0 子集）与 fixtures/cases.json 由我提供，**禁止修改**：
1）contract.js（CommonJS）：\`node contract.js --spec fixtures/openapi.json --cases fixtures/cases.json --out contract-report.json\`。
2）案例格式：{"caseId","method","path","requestBody"?,"response":{"status","body"}}。路径模板 {id} 视为匹配任意单段路径。只检查以下 4 条规则：
   - missing_required：请求体缺少 operation.requestBody.schema.required 中的顶层字段（按 required 顺序）；
   - type：请求体字段存在但 JSON 类型不符（string/integer/number/boolean/object/array；integer 必须为整数）；
   - enum：请求体字段有 enum 但取值不在其中；
   - undocumented_status：response.status 未出现在 operation.responses 的键中（按字符串比较）。
3）report.json 严格为 {"totalCases":n,"violations":[{"caseId":"c1","rule":"...","field":"..."}]}。violations 按 caseId 升序、同 case 按规则产生顺序（missing_required→type→enum→undocumented_status，同规则按字段名）。undocumented_status 的 field 固定为 "status"。存在违规退出码 1，否则 0。
4）contract.test.js（node --test，≥5 用例）覆盖四类规则与合法案例。
5）README.md（≥250 字节）：规则、匹配方式、退出码。
6）必须真实运行两次（对给定 cases.json，以及你自己造的一份全合法 cases 文件），把 totalCases 与违规条数写进回复。`,
    expect: 'contract.js + contract-report.json + contract.test.js + README.md',
    dir: D7, frozen: ['fixtures/openapi.json', 'fixtures/cases.json'],
    deliverables: [
      { file: 'contract.js', minBytes: 900 },
      { file: 'contract-report.json', minBytes: 60 },
      { file: 'contract.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const r = runNodeWithCode(dir, 'contract.js --spec fixtures/openapi.json --cases fixtures/cases.json --out contract-report.json');
      let got;
      try { got = JSON.parse(readFileSafe(path.join(dir, 'contract-report.json'))); } catch { return { ok: false, detail: 'exec=contract-report.json 非法 JSON' }; }
      const bad = [];
      if (r.code !== 1) bad.push(`退出码 ${r.code}≠1`);
      if (got.totalCases !== CONTRACT_CASES.length) bad.push(`totalCases ${got.totalCases}`);
      if (JSON.stringify(got.violations) !== JSON.stringify(EXPECTED_VIOLATIONS)) bad.push(`violations=${JSON.stringify(got.violations).slice(0, 300)}`);
      const t = runNodeTest(path.join(dir, 'contract.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ') : 'exec=✓6 条违规与独立预期逐项一致/退出码1' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'contract.js'));
      return [['required', /required/i.test(s)], ['enum', /enum/i.test(s)], ['路径模板', /\{.*\}|replace|segment/i.test(s)]];
    },
  },
  {
    id: 8, round: 2, name: 'Webhook 签名 + 幂等 + 死信', type: '服务端/事件',
    prompt: `你是事件平台工程师。在 ${D8}/ 下交付 webhook.js（CommonJS，无第三方依赖）：
1）签名：
   - signPayload(secret, timestampMs, bodyString) 返回小写十六进制 HMAC-SHA256，签名原文为 \`<timestampMs>.<bodyString>\`；
   - verifyPayload(secret, header, bodyString, nowMs, toleranceMs=300000) 解析 header 格式 "t=<ms>,v1=<hex>"，校验时间差 |nowMs-t| ≤ toleranceMs，并用 timingSafeEqual 比较；合法返回 true，任何格式/签名/时间问题返回 false。
2）投递器 createDispatcher({ deliver, deadLetterPath, maxAttempts=3, now=()=>Date.now(), sleep=async()=>{} })：
   - dispatch(event) 中 event 为 {"id","type","payload"}；以 id 去重：已出现过的 id 直接返回 {"status":"duplicate"} 且不调用 deliver；
   - deliver(event) 抛错时重试，共最多 maxAttempts 次；第 n 次失败后按 100*2^(n-1) 毫秒调用 sleep；
   - 全部失败：把 event 以单行 JSON 追加到 deadLetterPath，返回 {"status":"failed","attempts":maxAttempts}；
   - 成功返回 {"status":"delivered","attempts":n}；
   - 重复 id 与失败 id 都要去重（失败后再次 dispatch 返回 duplicate）。
   - stats() 返回 {"delivered","failed","duplicates","attempts"}。
3）webhook.test.js（node --test，≥6 用例）覆盖签名/篡改/过期/幂等/重试/死信。
4）README.md（≥250 字节）：签名格式、重试与死信语义。
5）必须真实运行签名验证与一次失败投递（可写脚本），把签名前 16 位与死信行数写进回复。`,
    expect: 'webhook.js + webhook.test.js + README.md（HMAC/幂等/死信探针）',
    dir: D8,
    deliverables: [
      { file: 'webhook.js', minBytes: 1200 },
      { file: 'webhook.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const dlq = path.join(dir, 'probe-dead-letter.jsonl');
      try { fs.rmSync(dlq, { force: true }); } catch {}
      const probe = `
        const crypto = require('crypto');
        const fs = require('fs');
        const secret = 's3cr3t-key';
        const t = 1700000000000;
        const body = JSON.stringify({ a: 1 });
        const expected = crypto.createHmac('sha256', secret).update(String(t) + '.' + body).digest('hex');
        const sig = m.signPayload(secret, t, body);
        const header = 't=' + t + ',v1=' + sig;
        const okValid = m.verifyPayload(secret, header, body, t + 1000, 300000);
        const tampered = m.verifyPayload(secret, 't=' + t + ',v1=' + '0'.repeat(64), body, t, 300000);
        const expired = m.verifyPayload(secret, header, body, t + 300001, 300000);
        const sleeps = []; let deliverCalls = 0;
        const d = m.createDispatcher({ deadLetterPath: ${JSON.stringify(dlq)}, maxAttempts: 3, now: () => 0, sleep: async (ms) => { sleeps.push(ms); }, deliver: async (ev) => { deliverCalls++; if (ev.id === 'e1') { if (deliverCalls <= 2) throw new Error('fail'); return; } throw new Error('always'); } });
        const e1 = { id: 'e1', type: 'x', payload: { n: 1 } };
        const r1 = await d.dispatch(e1);
        const callsAfter1 = deliverCalls;
        const sleepsE1 = sleeps.slice();
        sleeps.length = 0;
        const r1dup = await d.dispatch(e1);
        const callsAfterDup = deliverCalls;
        const e2 = { id: 'e2', type: 'y', payload: { n: 2 } };
        const r2 = await d.dispatch(e2);
        const stats = d.stats();
        let dlqLines = [];
        try { dlqLines = fs.readFileSync(${JSON.stringify(dlq)}, 'utf8').split('\\n').filter(Boolean).map(JSON.parse); } catch {}
        return { expected, sig, okValid, tampered, expired, r1, callsAfter1, sleepsE1, r1dup, callsAfterDup, r2, stats, dlqLines };
      `;
      const p = runProbe(dir, 'webhook.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      if (v.sig !== v.expected) bad.push('HMAC 不一致');
      if (v.okValid !== true || v.tampered !== false || v.expired !== false) bad.push(`verify ${v.okValid}/${v.tampered}/${v.expired}`);
      if (v.r1.status !== 'delivered' || v.r1.attempts !== 3 || JSON.stringify(v.sleepsE1) !== '[100,200]') bad.push(`e1 ${JSON.stringify(v.r1)} sleeps=${JSON.stringify(v.sleepsE1)}`);
      if (v.r1dup.status !== 'duplicate' || v.callsAfterDup !== v.callsAfter1) bad.push(`重复 ${JSON.stringify(v.r1dup)} calls ${v.callsAfter1}→${v.callsAfterDup}`);
      if (v.r2.status !== 'failed' || v.r2.attempts !== 3) bad.push(`e2 ${JSON.stringify(v.r2)}`);
      if (v.stats.delivered !== 1 || v.stats.failed !== 1 || v.stats.duplicates !== 1) bad.push(`stats ${JSON.stringify(v.stats)}`);
      if (v.dlqLines.length !== 1 || v.dlqLines[0]?.id !== 'e2') bad.push(`死信 ${JSON.stringify(v.dlqLines).slice(0, 120)}`);
      const t = runNodeTest(path.join(dir, 'webhook.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓HMAC/篡改/过期/幂等/重试[100,200]/死信/node-test 全过' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'webhook.js'));
      return [['HMAC', /createHmac|hmac/i.test(s)], ['timingSafeEqual', /timingSafeEqual/i.test(s)], ['死信', /deadLetter|appendFile/i.test(s)]];
    },
  },
]);

export const round = 2;
export const title = 'HTTP 服务与客户端可靠性';
export default { round, title, outTag: 'r2', seed, tasks };
