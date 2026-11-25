/**
 * EvoClaw v32 工作任务压测 — 9 项复杂多步任务，领域与 v12–v31 零重叠：
 *   1. 四则运算表达式求值（shunting-yard + RPN，floor 除/取余钉死）Python
 *   2. KMP 前缀函数 + 重叠串匹配位置（Node）
 *   3. Bloom filter（zlib.crc32 钉死哈希 + 误判率报告）Python
 *   4. LRU/LFU/CLOCK 缓存模拟器（Python）
 *   5. 指数退避 full-jitter（LCG 种子）+ 熔断器状态机（Node）
 *   6. N-queens 回计数 + 字典序首解（Python）
 *   7. 撤销/重做编辑器操作日志（连续插入合并组，Node）
 *   8. 有向图传递闭包 + 可达对统计（Floyd，Node）
 *   9. 确定性 quickselect（中位数三选 + Lomuto + 比较计数，Python）
 *
 * 断言纪律：harness 自带独立参考实现复算；不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PORT, apiRequest, snapshotStats, sleep, FIXTURE_HASHES, invariantCheck, defineChecks } from './v14/lib.mjs';
import { D, WS, seed, saveFixtureHashes, loadFixtureHashes, selfCheck } from './test-v32-lib.mjs';
import { tasks as rawTasks } from './test-v32-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasks = defineChecks(rawTasks);

async function main() {
  const bad = selfCheck();
  if (bad.length) {
    console.error('FATAL harness 自校准失败: ' + bad.join('; '));
    process.exit(2);
  }
  console.log('✅ harness 自校准通过（T1-T9 参考实现）\n');

  console.log('='.repeat(80));
  console.log('EvoClaw v32 工作任务压测 — 9 任务（表达式/KMP/Bloom/缓存/退避熔断/N皇后/撤销重做/闭包/quickselect）');
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
  const out = path.resolve(__dirname, filter === null ? 'test-results-v32.json' : `test-results-v32-r${process.env.TASK_FILTER.replace(/,/g, '-')}.json`);
  const save = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString(), before }, null, 2));
  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 1200000;
  const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS) || 45000;

  for (const task of tasks) {
    if (filter !== null && !filter.has(task.id)) continue;
    const sessionId = `v32-task-${task.id}-${Date.now()}`;
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
  console.log('V32 SUMMARY');
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
