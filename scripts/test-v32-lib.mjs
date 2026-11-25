/**
 * EvoClaw v32 压测共享库 —— 9 任务，领域与 v12–v31 全部任务零重叠：
 *   T1  四则运算表达式求值（shunting-yard + RPN，Python，floor 除/取余钉死）
 *   T2  KMP 前缀函数 + 重叠串匹配位置（Node）
 *   T3  Bloom filter（zlib.crc32 钉死哈希 + 误判率报告，Python）
 *   T4  LRU / LFU / CLOCK 缓存模拟器（Python）
 *   T5  指数退避 full-jitter（LCG 种子）+ 熔断器状态机（Node）
 *   T6  N-queens 回计数 + 字典序首解（Python）
 *   T7  撤销/重做编辑器操作日志（连续插入合并组，Node）
 *   T8  有向图传递闭包 + 可达对统计（Floyd，Node）
 *   T9  确定性 quickselect（中位数三选 + Lomuto，比较计数，Python）
 *
 * 参考实现用于 harness 自校准与对模型交付物的独立复算（不依赖被测产物）。
 * 夹具由 seed() 写入各任务目录，写入时记录哈希（frozen 校验）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { crc32 } from 'node:zlib';
import { writeFixture, FIXTURE_HASHES, canon as canonShared, pyReadTextLiteral } from './v14/lib.mjs';
export { pyReadTextLiteral };

export const WS = '/home/chy/EvoClaw/data/workspace';
export const D = (n) => `${WS}/v32-t${n}`;
export const canon = canonShared;
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/**
 * Python 模块装载片段（v32 T9 教训）：`sys.path.insert + import x` 遇到内置/frozen
 * 模块（如 select）会被无条件遮蔽——sys.path 优先级低于 builtins/frozen。
 * 所有 Python 探针统一用 importlib 按**文件路径**装载，杜绝同类假回归。
 * 片段把装载结果绑定为变量 `m`，调用方只需 `import json, sys`。
 */
export function pyLoadModule(alias, file) {
  return `import importlib.util as _ilu\n` +
    `_spec = _ilu.spec_from_file_location(${JSON.stringify(alias)}, ${JSON.stringify(file)})\n` +
    `m = _ilu.module_from_spec(_spec)\n` +
    `_spec.loader.exec_module(m)`;
}

// ═══════════════════════════ T1: 表达式求值参考实现 ═══════════════════════════
// 钉死口径：+ - * / % 与括号；一元负号优先级高于 * / %；
// / = 向负无穷取整除法（floor，如 -7/2=-4）；% = 结果符号随除数（如 -7%3=2）；
// 除零 → 报错。操作数为非负整数。

export const T1_CASES = [
  { name: 'e1', expr: '2+3*4' },
  { name: 'e2', expr: '(2+3)*4' },
  { name: 'e3', expr: '-2*3' },
  { name: 'e4', expr: '2*-3' },
  { name: 'e5', expr: '-7/2' },
  { name: 'e6', expr: '7/2' },
  { name: 'e7', expr: '-7%3' },
  { name: 'e8', expr: '10%3' },
  { name: 'e9', expr: '((1+2))*(3-4)' },
  { name: 'e10', expr: '1-2-3' },
];

