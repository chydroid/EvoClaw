/**
 * EvoClaw v30 压测共享库 —— 6 任务领域与 v12–v29 全部任务零重叠：
 *   T1 mini SQL 查询引擎（内连接/左连接/WHERE/GROUP BY/聚合/ORDER/LIMIT，Python）
 *   T2 WAL 快照式键值存储 + checkpoint 恢复（Python）
 *   T3 CJK 混排文本两端对齐（EAW 宽度 + 空格分配规则，Python）
 *   T4 JSON 操作重放（RFC 7386 merge-patch + RFC 6902 JSON Patch 子集，Node CJS）
 *   T5 确定性事件状态机 + 快照续跑（Node CJS）
 *   T6 二进制协议帧编解码 + CRC16-CCITT + 粘连流切帧（Node CJS）
 *
 * 参考实现用于 harness 自校准与对模型交付物的独立复算（不依赖被测产物）。
 * 夹具由 seed() 写入各任务目录，写入时记录哈希（frozen 校验）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeFixture, FIXTURE_HASHES, canon as canonShared, pyReadTextLiteral } from './v14/lib.mjs';
export { pyReadTextLiteral };

export const WS = '/home/chy/EvoClaw/data/workspace';
export const D = (n) => `${WS}/v30-t${n}`;
export const canon = canonShared;
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
export const pyPath = (s) => JSON.stringify(s);

// ═══════════════════════════ T1: mini SQL 引擎参考实现 ═══════════════════════════
// 语义口径（任务书与参考实现共用）：
// - SELECT 列：表.列 或 聚合 COUNT/SUM/AVG/MIN/MAX(表.列 | *)，可带 AS 别名
// - FROM：T1 [AS] A1 [INNER|LEFT JOIN T [AS] A ON cond]...
// - WHERE 仅支持：列比较(= != < <= > >=)、LIKE('%'→任意、'_'→单字符)、AND、括号（无 OR/NOT/IN）
// - GROUP BY 表达式；聚合对组内行求值；AVG 为空组/全 NULL 时返回 null；SUM 空组为 0
// - ORDER BY 键可多列；NULL 恒最小；数字比数值、其余按 String 码点序；同序保持原序（稳定）
// - LIMIT n / OFFSET m（先跳 m 再取 n）
// - 输出行键：AS 别名；否则列引用原文（如 o.id）；无别名的聚合写作 FUNC(参数)
// - 裸列引用（无表前缀）按 FROM 顺序在首个含该列的表行中解析，找不到为 null

export const T1_DB = {
  orders: {
    cols: ['id', 'customer', 'amount'],
    rows: [
      [1, 'Ann', 100],
      [2, 'Bob', 20],
      [3, 'Ann', 50],
      [4, 'Ann', 100],
      [5, 'Carl', 40],
      [6, 'Bob', 60],
      [7, 'Carl', 10],
      [8, 'Eve', 30],
    ],
  },
  customers: {
    cols: ['id', 'name', 'country'],
    rows: [
      [1, 'Ann', 'CN'],
      [2, 'Bob', 'US'],
      [3, 'Carl', 'DE'],
      [4, 'Dan', 'US'],
    ],
  },
  parts: {
    cols: ['id', 'sku'],
    rows: [
      [10, 'A-20'],
      [11, 'B-10'],
      [12, 'C-20'],
      [13, 'D-9'],
    ],
  },
};

export const T1_CASES = [
  {
    name: 'j1',
    sql: 'SELECT o.id, c.name, o.amount FROM orders AS o INNER JOIN customers AS c ON o.customer = c.name ORDER BY o.id',
    expected: [
      { 'o.id': 1, 'c.name': 'Ann', 'o.amount': 100 },
      { 'o.id': 2, 'c.name': 'Bob', 'o.amount': 20 },
      { 'o.id': 3, 'c.name': 'Ann', 'o.amount': 50 },
      { 'o.id': 4, 'c.name': 'Ann', 'o.amount': 100 },
      { 'o.id': 5, 'c.name': 'Carl', 'o.amount': 40 },
      { 'o.id': 6, 'c.name': 'Bob', 'o.amount': 60 },
      { 'o.id': 7, 'c.name': 'Carl', 'o.amount': 10 },
    ],
  },
  {
    name: 'j2',
    sql: 'SELECT o.id, c.country FROM orders AS o LEFT JOIN customers AS c ON o.customer = c.name ORDER BY c.country',
    expected: [
      { 'o.id': 8, 'c.country': null },
      { 'o.id': 1, 'c.country': 'CN' },
      { 'o.id': 3, 'c.country': 'CN' },
      { 'o.id': 4, 'c.country': 'CN' },
      { 'o.id': 5, 'c.country': 'DE' },
      { 'o.id': 7, 'c.country': 'DE' },
      { 'o.id': 2, 'c.country': 'US' },
      { 'o.id': 6, 'c.country': 'US' },
    ],
  },
  {
    name: 'w1',
    sql: 'SELECT id, amount FROM orders WHERE amount >= 40 AND amount <= 100 ORDER BY amount DESC, id ASC',
    expected: [
      { id: 1, amount: 100 },
      { id: 4, amount: 100 },
      { id: 6, amount: 60 },
      { id: 3, amount: 50 },
      { id: 5, amount: 40 },
    ],
  },
  {
    name: 'g1',
    sql: 'SELECT customer, COUNT(*) AS n, SUM(amount) AS total, AVG(amount) AS avg FROM orders GROUP BY customer ORDER BY customer',
    expected: [
      { customer: 'Ann', n: 3, total: 250, avg: 250 / 3 },
      { customer: 'Bob', n: 2, total: 80, avg: 40 },
      { customer: 'Carl', n: 2, total: 50, avg: 25 },
      { customer: 'Eve', n: 1, total: 30, avg: 30 },
    ],
  },
  {
    name: 'like1',
    sql: "SELECT sku FROM parts WHERE sku LIKE '%-20%' ORDER BY sku",
    expected: [{ sku: 'A-20' }, { sku: 'C-20' }],
  },
  {
    name: 'l1',
    sql: 'SELECT amount FROM orders LIMIT 3 OFFSET 2',
    expected: [{ amount: 50 }, { amount: 100 }, { amount: 40 }],
  },
];

function t1Tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',' || c === '*') { toks.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let v = ''; i++;
      while (i < s.length && s[i] !== c) v += s[i++];
      i++;
      toks.push({ t: 'str', v }); continue;
    }
    if (['!=', '<=', '>='].includes(s.slice(i, i + 2))) { toks.push({ t: s.slice(i, i + 2) }); i += 2; continue; }
    if ('=<>'.includes(c)) { toks.push({ t: c }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let v = ''; while (i < s.length && /[A-Za-z0-9_.]/.test(s[i])) v += s[i++];
      toks.push({ t: 'id', v }); continue;
    }
    if (/[0-9]/.test(c)) {
      let v = ''; while (i < s.length && /[0-9.]/.test(s[i])) v += s[i++];
      toks.push({ t: 'num', v: Number(v) }); continue;
    }
    throw new Error('T1 参考: 无法识别字符 ' + c);
  }
  return toks;
}

function t1ParseQuery(text) {
  const toks = t1Tokenize(text);
  const P = { toks, p: 0 };
  const peek = () => P.toks[P.p];
  const isKw = (kw) => !!peek() && peek().t === 'id' && peek().v.toUpperCase() === kw;
  const eatKw = (kw) => { if (!isKw(kw)) throw new Error('T1 参考: 期望 ' + kw); P.p++; };
  const readKey = () => {
    const c = peek();
    if (!c || c.t !== 'id') throw new Error('T1 参考: 键表达式须为列引用或聚合');
    if (/^(COUNT|SUM|AVG|MIN|MAX)$/i.test(c.v)) {
      const fn = c.v.toUpperCase(); P.p++;
      if (peek().t !== '(') throw new Error('T1 参考: 聚合缺括号');
      P.p++;
      let arg = null;
      if (peek() && peek().t === '*') P.p++;
      else { arg = { t: 'col', ref: peek().v }; P.p++; }
      if (peek().t !== ')') throw new Error('T1 参考: 聚合未闭合');
      P.p++;
      return { t: 'agg', fn, arg };
    }
    P.p++;
    return { t: 'col', ref: c.v };
  };
  const readOperand = () => {
    const c = peek();
    if (!c) throw new Error('T1 参考: 表达式缺操作数');
    if (c.t === 'num') { P.p++; return { t: 'num', v: c.v }; }
    if (c.t === 'str') { P.p++; return { t: 'str', v: c.v }; }
    if (c.t === 'id') { P.p++; return { t: 'col', ref: c.v }; }
    throw new Error('T1 参考: 不支持的操作数 ' + JSON.stringify(c));
  };
  const parseCond = () => {
    let left = parseTerm();
    while (isKw('AND')) { P.p++; left = { t: 'and', l: left, r: parseTerm() }; }
    return left;
  };
  const parseTerm = () => {
    if (peek().t === '(') {
      P.p++;
      const e = parseCond();
      if (peek().t !== ')') throw new Error('T1 参考: 括号未闭合');
      P.p++;
      return e;
    }
    const lhs = readOperand();
    const op = peek();
    const opName = op && op.t === 'id' ? op.v.toUpperCase() : op && op.t;
    if (!['=', '!=', '<', '<=', '>', '>=', 'LIKE'].includes(opName)) throw new Error('T1 参考: 期望比较运算符');
    P.p++;
    return { t: 'cmp', op: opName === 'LIKE' ? 'LIKE' : opName, lhs, rhs: readOperand() };
  };
  if (!isKw('SELECT')) throw new Error('T1 参考: 非 SELECT');
  P.p++;
  const cols = [];
  for (;;) {
    let expr;
    if (peek().t === 'id' && /^(COUNT|SUM|AVG|MIN|MAX)$/i.test(peek().v)) expr = readKey();
    else expr = { t: 'col', ref: readOperand().ref };
    let alias = null;
    if (isKw('AS')) { P.p++; alias = peek().v; P.p++; }
    cols.push({ expr, alias });
    if (peek() && peek().t === ',') { P.p++; continue; }
    break;
  }
  eatKw('FROM');
  const from = { tables: [], on: [] };
  {
    const name = peek().v; P.p++;
    let alias = null;
    if (isKw('AS')) { P.p++; alias = peek().v; P.p++; }
    else if (peek() && peek().t === 'id' && !['INNER', 'LEFT', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET'].includes(peek().v.toUpperCase())) { alias = peek().v; P.p++; }
    from.tables.push({ name, alias: alias || name });
    for (;;) {
      let kind = 'INNER';
      if (isKw('INNER')) { P.p++; eatKw('JOIN'); }
      else if (isKw('LEFT')) { kind = 'LEFT'; P.p++; eatKw('JOIN'); }
      else break;
      const jn = peek().v; P.p++;
      let jAlias = null;
      if (isKw('AS')) { P.p++; jAlias = peek().v; P.p++; }
      else if (peek() && peek().t === 'id' && !isKw('ON')) { jAlias = peek().v; P.p++; }
      from.tables.push({ name: jn, alias: jAlias || jn, join: kind });
      eatKw('ON');
      from.on.push(parseCond());
    }
  }
  let where = null;
  if (isKw('WHERE')) { P.p++; where = parseCond(); }
  let groupBy = null;
  if (isKw('GROUP')) { P.p++; eatKw('BY'); groupBy = []; for (;;) { groupBy.push(readKey()); if (peek() && peek().t === ',') { P.p++; continue; } break; } }
  let orderBy = null;
  if (isKw('ORDER')) { P.p++; eatKw('BY'); orderBy = []; for (;;) { const key = readKey(); let dir = 'ASC'; if (isKw('ASC') || isKw('DESC')) { dir = peek().v.toUpperCase(); P.p++; } orderBy.push({ key, dir }); if (peek() && peek().t === ',') { P.p++; continue; } break; } }
  let limit = null, offset = 0;
  if (isKw('LIMIT')) { P.p++; limit = peek().v; P.p++; }
  if (isKw('OFFSET')) { P.p++; offset = peek().v; P.p++; }
  if (P.p !== toks.length) throw new Error('T1 参考: 残留 token ' + JSON.stringify(toks[P.p]));
  return { cols, from, where, groupBy, orderBy, limit, offset };
}

function t1EvalExpr(e, env) {
  // env: { [alias]: rowObj | null }，rowObj 为 列名→值（LEFT JOIN 未匹配为 null）
  if (e.t === 'col') {
    if (e.ref.includes('.')) {
      const [a, c] = e.ref.split('.');
      if (!(a in env)) throw new Error('T1 参考: 未知表别名 ' + a);
      const row = env[a];
      return row === null || row === undefined ? null : row[c];
    }
    for (const a of Object.keys(env)) {
      const r = env[a];
      if (r && e.ref in r) return r[e.ref];
    }
    return null;
  }
  if (e.t === 'num') return e.v;
  if (e.t === 'str') return e.v;
  if (e.t === 'cmp') {
    const L = t1EvalExpr(e.lhs, env), R = t1EvalExpr(e.rhs, env);
    if (e.op === 'LIKE') {
      if (L === null || R === null) return null;
      const rx = new RegExp('^' + String(R).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 's');
      return rx.test(String(L));
    }
    if (L === null || R === null) return null;
    switch (e.op) {
      case '=': return L === R;
      case '!=': return L !== R;
      case '<': return L < R;
      case '<=': return L <= R;
      case '>': return L > R;
      case '>=': return L >= R;
    }
  }
  if (e.t === 'and') return t1EvalExpr(e.l, env) && t1EvalExpr(e.r, env);
  throw new Error('T1 参考: 未知表达式 ' + JSON.stringify(e));
}
function t1ResolveCol(env, ref) {
  if (ref.includes('.')) {
    const [a, c] = ref.split('.');
    const r = env[a];
    return r === null || r === undefined ? null : r[c];
  }
  for (const a of Object.keys(env)) {
    const r = env[a];
    if (r && ref in r) return r[ref];
  }
  return null;
}
function t1EvalAgg(a, rows) {
  if (a.fn === 'COUNT' && a.arg === null) return rows.length;
  const vals = rows.map((env) => t1ResolveCol(env, a.arg.ref)).filter((v) => v !== null && v !== undefined);
  switch (a.fn) {
    case 'COUNT': return vals.length;
    case 'SUM': return vals.length ? vals.reduce((x, y) => x + y, 0) : 0;
    case 'AVG': return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    case 'MIN': return vals.length ? Math.min(...vals) : null;
    case 'MAX': return vals.length ? Math.max(...vals) : null;
  }
}
const t1ColKey = (c) => c.alias || (c.expr.t === 'col' ? c.expr.ref : `${c.expr.fn}(${c.expr.arg ? c.expr.arg.ref : '*'})`);

/** 参考执行：sql 为 T1_CASES 中语句，db 为 T1_DB。返回行对象数组。 */
export function t1Exec(sql, db) {
  const q = t1ParseQuery(sql);
  const base = q.from.tables[0];
  if (!(base.name in db)) throw new Error('T1 参考: 未知表 ' + base.name);
  const colsOf = (name) => db[name].cols;
  let rows = db[base.name].rows.map((r) => ({ [base.alias]: Object.fromEntries(colsOf(base.name).map((c, i) => [c, r[i]])) }));
  for (let ti = 1; ti < q.from.tables.length; ti++) {
    const jt = q.from.tables[ti];
    const jt2 = db[jt.name];
    if (!jt2) throw new Error('T1 参考: 未知表 ' + jt.name);
    const jcols = jt2.cols;
    const cond = q.from.on[ti - 1];
    const next = [];
    for (const acc of rows) {
      let matched = false;
      for (const jr of jt2.rows) {
        const env = { ...acc, [jt.alias]: Object.fromEntries(jcols.map((c, k) => [c, jr[k]])) };
        if (t1EvalExpr(cond, env)) { next.push(env); matched = true; }
      }
      if (jt.join === 'LEFT' && !matched) next.push({ ...acc, [jt.alias]: null });
    }
    rows = next;
  }
  if (q.where) rows = rows.filter((env) => t1EvalExpr(q.where, env));
  let out;
  if (q.groupBy) {
    const groups = new Map();
    for (const env of rows) {
      const vk = JSON.stringify(q.groupBy.map((g) => t1EvalExpr(g, env)));
      if (!groups.has(vk)) groups.set(vk, []);
      groups.get(vk).push(env);
    }
    out = [...groups.values()].map((grows) => {
      const row0 = grows[0];
      return q.cols.map((c) => ({
        k: t1ColKey(c),
        v: c.expr.t === 'agg' ? t1EvalAgg(c.expr, grows) : t1EvalExpr(c.expr, row0),
      }));
    });
  } else {
    out = rows.map((env) => q.cols.map((c) => ({
      k: t1ColKey(c),
      v: c.expr.t === 'agg' ? t1EvalAgg(c.expr, [env]) : t1EvalExpr(c.expr, env),
    })));
  }
  if (q.orderBy) {
    const valOf = (rowArr, keyExpr) => {
      const av = Object.fromEntries(rowArr.map((x) => [x.k, x.v]));
      if (keyExpr.t === 'col') {
        if (keyExpr.ref.includes('.')) return av[keyExpr.ref];
        const f = rowArr.find((x) => x.k === keyExpr.ref);
        return f ? f.v : null;
      }
      return av[`${keyExpr.fn}(${keyExpr.arg ? keyExpr.arg.ref : '*'})`];
    };
    out = out.slice().sort((A, B) => {
      for (let i = 0; i < q.orderBy.length; i++) {
        const va = valOf(A, q.orderBy[i].key);
        const vb = valOf(B, q.orderBy[i].key);
        let d;
        if (va === null || va === undefined) d = -1;
        else if (vb === null || vb === undefined) d = 1;
        else if (typeof va === 'number' && typeof vb === 'number') d = va < vb ? -1 : va > vb ? 1 : 0;
        else d = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
        if (q.orderBy[i].dir === 'DESC') d = -d;
        if (d !== 0) return d;
      }
      return 0;
    });
  }
  if (q.offset) out = out.slice(q.offset);
  if (q.limit !== null) out = out.slice(0, q.limit);
  return out.map((rowArr) => Object.fromEntries(rowArr.map((x) => [x.k, x.v])));
}

