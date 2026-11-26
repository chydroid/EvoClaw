/**
 * EvoClaw v33 工作任务压测 — 10 项「生产系统组件」级复杂多步任务，领域与 v12–v32 零重叠：
 *   1. 功能开关求值引擎（Python，规则优先级 + fnv1a 灰度分桶）
 *   2. Webhook 投递引擎（Node，HMAC 签名 + 重试时间线 + 幂等去重 + 死信）
 *   3. 时序指标下采样 + 分层 rollup（Python，乱序/空窗/p95）
 *   4. 不透明游标分页（Node，base64url + HMAC 防篡改 + 排序签名）
 *   5. 数据库迁移编排器（Python，拓扑 + 校验和幂等 + 失败逆序回滚）
 *   6. 一致性哈希环 + 再平衡（Node，虚拟节点 + crc32 钉死 + 最小迁移）
 *   7. 日志异常检测 EWMA + 3σ（Python，冷启动 + 连续去抖）
 *   8. 审计日志哈希链（Node，规范 JSON + SHA-256 链 + 断链定位）
 *   9. i18n 消息格式化（Python，CLDR 复数 + ICU-lite + 回退链）
 *   10. Snowflake ID 生成器（Node，位布局 + 序列溢出 + 时钟回拨策略）
 *
 * 断言纪律：harness 自带独立参考实现复算；runner 启动时 selfCheck + crossCheck 三方交叉门禁。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PORT, apiRequest, snapshotStats, sleep, FIXTURE_HASHES, invariantCheck, defineChecks } from './v14/lib.mjs';
import { WS, seed, saveFixtureHashes, loadFixtureHashes, selfCheck, crossCheck } from './test-v33-lib.mjs';
import { tasks as rawTasks } from './test-v33-tasks.mjs';

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
  console.log('EvoClaw v33 工作任务压测 — 10 任务（开关/Webhook/指标/分页/迁移/哈希环/异常检测/审计链/i18n/Snowflake）');
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
  const out = path.resolve(__dirname, filter === null ? 'test-results-v33.json' : `test-results-v33-r${process.env.TASK_FILTER.replace(/,/g, '-')}.json`);
  const save = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString(), before }, null, 2));
  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 1200000;
  const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS) || 45000;

  for (const task of tasks) {
    if (filter !== null && !filter.has(task.id)) continue;
    const sessionId = `v33-task-${task.id}-${Date.now()}`;
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
  console.log('V33 SUMMARY');
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