function t1Eval(expr) {
  const toks = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < expr.length && expr[j] >= '0' && expr[j] <= '9') j++;
      toks.push({ t: 'num', v: Number(expr.slice(i, j)) });
      i = j; continue;
    }
    if (ch === '-' && (toks.length === 0 || toks[toks.length - 1].t === 'op' || toks[toks.length - 1].t === '(')) {
      toks.push({ t: 'op', v: 'u-' }); i++; continue;
    }
    if ('+-*/%'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(') { toks.push({ t: '(' }); i++; continue; }
    if (ch === ')') { toks.push({ t: ')' }); i++; continue; }
    throw new Error('bad char ' + ch);
  }
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u-': 3 };
  const rightAssoc = new Set(['u-']);
  const st = [];
  const out = [];
  for (const tk of toks) {
    if (tk.t === 'num') out.push(tk.v);
    else if (tk.t === 'op') {
      while (st.length) {
        const top = st[st.length - 1];
        if (top.t !== 'op') break;
        if (prec[top.v] > prec[tk.v] || (prec[top.v] === prec[tk.v] && !rightAssoc.has(tk.v))) { out.push(st.pop().v); }
        else break;
      }
      st.push(tk);
    } else if (tk.t === '(') st.push(tk);
    else {
      while (st.length && st[st.length - 1].t !== '(') out.push(st.pop().v);
      if (!st.length) throw new Error('unbalanced');
      st.pop();
    }
  }
  while (st.length) out.push(st.pop().v);
  const ev = [];
  for (const x of out) {
    if (typeof x === 'number') { ev.push(x); continue; }
    if (x === 'u-') { ev.push(-ev.pop()); continue; }
    const b = ev.pop(), a = ev.pop();
    switch (x) {
      case '+': ev.push(a + b); break;
      case '-': ev.push(a - b); break;
      case '*': ev.push(a * b); break;
      case '/':
        if (b === 0) throw new Error('division by zero');
        ev.push(Math.floor(a / b)); break;
      case '%':
        if (b === 0) throw new Error('division by zero');
        ev.push(((a % b) + b) % b); break;
    }
  }
  return ev[0];
}

export function t1Ref() {
  const out = {};
  for (const c of T1_CASES) out[c.name] = t1Eval(c.expr);
  return out;
}

// ═══════════════════════════ T2: KMP 参考实现 ═══════════════════════════

export function kmpPrefix(p) {
  const n = p.length;
  const pi = new Array(n).fill(0);
  let j = 0;
  for (let i = 1; i < n; i++) {
    while (j > 0 && p[i] !== p[j]) j = pi[j - 1];
    if (p[i] === p[j]) j++;
    pi[i] = j;
  }
  return pi;
}

export function kmpAll(text, pat) {
  if (!pat.length) return [];
  const pi = kmpPrefix(pat);
  const res = [];
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    while (j > 0 && text[i] !== pat[j]) j = pi[j - 1];
    if (text[i] === pat[j]) j++;
    if (j === pat.length) { res.push(i - pat.length + 1); j = pi[j - 1]; }
  }
  return res;
}

export const T2_CASES = [
  { text: 'aaaa', pattern: 'aa' },
  { text: 'abcababcab', pattern: 'abcab' },
  { text: 'mississippi', pattern: 'ssi' },
  { text: 'abc', pattern: 'abcd' },
  { text: 'abc', pattern: '' },
  { text: 'a', pattern: 'a' },
  { text: 'ababab', pattern: 'abab' },
  { text: 'xabcabc', pattern: 'abc' },
];

export const t2Ref = () => T2_CASES.map((c) => ({
  text: c.text,
  pattern: c.pattern,
  pi: kmpPrefix(c.pattern),
  positions: kmpAll(c.text, c.pattern),
}));

// ═══════════════════════════ T3: Bloom filter 参考实现 ═══════════════════════════
// 钉死哈希：h_i(s) = zlib.crc32(utf8(s + "#" + i)) % m，i = 0..k-1。

export const T3_FIXTURE = {
  m: 4096,
  k: 5,
  items: Array.from({ length: 100 }, (_, i) => `user${String(i + 1).padStart(4, '0')}`),
  probes: Array.from({ length: 16 }, (_, i) => `probe${String(i).padStart(3, '0')}`),
};

export function t3Ref(spec) {
  const bits = new Array(spec.m).fill(0);
  const h = (s, i) => crc32(Buffer.from(s + '#' + i, 'utf8')) % spec.m;
  for (const s of spec.items) for (let i = 0; i < spec.k; i++) bits[h(s, i)] = 1;
  const contains = (s) => {
    for (let i = 0; i < spec.k; i++) if (!bits[h(s, i)]) return false;
    return true;
  };
  const falsePositives = spec.probes.filter(contains);
  const bitsSet = bits.reduce((a, b) => a + b, 0);
  const expFpr = Math.pow(1 - Math.exp(-(spec.k * spec.items.length) / spec.m), spec.k);
  return {
    bitsSet,
    allMembersIn: spec.items.every(contains),
    falsePositives,
    obsFpr: spec.probes.length ? falsePositives.length / spec.probes.length : 0,
    expFpr,
  };
}

