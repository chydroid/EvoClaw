/**
 * EvoClaw v34 工作任务压测 — 10 项「真实工程交付」级复杂多步任务，领域与 v12–v33 零重叠：
 *   1. 遗留代码重构（Python，日志 helper 抽取 + 行为等价）
 *   2. 脏 CSV → SQLite ETL（Python，质量规则 + 拒绝表 + 聚合报表）
 *   3. Git 缺陷取证（Python，bisect 泛化到未见仓库）
 *   4. 分页 HTTP 客户端（Node，429 重试 + ETag/304 + 磁盘缓存）
 *   5. 密钥扫描器（Python，正则 + 香农熵 + 白名单 + 退出码）
 *   6. 账本对账（Python，精确/金额容差/日期容差三级匹配）
 *   7. 结构化日志器（Node，脱敏 + 确定性采样 + 按大小轮转）
 *   8. 队列 worker（Python，幂等 + 断点续跑 + 原子状态）
 *   9. 覆盖率门禁（Python，JUnit XML + 覆盖率 JSON → 门禁与 Markdown）
 *  10. 增量构建（Python，内容哈希 + DAG + manifest + --check）
 *
 * 断言纪律：harness 自带独立参考实现复算；runner 启动时 selfCheck + crossCheck 三方交叉门禁。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PORT, apiRequest, snapshotStats, sleep, FIXTURE_HASHES, defineChecks } from './v14/lib.mjs';
import { WS, seed, saveFixtureHashes, loadFixtureHashes, selfCheck, crossCheck } from './test-v34-lib.mjs';
import { tasks as rawTasks } from './test-v34-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasks = defineChecks(rawTasks);

async function main() {
  const bad = [...selfCheck(), ...crossCheck()];
  if (bad.length) {
    console.error('FATAL harness 自校准失败: ' + bad.join('; '));
    process.exit(2);
  }
  console.log('✅ harness 自校准通过（T1-T10 参考实现 + 探针向量交叉校验）\n');

  console.log('='.repeat(80));
  console.log('EvoClaw v34 工作任务压测 — 10 任务（重构/ETL/取证/HTTP客户端/密钥扫描/对账/日志/worker/门禁/构建）');
  console.log(`Server: http://127.0.0.1:${PORT}  WS: ${WS}`);
  console.log('='.repeat(80) + '\n');

  const filter = process.env.TASK_FILTER
    ? new Set(process.env.TASK_FILTER.split(',').map((s) => parseInt(s.trim(), 10))) : null;
  const CHECK_ONLY = !!process.env.CHECK_ONLY;
  for (const t of tasks) {
    if (filter !== null && !filter.has(t.id)) continue;
    if (CHECK_ONLY) continue;
    try { fs.rmSync(t.dir, { recursive: true, force: true }); } catch { /* missing */ }
  }
  if (process.env.NO_SEED) {
    console.log('⏭️  NO_SEED=1 — 跳过输出目录清理与夹具写入');
  } else if (CHECK_ONLY) {
    loadFixtureHashes();
    console.log('⏭️  CHECK_ONLY=1 — 不重跑任务，仅对现有交付物执行核验');
  } else {
    seed();
    saveFixtureHashes();
    console.log(`🧼 已清空输出目录并写入夹具（${FIXTURE_HASHES.size} 个冻结文件）`);
  }

  const before = await snapshotStats();
  const results = [];
  const out = path.resolve(__dirname, filter === null ? 'test-results-v34.json' : `test-results-v34-r${process.env.TASK_FILTER.replace(/,/g, '-')}.json`);
  const save = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString(), before }, null, 2));
  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 1200000;
  const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS) || 45000;

  for (const task of tasks) {
    if (filter !== null && !filter.has(task.id)) continue;
    const sessionId = `v34-task-${task.id}-${Date.now()}`;
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`[Task ${task.id}] ${task.name} (${task.type})`);
    console.log('─'.repeat(60));
    const startTime = Date.now();
    let timedOut = false, reply = '', tokens = 0;
    const receipts = [];
    if (!CHECK_ONLY) {
      let resp;
      try {
        resp = await apiRequest('POST', '/api/chat', { message: task.prompt, sessionId, stream: false });
      } catch (err) {
        timedOut = true;
        console.log(`⚠️  客户端超时（${err.message}），转延迟核验`);
        resp = { status: 0, data: { reply: '' } };
      }
      reply = resp.data?.reply || '';
      tokens = resp.data?.tokensUsed || 0;
      for (const f of resp.data?.files || []) receipts.push(f);
      if (resp.status !== 200 && resp.status !== 0) console.log(`⚠️  HTTP ${resp.status}`);
    }
    const duration = Date.now() - startTime;
    const isCheckpointReply = /⏳|检查点|后台继续|继续执行/.test(reply);
    let verdict;
    try { verdict = await task.check({ reply, tokens, duration, receipts }); }
    catch (e) { verdict = { ok: false, detail: 'check 异常: ' + String((e && e.message) || e).slice(0, 300) }; }
    let verifyWaited = 0;
    while (!verdict.ok && verifyWaited < VERIFY_WINDOW_MS && (timedOut || isCheckpointReply)) {
      await sleep(VERIFY_POLL_MS);
      verifyWaited += VERIFY_POLL_MS;
      try { verdict = await task.check({ reply, tokens, duration, receipts }); }
      catch (e) { verdict = { ok: false, detail: 'check 异常: ' + String((e && e.message) || e).slice(0, 300) }; }
    }
    const delayNote = verifyWaited > 0 ? ` [延迟核验 ${Math.round(verifyWaited / 1000)}s]` : '';
    const status = verdict.ok ? 'success' : timedOut ? 'error' : 'regression';
    results.push({
      id: task.id, name: task.name, type: task.type, expect: task.expect,
      status, duration: duration + verifyWaited, tokens,
      detail: `${verdict.detail}${delayNote}`,
      replyPreview: reply.slice(0, 320).replace(/\n/g, ' '),
    });
    save();
    console.log(`${verdict.ok ? '✅' : '❌'} ${status.toUpperCase()} (${((duration + verifyWaited) / 1000).toFixed(1)}s, tokens=${tokens})`);
    console.log(`   ${results[results.length - 1].detail}`);
    console.log(`   preview: ${results[results.length - 1].replyPreview}...\n`);
  }

  const after = await snapshotStats();
  const globalChecks = [];
  for (const key of Object.keys(before)) {
    const b = before[key]?.value, a = after[key]?.value;
    const hard = key !== 'concurrent';
    if (b == null || a == null) { globalChecks.push([`stats:${key}`, false, '不可读', hard]); continue; }
    globalChecks.push([`stats:${key}`, a > b, `${b}→${a}${hard ? '' : '（依赖模型同轮并发调用，仅供参考）'}`, hard]);
  }
  console.log('\n' + '='.repeat(80));
  console.log('全局断言');
  console.log('='.repeat(80));
  for (const [name, ok, detail, hard] of globalChecks) console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  console.log('\n' + '='.repeat(80));
  console.log('V34 SUMMARY');
  console.log('='.repeat(80));
  const pass = results.filter((r) => r.status === 'success').length;
  console.log(`Total: ${results.length} | pass: ${pass} | regression: ${results.filter((r) => r.status === 'regression').length} | error: ${results.filter((r) => r.status === 'error').length}`);
  for (const r of results) {
    console.log(`  ${r.id}. ${r.name} [${r.status}] ${(r.duration / 1000).toFixed(1)}s tokens=${r.tokens}`);
    console.log(`      ${r.detail}`);
  }
  const hardFail = globalChecks.some(([, ok, , hard]) => hard && !ok);
  console.log(`\n全局断言: ${hardFail ? 'FAIL' : 'PASS'}`);
  save();
  console.log(`\nResults saved: ${out}`);
  process.exit(pass === results.length && !hardFail ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