export function t1Ref() {
  const out = {};
  for (const c of T1_CASES) out[c.name] = t1Exec(c.sql, T1_DB);
  return out;
}

// ═══════════════════════════ T2: WAL 键值存储参考实现 ═══════════════════════════
/**
 * 规格：
 * - WAL 条目 {lsn, op:'put', key, value} | {lsn, op:'del', key} | {lsn, op:'ckpt', snapshot:{...}}
 * - 应用序：put 覆盖/插入；del 删除（无键则忽略）；ckpt 以 snapshot 整体替换当前状态
 * - recover(wal, fromLsn)：取 lsn≥fromLsn 的**最后一个** ckpt（无则空态）为基底，
 *   其后（lsn 更大）的 put/del 按序重放
 * 输出：{state, ckpt_lsn, replayed, total}（键名与任务书一致，Python snake_case；
 * replayed = 参与重放的 put/del 条目数，total = lsn≥fromLsn 的条目总数）
 */
export function t2Recover(wal, fromLsn = 1) {
  let last = null;
  for (const e of wal) if (e.lsn >= fromLsn && e.op === 'ckpt') last = e;
  const state = last ? { ...(last.snapshot || {}) } : {};
  let replayed = 0;
  for (const e of wal) {
    if (e.lsn < fromLsn || e.op === 'ckpt') continue;
    if (last && e.lsn <= last.lsn) continue;
    replayed++;
    if (e.op === 'put') state[e.key] = e.value;
    else if (e.op === 'del') delete state[e.key];
  }
  return { state, ckpt_lsn: last ? last.lsn : null, replayed, total: wal.filter((e) => e.lsn >= fromLsn).length };
}
export const T2_SCENARIOS = [
  {
    name: 'sc1',
    fromLsn: 1,
    wal: [
      { lsn: 1, op: 'put', key: 'a', value: 1 },
      { lsn: 2, op: 'put', key: 'b', value: 2 },
      { lsn: 3, op: 'ckpt', snapshot: { a: 1, b: 2 } },
      { lsn: 4, op: 'put', key: 'c', value: 3 },
      { lsn: 5, op: 'del', key: 'a' },
      { lsn: 6, op: 'ckpt', snapshot: { b: 2, c: 3 } },
      { lsn: 7, op: 'put', key: 'd', value: 4 },
      { lsn: 8, op: 'put', key: 'b', value: 22 },
    ],
  },
  {
    name: 'sc2',
    fromLsn: 7,
    wal: [
      { lsn: 1, op: 'put', key: 'a', value: 1 },
      { lsn: 6, op: 'ckpt', snapshot: { b: 2, c: 3 } },
      { lsn: 7, op: 'put', key: 'd', value: 4 },
      { lsn: 8, op: 'put', key: 'b', value: 22 },
    ],
  },
  {
    name: 'sc3',
    fromLsn: 1,
    wal: [{ lsn: 1, op: 'put', key: 'x', value: 'v' }],
  },
];
export function t2Ref() {
  return T2_SCENARIOS.map((s) => ({ name: s.name, ...t2Recover(s.wal, s.fromLsn) }));
}