// ═══════════════════════════ T4: 缓存模拟器参考实现 ═══════════════════════════

export const T4_FIXTURE = {
  cap: 3,
  trace: [
    'put:a', 'put:b', 'put:c', 'get:a', 'get:d', 'put:d', 'get:b', 'get:c',
    'get:a', 'put:e', 'get:e', 'get:b', 'put:f', 'get:c', 'get:f', 'get:d',
  ],
};

function parseOp(op) {
  const [kind, key] = op.split(':');
  return { kind, key };
}

function t4Lru(cap, trace) {
  const order = []; // oldest → newest
  const have = new Map();
  let hits = 0, misses = 0, evictions = 0;
  for (const op of trace) {
    const { kind, key } = parseOp(op);
    if (have.has(key)) {
      hits++;
      order.splice(order.indexOf(key), 1);
      order.push(key);
      have.set(key, kind === 'put');
    } else {
      misses++;
      if (kind === 'put') {
        if (order.length === cap) { have.delete(order.shift()); evictions++; }
        order.push(key);
        have.set(key, true);
      }
    }
  }
  return { hits, misses, evictions, final: order.slice() };
}

function t4Lfu(cap, trace) {
  const cache = new Map(); // key → {freq, last}
  let hits = 0, misses = 0, evictions = 0;
  trace.forEach((op, idx) => {
    const { kind, key } = parseOp(op);
    if (cache.has(key)) {
      hits++;
      const e = cache.get(key);
      e.freq++;
      e.last = idx;
    } else {
      misses++;
      if (kind === 'put') {
        if (cache.size === cap) {
          let victim = null;
          for (const [k, e] of cache) {
            if (victim === null) { victim = k; continue; }
            const ev = cache.get(victim);
            if (e.freq < ev.freq || (e.freq === ev.freq && (e.last < ev.last || (e.last === ev.last && k < victim)))) victim = k;
          }
          cache.delete(victim);
          evictions++;
        }
        cache.set(key, { freq: 1, last: idx });
      }
    }
  });
  const final = [...cache.entries()]
    .sort((a, b) => (a[1].freq - b[1].freq) || (a[1].last - b[1].last) || a[0].localeCompare(b[0]))
    .map((e) => e[0]);
  return { hits, misses, evictions, final };
}

function t4Clock(cap, trace) {
  const ring = new Array(cap).fill(null); // key | null
  const ref = new Array(cap).fill(0);
  const pos = new Map(); // key → slot
  let hand = 0;
  let hits = 0, misses = 0, evictions = 0;
  for (const op of trace) {
    const { kind, key } = parseOp(op);
    if (pos.has(key)) {
      hits++;
      ref[pos.get(key)] = 1;
    } else {
      misses++;
      if (kind !== 'put') continue; // get miss 不缓存（无 read-through）
      let placed = false;
      for (let step = 0; step < cap; step++) {
        const slot = hand % cap;
        if (ring[slot] === null) {
          ring[slot] = key; ref[slot] = 1;
          pos.set(key, slot);
          hand = slot + 1;
          placed = true; break;
        }
        if (ref[slot] === 1) {
          ref[slot] = 0;
          hand = slot + 1;
          continue;
        }
        pos.delete(ring[slot]);
        ring[slot] = key; ref[slot] = 1;
        pos.set(key, slot);
        hand = slot + 1;
        evictions++;
        placed = true; break;
      }
      if (!placed) { // 扫满一圈后强制淘汰 hand 所指（全 ref 已清零）
        const slot = hand % cap;
        pos.delete(ring[slot]);
        ring[slot] = key; ref[slot] = 1;
        pos.set(key, slot);
        hand = slot + 1;
        evictions++;
      }
    }
  }
  const final = [];
  for (let i = 0; i < cap; i++) final.push(ring[hand % cap === i ? i : (hand + i) % cap] ?? null);
  // 从 hand 起顺时针读取：
  const finalOrder = [];
  for (let i = 0; i < cap; i++) finalOrder.push(ring[(hand + i) % cap]);
  return { hits, misses, evictions, final: finalOrder };
}

