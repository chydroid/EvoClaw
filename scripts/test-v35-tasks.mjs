/**
 * EvoClaw v35 压测任务定义（10 任务）与核验器。
 * 主题：真实办公/工程交付——许可证审计 / 事故时间线 / a11y 审计 / RRULE 展开 /
 * 邮箱分诊 / OpenAPI lint / 归档校验 / Dockerfile 分析 / 发布计划 / INI→TOML 迁移。
 * 核验纪律：harness 自带参考实现复算（test-v35-lib.mjs），不检查任务书未钉死的私有细节。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runPy, readFileSafe } from './v14/lib.mjs';
import {
  D, sameJson, diffNote, pyLoadModule, runNodeIn, runNodeTestIn, pyRun, pyRunCwd, runNodeCwd, runNodeDriver,
  tmpDir, cleanup, copyTree, extractJson, fileJson, lastLineJson,
  T1_DEPS, T1_POLICY, t1Ref,
  T2_YEAR, t2Ref,
  T3_PAGES, T3_RULES, t3Ref,
  T4_TZ, T4_CASES, t4Ref,
  T5_MESSAGES, t5Ref,
  T6_SPEC, t6Ref,
  T7_FILES, T7_TAMPERED, T7_EXTRA, T7_EVIL_MEMBERS, t7Manifest, t7VerifyRef,
  T8_DOCKERFILE, T8_MAX_RUN, t8Ref,
  T9_BASE_VERSION, T9_COMMITS, t9Ref, t9Bump,
  T10_INI, T10_DEFAULTS, T10_TYPES, T10_SECTION_MAP, T10_KEY_MAP, t10Ref,
} from './test-v35-lib.mjs';

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
const pyProbe = (dir, moduleFile, expr, extraArgs = []) => runPy(dir, `
import json, sys
${pyLoadModule('t35mod', dir + '/' + moduleFile)}
${expr}
`, extraArgs);
function runNodeTest(file) { return runNodeTestIn(path.dirname(file), path.basename(file)); }

export const tasks = [
  // ═══════════════ T1: 依赖许可证合规审计 ═══════════════
  {
    id: 1, name: '依赖许可证合规审计（Python，SPDX 归一 + 策略门禁 + 退出码）', type: '合规/安全',
    prompt: `你是开源合规工程师。在 ${D(1)}/ 交付零依赖 Python（仅标准库）许可证审计工具。
冻结夹具（**禁止修改**）：\`deps.json\`（\`{"packages":[{"name","version","license","deps":[...]}]}\`，含重复条目）、
\`policy.json\`（\`{"allow":[...], "deny":[...], "unknown":"fail"|"pass"}\`）。
**必须交付（缺一不可）：audit.py、test_audit.py、README.md、report.json。**
CLI：\`python3 audit.py deps.json policy.json\`，向 stdout 打印**恰好一行** JSON（其它信息写 stderr）：
\`{"allowed": ["name@version"...], "denied": [{"name","version","license"}...],
"unknown": [{"name","version","license"}...],
"summary": {"total": int, "allowed": int, "denied": int, "unknown": int}, "exitCode": int}\`
规则：
1. **许可证归一（SPDX）**：去首尾空白、压缩内部空白；常见别名归一到规范 id——
   \`MIT License\`/\`MIT\`→\`MIT\`，\`Apache 2.0\`/\`Apache License 2.0\`→\`Apache-2.0\`，
   \`BSD 3-Clause\`/\`BSD-3-Clause\`→\`BSD-3-Clause\`，\`GPLv3\`/\`GPL 3.0\`/\`GPL-3.0\`→\`GPL-3.0\`，
   \`LGPL 2.1\`/\`LGPL-2.1\`→\`LGPL-2.1\`，\`AGPL-3.0\`，\`ISC\`，\`WTFPL\`，\`UNKNOWN\`（大小写不敏感）；
   其它未识别形态：把空白替换为 \`-\` 作为兜底。
2. **去重**：以 \`name@version\` 为键，重复条目只保留首次。
3. **判定**：归一后的许可证在 \`deny\`（归一后比较）→ \`denied\`；在 \`allow\` → \`allowed\`；否则 \`unknown\`。
4. **exitCode**：有任一 denied，或 policy.unknown=="fail" 且有任一 unknown → 1；否则 0。
5. \`allowed\` 为 \`name@version\` 字符串数组，按 name 再 version 升序；denied/unknown 按 name 再 version 升序。
6. summary.total = 去重后的包数。
report.json = 对夹具运行所得的那一行 JSON 对象。
test_audit.py：\`python3 test_audit.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖：
别名归一、去重、denied/unknown 判定、unknown=fail/pass 两种退出码、排序。
README.md（≥300 字节）：归一规则与门禁口径。
**注意：脚本会在另一组 deps/policy 上被复跑，不要硬编码路径或结果。**
在回复中写明 denied 数量与 exitCode。`,
    expect: 'audit.py + test + README + report.json', dir: D(1), frozen: ['deps.json', 'policy.json'],
    deliverables: [
      { file: 'audit.py', minBytes: 1200 }, { file: 'test_audit.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t1Ref();
      const r1 = pyRun(dir, ['audit.py', 'deps.json', 'policy.json']);
      const got = extractJson(r1.out);
      if (got === null) bad.push('无 JSON 输出: ' + r1.out.slice(-200));
      else if (!sameJson(got, ref)) bad.push('stdout 与参考不符: ' + diffNote(got, ref));
      if (r1.code !== ref.exitCode) bad.push(`退出码 ${r1.code}（应为 ${ref.exitCode}）`);
      // report.json 必须来自夹具那次运行——先读，再做泛化，避免泛化运行覆盖它
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report.json 与参考不符: ' + diffNote(rep, ref));
      // 未见数据泛化
      const w = tmpDir('t1');
      const deps2 = { packages: [
        { name: 'x', version: '1.0.0', license: 'MIT License', deps: [] },
        { name: 'y', version: '2.0.0', license: 'GPLv3', deps: [] },
        { name: 'z', version: '3.0.0', license: 'WTFPL', deps: [] },
        { name: 'x', version: '1.0.0', license: 'MIT License', deps: [] },
      ] };
      const pol2 = { allow: ['MIT'], deny: ['GPL-3.0'], unknown: 'pass' };
      fs.writeFileSync(path.join(w, 'd.json'), JSON.stringify(deps2), 'utf8');
      fs.writeFileSync(path.join(w, 'p.json'), JSON.stringify(pol2), 'utf8');
      const ref2 = t1Ref(deps2, pol2);
      const r2 = pyRunCwd(w, path.join(dir, 'audit.py'), ['d.json', 'p.json']);
      const got2 = extractJson(r2.out);
      cleanup(w);
      if (got2 === null) bad.push('未见数据无 JSON 输出');
      else if (!sameJson(got2, ref2)) bad.push('未见数据不符（未泛化）: ' + diffNote(got2, ref2));
      if (r2.code !== ref2.exitCode) bad.push(`未见数据退出码 ${r2.code}（应为 ${ref2.exitCode}）`);
      const ac = assertCount(path.join(dir, 'test_audit.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_audit.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 420) : 'exec=✓归一/去重/判定/退出码/泛化/单测全一致' };
    },
  },

  // ═══════════════ T2: 事故时间线重建 ═══════════════
  {
    id: 2, name: '事故时间线重建（Python，三源日志归一 + UTC 排序 + RCA）', type: 'SRE/取证',
    prompt: `你是 SRE。在 ${D(2)}/ 交付零依赖 Python（仅标准库）事故时间线工具。
冻结夹具（**禁止修改**）：\`app.jsonl\`（每行 \`{"ts": ISO8601 带偏移, "level", "service", "msg"}\`）、
\`nginx.log\`（CLF 格式，时间形如 \`[01/May/2024:10:00:03 +0200]\`，末两字段是状态码与字节数）、
\`syslog.log\`（形如 \`May  1 10:00:02 host proc[pid]: msg\`，**无年份**，按本地时区 UTC+2 解释）、
\`meta.json\`（\`{"year": 2024, "tzOffsetMin": 120}\`，用于补全 syslog 年份与时区）。
**必须交付（缺一不可）：timeline.py、test_timeline.py、README.md、report.json。**
CLI：\`python3 timeline.py app.jsonl nginx.log syslog.log meta.json\` → 写 \`report.json\` 并打印摘要。
**统一换算成 UTC**（ISO8601 固定格式：\`YYYY-MM-DDTHH:MM:SS.000Z\`——毫秒**恒为三位 000**、末尾 \`Z\`，不要省略 \`.000\`），然后**按 UTC 升序**（同刻按 source 名 \`app\`<\`nginx\`<\`syslog\` 稳定）：
report.json（**恰好这些键**）：
\`{"events": [{"utc","source","service","level","msg"}...],
"rca": {"first_error_utc", "error_count", "affected_services": [str...]}}\`
- source：\`app\`/\`nginx\`/\`syslog\`；service：app 用记录的 service，nginx 固定 \`nginx\`，syslog 固定 \`system\`；
- level：app 用记录 level；nginx 状态码 ≥500 → \`error\`，否则 \`info\`（msg 记 \`"HTTP <status>"\`）；
  syslog 含 \`Killed process\`/\`exited, code=\`/\`OOM\`/\`Out of memory\`（大小写不敏感）→ \`error\`，否则 \`info\`；
  syslog 的 msg 取主机名之后、第一个 \`:\` 之后的正文（去掉 \`proc[pid]:\` 前缀），例如
  \`May  1 10:00:40 web01 systemd[1]: Started api.service.\` → msg=\`Started api.service.\`；
- rca.first_error_utc = 最早的 level=error 事件的 utc（无则 null）；error_count = error 事件总数；
  affected_services = 出现 error 的 service 去重后字典序升序。
test_timeline.py：\`python3 test_timeline.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖：
三种格式解析、时区换算、UTC 排序、nginx 5xx 判错、syslog 关键字判错、RCA 聚合。
README.md（≥300 字节）：时间归一与 RCA 口径。
**脚本会在另一组同格式日志上被复跑，不要硬编码结果。**
在回复中写明 first_error_utc 与 error_count。`,
    expect: 'timeline.py + test + README + report.json', dir: D(2),
    frozen: ['app.jsonl', 'nginx.log', 'syslog.log', 'meta.json'],
    deliverables: [
      { file: 'timeline.py', minBytes: 1400 }, { file: 'test_timeline.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t2Ref();
      const c1 = pyRun(dir, ['timeline.py', 'app.jsonl', 'nginx.log', 'syslog.log', 'meta.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 泛化：另一组日志
      const w = tmpDir('t2');
      fs.writeFileSync(path.join(w, 'a.jsonl'), JSON.stringify({ ts: '2024-07-01T00:00:00+02:00', level: 'warn', service: 'api', msg: 'hi' }) + '\n', 'utf8');
      fs.writeFileSync(path.join(w, 'n.log'), '1.1.1.1 - - [01/Jul/2024:00:00:05 +0200] "GET / HTTP/1.1" 500 12\n', 'utf8');
      fs.writeFileSync(path.join(w, 's.log'), 'Jul  1 00:00:09 h s[1]: Started ok.\n', 'utf8');
      fs.writeFileSync(path.join(w, 'm.json'), JSON.stringify({ year: 2024, tzOffsetMin: 120 }), 'utf8');
      const refB = (() => {
        // 手工小样本参考（三源各一条）
        return {
          events: [
            { utc: '2024-06-30T22:00:00.000Z', source: 'app', service: 'api', level: 'warn', msg: 'hi' },
            { utc: '2024-06-30T22:00:05.000Z', source: 'nginx', service: 'nginx', level: 'error', msg: 'HTTP 500' },
            { utc: '2024-06-30T22:00:09.000Z', source: 'syslog', service: 'system', level: 'info', msg: 'Started ok.' },
          ],
          rca: { first_error_utc: '2024-06-30T22:00:05.000Z', error_count: 1, affected_services: ['nginx'] },
        };
      })();
      const c2 = pyRunCwd(w, path.join(dir, 'timeline.py'), ['a.jsonl', 'n.log', 's.log', 'm.json']);
      const repB = fileJson(w, 'report.json');
      cleanup(w);
      if (c2.code !== 0) bad.push(`泛化 CLI rc=${c2.code} ${c2.out.slice(-160)}`);
      else if (!sameJson(repB, refB)) bad.push('泛化结果不符（未泛化）: ' + diffNote(repB, refB));
      const ac = assertCount(path.join(dir, 'test_timeline.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_timeline.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓三源解析/UTC排序/RCA/泛化/单测全一致' };
    },
  },

  // ═══════════════ T3: 无障碍(a11y)静态审计 ═══════════════
  {
    id: 3, name: '无障碍(a11y)静态审计（Python，html.parser + 规则分级 + 报告）', type: '质量/前端',
    prompt: `你是前端质量工程师。在 ${D(3)}/ 交付零依赖 Python（仅标准库，用 \`html.parser\`）无障碍审计工具。
冻结夹具（**禁止修改**）：\`index.html\`、\`about.html\`、\`rules.json\`（规则清单，含 id 与 severity）。
**必须交付（缺一不可）：a11y.py、test_a11y.py、README.md、report.json。**
CLI：\`python3 a11y.py <html_dir>\` → 扫描目录下所有 \`*.html\`，写 \`report.json\` 并打印摘要。
report.json（**恰好这些键**）：
\`{"pages": {文件名: {"violations": [{"line": int, "ruleId": str, "severity": "error"|"warning"}...],
"errorCount": int, "warningCount": int}},
"totals": {"pages": int, "errors": int, "warnings": int}}\`
规则（与 rules.json 一致，violations 按 line 升序、同 line 按 ruleId 升序）：
- \`img-alt\`(error)：\`<img>\` 缺 alt 属性；\`alt=""\` 视为装饰性**允许**；
- \`button-name\`(error)：\`<button>\` 无可见文本且无 aria-label；
- \`link-name\`(error)：\`<a>\` 无可见文本且无 aria-label；
- \`input-label\`(error)：\`<input>\` 无 aria-label 且无 \`<label for="该id">\` 关联；
- \`heading-skip\`(warning)：标题层级跳跃（如 h1 后直接 h3，即当前级别 > 上一级别+1）；
- \`duplicate-id\`(error)：同一页面 id 重复（在**第二次**出现处记一条）；
- \`html-lang\`(warning)：\`<html>\` 缺 lang 属性。
行号从 1 起。totals.errors/warnings 为全部页面之和。
test_a11y.py：\`python3 test_a11y.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），
用自造的小 HTML 字符串覆盖每条规则（含 alt="" 不报、有 aria-label 不报、label 关联不报）。
README.md（≥300 字节）：规则与严重度口径。
**脚本会在另一个你从未见过的 HTML 目录上被复跑，不要硬编码文件名或结果。**
在回复中写明 totals.errors 与 totals.warnings。`,
    expect: 'a11y.py + test + README + report.json', dir: D(3),
    frozen: ['index.html', 'about.html', 'rules.json'],
    deliverables: [
      { file: 'a11y.py', minBytes: 1400 }, { file: 'test_a11y.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t3Ref();
      const c1 = pyRun(dir, ['a11y.py', '.']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 泛化：另一个目录
      const w = tmpDir('t3');
      fs.writeFileSync(path.join(w, 'page.html'), `<html>\n<body>\n<h2>no h1</h2>\n<img src="x.png">\n<button></button>\n<a href="/x"></a>\n<input type="text">\n</body>\n</html>\n`, 'utf8');
      const refB = t3Ref({ 'page.html': fs.readFileSync(path.join(w, 'page.html'), 'utf8') });
      const c2 = pyRunCwd(w, path.join(dir, 'a11y.py'), [w]);
      const repB = fileJson(w, 'report.json');
      cleanup(w);
      if (c2.code !== 0) bad.push(`泛化 CLI rc=${c2.code} ${c2.out.slice(-160)}`);
      else if (!sameJson(repB, refB)) bad.push('泛化结果不符（未泛化）: ' + diffNote(repB, refB));
      const ac = assertCount(path.join(dir, 'test_a11y.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_a11y.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓七规则/分级/行号/泛化/单测全一致' };
    },
  },

  // ═══════════════ T4: 日历 RRULE 展开 ═══════════════
  {
    id: 4, name: '日历 RRULE 展开（Node，RFC5545 子集 + DST + EXDATE）', type: '日期/算法',
    prompt: `你是日历系统工程师。在 ${D(4)}/ 交付零依赖 Node（CommonJS）重复事件展开器。
冻结夹具（**禁止修改**）：\`cases.json\`（\`{"tz": "Europe/Berlin", "cases": [{name, dtstart, rrule, exdate:[...]}]}\`）。
**必须交付（缺一不可）：rrule.js、rrule.test.js、README.md、report.json。**
rrule.js 用 \`module.exports = { expand }\` 导出 \`expand(dtstart, rrule, exdate, tz)\`，
返回该规则展开出的本地时间字符串数组（形如 \`"2024-01-02T09:00:00"\`，无时区后缀，按时间升序）。
CLI：\`node rrule.js cases.json\` → 写 \`report.json\`（**恰好这些键**）：
\`{caseName: [本地时间字符串...]}\`，并为每个 case 额外包含 \`caseName + ".utc"\`：对应的 UTC ISO 字符串数组。
支持的 RRULE 子集：\`FREQ=DAILY|WEEKLY|MONTHLY\`、\`INTERVAL=n\`、\`COUNT=n\`、\`UNTIL=<YYYYMMDDTHHMMSSZ>\`、
\`BYDAY=MO,TU,...\`（仅 WEEKLY 生效）、\`EXDATE\` 列表（本地时间字符串）。
语义：
- 保留 dtstart 的钟点（时:分:秒），只推进日期；
- **MONTHLY**：某月没有该日（如 31 号遇 2 月）→ **跳过该月**，不钳制；
- **WEEKLY + BYDAY**：从 dtstart 所在周起按 INTERVAL 周步进，每个命中周展开 BYDAY 中的日（≥dtstart）；
- **UNTIL** 是 UTC 时间，与展开点的 UTC 比较，超过则停止；
- **EXDATE** 命中的展开点被跳过，但**不占 COUNT 名额**（COUNT 计的是最终保留的条数）；
- **DST**：以 IANA 时区解释本地墙钟。春季不存在的墙钟（如 2024-03-31 02:30）顺延到 **03:30**；
  秋季重复的墙钟取第一次出现。Node 24 可直接用 \`Intl.DateTimeFormat\` 或内置时区换算，无需第三方库。
rrule.test.js：\`node --test rrule.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
DAILY+COUNT、WEEKLY+BYDAY+INTERVAL、MONTHLY 跳过短月、UNTIL、EXDATE 不占 COUNT、DST 春季顺延。
README.md（≥300 字节）：RRULE 子集与 DST 口径。
在回复中写明 dst-spring 这个 case 的第三条时间。`,
    expect: 'rrule.js + test + README + report.json', dir: D(4), frozen: ['cases.json'],
    deliverables: [
      { file: 'rrule.js', minBytes: 1400 }, { file: 'rrule.test.js', minBytes: 900 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t4Ref();
      const refReport = {};
      for (const [k, v] of Object.entries(ref)) {
        refReport[k] = v.map((x) => x.local);
        refReport[k + '.utc'] = v.map((x) => x.utc);
      }
      const c1 = runNodeIn(dir, ['rrule.js', 'cases.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, refReport)) bad.push('report 与参考不符: ' + diffNote(rep, refReport));
      // 模块探测（多行代码走临时驱动文件，避免 -e 里的换行被 shell 吃掉）
      const probe = runNodeDriver(dir, `
const { expand } = require(${JSON.stringify(path.join(dir, 'rrule.js'))});
const out = expand('2024-01-02T09:00:00', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=4', [], 'Europe/Berlin');
console.log(JSON.stringify(out));
`);
      const wantW = ref['weekly-tue-count'].map((x) => x.local);
      const gotW = probe.ok ? lastLineJson(probe.out) : null;
      if (!sameJson(gotW, wantW)) bad.push('模块 expand 不符: ' + JSON.stringify(gotW));
      const ac = assertCount(path.join(dir, 'rrule.test.js'), 8);
      if (ac) bad.push(ac);
      const t = runNodeTest(path.join(dir, 'rrule.test.js'));
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓DAILY/WEEKLY/MONTHLY/UNTIL/EXDATE/DST/单测全一致' };
    },
  },

  // ═══════════════ T5: 邮箱分诊 ═══════════════
  {
    id: 5, name: '邮箱分诊（Python，线程归并 + 分类 + 行动清单）', type: '办公自动化',
    prompt: `你是效率工程师。在 ${D(5)}/ 交付零依赖 Python（仅标准库）邮件分诊工具。
冻结夹具（**禁止修改**）：\`messages.json\`（\`[{"id","from","to","subject","date","inReplyTo","references","body"}...]\`）。
**必须交付（缺一不可）：triage.py、test_triage.py、README.md、report.json。**
CLI：\`python3 triage.py messages.json\` → 写 \`report.json\` 并打印摘要。
**分类**（\`classify(msg)\`，大小写不敏感，按优先级判定）：
1. \`spam\`：from 含 \`newsletter@\` 或 body 含 \`unsubscribe\`；
2. \`action_required\`：body 含 \`reply by\` / \`action needed\` / \`can you confirm\` / \`please review\` 任一；
3. 其余 \`fyi\`。
**线程归并**：沿 \`inReplyTo\`（若指向本集合内邮件）逐级上溯到根，同一根为一线程。
**report.json（恰好这些键）**：
\`{"threads": [{"root","subject","messageCount","latestFrom","latestDate","status"}...],
"actions": [{"id","from","subject","date"}...],
"counts": {"action_required": int, "fyi": int, "spam": int}}\`
- threads 按 root 升序；subject = 根邮件 subject；latestFrom/latestDate = 线程内日期最晚的邮件；
  status：线程内任一邮件为 action_required → \`action_required\`；否则全为 spam → \`spam\`；否则 \`fyi\`；
- actions = 所有分类为 action_required 的邮件，按 date 升序；
- counts 按**单封邮件**（非线程）统计三类数量。
test_triage.py：\`python3 test_triage.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），覆盖：
三类分类各一例、线程归并（含二级回复）、status 优先级、actions 排序、counts。
README.md（≥300 字节）：分类优先级与线程归并口径。
在回复中写明线程数与 action_required 邮件数。`,
    expect: 'triage.py + test + README + report.json', dir: D(5), frozen: ['messages.json'],
    deliverables: [
      { file: 'triage.py', minBytes: 1200 }, { file: 'test_triage.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t5Ref();
      const c1 = pyRun(dir, ['triage.py', 'messages.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 模块探测
      const probe = pyProbe(dir, 'triage.py', `print(json.dumps(m.classify({"from":"newsletter@x.io","body":"hi"})))`);
      if (!probe.ok) bad.push('模块 classify 探测失败: ' + probe.out.slice(-160));
      else if (probe.value !== 'spam') bad.push('classify 未识别 newsletter: ' + JSON.stringify(probe.value));
      const ac = assertCount(path.join(dir, 'test_triage.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_triage.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓分类/线程/status/actions/counts/单测全一致' };
    },
  },

  // ═══════════════ T6: OpenAPI 子集 lint ═══════════════
  {
    id: 6, name: 'OpenAPI 子集 lint（Node，$ref/operationId/参数/响应规则）', type: 'API/质量',
    prompt: `你是 API 治理工程师。在 ${D(6)}/ 交付零依赖 Node（CommonJS）OpenAPI 3.0 静态检查器。
冻结夹具（**禁止修改**）：\`openapi.json\`（一份含缺陷的 3.0 文档）。
**必须交付（缺一不可）：lint.js、lint.test.js、README.md、report.json。**
lint.js 用 \`module.exports = { lint }\` 导出 \`lint(spec)\`，返回
\`{"issues": [{"code","where"}...], "summary": {"total": int, "byCode": {code: int}}}\`。
CLI：\`node lint.js openapi.json\` → 写 \`report.json\`（即 lint 的返回值）。
规则（issues 按 code 再 where 升序）：
- \`ref-missing\`：\`$ref\` 指向的本地 \`#/...\` 组件不存在；where = 该 ref 字符串；
- \`ref-unused\`：\`components\` 下每个定义未被任何 \`$ref\` 引用；where = \`#/components/<section>/<name>\`；
- \`opid-missing\`：operation（get/put/post/delete/patch）缺 operationId；where = \`"METHOD path"\`；
- \`opid-duplicate\`：operationId 重复；where = 重复的 operationId；
- \`param-path-mismatch\`：path 模板 \`{x}\` 的变量集合与该 operation 的 \`in:path\` 参数名集合不一致；where = \`"METHOD path"\`；
- \`response-missing\`：operation 缺 responses 或为空对象；where = \`"METHOD path"\`；
- \`tag-undeclared\`：operation 用了顶层 \`tags\` 未声明的 tag；where = \`"METHOD path:tag"\`。
\`where\` 的 METHOD 大写，path 原样。summary.byCode 只统计出现的 code。
lint.test.js：\`node --test lint.test.js\` 通过，至少 8 个断言（node:assert），用自造小 spec 覆盖每条规则。
README.md（≥300 字节）：规则清单与输出口径。
**脚本会在另一份 spec 上被复跑，不要硬编码结果。**
在回复中写明 summary.total 与命中的规则种类数。`,
    expect: 'lint.js + test + README + report.json', dir: D(6), frozen: ['openapi.json'],
    deliverables: [
      { file: 'lint.js', minBytes: 1400 }, { file: 'lint.test.js', minBytes: 900 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t6Ref();
      const c1 = runNodeIn(dir, ['lint.js', 'openapi.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 泛化：小 spec
      const w = tmpDir('t6');
      const spec2 = {
        openapi: '3.0.0', info: { title: 'x', version: '1' }, tags: [{ name: 'a' }],
        paths: {
          '/x/{id}': { get: { operationId: 'getX', tags: ['b'], parameters: [{ name: 'id', in: 'path' }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } } } } } },
        },
        components: { schemas: { Ok: { type: 'object' } } },
      };
      fs.writeFileSync(path.join(w, 's.json'), JSON.stringify(spec2), 'utf8');
      const refB = t6Ref(spec2);
      const c2 = runNodeCwd(w, path.join(dir, 'lint.js'), ['s.json']);
      const repB = fileJson(w, 'report.json');
      cleanup(w);
      if (c2.code !== 0) bad.push(`泛化 CLI rc=${c2.code} ${c2.out.slice(-160)}`);
      else if (!sameJson(repB, refB)) bad.push('泛化结果不符（未泛化）: ' + diffNote(repB, refB));
      const ac = assertCount(path.join(dir, 'lint.test.js'), 8);
      if (ac) bad.push(ac);
      const t = runNodeTest(path.join(dir, 'lint.test.js'));
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓七规则/排序/泛化/单测全一致' };
    },
  },

  // ═══════════════ T7: 备份归档校验与恢复 ═══════════════
  {
    id: 7, name: '备份归档校验与恢复（Python，manifest sha256 + 篡改检出 + 安全解包）', type: '运维/安全',
    prompt: `你是备份运维工程师。在 ${D(7)}/ 交付零依赖 Python（仅标准库）备份校验与恢复工具。
冻结夹具（**禁止修改**）：\`backup/\` 目录树（含 \`manifest.json\`：\`{"version":1,"files":{rel:{"sha256","size"}}}\`）、
\`evil_members.txt\`（每行一个恶意归档成员路径）。
**必须交付（缺一不可）：backup_tool.py、test_backup_tool.py、README.md、report.json。**
CLI 两个子命令：
- \`python3 backup_tool.py verify backup/\` → 校验 backup/ 下**除 manifest.json 外**的所有文件：
  与 manifest 比对，分类 \`modified\`（sha256 或 size 不符）/ \`missing\`（manifest 有但文件无）/ \`extra\`（文件有但 manifest 无）。
  写 \`report.json\`（**恰好这些键**）：\`{"ok": bool, "issues": [{"rel","status"}...], "summary": {"total": int}}\`，
  issues 按 rel 再 status 升序；有任一 issue → 退出码 1，否则 0。
- \`python3 backup_tool.py restore backup/ <target_dir>\` → 把 backup/ 的文件安全恢复到 target_dir：
  **拒绝**路径穿越（含 \`..\`）、绝对路径成员；被拒绝的成员跳过并在 stderr 报告，其余正常恢复。
同时提供 \`is_safe_member(path)\` 函数（返回 bool），供 test 直接调用验证 \`evil_members.txt\` 中全部为 False。
test_backup_tool.py：\`python3 test_backup_tool.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），
用临时目录自造 backup + manifest，覆盖：ok 场景、modified、missing、extra、is_safe_member 拒绝穿越/绝对路径、restore 正常恢复。
README.md（≥300 字节）：校验口径与安全解包规则。
在回复中写明 verify 检出的 issue 数量与各自的 status。`,
    expect: 'backup_tool.py + test + README + report.json', dir: D(7),
    frozen: ['backup/data/a.txt', 'backup/data/b.txt', 'backup/data/sub/c.txt', 'backup/config/app.ini', 'backup/manifest.json', 'evil_members.txt'],
    deliverables: [
      { file: 'backup_tool.py', minBytes: 1400 }, { file: 'test_backup_tool.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      // 参考：基于夹具真实内容复算
      const man = t7Manifest();
      const actual = {};
      for (const f of T7_FILES) actual[f.rel] = Buffer.from(f.content, 'utf8');
      for (const [rel, content] of Object.entries(T7_TAMPERED)) actual[rel] = Buffer.from(content, 'utf8');
      for (const [rel, content] of Object.entries(T7_EXTRA)) actual[rel] = Buffer.from(content, 'utf8');
      const ref = t7VerifyRef(man, actual);
      const c1 = pyRun(dir, ['backup_tool.py', 'verify', 'backup']);
      if (c1.code !== 1) bad.push(`verify 有 issue 时退出码 ${c1.code}（应为 1）`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // is_safe_member
      const probe = pyProbe(dir, 'backup_tool.py', `
ev = [l.strip() for l in open('evil_members.txt', encoding='utf-8') if l.strip()]
print(json.dumps([m.is_safe_member(x) for x in ev]))
print(json.dumps([m.is_safe_member(x) for x in ['data/a.txt','config/app.ini','sub/x/y.txt']]))
`);
      if (!probe.ok) bad.push('is_safe_member 探测失败: ' + probe.out.slice(-180));
      else {
        const lines = probe.out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
        const evilRes = lines[0], goodRes = lines[1];
        if (!Array.isArray(evilRes) || evilRes.some((x) => x !== false)) bad.push('is_safe_member 未拒绝全部恶意成员: ' + JSON.stringify(evilRes));
        if (!Array.isArray(goodRes) || goodRes.some((x) => x !== true)) bad.push('is_safe_member 误拒正常成员: ' + JSON.stringify(goodRes));
      }
      // restore 正常恢复
      const w = tmpDir('t7');
      const c2 = pyRun(dir, ['backup_tool.py', 'restore', 'backup', w]);
      const restored = path.join(w, 'config', 'app.ini');
      if (c2.code !== 0) bad.push(`restore rc=${c2.code} ${c2.out.slice(-160)}`);
      else if (!fs.existsSync(restored) || readFileSafe(restored) !== T7_FILES[3].content) bad.push('restore 未正确恢复 config/app.ini');
      const escaped = fs.existsSync(path.join(w, '..', 'escape.txt')) || fs.existsSync('/etc/abs.txt');
      if (escaped) bad.push('restore 出现路径穿越/绝对路径逃逸');
      cleanup(w);
      const ac = assertCount(path.join(dir, 'test_backup_tool.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_backup_tool.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓校验三态/退出码/安全成员/恢复/单测全一致' };
    },
  },

  // ═══════════════ T8: Dockerfile 静态分析 ═══════════════
  {
    id: 8, name: 'Dockerfile 静态分析（Python，指令解析 + 安全/体积规则）', type: '容器/安全',
    prompt: `你是容器安全工程师。在 ${D(8)}/ 交付零依赖 Python（仅标准库）Dockerfile 静态分析器。
冻结夹具（**禁止修改**）：\`Dockerfile\`、\`limits.json\`（\`{"maxRun": 4}\`）。
**必须交付（缺一不可）：dockerlint.py、test_dockerlint.py、README.md、report.json。**
CLI：\`python3 dockerlint.py Dockerfile limits.json\` → 写 \`report.json\` 并打印摘要。
report.json（**恰好这些键**）：
\`{"issues": [{"code","line"}...], "summary": {"total": int, "byCode": {code: int}}}\`
issues 按 code 再 line 升序。规则（针对**最终 stage**，除 latest-tag 针对所有 FROM）：
- \`latest-tag\`：FROM 使用 \`:latest\` 或无 tag（\`scratch\` 除外）；line = 该 FROM 行；
- \`no-user\`：最终 stage 未设置 USER 或为 \`root\`/\`0\`；line = 最终 FROM 行；
- \`workdir-missing\`：最终 stage 无 WORKDIR；line = 最终 FROM 行；
- \`add-instead-copy\`：最终 stage 使用 ADD；line = 最终 FROM 行；
- \`apt-no-clean\`：最终 stage 的 \`apt-get install\` 未在同条 RUN 内 \`rm -rf /var/lib/apt/lists\`；line = 最终 FROM 行；
- \`curl-pipe-sh\`：最终 stage 的 RUN 含 \`curl|wget ... | sh\`；line = 最终 FROM 行；
- \`secret-env\`：最终 stage 的 ENV/ARG 键名含 KEY/SECRET/TOKEN/PASSWORD（大小写不敏感）；line = 该指令行；
- \`many-layers\`：最终 stage 的 RUN 指令数 > maxRun；line = 最终 FROM 行。
test_dockerlint.py：\`python3 test_dockerlint.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），
用自造 Dockerfile 字符串覆盖每条规则（含合规文件不报）。
README.md（≥300 字节）：规则与行号口径。
**脚本会在另一份 Dockerfile 上被复跑，不要硬编码结果。**
在回复中写明 summary.total 与命中的规则种类数。`,
    expect: 'dockerlint.py + test + README + report.json', dir: D(8), frozen: ['Dockerfile', 'limits.json'],
    deliverables: [
      { file: 'dockerlint.py', minBytes: 1400 }, { file: 'test_dockerlint.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t8Ref();
      const c1 = pyRun(dir, ['dockerlint.py', 'Dockerfile', 'limits.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 泛化：合规 Dockerfile（应无 issue）
      const w = tmpDir('t8');
      const good = `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nUSER node\nCMD ["node","index.js"]\n`;
      fs.writeFileSync(path.join(w, 'Dockerfile'), good, 'utf8');
      fs.writeFileSync(path.join(w, 'limits.json'), JSON.stringify({ maxRun: 4 }), 'utf8');
      const refB = t8Ref(good);
      const c2 = pyRunCwd(w, path.join(dir, 'dockerlint.py'), ['Dockerfile', 'limits.json']);
      const repB = fileJson(w, 'report.json');
      cleanup(w);
      if (c2.code !== 0) bad.push(`泛化 CLI rc=${c2.code} ${c2.out.slice(-160)}`);
      else if (!sameJson(repB, refB)) bad.push('泛化结果不符（合规文件应无 issue）: ' + diffNote(repB, refB));
      const ac = assertCount(path.join(dir, 'test_dockerlint.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_dockerlint.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓八规则/行号/泛化/单测全一致' };
    },
  },

  // ═══════════════ T9: 发布计划与 CHANGELOG ═══════════════
  {
    id: 9, name: '发布计划与 CHANGELOG（Node，conventional commits → semver + 幂等）', type: '发布/工程',
    prompt: `你是发布工程师。在 ${D(9)}/ 交付零依赖 Node（CommonJS）发布计划工具。
冻结夹具（**禁止修改**）：\`commits.json\`（\`{"baseVersion":"1.2.3","commits":[{"subject":"..."}...]}\`，
subject 形如 \`type(scope)!: subject\`）。
**必须交付（缺一不可）：release.js、release.test.js、README.md、report.json。**
release.js 用 \`module.exports = { bump, plan }\` 导出：
- \`bump(version, subjects)\` → \`{"next": "x.y.z", "level": "major"|"minor"|"patch"|"none"}\`；
- \`plan(baseVersion, commits)\` → \`{"version","level","groups":{"breaking","features","fixes","perf","other"},"headings":[str...]}\`。
CLI：\`node release.js commits.json\` → 写 \`report.json\`（即 plan 的返回值）。
**bump 规则**：
- 任一 commit 带 \`!\`（如 \`feat!:\`）或 body 声明 BREAKING（本任务只需识别 subject 里的 \`!\`）→ major（x+1.0.0）；
- 否则任一 \`feat:\` → minor（x.y+1.0）；否则任一 \`fix:\` 或 \`perf:\` → patch（x.y.z+1）；否则 none（版本不变）。
**plan**：groups 中每类是该类 commit 的展示行：有 scope 写 \`**scope:** subject\`，无 scope 写 subject；
breaking 组收所有带 \`!\` 的；其余按 type 归入 features(feat)/fixes(fix)/perf(perf)/other(其它)；
headings = 非空组的标题，顺序固定 \`Breaking Changes\` > \`Features\` > \`Bug Fixes\` > \`Performance\` > \`Other\`。
release.test.js：\`node --test release.test.js\` 通过，至少 8 个断言（node:assert），覆盖：
major/minor/patch/none 四档、\`!\` 识别、groups 分组、scope 格式化、headings 顺序、空组省略。
README.md（≥300 字节）：semver 推导与分组口径。
在回复中写明 next 版本与 level。`,
    expect: 'release.js + test + README + report.json', dir: D(9), frozen: ['commits.json'],
    deliverables: [
      { file: 'release.js', minBytes: 1200 }, { file: 'release.test.js', minBytes: 900 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t9Ref();
      const c1 = runNodeIn(dir, ['release.js', 'commits.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 模块探测：bump 四档（多行代码走临时驱动文件）
      const probe = runNodeDriver(dir, `
const { bump } = require(${JSON.stringify(path.join(dir, 'release.js'))});
console.log(JSON.stringify([
  bump('1.2.3', ['feat!: drop v1']),
  bump('1.2.3', ['feat: x']),
  bump('1.2.3', ['fix: y']),
  bump('1.2.3', ['docs: z']),
]));
`);
      const want = [
        { next: '2.0.0', level: 'major' },
        { next: '1.3.0', level: 'minor' },
        { next: '1.2.4', level: 'patch' },
        { next: '1.2.3', level: 'none' },
      ];
      const got = probe.ok ? lastLineJson(probe.out) : null;
      if (!sameJson(got, want)) bad.push('bump 四档不符: ' + JSON.stringify(got));
      const ac = assertCount(path.join(dir, 'release.test.js'), 8);
      if (ac) bad.push(ac);
      const t = runNodeTest(path.join(dir, 'release.test.js'));
      if (!t.ok) bad.push('node --test 失败: ' + t.out.slice(-180));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓semver四档/分组/headings/单测全一致' };
    },
  },

  // ═══════════════ T10: INI → TOML 配置迁移 ═══════════════
  {
    id: 10, name: 'INI → TOML 配置迁移（Python，重命名/默认值/类型校验 + dry-run diff）', type: '重构/配置',
    prompt: `你是平台工程师。在 ${D(10)}/ 交付零依赖 Python（仅标准库）配置迁移工具。
冻结夹具（**禁止修改**）：\`config.ini\`、\`migration.json\`（\`{"sectionMap":{旧节:新节},"keyMap":{"旧节.旧键":新键},
"defaults":{"新节.新键":默认值},"types":{"新节.新键":"int"|"bool"|"str"}}\`）。
**必须交付（缺一不可）：migrate.py、test_migrate.py、README.md、report.json。**
CLI：\`python3 migrate.py config.ini migration.json\` → 写 \`report.json\` 并打印摘要。
**流程**：
1. 解析 INI（\`[section]\` 与 \`key = value\`，忽略空行与 \`;\`/\`#\` 注释）；
2. 节名按 sectionMap 重命名（未映射保留原名）；键按 keyMap（键为 \`"旧节.旧键"\`）重命名（未映射保留原名）；
3. 按 types 对最终键（\`"新节.新键"\`）做类型转换：int（严格整数）/bool（true/false/1/0/yes/no，大小写不敏感）/str；
   转换失败记入 errors，**不中止**（继续收集全部错误），该键不进入 config、**也不产生任何 changes 行**；
   errors 元素形如 \`{"key": "新节.新键", "error": "not an int: <原始值>"}\`（bool 失败为 \`"not a bool: <原始值>"\`，
   原始值原样拼在冒号后，不加引号、不做类型描述改写）；
4. 按 defaults 对最终键补默认值（缺失时补）；
5. report.json（**恰好这些键**）：
   \`{"config": {节: {键: 值}}, "errors": [{"key": "新节.新键", "error": str}...],
   "changes": [str...], "ok": bool}\`
   - changes 是 dry-run diff 的行，格式固定：\`rename <旧节.旧键> -> <新节.新键>\`；
     未改名 \`keep <新节.新键>=<JSON 值>\`；补默认 \`default <新节.新键>=<JSON 值>\`；
     - 判据是**点号全路径是否变化**（节变或键变都算）：\`db.ssl\`→\`database.ssl\` 路径变了，
       即使键名 ssl 没变也要写 \`rename db.ssl -> database.ssl\`；只有新旧全路径**完全相同**才写 keep；
     - 全部按字典序排序（**生成后必须显式排序**，如 Python \`changes.sort()\`；
       不要按处理顺序/先重命名后默认值的自然顺序输出）；
     - 对冻结夹具，排序后 changes 恰好 8 条、按此顺序：
       \`default server.timeout=30\`、\`keep logging.level="info"\`、\`keep server.debug=true\`、
       \`keep server.port=8080\`、\`rename db.host -> database.hostname\`、\`rename db.pool -> database.pool_size\`、
       \`rename db.ssl -> database.ssl\`、\`rename server.host -> server.hostname\`；
   - **changes 在类型校验之后、基于最终 config 生成**：只描述最终进入 config 的键。
     某键若类型转换失败被剔除，它的 rename/keep 行**一律不出现**（即便它确实被重命名过）。
     例：\`[db]\\nport = notanint\\npool = 5\` + sectionMap \`{db: database}\`、keyMap \`{"db.pool": "pool_size"}\`、
     defaults \`{"database.ssl": false}\`、types \`{"database.port": "int", "database.pool_size": "int", "database.ssl": "bool"}\` 时，
     changes 恰好 2 条：\`"default database.ssl=false"\`、\`"rename db.pool -> database.pool_size"\`；
   - ok = errors 为空。
test_migrate.py：\`python3 test_migrate.py\` 退出码 0，至少 8 个断言（断言助手用英文函数名），
用自造小 INI + 迁移表覆盖：节重命名、键重命名、int/bool 转换、默认值补全、类型错误收集、changes 排序。
README.md（≥300 字节）：迁移顺序、类型校验与 diff 口径。
在回复中写明 ok 与 changes 条数。`,
    expect: 'migrate.py + test + README + report.json', dir: D(10), frozen: ['config.ini', 'migration.json'],
    deliverables: [
      { file: 'migrate.py', minBytes: 1200 }, { file: 'test_migrate.py', minBytes: 800 },
      { file: 'README.md', minBytes: 300 }, { file: 'report.json' },
    ],
    exec: (dir) => {
      const bad = [];
      const ref = t10Ref();
      const c1 = pyRun(dir, ['migrate.py', 'config.ini', 'migration.json']);
      if (c1.code !== 0) bad.push(`CLI rc=${c1.code} ${c1.out.slice(-180)}`);
      const rep = fileJson(dir, 'report.json');
      if (!rep) bad.push('report.json 缺失/非 JSON');
      else if (!sameJson(rep, ref)) bad.push('report 与参考不符: ' + diffNote(rep, ref));
      // 泛化：含类型错误的小 INI
      const w = tmpDir('t10');
      fs.writeFileSync(path.join(w, 'c.ini'), '[db]\nport = notanint\npool = 5\n', 'utf8');
      const mig = { sectionMap: { db: 'database' }, keyMap: { 'db.pool': 'pool_size' }, defaults: { 'database.ssl': false }, types: { 'database.port': 'int', 'database.pool_size': 'int', 'database.ssl': 'bool' } };
      fs.writeFileSync(path.join(w, 'm.json'), JSON.stringify(mig), 'utf8');
      const refB = t10Ref('[db]\nport = notanint\npool = 5\n', mig);
      const c2 = pyRunCwd(w, path.join(dir, 'migrate.py'), ['c.ini', 'm.json']);
      const repB = fileJson(w, 'report.json');
      cleanup(w);
      if (c2.code !== 0) bad.push(`泛化 CLI rc=${c2.code} ${c2.out.slice(-160)}`);
      else if (!sameJson(repB, refB)) bad.push('泛化结果不符（未泛化）: ' + diffNote(repB, refB));
      const ac = assertCount(path.join(dir, 'test_migrate.py'), 8);
      if (ac) bad.push(ac);
      const t = pyRun(dir, ['test_migrate.py']);
      if (t.code !== 0) bad.push(`test rc=${t.code} ${t.out.slice(-160)}`);
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 4).join('; ').slice(0, 440) : 'exec=✓重命名/类型/默认/diff/泛化/单测全一致' };
    },
  },
];