// ═══════════════════════════ T3: CJK 混排两端对齐参考实现 ═══════════════════════════
/**
 * 规格：
 * - 宽度：码点位于 0x1100-0x115F / 0x2E80-0x303E / 0x3041-0x33FF / 0x3400-0x4DBF /
 *   0x4E00-0x9FFF / 0xA000-0xA4CF / 0xAC00-0xD7A3 / 0xF900-0xFAFF / 0xFE30-0xFE4F /
 *   0xFF00-0xFF60 / 0xFFE0-0xFFE6 记 2（全角/汉字），其余记 1
 * - 行切：从左到右贪婪填充，单行宽度不得超过 limit；放不下即换行；空文本返回 []
 * - 空格分配（仅最后一行以外的行）：slack = limit - 行宽
 *   1) 先在各 CJK 字（宽度 2 的字）**前方**字间间隙补 1 空格（从左到右；行首不算间隙；slack 为 0 时不补）
 *   2) 仍有剩余：按原序（跳过已用）在每个非 CJK 字前方间隙补 1
 *   3) 仍有多余：追加到行尾
 *   最后一行：内容不变，不加空格
 * 输出：{lines:[...], lastWidth}（lastWidth = 末行内容宽度）
 */
export function t3Width(ch) {
  const cp = ch.codePointAt(0);
  const w2 = (lo, hi) => cp >= lo && cp <= hi;
  return (
    w2(0x1100, 0x115f) || w2(0x2e80, 0x303e) || w2(0x3041, 0x33ff) || w2(0x3400, 0x4dbf) ||
    w2(0x4e00, 0x9fff) || w2(0xa000, 0xa4cf) || w2(0xac00, 0xd7a3) || w2(0xf900, 0xfaff) ||
    w2(0xfe30, 0xfe4f) || w2(0xff00, 0xff60) || w2(0xffe0, 0xffe6)
  ) ? 2 : 1;
}
export const t3IsCJK = (ch) => t3Width(ch) === 2;
export function t3Justify(text, limit) {
  if (!text) return { lines: [], lastWidth: 0 };
  const chars = [...text];
  const lines = [];
  let cur = [], curW = 0;
  for (const ch of chars) {
    const w = t3Width(ch);
    if (curW + w > limit) { lines.push(cur); cur = [ch]; curW = w; }
    else { cur.push(ch); curW += w; }
  }
  lines.push(cur);
  const out = [];
  lines.forEach((ln, idx) => {
    if (idx === lines.length - 1) { out.push(ln.join('')); return; }
    const lineW = ln.reduce((s, c) => s + t3Width(c), 0);
    let slack = limit - lineW;
    const per = new Array(ln.length).fill(0);
    for (let i = 0; i < ln.length && slack > 0; i++) {
      if (i > 0 && t3IsCJK(ln[i])) { per[i] += 1; slack--; }
    }
    for (let i = 0; i < ln.length && slack > 0; i++) {
      if (i > 0 && !t3IsCJK(ln[i])) { per[i] += 1; slack--; }
    }
    let str = '';
    for (let j = 0; j < ln.length; j++) { if (per[j]) str += ' '.repeat(per[j]); str += ln[j]; }
    if (slack > 0) str += ' '.repeat(slack);
    out.push(str);
  });
  const lastW = lines.length ? lines[lines.length - 1].reduce((s, c) => s + t3Width(c), 0) : 0;
  return { lines: out, lastWidth: lastW };
}
export const T3_CASES = [
  { text: '数据中台', limit: 4 },          // ['数据', '中台']（首行 slack=0 不补白）
  { text: '数据中台', limit: 8 },          // 单行恰满（末行不补白）
  { text: '数据中台', limit: 12 },        // 单行（末行，slack 不用）
  { text: '数据中台测试', limit: 9 },      // ['数 据中台 ', '测试']（CJK 间隙 1 + 行尾 1）
  { text: '数据中台测试', limit: 10 },     // ['数据中台测', '试']
  { text: '', limit: 8 },
  { text: 'ab数据cd中台', limit: 6 },      // ['ab数据', 'cd中台']
  { text: 'ab数据中cd', limit: 7 },        // ['ab 数据', '中cd']（a 后补 1）
];
export function t3Ref() {
  return T3_CASES.map((c, i) => ({ i, ...t3Justify(c.text, c.limit) }));
}

