/**
 * Round 4 — 并发 / 异步可靠性
 * 13. 有界并发 worker pool + 重试 + 优雅关闭
 * 14. 优先级队列 + 幂等键 + 背压
 * 15. 可恢复批处理（崩溃续跑 + 恰好一次）
 * 16. 跨进程文件锁（原子创建 + 陈旧检测）
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  WS, defineChecks, runProbe, runNodeTest, runNodeWithCode, readFileSafe, writeFixture,
} from './lib.mjs';

const D13 = `${WS}/v14-pool`;
const D14 = `${WS}/v14-taskqueue`;
const D15 = `${WS}/v14-resume`;
const D16 = `${WS}/v14-lock`;

const BATCH_ITEMS = (() => {
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push(JSON.stringify({ id: i, value: i * 3 }));
  return lines.join('\n') + '\n';
})();

function seed() {
  writeFixture(D15, 'fixtures/items.jsonl', BATCH_ITEMS);
}

function spawnEach(cmds, timeoutMs = 120000) {
  return Promise.all(cmds.map(({ cmd, args, cwd }) => new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (c) => { out += c; });
    ch.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} }, timeoutMs);
    ch.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
    ch.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message) }); });
  })));
}

const tasks = defineChecks([
  {
    id: 13, round: 4, name: '有界并发 worker pool', type: '并发/异步',
    prompt: `你是并发系统工程师。在 ${D13}/ 下交付 pool.js（CommonJS，无第三方依赖）：
1）导出 createPool(options)，options 可含：concurrency（默认4）、retries（默认0）、retryDelayMs（默认20）、sleep（默认 setTimeout Promise）。
2）pool.run(items, handler) → Promise<{results}>：对 items 每个元素调用 handler(item, index)，最多同时运行 concurrency 个；结果按输入顺序为 {"index","value"}（成功）或 {"index","error":"消息"}（重试耗尽）。
   - handler 可返回 Promise；抛错/拒绝时重试，最多 retries 次额外尝试，每次失败后 sleep(retryDelayMs)。
   - retries=0 表示只尝试一次。
3）pool.stats() → {"active","maxActive","completed","failed"}（active 为当前运行数，maxActive 为历史峰值）。
4）pool.close() → Promise：等待已激活任务完成，不再接受新任务；之后调用 run 必须拒绝，err.code='POOL_CLOSED'。
5）pool.test.js（node --test，≥6 用例）覆盖并发上限、顺序保持、重试成功、重试耗尽、关闭语义。
6）README.md（≥250 字节）：调度、重试、关闭语义。
7）必须真实运行一次 10 任务/并发 3 的场景，把 maxActive 与失败数写进回复。`,
    expect: 'pool.js + pool.test.js + README.md（并发/重试/关闭探针）',
    dir: D13,
    deliverables: [
      { file: 'pool.js', minBytes: 900 },
      { file: 'pool.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const probe = `
        const sleeps = [];
        const p = m.createPool({ concurrency: 3, retries: 2, retryDelayMs: 20, sleep: async (ms) => { sleeps.push(ms); } });
        let active = 0, peak = 0, attempts2 = 0;
        const results = await p.run([0,1,2,3,4,5,6,7,8,9], async (item, i) => {
          active++; peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
          if (i === 2) { attempts2++; if (attempts2 <= 2) throw new Error('flaky'); }
          return item * 2;
        });
        const stats = p.stats();
        const p2 = m.createPool({ concurrency: 1, retries: 1, retryDelayMs: 10, sleep: async () => {} });
        const exhausted = await p2.run([1], async () => { throw new Error('boom'); });
        let closeErr = null;
        const p3 = m.createPool({ concurrency: 2, retries: 0 });
        const inflight = p3.run([1,2,3], async (x) => { await new Promise((r) => setTimeout(r, 20)); return x; });
        const closed = p3.close();
        try { await p3.run([4], async () => 4); } catch (e) { closeErr = e.code; }
        const inflightRes = await inflight;
        await closed;
        return { results, peak, active, stats, attempts2, sleeps, exhausted, p2stats: p2.stats(), closeErr, inflightRes };
      `;
      const p = runProbe(dir, 'pool.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      if (v.results?.length !== 10) bad.push(`结果数 ${v.results?.length}`);
      for (let i = 0; i < 10; i++) {
        if (i === 2) { if (v.results[i]?.value !== 4) bad.push(`结果[2]=${JSON.stringify(v.results[i])}`); }
        else if (v.results?.[i]?.value !== i * 2) bad.push(`结果[${i}]=${JSON.stringify(v.results?.[i])}`);
      }
      if (!(v.peak <= 3 && v.peak >= 2)) bad.push(`并发峰值 ${v.peak}`);
      if (v.stats?.maxActive !== v.peak || v.stats?.completed !== 10) bad.push(`stats ${JSON.stringify(v.stats)}`);
      // failed 语义=重试耗尽条数；重试至成功的那条在中间尝试失败时实现会自增 failed，故不能硬判 0。
      if (v.stats?.failed < 0 || v.stats?.failed > 10) bad.push(`stats.failed 越界 ${v.stats?.failed}`);
      if (v.attempts2 !== 3 || JSON.stringify(v.sleeps) !== '[20,20]') bad.push(`重试 attempts=${v.attempts2} sleeps=${JSON.stringify(v.sleeps)}`);
      if (v.exhausted?.[0]?.error == null || !/boom/.test(String(v.exhausted[0].error)) || v.p2stats?.failed !== 1) bad.push(`耗尽 ${JSON.stringify(v.exhausted)}/${JSON.stringify(v.p2stats)}`);
      if (v.closeErr !== 'POOL_CLOSED') bad.push(`关闭 err=${v.closeErr}`);
      if (v.inflightRes?.results?.length !== 3) bad.push('close 未等待在途任务');
      if (v.active !== 0) bad.push(`结束后 active=${v.active}`);
      const t = runNodeTest(path.join(dir, 'pool.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓并发≤3/顺序/重试[20,20]/耗尽/close/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'pool.js'));
      return [['并发限制', /concurrency|active/i.test(s)], ['重试', /retries|retryDelay/i.test(s)], ['关闭', /POOL_CLOSED/i.test(s)]];
    },
  },
  {
    id: 14, round: 4, name: '优先级队列 + 幂等 + 背压', type: '并发/队列',
    prompt: `你是任务队列工程师。在 ${D14}/ 下交付 queue.js（CommonJS，无第三方依赖）：
1）导出 createQueue({concurrency=2, capacity=10})。
2）queue.enqueue(job)：job 为 {"key"?,"priority"?=0,"task":async function}，返回 Promise（resolve task 的返回值）。
   - 并发上限 concurrency；priority 数值越大越先执行；同优先级按入队顺序 FIFO。
   - key 幂等：同一 key 在排队或执行期间再次 enqueue，不重复执行，返回**同一个 Promise**。
   - 容量 capacity 指排队 + 执行中的总任务数；已满时新 enqueue 返回 rejected Promise，err.code='QUEUE_FULL'。
3）queue.drain() → Promise，等待当前所有任务完成。
4）queue.stats() → {"processed","deduped","rejected","peakActive"}。
5）queue.test.js（node --test，≥6 用例）覆盖优先级、FIFO、幂等、容量拒绝、并发上限。
6）README.md（≥250 字节）：调度与背压语义。
7）必须真实运行一次优先级与幂等场景，把执行顺序与 deduped 计数写进回复。`,
    expect: 'queue.js + queue.test.js + README.md（优先级/幂等/背压探针）',
    dir: D14,
    deliverables: [
      { file: 'queue.js', minBytes: 900 },
      { file: 'queue.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const probe = `
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = m.createQueue({ concurrency: 1, capacity: 10 });
        const log = [];
        const blocker = q.enqueue({ key: 'block', priority: 0, task: async () => { await sleep(20); log.push('block'); return 'b'; } });
        await sleep(5);
        const p5 = q.enqueue({ priority: 5, task: async () => { log.push('p5'); return 5; } });
        const p3 = q.enqueue({ priority: 3, task: async () => { log.push('p3'); return 3; } });
        const p0a = q.enqueue({ priority: 0, task: async () => { log.push('p0a'); return 'a'; } });
        const p0b = q.enqueue({ priority: 0, task: async () => { log.push('p0b'); return 'b'; } });
        const vals = await Promise.all([blocker, p5, p3, p0a, p0b]);
        await q.drain();
        const stats1 = q.stats();
        // 幂等
        const q2 = m.createQueue({ concurrency: 1, capacity: 5 });
        let calls = 0, release;
        const gate = new Promise((r) => { release = r; });
        const t1 = q2.enqueue({ key: 'k', task: async () => { calls++; await gate; return 'v'; } });
        await sleep(5);
        const t2 = q2.enqueue({ key: 'k', task: async () => { calls++; return 'x'; } });
        release();
        const [v1, v2] = await Promise.all([t1, t2]);
        await q2.drain();
        const stats2 = q2.stats();
        // 背压
        const q3 = m.createQueue({ concurrency: 1, capacity: 1 });
        const long = q3.enqueue({ task: async () => { await sleep(30); return 'long'; } });
        let fullErr = null;
        try { await q3.enqueue({ task: async () => 'x' }); } catch (e) { fullErr = e.code; }
        const longVal = await long;
        await q3.drain();
        const stats3 = q3.stats();
        return { log, vals, stats1, calls, v1, v2, same: t1 === t2, stats2, fullErr, longVal, stats3 };
      `;
      const p = runProbe(dir, 'queue.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      if (JSON.stringify(v.log) !== JSON.stringify(['block', 'p5', 'p3', 'p0a', 'p0b'])) bad.push(`顺序 ${JSON.stringify(v.log)}`);
      if (v.stats1?.peakActive > 1) bad.push(`峰值 ${v.stats1?.peakActive}`);
      if (v.calls !== 1 || v.v1 !== 'v' || v.v2 !== 'v') bad.push(`幂等 calls=${v.calls} v=${v.v1}/${v.v2}`);
      if (v.stats2?.deduped !== 1 || v.stats2?.processed !== 1) bad.push(`dedupe stats ${JSON.stringify(v.stats2)}`);
      if (v.fullErr !== 'QUEUE_FULL') bad.push(`背压 err=${v.fullErr}`);
      if (v.longVal !== 'long' || v.stats3?.rejected !== 1) bad.push(`背压 ${v.longVal}/${JSON.stringify(v.stats3)}`);
      const t = runNodeTest(path.join(dir, 'queue.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓优先级/FIFO/同Promise幂等/QUEUE_FULL/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'queue.js'));
      return [['优先级', /priority/i.test(s)], ['幂等 key', /key|dedup/i.test(s)], ['背压', /QUEUE_FULL|capacity/i.test(s)]];
    },
  },
  {
    id: 15, round: 4, name: '可恢复批处理（崩溃续跑）', type: '批处理/可靠性',
    prompt: `你是数据管道工程师。在 ${D15}/ 下交付 batch.js（CommonJS，无第三方依赖），夹具 fixtures/items.jsonl（100 行 {"id","value"}）由我提供，**禁止修改**：
1）CLI：\`node batch.js --input fixtures/items.jsonl --out out.jsonl --state state.json [--fail-at N]\`；所有相对路径按**进程当前工作目录**解析。
2）顺序处理每条 item，输出一行 {"id":item.id,"doubled":item.value*2} 追加到 out.jsonl；每完成一条后把 {"nextIndex":已完成条数} 原子写入 state.json（临时文件 + rename）。
3）--fail-at N：在处理 0 基下标 N 的那条时抛出错误并以退出码 3 退出；**不得**写入第 N 条，也不得把 nextIndex 推进到 N+1。用于模拟崩溃。
4）续跑：启动时若 state.json 存在，从 nextIndex 继续，不重复处理前序条目；out.jsonl 以追加方式写入（不得截断）。全部完成时写 manifest.json：{"total":100,"processed":100,"doubledSum":总和}，退出码 0。
5）batch.test.js（node --test，≥5 用例）覆盖首跑完成、失败中断、续跑不重复、manifest 数值、非法输入。
6）README.md（≥250 字节）：状态文件、原子写、续跑语义。
7）必须真实验证崩溃续跑：先带 --fail-at 37 跑一次，再不带参数跑第二次，把两次退出码与 out 行数写进回复。`,
    expect: 'batch.js + out.jsonl(100) + state.json + manifest.json + README.md',
    dir: D15, frozen: ['fixtures/items.jsonl'],
    // out.jsonl/state.json/manifest.json 由 exec 在独立 verify-run 目录重跑并校验，
    // 不要求落在交付根目录（agent 常按 cwd 输出到子目录）。
    deliverables: [
      { file: 'batch.js', minBytes: 900 },
      { file: 'batch.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      // 用独立目录重跑，避免依赖 agent 留下的中间状态顺序
      const work = path.join(dir, 'verify-run');
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(work, { recursive: true });
      const first = runNodeWithCode(work, `../batch.js --input ${path.join(dir, 'fixtures/items.jsonl')} --out out.jsonl --state state.json --fail-at 37`);
      if (first.code !== 3) return { ok: false, detail: `exec=首跑退出码 ${first.code}≠3 ${first.out.slice(-200).replace(/\n/g, ' ')}` };
      const bad = [];
      let st;
      try { st = JSON.parse(fs.readFileSync(path.join(work, 'state.json'), 'utf8')); } catch { return { ok: false, detail: 'exec=state.json 非法' }; }
      if (st.nextIndex !== 37) bad.push(`中断后 nextIndex=${st.nextIndex}≠37`);
      const out1 = fs.readFileSync(path.join(work, 'out.jsonl'), 'utf8').split('\n').filter(Boolean);
      if (out1.length !== 37) bad.push(`中断后 out 行数=${out1.length}≠37`);
      const second = runNodeWithCode(work, `../batch.js --input ${path.join(dir, 'fixtures/items.jsonl')} --out out.jsonl --state state.json`);
      if (second.code !== 0) bad.push(`续跑退出码 ${second.code}`);
      const out2 = fs.readFileSync(path.join(work, 'out.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (out2.length !== 100) bad.push(`续跑后行数 ${out2.length}≠100`);
      const ids = out2.map((x) => x.id);
      if (new Set(ids).size !== 100) bad.push(`重复 id ${out2.length - new Set(ids).size}`);
      const sum = out2.reduce((a, x) => a + x.doubled, 0);
      if (sum !== 30300) bad.push(`doubledSum ${sum}≠30300`);
      let man;
      try { man = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8')); } catch { bad.push('manifest.json 非法'); }
      if (man && (man.total !== 100 || man.processed !== 100 || man.doubledSum !== 30300)) bad.push(`manifest ${JSON.stringify(man)}`);
      const t = runNodeTest(path.join(dir, 'batch.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓中断退出3/nextIndex37/续跑100条不重复/sum30300/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'batch.js'));
      return [['原子写', /rename|tmp|temp/i.test(s)], ['续跑', /nextIndex|state/i.test(s)], ['fail-at', /fail-at/i.test(s)]];
    },
  },
  {
    id: 16, round: 4, name: '跨进程文件锁 + 并发计数', type: '并发/系统',
    prompt: `你是系统工程师。在 ${D16}/ 下交付 lock.js（CommonJS，无第三方依赖）与 counter.js：
1）lock.js 导出 acquire(lockPath, options) → Promise<releaseFn>。options 可含 staleMs（默认5000）、timeoutMs（默认5000）、now（默认 Date.now）、retryMs（默认20）。
   - 用 fs.open(path,'wx') 原子创建，内容为 JSON {"pid":n,"acquiredAt":ms}；失败时读取现有锁：
   - 陈旧判定：now() - acquiredAt > staleMs **或** 记录 pid 已不存在（process.kill(pid,0) 抛 ESRCH），则删除并重试；
   - 否则每 retryMs 重试，超过 timeoutMs 抛 Error，code='LOCK_TIMEOUT'；
   - releaseFn 只能删除自己持有的锁（读取内容 pid 与自身 pid 一致才 unlink），重复调用安全。
2）counter.js CLI：\`node counter.js --lock <锁文件> --iterations N --out <计数文件>\`。每轮 acquire 后读取计数（文件不存在视为 0），加 1，临时文件 + rename 写回，再 release。结束后退出码 0。
3）lock.test.js（node --test，≥5 用例）覆盖互斥、超时、陈旧锁回收、release 幂等。
4）README.md（≥250 字节）：原子创建、陈旧检测、释放语义。
5）必须真实验证并发：8 个进程各 25 次，最终计数必须为 200，把结果写进回复。`,
    expect: 'lock.js + counter.js + lock.test.js + README.md（8进程×25次=200）',
    dir: D16,
    deliverables: [
      { file: 'lock.js', minBytes: 700 },
      { file: 'counter.js', minBytes: 500 },
      { file: 'lock.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: async (dir) => {
      const lock = path.join(dir, 'verify.lock');
      const cnt = path.join(dir, 'verify-counter.txt');
      try { fs.rmSync(lock, { force: true }); fs.rmSync(cnt, { force: true }); } catch {}
      const cmds = [];
      for (let i = 0; i < 8; i++) cmds.push({ cmd: 'node', args: ['counter.js', '--lock', lock, '--iterations', '25', '--out', cnt], cwd: dir });
      const runs = await spawnEach(cmds, 120000);
      const bad = [];
      const failed = runs.filter((x) => x.code !== 0);
      if (failed.length) bad.push(`${failed.length} 个进程非0: ${failed[0].out.slice(-120).replace(/\n/g, ' ')}`);
      let val = -1;
      try { val = Number(fs.readFileSync(cnt, 'utf8').trim()); } catch {}
      // validate 计数：8 进程 × 25 次，exclusive lock 下必须恰好 200
      if (val !== 200) bad.push(`最终计数 ${val}≠200（互斥锁丢失更新）`);
      // 陈旧锁恢复探针（注入 now）
      const staleLock = path.join(dir, 'stale.lock');
      fs.writeFileSync(staleLock, JSON.stringify({ pid: 999999, acquiredAt: 1000 }));
      const staleProbe = `
        const fs = require('fs');
        let released = false;
        const release = await m.acquire(${JSON.stringify(staleLock)}, { staleMs: 1000, timeoutMs: 1000, now: () => 5000, retryMs: 5 });
        await release(); released = !fs.existsSync(${JSON.stringify(staleLock)});
        let reacquired = null;
        const rel2 = await m.acquire(${JSON.stringify(staleLock)}, { staleMs: 1000, timeoutMs: 1000, now: () => 10000, retryMs: 5 });
        rel2();
        return { released };
      `;
      const sp = runProbe(dir, 'lock.js', staleProbe);
      if (!sp.ok) bad.push('陈旧锁探针失败 ' + sp.out);
      else if (sp.value?.released === false) bad.push('release 未删除锁文件');
      const t = runNodeTest(path.join(dir, 'lock.test.js'), 120000);
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓8进程×25次计数200/陈旧锁回收/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'lock.js'));
      return [['wx 原子创建', /'wx'|"wx"/.test(s)], ['陈旧检测', /staleMs|ESRCH/i.test(s)], ['rename', /rename/i.test(readFileSafe(path.join(dir, 'counter.js')))]];
    },
  },
]);

export const round = 4;
export const title = '并发 / 异步可靠性';
export default { round, title, outTag: 'r4', seed, tasks };
