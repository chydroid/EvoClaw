/**
 * EvoClaw v32 压测任务定义（9 任务）与核验器。
 * 核验纪律：harness 自带参考实现复算（test-v32-lib.mjs），不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runPy, runProbe, readFileSafe } from './v14/lib.mjs';
import {
  D, sameJson, pyPath, pyReadTextLiteral,
  t1Ref, t2Ref, t3Ref, T3_FIXTURE, t4Ref, T4_FIXTURE, t5Ref, t6Ref, t7Ref, t8Ref, T8_FIXTURE, t9Ref,
} from './test-v32-lib.mjs';

// 断言行判定（与 v30/v31 同口径 + 中文助手族 + assert* 族）。
const ASSERT_LINE_RE = /\bassert\b|\b(?:assert|expect|check|verify|should|ensure|confirm)\w*\s*\(|\bok\s*\(|(?:断言|校验|检查|验证|确认)\s*[（(]/;
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

const pyRun = (dir, args, timeoutMs = 90000) => {
  try {
    const out = execSync(`timeout 80 python3 ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
};

export const tasks = [
  // ═══════════════ T1: 四则运算表达式求值（Python） ═══════════════
  {
    id: 1, name: '四则运算表达式求值（Python，shunting-yard + 向负 floor 除/取余）', type: '解析/求值',
    prompt: `你是解释器工程师。在 ${D(1)}/ 交付零依赖 Python（仅标准库）四则运算表达式求值器。
冻结夹具：\`cases.json\`（数组 \`[{name, expr}]\`，expr 仅含数字、+ - * / % 与括号、空格）。禁止修改夹具。
**必须交付（缺一不可）：calc.py、test_calc.py、README.md、report.json。**
calc.py 导出 \`{ eval_expr }\`：eval_expr(text) -> int，口径（必须逐条对上）：
- 运算符 \`+ - * / %\` 与括号；\`-\` 可作一元负号，其优先级**高于** * / %（故 -2*3 = (-2)*3，
  2*-3 = 2*(-3)）；二元运算左结合；
- \`/\` 为**向负无穷取整的除法**（floor：7/2=3，-7/2=-4）；\`%\` 为与 floor 除法配对的取余
  （\`a%b = a - floor(a/b)*b\`，结果符号随除数：-7%3=2，7%-3=-2）；除数为 0 抛异常；
- 操作数为非负整数；支持任意嵌套括号。实现要求：shunting-yard 或等价算法（先转 RPN/后缀式再求值），
  不得用 eval/exec 执行表达式。
CLI：\`python3 calc.py run cases.json\` 写当前目录 \`report.json\` = \`{"results": {name: 值}}\`（键序与夹具一致），
退出码 0，打印摘要。
test_calc.py：\`python3 test_calc.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，
中文注释可以；裸 \`assert\` 语句亦可），覆盖：优先级、括号、一元负号两侧、floor 除法负商、取余符号规则、连减。
README.md（≥300 字节）：算法（shunting-yard/RPN）与除法取整口径。
必须真实运行 CLI，并在回复中写明 e5 与 e7 的值。`,
    expect: 'calc.py + test + README + report.json', dir: D(1), frozen: ['cases.json'],
    deliverables: [
      { file: 'calc.py', minBytes: 1200 }, { file: 'test_calc.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 120 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['calc.py', 'run', 'cases.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results || rep, R1)) bad.push('report 结果与参考不符: ' + JSON.stringify(rep).slice(0, 200));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import calc as m
cases = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = {}
for c in cases:
    out[c['name']] = m.eval_expr(c['expr'])
print(json.dumps(out, sort_keys=True))
`, [dir + '/cases.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R1)) bad.push('模块 eval_expr 与参考不符');
      const ac = assertCount(dir, 'test_calc.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_calc.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓优先级/一元负号/floor除/取余/CLI/单测全一致' };
    },
  },

  // ═══════════════ T2: KMP 串匹配（Node） ═══════════════
  {
    id: 2, name: 'KMP 前缀函数 + 重叠串匹配位置（Node）', type: '字符串算法',
    prompt: `你是字符串算法工程师。在 ${D(2)}/ 交付零依赖 Node（CommonJS）KMP 匹配器。
冻结夹具：\`cases.json\`（\`{cases: [{text, pattern}]}\`）。禁止修改夹具。
**必须交付（缺一不可）：kmp.js、kmp.test.js、README.md、report.json。**
kmp.js 用 \`module.exports = { prefix, find }\` 导出：
1）\`prefix(p)\`：KMP 前缀函数（部分匹配表）——对 i≥1：若 p[i]≠p[j] 则 j 沿 pi 回溯，相等则 j+1，pi[i]=j。
   返回长度 p.length 的整数数组（pi[0]=0）。
2）\`find(text, pat)\`：返回 pat 在 text 中**所有（含重叠）出现位置**（0 起 index 数组，升序）；
   标准 KMP 状态机（失配时 j 沿 pi 回溯，命中后 j=pi[j-1] 继续扫描）；pat 为空串返回 []。
实现要求：O(|text|+|pat|)，**不得**用 indexOf/lastIndexOf/正则引擎。
CLI：\`node kmp.js run cases.json\` 写当前目录 \`report.json\` = \`{"results": [{text, pattern, pi, positions}...]}\`
（顺序与夹具一致；空 pattern 的 pi 为 []），退出码 0，打印摘要。
kmp.test.js：\`node --test kmp.test.js\` 通过，至少 8 个断言（node:assert），覆盖：aaaa 重叠三连、
前缀函数已知向量（'abab'→[0,0,1,2]）、pattern 长于 text、空 pattern、单字符命中、无命中空数组、
位置升序、prefix('aaab')=[0,1,2,0]。
README.md（≥300 字节）：前缀函数构造与回溯规则、为什么命中后 j=pi[j-1] 能保留重叠匹配。
必须真实运行 CLI，并在回复中写明 mississippi 的 positions。`,
    expect: 'kmp.js + test + README + report.json', dir: D(2), frozen: ['cases.json'],
    deliverables: [
      { file: 'kmp.js', minBytes: 1000 }, { file: 'kmp.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node kmp.js run cases.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results, R2)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runProbe(dir, 'kmp.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'cases.json'), 'utf8'));
return {
  out: doc.cases.map((c) => ({ text: c.text, pattern: c.pattern, pi: m.prefix(c.pattern), positions: m.find(c.text, c.pattern) })),
  v1: m.prefix('abab'),
  v2: m.find('abcababcab', 'abcab'),
};
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.out, R2)) bad.push('模块 find 与参考不符');
        if (!sameJson(probe.value.v1, [0, 0, 1, 2])) bad.push('prefix 已知向量漂移');
        if (!sameJson(probe.value.v2, [0, 5])) bad.push('重叠匹配向量漂移');
      }
      const ac = assertCount(dir, 'kmp.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'kmp.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓前缀函数/重叠匹配/边界/CLI/单测全一致' };
    },
  },

  // ═══════════════ T3: Bloom filter（Python） ═══════════════
  {
    id: 3, name: 'Bloom filter 误判率报告（Python，zlib.crc32 钉死哈希）', type: '概率数据结构',
    prompt: `你是概率数据工程师。在 ${D(3)}/ 交付零依赖 Python（仅标准库）Bloom filter 模块。
冻结夹具：\`bloom.json\`（\`{m, k, items: [string], probes: [string]}\`；items 全为已插入成员，probes 全为**不在** items 中的探针）。
禁止修改夹具。
**必须交付（缺一不可）：bloom.py、test_bloom.py、README.md、report.json。**
bloom.py 导出 \`{ BloomFilter, run_report }\`：
- BloomFilter(m, k)：位数组（m 位）+ 插入 + 查询；第 i 个哈希 h_i(s) = zlib.crc32(utf8 编码的 s + "#" + str(i)) % m，
  i = 0..k-1（必须用 zlib.crc32，逐字复刻）；
- 查询语义：k 个哈希位全 1 → 可能存在（True）；任一为 0 → 一定不在（False）；
- run_report(spec) -> \`{"bitsSet": 置 1 位总数, "allMembersIn": 单个布尔值（每个 item 查询是否**都**为 True，
  100 项全中即为 true，**不要**返回逐项数组）,
  "falsePositives": 误报的探针（按夹具序）, "obsFpr": len(误报)/len(probes), "expFpr": 理论误判率}\`，
  其中 expFpr = (1 - exp(-k*n/m))^k（n = items 数，用 math.exp；不要求对探针做区分）。
CLI：\`python3 bloom.py run bloom.json\` 写当前目录 \`report.json\` = run_report 结果，退出码 0，打印摘要。
test_bloom.py：\`python3 test_bloom.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，
中文注释可以；裸 \`assert\` 语句亦可），覆盖：已插入成员必命中、未插入探针可能误报、bitsSet 范围（0≤bitsSet≤m）、
k=1 退化为单哈希、小 filter 全位 1 后一切命中、插入幂等（重复插入不增位）、zlib.crc32 已知向量
（crc32('123456789')==3421780262）、obsFpr/expFpr 类型与范围。
README.md（≥300 字节）：误判单向性（只可能报"可能存在"）与理论误判率公式。
必须真实运行 CLI，并在回复中写明 bitsSet 与 obsFpr。`,
    expect: 'bloom.py + test + README + report.json', dir: D(3), frozen: ['bloom.json'],
    deliverables: [
      { file: 'bloom.py', minBytes: 1000 }, { file: 'test_bloom.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 120 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['bloom.py', 'run', 'bloom.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      // allMembersIn 口径归一化：任务书写「每个 item 查询是否都为 True」，
      // 模型可能返回 100 个布尔的 list（逐 item）或单个标量 true。两种都是
      // 任务书未钉死的私有细节，统一折成「是否全部命中」的单布尔再比。
      const normBloom = (x) => ({ ...x, allMembersIn: Array.isArray(x.allMembersIn) ? x.allMembersIn.every(Boolean) : !!x.allMembersIn, expFpr: null });
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(normBloom(rep), normBloom(R3))) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      else if (Math.abs((rep.expFpr ?? 0) - R3.expFpr) > 1e-12 * Math.max(1, R3.expFpr)) bad.push('expFpr 漂移: ' + rep.expFpr + ' vs ' + R3.expFpr);
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import bloom as m
spec = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
print(json.dumps(m.run_report(spec), sort_keys=True))
`, [dir + '/bloom.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(normBloom(probe.value), normBloom(R3))) bad.push('模块 run_report 与参考不符');
      const ac = assertCount(dir, 'test_bloom.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_bloom.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓钉死哈希/误报清单/obsFpr与expFpr/CLI/单测全一致' };
    },
  },

  // ═══════════════ T4: LRU/LFU/CLOCK 缓存模拟（Python） ═══════════════
  {
    id: 4, name: 'LRU/LFU/CLOCK 缓存模拟器（Python，三种逐出策略对比）', type: '缓存算法',
    prompt: `你是存储系统工程师。在 ${D(4)}/ 交付零依赖 Python（仅标准库）缓存模拟器，实现三种逐出策略并对比。
冻结夹具：\`cache.json\`（\`{cap, trace: ["put:key"|"get:key" ...]}\`）。禁止修改夹具。
**必须交付（缺一不可）：cachesim.py、test_cachesim.py、README.md、report.json。**
cachesim.py 导出 \`{ simulate }\`：simulate(spec) -> \`{"lru": S, "lfu": S, "clock": S}\`，三种策略各得
S = \`{"hits", "misses", "evictions", "final"}\`，口径（必须逐条对上）：
- 每次 trace 操作：键已在缓存 → hit；不在 → miss；
- **put miss**：容量未满则插入；满了则先逐出一个键再插入（记一次 eviction）；**get miss 不缓存**（无 read-through）；
- LRU：逐出**最久未访问**者（hit 与 put 均刷新；final = 从最旧到最新）；
- LFU：逐出频率最低者，平局取**最久未访问**者（按最后访问时刻，再平按字典序；final = 按(频率, 最后访问时刻, 键)升序）；
- CLOCK：cap 个槽环形表 + 每槽 referent 位，hand 指针从 0 起；put miss 时从 hand 所指顺时针扫描：
  referent=1 → 清零、hand+1 继续；referent=0 → 该槽逐出并写入新键（referent 置 1，hand+1）；
  遇空槽直接写入（referent 置 1，hand+1）；hit → 该键所在槽 referent 置 1；
  扫满一圈仍无空槽/无 referent=0 槽则淘汰 hand 所指；final = 从 hand 起顺时针读 cap 个槽（null 表示空）。
CLI：\`python3 cachesim.py run cache.json\` 写当前目录 \`report.json\` = simulate 结果，退出码 0，打印摘要。
test_cachesim.py：\`python3 test_cachesim.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，
如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：LRU 逐出序、LFU 平局按访问时刻、
CLOCK 两次机会（referent 清零后才逐出）、get miss 不占槽、容量边界（1 槽）、三策略 hits+misses==trace 长度、
evictions 计数、final 长度。
README.md（≥300 字节）：三种策略逐出口径与平局规则。
必须真实运行 CLI，并在回复中写明三策略的 evictions。`,
    expect: 'cachesim.py + test + README + report.json', dir: D(4), frozen: ['cache.json'],
    deliverables: [
      { file: 'cachesim.py', minBytes: 1500 }, { file: 'test_cachesim.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 160 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['cachesim.py', 'run', 'cache.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R4)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 260));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import cachesim as m
spec = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
print(json.dumps(m.simulate(spec), sort_keys=True))
`, [dir + '/cache.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R4)) bad.push('模块 simulate 与参考不符');
      const ac = assertCount(dir, 'test_cachesim.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_cachesim.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓三策略逐出/平局/CLOCK环/CLI/单测全一致' };
    },
  },

  // ═══════════════ T5: 指数退避 full-jitter + 熔断器（Node） ═══════════════
  {
    id: 5, name: '指数退避 full-jitter + 熔断器状态机（Node，LCG 种子确定性）', type: '高可用/弹性',
    prompt: `你是可靠性工程师。在 ${D(5)}/ 交付零依赖 Node（CommonJS）重试退避与熔断器模块。
冻结夹具：\`resilience.json\`（\`{backoff: {attempts, baseMs, factor, capMs, seed},
breaker: {failThreshold, openMs, events: [{t, ok}]}}\`；events 按时间升序）。禁止修改夹具。
**必须交付（缺一不可）：resilience.js、resilience.test.js、README.md、report.json。**
resilience.js 用 \`module.exports = { backoffSchedule, runBreaker }\` 导出，口径（必须逐条对上）：
1）\`backoffSchedule(cfg)\`：full-jitter 指数退避——第 0 次尝试 t=0；第 i 次（i≥1）等待
   limit_i = min(capMs, baseMs × factor^(i-1))，wait_i = floor(draw_i / 2^32 × limit_i)
   （draw_i 来自 LCG \`x = (x * 1103515245 + 12345) % 2147483648\`，x0 = seed，每次调用步进一次；
   Node 32 位回绕须用 Math.imul 处理乘法，结果取无符号 32 位）；
   返回 \`{schedule: [0, w1, w1+w2, ...]（attempts 项，时刻 ms）, waits, draws}\`（waits/draws 各 attempts-1 项）。
2）\`runBreaker(spec)\`：熔断器状态机 closed →（连续 failThreshold 次失败，累计计数归零）→ open
   （openUntil = 失败时刻 + openMs）→ 到达 openUntil 后首个事件转 half-open →
   half-open 成功 → closed（该事件处理后即为 closed）；half-open 失败 → open（openUntil = 该事件时刻 + openMs）；
   open 期内（t < openUntil）到达的事件被快速失败丢弃：不改变状态、不计入 failures/successes；
   half-open 只在事件之间出现（某事件处理后不可能是 half-open）；
   返回 \`{finalState, transitions: [如 "closed->open"...]（只记状态跳变序列）, failures, successes,
   timeline: [{t, state}（每事件处理后的状态）]}\`。
CLI：\`node resilience.js run resilience.json\` 写当前目录 \`report.json\` = \`{"backoff": backoffSchedule 结果,
"breaker": runBreaker 结果}\`，退出码 0，打印摘要。
resilience.test.js：\`node --test resilience.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
LCG 已知向量（x0=0 首次步进=12345）、schedule[0]=0、waits ≤ capMs、full-jitter 范围、
熔断三连发转 open、open 期内事件保持 open、half-open 成功/失败两分支、transitions 序。
README.md（≥300 字节）：full-jitter 公式与 LCG 步进口径、熔断器状态迁移表。
必须真实运行 CLI，并在回复中写明 waits 数组。`,
    expect: 'resilience.js + test + README + report.json', dir: D(5), frozen: ['resilience.json'],
    deliverables: [
      { file: 'resilience.js', minBytes: 1200 }, { file: 'resilience.test.js', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 240 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node resilience.js run resilience.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R5)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 260));
      const probe = runProbe(dir, 'resilience.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'resilience.json'), 'utf8'));
return {
  backoff: m.backoffSchedule(doc.backoff),
  breaker: m.runBreaker(doc.breaker),
  lcg1: (() => { let x = (Math.imul(0, 1103515245) + 12345) % 2147483648; return x; })(),
};
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.backoff, R5.backoff)) bad.push('模块 backoffSchedule 与参考不符');
        if (!sameJson(probe.value.breaker, R5.breaker)) bad.push('模块 runBreaker 与参考不符');
        if (probe.value.lcg1 !== 12345) bad.push('LCG 向量漂移');
      }
      const ac = assertCount(dir, 'resilience.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'resilience.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓LCG退避/熔断迁移/边界/CLI/单测全一致' };
    },
  },

  // ═══════════════ T6: N-queens 回计数（Python） ═══════════════
  {
    id: 6, name: 'N-queens 回计数 + 字典序首解（Python）', type: '组合搜索',
    prompt: `你是算法竞赛选手。在 ${D(6)}/ 交付零依赖 Python（仅标准库）N 皇后求解器。
冻结夹具：\`boards.json\`（\`{ns: [整数...]}\`）。禁止修改夹具。
**必须交付（缺一不可）：queens.py、test_queens.py、README.md、report.json。**
queens.py 导出 \`{ solve_nqueens }\`：solve_nqueens(n) -> \`{count, first}\`：
- n 行 n 列，每行恰好一个皇后且互不攻击；n<4（且 n≠1）→ count=0、first=null；n=1 → count=1、first=[0]；
- 逐行回溯（行 0..n-1），列按 0..n-1 顺序尝试 → 首个解即列号字典序最小的解；
- 用两条对角线索引集剪枝（行+列、行−列+n−1）；
- first 为 [列号] 数组（第 i 项 = 第 i 行皇后列号）。
CLI：\`python3 queens.py run boards.json\` 写当前目录 \`report.json\` = \`{str(n): 结果}\`（键为十进制字符串，如 "4"），
退出码 0，打印摘要。
test_queens.py：\`python3 test_queens.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，
如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：已知解数 n=1/4/5/6/8、
解合法性检查器（自写 validator：行数/列唯一/对角唯一）、first 为合法解、n=2/3 无解、
解长度==n、字典序首解性质（n=4 首解首行列 < 末解首行列）。
README.md（≥300 字节）：剪枝集构造（行+列/行−列+n−1）与复杂度说明。
必须真实运行 CLI，并在回复中写明 n=8 的 count。`,
    expect: 'queens.py + test + README + report.json', dir: D(6), frozen: ['boards.json'],
    deliverables: [
      { file: 'queens.py', minBytes: 900 }, { file: 'test_queens.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 140 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['queens.py', 'run', 'boards.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R6)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import queens as m
doc = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = {}
for n in doc['ns']:
    out[str(n)] = m.solve_nqueens(n)
print(json.dumps(out, sort_keys=True))
`, [dir + '/boards.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R6)) bad.push('模块 solve_nqueens 与参考不符');
      const ac = assertCount(dir, 'test_queens.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_queens.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓解数/首解/合法性/边界/CLI/单测全一致' };
    },
  },

  // ═══════════════ T7: 撤销/重做操作日志（Node） ═══════════════
  {
    id: 7, name: '撤销/重做操作日志：连续插入合并组（Node）', type: '编辑器基础设施',
    prompt: `你是编辑器基础设施工程师。在 ${D(7)}/ 交付零依赖 Node（CommonJS）带撤销/重做的操作日志引擎。
冻结夹具：\`ops.json\`（\`{init: [数], ops: [{op: "ins"|"del"|"undo"|"redo", ...}]}\`；
ins 为 {pos, val}，del 为 {pos}）。禁止修改夹具。
**必须交付（缺一不可）：history.js、history.test.js、README.md、report.json。**
- 返回 `{final, groups, undos, redos}`；**groups = 全程创建的合并组总数（累计计数：
  每次新建一组 +1，undo/redo 都不减少它，也不是结束时的栈占用数）**；
- 数组下标 0 起；ins 在 pos 处插入 val（pos 可越界到末尾，视为追加）；del 删除 pos 项；
- **合并组**：连续两次 ins，且前一次的下一个插入位置恰好等于后一次的 pos（即同位连续追加，
  后一次 pos = 前一次 pos+1）→ 并入**同一个组**；del 永远独占一组；
- undo：弹出最近一组，按组内操作的**逆序**逐条回滚（ins 回滚=删该位，del 回滚=原值插回原位）；
  组移入 redo 栈；undos 计数每次 undo 指令（栈空则原样返回不计数）；
- redo：弹出 redo 栈顶组，按组内**正序**逐条重放（ins 插回/del 重删）；组移回 undo 栈；redos 计数每次 redo 指令
  （栈空不计数）；
- 任何新的 ins/del 清空 redo 栈。
CLI：\`node history.js run ops.json\` 写当前目录 \`report.json\` = apply 结果，退出码 0，打印摘要。
history.test.js：\`node --test history.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
三连插合并为一组、ins 后 del 不合并、undo 逆序回滚、redo 正序重放、新输入清 redo、
undo 栈空安全、del 独占组、final 精确值。
README.md（≥300 字节）：合并组规则与 undo/redo 栈语义。
必须真实运行 CLI，并在回复中写明 groups 与 final。`,
    expect: 'history.js + test + README + report.json', dir: D(7), frozen: ['ops.json'],
    deliverables: [
      { file: 'history.js', minBytes: 1100 }, { file: 'history.test.js', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 80 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node history.js run ops.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R7)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 200));
      const probe = runProbe(dir, 'history.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'ops.json'), 'utf8'));
return { out: m.apply(doc.init, doc.ops), v1: m.apply([0], [{ op: 'ins', pos: 1, val: 1 }, { op: 'ins', pos: 2, val: 2 }]) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.out, R7)) bad.push('模块 apply 与参考不符');
        if (probe.value.v1.groups !== 1) bad.push('合并组向量漂移: ' + JSON.stringify(probe.value.v1));
      }
      const ac = assertCount(dir, 'history.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'history.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓合并组/逆序回滚/栈语义/CLI/单测全一致' };
    },
  },

  // ═══════════════ T8: 传递闭包 + 可达统计（Node） ═══════════════
  {
    id: 8, name: '有向图传递闭包（Floyd）+ 可达对统计（Node）', type: '图算法',
    prompt: `你是图算法工程师。在 ${D(8)}/ 交付零依赖 Node（CommonJS）有向图传递闭包模块。
冻结夹具：\`graph.json\`（\`{n, edges: [[u,v]...], queries: [[a,b]...]}\`；节点编号 0..n-1；边可含 u==v 自环，
查询可能含 a==b）。禁止修改夹具。
**必须交付（缺一不可）：closure.js、closure.test.js、README.md、report.json。**
closure.js 用 \`module.exports = { closure }\` 导出：closure(spec) ->
\`{results: 每个 [a,b] 查询的 a 是否可达 b（布尔数组，顺序与 queries 一致）,
total: 所有 i≠j 的可达对总数, maxOut: [出度最大者编号, 其出度]（平局取编号小者）}\`，口径：
- 可达性：路径长度 ≥ 1（边存在即可达；**自环不产生 i≠j 的可达对**）；
- 中间节点 k 按 0..n-1 序的 Floyd-Warshall 标准三层循环（外层 k 必须最外）；
- total 统计 i≠j 的 reach[i][j] 数；出度 = i≠j 的 reach[i][*] 个数。
实现要求：布尔矩阵（可用 Array(n)×Array(n) 或位掩码整行），**不得使用**递归 DFS/BFS。
CLI：\`node closure.js run graph.json\` 写当前目录 \`report.json\` = closure 结果，退出码 0，打印摘要。
closure.test.js：\`node --test closure.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
自环不计数、环内互达（0→1→2→0 三者两两可达）、不连通分量（6-7 对与其余隔离）、
i==j 查询按直接边判定、total 不变量（≤n(n-1)）、位掩码实现交叉验证（自写一个独立小实现比对）、
空图全 false、k 外层循环顺序等价性。
README.md（≥300 字节）：Floyd 递推式与为什么 k 必须最外层。
必须真实运行 CLI，并在回复中写明 total。`,
    expect: 'closure.js + test + README + report.json', dir: D(8), frozen: ['graph.json'],
    deliverables: [
      { file: 'closure.js', minBytes: 900 }, { file: 'closure.test.js', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 100 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node closure.js run graph.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R8)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runProbe(dir, 'closure.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'graph.json'), 'utf8'));
return { out: m.closure(doc), v1: m.closure({ n: 2, edges: [[0, 0]], queries: [[0, 0], [0, 1]] }) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.out, R8)) bad.push('模块 closure 与参考不符');
        if (!sameJson(probe.value.v1, { results: [true, false], total: 0, maxOut: [0, 0] })) bad.push('自环向量漂移: ' + JSON.stringify(probe.value.v1));
      }
      const ac = assertCount(dir, 'closure.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'closure.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓闭包/自环/环互达/统计/CLI/单测全一致' };
    },
  },

  // ═══════════════ T9: 确定性 quickselect（Python） ═══════════════
  {
    id: 9, name: '确定性 quickselect：中位数三选 + Lomuto + 比较计数（Python）', type: '选择算法',
    prompt: `你是算法工程师。在 ${D(9)}/ 交付零依赖 Python（仅标准库）确定性 quickselect。
冻结夹具：\`cases.json\`（\`{cases: [{a: [数], k: 整数}]}\`，k 合法：0≤k<len(a)）。禁止修改夹具。
**必须交付（缺一不可）：select.py、test_select.py、README.md、report.json。**
select.py 导出 \`{ quickselect }\`：quickselect(arr, k) -> \`[第 k 小的值（0 起）, 元素比较次数]\`，
口径（必须逐条对上，实现确定性、与调用次数无关）：
- 在闭区间 [l, r] 反复选择：三数取中——pivot = [arr[l], arr[(l+r)//2], arr[r]] 三者中位数
  （两两比较取中值，比较次数**不计入**）；把 pivot 换到 r 位置；
- Lomuto 分区：i = l-1；j 从 l 到 r-1：若 arr[j] ≤ pivot（**计 1 次比较**）则 i++、交换 arr[i] 与 arr[j]；
  最后交换 arr[i+1] 与 arr[r]；p = i+1；
- p == k → 返回 [arr[k], 总比较次数]；k < p → r = p-1；k > p → l = p+1；
- 不修改调用方入参（内部拷贝）；比较次数只统计 \`arr[j] <= pivot\` 的每次判定。
CLI：\`python3 select.py run cases.json\` 写当前目录 \`report.json\` = \`{"results": [{kth, comps}]}\`
（顺序与夹具一致），退出码 0，打印摘要。
test_select.py：\`python3 test_select.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，
如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：answer == sorted(a)[k]（多组自构数据）、
确定性（同输入重复 3 次结果一致）、全相同元素、单元素、入参不被修改、k=0/k=len-1 边界、
比较次数 ≥ k、负数参与排序。
README.md（≥300 字节）：三数取中 pivot 规则、Lomuto 分区不变量与比较计数口径。
必须真实运行 CLI，并在回复中写明第 5 个 case 的 kth 与 comps。`,
    expect: 'select.py + test + README + report.json', dir: D(9), frozen: ['cases.json'],
    deliverables: [
      { file: 'select.py', minBytes: 900 }, { file: 'test_select.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 140 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['select.py', 'run', 'cases.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results || rep, R9)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import select as m
doc = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = []
for c in doc['cases']:
    v, c2 = m.quickselect(c['a'], c['k'])
    out.append({'kth': v, 'comps': c2})
print(json.dumps(out))
`, [dir + '/cases.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R9)) bad.push('模块 quickselect 与参考不符');
      const ac = assertCount(dir, 'test_select.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_select.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓kth值/比较计数/确定性/边界/CLI/单测全一致' };
    },
  },
];

// 顶层预计算参考（exec 闭包引用）
const R1 = t1Ref();
const R2 = t2Ref();
const R3 = t3Ref(T3_FIXTURE);
const R4 = t4Ref(T4_FIXTURE);
const R5 = t5Ref();
const R6 = t6Ref();
const R7 = t7Ref();
const R8 = t8Ref();
const R9 = t9Ref();