// ═══════════════════════════ T4: JSON 操作重放参考实现 ═══════════════════════════
/** RFC 7386 merge-patch：对象递归合并；null 值删除目标键；非对象整体替换。 */
export function t4MergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...target };
  for (const k of Object.keys(patch)) {
    if (patch[k] === null) delete out[k];
    else if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) &&
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = t4MergePatch(out[k], patch[k]);
    else out[k] = patch[k];
  }
  return out;
}
/** RFC 6902 子集：add/remove/replace（path 为 JSON Pointer，'-' 对 add 入数组末尾） */
export function t4ApplyPatch(doc, ops) {
  let cur = JSON.parse(JSON.stringify(doc));
  for (const op of ops) {
    const applyOne = (o, docRef) => {
      if (o.op === 'add' || o.op === 'replace') {
        if (o.path === '') return { root: o.value };
        const parts = o.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
        let obj = docRef;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        const key = parts[parts.length - 1];
        if (Array.isArray(obj)) {
          if (key === '-') obj.push(o.value);
          else obj[Number(key)] = o.value;
        } else if (o.op === 'add' && obj[key] !== undefined) {
          obj[key] = o.value; // add 到已存在对象键 = 替换
        } else obj[key] = o.value;
      } else if (o.op === 'remove') {
        if (o.path === '') return { root: undefined, deleteRoot: true };
        const parts = o.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
        let obj = docRef;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        const key = parts[parts.length - 1];
        if (Array.isArray(obj)) obj.splice(Number(key), 1);
        else delete obj[key];
      } else throw new Error('T4 参考: 不支持操作 ' + o.op);
    };
    const r = applyOne(op, cur);
    if (r && r.deleteRoot) cur = undefined;
    else if (r && 'root' in r && r.root !== undefined && op.path === '') cur = r.root;
  }
  return cur;
}
export const T4_SEEDS = [{ doc: { a: 1, b: { c: 2, d: [1, 2] } } }];
export const T4_OPS = [
  { name: 'm1', seed: 0, op: { seq: 1, kind: 'merge-patch', path: '', value: { b: { d: 3, e: 5 } } } },
  { name: 'm2', seed: 0, op: { seq: 2, kind: 'json-patch', value: { op: 'add', path: '/x', value: { y: [true] } } } },
  { name: 'm3', seed: 0, op: { seq: 3, kind: 'json-patch', value: { op: 'remove', path: '/a' } } },
  { name: 'm4', seed: 0, op: { seq: 4, kind: 'json-patch', value: { op: 'add', path: '/x/y/-', value: false } } },
];
/** 重放：states[0]=seed 初态；states[i]=第 i 个操作后状态 */
export function t4Replay() {
  const states = [canon(T4_SEEDS[0].doc)];
  let cur = T4_SEEDS[0].doc;
  for (const o of T4_OPS) {
    cur = o.op.kind === 'merge-patch' ? t4MergePatch(cur, o.op.value) : t4ApplyPatch(cur, [o.op.value]);
    states.push(canon(cur));
  }
  return { states };
}

