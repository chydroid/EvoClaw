/**
 * Round 3 — 解析器 / 编译器 / 渲染
 *  9. 表达式 tokenizer + parser + evaluator（AST + 错误位置）
 * 10. RFC4180 CSV 解析器（引号/嵌入换行/BOM/CRLF）
 * 11. Markdown 子集渲染（HTML 转义 + 链接消毒）
 * 12. Mustache 子集模板引擎
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  WS, defineChecks, runProbe, runNodeTest, runNodeWithCode, readFileSafe, writeFixture,
} from './lib.mjs';

const D9 = `${WS}/v14-expr`;
const D10 = `${WS}/v14-csv`;
const D11 = `${WS}/v14-markdown`;
const D12 = `${WS}/v14-template`;

const TRICKY = 'id,name,note\n1,plain,simple\n2,"a, b",quoted comma\n3,"line1\nline2",embedded newline\n4,"say ""hi""",escaped quotes\n5,,empty\n';
const CRLF = 'id,name,note\r\n1,plain,simple\r\n2,"a, b",quoted comma\r\n';
const BOM = '﻿id,name,note\n1,plain,simple\n';
const BAD = 'id,name\n1,"unterminated\n';

const TRICKY_OBJECTS = [
  { id: '1', name: 'plain', note: 'simple' },
  { id: '2', name: 'a, b', note: 'quoted comma' },
  { id: '3', name: 'line1\nline2', note: 'embedded newline' },
  { id: '4', name: 'say "hi"', note: 'escaped quotes' },
  { id: '5', name: '', note: 'empty' },
];

const EXPR_CASES = [
  ['1+2*3', 7],
  ['(1+2)*3', 9],
  ['2**3**2', 512],
  ['-3**2', -9],
  ['10/4', 2.5],
  ['10%3', 1],
  ['2*(3+4)-5', 9],
  ['  1 + 2  ', 3],
];

function seed() {
  writeFixture(D10, 'fixtures/tricky.csv', TRICKY);
  writeFixture(D10, 'fixtures/crlf.csv', CRLF);
  writeFixture(D10, 'fixtures/bom.csv', BOM);
  writeFixture(D10, 'fixtures/bad.csv', BAD);
}

const tasks = defineChecks([
  {
    id: 9, round: 3, name: '表达式 parser + AST + 错误位置', type: '解析器',
    prompt: `你是语言工具链工程师。在 ${D9}/ 下交付 expr.js（CommonJS，无第三方依赖，不使用 eval/Function）：
1）导出三个函数：
   - tokenize(src) → {ok:true,tokens} | {ok:false,error:{message,position}}；
   - parse(src) → {ok:true,ast} | {ok:false,error:{message,position}}；
   - evaluate(src) → {ok:true,value} | {ok:false,error:{message,position}}。
2）语法：数字（整数/小数）、二元 + - * / % **、一元 -、括号。优先级 **（右结合）> 一元负号 > * / % > + -。因此 -3**2 = -9，2**3**2 = 512。
3）AST 节点：数字 {"type":"number","value":n}；一元 {"type":"unary","op":"-","operand":node}；二元 {"type":"binary","op":"+|-|*|/|%|**","left":node,"right":node}。
4）错误：position 是 0 基字符下标；输入提前结束（如缺右括号）position 等于 src.length；除零错误 position 为除号下标。支持空白。
5）CLI：\`node expr.js "<表达式>"\` 成功打印 {"ok":true,"value":n,"ast":{...}} 退出码 0；失败打印 {"ok":false,"error":{"message","position"}} 退出码 2。
6）expr.test.js（node --test，≥7 用例）覆盖优先级/结合性/括号/一元负号/错误位置/除零。
7）README.md（≥250 字节）：文法、优先级、AST 结构、错误位置约定。`,
    expect: 'expr.js + expr.test.js + README.md（8 算式 + AST + 错误位置）',
    dir: D9,
    deliverables: [
      { file: 'expr.js', minBytes: 1200 },
      { file: 'expr.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const probe = `
        const out = { values: {}, errors: {} };
        const cases = ${JSON.stringify(EXPR_CASES)};
        for (const [src, want] of cases) out.values[src] = m.evaluate(src);
        out.errors.parse1 = m.parse('1+*2');
        out.errors.parse2 = m.parse('1+(2*3');
        out.errors.div0 = m.evaluate('8/0');
        out.errors.bad = m.parse('abc');
        out.ast1 = m.parse('1+2*3');
        out.ast2 = m.parse('2**3**2');
        out.ast3 = m.parse('-3**2');
        out.tokens = m.tokenize('12+3');
        return out;
      `;
      const p = runProbe(dir, 'expr.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      for (const [src, want] of EXPR_CASES) {
        const r = v.values[src];
        if (!r?.ok || r.value !== want) bad.push(`${src}=${JSON.stringify(r)}≠${want}`);
      }
      if (v.errors.parse1?.ok !== false || v.errors.parse1.error?.position !== 2) bad.push(`1+*2 位置 ${JSON.stringify(v.errors.parse1)}`);
      if (v.errors.parse2?.ok !== false || v.errors.parse2.error?.position !== 6) bad.push(`1+(2*3 位置 ${JSON.stringify(v.errors.parse2)}`);
      if (v.errors.div0?.ok !== false || v.errors.div0.error?.position !== 1) bad.push(`8/0 位置 ${JSON.stringify(v.errors.div0)}`);
      if (v.errors.bad?.ok !== false || v.errors.bad.error?.position !== 0) bad.push(`abc 位置 ${JSON.stringify(v.errors.bad)}`);
      const a1 = v.ast1?.ast, a2 = v.ast2?.ast, a3 = v.ast3?.ast;
      if (!(a1?.type === 'binary' && a1.op === '+' && a1.right?.type === 'binary' && a1.right.op === '*')) bad.push('AST 1+2*3 形状');
      if (!(a2?.type === 'binary' && a2.op === '**' && a2.right?.type === 'binary' && a2.right.op === '**')) bad.push('** 右结合 AST');
      if (!(a3?.type === 'unary' && a3.op === '-' && a3.operand?.type === 'binary' && a3.operand.op === '**')) bad.push('-3**2 AST');
      const okCli = runNodeWithCode(dir, 'expr.js "2*(3+4)"');
      // 期望 14（=2*7）
      if (okCli.code !== 0 || !/"value"\s*:\s*14/.test(okCli.out)) bad.push(`CLI 成功 ${okCli.code}/${okCli.out.slice(0, 80)}`);
      const badCli = runNodeWithCode(dir, 'expr.js "1+*2"');
      if (badCli.code !== 2) bad.push(`CLI 非法退出码 ${badCli.code}`);
      const t = runNodeTest(path.join(dir, 'expr.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 500) : 'exec=✓8算式/优先级/右结合/错误位置/CLI/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'expr.js'));
      return [['无 eval', !/\beval\s*\(|new\s+Function/.test(s)], ['tokenizer', /tokeniz/i.test(s)], ['错误位置', /position/i.test(s)]];
    },
  },
  {
    id: 10, round: 3, name: 'RFC4180 CSV 解析器', type: '解析器/CSV',
    prompt: `你是数据格式工程师。在 ${D10}/ 下交付 csv.js（CommonJS，无第三方依赖）：
1）导出 parseCSV(text) → string[][]（每行字段数组）。要求正确处理：逗号分隔、双引号包裹字段、字段内逗号、双引号内换行、"" 转义双引号、CRLF/LF、UTF-8 BOM（首字段去除 BOM）、末尾空字段。遇到未闭合引号抛出 Error（message 含 "unterminated"）。不得用简单的 split(',')。
2）导出 parseObjects(text) → 对象数组，以首行为表头，值一律字符串。
3）CLI：\`node csv.js <输入文件> --out <输出文件>\`，用 parseObjects 写 JSON；输入非法时 stderr 输出错误并以退出码 2 退出。
4）csv.test.js（node --test，≥6 用例）覆盖夹具中的引号/嵌入换行/CRLF/BOM/空字段/非法引号。
5）README.md（≥250 字节）：支持范围与限制。
6）必须真实运行 CLI 处理 fixtures/tricky.csv，把解析行数与第 3 行 name 写进回复。`,
    expect: 'csv.js + tricky.json + csv.test.js + README.md',
    dir: D10, frozen: ['fixtures/tricky.csv', 'fixtures/crlf.csv', 'fixtures/bom.csv', 'fixtures/bad.csv'],
    deliverables: [
      { file: 'csv.js', minBytes: 900 },
      { file: 'tricky.json', minBytes: 150 },
      { file: 'csv.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const r = runNodeWithCode(dir, 'csv.js fixtures/tricky.csv --out tricky.json');
      if (r.code !== 0) return { ok: false, detail: `exec=CLI 退出码 ${r.code} ${r.out.slice(-200).replace(/\n/g, ' ')}` };
      const bad = [];
      let got;
      try { got = JSON.parse(readFileSafe(path.join(dir, 'tricky.json'))); } catch { return { ok: false, detail: 'exec=tricky.json 非法 JSON' }; }
      if (JSON.stringify(got) !== JSON.stringify(TRICKY_OBJECTS)) bad.push(`tricky 结果 ${JSON.stringify(got).slice(0, 300)}`);
      const badRun = runNodeWithCode(dir, 'csv.js fixtures/bad.csv --out bad.json');
      if (badRun.code !== 2) bad.push(`非法 CSV 退出码 ${badRun.code}`);
      const probe = `
        const fs = require('fs');
        const tricky = m.parseCSV(fs.readFileSync('fixtures/tricky.csv','utf8'));
        const crlf = m.parseCSV(fs.readFileSync('fixtures/crlf.csv','utf8'));
        const bom = m.parseCSV(fs.readFileSync('fixtures/bom.csv','utf8'));
        let badErr = null; try { m.parseCSV(fs.readFileSync('fixtures/bad.csv','utf8')); } catch(e) { badErr = String(e.message); }
        return { tricky, crlf, bom, badErr };
      `;
      const p = runProbe(dir, 'csv.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value;
      if (v.tricky?.length !== 6) bad.push(`parseCSV 行数 ${v.tricky?.length}`);
      if (JSON.stringify(v.tricky?.[3]) !== JSON.stringify(['3', 'line1\nline2', 'embedded newline'])) bad.push(`嵌入换行行=${JSON.stringify(v.tricky?.[3])}`);
      if (JSON.stringify(v.tricky?.[4]) !== JSON.stringify(['4', 'say "hi"', 'escaped quotes'])) bad.push(`转义引号行=${JSON.stringify(v.tricky?.[4])}`);
      if (JSON.stringify(v.tricky?.[5]) !== JSON.stringify(['5', '', 'empty'])) bad.push(`空字段行=${JSON.stringify(v.tricky?.[5])}`);
      if (v.crlf?.length !== 3 || v.crlf[1]?.[1] !== 'plain') bad.push(`CRLF ${JSON.stringify(v.crlf)?.slice(0, 120)}`);
      if (v.bom?.[0]?.[0] !== 'id') bad.push(`BOM 首字段=${v.bom?.[0]?.[0]}`);
      if (!/unterminated/i.test(v.badErr || '')) bad.push(`非法引号未抛出 ${v.badErr}`);
      const t = runNodeTest(path.join(dir, 'csv.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓引号/嵌入换行/CRLF/BOM/空字段/非法/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'csv.js'));
      return [['状态机', /inQuotes|quote|state/i.test(s)], ['无 split 捷径', !/\.split\(\s*['"]\s*,\s*['"]\s*\)/.test(s)]];
    },
  },
  {
    id: 11, round: 3, name: 'Markdown 子集渲染（XSS 安全）', type: '渲染/前端',
    prompt: `你是文档渲染工程师。在 ${D11}/ 下交付 md.js（CommonJS，无第三方依赖），导出 render(markdown) → HTML 字符串：
1）支持：ATX 标题 # ~ ###；**粗体**；*斜体*；行内反引号代码；围栏代码块（\`\`\` 语言可选）；链接 [文本](url)；无序列表 - 项；管道表格（第二行是 |---| 分隔）。
2）安全：所有文本必须 HTML 转义（& < > " '）。原始 HTML 标签（如 <script>）只能以转义文本出现。链接 URL 仅允许 http/https/mailto 与相对路径（/、./、#）；出现 javascript: 或 data: 时**不得生成 href**（可只渲染文本）。
3）围栏代码块输出 <pre><code>...</code></pre>，内容转义。
4）表格输出 <table> 且含 <thead>/<th>/<tbody>/<td>。
5）md.test.js（node --test，≥7 用例）覆盖标题/粗斜体/代码/链接消毒/原始 HTML/表格/列表。
6）README.md（≥250 字节）：支持语法与安全策略。
7）必须真实渲染一段包含 <script>alert(1)</script> 与 javascript: 链接的样例，把输出中是否出现未转义标签写进回复。`,
    expect: 'md.js + md.test.js + README.md（渲染 + XSS 探针）',
    dir: D11,
    deliverables: [
      { file: 'md.js', minBytes: 1000 },
      { file: 'md.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const probe = `
        const r = {};
        r.h1 = m.render('# Title');
        r.h2 = m.render('## Sub');
        r.bold = m.render('**bold**');
        r.em = m.render('*it*');
        r.code = m.render('\\\`x=1\\\`');
        r.link = m.render('[ok](https://example.com)');
        r.badLink = m.render('[bad](javascript:alert(1))');
        r.html = m.render('<script>alert(1)</script>');
        r.fence = m.render('\\u0060\\u0060\\u0060js\\nconst x = "<b>";\\n\\u0060\\u0060\\u0060');
        r.table = m.render('| a | b |\\n|---|---|\\n| 1 | 2 |');
        r.list = m.render('- one\\n- two');
        return r;
      `;
      const p = runProbe(dir, 'md.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      if (!/<h1>Title<\/h1>/.test(v.h1)) bad.push('h1');
      if (!/<h2>Sub<\/h2>/.test(v.h2)) bad.push('h2');
      if (!/<strong>bold<\/strong>/.test(v.bold)) bad.push('bold');
      if (!/<em>it<\/em>/.test(v.em)) bad.push('em');
      if (!/<code>x=1<\/code>/.test(v.code)) bad.push('inline code');
      if (!/<a href="https:\/\/example\.com">ok<\/a>/.test(v.link)) bad.push(`link ${v.link}`);
      if (/href\s*=\s*["']?javascript:/i.test(v.badLink)) bad.push('javascript 链接未消毒');
      if (/<script>/i.test(v.html) || !/&lt;script&gt;/.test(v.html)) bad.push(`原始 HTML 未转义 ${v.html}`);
      if (!/<pre><code/.test(v.fence) || !/&lt;b&gt;/.test(v.fence) || /<b>/.test(v.fence.replace(/&lt;b&gt;/g, ''))) bad.push(`fence ${v.fence}`);
      if (!/<table>/.test(v.table) || !/<th>/.test(v.table) || !/<td>/.test(v.table)) bad.push(`table ${v.table}`);
      if (!/<ul>/.test(v.list) || !/<li>one<\/li>/.test(v.list)) bad.push(`list ${v.list}`);
      const t = runNodeTest(path.join(dir, 'md.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓标题/粗斜体/代码/链接消毒/XSS/表格/列表/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'md.js'));
      return [['转义', /&amp;|&lt;|escape/i.test(s)], ['链接白名单', /https|mailto|javascript/i.test(s)]];
    },
  },
  {
    id: 12, round: 3, name: 'Mustache 子集模板引擎', type: '模板引擎',
    prompt: `你是模板引擎工程师。在 ${D12}/ 下交付 template.js（CommonJS，无第三方依赖）：
1）导出 render(template, data, partials = {}) → string，支持：
   - 变量 {{name}}（HTML 转义 & < > " ' 为 &amp; &lt; &gt; &quot; &#39;）；
   - 三花括号 {{{name}}} 原样输出；
   - 点路径 {{user.name}}；
   - 区段 {{#key}}...{{/key}}：数组逐项渲染（当前项为上下文，对象字段直接可用），对象/真值渲染一次，假值/空数组不渲染；
   - 反向区段 {{^key}}...{{/key}}：假值/空数组/缺失时渲染一次；
   - 局部模板 {{>name}}，从 partials 取值并渲染；
   - 缺失变量渲染为空串。
2）template.test.js（node --test，≥7 用例）覆盖变量/转义/三花括号/点路径/数组区段/对象区段/反向区段/局部模板/缺失值。
3）README.md（≥250 字节）：语法与转义规则。
4）必须真实渲染一个含数组区段与 HTML 转义的样例，把输出写进回复。`,
    expect: 'template.js + template.test.js + README.md（9 组精确输出）',
    dir: D12,
    deliverables: [
      { file: 'template.js', minBytes: 1000 },
      { file: 'template.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const probe = `
        const r = {};
        r.basic = m.render('Hello {{name}}!', { name: 'Bob' });
        r.escape = m.render('{{x}}', { x: '<script> & "q" \\'s\\'' });
        r.raw = m.render('{{{x}}}', { x: '<b>ok</b>' });
        r.dotted = m.render('{{user.name}}', { user: { name: 'Ann' } });
        r.section = m.render('{{#items}}<{{name}}>{{/items}}', { items: [{ name: 'a' }, { name: 'b' }] });
        r.objSection = m.render('{{#user}}{{name}}{{/user}}', { user: { name: 'Z' } });
        r.inverted = m.render('{{^missing}}none{{/missing}}', {});
        r.truthyInverted = m.render('{{^user}}none{{/user}}', { user: { name: 'Z' } });
        r.partial = m.render('A {{>p}}', {}, { p: 'P{{x}}' });
        r.missing = m.render('x{{nope}}y', {});
        return r;
      `;
      const p = runProbe(dir, 'template.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      const eq = (name, got, want) => { if (got !== want) bad.push(`${name}=${JSON.stringify(got)}≠${JSON.stringify(want)}`); };
      eq('basic', v.basic, 'Hello Bob!');
      eq('escape', v.escape, '&lt;script&gt; &amp; &quot;q&quot; &#39;s&#39;');
      eq('raw', v.raw, '<b>ok</b>');
      eq('dotted', v.dotted, 'Ann');
      eq('section', v.section, '<a><b>');
      eq('objSection', v.objSection, 'Z');
      eq('inverted', v.inverted, 'none');
      eq('truthyInverted', v.truthyInverted, '');
      eq('partial', v.partial, 'A P');
      eq('missing', v.missing, 'xy');
      const t = runNodeTest(path.join(dir, 'template.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓10 组模板输出逐字一致/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'template.js'));
      return [['区段', /#[^}]*\}\}|section/i.test(s)], ['反向', /\^\{\{|inverted/i.test(s)], ['转义', /&amp;|escape/i.test(s)]];
    },
  },
]);

export const round = 3;
export const title = '解析器 / 模板引擎';
export default { round, title, outTag: 'r3', seed, tasks };