export function t4Ref(spec) {
  return { lru: t4Lru(spec.cap, spec.trace), lfu: t4Lfu(spec.cap, spec.trace), clock: t4Clock(spec.cap, spec.trace) };
}

// ═══════════════════════════ T5: 退避 + 熔断器参考实现 ═══════════════════════════

export const T5_FIXTURE = {
  backoff: { attempts: 7, baseMs: 100, factor: 2, capMs: 4000, seed: 12345 },
  breaker: {
    failThreshold: 3,
    openMs: 1000,
    events: [
      { t: 1000, ok: false }, { t: 2000, ok: false }, { t: 3000, ok: false },
      { t: 3000 + 500, ok: true }, { t: 4000, ok: true },
      { t: 5000, ok: false }, { t: 6000, ok: false }, { t: 7000, ok: false },
      { t: 8500, ok: false }, { t: 9000, ok: false }, { t: 9500, ok: true },
    ],
  },
};

function t5Lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = ((Math.imul(x, 1103515245) + 12345) % 2147483648 + 2147483648) % 2147483648;
    return x >>> 0;
  };
}

export function t5Backoff(cfg) {
  const rnd = t5Lcg(cfg.seed);
  const schedule = [0];
  const waits = [];
  const draws = [];
  for (let i = 1; i < cfg.attempts; i++) {
    const limit = Math.min(cfg.capMs, cfg.baseMs * Math.pow(cfg.factor, i - 1));
    const r = rnd();
    draws.push(r);
    const w = Math.floor((r / 4294967296) * limit);
    waits.push(w);
    schedule.push(schedule[schedule.length - 1] + w);
  }
  return { schedule, waits, draws };
}

export function t5Breaker(spec) {
  let state = 'closed';
  let f = 0;
  let openUntil = -1;
  let failures = 0;
  let successes = 0;
  const timeline = [];
  const transitions = [];
  for (const ev of spec.events) {
    if (state === 'open' && ev.t >= openUntil) {
      state = 'half-open';
      transitions.push('open->half-open');
    }
    if (state === 'open') {
      // open 期内（t < openUntil）事件被快速失败丢弃：不计入 successes/failures，状态保持 open
      timeline.push({ t: ev.t, state });
      continue;
    }
    if (ev.ok) {
      successes++;
      // 「连续失败」语义：closed 态成功清零连续失败计数（prompt 明写「连续 failThreshold 次」）
      if (state === 'closed') f = 0;
      if (state === 'half-open') { state = 'closed'; f = 0; transitions.push('half-open->closed'); }
    } else {
      failures++;
      if (state === 'half-open') {
        state = 'open';
        openUntil = ev.t + spec.openMs;
        transitions.push('half-open->open');
      } else {
        f++;
        if (f >= spec.failThreshold) {
          state = 'open';
          openUntil = ev.t + spec.openMs;
          f = 0;
          transitions.push('closed->open');
        }
      }
    }
    timeline.push({ t: ev.t, state });
  }
  return { finalState: state, transitions, failures, successes, timeline };
}

export function t5Ref() {
  return { backoff: t5Backoff(T5_FIXTURE.backoff), breaker: t5Breaker(T5_FIXTURE.breaker) };
}

// ═══════════════════════════ T6: N-queens 参考实现 ═══════════════════════════

export const T6_FIXTURE = { ns: [1, 4, 5, 6, 8, 9] };

