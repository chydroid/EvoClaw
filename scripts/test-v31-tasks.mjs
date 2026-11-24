/**
 * EvoClaw v31 压测任务定义（10 任务）与核验器。
 * 核验纪律：harness 自带参考实现复算（test-v31-lib.mjs），不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runPy, runProbe, readFileSafe } from './v14/lib.mjs';
import {
  D, sameJson, pyPath, pyReadTextLiteral,
  t1Ref, t2Ref, t3Ref, t4Ref, t4RegexMatch, t5Ref, t6Ref, t7Ref, t8Ref, t8Fnv, t9Ref, t10Ref,
} from './test-v31-lib.mjs';

// 断言行判定（与 v30 同口径 + 中文助手族 + assert* 族，v30-run2 修复沉淀）。
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
  // ═══════════════ T1: YAML 子集解析器（Python） ═══════════════
  {
    id: 1, name: 'YAML 子集解析器（Python，块映射/块列表/标量类型）', type: '配置解析',
    prompt: `你是配置系统工程师。在 ${D(1)}/ 交付零依赖 Python（仅标准库）YAML 子集解析器。
冻结夹具：\`cases.json\`（数组 \`[{name, yaml}]\`，yaml 为带换行转义的字符串）。禁止修改夹具。
**必须交付（缺一不可）：yamlite.py、test_yamlite.py、README.md、report.json。**
yamlite.py 导出 \`{ parse_yaml }\`：parse_yaml(text) -> 解析结果（dict/list/标量/None）。支持**且仅支持**（口径必须逐条对上）：
- 块映射：\`key: value\`；key 为 \`[A-Za-z0-9_-]+\`；value 可为空（表示嵌套块或 null）；
- 块列表：行首 \`- 标量\`（列表项仅标量，无嵌套映射/列表）；
- 缩进规则：每级缩进 2 空格（相对父级严格更深）；同层键的缩进一致；
- 标量类型判定（**按此顺序**）：空值/\`null\`/\`~\`→None；\`true\`→True；\`false\`→False；
  \`[+-]?\\d+\`→int；\`[+-]?(\\d+\\.\\d*|\\.\\d+)([eE][+-]?\\d+)?\`→float；
  单引号/双引号串→去引号取**逐字**内容（无转义处理）；其余（含 \`FALSE\`/\`True\` 等非常规大小写）→原样字符串；
- 注释：整行（trim 后以 # 开头）忽略；行内注释不识别（# 是普通字符，如 'a#b'）；
- 空文件/纯注释 → None。不支持 flow 集合、锚点、多文档、多行块——夹具中不出现。
CLI：\`python3 yamlite.py run cases.json\` 写当前目录 \`report.json\` = \`{"results": {name: 解析结果}}\`（键序与夹具一致），退出码 0，打印摘要。
test_yamlite.py：\`python3 test_yamlite.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：嵌套映射、列表、标量类型判定（含 False/0.0 边界）、引号串、空/注释文件。
README.md（≥300 字节）：支持范围与标量类型判定顺序。
必须真实运行 CLI，并在回复中写明 y1 的 labels 与 y4 的 f 值。`,
    expect: 'yamlite.py + test + README + report.json', dir: D(1), frozen: ['cases.json'],
    deliverables: [
      { file: 'yamlite.py', minBytes: 1500 }, { file: 'test_yamlite.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['yamlite.py', 'run', 'cases.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results || rep, R1)) bad.push('report 结果与参考不符: ' + JSON.stringify(rep).slice(0, 200));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import yamlite as m
cases = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = {}
for c in cases:
    out[c['name']] = m.parse_yaml(c['yaml'])
print(json.dumps(out, sort_keys=True))
`, [dir + '/cases.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R1)) bad.push('模块 parse_yaml 与参考不符');
      const ac = assertCount(dir, 'test_yamlite.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_yamlite.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓嵌套映射/列表/标量类型/引号/注释/CLI/单测全一致' };
    },
  },

  // ═══════════════ T2: 复式记账账本（Python） ═══════════════
  {
    id: 2, name: '复式记账账本 + 对账（Python，借贷平衡判定/账户余额）', type: '财务账本',
    prompt: `你是财务系统工程师。在 ${D(2)}/ 交付零依赖 Python（仅标准库）复式记账账本模块。
冻结夹具：\`books.json\`（\`{accounts: [{code, name}], journals: [{name, date, entries: [{account, debit, credit}]}]}\`，金额均为整数）。禁止修改夹具。
**必须交付（缺一不可）：books.py、test_books.py、README.md、report.json。**
books.py 导出 \`{ check_journal, build_ledger }\`：
- check_journal(entries) -> "OK" | "UNBALANCED"：总借方 == 总贷方 为 OK（空分录总账 0==0 → OK）；
- build_ledger(accounts, journals) -> dict：
  - 逐日记账：UNBALANCED 的日记账**整笔不生效**（其分录不计入余额与借方合计）；
  - balances：各账户余额 = 生效分录(借方 − 贷方)之和（账户初始 0，**含未出现在任何生效分录的账户**）；
  - totalDebit：全部**生效**分录借方总和。
  返回恰好 \`{"journals": {name: 状态}, "balances": {code: 数}, "totalDebit": 数}\`。
CLI：\`python3 books.py run books.json\` 写当前目录 \`report.json\` = 上述结构（键序：journals 按夹具顺序、balances 按字典序），退出码 0，打印摘要。
test_books.py：\`python3 test_books.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：平衡判定、空分录、不平衡整笔拒绝、多日记账累加、未出现账户 0 余额。
README.md（≥300 字节）：借贷平衡语义与不平衡日记账的隔离规则。
必须真实运行 CLI，并在回复中写明 CA 与 REV 的余额。`,
    expect: 'books.py + test + README + report.json', dir: D(2), frozen: ['books.json'],
    deliverables: [
      { file: 'books.py', minBytes: 1000 }, { file: 'test_books.py', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 150 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['books.py', 'run', 'books.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R2)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import books as m
doc = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
out = m.build_ledger(doc['accounts'], doc['journals'])
print(json.dumps(out, sort_keys=True))
`, [dir + '/books.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R2)) bad.push('模块 build_ledger 与参考不符');
      const ac = assertCount(dir, 'test_books.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_books.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓平衡判定/整笔隔离/余额累加/totalDebit/CLI/单测全一致' };
    },
  },

  // ═══════════════ T3: 老化优先级任务队列（Python） ═══════════════
  {
    id: 3, name: '优先级任务队列 + 老化防饥饿（Python，确定性事件轨迹）', type: '调度算法',
    prompt: `你是调度系统工程师。在 ${D(3)}/ 交付零依赖 Python（仅标准库）带老化的优先级任务队列模拟器。
冻结夹具：\`jobs.json\`（\`{threshold, jobs: [{id, priority, arrive}]}\`；time 为整数步 0,1,2,...）。禁止修改夹具。
**必须交付（缺一不可）：sched.py、test_sched.py、README.md、report.json。**
sched.py 导出 \`{ simulate }\`：simulate(cfg) -> 调度轨迹，语义（必须逐条对上）：
- 时间步 c 从 0 起：先把 arrive == c 的任务全部加入等待队列，再选一个任务执行（本步结束 c+1），
  直到全部完成；
- 出队排序（全序）：优先级数值小者先；**同优先级**按入队等待时长 since 大者先（防饥饿）；
  再同则 id 字典序；
- **老化**：每次出队前，把每个等待中任务的当前等待时长（c − since）每满 threshold 个时间步，
  其优先级**减 1**（since 同步推进已消化的时长）；优先级减后可能与其他任务并列，按上述全序重排；
- 输出 \`{"order": [执行的 job id 序列], "finish": {id: 完成时刻c+1}, "wait": {id: 被选中执行的时刻c − arrive}}\`。
  **wait 是排队等待时长（不含自身执行那一步）**：任务在第 c 步被选中执行、于 c+1 完成，则 wait = c − arrive（**不是** finish − arrive）。
CLI：\`python3 sched.py run jobs.json\` 写当前目录 \`report.json\` = simulate 结果，退出码 0，打印摘要。
test_sched.py：\`python3 test_sched.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：同优先级先到先走、老化降权后翻转顺序、等待时长统计、单任务。
README.md（≥300 字节）：全序规则与老化口径（为何每 threshold 减 1）。
必须真实运行 CLI，并在回复中写明执行 order 与 E 的 wait 值。`,
    expect: 'sched.py + test + README + report.json', dir: D(3), frozen: ['jobs.json'],
    deliverables: [
      { file: 'sched.py', minBytes: 1000 }, { file: 'test_sched.py', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 100 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['sched.py', 'run', 'jobs.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R3)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import sched as m
cfg = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
print(json.dumps(m.simulate(cfg), sort_keys=True))
`, [dir + '/jobs.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R3)) bad.push('模块 simulate 与参考不符');
      const ac = assertCount(dir, 'test_sched.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_sched.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓全序/老化降权/等待统计/CLI/单测全一致' };
    },
  },

  // ═══════════════ T4: 正则子集 NFA 引擎（Node） ═══════════════
  {
    id: 4, name: '正则子集引擎（Node，NFA 模拟：* + ? . | [] () 转义）', type: '模式匹配',
    prompt: `你是模式匹配引擎工程师。在 ${D(4)}/ 交付零依赖 Node（CommonJS）正则子集匹配器（**整串匹配**，非搜索）。
冻结夹具：\`cases.json\`（\`{cases: [{pattern, text}]}\`）。禁止修改夹具。
**必须交付（缺一不可）：regexn.js、regexn.test.js、README.md、report.json。**
regexn.js 用 \`module.exports = { match }\` 导出：match(pattern, text) -> boolean，支持（口径必须逐条对上）：
- 字面字符；\`?\`（0 或 1）；\`*\`（0 或多）；\`+\`（1 或多）；\`.\`（任意单字符）；
- \`(\`...\`)\` 分组（无捕获）；\`|\` 选择（分组内外均按**从左到右优先级最低的顶层 | 切分支**，本夹具 | 仅出现在分组内）；
- \`[class]\` 字符类：逐字符或 \`a-z\` 区间（**无 ^ 取反**，本夹具不出现）；
- \`\\\\\` 转义下一个字符为字面量（如 \`\\\\.\` 匹配 "."）。
- 空 pattern 仅匹配空串。实现要求：NFA（Thompson 或等价状态集模拟），**不得**用回溯引擎，
  不得使用正则引擎（new RegExp 等）——自写 NFA。
CLI：\`node regexn.js run cases.json\` 写当前目录 \`report.json\` = \`{"results": [{pattern, text, matched}]}\`
（顺序与夹具一致），退出码 0，打印摘要。
regexn.test.js：\`node --test regexn.test.js\` 通过，至少 8 个断言（node:assert），覆盖：* 空/多、+ 至少一、? 可选、. 任意、
分组嵌套 +、字符类区间、转义 \\\\.、整串语义（'a*b' 不匹配 'xaab'，须整体消费）。
README.md（≥300 字节）：NFA 构建与模拟方式、整串锚定说明。
必须真实运行 CLI，并在回复中写明 '(ab)+' 对 'ababab' 与 '(ab)+' 对 'aba' 的结果。`,
    expect: 'regexn.js + test + README + report.json', dir: D(4), frozen: ['cases.json'],
    deliverables: [
      { file: 'regexn.js', minBytes: 1500 }, { file: 'regexn.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 800 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node regexn.js run cases.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.results, R4)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runProbe(dir, 'regexn.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'cases.json'), 'utf8'));
return {
  out: doc.cases.map((c) => ({ pattern: c.pattern, text: c.text, matched: m.match(c.pattern, c.text) })),
  v1: m.match('a*b', 'aaab'),
  v2: m.match('a*b', 'xxb'),
};
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.out, R4)) bad.push('模块 match 与参考不符');
        if (!probe.value.v1 || probe.value.v2) bad.push('已知向量漂移');
      }
      const ac = assertCount(dir, 'regexn.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'regexn.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓量词/分组/字符类/转义/整串语义/CLI/单测全一致' };
    },
  },

  // ═══════════════ T5: 分层配置继承覆盖 + 插值（Node） ═══════════════
  {
    id: 5, name: '分层配置继承覆盖 + ${ref} 插值（Node，深合并规则）', type: '配置系统',
    prompt: `你是平台配置工程师。在 ${D(5)}/ 交付零依赖 Node（CommonJS）分层配置合并器。
冻结夹具：\`layers.json\`（\`{layers: [{name, config}]}\`，按数组顺序 base→override，后者覆盖前者）。禁止修改夹具。
**必须交付（缺一不可）：confmerge.js、confmerge.test.js、README.md、report.json。**
confmerge.js 用 \`module.exports = { mergeLayers, resolveRefs }\` 导出：
1）\`mergeLayers(layers) -> config\`：按序深度合并，规则（必须逐条对上）：
   - 两侧均为**普通对象**：递归合并（同键以深层覆盖浅层，浅层独有键保留）；
   - 任一侧为**数组或标量或 null**：后者整体替换前者（数组**不**逐元素合并；\`null\` 值表示删除/置空，替换为 null）；
2）\`resolveRefs(config) -> config\`：深度遍历字符串值，把形如「美元符号+花括号包裹路径」的引用
   （路径由字母数字/_/-/. 组成，例如美元+{db.host}）
   替换为合并后 config 中该路径的值（字符串化）；路径不存在/值为 null/对象/数组 → 抛 Error('unresolved ref: ...')；
   同一字符串可含多个引用。返回新对象（不修改入参）。
   注：路径形如 db.host（字母数字/_/-/.），引用写作 美元符号 + 花括号包裹路径（即 shell 里常写 \$ 或 \$\{...}）。
CLI：\`node confmerge.js run layers.json\` 写当前目录 \`report.json\` = \`{"merged": resolveRefs(mergeLayers(layers))}\`，
退出码 0，打印摘要。
confmerge.test.js：\`node --test confmerge.test.js\` 通过，至少 8 个断言（node:assert），覆盖：递归深合并、
数组整体替换、null 置空、标量覆盖、单引用/多引用解析、未定义引用抛错、不修改入参。
README.md（≥300 字节）：合并规则与插值口径（为什么数组不逐元素合并）。
必须真实运行 CLI，并在回复中写明 merged.url 的值。`,
    expect: 'confmerge.js + test + README + report.json', dir: D(5), frozen: ['layers.json'],
    deliverables: [
      { file: 'confmerge.js', minBytes: 1200 }, { file: 'confmerge.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 140 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node confmerge.js run layers.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep.merged, R5.merged)) bad.push('merged 与参考不符: ' + JSON.stringify(rep.merged).slice(0, 240));
      const probe = runProbe(dir, 'confmerge.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'layers.json'), 'utf8'));
const before = JSON.stringify(doc.layers[0].config);
const out = m.resolveRefs(m.mergeLayers(doc.layers));
return { out, mutated: JSON.stringify(doc.layers[0].config) !== before };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.out, R5.merged)) bad.push('模块输出与参考不符');
        if (probe.value.mutated) bad.push('resolveRefs 修改了入参');
      }
      const ac = assertCount(dir, 'confmerge.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'confmerge.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓深合并/数组替换/null置空/引用解析/不可变/CLI/单测全一致' };
    },
  },

  // ═══════════════ T6: 日志轮转与保留策略模拟（Python） ═══════════════
  {
    id: 6, name: '日志轮转与保留策略模拟器（Python，大小/保留版本/年龄淘汰）', type: '运维模拟',
    prompt: `你是运维工程师。在 ${D(6)}/ 交付零依赖 Python（仅标准库）日志轮转与保留策略模拟器。
冻结夹具：\`rotation.json\`（\`{days, policies: {name: {maxMB, keep, maxAgeDays}}, daily: [{day, name, mb}]}\`，
daily 为 1..days 每天每个日志的当日增量 MB）。禁止修改夹具。
**必须交付（缺一不可）：rotator.py、test_rotator.py、README.md、report.json。**
rotator.py 导出 \`{ simulate }\`：simulate(spec) -> 模拟结果，语义（必须逐条对上，**按 day 1..days 逐日推进**）：
- 每日志名一个活动文件（初始 0 MB）与轮转归档列表（最旧→最新 顺序的归档序列）；
- 每日：活动文件 += 当日 mb；随后**若活动 > maxMB** 则轮转：活动文件整体归档（归档条目记 {mb, day}，
  排入归档列表末尾），活动文件清零；
- 轮转后按 keep 淘汰：归档数 > keep 时，从**最旧**开始逐条删除，直到恰剩 keep 条；
- 淘汰后（含未轮转的日）再按年龄淘汰：**当天 day** 满足 day − 归档.day >= maxAgeDays 的归档删除；
  删除按从旧到新逐条处理；上述两类删除都计入该日志 dropped（删除次数）；
- 结束后：归档条目重新编号 \`suffix = .N\`（最旧=.1，**suffix 是带前导点的字符串，如 ".1"，不是整数 1**）；日志最终态 = {activeMB（剩余活动文件）,
  retained: [{suffix, mb, day}]（最旧→最新）, dropped}。
输出 \`{"logs": {name: 上述}, "totalActiveMB": 各日志 activeMB 之和}\`。
CLI：\`python3 rotator.py run rotation.json\` 写当前目录 \`report.json\` = simulate 结果，退出码 0，打印摘要。
test_rotator.py：\`python3 test_rotator.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：恰满不轮转（== maxMB 不触发）、keep 淘汰最旧、
年龄淘汰跨日累计、空日志、多日志独立。
README.md（≥300 字节）：轮转判定（> 还是 >=）与两类淘汰顺序。
必须真实运行 CLI，并在回复中写明 access.log 的 retained 与 dropped。`,
    expect: 'rotator.py + test + README + report.json', dir: D(6), frozen: ['rotation.json'],
    deliverables: [
      { file: 'rotator.py', minBytes: 1200 }, { file: 'test_rotator.py', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 160 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['rotator.py', 'run', 'rotation.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R6)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import rotator as m
spec = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
print(json.dumps(m.simulate(spec), sort_keys=True))
`, [dir + '/rotation.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R6)) bad.push('模块 simulate 与参考不符');
      const ac = assertCount(dir, 'test_rotator.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_rotator.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓轮转判定/keep淘汰/年龄淘汰/suffix编号/CLI/单测全一致' };
    },
  },

  // ═══════════════ T7: Gossip 反熵收敛（Python） ═══════════════
  {
    id: 7, name: 'Gossip 反熵收敛 + 法定数判定（Python，LCG 确定性）', type: '分布式系统',
    prompt: `你是分布式系统工程师。在 ${D(7)}/ 交付零依赖 Python（仅标准库）gossip 反熵收敛模拟器。
冻结夹具：\`gossip.json\`（\`{n, seed, rounds, k, initial: [每节点 {entries: {key: {v, ver}}}], quorum: {n, w, r}}\`）。禁止修改夹具。
**必须交付（缺一不可）：gossip.py、test_gossip.py、README.md、report.json。**
gossip.py 导出 \`{ run_gossip }\`：run_gossip(spec) -> 结果，语义（必须逐条对上）：
- 确定性对子抽样：每轮从全部 C(n,2) 个节点对里，用 LCG（\`x = (x * 1103515245 + 12345) % 2147483648\`，
  x0 = seed）驱动 Fisher-Yates 洗牌取前 k 对（每轮 2×k 次 LCG 步进）；
- 每对 (a,b)（a<b）双向同步：每节点对每个 key 取 **(ver 大者胜；ver 相同则来自下标大者节点)** 的条目
  （两节点交换后各自持有全局最优）；
- rounds 轮后：converged = 所有节点的 {key: v} 视图（**忽略 ver，只比 v 键值对**）是否逐一相等；
- 法定数判定：guaranteed = (w + r > n)（w/r/n 取夹具 quorum 字段）。
输出 \`{"converged": bool, "state": [每节点 {key: v}（键字典序）], "quorum": {"n", "w", "r", "guaranteed"}}\`。
CLI：\`python3 gossip.py run gossip.json\` 写当前目录 \`report.json\` = run_gossip 结果，退出码 0，打印摘要。
test_gossip.py：\`python3 test_gossip.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：单轮对子抽样确定性（同一 seed 重放两次同结果）、
ver 高者胜、同 ver 下标大者胜、converged 判定、quorum 公式边界（w+r==n 不保证）。
README.md（≥300 字节）：LCG 步进顺序（每轮 2k 次）与冲突消解口径。
必须真实运行 CLI，并在回复中写明 converged 值与每个节点的 c 键值。`,
    expect: 'gossip.py + test + README + report.json', dir: D(7), frozen: ['gossip.json'],
    deliverables: [
      { file: 'gossip.py', minBytes: 1200 }, { file: 'test_gossip.py', minBytes: 600 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 180 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['gossip.py', 'run', 'gossip.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R7)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import gossip as m
spec = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
print(json.dumps(m.run_gossip(spec), sort_keys=True))
`, [dir + '/gossip.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R7)) bad.push('模块 run_gossip 与参考不符');
      const ac = assertCount(dir, 'test_gossip.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_gossip.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓LCG抽样/ver消解/收敛判定/法定数/CLI/单测全一致' };
    },
  },

  // ═══════════════ T8: Count-min 重击者（Node） ═══════════════
  {
    id: 8, name: 'Count-min 重击者 top-k（Node，fnv1a 钉死哈希）', type: '流式统计',
    prompt: `你是流式统计工程师。在 ${D(8)}/ 交付零依赖 Node（CommonJS）Count-min Sketch 重击者检测器。
冻结夹具：\`counts.json\`（\`{width, depth, k, stream: [string...]}\`）。禁止修改夹具。
**必须交付（缺一不可）：sketch.js、sketch.test.js、README.md、report.json。**
sketch.js 用 \`module.exports = { fnv1a, countMin, heavyHitters }\` 导出，口径（必须逐条对上）：
1）\`fnv1a(s) -> number\`：32 位 FNV-1a——初值 2166136261，逐字节 \`(h ^ byte) * 16777619\`，结果取无符号 32 位
  （已知向量：fnv1a("123456789") === 3146166556，fnv1a("") === 2166136261；**不得**用任何第三方/内置哈希；
  注意 32 位回绕须在每字节步内完成（如 0xffffffff 掩码），浮点乘法精度不足会产生错误值）；
2）\`countMin(width, depth)\` 返回 sketch：\`update(key)\`（第 r 层槽 = fnv1a(key + "|" + r) % width 各 +1）
  与 \`estimate(key)\` = 各层对应槽计数取**最小值**；
3）\`heavyHitters(cfg, stream)\` -> \`{top, distinct}\`：对 cfg.stream 逐元素 update；distinct = 流中不同键数；
   top = 前 k 项（按 est 降序，est 相同按键字典序升序），每项 \`{key, est}\`。
CLI：\`node sketch.js run counts.json\` 写当前目录 \`report.json\` = \`{"fnv": {"empty": fnv1a(""), "123456789": fnv1a("123456789")}, "heavy": heavyHitters 结果}\`，
退出码 0，打印摘要。
sketch.test.js：\`node --test sketch.test.js\` 通过，至少 8 个断言（node:assert），覆盖：fnv1a 两个已知向量、
update 后各层槽计数、estimate 取最小、碰撞导致 est >= 真实计数（可构造 2 键撞槽用例）、
top 排序（含 est 相同字典序）、distinct 计数。
README.md（≥300 字节）：Count-min 上偏性质（为何 est >= 真实值）与钉死哈希的原因。
必须真实运行 CLI，并在回复中写明 top 三项的 key 与 est。`,
    expect: 'sketch.js + test + README + report.json', dir: D(8), frozen: ['counts.json'],
    deliverables: [
      { file: 'sketch.js', minBytes: 1200 }, { file: 'sketch.test.js', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 80 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node sketch.js run counts.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else {
        if (!sameJson(rep.heavy, R8)) bad.push('heavy 与参考不符: ' + JSON.stringify(rep.heavy).slice(0, 200));
        if (rep.fnv?.empty !== t8Fnv('') || rep.fnv?.['123456789'] !== t8Fnv('123456789')) bad.push('fnv 已知向量不符: ' + JSON.stringify(rep.fnv));
      }
      const probe = runProbe(dir, 'sketch.js', `
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'counts.json'), 'utf8'));
const sk = m.countMin(cfg.width, cfg.depth);
for (const key of cfg.stream) sk.update(key);
return {
  fnvE: m.fnv1a(''),
  fnvV: m.fnv1a('123456789'),
  heavy: m.heavyHitters(cfg, cfg.stream),
  estAnt: sk.estimate('ant'),
};
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else {
        if (!sameJson(probe.value.heavy, R8)) bad.push('模块 heavyHitters 与参考不符');
        if (probe.value.estAnt !== R8.top[0].est) bad.push('模块 estimate 漂移');
        if (probe.value.fnvE !== t8Fnv('') || probe.value.fnvV !== t8Fnv('123456789')) bad.push('模块 fnv1a 向量漂移');
      }
      const ac = assertCount(dir, 'sketch.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'sketch.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓fnv向量/计数/最小估计/top排序/CLI/单测全一致' };
    },
  },

  // ═══════════════ T9: EDF 实时调度模拟（Python） ═══════════════
  {
    id: 9, name: 'EDF 实时调度模拟器（Python，抢占/截止期/周期实例）', type: '实时调度',
    prompt: `你是实时系统工程师。在 ${D(9)}/ 交付零依赖 Python（仅标准库）EDF（最早截止期优先）调度模拟器。
冻结夹具：\`edf.json\`（\`{horizon, jobs: [{id, release, period, deadline, exec}]}\`，period=0 表示一次性任务；
horizon 为时间步上界（含））。禁止修改夹具。
**必须交付（缺一不可）：edf.py、test_edf.py、README.md、report.json。**
edf.py 导出 \`{ simulate_edf }\`：simulate_edf(spec) -> 调度轨迹，语义（必须逐条对上）：
- 实例生成：period>0 的任务在 release, release+period, ... 且 release+k*period <= horizon 的时刻各生成实例
  \`id#k\`（截止期 deadline + k*period，需时 exec）；period=0 生成唯一实例 \`id#0\`（截止期 deadline，需时 exec）；
- 逐时间步 c = 0..horizon：在**已释放且未完成**的实例中，按（截止期小者先；同截止期实例 id 字典序先）
  取一个执行 1 步（**抢占**：每步重新按截止期排序，正在跑的实例若不再最优先则让出）；无可执行实例则空转；
- 实例在 c 步执行后剩余为 0 即完成，finish 记录 c+1；若 c+1 > 该实例截止期则记 missed（**完成即判定**，
  不要求完成时刻 <= 截止期，超期完成也记入 missed）；
- 输出 \`{"order": [每步执行的实例 id（空转步记 null）], "finish": {实例id: 时刻}, "missed": [按完成顺序的超期实例]}\`。
CLI：\`python3 edf.py run edf.json\` 写当前目录 \`report.json\` = simulate_edf 结果，退出码 0，打印摘要。
test_edf.py：\`python3 test_edf.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`，中文注释可以；裸 \`assert\` 语句亦可），覆盖：周期实例生成边界（<= horizon）、同截止期 id 序、
抢占让出、空转 null、一次性任务、missed 判定（完成时刻 > 截止期）。
README.md（≥300 字节）：实例生成公式与 missed 判定口径。
必须真实运行 CLI，并在回复中写明 missed 列表与首步执行的实例。`,
    expect: 'edf.py + test + README + report.json', dir: D(9), frozen: ['edf.json'],
    deliverables: [
      { file: 'edf.py', minBytes: 1200 }, { file: 'test_edf.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 150 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['edf.py', 'run', 'edf.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R9)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runPy(dir, `
import sys, json
sys.path.insert(0, ${pyPath(dir)})
import edf as m
spec = json.loads(${pyReadTextLiteral(`sys.argv[1]`)})
print(json.dumps(m.simulate_edf(spec), sort_keys=True))
`, [dir + '/edf.json']);
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R9)) bad.push('模块 simulate_edf 与参考不符');
      const ac = assertCount(dir, 'test_edf.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_edf.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓实例生成/抢占/截止期排序/missed/CLI/单测全一致' };
    },
  },

  // ═══════════════ T10: 图形原语渲染（Node） ═══════════════
  {
    id: 10, name: '图形原语：Bresenham 线/矩形描边/泛洪填充 + 像素统计（Node）', type: '图形渲染',
    prompt: `你是图形系统工程师。在 ${D(10)}/ 交付零依赖 Node（CommonJS）小画布图形原语渲染器。
冻结夹具：\`ops.json\`（\`{w, h, ops: [{op: "line"|"rect"|"fill", ...}]}\`；line: {x0,y0,x1,y1}；
rect: {x,y,w,h}；fill: {x,y}）。禁止修改夹具。
**必须交付（缺一不可）：canvas2d.js、canvas2d.test.js、README.md、report.json。**
canvas2d.js 用 \`module.exports = { render } 导出：render(spec) -> 结果，语义（必须逐条对上）：
- 画布 w×h，像素初值 0，渲染后置 255；**每操作前**统计将首次置 255 的像素数（已 255 的不计重）；
- line：经典 **Bresenham 整数线**（dx/abs/sy 误差累加版，含负斜率），逐点 set；
- rect：\`w×h\` 的**描边框**（上下边完整、左右边补内侧两行；注意 w=1 或 h=1 时退化为线/点）；
- fill：从 (x,y) 出发的 **4 连通泛洪**，仅填连续 0 区域（被非 0 像素包围则填 0 个）；
输出 \`{"rowsB64": 画布按行序（y 外 x 内）每像素 1 字节 0/255 的 base64, "stats": [{i, op, pixels}]（按 ops 顺序）}\`。
CLI：\`node canvas2d.js run ops.json\` 写当前目录 \`report.json\` = render 结果，退出码 0，打印摘要。
canvas2d.test.js：\`node --test canvas2d.test.js\` 通过，至少 8 个断言（node:assert），覆盖：对角线 12 像素、
矩形描边 2*(w+h)-4、泛洪连通域计数、已填充像素不重复计数、w=1 退化 rect、越界坐标忽略（line 端点越界
只画画布内部分——夹具不出现，测试可自行构造）。
README.md（≥300 字节）：Bresenham 误差更新与 4 连通泛洪口径。
必须真实运行 CLI，并在回复中写明首条 line 的 pixels 值。`,
    expect: 'canvas2d.js + test + README + report.json', dir: D(10), frozen: ['ops.json'],
    deliverables: [
      { file: 'canvas2d.js', minBytes: 1400 }, { file: 'canvas2d.test.js', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 340 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node canvas2d.js run ops.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileExistsJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R10)) bad.push('report 与参考不符: ' + JSON.stringify(rep).slice(0, 240));
      const probe = runProbe(dir, 'canvas2d.js', `
const fs = require('fs');
const path = require('path');
const spec = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'ops.json'), 'utf8'));
return m.render(spec);
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value, R10)) bad.push('模块 render 与参考不符');
      const ac = assertCount(dir, 'canvas2d.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'canvas2d.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓Bresenham/描边/泛洪/不重复计数/CLI/单测全一致' };
    },
  },
];

// 顶层预计算参考（exec 闭包引用）
const R1 = t1Ref();
const R2 = t2Ref();
const R3 = t3Ref();
const R4 = t4Ref();
const R5 = t5Ref();
const R6 = t6Ref();
const R7 = t7Ref();
const R8 = t8Ref();
const R9 = t9Ref();
const R10 = t10Ref();
