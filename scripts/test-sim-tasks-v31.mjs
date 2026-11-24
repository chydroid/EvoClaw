/**
 * EvoClaw v31 工作任务压测 — 10 项全新复杂多步任务，领域与 v12–v30 零重叠：
 *   1. YAML 子集解析器（嵌套映射/序列/标量/注释/锚点排除）Python
 *   2. 复式记账总账（借贷平衡校验/账簿重放/余额）Python
 *   3. 老化优先级队列（等待时间老化/服务序）Python
 *   4. 正则 NFA 引擎（Thompson 构造/全词匹配/惰性量词语义钉死）Node
 *   5. 分层配置合并 + ${ref} 插值（数组替换/引用解析/不修改入参）Node
 *   6. 日志轮转与保留策略模拟（压缩/保留/dropped 统计）Python
 *   7. Gossip 反熵（LCG 种子洗牌/版本冲突/多数派保证判定）Python
 *   8. Count-Min Sketch（固定 FNV-1a/top-k/去重估计的过估计特性）Node
 *   9. EDF 调度模拟器（周期实例/抢占/空闲步/错过截止期清单）Python
 *   10. 画布图元（Bresenham/矩形描边/洪泛填充/首次置像素统计/base64）Node
 *
 * 断言纪律：harness 自带独立参考实现复算；不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PORT, apiRequest, snapshotStats, sleep, FIXTURE_HASHES, invariantCheck, defineChecks } from './v14/lib.mjs';
import { D, WS, seed, saveFixtureHashes, loadFixtureHashes, selfCheck } from './test-v31-lib.mjs';
import { tasks as rawTasks } from './test-v31-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasks = defineChecks(rawTasks);

async function main() {
  const bad = selfCheck();
  if (bad.length) {
    console.error('FATAL harness 自校准失败: ' + bad.join('; '));
    process.exit(2);
  }
  console.log('✅ harness 自校准通过（T1-T10 参考实现）\n');

  console.log('='.repeat(80));
  console.log('EvoClaw v31 工作任务压测 — 10 任务（YAML/总账/老化队列/NFA正则/配置合并/日志轮转/gossip/CMSketch/EDF/画布）');
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
  const out = path.resolve(__dirname, filter === null ? 'test-results-v31.json' : `test-results-v31-r${process.env.TASK_FILTER.replace(/,/g, '-')}.json`);
  const save = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString(), before }, null, 2));
  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 1200000;
  const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS) || 45000;

  for (const task of tasks) {
    if (filter !== null && !filter.has(task.id)) continue;
    const sessionId = `v31-task-${task.id}-${Date.now()}`;
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
  console.log('V31 SUMMARY');
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