export function t6Solve(n) {
  if (n === 1) return { count: 1, first: [0] };
  if (n < 4) return { count: 0, first: null };
  let count = 0;
  let first = null;
  const usedCol = new Array(n).fill(false);
  const diag1 = new Array(2 * n - 1).fill(false); // 行+列
  const diag2 = new Array(2 * n - 1).fill(false); // 行−列+n−1
  const cols = new Array(n).fill(-1);
  const rec = (row) => {
    if (row === n) { count++; if (!first) first = cols.slice(); return; }
    for (let c = 0; c < n; c++) {
      if (usedCol[c] || diag1[row + c] || diag2[row - c + n - 1]) continue;
      cols[row] = c;
      usedCol[c] = true;
      diag1[row + c] = true;
      diag2[row - c + n - 1] = true;
      rec(row + 1);
      usedCol[c] = false;
      diag1[row + c] = false;
      diag2[row - c + n - 1] = false;
      cols[row] = -1;
    }
  };
  rec(0);
  return { count, first };
}

export function t6Ref() {
  const out = {};
  for (const n of T6_FIXTURE.ns) out[String(n)] = t6Solve(n);
  return out;
}

// ═══════════════════════════ T7: 撤销/重做参考实现 ═══════════════════════════

export const T7_FIXTURE = {
  init: [10, 20],
  ops: [
    { op: 'ins', pos: 2, val: 30 },
    { op: 'ins', pos: 3, val: 40 },
    { op: 'ins', pos: 4, val: 50 },
    { op: 'undo' },
    { op: 'ins', pos: 2, val: 70 },
    { op: 'redo' },
    { op: 'del', pos: 2 },
    { op: 'undo' },
    { op: 'redo' },
    { op: 'ins', pos: 2, val: 80 },
    { op: 'undo' },
    { op: 'undo' },
  ],
};

export function t7Apply(init, ops) {
  let arr = init.slice();
  const undoStack = [];
  let redoStack = [];
  let undos = 0;
  let redos = 0;
  let nGroups = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'ins' || op.op === 'del') {
      redoStack = [];
      let g = null;
      if (op.op === 'ins' && i > 0 && ops[i - 1].op === 'ins' && op.pos === ops[i - 1].pos + 1) {
        g = undoStack[undoStack.length - 1];
      }
      if (!g) { g = { u: [], r: [] }; undoStack.push(g); nGroups++; }
      if (op.op === 'ins') {
        // 越界 pos 视为追加（prompt 钉死）：按实际插入位置记录撤销/重做，undo 才能正确回滚
        const at = Math.min(op.pos, arr.length);
        arr.splice(at, 0, op.val);
        g.u.push({ op: 'del', pos: at });
        g.r.push({ op: 'ins', pos: at, val: op.val });
      } else {
        const v = arr.splice(op.pos, 1)[0];
        g.u.push({ op: 'ins', pos: op.pos, val: v });
        g.r.push({ op: 'del', pos: op.pos });
      }
    } else if (op.op === 'undo') {
      const g = undoStack.pop();
      if (!g) continue;
      for (let j = g.u.length - 1; j >= 0; j--) {
        const e = g.u[j];
        if (e.op === 'ins') arr.splice(e.pos, 0, e.val);
        else arr.splice(e.pos, 1);
      }
      redoStack.push(g);
      undos++;
    } else if (op.op === 'redo') {
      const g = redoStack.pop();
      if (!g) continue;
      for (const e of g.r) {
        if (e.op === 'ins') arr.splice(e.pos, 0, e.val);
        else arr.splice(e.pos, 1);
      }
      undoStack.push(g);
      redos++;
    }
  }
  return { final: arr, groups: nGroups, undos, redos };
}

export const t7Ref = () => t7Apply(T7_FIXTURE.init, T7_FIXTURE.ops);

// ═══════════════════════════ T8: 传递闭包参考实现 ═══════════════════════════

export const T8_FIXTURE = {
  n: 8,
  edges: [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 5], [5, 3], [6, 7], [7, 6], [1, 7], [4, 6]],
  queries: [[0, 5], [5, 0], [7, 4], [2, 4], [6, 6], [0, 0], [3, 7], [4, 2]],
};

