/**
 * EvoClaw v34 压测任务定义（10 任务）与核验器。
 * 主题：真实工程交付——重构 / ETL / 缺陷取证 / HTTP 客户端 / 密钥扫描 / 对账 /
 * 结构化日志 / 队列 worker / 覆盖率门禁 / 增量构建。
 * 核验纪律：harness 自带参考实现复算（test-v34-lib.mjs），不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { runPy, runProbe, readFileSafe, hashFile } from './v14/lib.mjs';
import {
  D, sameJson, diffNote, pyLoadModule, runNodeDriver,
  T1_LEGACY, T1_PROBE, t2Report, T5_FILES, t5Ref, t5HoldoutRef,
  T6_LEDGER, T6_BANK, t6Ref, t7Sampled, T7_REDACT, T7_SAMPLE_EVERY, T7_MAX_BYTES, T7_MAX_FILES,
  t9Ref, T9_JUNIT, T9_COVERAGE, t3GroundTruth, T3_BAD_STEP, T3_B_BAD_STEP, HOLDOUT_T3, HOLDOUT_T5,
  T5_ENTROPY_MIN,
} from './test-v34-lib.mjs';

// ─────────────────────────── 通用助手 ───────────────────────────
const ASSERT_LINE_RE = /\bassert\b|\b(?:assert|expect|check|verify|should|ensure|confirm)\w*\s*\(|\bok\s*\(|(?:断言|校验|检查|验证|确认)\s*[（(]/;
const ASSERT_SKIP_LINE_RE = /^\s*(?:import\b|(?:const|let|var)\b.*\brequire\s*\()/;
function assertCount(file, min) {
  const t = readFileSafe(file);
  let n = 0;
  for (const line of t.split(/\r?\n/)) {
    if (ASSERT_SKIP_LINE_RE.test(line)) continue;
    if (ASSERT_LINE_RE.test(line)) n++;
  }
  return n >= min ? null : `${path.basename(file)} 断言数 ${n}<${min}`;
}
function cli(dir, cmd, timeoutMs = 60000) {
  try {
    return execSync(`timeout ${Math.floor(timeoutMs / 1000)} bash -c ${JSON.stringify(cmd)} 2>&1; echo "rc=$?"`, {
      cwd: dir, timeout: timeoutMs + 10000, encoding: 'utf8',
    }).toString().trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).toString().trim() + '\nrc=124';
  }
}
function runNodeTestIn(dir, file) {
  try {
    const out = execSync(`timeout 80 node --test ${JSON.stringify(file)} 2>&1`, { cwd: dir, timeout: 90000, encoding: 'utf8' }).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  }
}
function extractJson(out) {
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
const fileJson = (dir, file) => extractJson(readFileSafe(path.join(dir, file)));
const pyRun = (dir, args, timeoutMs = 90000) => {
  try {
    const out = execSync(`timeout 80 python3 ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
};
const pyProbe = (dir, moduleFile, expr, extraArgs = []) => runPy(dir, `
import json, sys
${pyLoadModule('t34mod', dir + '/' + moduleFile)}
${expr}
`, extraArgs);
function tmpDir(tag) {
  const d = `/tmp/v34-check-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}
function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
function startMockServer(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-u', path.join(dir, 'mock_server.py')], { cwd: dir });
    let buf = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('mock server start timeout')); }, 15000);
    const onData = (d) => {
      buf += d.toString();
      const m = /^(\d+)\s*$/m.exec(buf);
      if (m) { clearTimeout(timer); resolve({ port: Number(m[1]), proc }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('exit', (c) => { clearTimeout(timer); if (!/^(\d+)\s*$/m.test(buf)) reject(new Error(`mock server exited rc=${c} ${buf.slice(0, 200)}`)); });
  });
}
const lastLineJson = (out) => {
  const lines = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
  }
  return null;
};
const normFindings = (arr) => {
  if (!Array.isArray(arr)) return arr;
  return arr.map((f) => ({ file: f && f.file, line: f && f.line, type: f && f.type }))
    .sort((a, b) => String(a.file).localeCompare(String(b.file)) || (a.line - b.line) || String(a.type).localeCompare(String(b.type)));
};

export const tasks = [
  // ═══════════════ T1: 遗留代码重构（Python，日志 helper 抽取 + 行为等价） ═══════════════
  {
    id: 1, name: '遗留代码重构（Python，日志 helper 抽取 + 字节级行为等价）', type: '重构',
    prompt: `你是维护工程师。\`${D(1)}/legacy/\` 下有一个遗留模块 \`report_gen.py\`，里面 7 处散落的 \`print(...)\` 日志。
请把它重构到 \`${D(1)}/report_gen.py\`（**新文件**，不要改 legacy/ 里的原件），要求：
1. 抽取**唯一**日志 helper：\`def log(level, message): print("[" + level + "] " + message)\`
   （输出必须与原来逐字节一致，如 \`[INFO] summarize start\`）；
2. 所有日志输出都改走 \`log(...)\`，整个文件里 \`print(\` 只允许出现 **1 次**（在 helper 内）；
3. 业务逻辑（summarize / group_by / format_row）的返回值、异常类型、stdout 内容必须与原件**完全等价**；
4. 交付 \`test_report_gen.py\`：\`python3 test_report_gen.py\` 退出码 0，用 unittest，**至少 8 个断言**，
   覆盖 summarize 返回值、group_by、format_row、缺 amount 抛 ValueError、stdout 逐行内容；
5. 交付 \`README.md\`（≥300 字节）：说明抽取方式与等价性保证；
6. **禁止修改** \`legacy/\` 下的两个冻结文件。
在回复中说明 \`print(\` 的最终出现次数。`,
    expect: 'report_gen.py + test_report_gen.py + README.md', dir: D(1),
    frozen: ['legacy/report_gen.py', 'legacy/test_report_gen.py'],
    deliverables: [
      { file: 'report_gen.py', minBytes: 700 }, { file: 'test_report_gen.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const src = readFileSafe(path.join(dir, 'report_gen.py'));
      if (!src) { return { ok: false, detail: 'exec=✗report_gen.py 缺失' }; }
      const printCalls = (src.match(/\bprint\s*\(/g) || []).length;
      if (printCalls !== 1) bad.push(`print( 出现 ${printCalls} 次（应为 1）`);
      if (!/\bdef\s+log\s*\(\s*level\s*,\s*message\s*\)/.test(src)) bad.push('缺少 def log(level, message)');
      // 行为等价：pristine 副本在 /tmp，候选在任务目录
      const pristine = `/tmp/v34-t1-pristine-${Date.now()}.py`;
      fs.writeFileSync(pristine, T1_LEGACY, 'utf8');
      const probe = runPy(dir, T1_PROBE, [pristine, path.join(dir, 'report_gen.py')]);
      cleanup(pristine);
      if (!probe.ok) bad.push('等价探针失败: ' + String(probe.out).slice(-220));
      else if (probe.value && probe.value.diffs && probe.value.diffs.length) {
        bad.push('行为不等价: ' + JSON.stringify(probe.value.diffs).slice(0, 260));
      }
      const ac = assertCount(path.join(dir, 'test_report_gen.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_report_gen.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓print 唯一/helper/行为等价/单测全一致' };
    },
  },

  // ═══════════════ T2: 脏 CSV → SQLite ETL（Python） ═══════════════
  {
    id: 2, name: '脏 CSV → SQLite ETL（Python，质量规则 + 拒绝表 + 聚合报表）', type: '数据工程',
    prompt: `你是数据工程师。在 ${D(2)}/ 交付零依赖 Python（仅标准库）ETL 作业。
冻结夹具：\`orders.csv\`（**带 UTF-8 BOM、CRLF 换行、末尾空行**，字段含逗号与引号需按 RFC 4180 解析）、
\`customers.json\`（\`{customers:[{id,name,country}]}\`）。禁止修改夹具。
**必须交付（缺一不可）：etl.py、test_etl.py、README.md、report.json、warehouse.db。**
CLI：\`python3 etl.py build\` 读取两个夹具，写出 \`warehouse.db\` 与 \`report.json\`，退出码 0，打印摘要。
SQLite 表结构（列名必须一致）：
- \`customers(id TEXT PRIMARY KEY, name TEXT, country TEXT)\`
- \`orders(order_id TEXT PRIMARY KEY, customer_id TEXT, amount REAL, ts TEXT)\`
- \`rejects(order_id TEXT, reason TEXT)\`
清洗规则（**按此顺序**逐行判定，命中即拒绝并写 rejects）：
1. amount 不能转成数字（如 \`abc\`）→ \`bad_amount\`；
2. amount < 0 → \`negative_amount\`；
3. customer_id 为空或不在 customers 中 → \`orphan_customer\`；
4. order_id 重复（**保留首次出现**，后续同 id 拒绝）→ \`duplicate\`；
否则接受：amount 四舍五入到 2 位小数后入库。
\`report.json\` **恰好**包含这些键（多键少键都算错）：
\`{"accepted": int, "rejected": int, "rejectsByReason": {reason: count}, "revenueByCountry": {country: 营收(2 位小数)},
"topCustomer": {"id": 客户 id, "total": 营收} | null, "monthly": {"YYYY-MM": 营收(2 位小数)}}\`
（营收按接受行 amount 求和；topCustomer 取营收最高者，并列时取 id 字典序最小）。
test_etl.py：\`python3 test_etl.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖 BOM/CRLF 解析、
四类拒绝原因各一例、重复保留首次、金额 2 位小数、按国家/月度聚合、topCustomer。
README.md（≥300 字节）：清洗规则优先级与报表口径。
在回复中写明 accepted/rejected 两个数。`,
    expect: 'etl.py + test + README + report.json + warehouse.db', dir: D(2), frozen: ['orders.csv', 'customers.json'],
    deliverables: [
      { file: 'etl.py', minBytes: 1400 }, { file: 'test_etl.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 },
      { file: 'warehouse.db', minBytes: 1000 },
      { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['etl.py', 'build']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const ref = t2Report();
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 独立核对 SQLite 真实内容（防 report 自说自话）
      const dbPath = path.join(dir, 'warehouse.db');
      if (!fs.existsSync(dbPath)) bad.push('warehouse.db 缺失');
      else {
        const drv = runNodeDriver(dir, `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(dbPath)});
const out = {};
out.orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
out.rejects = db.prepare('SELECT COUNT(*) c FROM rejects').get().c;
out.customers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
out.us = db.prepare("SELECT ROUND(SUM(o.amount),2) s FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.country='US'").get().s;
out.byReason = {};
for (const r of db.prepare('SELECT reason, COUNT(*) c FROM rejects GROUP BY reason').all()) out.byReason[r.reason] = r.c;
console.log(JSON.stringify(out));
db.close();
`);
        if (!drv.ok) bad.push('db 查询失败: ' + drv.out.slice(-200));
        else {
          const got = lastLineJson(drv.out);
          const want = { orders: 5, rejects: 5, customers: 2, us: 150.75, byReason: ref.rejectsByReason };
          if (!got || !sameJson(got, want)) bad.push('db 内容与参考不符: ' + diffNote(got, want));
        }
      }
      const ac = assertCount(path.join(dir, 'test_etl.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_etl.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓清洗/拒绝表/聚合/db内容/CLI/单测全一致' };
    },
  },

  // ═══════════════ T3: Git 缺陷取证（Python，bisect 泛化） ═══════════════
  {
    id: 3, name: 'Git 缺陷取证（Python，bisect 泛化到未见仓库）', type: '调试/取证',
    prompt: `你是调试工程师。${D(3)}/repo 是一个 git 仓库：\`main\` 上最新提交起，测试 \`tests/test_calc.py\` 一直失败，
某个提交引入了回归。请交付 \`${D(3)}/investigate.py\`（零依赖 Python）：
CLI：\`python3 investigate.py <repo_path> <test_rel_path>\`，在 \`repo_path\` 下以 \`python3 <test_rel_path>\`
运行测试（退出码非 0 即失败），**用二分（bisect）语义**定位：找到「最早开始失败」的提交，
并把它的父提交作为 last_good。向 stdout 打印**恰好一行 JSON**（其它诊断信息请写 stderr）：
\`{"bad_commit": <完整 40 位 sha>, "last_good": <父提交完整 sha>, "bad_subject": <该提交标题>}\`
约束：
- **通用**：不能硬编码本仓库的提交号、文件名或测试名——脚本会在一个你从未见过的仓库上被复跑；
- **只读**：不得修改仓库（\`git status --porcelain -uno\` 必须保持为空），也不得提交/检出后不还原；
- 假定回归是单调的（首个坏提交之后一直坏）。
同时交付：
- \`report.json\`：对 ${D(3)}/repo（测试路径 \`tests/test_calc.py\`）运行所得的那一行 JSON 对象；
- \`INVESTIGATION.md\`（≥300 字节）：你的定位方法与结论（坏提交标题）。
在回复中写明 bad_subject。`,
    expect: 'investigate.py + INVESTIGATION.md + report.json', dir: D(3), frozen: [],
    deliverables: [
      { file: 'investigate.py', minBytes: 800 }, { file: 'INVESTIGATION.md', minBytes: 300 },
      { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const repo = path.join(dir, 'repo');
      const gt = t3GroundTruth(repo, 'step', T3_BAD_STEP);
      if (!gt.bad_commit) { return { ok: false, detail: 'exec=✗夹具仓库异常（未找到坏提交）' }; }
      // 1) 可见仓库
      const r1 = pyRun(dir, ['investigate.py', 'repo', 'tests/test_calc.py'], 120000);
      const j1 = lastLineJson(r1.out);
      if (!j1) bad.push('可见仓库无 JSON 输出: ' + r1.out.slice(-200));
      else if (j1.bad_commit !== gt.bad_commit || j1.last_good !== gt.last_good) {
        bad.push(`可见仓库定位错误: got ${String(j1.bad_commit).slice(0, 8)}/${String(j1.last_good).slice(0, 8)} want ${gt.bad_commit.slice(0, 8)}/${gt.last_good.slice(0, 8)}`);
      } else if (j1.bad_subject !== gt.bad_subject) bad.push('bad_subject 不符: ' + JSON.stringify(j1.bad_subject));
      // 2) 未见仓库（泛化）
      const gtb = t3GroundTruth(HOLDOUT_T3, 'step', T3_B_BAD_STEP);
      const r2 = pyRun(dir, ['investigate.py', HOLDOUT_T3, 'tests/test_pricing.py'], 120000);
      const j2 = lastLineJson(r2.out);
      if (!j2) bad.push('未见仓库无 JSON 输出: ' + r2.out.slice(-200));
      else if (j2.bad_commit !== gtb.bad_commit || j2.last_good !== gtb.last_good) {
        bad.push(`未见仓库定位错误（未泛化）: got ${String(j2.bad_commit).slice(0, 8)} want ${gtb.bad_commit.slice(0, 8)}`);
      }
      // 3) 仓库只读
      const st = cli(dir, `git -C repo status --porcelain -uno`);
      if (!/^rc=0\b/m.test(st) || st.replace(/rc=0\s*$/, '').trim() !== '') bad.push('仓库被修改: ' + st.slice(0, 160));
      // 4) report.json 自洽
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, { bad_commit: gt.bad_commit, last_good: gt.last_good, bad_subject: gt.bad_subject })) {
        bad.push('report.json 与实测不符: ' + diffNote(rep, { bad_commit: gt.bad_commit, last_good: gt.last_good, bad_subject: gt.bad_subject }));
      }
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 460) : 'exec=✓可见/未见仓库均定位准确+仓库只读+report 自洽' };
    },
  },

  // ═══════════════ T4: 分页 HTTP 客户端（Node） ═══════════════
  {
    id: 4, name: '分页 HTTP 客户端（Node，429 重试 + ETag/304 + 磁盘缓存）', type: '网络/可靠性',
    prompt: `你是 API 客户端工程师。在 ${D(4)}/ 交付零依赖 Node（CommonJS）分页拉取客户端。
冻结夹具：\`mock_server.py\`（不要修改；用 \`python3 mock_server.py\` 启动，stdout 首行是端口）。
服务行为：\`GET /api/items?cursor=<n>\` 返回 \`{"items":[{"id","name"}], "next": <下一 cursor 或 null>}\` 并带 \`ETag\`；
**每个 cursor 的第一次请求（未带 If-None-Match）返回 429 + \`Retry-After: 1\`**；带匹配的 \`If-None-Match\` 返回 304。
**必须交付（缺一不可）：client.js、client.test.js、README.md、report.json。**
client.js 用 \`module.exports = { fetchAll }\` 导出，并支持 CLI：\`node client.js run <baseUrl>\`：
- 从 \`cursor=0\` 开始逐页拉取，直到 \`next\` 为 null，拼接全部 items；
- 遇 429 按 \`Retry-After\`（秒）等待后**重试同一 cursor**；
- 磁盘缓存：把每页响应（含 ETag 与 body）存到当前目录 \`.cache/\` 下；后续请求带 \`If-None-Match\`，
  收到 304 时直接用缓存 body（计入 notModified，不计入 retries429）；
- 写当前目录 \`report.json\`（**恰好这些键**）：
  \`{"items": [id...], "pages": int, "retries429": int, "notModified": int}\`
  （pages = 本次实际取到 200 的页数；items 为 id 顺序数组）。
client.test.js：\`node --test client.test.js\` 通过，至少 8 个断言（node:assert），自行起一个本地 http mock，
覆盖：多页拼接、429 重试、304 复用缓存、report 计数自洽、next 为 null 终止。
README.md（≥300 字节）：重试与缓存策略。
先启动 mock server 真实跑一遍 CLI，在回复中写明 items 长度与第一次的 retries429。`,
    expect: 'client.js + test + README + report.json', dir: D(4), frozen: ['mock_server.py'],
    deliverables: [
      { file: 'client.js', minBytes: 1400 }, { file: 'client.test.js', minBytes: 900 },
      { file: 'README.md', minBytes: 300 },
      { file: 'report.json' },
    ],
    exec: async (dir) => {
      const bad = [];
      const work = tmpDir('t4');
      copyTree(dir, work);
      // ★ v34 run2 缺陷：交付物按任务书会含 .cache/（模型跑过 CLI 的真实产物）。
      //   copyTree 把它一并复制过来，于是核验的「第 1 次」其实带着热缓存 →
      //   pages/retries429/notModified 全按「第 2 次」口径出，误判交付物错误。
      //   核验必须从**冷缓存**开始（任务书语义：从 cursor=0 全新拉取）。
      fs.rmSync(path.join(work, '.cache'), { recursive: true, force: true });
      let srv = null;
      try {
        srv = await startMockServer(work);
        const base = `http://127.0.0.1:${srv.port}`;
        const c1 = cli(work, `node client.js run ${base}`, 90000);
        if (!/rc=0\b/.test(c1)) bad.push(`第 1 次 CLI ${c1.slice(-200)}`);
        const rep1 = fileJson(work, 'report.json');
        const c2 = cli(work, `node client.js run ${base}`, 90000);
        if (!/rc=0\b/.test(c2)) bad.push(`第 2 次 CLI ${c2.slice(-200)}`);
        const rep2 = fileJson(work, 'report.json');
        const wantItems = Array.from({ length: 8 }, (_, i) => i + 1);
        // pages = 本次实际取到 200 的页数（全缓存命中时为 0），故两次口径不同。
        if (!rep1 || !Array.isArray(rep1.items)) bad.push('第 1 次 report 结构不符: ' + JSON.stringify(rep1).slice(0, 160));
        else {
          if (JSON.stringify(rep1.items) !== JSON.stringify(wantItems)) bad.push('第 1 次 items 不符: ' + JSON.stringify(rep1.items));
          if (rep1.pages !== 3) bad.push(`第 1 次 pages=${rep1.pages}（应为 3）`);
          if (rep1.retries429 !== 3) bad.push(`第 1 次 retries429=${rep1.retries429}（应为 3）`);
          if (rep1.notModified !== 0) bad.push(`第 1 次 notModified=${rep1.notModified}（应为 0）`);
        }
        if (!rep2 || !Array.isArray(rep2.items)) bad.push('第 2 次 report 结构不符: ' + JSON.stringify(rep2).slice(0, 160));
        else {
          if (JSON.stringify(rep2.items) !== JSON.stringify(wantItems)) bad.push('第 2 次 items 不符');
          if (rep2.pages !== 0) bad.push(`第 2 次 pages=${rep2.pages}（应全 304 → 0）`);
          if (rep2.notModified !== 3) bad.push(`第 2 次 notModified=${rep2.notModified}（应为 3，缓存未命中）`);
          if (rep2.retries429 !== 0) bad.push(`第 2 次 retries429=${rep2.retries429}（应为 0）`);
        }
        // 服务端计数交叉核对（防客户端自说自话）
        const stats = lastLineJson(execSync(`curl -s -m 10 ${base}/stats?run=default`, { encoding: 'utf8' }).toString());
        if (!stats) bad.push('服务端 /stats 不可读');
        else {
          if (stats.retries429 !== 3) bad.push(`服务端 retries429=${stats.retries429}（应为 3）`);
          if (stats.notModified !== 3) bad.push(`服务端 notModified=${stats.notModified}（应为 3）`);
        }
        const cacheDir = path.join(work, '.cache');
        if (!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0) bad.push('.cache/ 未写入磁盘缓存');
      } finally {
        if (srv && srv.proc) { try { srv.proc.kill('SIGKILL'); } catch { /* ignore */ } }
        cleanup(work);
      }
      const ac = assertCount(path.join(dir, 'client.test.js'), 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'client.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓多页/429重试/304缓存/服务端计数/CLI/单测全一致' };
    },
  },

  // ═══════════════ T5: 密钥扫描器（Python） ═══════════════
  {
    id: 5, name: '密钥扫描器（Python，正则 + 香农熵 + 白名单 + 退出码）', type: '安全',
    prompt: `你是应用安全工程师。在 ${D(5)}/ 交付零依赖 Python（仅标准库）密钥扫描器。
被测目录：\`${D(5)}/scan/\`（含 \`.secretsignore\`，**不要修改**目录内任何文件）。
**必须交付（缺一不可）：scan.py、test_scan.py、README.md、report.json。**
CLI：\`python3 scan.py <root>\`，递归扫描 \`<root>\` 下的文本文件，向 stdout 打印 JSON 数组（每项
\`{"file": 相对 root 的路径(正斜杠), "line": 行号(1 起), "type": 类型}\`），**有命中退出码 1，无命中退出码 0**。
检测类型（同一行可命中多个 type，各输出一条）：
- \`aws_access_key\`：匹配 \`AKIA[0-9A-Z]{16}\`；
- \`private_key\`：行内含 \`-----BEGIN \` 且含 \`PRIVATE KEY-----\`；
- \`high_entropy\`：用正则 \`[A-Za-z0-9_\\-+/=]{32,}\` 找候选串，对**每个候选串**计算**按字符**的香农熵
  （bits/char，\`-Σ p·log2(p)\`），**熵 ≥ ${T5_ENTROPY_MIN}** 即命中（每行最多记一条 high_entropy）。
白名单规则：
- \`.secretsignore\` 每行一条规则，空行与 \`#\` 开头行忽略；
- 以 \`/\` 结尾 = 目录前缀匹配；含 \`**\` = 跨目录通配；含 \`*\` = 单段通配；否则整路径精确匹配；
- 行内出现 \`secret-scan:ignore\` 的行整体跳过。
report.json = 对 \`scan/\` 运行所得的 findings 数组（即 stdout 的 JSON）。
test_scan.py：\`python3 test_scan.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖三类检测、
熵阈值边界、.secretsignore 三种规则、行内忽略、退出码。
README.md（≥300 字节）：检测口径与白名单语义。
注意：**脚本会在另一个你从未见过的目录上被复跑**，不要硬编码路径或结果。
在回复中写明命中条数。`,
    expect: 'scan.py + test + README + report.json', dir: D(5),
    // ★ 冻结路径以真实落盘位置为准：.secretsignore 位于 scan/ 下（prompt 亦如此描述）。
    frozen: ['scan/.secretsignore', ...T5_FILES.map((f) => `scan/${f.rel}`)],
    deliverables: [
      { file: 'scan.py', minBytes: 1200 }, { file: 'test_scan.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 },
      { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const want = normFindings(t5Ref());
      const r1 = pyRun(dir, ['scan.py', 'scan']);
      const got = extractJson(r1.out);
      if (got === null) bad.push('scan 无 JSON 输出: ' + r1.out.slice(-200));
      else if (!sameJson(normFindings(got), want)) bad.push('可见目录 findings 不符: ' + diffNote(normFindings(got), want));
      if (r1.code !== 1) bad.push(`有命中时退出码 ${r1.code}（应为 1）`);
      // 未见目录（泛化）
      const wantB = normFindings(t5HoldoutRef());
      const r2 = pyRun(dir, ['scan.py', HOLDOUT_T5]);
      const gotB = extractJson(r2.out);
      if (gotB === null) bad.push('未见目录无 JSON 输出');
      else if (!sameJson(normFindings(gotB), wantB)) bad.push('未见目录 findings 不符（未泛化）: ' + diffNote(normFindings(gotB), wantB));
      if (r2.code !== 1) bad.push(`未见目录退出码 ${r2.code}（应为 1）`);
      // 干净目录 → 退出码 0
      const clean = tmpDir('t5-clean');
      fs.writeFileSync(path.join(clean, 'a.txt'), 'hello world\nnothing to see\n');
      fs.writeFileSync(path.join(clean, '.secretsignore'), '\n');
      const r3 = pyRun(dir, ['scan.py', clean]);
      cleanup(clean);
      if (r3.code !== 0) bad.push(`干净目录退出码 ${r3.code}（应为 0）`);
      const rep = fileJson(dir, 'report.json');
      if (!sameJson(normFindings(rep), want)) bad.push('report.json 与参考不符');
      const ac = assertCount(path.join(dir, 'test_scan.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_scan.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓三类检测/熵阈值/白名单/未见目录/退出码/单测全一致' };
    },
  },

  // ═══════════════ T6: 账本对账（Python） ═══════════════
  {
    id: 6, name: '账本对账（Python，精确/金额容差/日期容差三级匹配）', type: '财务/数据',
    prompt: `你是财务系统工程师。在 ${D(6)}/ 交付零依赖 Python（仅标准库）银行对账器。
冻结夹具：\`ledger.jsonl\`（内部账，每行 \`{"id","date","ref","amountCents"}\`）、
\`bank.csv\`（银行流水，表头 \`date,description,amount\`）。禁止修改夹具。
**必须交付（缺一不可）：reconcile.py、test_reconcile.py、README.md、report.json。**
reconcile.py 导出 \`reconcile(ledger, bank)\` 并支持 CLI：\`python3 reconcile.py run ledger.jsonl bank.csv\`
（写 \`report.json\`，退出码 0，打印摘要）。
**模块参数契约（钉死）**：\`reconcile(ledger, bank)\` 接收**原始记录**——
\`ledger\` 为 \`[{"id","date","ref","amountCents"}] \`（\`amountCents\` 是 int），
\`bank\` 为 \`[{"date","description","amount"}] \`（\`amount\` 是**文件里的原始字符串**，
如 \`"1,234.56"\`，必须在 reconcile 内部解析成整数分）。
输出（**恰好这些键**）：
\`{"matched": [{"ledgerId","bankIndex","rule"}...], "ledgerOnly": [id...], "bankOnly": [bankIndex...],
"summary": {"ledgerCount","bankCount","matchedCount","ledgerTotalCents","bankTotalCents","matchedTotalCents"}}\`
匹配口径（按 bank 行顺序，每行独立找最佳候选）：
- 金额解析：去掉千分位逗号，允许 1-2 位小数，可带负号，转成整数分（如 \`1,234.56\` → 123456）；
- 候选 = 未被占用、且 \`description\` **包含**该账目 \`ref\` 的账目行；
- 规则（优先级从高到低，同一 bank 行取优先级最高者；同级取 ledger id 字典序最小）：
  1. \`exact\`：日期相同 **且** 金额（分）完全相等；
  2. \`amount_tolerance\`：日期相同 **且** 金额差 ≤ 1 分；
  3. \`date_tolerance\`：金额相等 **且** 日期相差 ≤ 3 天（不同日）；
- 无候选 → 该 bank 行进入 \`bankOnly\`（存 bank 行下标，0 起，不含表头）；
- 未被匹配的账目 → \`ledgerOnly\`（按原顺序）；匹配成功则该账目不可再被占用。
\`matched\` 按 bankIndex 升序。三个 total 为整数分求和（ledgerTotal=全部账目、bankTotal=全部银行行、
matchedTotal=已匹配账目）。
test_reconcile.py：\`python3 test_reconcile.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖
金额解析、三种规则各一例、优先级、同级 tie-break、bankOnly/ledgerOnly、合计自洽。
README.md（≥300 字节）：三级匹配规则与确定性口径。
在回复中写明 matchedCount 与 ledgerOnly。`,
    expect: 'reconcile.py + test + README + report.json', dir: D(6), frozen: ['ledger.jsonl', 'bank.csv'],
    deliverables: [
      { file: 'reconcile.py', minBytes: 1400 }, { file: 'test_reconcile.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 },
      { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['reconcile.py', 'run', 'ledger.jsonl', 'bank.csv']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const ref = t6Ref();
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      const probe = pyProbe(dir, 'reconcile.py', `print(json.dumps(m.reconcile(${JSON.stringify(T6_LEDGER)}, ${JSON.stringify(T6_BANK)}), sort_keys=True, ensure_ascii=False))`);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-200));
      else if (!sameJson(probe.value, ref)) bad.push('模块 reconcile 与参考不符: ' + diffNote(probe.value, ref));
      const ac = assertCount(path.join(dir, 'test_reconcile.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_reconcile.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓三级匹配/优先级/合计/CLI/单测全一致' };
    },
  },

  // ═══════════════ T7: 结构化日志器（Node） ═══════════════
  {
    id: 7, name: '结构化日志器（Node，脱敏 + 确定性采样 + 按大小轮转）', type: '基础设施',
    prompt: `你是平台工程师。在 ${D(7)}/ 交付零依赖 Node（CommonJS）结构化日志器。
**必须交付（缺一不可）：logger.js、logger.test.js、README.md。**
logger.js 用 \`module.exports = { createLogger }\` 导出：
\`createLogger({ dir, maxBytes, maxFiles, sampleEvery, redactKeys, clock })\` 返回
\`{ info(msg, ctx), warn(msg, ctx), error(msg, ctx) }\`。
每条日志 = 一行 JSON + \`\\n\`：\`{"ts": <clock().toISOString()>, "level": <level>, "msg": <msg>, "ctx": <脱敏后的 ctx>}\`
（\`ctx\` 省略时写 \`{}\`；JSON 对象键顺序不限）。
- **脱敏**：\`ctx\` 递归遍历，凡是**键名**（不区分大小写）包含 \`redactKeys\` 中任一子串，其值替换为字符串
  \`[REDACTED]\`（数组内对象同样递归；数组本身保留）。
- **采样**：仅 \`info\` 参与采样——当 \`fnv1a32(msg) % sampleEvery === 0\` 时落盘，否则丢弃；
  \`warn\`/\`error\` **恒落盘**。fnv1a32 口径：\`h=0x811c9dc5\`；对 UTF-8 每个字节 \`h^=b; h=Math.imul(h,0x01000193)>>>0\`。
- **轮转**：写当前文件 \`<dir>/app.log\`；写之前若 \`当前文件字节数 + 本条字节数 > maxBytes\` 且当前文件非空，
  先轮转：删除 \`app.log.{maxFiles-1}\`，\`app.log.i\` → \`app.log.{i+1}\`（i 从 maxFiles-2 递减到 1），
  \`app.log\` → \`app.log.1\`，再新建空 \`app.log\`。总文件数不超过 maxFiles。
- 需要时自动 \`mkdir -p\` \`dir\`。
logger.test.js：\`node --test logger.test.js\` 通过，至少 8 个断言（node:assert，用临时目录），覆盖：
脱敏（含嵌套/数组）、采样确定性（同 msg 结果稳定）、warn/error 恒落盘、轮转文件数上限、
轮转后条目时间顺序不丢、maxBytes 边界、JSON 行可解析、ts 来自注入 clock。
README.md（≥300 字节）：脱敏、采样与轮转规则。
在回复中说明采样比例与最大文件数。`,
    expect: 'logger.js + test + README', dir: D(7), frozen: [],
    deliverables: [
      { file: 'logger.js', minBytes: 1400 }, { file: 'logger.test.js', minBytes: 900 },
      { file: 'README.md', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const out = tmpDir('t7');
      const driverPath = path.join(out, 'driver.js');
      fs.writeFileSync(driverPath, `
const path = require('path');
const { createLogger } = require(${JSON.stringify(path.join(dir, 'logger.js'))});
let t = 0;
const clock = () => new Date(Date.UTC(2024, 0, 1, 0, 0, t++));
const logger = createLogger({
  dir: ${JSON.stringify(out)},
  maxBytes: ${T7_MAX_BYTES},
  maxFiles: ${T7_MAX_FILES},
  sampleEvery: ${T7_SAMPLE_EVERY},
  redactKeys: ${JSON.stringify(T7_REDACT)},
  clock,
});
for (let i = 0; i < 20; i++) logger.info('m' + i, { password: 'p' + i, nested: { apiKey: 'k' + i }, tags: [{ secret: 's' }] });
logger.warn('w1', { note: 'keep' });
logger.error('e1', { token: 'visible', password: 'hide' });
logger.warn('w2', {});
logger.error('e2', {});
console.log('DONE');
`, 'utf8');
      const run = runNodeDriver(out, fs.readFileSync(driverPath, 'utf8'));
      fs.rmSync(driverPath, { force: true });
      if (!run.ok || !/DONE/.test(run.out)) bad.push('驱动执行失败: ' + run.out.slice(-220));
      const files = fs.readdirSync(out).filter((f) => /^app\.log(\.\d+)?$/.test(f));
      if (!files.length) bad.push('未生成 app.log');
      if (files.length > T7_MAX_FILES) bad.push(`日志文件数 ${files.length} > maxFiles=${T7_MAX_FILES}`);
      const ordered = [...files].sort((a, b) => {
        const n = (f) => (f === 'app.log' ? 0 : -Number(f.split('.')[2]));
        return n(a) - n(b); // 最旧在前：app.log.{maxFiles-1} ... app.log
      });
      const entries = [];
      let parseErr = 0;
      for (const f of ordered) {
        const p = path.join(out, f);
        const size = fs.statSync(p).size;
        if (size > T7_MAX_BYTES) bad.push(`${f} 体积 ${size} > maxBytes=${T7_MAX_BYTES}`);
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { entries.push(JSON.parse(line)); } catch { parseErr++; }
        }
      }
      if (parseErr) bad.push(`${parseErr} 行不是合法 JSON`);
      const wantInfo = Array.from({ length: 20 }, (_, i) => `m${i}`).filter((m) => t7Sampled(m));
      const gotInfo = entries.filter((e) => e.level === 'info').map((e) => e.msg);
      if (JSON.stringify(gotInfo) !== JSON.stringify(wantInfo)) {
        bad.push(`采样结果不符: got ${gotInfo.length} 条 want ${wantInfo.length} 条`);
      }
      const nonInfo = entries.filter((e) => e.level !== 'info').map((e) => e.level + ':' + e.msg);
      if (JSON.stringify(nonInfo) !== JSON.stringify(['warn:w1', 'error:e1', 'warn:w2', 'error:e2'])) {
        bad.push('warn/error 序列不符: ' + JSON.stringify(nonInfo));
      }
      // 脱敏：info 条目里不应出现明文 p*/k*/s*；应出现 [REDACTED]
      const leaks = [];
      for (const e of entries) {
        const s = JSON.stringify(e.ctx);
        if (/"(p\d+|k\d+|s\d+)"/.test(s)) leaks.push(e.msg);
      }
      if (leaks.length) bad.push('脱敏泄漏: ' + leaks.slice(0, 3).join(','));
      if (!entries.some((e) => JSON.stringify(e.ctx).includes('[REDACTED]'))) bad.push('未见 [REDACTED] 标记');
      const e1 = entries.find((e) => e.msg === 'e1');
      if (!e1 || e1.ctx.token !== 'visible' || e1.ctx.password !== '[REDACTED]') bad.push('e1 脱敏语义错误: ' + JSON.stringify(e1 && e1.ctx));
      // 时间顺序
      const tsSeq = entries.map((e) => Date.parse(e.ts));
      if (tsSeq.some((v, i) => i > 0 && v < tsSeq[i - 1])) bad.push('轮转后条目时间顺序错乱');
      // 总条数
      if (entries.length !== wantInfo.length + 4) bad.push(`总条数 ${entries.length} != ${wantInfo.length + 4}`);
      cleanup(out);
      const ac = assertCount(path.join(dir, 'logger.test.js'), 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'logger.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓脱敏/采样/轮转/顺序/体积/单测全一致' };
    },
  },

  // ═══════════════ T8: 队列 worker（Python） ═══════════════
  {
    id: 8, name: '队列 worker（Python，幂等 + 断点续跑 + 原子状态）', type: '可靠性',
    prompt: `你是后端工程师。在 ${D(8)}/ 交付零依赖 Python（仅标准库）幂等队列 worker。
冻结夹具：\`jobs.jsonl\`（每行 \`{"id","value","failTimes"}\`）。禁止修改夹具。
**必须交付（缺一不可）：worker.py、test_worker.py、README.md、report.json、state.json。**
CLI：\`python3 worker.py run jobs.jsonl state.json report.json\`，按输入顺序处理每个 job：
- 每个 job 最多尝试 **3** 次；第 k 次尝试（1 起）当 \`k <= failTimes\` 视为失败，否则成功（确定性模拟）；
- 成功 → 记录 \`status: "ok"\` 且把 \`value\` 累加进 \`sum\`；3 次全失败 → \`status: "failed"\`（不计入 sum）；
- **幂等**：state.json 里已完成的 job 不再处理（attempts 不变）；重复运行结果完全一致；
- **断点续跑**：state.json 已存在则在其基础上继续；**原子写**：先写 \`state.json.tmp\` 再 \`os.replace\`
  （结束后不得残留 \`.tmp\` 文件）。
state.json（**恰好这些键**）：
\`{"done": {jobId: {"status": "ok"|"failed", "attempts": int, "value": <value 或 null>}}, "sum": int, "processed": int}\`
（failed 的 value 记 null；processed = done 中条目数）。
report.json（**恰好这些键**）：\`{"ok": int, "failed": int, "sum": int, "processed": int}\`。
test_worker.py：\`python3 test_worker.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖
重试成功、三次失败、sum 只累加成功、幂等重跑、断点续跑跳过已完成、原子写无 .tmp 残留、report 自洽。
README.md（≥300 字节）：幂等、续跑与原子状态写。
在回复中写明 ok/failed/sum 三个数。`,
    expect: 'worker.py + test + README + report.json + state.json', dir: D(8), frozen: ['jobs.jsonl'],
    deliverables: [
      { file: 'worker.py', minBytes: 1200 }, { file: 'test_worker.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 },
      { file: 'report.json' }, { file: 'state.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const wantDone = {
        j1: { status: 'ok', attempts: 1, value: 1 },
        j2: { status: 'ok', attempts: 2, value: 2 },
        j3: { status: 'ok', attempts: 3, value: 3 },
        j4: { status: 'ok', attempts: 1, value: 4 },
        j5: { status: 'failed', attempts: 3, value: null },
        j6: { status: 'ok', attempts: 2, value: 6 },
      };
      const wantState = { done: wantDone, sum: 16, processed: 6 };
      const wantReport = { ok: 5, failed: 1, sum: 16, processed: 6 };
      const w1 = tmpDir('t8a');
      copyTree(path.join(dir, 'jobs.jsonl'), path.join(w1, 'jobs.jsonl'));
      copyTree(path.join(dir, 'worker.py'), path.join(w1, 'worker.py'));
      const c1 = pyRun(w1, ['worker.py', 'run', 'jobs.jsonl', 'state.json', 'report.json']);
      if (c1.code !== 0) bad.push(`第 1 次 rc=${c1.code} ${c1.out.slice(-160)}`);
      const st1 = fileJson(w1, 'state.json');
      if (!st1) bad.push('state.json 缺失/非 JSON');
      else if (!sameJson(st1, wantState)) bad.push('state.json 与参考不符: ' + diffNote(st1, wantState));
      const rp1 = fileJson(w1, 'report.json');
      if (!sameJson(rp1, wantReport)) bad.push('report.json 与参考不符: ' + diffNote(rp1, wantReport));
      // 幂等重跑
      const c2 = pyRun(w1, ['worker.py', 'run', 'jobs.jsonl', 'state.json', 'report.json']);
      const st2 = fileJson(w1, 'state.json');
      if (c2.code !== 0) bad.push(`第 2 次 rc=${c2.code}`);
      else if (!sameJson(st2, wantState)) bad.push('幂等重跑后 state 变化: ' + diffNote(st2, wantState));
      const leftovers = fs.readdirSync(w1).filter((f) => f.endsWith('.tmp'));
      if (leftovers.length) bad.push('残留 .tmp 文件: ' + leftovers.join(','));
      // 断点续跑：预置 j1 已完成
      const w2 = tmpDir('t8b');
      copyTree(path.join(dir, 'jobs.jsonl'), path.join(w2, 'jobs.jsonl'));
      copyTree(path.join(dir, 'worker.py'), path.join(w2, 'worker.py'));
      fs.writeFileSync(path.join(w2, 'state.json'), JSON.stringify({ done: { j1: wantDone.j1 }, sum: 1, processed: 1 }), 'utf8');
      const c3 = pyRun(w2, ['worker.py', 'run', 'jobs.jsonl', 'state.json', 'report.json']);
      const st3 = fileJson(w2, 'state.json');
      if (c3.code !== 0) bad.push(`续跑 rc=${c3.code} ${c3.out.slice(-160)}`);
      else if (!sameJson(st3, wantState)) bad.push('断点续跑结果不符: ' + diffNote(st3, wantState));
      cleanup(w1, w2);
      const ac = assertCount(path.join(dir, 'test_worker.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_worker.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓重试/失败/sum/幂等/续跑/原子写/单测全一致' };
    },
  },

  // ═══════════════ T9: 覆盖率门禁（Python） ═══════════════
  {
    id: 9, name: '覆盖率门禁（Python，JUnit XML + 覆盖率 JSON → 门禁与 Markdown）', type: 'CI/CD',
    prompt: `你是 DevOps 工程师。在 ${D(9)}/ 交付零依赖 Python（仅标准库）CI 质量门禁工具。
冻结夹具：\`junit/\`（多个 JUnit XML）、\`coverage/\`（多个覆盖率 JSON，形如 \`{"files": {"路径": {"coveredLines","totalLines"}}}\`）、
\`thresholds.json\`（\`{minLineCoverage, maxFailures}\`）。禁止修改夹具。
**必须交付（缺一不可）：gate.py、test_gate.py、README.md、report.json、gate.md。**
CLI：\`python3 gate.py junit/ coverage/ thresholds.json\`：
- 解析 \`junit/\` 下**所有** \`*.xml\`，累加每个 \`<testsuite>\` 的 \`tests/failures/errors/skipped\` 属性；
- 解析 \`coverage/\` 下**所有** \`*.json\`，按文件路径**第一段**（\`/\` 之前）归并模块，累加 coveredLines/totalLines；
- 覆盖率百分比 = \`round(covered/total*100, 2)\`（total 为 0 时记 0）；总计与每模块都要算；
- 门禁：\`lineCoverage < minLineCoverage\` → 违规 \`line_coverage_below_min\`；
  \`failures + errors > maxFailures\` → 违规 \`too_many_failures\`；\`violations\` 按字典序排序；
- 写 \`report.json\`（**恰好这些键**）：
  \`{"totals": {"tests","failures","errors","skipped","coveredLines","totalLines","lineCoverage"},
    "modules": {mod: {"coveredLines","totalLines","lineCoverage"}}, "passed": bool, "violations": [str...]}\`
- 写 \`gate.md\`：Markdown 表格（表头 \`| Module | Covered | Total | Coverage |\`，每个模块一行），
  末尾给出总体覆盖率与 \`Result: PASS\` 或 \`Result: FAIL\`；
- **退出码**：通过 0，不通过 2。
test_gate.py：\`python3 test_gate.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖 XML 累加、
模块归并、百分比四舍五入、两类违规、排序、通过/不通过判定。
README.md（≥300 字节）：门禁口径与退出码约定。
在回复中写明总体覆盖率与是否通过。`,
    expect: 'gate.py + test + README + report.json + gate.md', dir: D(9),
    frozen: [...T9_JUNIT.map((s) => `junit/${s.file}`), ...T9_COVERAGE.map((c) => `coverage/${c.file}`), 'thresholds.json'],
    deliverables: [
      { file: 'gate.py', minBytes: 1400 }, { file: 'test_gate.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 },
      { file: 'gate.md', minBytes: 150 },
      { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['gate.py', 'junit', 'coverage', 'thresholds.json']);
      const ref = t9Ref();
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      if (c1.code !== 2) bad.push(`不通过时退出码 ${c1.code}（应为 2）`);
      const md = readFileSafe(path.join(dir, 'gate.md'));
      if (!md) bad.push('gate.md 缺失');
      else {
        if (!/\|\s*Module\s*\|\s*Covered\s*\|\s*Total\s*\|\s*Coverage\s*\|/.test(md)) bad.push('gate.md 缺表头');
        if (!/\bcore\b/.test(md) || !/\bapi\b/.test(md)) bad.push('gate.md 缺模块行');
        if (!/67\.5/.test(md)) bad.push('gate.md 缺总体覆盖率 67.5');
        if (!/Result:\s*FAIL/.test(md)) bad.push('gate.md 缺 Result: FAIL');
      }
      // 通过场景：放宽阈值 → 退出码 0
      const w = tmpDir('t9');
      copyTree(path.join(dir, 'junit'), path.join(w, 'junit'));
      copyTree(path.join(dir, 'coverage'), path.join(w, 'coverage'));
      fs.writeFileSync(path.join(w, 'thresholds.json'), JSON.stringify({ minLineCoverage: 50, maxFailures: 5 }), 'utf8');
      const c2 = execSync(`timeout 60 python3 ${JSON.stringify(path.join(dir, 'gate.py'))} junit coverage thresholds.json 2>&1; echo rc=$?`, { cwd: w, encoding: 'utf8' }).toString();
      if (!/rc=0\b/.test(c2)) bad.push(`放宽阈值后退出码非 0: ${c2.slice(-160)}`);
      cleanup(w);
      const ac = assertCount(path.join(dir, 'test_gate.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_gate.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓XML累加/模块归并/门禁/退出码/gate.md/单测全一致' };
    },
  },

  // ═══════════════ T10: 增量构建（Python） ═══════════════
  {
    id: 10, name: '增量构建（Python，内容哈希 + DAG + manifest + --check）', type: '构建系统',
    prompt: `你是构建系统工程师。在 ${D(10)}/ 交付零依赖 Python（仅标准库）增量构建工具。
冻结夹具：\`build.json\`（\`{"targets": {name: {"inputs": [路径...], "cmd": 命令, "output": 路径}}}\`）、
\`src/\` 源文件、\`cycle.json\`（循环依赖样例）。禁止修改夹具。
**必须交付（缺一不可）：build.py、test_build.py、README.md、report.json。**
build.py 支持两个子命令（都在当前目录执行，\`cmd\` 用 shell 执行）：
- \`python3 build.py build build.json\`：
  - 依赖关系 = 某 target 的 input 恰好是另一 target 的 output；按拓扑序构建，**同级按 target 名字典序**；
  - 判断是否需要重建：output 不存在，或 manifest 中该 target 的「输入内容哈希 + cmd」与当前不一致 → 重建；
    否则跳过；
  - 构建 = 执行 cmd；成功后把该 target 的哈希写进 \`manifest.json\`（\`{"target": {"hash": <64hex>, "output": <path>}}\`）；
  - 写 \`report.json\`（**恰好这些键**）：\`{"built": [按构建顺序的 name...], "skipped": [name...], "order": [完整拓扑序...]}\`；
  - 存在循环依赖 → 打印错误（stderr 含 \`cycle\`）并以非 0 退出码结束。
- \`python3 build.py check build.json\`：不执行构建，若全部最新 → 退出码 0；有任一需重建 → 退出码 1。
test_build.py：\`python3 test_build.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名，用临时目录自造小型 build 配置），
覆盖：拓扑序、同级字典序、全量构建、二次增量跳过、改输入只重建下游、check 退出码、循环检测。
README.md（≥300 字节）：哈希口径、DAG 拓扑与增量判定。
先真实跑一遍 build 与 check，在回复中写明首次 built 的顺序。`,
    expect: 'build.py + test + README + report.json', dir: D(10),
    frozen: ['build.json', 'cycle.json', 'src/a.txt', 'src/b.txt', 'src/c.txt'],
    deliverables: [
      { file: 'build.py', minBytes: 1400 }, { file: 'test_build.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 },
      { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const w = tmpDir('t10');
      fs.mkdirSync(path.join(w, 'src'), { recursive: true });
      copyTree(path.join(dir, 'build.py'), path.join(w, 'build.py'));
      copyTree(path.join(dir, 'build.json'), path.join(w, 'build.json'));
      copyTree(path.join(dir, 'cycle.json'), path.join(w, 'cycle.json'));
      for (const f of ['a.txt', 'b.txt', 'c.txt']) copyTree(path.join(dir, 'src', f), path.join(w, 'src', f));
      const run = (args) => execSync(`timeout 60 python3 build.py ${args} 2>&1; echo rc=$?`, { cwd: w, encoding: 'utf8' }).toString();
      // 1) 全量
      const r1 = run('build build.json');
      if (!/rc=0\b/.test(r1)) bad.push('首次 build 失败: ' + r1.slice(-200));
      const rep1 = fileJson(w, 'report.json');
      if (!rep1) bad.push('report.json 缺失');
      else {
        if (JSON.stringify(rep1.built) !== JSON.stringify(['a', 'b', 'c'])) bad.push('首次 built 顺序不符: ' + JSON.stringify(rep1.built));
        if (JSON.stringify(rep1.order) !== JSON.stringify(['a', 'b', 'c'])) bad.push('order 不符: ' + JSON.stringify(rep1.order));
      }
      const outC = readFileSafe(path.join(w, 'out', 'c.txt'));
      if (outC !== 'alpha\nbravo\n') bad.push('out/c.txt 内容不符: ' + JSON.stringify(outC));
      // 2) 增量：应全跳过
      const r2 = run('build build.json');
      if (!/rc=0\b/.test(r2)) bad.push('二次 build 失败');
      const rep2 = fileJson(w, 'report.json');
      if (JSON.stringify(rep2 && rep2.built) !== '[]') bad.push('二次 build 应无重建: ' + JSON.stringify(rep2 && rep2.built));
      // 3) check 最新 → 0
      const c1 = run('check build.json');
      if (!/rc=0\b/.test(c1)) bad.push('check 最新时退出码非 0: ' + c1.slice(-120));
      // 4) 改源 → 只重建下游 b,c
      fs.writeFileSync(path.join(w, 'src', 'b.txt'), 'bravo2\n', 'utf8');
      const c2 = run('check build.json');
      if (!/rc=1\b/.test(c2)) bad.push('check 过期时退出码非 1: ' + c2.slice(-120));
      const r3 = run('build build.json');
      const rep3 = fileJson(w, 'report.json');
      if (JSON.stringify(rep3 && rep3.built) !== JSON.stringify(['b', 'c'])) bad.push('改源后应只重建 b,c: ' + JSON.stringify(rep3 && rep3.built));
      if (readFileSafe(path.join(w, 'out', 'c.txt')) !== 'alpha\nbravo2\n') bad.push('重建后 out/c.txt 不符');
      // 5) 循环 → 非 0 + cycle
      const rc = run('build cycle.json');
      if (/rc=0\b/.test(rc)) bad.push('循环依赖应非 0 退出');
      if (!/cycle/i.test(rc)) bad.push('循环依赖错误信息缺 cycle: ' + rc.slice(-120));
      cleanup(w);
      const ac = assertCount(path.join(dir, 'test_build.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_build.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓拓扑序/增量/check/循环/产物/单测全一致' };
    },
  },
];
