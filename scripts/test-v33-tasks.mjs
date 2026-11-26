/**
 * EvoClaw v33 压测任务定义（10 任务）与核验器。
 * 主题：工程实用性更强的「生产系统组件」——开关引擎/Webhook/指标/分页/迁移/哈希环/
 * 异常检测/审计链/i18n/分布式 ID。
 * 核验纪律：harness 自带参考实现复算（test-v33-lib.mjs），不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runPy, runProbe, readFileSafe } from './v14/lib.mjs';
import {
  D, sameJson, diffNote, pyReadTextLiteral, pyLoadModule,
  t1Ref, t2Ref, t3Ref, t4Ref, T4_FIXTURE, t5Ref, t6Ref, t7Ref, t8Ref, t9Ref, t10Ref,
} from './test-v33-lib.mjs';

// 断言行判定（与 v30–v32 同口径 + 中文助手族 + assert* 族）。
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
const fileJson = (dir, file) => extractJson(readFileSafe(path.join(dir, file)));

const pyRun = (dir, args, timeoutMs = 90000) => {
  try {
    const out = execSync(`timeout 80 python3 ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 124, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
};
const pyProbe = (dir, moduleFile, fixtureFile, expr) => runPy(dir, `
import json, sys
${pyLoadModule('t33mod', dir + '/' + moduleFile)}
spec = json.loads(${pyReadTextLiteral('sys.argv[1]')})
print(json.dumps(${expr}, sort_keys=True, ensure_ascii=False))
`, [dir + '/' + fixtureFile]);

export const tasks = [
  // ═══════════════ T1: 功能开关求值引擎（Python） ═══════════════
  {
    id: 1, name: '功能开关求值引擎（Python，规则优先级 + fnv1a 灰度分桶）', type: '配置/灰度',
    prompt: `你是平台工程师。在 ${D(1)}/ 交付零依赖 Python（仅标准库）功能开关求值引擎。
冻结夹具：\`flags.json\`（\`{flags: [...], contexts: [...]}\`）。禁止修改夹具。
**必须交付（缺一不可）：flagd.py、test_flagd.py、README.md、report.json。**
flagd.py 导出 \`evaluate(spec)\`，返回 \`{"results": [{"userId", "flags": {key: {"value": bool, "reason": str}}}...],
"counts": {key: 值为 true 的 context 数}}\`（results 顺序与 contexts 一致；每个 context 的 flags 必须包含**全部** flag）。
单个 flag 判定顺序（必须逐条对上）：
1）\`enabled == false\` → \`{"value": false, "reason": "disabled"}\`（kill switch 最高优先，规则与灰度都不看）；
2）按 rules 数组顺序，**首个**全部条件成立的规则胜出 → \`{"value": <rule.value>, "reason": "rule:<下标>"}\`
   （下标为十进制，如 \`rule:0\`）；条件全为 AND；属性缺失（\`ctx[attr] === undefined\`）一律视为不匹配；
   比较运算符：\`eq\`/\`neq\`（严格相等）、\`in\`（value 为数组且包含属性值）、\`gt\`/\`lt\`（仅当两侧都是数字）；
3）有 rollout 时：\`bucket = fnv1a32(salt + ":" + userId) % 100\`，
   \`{"value": bucket < percentage, "reason": "rollout"}\`；
4）否则 \`{"value": default, "reason": "default"}\`。
fnv1a32 口径（必须逐字节复刻，UTF-8 字节序）：\`h = 0x811c9dc5\`；对每个字节 b：\`h ^= b; h = (h * 0x01000193) & 0xFFFFFFFF\`；返回 h。
CLI：\`python3 flagd.py run flags.json\` 写当前目录 \`report.json\` = evaluate 结果，退出码 0，打印摘要。
test_flagd.py：\`python3 test_flagd.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**，如 \`assert_eq\`/\`check\`；
中文注释可以；裸 \`assert\` 亦可），覆盖：kill switch 优先于规则、规则按序首个命中、属性缺失不匹配、
in/gt/lt 各一例、灰度桶确定性（同 userId 重复求值一致）、counts 与 results 自洽、default 分支。
README.md（≥300 字节）：判定优先级与 fnv1a32 分桶口径。
必须真实运行 CLI，并在回复中写明 checkout-v2 命中 true 的数量。`,
    expect: 'flagd.py + test + README + report.json', dir: D(1), frozen: ['flags.json'],
    deliverables: [
      { file: 'flagd.py', minBytes: 1200 }, { file: 'test_flagd.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 200 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['flagd.py', 'run', 'flags.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R1)) bad.push('report 与参考不符: ' + diffNote(rep, R1));
      const probe = pyProbe(dir, 'flagd.py', 'flags.json', 'm.evaluate(spec)');
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R1)) bad.push('模块 evaluate 与参考不符: ' + diffNote(probe.value, R1));
      const ac = assertCount(dir, 'test_flagd.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_flagd.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓killSwitch/规则序/灰度桶/counts/CLI/单测全一致' };
    },
  },

  // ═══════════════ T2: Webhook 投递引擎（Node） ═══════════════
  {
    id: 2, name: 'Webhook 投递引擎（Node，HMAC 签名 + 重试时间线 + 幂等去重 + 死信）', type: '集成/可靠性',
    prompt: `你是集成平台工程师。在 ${D(2)}/ 交付零依赖 Node（CommonJS）Webhook 投递引擎。
冻结夹具：\`hooks.json\`（\`{secret, baseTs, maxAttempts, retryDelaysMs, capMs, deliveries: [{id, event, outcomes}]}\`）。
禁止修改夹具。
**必须交付（缺一不可）：webhook.js、webhook.test.js、README.md、report.json。**
webhook.js 用 \`module.exports = { deliver }\` 导出：deliver(spec) -> \`{deliveries, dlq, summary}\`，口径（必须逐条对上）：
- **幂等**：按 \`event.id\` 去重，首次出现正常投递；重复出现 → \`{"id", "status": "duplicate", "attempts": 0,
  "deadLettered": false, "signatures": [], "timeline": []}\`，不消耗尝试；
- 首次投递：最多 \`maxAttempts\` 次尝试；第 k 次（0 起）的 \`outcomes[k]\` 为 2xx → \`status: "delivered"\` 立即停止；
  outcomes 不够长时按失败（599）处理；
- 第 k 次失败后，若仍有剩余尝试，累计等待 \`retryDelaysMs[k]\`（下标越界则用 \`capMs\`）；
  \`timeline\` = 每次尝试的**累计**等待毫秒（第 0 次恒为 0）；
- 每次尝试生成签名：\`HMAC-SHA256(secret, ts + "." + body)\` 的**小写 hex 全串**，
  其中 \`ts = baseTs + timeline[k]\`，\`body\` = event 的规范 JSON
  （对象键在每层按字典序、无空白、分隔符 \`,\` 与 \`:\`、UTF-8、非 ASCII 不转义）；
- 尝试耗尽仍失败 → \`status: "dead"\`、\`deadLettered: true\`，并把**该投递的 \`id\`**（即 \`deliveries[].id\`，
  **不是** \`event.id\`）按出现顺序追加进 \`dlq\`；
- \`summary\` = \`{delivered, dead, duplicates}\` 三个计数（duplicate 不计入 dead）。
CLI：\`node webhook.js run hooks.json\` 写当前目录 \`report.json\` = deliver 结果，退出码 0，打印摘要。
webhook.test.js：\`node --test webhook.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
幂等重复不消耗尝试、成功即停、时间线累计偏移、capMs 兜底、签名条数==尝试数、HMAC 已知向量
（secret='key'、data='The quick brown fox jumps over the lazy dog' → f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8）、
死信入 dlq、summary 自洽。
README.md（≥300 字节）：签名串构造、重试与死信语义。
必须真实运行 CLI，并在回复中写明 delivered/dead/duplicates 三个数。`,
    expect: 'webhook.js + test + README + report.json', dir: D(2), frozen: ['hooks.json'],
    deliverables: [
      { file: 'webhook.js', minBytes: 1400 }, { file: 'webhook.test.js', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node webhook.js run hooks.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R2)) bad.push('report 与参考不符: ' + diffNote(rep, R2));
      const probe = runProbe(dir, 'webhook.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'hooks.json'), 'utf8'));
return { out: m.deliver(doc) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value.out, R2)) bad.push('模块 deliver 与参考不符: ' + diffNote(probe.value.out, R2));
      const ac = assertCount(dir, 'webhook.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'webhook.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓幂等/重试时间线/签名/死信/CLI/单测全一致' };
    },
  },

  // ═══════════════ T3: 指标下采样 + rollup（Python） ═══════════════
  {
    id: 3, name: '时序指标下采样 + 分层 rollup（Python，乱序/空窗/p95）', type: '可观测性',
    prompt: `你是可观测性工程师。在 ${D(3)}/ 交付零依赖 Python（仅标准库）时序指标下采样器。
冻结夹具：\`metrics.json\`（\`{startMs, widthMs, count, points: [{ts, v}]}\`；points **乱序**且含范围外点）。
禁止修改夹具。
**必须交付（缺一不可）：metrics.py、test_metrics.py、README.md、report.json。**
metrics.py 导出 \`downsample(spec)\` -> \`{"windows": [...], "rollups": [...], "dropped": int}\`，口径（必须逐条对上）：
- 有效范围 \`[startMs, startMs + count*widthMs)\`；范围外点丢弃并计入 \`dropped\`；
- 窗口下标 = \`(ts - startMs) // widthMs\`，共 count 个窗口；
- 每窗口统计 \`{"count", "avg", "max", "p95"}\`：\`avg\` = 算术平均，保留 6 位小数（\`round(x, 6)\`）；
  \`max\` = 最大值；\`p95\` 用 **nearest-rank**：升序排序后取下标 \`ceil(0.95*n) - 1\`；
- 空窗口 = \`{"count": 0, "avg": null, "max": null, "p95": null}\`；
- \`rollups\`：每 **4** 个连续窗口合成一个（末尾不足 4 个的余数窗口不产生 rollup）：
  \`count\` = 组内 count 之和；\`avg\` = 按 count 加权的平均（保留 6 位小数）；\`max\` = 组内非空窗口 max 的最大值；
  \`p95\` = 组内非空窗口 p95 的最大值；若组内全空 → 三项 null。
CLI：\`python3 metrics.py run metrics.json\` 写当前目录 \`report.json\` = downsample 结果，退出码 0，打印摘要。
test_metrics.py：\`python3 test_metrics.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**；中文注释可以；裸 \`assert\` 亦可），覆盖：
范围外点丢弃计数、乱序输入不影响结果、空窗三项 null、nearest-rank p95 边界（n=1/n=2/n=4）、
avg 加权、rollup count 求和、rollup max 取非空最大值、窗口数==count。
README.md（≥300 字节）：nearest-rank 分位口径与 rollup 加权规则。
必须真实运行 CLI，并在回复中写明第 0 个窗口的 p95 与第 2 个 rollup 的 avg。`,
    expect: 'metrics.py + test + README + report.json', dir: D(3), frozen: ['metrics.json'],
    deliverables: [
      { file: 'metrics.py', minBytes: 1200 }, { file: 'test_metrics.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['metrics.py', 'run', 'metrics.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R3)) bad.push('report 与参考不符: ' + diffNote(rep, R3));
      const probe = pyProbe(dir, 'metrics.py', 'metrics.json', 'm.downsample(spec)');
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R3)) bad.push('模块 downsample 与参考不符: ' + diffNote(probe.value, R3));
      const ac = assertCount(dir, 'test_metrics.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_metrics.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓范围过滤/空窗/p95/rollup加权/CLI/单测全一致' };
    },
  },

  // ═══════════════ T4: 不透明游标分页（Node） ═══════════════
  {
    id: 4, name: '不透明游标分页（Node，base64url + HMAC 防篡改 + 排序签名）', type: 'API 设计',
    prompt: `你是 API 平台工程师。在 ${D(4)}/ 交付零依赖 Node（CommonJS）游标分页模块。
冻结夹具：\`page.json\`（\`{secret, pageSize, sort: [{field, dir}], items: [{id, ...}]}\`）。禁止修改夹具。
**必须交付（缺一不可）：paginate.js、paginate.test.js、README.md、report.json。**
paginate.js 用 \`module.exports = { paginate, encodeCursor, decodeCursor }\` 导出，口径（必须逐条对上）：
- 排序：按 \`sort\` 数组逐键比较，\`dir\` 为 \`"asc"|"desc"\`；所有键相等时按 \`id\` **升序**（不随 dir 反转）；
- \`sortHash\` = \`sha256(规范JSON(sort))\` 的**前 8 位小写 hex**；
- 游标 payload = \`{"o": <下一页起始下标>, "s": <sortHash>, "v": 1}\` 的规范 JSON
  （键按字典序、无空白、分隔符 \`,\` \`:\`、UTF-8）→ 标准 base64url（无填充）；
  游标 = \`<b64> + "." + HMAC-SHA256(secret, b64) 的前 16 位小写 hex\`；
- \`paginate(spec)\` -> \`{"pages": [{"items": [id...], "cursor": 下一页游标|null}], "resumed": [id...],
  "tamperRejected": bool, "sortMismatchRejected": bool}\`：
  首页从 0 开始；末页 \`cursor = null\`；\`resumed\` = 用首页游标解出的 offset 处再取一页的 id 数组；
  \`tamperRejected\` = 把首页游标第一个字符改掉后 \`decodeCursor\` **必须抛错**；
  \`sortMismatchRejected\` = 用不同的 sort 调 \`decodeCursor\` **必须抛错**；
- \`decodeCursor(cursor, sort, secret)\` -> \`{"offset": int}\`，格式错/长度≠2 段/MAC 不符/版本≠1/排序签名不符 → 抛错
  （错误信息分别含 \`bad_cursor_format\` / \`bad_cursor_mac\` / \`bad_cursor_version\` / \`sort_mismatch\`）。
CLI：\`node paginate.js run page.json\` 写当前目录 \`report.json\` = paginate 结果，退出码 0，打印摘要。
paginate.test.js：\`node --test paginate.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
多键排序（含 desc）、id 升序兜底、页大小与末页 cursor=null、续页不重复不遗漏、
篡改首字符抛错、换排序抛错、错误码文案、sortHash 稳定性（同 sort 多次一致）。
README.md（≥300 字节）：游标载荷结构、HMAC 校验与排序签名绑定。
必须真实运行 CLI，并在回复中写明首页的 id 列表。`,
    expect: 'paginate.js + test + README + report.json', dir: D(4), frozen: ['page.json'],
    deliverables: [
      { file: 'paginate.js', minBytes: 1400 }, { file: 'paginate.test.js', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node paginate.js run page.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R4)) bad.push('report 与参考不符: ' + diffNote(rep, R4));
      const probe = runProbe(dir, 'paginate.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'page.json'), 'utf8'));
return { out: m.paginate(doc) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value.out, R4)) bad.push('模块 paginate 与参考不符: ' + diffNote(probe.value.out, R4));
      const ac = assertCount(dir, 'paginate.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'paginate.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓排序/游标/防篡改/排序签名/CLI/单测全一致' };
    },
  },

  // ═══════════════ T5: 迁移编排器（Python） ═══════════════
  {
    id: 5, name: '数据库迁移编排器（Python，拓扑 + 校验和幂等 + 失败逆序回滚）', type: '数据/运维',
    prompt: `你是数据库平台工程师。在 ${D(5)}/ 交付零依赖 Python（仅标准库）迁移编排器。
冻结夹具：\`migrations.json\`（\`{applied: [{id, checksum}], migrations: [{id, deps, sql}], failAt}\`）。
禁止修改夹具。
**必须交付（缺一不可）：migrate.py、test_migrate.py、README.md、report.json。**
migrate.py 导出 \`plan_and_run(spec)\` -> \`{"order", "plan", "executed", "rolledBack", "status", "errors"}\`，口径（必须逐条对上）：
- \`checksum\` = \`sha256(sql.encode("utf-8"))\` 的**全 64 位小写 hex**；
- 校验：任一已应用迁移的 checksum 与重算不符 → \`status: "invalid"\`、\`errors\` 含 \`"checksum_mismatch:<id>"\`，
  其余字段为空数组，**不执行任何迁移**；
- 依赖完整性：deps 引用不存在的 id → \`"invalid"\` + \`"missing_dep:<id>-><dep>"\`；
- 拓扑序：Kahn 算法，就绪集合每次取**字典序最小**者（最小堆语义）；存在环 → \`"invalid"\` + \`"cycle"\`；
- \`plan\` = 拓扑序逐项 \`{"id", "action"}\`，已应用且校验和一致 → \`"skip"\`，否则 \`"apply"\`；
- 按 plan 顺序执行：skip 不动；遇到 id == failAt → \`status: "aborted"\`、\`errors\` 追加 \`"failed:<id>"\`，
  并把**本次已执行**的迁移按**逆序**写入 \`rolledBack\`，立即停止；
- 全部成功 → \`status: "ok"\`、\`errors: []\`。
CLI：\`python3 migrate.py run migrations.json\` 写当前目录 \`report.json\` = plan_and_run 结果，退出码 0，打印摘要。
test_migrate.py：\`python3 test_migrate.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**；中文注释可以；裸 \`assert\` 亦可），覆盖：
拓扑序字典序稳定、已应用 skip、checksum 不符拦截、缺失依赖拦截、环检测、failAt 逆序回滚、
全成功 status=ok、executed 与 plan 一致。
README.md（≥300 字节）：Kahn + 最小堆的确定性、校验和幂等与回滚语义。
必须真实运行 CLI，并在回复中写明 rolledBack 列表。`,
    expect: 'migrate.py + test + README + report.json', dir: D(5), frozen: ['migrations.json'],
    deliverables: [
      { file: 'migrate.py', minBytes: 1400 }, { file: 'test_migrate.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 200 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['migrate.py', 'run', 'migrations.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R5)) bad.push('report 与参考不符: ' + diffNote(rep, R5));
      const probe = pyProbe(dir, 'migrate.py', 'migrations.json', 'm.plan_and_run(spec)');
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R5)) bad.push('模块 plan_and_run 与参考不符: ' + diffNote(probe.value, R5));
      const ac = assertCount(dir, 'test_migrate.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_migrate.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓拓扑序/checksum/skip/逆序回滚/CLI/单测全一致' };
    },
  },

  // ═══════════════ T6: 一致性哈希环（Node） ═══════════════
  {
    id: 6, name: '一致性哈希环 + 再平衡（Node，虚拟节点 + crc32 钉死 + 最小迁移）', type: '分布式',
    prompt: `你是分布式存储工程师。在 ${D(6)}/ 交付零依赖 Node（CommonJS）一致性哈希环。
冻结夹具：\`ring.json\`（\`{vnodes, nodes, keys, add, remove}\`）。禁止修改夹具。
**必须交付（缺一不可）：ring.js、ring.test.js、README.md、report.json。**
ring.js 用 \`module.exports = { assign }\` 导出：assign(spec) -> \`{owners, rebalanceAdd, rebalanceRemove, distribution}\`，口径（必须逐条对上）：
- 环点：对每个 node、每个 \`i ∈ [0, vnodes)\` 生成 \`point = zlib.crc32(Buffer.from(node + "#" + i, "utf8"))\`
  （**必须用 zlib.crc32，逐字复刻**）；环点按 \`(point, node 字典序, i)\` 升序；
- 键归属：\`h = crc32(Buffer.from(key, "utf8"))\`，取**第一个 point ≥ h** 的环点所属 node；
  若无（h 大于所有 point）→ 回绕到**第 0 个**环点；
- \`owners\` = \`{key: node}\`（基于 \`spec.nodes\` 原环）；
- \`rebalanceAdd\` = \`{moved: [{key, from, to}...], count}\`：用 \`nodes + [add]\` 独立建环，
  归属相对原环变化的键，按 key **字典序升序**；
- \`rebalanceRemove\` = 同样结构，用 \`nodes 去掉 remove\` 独立建环；
- \`distribution\` = \`{node: 该 node 在原环下拥有的 key 数}\`（覆盖 spec.nodes 全部节点，无 key 则为 0）。
CLI：\`node ring.js run ring.json\` 写当前目录 \`report.json\` = assign 结果，退出码 0，打印摘要。
ring.test.js：\`node --test ring.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
crc32 已知向量（crc32('123456789')==3421780262）、环点排序稳定性、回绕到 0 号点、
加节点只从其它节点抢 key（to 恒为新增节点）、删节点只迁移该节点原有 key（from 恒为被删节点）、
count 与 moved.length 一致、distribution 求和==keys.length、同输入重复调用结果一致。
README.md（≥300 字节）：虚拟节点与顺时针查找口径、再平衡最小迁移性质。
必须真实运行 CLI，并在回复中写明 rebalanceAdd 的 count。`,
    expect: 'ring.js + test + README + report.json', dir: D(6), frozen: ['ring.json'],
    deliverables: [
      { file: 'ring.js', minBytes: 1200 }, { file: 'ring.test.js', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node ring.js run ring.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R6)) bad.push('report 与参考不符: ' + diffNote(rep, R6));
      const probe = runProbe(dir, 'ring.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'ring.json'), 'utf8'));
return { out: m.assign(doc) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value.out, R6)) bad.push('模块 assign 与参考不符: ' + diffNote(probe.value.out, R6));
      const ac = assertCount(dir, 'ring.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'ring.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓环点/回绕/再平衡最小迁移/分布/CLI/单测全一致' };
    },
  },

  // ═══════════════ T7: EWMA 异常检测（Python） ═══════════════
  {
    id: 7, name: '日志异常检测 EWMA + 3σ（Python，冷启动 + 连续去抖）', type: '监控/统计',
    prompt: `你是 SRE 工程师。在 ${D(7)}/ 交付零依赖 Python（仅标准库）EWMA 异常检测器。
冻结夹具：\`anomaly.json\`（\`{alpha, warmup, threshold, minStreak, series: [数]}\`）。禁止修改夹具。
**必须交付（缺一不可）：anomaly.py、test_anomaly.py、README.md、report.json。**
anomaly.py 导出 \`detect(spec)\` -> \`{"alerts": [{index, value, direction}...], "anomalies": int, "evaluated": int}\`，口径（必须逐条对上）：
- 初始化 \`mean = series[0]\`、\`var = 0\`；
- 对 i ≥ 1：**先用上一步的 mean/var 算 z**：\`z = (x_i - mean_prev) / sqrt(var_prev)\`（var_prev == 0 时 z = 0），
  **再**更新 \`mean = alpha*x_i + (1-alpha)*mean_prev\`、\`var = alpha*(x_i - mean_prev)^2 + (1-alpha)*var_prev\`；
- 仅当 \`i >= warmup\` 才参与评估（之前只更新状态）；\`evaluated = max(0, len(series) - warmup)\`；
- 异常判定 \`|z| > threshold\`；统计 \`anomalies\` 为评估期异常点总数；
- **连续去抖**：连续异常计数达到 \`minStreak\` 时，在**该下标**产出一次告警
  \`{"index": i, "value": x_i, "direction": "up"|"down"}\`（z>0 为 up），随后继续计数（同一段连续异常只在达到
  minStreak 时告警一次；中间出现正常点则计数清零）。
CLI：\`python3 anomaly.py run anomaly.json\` 写当前目录 \`report.json\` = detect 结果，退出码 0，打印摘要。
test_anomaly.py：\`python3 test_anomaly.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**；中文注释可以；裸 \`assert\` 亦可），覆盖：
冷启动期不告警、单点尖峰不告警（streak 不足）、连续异常告警一次且方向正确、
出现正常点后 streak 清零、var 为 0 时 z=0、evaluated 计算、anomalies 计数、minStreak=1 时首个异常即告警。
README.md（≥300 字节）：EWMA 均值/方差递推式与「先算 z 后更新」的顺序、去抖语义。
必须真实运行 CLI，并在回复中写明 alerts 的条数与下标。`,
    expect: 'anomaly.py + test + README + report.json', dir: D(7), frozen: ['anomaly.json'],
    deliverables: [
      { file: 'anomaly.py', minBytes: 1000 }, { file: 'test_anomaly.py', minBytes: 700 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 120 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['anomaly.py', 'run', 'anomaly.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R7)) bad.push('report 与参考不符: ' + diffNote(rep, R7));
      const probe = pyProbe(dir, 'anomaly.py', 'anomaly.json', 'm.detect(spec)');
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R7)) bad.push('模块 detect 与参考不符: ' + diffNote(probe.value, R7));
      const ac = assertCount(dir, 'test_anomaly.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_anomaly.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓冷启动/先算z后更新/去抖/计数/CLI/单测全一致' };
    },
  },

  // ═══════════════ T8: 审计哈希链（Node） ═══════════════
  {
    id: 8, name: '审计日志哈希链（Node，规范 JSON + SHA-256 链 + 断链定位）', type: '安全/合规',
    prompt: `你是安全合规工程师。在 ${D(8)}/ 交付零依赖 Node（CommonJS）审计日志哈希链。
冻结夹具：\`audit.json\`（\`{events: [对象...]}\`）。禁止修改夹具。
**必须交付（缺一不可）：audit.js、audit.test.js、README.md、report.json。**
audit.js 用 \`module.exports = { buildChain, verifyChain }\` 导出，口径（必须逐条对上）：
- \`buildChain(events)\` -> \`{"records": [{seq, prev, hash}...], "head": 末条 hash}\`；
- \`hash_i = sha256hex(prev + "\\n" + canonicalJson(event_i))\`（小写全 64 位 hex）；
  \`prev_0\` = **64 个字符 "0"**；\`prev_i = hash_{i-1}\`；\`seq\` 从 0 递增；
- \`canonicalJson\` = 对象键在每层按字典序、无空白、分隔符 \`,\` \`:\`、UTF-8、非 ASCII 不转义；
- \`verifyChain(events, records)\` -> \`{"ok": bool, "brokenAt": int|null}\`：按同样规则从创世 prev 重算，
  逐条比对 \`prev\` 与 \`hash\`；首个不符 → \`{"ok": false, "brokenAt": i}\`；条数不一致 → brokenAt = 较短侧长度；
  全部一致 → \`{"ok": true, "brokenAt": null}\`。
CLI：\`node audit.js run audit.json\` 写当前目录 \`report.json\` =
\`{records, head, verified, tamperCheck}\`，其中 \`verified = verifyChain(events, records)\`；
\`tamperCheck\` = 把**第 3 条（下标 2）**事件的 \`action\` 改成 \`"login"\` 后再 verifyChain 的结果。退出码 0，打印摘要。
audit.test.js：\`node --test audit.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
创世 prev 全 0、链长度==事件数、原始链校验 ok、篡改任一条即失败且 brokenAt 精确、
插入/删除事件后条数不一致被检出、head 等于末条 hash、canonical JSON 键序不影响结果、
SHA-256 已知向量（sha256('abc')==ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad）。
README.md（≥300 字节）：链式构造、规范 JSON 的必要性与断链定位。
必须真实运行 CLI，并在回复中写明 head 的前 12 位与 tamperCheck.brokenAt。`,
    expect: 'audit.js + test + README + report.json', dir: D(8), frozen: ['audit.json'],
    deliverables: [
      { file: 'audit.js', minBytes: 1000 }, { file: 'audit.test.js', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 300 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node audit.js run audit.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R8)) bad.push('report 与参考不符: ' + diffNote(rep, R8));
      const probe = runProbe(dir, 'audit.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'audit.json'), 'utf8'));
const built = m.buildChain(doc.events);
const tampered = doc.events.map((e, i) => (i === 2 ? { ...e, action: 'login' } : e));
return { records: built.records, head: built.head, verified: m.verifyChain(doc.events, built.records), tamperCheck: m.verifyChain(tampered, built.records) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value, R8)) bad.push('模块 buildChain/verifyChain 与参考不符: ' + diffNote(probe.value, R8));
      const ac = assertCount(dir, 'audit.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'audit.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓创世/链校验/篡改定位/规范JSON/CLI/单测全一致' };
    },
  },

  // ═══════════════ T9: i18n 格式化（Python） ═══════════════
  {
    id: 9, name: 'i18n 消息格式化（Python，CLDR 复数 + ICU-lite + 回退链）', type: '国际化',
    prompt: `你是国际化工程师。在 ${D(9)}/ 交付零依赖 Python（仅标准库）消息格式化器。
冻结夹具：\`i18n.json\`（\`{locale, catalogs: {locale: {key: template}}, cases: [{key, locale, vars}]}\`）。
禁止修改夹具。
**必须交付（缺一不可）：i18n.py、test_i18n.py、README.md、report.json。**
i18n.py 导出 \`render(spec)\` -> \`{"rendered": [{key, locale, text, source}...], "missing": [key...]}\`，口径（必须逐条对上）：
- 回退链：\`locale\` → 其基础语言（首个 \`-\` 之前的部分，若不同）→ \`"en"\`（若尚未包含）→ **键名本身**；
  \`source\` = 实际命中的 catalog locale，全部落空时为 \`"key"\`；\`missing\` 按 cases 顺序记录落空 key；
- 复数类别（严格按 locale 基础语言判定）：
  - \`en\`：\`n == 1\` → \`one\`，否则 \`other\`；
  - \`zh\`：恒 \`other\`；
  - \`ru\`：\`n%10==1 且 n%100!=11\` → \`one\`；\`n%10∈2..4 且 n%100∉12..14\` → \`few\`；
    \`n%10==0 或 n%10∈5..9 或 n%100∈11..14\` → \`many\`；否则 \`other\`；
  - 其它语言：恒 \`other\`；
- 模板语法：\`{name}\` 用 \`vars[name]\` 插值（缺失时原样保留 \`{name}\`）；
  \`{count, plural, one{...} few{...} many{...} other{...}}\` 按 count 的类别选分支，
  分支内的 \`#\` 全部替换为 count 的十进制字符串；分支缺失时回退到 \`other\`；
  花括号配对必须支持分支文本中不含嵌套花括号的情形（用配对扫描，不要用不能处理 \`}\` 的正则）。
CLI：\`python3 i18n.py run i18n.json\` 写当前目录 \`report.json\` = render 结果，退出码 0，打印摘要。
test_i18n.py：\`python3 test_i18n.py\` 退出码 0，至少 8 个断言（**断言助手用英文函数名**；中文注释可以；裸 \`assert\` 亦可），覆盖：
ru one/few/many 三类别边界（1/3/7/21）、en one/other、zh 恒 other、基础语言回退、en 兜底、
键名兜底且 missing 记录、# 替换、{name} 插值。
README.md（≥300 字节）：回退链、CLDR 复数规则表、模板扫描方式。
必须真实运行 CLI，并在回复中写明 ru 下 count=21 与 count=7 的渲染结果。`,
    expect: 'i18n.py + test + README + report.json', dir: D(9), frozen: ['i18n.json'],
    deliverables: [
      { file: 'i18n.py', minBytes: 1400 }, { file: 'test_i18n.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = pyRun(dir, ['i18n.py', 'run', 'i18n.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-160)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R9)) bad.push('report 与参考不符: ' + diffNote(rep, R9));
      const probe = pyProbe(dir, 'i18n.py', 'i18n.json', 'm.render(spec)');
      if (!probe.ok) bad.push('模块探测失败: ' + probe.out.slice(-220));
      else if (!sameJson(probe.value, R9)) bad.push('模块 render 与参考不符: ' + diffNote(probe.value, R9));
      const ac = assertCount(dir, 'test_i18n.py', 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_i18n.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓复数类别/回退链/模板扫描/missing/CLI/单测全一致' };
    },
  },

  // ═══════════════ T10: Snowflake ID（Node） ═══════════════
  {
    id: 10, name: 'Snowflake ID 生成器（Node，位布局 + 序列溢出 + 时钟回拨策略）', type: '分布式 ID',
    prompt: `你是分布式系统工程师。在 ${D(10)}/ 交付零依赖 Node（CommonJS）Snowflake ID 生成器。
冻结夹具：\`snowflake.json\`（\`{epoch, datacenterId, workerId, dcBits, workerBits, seqBits, policy, requests: [{ts}]}\`）。
禁止修改夹具。
**必须交付（缺一不可）：snowflake.js、snowflake.test.js、README.md、report.json。**
snowflake.js 用 \`module.exports = { generate }\` 导出：generate(spec) -> \`{ids, parsed, errors}\`，口径（必须逐条对上）：
- 位布局：\`id = ((ts - epoch) << (dcBits+workerBits+seqBits)) | (dc << (workerBits+seqBits)) |
  (worker << seqBits) | seq\`；**必须用 BigInt 计算**，\`ids\` 输出为**十进制字符串**数组（避免精度丢失）；
- 逐请求处理，维护 \`lastTs\`（初值 -1）与 \`seq\`（初值 0n），\`maxSeq = 1n << seqBits\`：
  - 若 \`ts < lastTs\`（时钟回拨）：\`policy == "reject"\` → \`errors\` 追加 \`{"index", "reason": "clock_backwards"}\`，
    该位置 \`ids[i] = null\`、\`parsed[i] = null\`，**不改变** lastTs/seq，继续下一个；
    \`policy == "wait"\` → 把 \`ts\` 改为 \`lastTs\` 后继续按同 ms 处理；
  - \`ts == lastTs\` → \`seq += 1n\`；若 \`seq >= maxSeq\` → \`seq = 0n\`、\`ts = lastTs + 1\`、\`lastTs = ts\`；
  - \`ts != lastTs\` → \`seq = 0n\`、\`lastTs = ts\`；
- \`parsed\` 每项 = \`{"ts", "datacenterId", "workerId", "seq"}\`（seq 为 Number；reject 时为 null）。
CLI：\`node snowflake.js run snowflake.json\` 写当前目录 \`report.json\` = generate 结果，退出码 0，打印摘要。
snowflake.test.js：\`node --test snowflake.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
同 ms 序列递增、跨 ms 序列归零、序列溢出进位到下一 ms、时钟回拨 wait 复用 lastTs、
reject 策略产出 errors 且该位 null 且不推进状态、位布局手算向量、ID 单调递增（同 worker）、
BigInt 大时间戳不丢精度。
README.md（≥300 字节）：位布局与各字段位宽、序列溢出与两种回拨策略。
必须真实运行 CLI，并在回复中写明 ids[0] 的十进制值。`,
    expect: 'snowflake.js + test + README + report.json', dir: D(10), frozen: ['snowflake.json'],
    deliverables: [
      { file: 'snowflake.js', minBytes: 1200 }, { file: 'snowflake.test.js', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json', minBytes: 200 },
    ],
    exec: (dir) => {
      const bad = [];
      const c1 = cli(dir, 'node snowflake.js run snowflake.json');
      if (!/rc=0\b/.test(c1)) bad.push(`CLI ${c1.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, R10)) bad.push('report 与参考不符: ' + diffNote(rep, R10));
      const probe = runProbe(dir, 'snowflake.js', `
const fs = require('fs');
const path = require('path');
const doc = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, 'snowflake.json'), 'utf8'));
return { out: m.generate(doc) };
`);
      if (!probe.ok) bad.push('模块探测失败: ' + String(probe.out).slice(-220));
      else if (!sameJson(probe.value.out, R10)) bad.push('模块 generate 与参考不符: ' + diffNote(probe.value.out, R10));
      const ac = assertCount(dir, 'snowflake.test.js', 8);
      if (ac) bad.push(ac);
      const t = runNodeTestIn(dir, 'snowflake.test.js');
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓位布局/序列溢出/回拨策略/CLI/单测全一致' };
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