export function t8Closure(spec) {
  const n = spec.n;
  const reach = Array.from({ length: n }, () => new Array(n).fill(false));
  // 自环边保留在 reach 矩阵（prompt 钉死 i==j 查询按直接边判定），
  // 只在 total/out-degree 处过滤 i!==j（自环不产生 i≠j 的可达对）
  for (const [u, v] of spec.edges) reach[u][v] = true;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!reach[i][k]) continue;
      for (let j = 0; j < n; j++) if (reach[k][j]) reach[i][j] = true;
    }
  }
  const results = spec.queries.map(([a, b]) => reach[a][b]);
  let total = 0;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && reach[i][j]) { total++; out[i]++; }
    }
  }
  let maxOut = [0, 0];
  for (let i = 0; i < n; i++) if (out[i] > maxOut[1]) maxOut = [i, out[i]];
  return { results, total, maxOut };
}

export const t8Ref = () => t8Closure(T8_FIXTURE);

// ═══════════════════════════ T9: quickselect 参考实现 ═══════════════════════════

export const T9_CASES = [
  { a: [3, 1, 2], k: 1 },
  { a: [7, 2, 9, 4, 5, 1, 8, 3, 6], k: 4 },
  { a: [5, 5, 5, 5], k: 2 },
  { a: [10, -3, 7, 0, -3, 7, 2, 9], k: 3 },
  { a: [1], k: 0 },
  { a: [4, 2, 7, 1, 9, 3, 6, 8, 5, 0], k: 7 },
];

export function t9Kth(a, k) {
  const arr = a.slice();
  let l = 0;
  let r = arr.length - 1;
  let comps = 0;
  for (;;) {
    const m = (l + r) >> 1;
    const triple = [arr[l], arr[m], arr[r]].sort((x, y) => x - y);
    const pivot = triple[1]; // 中位值
    // 把中位值换到 r：取 l、m、r 中从左到右第一个等于中位值的下标与 r 交换（相等不动）
    let src = l;
    if (arr[src] !== pivot && arr[m] === pivot) src = m;
    else if (arr[src] !== pivot && arr[r] === pivot) src = r;
    const tmp = arr[src];
    arr[src] = arr[r];
    arr[r] = tmp;
    let i = l - 1;
    for (let j = l; j < r; j++) {
      comps++;
      if (arr[j] <= pivot) {
        i++;
        const t2 = arr[i];
        arr[i] = arr[j];
        arr[j] = t2;
      }
    }
    const t3 = arr[i + 1];
    arr[i + 1] = arr[r];
    arr[r] = t3;
    const p = i + 1;
    if (p === k) return [arr[p], comps];
    if (p > k) r = p - 1;
    else l = p + 1;
  }
}

export function t9Ref() {
  return T9_CASES.map((c) => ({ kth: t9Kth(c.a, c.k)[0], comps: t9Kth(c.a, c.k)[1] }));
}

// ═══════════════════════════ 夹具写入 ═══════════════════════════

export function seed() {
  writeFixture(D(1), 'cases.json', JSON.stringify(T1_CASES, null, 2));
  writeFixture(D(2), 'cases.json', JSON.stringify({ cases: T2_CASES }, null, 2));
  writeFixture(D(3), 'bloom.json', JSON.stringify(T3_FIXTURE, null, 2));
  writeFixture(D(4), 'cache.json', JSON.stringify(T4_FIXTURE, null, 2));
  writeFixture(D(5), 'resilience.json', JSON.stringify(T5_FIXTURE, null, 2));
  writeFixture(D(6), 'boards.json', JSON.stringify(T6_FIXTURE, null, 2));
  writeFixture(D(7), 'ops.json', JSON.stringify(T7_FIXTURE, null, 2));
  writeFixture(D(8), 'graph.json', JSON.stringify(T8_FIXTURE, null, 2));
  writeFixture(D(9), 'cases.json', JSON.stringify({ cases: T9_CASES }, null, 2));
}

export function saveFixtureHashes(file = `${WS}/v32-fixture-hashes.json`) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURE_HASHES), null, 2));
}