// ═══════════════════════════ T5: 确定性事件状态机参考实现 ═══════════════════════════
/**
 * 规格：
 * - 机 {states:[{id,accepting}], transitions:[{from,event,to}], initial}
 * - 事件流 [{name,data}]；逐事件：在当前 state 的出边中按定义顺序找**第一条**
 *   event 名匹配者；无匹配则忽略。到达 accepting 态即发 {i, state, event, data}
 *   （i 为事件下标）；snapshots[i] = 处理完第 i 个事件后的 {state, i}
 * - resume(snapshot, tail)：从 snapshot.state 出发按同规则处理 tail，输出同构
 * 输出：{accepted, finalState, snapshots}
 */
export function t5Run(machine, events) {
  let state = machine.initial;
  const accepted = [];
  const snapshots = [];
  events.forEach((ev, i) => {
    let fired = false;
    for (const t of machine.transitions) {
      if (t.from === state && t.event === ev.name) { state = t.to; fired = true; break; }
    }
    if (fired && machine.states.find((s) => s.id === state)?.accepting) accepted.push({ i, state, event: ev.name, data: ev.data });
    snapshots.push({ state, i });
  });
  return { accepted, finalState: state, snapshots };
}
export const T5_MACHINE = {
  initial: 'idle',
  states: [
    { id: 'idle', accepting: false },
    { id: 'busy', accepting: false },
    { id: 'ok', accepting: true },
    { id: 'failed', accepting: true },
  ],
  transitions: [
    { from: 'idle', event: 'start', to: 'busy' },
    { from: 'busy', event: 'done', to: 'ok' },
    { from: 'busy', event: 'err', to: 'failed' },
    { from: 'idle', event: 'tick', to: 'idle' },
    { from: 'ok', event: 'reset', to: 'idle' },
    { from: 'failed', event: 'reset', to: 'idle' },
  ],
};
export const T5_EVENTS = [
  { name: 'start', data: 'a' },
  { name: 'tick', data: null },
  { name: 'done', data: 'd1' },
  { name: 'err', data: 'x' },
  { name: 'reset', data: null },
  { name: 'start', data: 'b' },
  { name: 'done', data: 'd2' },
  { name: 'zzz', data: null },
];
export function t5Ref() {
  const full = t5Run(T5_MACHINE, T5_EVENTS);
  const snap = full.snapshots[3];
  const tail = t5Run({ ...T5_MACHINE, initial: snap.state }, T5_EVENTS.slice(4));
  return { full, snapIndex: 3, snap, tail };
}

