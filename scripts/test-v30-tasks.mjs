/**
 * EvoClaw v30 压测任务定义（6 任务）与核验器。
 * 核验纪律：harness 自带参考实现复算（test-v30-lib.mjs），不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runPy, runProbe, readFileSafe } from './v14/lib.mjs';
import {
  D, sameJson, pyPath, pyReadTextLiteral,
  T1_DB, T1_CASES, t1Ref, T2_SCENARIOS, t2Ref, T3_CASES, t3Ref,
  T4_SEEDS, T4_OPS, t4Replay, T5_MACHINE, T5_EVENTS, t5Ref, t6Ref, t6Encode,
} from './test-v30-lib.mjs';

const ASSERT_LINE_RE = /\bassert\b|\b(?:expect|check|verify|should|ensure|confirm)\w*\s*\(|\bok\s*\(/;
const ASSERT_SKIP_LINE_RE = /^\s*(?:import\b|(?:const|let|var)\b.*\brequire\s*\()/;
function assertCount(dir, file, min) {
  const t = readFileSafe(path.join(dir, file));
  let n = 0;
  for (const line of t.split(/\r?\n/)) {
    if (ASSERT_SKIP_LINE_RE.test(line)) continue;
    if (ASSERT_LINE_RE.test(line)) n++;
  }
  return n >= min ? null : `${file} 断言数 ${n}<${min}`;
}
function cli(dir, cmd) {
  try {
    return execSync(`timeout 30 bash -c ${JSON.stringify(cmd)} 2>&1; echo "rc=$?"`, { cwd: dir, timeout: 40000, encoding: 'utf8' }).toString().trim();
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
function fileExistsJson(dir, file) { return extractJson(readFileSafe(path.join(dir, file))); }

const R1 = t1Ref();
const R2 = t2Ref();
const R3 = t3Ref();
const R4 = t4Replay();
const R5 = t5Ref();
const R6 = t6Ref();

export const pyRun = (dir, args, timeoutMs = 90000) => {
  try {
    const out = execSync(`timeout 80 python3 ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
};

export const tasks = [
  // ═══════════════ T1: mini SQL 引擎（Python） ═══════════════
  {
    id: 1, name: 'mini SQL 查询引擎（Python，连接/聚合/排序）', type: '查询引擎',
    prompt: `你是查询引擎工程师。在 ${D(1)}/ 交付零依赖 Python（仅标准库）mini SQL 引擎。
冻结夹具：\`cases.json\`（\`{db: {表名: {cols, rows}}, cases: [{name, sql}]}\`）。禁止修改夹具。
**必须交付（缺一不可）：sqleng.py、test_sqleng.py、README.md、report.json。**
sqleng.py 导出 \`{ exec_sql }\`：exec_sql(db, sql) -> list[dict]，支持子集（口径必须全部实现）：
- SELECT 列：\`表.列\` 或 聚合 COUNT/SUM/AVG/MIN/MAX(表.列 | *)，可带 \`AS 别名\`；
- FROM：\`T1 [AS] A1\` 加 0..n 个 \`INNER JOIN T [AS] A ON cond\` / \`LEFT JOIN ... ON cond\`；
- WHERE 仅支持：列比较（= != < <= > >=）、LIKE（'%'→任意、'_'→单字符，大小写敏感）、AND、括号；无 OR/NOT/IN；
- GROUP BY：表达式可多个；聚合对**组内行**求值；AVG 空组/全 NULL 为 null，SUM 空组为 0，COUNT(*) 计行数；
- ORDER BY：键可多列，各自可带 ASC/DESC（缺省 ASC）；**NULL 恒最小**；数字比数值、其余按 String 码点序；全等保持原序；
- LIMIT n / OFFSET m（先跳过 m 行再取 n 行）；
- 输出行键：有 AS 别名用别名；列引用用原文（如 \`o.id\`）；无别名聚合写作 \`FUNC(参数)\`（如 \`COUNT(*)\`）；
- 裸列引用（无表前缀）按 FROM 顺序在**首个**含该列的表行中解析，找不到为 null。
LEFT JOIN 未匹配时右表各列输出 null（不影响其他列与聚合）。
CLI：\`python3 sqleng.py run cases.json\` 写当前目录 \`report.json\` = \`{"results": {name: [行...]}}\`（键序与夹具 cases 一致），退出码 0，打印摘要。
test_sqleng.py：\`python3 test_sqleng.py\` 退出码 0，至少 8 个断言，覆盖内连接、左连接 null、WHERE+LIKE、聚合+组内 AVG、多列 ORDER 含 DESC、LIMIT/OFFSET。
README.md（≥300 字节）：支持范围与语义口径（NULL 排序/AVG 空组/输出键规则）。
必须真实运行 CLI，并在回复中写明 g1 用例的 total 与 avg 值。`,
    expect: 'sqleng.py + test + README + report.json', dir: D(1), frozen: ['cases.json'],
    deliverables: [
      { file: 'sqleng.py', minBytes: 2500 }, { file: 'test_sqleng.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 800 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['sqleng.py', 'run', 'cases.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results || rep, R1)) bad.push('report 结果与参考不符: ' + JSON.stringify(rep).slice(0, 200));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import sqleng as m
cases = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = {}
for c in cases['cases']:
    out[c['name']] = m.exec_sql(cases['db'], c['sql'])
print(json.dumps(out, sort_keys=True))
`, [dir + '/cases.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R1)) bad.push('模块 exec_sql 与参考不符');
      const ac = assertCount(dir, 'test_sqleng.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_sqleng.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓内连接/左连接/WHERE+LIKE/聚合/多列ORDER/LIMIT-OFFSET/CLI/单测全一致' };
    },
  },

  // ═══════════════ T2: WAL 键值存储（Python） ═══════════════
  {
    id: 2, name: 'WAL 键值存储与 checkpoint 恢复（Python）', type: '存储引擎',
    prompt: `你是存储引擎工程师。在 ${D(2)}/ 交付零依赖 Python（仅标准库）WAL 键值存储恢复器。
冻结夹具：\`wal.json\`（数组，元素 \`{name, fromLsn, wal}\`；wal 条目 \`{lsn, op, key?, value?, snapshot?}\`，op 为 put/del/ckpt）。禁止修改夹具。
**必须交付（缺一不可）：walstore.py、test_walstore.py、README.md、report.json。**
walstore.py 导出 \`{ recover }\`：recover(wal, from_lsn) -> dict，语义（必须逐条对上）：
- put：写入/覆盖 key；del：删除 key（不存在则忽略）；ckpt：以该条 \`snapshot\` 整体替换当前状态；
- recover 只取 \`lsn >= from_lsn\` 的条目参与：取其中**最后一个** ckpt（若无则空状态）为基底，
  重放其后（lsn 严格大于该 ckpt.lsn）的 put/del，按 lsn 升序。
返回恰好：\`{"state": 状态dict, "ckpt_lsn": 最后采用的 ckpt 的 lsn（无则 None）, "replayed": 参与重放的 put/del 条目数, "total": lsn>=from_lsn 的条目总数}\`。
CLI：\`python3 walstore.py run wal.json\` 写当前目录 \`report.json\` = \`{"results": [{name, state, ckpt_lsn, replayed, total}]}\`（顺序与夹具一致，state 键按字典序），退出码 0，打印摘要。
test_walstore.py：\`python3 test_walstore.py\` 退出码 0，至少 8 个断言，覆盖多 ckpt 取最后、from_lsn 跳过早期 ckpt（ckpt_lsn 为 None）、del 幂等、空 WAL。
README.md（≥300 字节）：恢复语义（ckpt 基底 + 重放窗口）与边界。
必须真实运行 CLI，并在回复中写明 sc1 的 state 与 ckpt_lsn。`,
    expect: 'walstore.py + test + README + report.json', dir: D(2), frozen: ['wal.json'],
    deliverables: [
      { file: 'walstore.py', minBytes: 1200 }, { file: 'test_walstore.py', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 400 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['walstore.py', 'run', 'wal.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results || rep, R2)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 200));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import walstore as m
scs = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = []
for s in scs:
    r = m.recover(s['wal'], s['fromLsn'])
    r['name'] = s['name']
    out.append(r)
print(json.dumps(out, sort_keys=True))
`, [dir + '/wal.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R2)) bad.push('模块 recover 与参考不符');
      const ac = assertCount(dir, 'test_walstore.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_walstore.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓ckpt基底/重放窗口/from_lsn边界/del幂等/CLI/单测全一致' };
    },
  },

  // ═══════════════ T3: CJK 混排两端对齐（Python） ═══════════════
  {
    id: 3, name: 'CJK 混排文本两端对齐（Python，EAW 宽度+空格分配）', type: '排版算法',
    prompt: `你是终端排版工程师。在 ${D(3)}/ 交付零依赖 Python（仅标准库）CJK 混排两端对齐器。
冻结夹具：\`cases.json\`（数组 \`[{text, limit}]\`）。禁止修改夹具。
**必须交付（缺一不可）：align.py、test_align.py、README.md、report.json。**
align.py 导出 \`{ char_width, justify }\`，语义（必须逐条对上）：
- char_width(ch)：码点位于这些区间记 2（全角/汉字），其余记 1：
  0x1100-0x115F、0x2E80-0x303E、0x3041-0x33FF、0x3400-0x4DBF、0x4E00-0x9FFF、
  0xA000-0xA4CF、0xAC00-0xD7A3、0xF900-0xFAFF、0xFE30-0xFE4F、0xFF00-0xFF60、0xFFE0-0xFFE6；
- justify(text, limit) -> {"lines": [...], "lastWidth": n}：
  1) 行切：按字符（code point）从左到右贪婪填充，单行宽度（各字符 char_width 之和）不得超过 limit；放不下即换行；空文本 lines 为 [] 且 lastWidth 为 0；
  2) 空格分配**仅对最后一行以外的行**：slack = limit − 行内容宽度；
     - 先在各「宽度 2 的字」**前方**的字间间隙（从左到右；行首不算间隙；间隙即前一个字符与它之间）各补至多 1 空格；
     - 仍有剩余：按原序（跳过已用间隙）在每个宽度 1 的字前方间隙补 1；
     - 仍有多余：追加到行尾（尾随空格）；
  3) 最后一行：内容原样输出，不加任何空格；
  4) lastWidth = 末行内容宽度（未加空格）。
CLI：\`python3 align.py run cases.json\` 写当前目录 \`report.json\` = \`{"results": [{"i": 下标, "lines", "lastWidth"}]}\`（顺序与夹具一致），退出码 0，打印摘要。
test_align.py：\`python3 test_align.py\` 退出码 0，至少 8 个断言，覆盖：纯 CJK 恰满/补中间隙/行尾补白、混合行、最后一行不补、空文本、limit 大于全宽。
README.md（≥300 字节）：宽度区间表与空格分配三步规则。
必须真实运行 CLI，并在回复中写明 limit=9 与 limit=7 两条用例的输出行。`,
    expect: 'align.py + test + README + report.json', dir: D(3), frozen: ['cases.json'],
    deliverables: [
      { file: 'align.py', minBytes: 1200 }, { file: 'test_align.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['align.py', 'run', 'cases.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results || rep, R3)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import align as m
cases = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = []
for i, c in enumerate(cases):
    out.append({'i': i, **m.justify(c['text'], c['limit'])})
print(json.dumps(out, sort_keys=True))
`, [dir + '/cases.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R3)) bad.push('模块 justify 与参考不符');
      const ac = assertCount(dir, 'test_align.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_align.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓宽度/行切/CJK间隙/非CJK间隙/行尾补白/末行原样/CLI/单测全一致' };
    },
  },

  // ═══════════════ T4: JSON 操作重放（Node） ═══════════════
  {
    id: 4, name: 'JSON 操作重放：merge-patch + JSON Patch（Node）', type: '序列化/补丁',
    prompt: `你是同步系统工程师。在 ${D(4)}/ 交付零依赖 Node（CommonJS）JSON 操作重放器。
冻结夹具：\`ops.json\`（\`{seeds: [{doc}], ops: [{name, seed, op}]}\`；op 形如 \`{seq, kind: "merge-patch"|"json-patch", path?, value}\`）。禁止修改夹具。
**必须交付（缺一不可）：jsonops.js、jsonops.test.js、README.md、report.json。**
jsonops.js 用 \`module.exports = { mergePatch, jsonPatch, replay }\` 导出：
1）\`mergePatch(target, patch)\`（RFC 7386）：对象递归合并；null 值删除目标键；非对象 patch 整体替换；数组/标量不做合并。
2）\`jsonPatch(doc, ops)\`（RFC 6902 子集：add/remove/replace）：path 为 JSON Pointer（~0→~ ~1→/）；
   - replace：目标键/数组下标赋值；add：对象键已存在则替换、数组下标插入、\`-\` 追加末尾；remove：对象删键、数组按下标 splice 移除一项；
   - 本夹具不出现 move/copy/test，遇到直接 throw Error("unsupported op")。
3）\`replay({seeds, ops}) -> {states: [s0..sn]}\`：states[0] 为 seeds[0].doc 的深拷贝；第 i 项 = 依序应用**第 i 个**
   ops[i-1] 后的**完整文档状态**（每个操作作用于上一状态的深拷贝，互不影响）；json-patch 操作的 value 就是
   单个 RFC6902 操作对象。merge-patch 的 value 直接作为 patch 应用于上一状态（path 字段忽略）。
CLI：\`node jsonops.js run ops.json\` 写当前目录 \`report.json\` = \`{"states": [...]}\`，退出码 0，打印摘要。
jsonops.test.js：\`node --test jsonops.test.js\` 通过，至少 8 个断言（node:assert），覆盖：递归合并、null 删键、
数组 '-' 追加、remove 数组项下标偏移、replace 深层路径、深拷贝隔离（states 之间无共享引用）。
README.md（≥300 字节）：两种 patch 的语义差异与重放口径。
必须真实运行 CLI，并在回复中写明 states[4] 的 JSON 内容。`,
    expect: 'jsonops.js + test + README + report.json', dir: D(4), frozen: ['ops.json'],
    deliverables: [
      { file: 'jsonops.js', minBytes: 1600 }, { file: 'jsonops.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node jsonops.js run ops.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.states, R4.states)) bad.push('report.states 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runProbe(dir, 'jsonops.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'ops.json'), 'utf8'));
return m.replay(doc);
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value.states, R4.states)) bad.push('模块 replay 与参考不符');
      const ac = assertCount(dir, 'jsonops.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'jsonops.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓递归合并/null删键/数组追加/下标偏移/深拷贝隔离/CLI/单测全一致' };
    },
  },

  // ═══════════════ T5: 确定性事件状态机（Node） ═══════════════
  {
    id: 5, name: '确定性事件状态机 + 快照续跑（Node）', type: '并发模型',
    prompt: `你是分布式系统工程师。在 ${D(5)}/ 交付零依赖 Node（CommonJS）确定性事件状态机。
冻结夹具：\`machines.json\`（\`{machine, events, snapshotIndex, resumeFrom}\`；machine 形如
\`{initial, states:[{id, accepting}], transitions:[{from, event, to}]}\`，events 形如 \`[{name, data}]\`）。禁止修改夹具。
**必须交付（缺一不可）：fsm.js、fsm.test.js、README.md、report.json。**
fsm.js 用 \`module.exports = { run, resume }\` 导出，\`run(machine, events)\` 与 \`resume(machine, snapshot, tailEvents)\`
返回同构结果 \`{accepted, finalState, snapshots}\`，语义（必须逐条对上）：
- 逐事件处理：在当前 state 的出边中按 transitions **定义顺序**找第一条 event 名匹配者并跳转；无匹配则忽略（state 不变，**不记 accepted**）；
- 仅当本次事件**触发了跳转且落入 accepting 态**时，记 accepted.push({i, state, event: 事件name, data})；
  每处理完事件 i（下标）必记 snapshots.push({state, i})；
- resume：以 snapshot.state 作为初始状态，处理 tailEvents（下标重排为 0 起），accepted/snapshots 只含 tail 段；
  结果须与「全量运行取同一续跑点」在 accepted/finalState 上逐字段一致（全量快照 snapshots 除外）。
CLI：\`node fsm.js run machines.json\` 写当前目录 \`report.json\` =
\`{"full": {accepted, finalState, snapshots}, "resumed": {accepted, finalState, snapshots}}\`，
其中 full 为全事件流运行、resumed 为从第 snapshotIndex 个快照 state 起处理 events.slice(resumeFrom) 的运行；退出码 0，打印摘要。
fsm.test.js：\`node --test fsm.test.js\` 通过，至少 8 个断言（node:assert），覆盖：事件无出边忽略、按定义顺序首匹配、
accepting 态事件记录含 data、resume 与全量等价（accepted/finalState）、空事件流。
README.md（≥300 字节）：确定性口径（出边顺序/忽略规则/续跑等价性证明思路）。
必须真实运行 CLI，并在回复中写明 full.accepted 的下标集合与 resumed.finalState。`,
    expect: 'fsm.js + test + README + report.json', dir: D(5), frozen: ['machines.json'],
    deliverables: [
      { file: 'fsm.js', minBytes: 1200 }, { file: 'fsm.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 500 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node fsm.js run machines.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else {
        if (!sameJson(rep.full.accepted, R5.full.accepted)) bad.push('full.accepted 不符: ' + JSON.stringify(rep.full?.accepted).slice(0, 200));
        if (rep.full.finalState !== R5.full.finalState) bad.push(`full.finalState ${rep.full?.finalState}≠${R5.full.finalState}`);
        if (!sameJson(rep.full.snapshots, R5.full.snapshots)) bad.push('full.snapshots 不符');
        if (!sameJson(rep.resumed.accepted, R5.tail.accepted)) bad.push('resumed.accepted 不符: ' + JSON.stringify(rep.resumed?.accepted).slice(0, 200));
        if (rep.resumed.finalState !== R5.tail.finalState) bad.push('resumed.finalState 不符');
        if (!sameJson(rep.resumed.snapshots, R5.tail.snapshots)) bad.push('resumed.snapshots 不符（i 须重排为 0 起）');
      }
      const probe = runProbe(dir, 'fsm.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'machines.json'), 'utf8'));
const full = m.run(doc.machine, doc.events);
const snap = full.snapshots[doc.snapshotIndex];
const resumed = m.resume(doc.machine, snap, doc.events.slice(doc.resumeFrom));
return { full, resumed };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.full, R5.full)) bad.push('模块 run 与参考不符');
        if (!sameJson(probe.value.resumed, R5.tail)) bad.push('模块 resume 与参考不符');
      }
      const ac = assertCount(dir, 'fsm.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'fsm.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓出边顺序/忽略规则/accepting记录/快照续跑等价/CLI/单测全一致' };
    },
  },

  // ═══════════════ T6: 二进制帧协议 + CRC16（Node） ═══════════════
  {
    id: 6, name: '二进制协议帧编解码 + CRC16-CCITT（Node）', type: '二进制协议',
    prompt: `你是协议栈工程师。在 ${D(6)}/ 交付零依赖 Node（CommonJS）二进制帧协议编解码器。
冻结夹具：\`frames.json\`（\`{pairs: [[seq, payloadText]...], stream_hex, truncated_hex, zeros11_hex}\`，hex 为十六进制字符串）。禁止修改夹具。
**必须交付（缺一不可）：frames.js、frames.test.js、README.md、report.json。**
帧布局（全部小端，按字节偏移钉死）：magic [0,4)=FE ED A7 11 | version [4,5) | seq [5,7) 小端 |
len [7,11) 小端（payload 字节数）| payload [11, 11+len) | crc [11+len, 13+len) 小端（帧总长 13+len 字节；
非 payload 的固定字节恰 13 个，其中 crc 在**帧尾**，不在 payload 前）。
frames.js 用 \`module.exports = { encode, decodeStream, crc16 }\` 导出：
1）\`crc16(buf) -> number\`：CRC16-CCITT-FALSE（poly 0x1021，init 0xFFFF，无反射，无异或输出）。
   帧内 crc 覆盖 version+seq+len+payload 全部字节（不含 magic），小端写入帧尾。
2）\`encode(seq, payloadText, version=1) -> Buffer\`：payload 按 UTF-8 编码。
3）\`decodeStream(buf) -> 结果数组\`（从左到右扫描，可粘连多帧）：
   - 当前 4 字节 ≠ magic → 记 {ok:false, error:"BAD_MAGIC", at: 偏移}，偏移 +1 逐字节重同步找下一个 magic（重同步过程中即使尾部不足 13 字节也继续记 BAD_MAGIC，直到剩余 < 4 字节读不出 magic）；
   - 剩余不足 4 字节，或 magic 命中后帧头（前 11 字节 = magic+version+seq+len）未收全，或 payload 不足（剩余 < 11+len）→ {ok:false, error:"INCOMPLETE", at: 偏移}，停止扫描；
   - crc 校验失败 → {ok:false, error:"BAD_CRC", seq, at: 偏移}，跳过该帧继续；
   - version ≠ 1 → {ok:false, error:"BAD_VERSION", seq, at: 偏移}，跳过该帧继续（判定顺序：先 CRC 后 version）；
   - 正常 → {ok:true, seq, version, payload}（payload 为 UTF-8 文本），跳帧继续。
CLI：\`node frames.js run frames.json\` 写当前目录 \`report.json\` =
\`{"encoded": pairs 逐项 {seq, hex}（version=1）, "stream": 对 stream_hex 的解码结果, "truncated": 对 truncated_hex 的解码结果, "zeros": 对 zeros11_hex 的解码结果}\`，
退出码 0，打印摘要。
frames.test.js：\`node --test frames.test.js\` 通过，至少 8 个断言（node:assert），覆盖：encode/decode 往返、CRC 单字节损坏判 BAD_CRC、
版本 2 判 BAD_VERSION（CRC 合法）、粘连双帧、INCOMPLETE、BAD_MAGIC 后逐字节重同步、crc16 已知向量（"123456789" → 0x29B1）。
README.md（≥300 字节）：帧布局表、判定顺序与重同步规则。
必须真实运行 CLI，并在回复中写明 stream 解码结果数组的错误类型序列。`,
    expect: 'frames.js + test + README + report.json', dir: D(6), frozen: ['frames.json'],
    deliverables: [
      { file: 'frames.js', minBytes: 1400 }, { file: 'frames.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 500 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node frames.js run frames.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else {
        const expStream = R6.out.stream.map((r) => (r.ok ? { ok: true, seq: r.seq, version: r.version, payload: r.payload } : { ok: false, error: r.error, seq: r.seq, at: r.at }));
        const expTrunc = R6.out.truncated.map((r) => ({ ok: false, error: r.error, at: r.at }));
        const expZeros = R6.out.zeros.map((r) => ({ ok: false, error: r.error, at: r.at }));
        if (!Array.isArray(rep.encoded) || rep.encoded.length !== 2) bad.push('encoded 项数不符');
        else {
          const f1 = Buffer.from(rep.encoded[0].hex, 'hex');
          if (f1.toString('hex') !== R6.f1_hex) bad.push('encoded[0] hex 与参考不符: ' + f1.toString('hex'));
          if (Buffer.from(rep.encoded[1].hex, 'hex').toString('hex') !== R6.f2_hex) bad.push('encoded[1] hex 与参考不符');
        }
        if (!sameJson(rep.stream, expStream)) bad.push('stream 解码与参考不符: ' + JSON.stringify(rep.stream).slice(0, 240));
        if (!sameJson(rep.truncated, expTrunc)) bad.push('truncated 解码与参考不符');
        if (!sameJson(rep.zeros, expZeros)) bad.push('zeros 解码与参考不符');
      }
      const probe = runProbe(dir, 'frames.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'frames.json'), 'utf8'));
return {
  crc9: m.crc16(Buffer.from('123456789')),
  f1: m.encode(7, 'hello').toString('hex'),
  stream: m.decodeStream(Buffer.from(doc.stream_hex, 'hex')),
  trunc: m.decodeStream(Buffer.from(doc.truncated_hex, 'hex')),
};
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (probe.value.crc9 !== 0x29b1) bad.push(`crc16("123456789")=${probe.value.crc9.toString(16)}≠29b1`);
        if (probe.value.f1 !== R6.f1_hex) bad.push('模块 encode 与参考不符');
        const norm = (a) => a.map((r) => (r.ok ? { ok: true, seq: r.seq, version: r.version, payload: r.payload } : { ok: false, error: r.error, seq: r.seq, at: r.at }));
        if (!sameJson(norm(probe.value.stream), R6.out.stream.map((r) => (r.ok ? { ok: true, seq: r.seq, version: r.version, payload: r.payload } : { ok: false, error: r.error, seq: r.seq, at: r.at })))) bad.push('模块 decodeStream 与参考不符');
        if (probe.value.trunc.length !== 1 || probe.value.trunc[0].error !== 'INCOMPLETE') bad.push('模块 truncated 漂移');
      }
      const ac = assertCount(dir, 'frames.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'frames.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓CRC向量/编解码往返/粘连切帧/CRC错/坏版本/INCOMPLETE/重同步/CLI/单测全一致' };
    },
  },
];