export function loadFixtureHashes(file = `${WS}/v32-fixture-hashes.json`) {
  if (!fs.existsSync(file)) return;
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8')))) FIXTURE_HASHES.set(k, v);
}

// ═══════════════════════════ 自校准 ═══════════════════════════

export function selfCheck() {
  const bad = [];
  // T1 已知向量
  const R1 = t1Ref();
  if (R1.e1 !== 14) bad.push('T1 e1≠14');
  if (R1.e5 !== -4) bad.push('T1 e5≠-4');
  if (R1.e7 !== 2) bad.push('T1 e7≠2');
  if (R1.e9 !== -3) bad.push('T1 e9≠-3');
  if (R1.e10 !== -4) bad.push('T1 e10≠-4');
  // T2 已知向量
  if (JSON.stringify(kmpAll('aaaa', 'aa')) !== '[0,1,2]') bad.push('T2 overlap');
  if (JSON.stringify(kmpAll('abc', 'abcd')) !== '[]') bad.push('T2 nomatch');
  if (JSON.stringify(kmpAll('abc', '')) !== '[]') bad.push('T2 empty');
  // T3 crc32 已知向量（zlib.crc32(utf8('123456789'))，Node/Python 一致）
  if (crc32(Buffer.from('123456789', 'utf8')) !== 3421780262) bad.push('T3 crc32 向量');
  const R3 = t3Ref(T3_FIXTURE);
  if (!R3.allMembersIn) bad.push('T3 members not in');
  if (R3.bitsSet < 0 || R3.bitsSet > T3_FIXTURE.m) bad.push('T3 bitsSet 越界');
  // T4 不变量
  const R4 = t4Ref(T4_FIXTURE);
  for (const alg of ['lru', 'lfu', 'clock']) {
    const s = R4[alg];
    if (s.hits + s.misses !== T4_FIXTURE.trace.length) bad.push(`T4 ${alg} hits+misses≠trace`);
    if (alg === 'lru' && s.final.length > T4_FIXTURE.cap) bad.push('T4 lru final 超容量');
    if (alg === 'clock' && s.final.length !== T4_FIXTURE.cap) bad.push('T4 clock final 长度');
  }
  // T5 不变量
  const R5 = t5Ref();
  if (R5.backoff.schedule[0] !== 0) bad.push('T5 schedule[0]≠0');
  if (R5.backoff.draws.length !== T5_FIXTURE.backoff.attempts - 1) bad.push('T5 draws 数');
  if (R5.backoff.schedule.length !== T5_FIXTURE.backoff.attempts) bad.push('T5 schedule 长度');
  if (R5.backoff.waits.length !== T5_FIXTURE.backoff.attempts - 1) bad.push('T5 waits 长度');
  // open 期内（t < openUntil）事件快速失败、不计入 successes/failures → 11 事件中 2 个被丢弃（t=3500、t=9000）
  if (R5.breaker.failures !== 7 || R5.breaker.successes !== 2) bad.push('T5 熔断计数漂移: ' + R5.breaker.failures + '/' + R5.breaker.successes);
  // T5 持续：closed 态成功清零连续失败计数（F2 外部手算向量 F,F,S,F 不转 open）
  const cc = t5Breaker({ failThreshold: 3, openMs: 1000, events: [
    { t: 1, ok: false }, { t: 2, ok: false }, { t: 3, ok: true }, { t: 4, ok: false },
  ] });
  if (cc.finalState !== 'closed' || cc.failures !== 3 || cc.successes !== 1) bad.push('T5 连续失败语义漂移: ' + JSON.stringify(cc));
  // T6 已知解数（公开已知值，n=9=352 同属外部锚点）
  if (t6Solve(4).count !== 2 || t6Solve(5).count !== 10 || t6Solve(6).count !== 4 || t6Solve(8).count !== 92 || t6Solve(9).count !== 352) bad.push('T6 已知解数');
  // T7 外部锚点（手算终局 + 越界 undo 边界 F3）
  const R7 = t7Ref();
  if (JSON.stringify(R7.final) !== '[10,20,70]' || R7.groups !== 4 || R7.undos !== 4 || R7.redos !== 1) bad.push('T7 不变量漂移: ' + JSON.stringify(R7));
  const ov = t7Apply([1, 2], [{ op: 'ins', pos: 99, val: 3 }, { op: 'undo' }]);
  if (JSON.stringify(ov.final) !== '[1,2]') bad.push('T7 越界 undo 语义漂移: ' + JSON.stringify(ov));
  // T8 外部锚点：自环查询按直接边 true（F1），total/out-degree 仍排除 i===j
  const sl = t8Closure({ n: 2, edges: [[0, 0]], queries: [[0, 0], [0, 1]] });
  if (JSON.stringify(sl) !== JSON.stringify({ results: [true, false], total: 0, maxOut: [0, 0] })) bad.push('T8 自环语义漂移: ' + JSON.stringify(sl));
  const R8 = t8Ref();
  if (R8.total !== 35 || JSON.stringify(R8.maxOut) !== '[0,7]') bad.push('T8 全局统计漂移: ' + JSON.stringify(R8));
  if (R8.results.length !== T8_FIXTURE.queries.length || R8.maxOut.length !== 2) bad.push('T8 结构漂移');
  // T9 不变量：kth == 排序后第 k 个
  for (const c of T9_CASES) {
    const sorted = c.a.slice().sort((x, y) => x - y);
    const [v] = t9Kth(c.a, c.k);
    if (v !== sorted[c.k]) bad.push(`T9 kth≠sorted[k] (${c.k}): ${v}≠${sorted[c.k]}`);
  }
  // T9 比较次数外部锚点（手算：中位数三选 + Lomuto，逐比较计数）
  const comps = t9Ref().map((r) => r.comps);
  if (JSON.stringify(comps) !== '[2,13,5,15,0,15]') bad.push('T9 comps 漂移: ' + JSON.stringify(comps));
  return bad;
}