// ═══════════════════════════ T6: 二进制帧协议 + CRC16-CCITT ═══════════════════════════
/**
 * 帧布局（小端）：magic 4B FE ED A7 11 | version 1B | seq 2B | len 4B | payload len B |
 * crc 2B（定长部分共 13 字节；CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF，
 * 覆盖 version+seq+len+payload 全部字节，小端存储于帧尾）
 * 解码判定顺序：magic 错→BAD_MAGIC（逐字节重同步）；crc 错→BAD_CRC；version≠1→BAD_VERSION；
 * 定长部分不足 13B 或 payload 不足→INCOMPLETE（停流）；
 * 正常输出 {ok:true, seq, version, payload(按 UTF-8 文本)}，错误输出 {ok:false, error, at(字节偏移)}
 */
export function t6Crc16(buf) {
  // ★ 2026-11-24 修复：旧表驱动实现掩码写错（T[i] = c & 0xffff 少了 ^0x1021 后的
  //   回卷语义），算出的值既不是 CCITT-FALSE（"123456789" 应为 0x29B1，旧表得 0xCF82）。
  //   改为标准 MSB-first 逐位实现：poly 0x1021 / init 0xFFFF / 无反射 / 无输出异或。
  let x = 0xffff;
  for (const b of buf) {
    x ^= b << 8;
    for (let k = 0; k < 8; k++) x = x & 0x8000 ? ((x << 1) ^ 0x1021) & 0xffff : (x << 1) & 0xffff;
  }
  return x & 0xffff;
}
export const T6_MAGIC = [0xfe, 0xed, 0xa7, 0x11];
export function t6Encode(seq, payload, version = 1) {
  const p = Buffer.from(payload, 'utf8');
  const hdr = Buffer.alloc(11);
  T6_MAGIC.forEach((b, i) => hdr[i] = b);
  hdr[4] = version;
  hdr.writeUInt16LE(seq, 5);
  hdr.writeUInt32LE(p.length, 7);
  const crc = t6Crc16(Buffer.concat([hdr.subarray(4, 11), p]));
  const out = Buffer.alloc(13 + p.length);
  hdr.copy(out, 0);
  p.copy(out, 11);
  out.writeUInt16LE(crc, 11 + p.length);
  return out;
}
export function t6DecodeStream(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    // ★ v30 口径钉死（与任务书一致，magic 优先）：
    //   剩余 < 4（读不出 4 字节 magic）→ INCOMPLETE 停流；
    //   能读出 4 字节且 ≠ magic → 逐字节重同步 BAD_MAGIC（即使定长部分没收全）；
    //   magic 命中后，表头（前 11 字节 = magic+version+seq+len）未收全 → INCOMPLETE 停流
    //   （否则 readUInt32LE(off+7) 越界抛 RangeError）。
    if (off + 4 > buf.length) { out.push({ ok: false, error: 'INCOMPLETE', at: off }); break; }
    if (!buf.subarray(off, off + 4).equals(Buffer.from(T6_MAGIC))) {
      out.push({ ok: false, error: 'BAD_MAGIC', at: off });
      off++;
      continue;
    }
    if (off + 11 > buf.length) { out.push({ ok: false, error: 'INCOMPLETE', at: off }); break; }
    const version = buf[off + 4];
    const seq = buf.readUInt16LE(off + 5);
    const len = buf.readUInt32LE(off + 7);
    if (off + 13 + len > buf.length) { out.push({ ok: false, error: 'INCOMPLETE', at: off }); break; }
    const payload = buf.subarray(off + 11, off + 11 + len);
    const stored = buf.readUInt16LE(off + 11 + len);
    const calc = t6Crc16(Buffer.concat([buf.subarray(off + 4, off + 11), payload]));
    if (calc !== stored) { out.push({ ok: false, error: 'BAD_CRC', seq, at: off }); off += 13 + len; continue; }
    if (version !== 1) { out.push({ ok: false, error: 'BAD_VERSION', seq, at: off }); off += 13 + len; continue; }
    out.push({ ok: true, seq, version, payload: payload.toString('utf8') });
    off += 13 + len;
  }
  return out;
}
export function t6Ref() {
  const f1 = t6Encode(7, 'hello');
  const f2 = t6Encode(8, '世界v30');
  const bad = Buffer.from(f1); bad[16] ^= 0x01; // 破坏首 CRC 字节
  const badVer = t6Encode(9, 'x', 2); // version=2 且按 version=2 重算 CRC → 判定顺序落在 BAD_VERSION
  const stream = Buffer.concat([f1, bad, f2, badVer]);
  const truncated = Buffer.from(f2.subarray(0, 9)); // 不足 13 定长部分
  const zeros11 = Buffer.alloc(11);
  return {
    f1_hex: f1.toString('hex'),
    f2_hex: f2.toString('hex'),
    stream_hex: stream.toString('hex'),
    truncated_hex: truncated.toString('hex'),
    zeros11_hex: zeros11.toString('hex'),
    out: {
      roundtrip: t6DecodeStream(f1),
      stream: t6DecodeStream(stream),
      truncated: t6DecodeStream(truncated),
      zeros: t6DecodeStream(zeros11),
    },
  };
}

