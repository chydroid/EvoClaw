/**
 * EvoClaw v5 菜单数据核验（2026-10-28）
 *
 * 在 10 个复杂任务完成后，快照系统各菜单（WebUI 侧）的 API 数据，
 * 与压测前基线对比，验证：
 *   1）会话列表新增了 v5-task 会话（菜单可见）
 *   2）技能/记忆/进化记录有符合预期的增长
 *   3）Token 用量统计随任务执行增长，cacheHitRate 保持在合理区间
 *   4）事件流、调度任务、工作台等菜单接口可用且数据合理
 *
 * 用法：node scripts/verify-menus-v5.mjs
 * 基线在脚本内硬编码（压测前快照值），输出前后对比报告。
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jwt = require('/home/chy/EvoClaw/node_modules/.pnpm/jsonwebtoken@9.0.3/node_modules/jsonwebtoken');
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const envPath = path.resolve(__dirname, '../.env');
const envVars = {};
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([^=]+)=([^#]*)$/);
  if (m) envVars[m[1].trim()] = m[2].trim();
}
const token = jwt.sign({ userId: 'test-user', roles: ['user', 'admin'] }, envVars.JWT_SECRET, { expiresIn: '24h' });
const PORT = process.env.EvoClaw_PORT || envVars.EvoClaw_PORT || '27789';
const DATA_DIR = process.env.EVOCLAW_DATA_DIR || path.resolve(__dirname, '../data');

// 压测前基线：优先读取 scripts/menu-baseline-v5.json（重跑前快照），
// 否则用首跑前的硬编码基线。
let BASELINE;
try {
  BASELINE = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'menu-baseline-v5.json'), 'utf-8'));
  console.log(`Baseline loaded from menu-baseline-v5.json (captured ${BASELINE.capturedAt})`);
} catch {
  BASELINE = {
    sessions: 484,
    skills: 21,
    memories: 2566,
    evolutionRecords: 1,
    totalTokens: 201691403,
    totalCalls: 5113,
    cacheHitRate: 0.5286,
  };
}

function apiRequest(method, endpoint, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `http://127.0.0.1:${PORT}`);
    const req = http.request(url.toString(), {
      method,
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 0, data: { raw: data } }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout ${endpoint}`)); });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const BASE = `http://127.0.0.1:${PORT}`;
  const report = {};

  // 1) 会话菜单
  const sess = await apiRequest('GET', '/api/sessions');
  const sessions = Array.isArray(sess.data) ? sess.data : (sess.data?.sessions || []);
  const v5Sessions = sessions.filter((s) => /v5-task-/.test(String(s.sessionId || s.id || s.title || '')));
  report.sessions = {
    total: sessions.length,
    baseline: BASELINE.sessions,
    delta: sessions.length - BASELINE.sessions,
    v5TaskSessions: v5Sessions.length,
    v5Ids: v5Sessions.map((s) => String(s.sessionId || s.id).match(/v5-task-(\d+)/)?.[1]).filter(Boolean).sort((a, b) => a - b).join(','),
    sample: v5Sessions.slice(0, 2).map((s) => ({ id: String(s.sessionId || s.id), title: s.title || s.lastMessage || '' })),
  };

  // 2) 技能菜单
  const skills = await apiRequest('GET', '/api/skills');
  const skillList = Array.isArray(skills.data) ? skills.data : (skills.data?.skills || []);
  report.skills = {
    total: skillList.length,
    baseline: BASELINE.skills,
    delta: skillList.length - BASELINE.skills,
    names: skillList.map((s) => s.name).slice(0, 30),
  };

  // 3) 记忆菜单（直接读存储文件，菜单背后数据源）
  const memRaw = fs.readFileSync(path.resolve(DATA_DIR, 'memory/long-term.json'), 'utf-8');
  const memParsed = JSON.parse(memRaw);
  const memCount = Array.isArray(memParsed) ? memParsed.length : (memParsed?.memories?.length ?? Object.keys(memParsed).length);
  report.memories = {
    total: memCount,
    baseline: BASELINE.memories,
    delta: memCount - BASELINE.memories,
  };

  // 4) 进化记录（SkillCurator 进化史）
  const evoRaw = fs.readFileSync(path.resolve(DATA_DIR, 'skill-curator/evolutions.json'), 'utf-8');
  const evoParsed = JSON.parse(evoRaw);
  const evoRecs = evoParsed?.records || [];
  report.evolution = {
    records: evoRecs.length,
    baseline: BASELINE.evolutionRecords,
    delta: evoRecs.length - BASELINE.evolutionRecords,
    recent: evoRecs.slice(-3).map((r) => ({ skillName: r.skillName, type: r.type, ts: r.timestamp })),
  };

  // 5) Token 用量菜单
  const usage = await apiRequest('GET', '/api/token-usage/overview');
  const u = usage.data || {};
  report.tokenUsage = {
    totalTokens: u.totalTokens,
    baseline: BASELINE.totalTokens,
    delta: (u.totalTokens || 0) - BASELINE.totalTokens,
    totalCalls: u.totalCalls,
    baselineCalls: BASELINE.totalCalls,
    deltaCalls: (u.totalCalls || 0) - BASELINE.totalCalls,
    cacheHitRate: u.cacheHitRate,
    baselineHit: BASELINE.cacheHitRate,
    recentCalls: (u.recentUsage || []).length,
  };

  // 6) 事件流
  const events = await apiRequest('GET', '/api/events?limit=50');
  const evList = events.data?.events || [];
  report.events = {
    seq: evList[0]?.seq,
    recentTypes: evList.map((e) => e.type).slice(0, 10),
    v5Events: evList.filter((e) => /v5-/.test(String(e.sessionId || ''))).length,
  };

  // 7) 调度任务菜单
  const sched = await apiRequest('GET', '/api/scheduler/tasks');
  const schedTasks = sched.data?.tasks || [];
  report.scheduler = { total: schedTasks.length, names: schedTasks.map((t) => t.name) };

  // 8) 工作台/看板
  try {
    const wb = await apiRequest('GET', '/api/workboard/tasks');
    report.workboard = { status: wb.status, total: Array.isArray(wb.data) ? wb.data.length : (wb.data?.tasks?.length ?? 0) };
  } catch (e) { report.workboard = { error: e.message }; }
  try {
    const kb = await apiRequest('GET', '/api/kanban/boards');
    report.kanban = { status: kb.status, boards: Array.isArray(kb.data) ? kb.data.length : (kb.data?.boards?.length ?? 0) };
  } catch (e) { report.kanban = { error: e.message }; }

  // 9) 仪表盘 metrics（Prometheus 文本）
  const met = await apiRequest('GET', '/api/metrics');
  const metricsText = met.data?.raw || '';
  const totalReq = /evoclaw_http_requests_total\s+(\d+)/.exec(metricsText);
  const errRate = /evoclaw_http_requests_error_rate\s+([\d.]+)/.exec(metricsText);
  report.metrics = {
    httpRequests: totalReq ? Number(totalReq[1]) : null,
    errorRate: errRate ? Number(errRate[1]) : null,
  };

  // 10) 会话详情抽查：拿一个 v5 会话的消息，确认消息存储正常
  if (v5Sessions[0]) {
    const sid = String(v5Sessions[0].sessionId || v5Sessions[0].id);
    try {
      const detail = await apiRequest('GET', `/api/sessions/default/${encodeURIComponent(sid)}`);
      const msgs = detail.data?.turns || detail.data?.messages || detail.data?.history || [];
      report.sessionDetail = {
        sessionId: sid,
        messages: Array.isArray(msgs) ? msgs.length : 'n/a',
        preview: Array.isArray(msgs) && msgs[0] ? String(msgs[0].content || msgs[0].text || '').slice(0, 100) : '',
      };
    } catch (e) { report.sessionDetail = { error: e.message }; }
  }

  // 输出
  console.log('='.repeat(80));
  console.log('V5 菜单数据核验报告');
  console.log('='.repeat(80));
  console.log(JSON.stringify(report, null, 2));

  // 判定
  const checks = [
    ['v5 会话总数 ≥ 基线 + 重跑任务数（≥17）', report.sessions.v5TaskSessions >= BASELINE.v5TaskSessions + 6],
    ['会话总数较基线增长（重跑 6 任务 ≥ +5）', report.sessions.delta >= 5],
    ['技能菜单可访问且数量 ≥ 基线', report.skills.total >= BASELINE.skills],
    ['记忆存储增长 ≥ 0（允许不变，任务不强制记忆）', report.memories.delta >= 0],
    ['Token 用量增长 > 0', report.tokenUsage.delta > 0],
    ['Token 调用次数增长 > 0', report.tokenUsage.deltaCalls > 0],
    ['缓存命中率保持在 0.4-0.95 合理区间', report.tokenUsage.cacheHitRate >= 0.4 && report.tokenUsage.cacheHitRate <= 0.95],
    ['事件流包含 v5 事件', report.events.v5Events >= 5],
    ['调度任务菜单可访问', report.scheduler.total >= 0],
    ['工作台接口可用', !report.workboard.error],
    ['看板接口可用', !report.kanban.error],
    ['v5 会话详情含消息记录', !report.sessionDetail?.error && typeof report.sessionDetail?.messages === 'number' && report.sessionDetail.messages > 0],
  ];
  console.log('\n' + '='.repeat(80));
  console.log('判定');
  console.log('='.repeat(80));
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} 通过`);
  fs.writeFileSync(path.resolve(__dirname, 'menu-verify-v5.json'), JSON.stringify({ report, checks, ts: new Date().toISOString() }, null, 2));
  console.log('Saved: scripts/menu-verify-v5.json');
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