/**
 * 交叉校验：核验器（test-v32-tasks.mjs）里的硬编码探针向量必须由参考实现复算得出。
 * v32 F1 教训：T8 探针期望自环查询 true、参考实现却丢弃自环给 false——两边
 * 各自 selfCheck 都不报错，只有「探针向量 vs 参考」交叉校验能挡住这类三方撕裂。
 */
export const PROBE_VECTORS = {
  t2Prefix: { input: 'abab', expected: [0, 0, 1, 2] },
  t2Overlap: { input: ['abcababcab', 'abcab'], expected: [0, 5] },
  t5Lcg1: { seed: 0, expected: 12345 },
  t7MergeGroups: { init: [0], ops: [{ op: 'ins', pos: 1, val: 1 }, { op: 'ins', pos: 2, val: 2 }], expected: { final: [0, 1, 2], groups: 1, undos: 0, redos: 0 } },
  t8SelfLoop: { spec: { n: 2, edges: [[0, 0]], queries: [[0, 0], [0, 1]] }, expected: { results: [true, false], total: 0, maxOut: [0, 0] } },
};

export function crossCheck() {
  const bad = [];
  const p = PROBE_VECTORS;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(kmpPrefix(p.t2Prefix.input), p.t2Prefix.expected)) bad.push('cross T2 prefix');
  if (!eq(kmpAll(...p.t2Overlap.input), p.t2Overlap.expected)) bad.push('cross T2 overlap');
  if (!eq(t5Backoff({ attempts: 2, baseMs: 1, factor: 1, capMs: 1, seed: p.t5Lcg1.seed }).draws[0] % 2147483648, p.t5Lcg1.expected % 2147483648)) {
    // LCG 首步进 x=(0*1103515245+12345)%2^31=12345，用 backoff draws 复算
    bad.push('cross T5 lcg1');
  }
  if (!eq(t7Apply(p.t7MergeGroups.init, p.t7MergeGroups.ops), p.t7MergeGroups.expected)) bad.push('cross T7 mergeGroups');
  if (!eq(t8Closure(p.t8SelfLoop.spec), p.t8SelfLoop.expected)) bad.push('cross T8 selfLoop');
  return bad;
}