// ═══════════════════════════ 夹具播种 ═══════════════════════════
export function seed() {
  const r6 = t6Ref();
  writeFixture(D(1), 'cases.json', JSON.stringify({ db: T1_DB, cases: T1_CASES.map((c) => ({ name: c.name, sql: c.sql })) }, null, 2));
  writeFixture(D(2), 'wal.json', JSON.stringify(T2_SCENARIOS.map((s) => ({ name: s.name, fromLsn: s.fromLsn, wal: s.wal })), null, 2));
  writeFixture(D(3), 'cases.json', JSON.stringify(T3_CASES, null, 2));
  writeFixture(D(4), 'ops.json', JSON.stringify({ seeds: T4_SEEDS, ops: T4_OPS }, null, 2));
  writeFixture(D(5), 'machines.json', JSON.stringify({ machine: T5_MACHINE, events: T5_EVENTS, snapshotIndex: 3, resumeFrom: 4 }, null, 2));
  writeFixture(D(6), 'frames.json', JSON.stringify({
    pairs: [[7, 'hello'], [8, '世界v30']],
    stream_hex: r6.stream_hex,
    truncated_hex: r6.truncated_hex,
    zeros11_hex: r6.zeros11_hex,
  }, null, 2));
}
export function saveFixtureHashes(file = `${WS}/v30-fixture-hashes.json`) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURE_HASHES), null, 2));
}
export function loadFixtureHashes(file = `${WS}/v30-fixture-hashes.json`) {
  try {
    for (const [p, h] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) FIXTURE_HASHES.set(p, h);
  } catch { /* 首次 */ }
}

/** harness 自校准：参考实现一致性 + 期望值固化核对 */
export function selfCheck() {
  const bad = [];
  // T1
  const r1 = t1Ref();
  for (const c of T1_CASES) {
    if (!sameJson(r1[c.name], c.expected)) bad.push(`T1 ${c.name} 参考输出与固化期望不符: ${JSON.stringify(r1[c.name]).slice(0, 240)}`);
  }
  // T2
  const r2 = t2Ref();
  if (!sameJson(r2[0].state, { b: 22, c: 3, d: 4 })) bad.push('T2 sc1 state 漂移: ' + JSON.stringify(r2[0].state));
  if (r2[0].ckpt_lsn !== 6 || r2[0].replayed !== 2 || r2[0].total !== 8) bad.push('T2 sc1 ckpt_lsn/replayed/total 漂移');
  if (!sameJson(r2[1].state, { b: 22, d: 4 }) || r2[1].ckpt_lsn !== null || r2[1].replayed !== 2 || r2[1].total !== 2) bad.push('T2 sc2 漂移: ' + JSON.stringify(r2[1]));
  if (!sameJson(r2[2].state, { x: 'v' }) || r2[2].replayed !== 1) bad.push('T2 sc3 漂移');
  // T3
  const j4 = t3Justify('数据中台', 4);
  if (JSON.stringify(j4.lines) !== JSON.stringify(['数据', '中台'])) bad.push('T3 limit4 漂移: ' + JSON.stringify(j4.lines));
  const j8 = t3Justify('数据中台', 8);
  if (j8.lines.length !== 1 || j8.lines[0] !== '数据中台' || j8.lastWidth !== 8) bad.push('T3 恰满漂移: ' + JSON.stringify(j8));
  const j9 = t3Justify('数据中台测试', 9);
  if (JSON.stringify(j9.lines) !== JSON.stringify(['数 据中台', '测试'])) bad.push('T3 limit9 漂移: ' + JSON.stringify(j9.lines));
  const j7m = t3Justify('ab数据中cd', 7);
  if (JSON.stringify(j7m.lines) !== JSON.stringify(['ab 数据', '中cd'])) bad.push('T3 混合漂移: ' + JSON.stringify(j7m.lines));
  const j0 = t3Justify('', 8);
  if (!sameJson(j0.lines, []) || j0.lastWidth !== 0) bad.push('T3 空文本漂移');
  // T4
  const r4 = t4Replay();
  if (r4.states.length !== 5) bad.push('T4 状态数漂移 ' + r4.states.length);
  if (JSON.stringify(r4.states[4]) !== JSON.stringify({ b: { c: 2, d: 3, e: 5 }, x: { y: [true, false] } })) bad.push('T4 末态漂移: ' + JSON.stringify(r4.states[4]));
  // T5
  const r5 = t5Ref();
  if (r5.full.accepted.length !== 2 || r5.full.accepted[0].i !== 2 || r5.full.accepted[1].i !== 6) bad.push('T5 accepted 漂移: ' + JSON.stringify(r5.full.accepted));
  if (r5.full.finalState !== 'ok') bad.push('T5 finalState 漂移 ' + r5.full.finalState);
  if (r5.snap.state !== 'ok' || r5.snap.i !== 3) bad.push('T5 快照漂移 ' + JSON.stringify(r5.snap));
  if (r5.tail.finalState !== r5.full.finalState) bad.push('T5 续跑终态不一致');
  if (r5.tail.accepted.length !== 1 || r5.tail.accepted[0].event !== 'done') bad.push('T5 续跑 accepted 漂移');
  // T6
  const r6 = t6Ref();
  // ★ 已知向量钉死：CCITT-FALSE 标准值 "123456789" → 0x29B1（任务书明写）。
  //   防 t6Crc16 实现漂移（旧表驱动版算出 0xCF82，被 v30 T6 假回归揪出）。
  if (t6Crc16(Buffer.from('123456789')) !== 0x29b1) bad.push('T6 crc16 已知向量漂移: ' + t6Crc16(Buffer.from('123456789')).toString(16));
  if (!r6.out.roundtrip[0].ok || r6.out.roundtrip[0].payload !== 'hello') bad.push('T6 roundtrip 漂移');
  const st = r6.out.stream;
  if (st.length !== 4 || st[0].ok !== true || st[1].error !== 'BAD_CRC' || st[2].ok !== true || st[2].payload !== '世界v30' || st[3].error !== 'BAD_VERSION') bad.push('T6 stream 漂移: ' + JSON.stringify(st.map((x) => x.ok ? 'ok' : x.error)));
  if (r6.out.truncated[0].error !== 'INCOMPLETE') bad.push('T6 truncated 漂移');
  if (r6.out.zeros[0].error !== 'BAD_MAGIC') bad.push('T6 zeros 漂移: ' + JSON.stringify(r6.out.zeros));
  return bad;
}
