/**
 * EvoClaw v31 压测共享库 —— 10 任务，领域与 v12–v30 全部任务零重叠：
 *   T1  YAML 子集解析器（块映射/块列表/标量类型，Python）
 *   T2  复式记账账本 + 对账（借贷平衡判定/账户余额，Python）
 *   T3  优先级任务队列 + 老化防饥饿（确定性事件轨迹，Python）
 *   T4  正则子集引擎（NFA 模拟：* + ? . | [] () 转义，Node）
 *   T5  分层配置继承覆盖 + ${ref} 插值（深合并规则，Node）
 *   T6  日志轮转与保留策略模拟器（大小/保留版本/年龄淘汰，Python）
 *   T7  Gossip 反熵收敛 + 法定数交集判定（LCG 确定性，Python）
 *   T8  Count-min 重击者 top-k（fnv1a 钉死哈希，Node）
 *   T9  EDF 实时调度模拟（抢占/截止期/周期实例，Python）
 *   T10 图形原语（Bresenham/矩形描边/泛洪填充 + 像素统计，Node）
 *
 * 参考实现用于 harness 自校准与对模型交付物的独立复算（不依赖被测产物）。
 * 夹具由 seed() 写入各任务目录，写入时记录哈希（frozen 校验）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeFixture, FIXTURE_HASHES, canon as canonShared, pyReadTextLiteral } from './v14/lib.mjs';
export { pyReadTextLiteral };

export const WS = '/home/chy/EvoClaw/data/workspace';
export const D = (n) => `${WS}/v31-t${n}`;
export const canon = canonShared;
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
export const pyPath = (s) => JSON.stringify(s);

// ═══════════════════════════ T1: YAML 子集解析器参考实现 ═══════════════════════════
// 口径：块映射 + 块列表（列表项仅标量）；缩进为 2 空格倍数且严格更深；
// 标量：int / float / true / false / null(与~) / 单双引号(内容逐字，无转义) / 裸字符串；
// 注释：仅整行（trim 后以 # 开头）；无 flow / 锚点 / 多文档 / 多行块。

export const T1_CASES = [
  { name: 'y1', yaml: 'name: acme\nreplicas: 3\nlabels:\n  app: web\n  tier: 1\nempty:\n' },
  { name: 'y2', yaml: 'list:\n  - 1\n  - -2\n  - 3.5\nflags:\n  - true\n  - false\n  - null\n' },
  { name: 'y3', yaml: 'a:\n  b:\n    c:\n      - x\n      - "y z"\n' },
  { name: 'y4', yaml: "i: 42\nf: -3.25\ns1: 'a#b'\ns2: \"done\"\nb1: true\nn1: ~\n" },
  { name: 'y5', yaml: '# only a comment\n\n' },
  { name: 'y6', yaml: 'x: -1\ny: 0.0\nz: FALSE\n' },
];

export function t1Parse(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, body: t });
  }
  let pos = 0;
  const parseScalar = (s) => {
    s = s.trim();
    if (s === '' || s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
    if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  };
  const parseList = (ind) => {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === ind && lines[pos].body.startsWith('- ')) {
      arr.push(parseScalar(lines[pos].body.slice(2)));
      pos++;
    }
    return arr;
  };
  const parseMap = (ind) => {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === ind && !lines[pos].body.startsWith('- ')) {
      const m = lines[pos].body.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) throw new Error('T1 参考: 非法映射行 ' + lines[pos].body);
      pos++;
      if (m[2].trim() === '') {
        obj[m[1]] = pos < lines.length && lines[pos].indent > ind
          ? (lines[pos].body.startsWith('- ') ? parseList(lines[pos].indent) : parseMap(lines[pos].indent))
          : null;
      } else {
        obj[m[1]] = parseScalar(m[2]);
      }
    }
    return obj;
  };
  if (lines.length === 0) return null;
  const out = lines[0].body.startsWith('- ') ? parseList(lines[0].indent) : parseMap(lines[0].indent);
  if (pos !== lines.length) throw new Error('T1 参考: 尾部残留内容 ' + lines[pos].body);
  return out;
}
export function t1Ref() {
  const out = {};
  for (const c of T1_CASES) out[c.name] = t1Parse(c.yaml);
  return out;
}

// ═══════════════════════════ T2: 复式记账账本参考实现 ═══════════════════════════
export const T2_FIXTURE = {
  accounts: [
    { code: 'CA', name: 'Cash' },
    { code: 'INV', name: 'Inventory' },
    { code: 'AP', name: 'Payable' },
    { code: 'REV', name: 'Revenue' },
  ],
  journals: [
    { name: 'j_open', date: '2026-01-01', entries: [
      { account: 'CA', debit: 100000, credit: 0 },
      { account: 'INV', debit: 0, credit: 60000 },
      { account: 'AP', debit: 0, credit: 40000 },
    ]},
    { name: 'j_sale', date: '2026-01-05', entries: [
      { account: 'REV', debit: 0, credit: 8000 },
      { account: 'CA', debit: 8000, credit: 0 },
    ]},
    { name: 'j_bad', date: '2026-01-07', entries: [
      { account: 'INV', debit: 500, credit: 0 },
      { account: 'CA', debit: 0, credit: 300 },
    ]},
    { name: 'j_zero', date: '2026-01-08', entries: [] },
  ],
};

export function t2Ref() {
  const J = T2_FIXTURE;
  const journals = {};
  const balances = {};
  for (const a of J.accounts) balances[a.code] = 0;
  let totalDebit = 0;
  for (const j of J.journals) {
    const d = j.entries.reduce((s, e) => s + e.debit, 0);
    const c = j.entries.reduce((s, e) => s + e.credit, 0);
    const ok = d === c;
    journals[j.name] = ok ? 'OK' : 'UNBALANCED';
    if (ok) {
      for (const e of j.entries) {
        balances[e.account] = (balances[e.account] || 0) + e.debit - e.credit;
        totalDebit += e.debit;
      }
    }
  }
  return { journals, balances, totalDebit };
}

// ═══════════════════════════ T3: 老化优先级队列参考实现 ═══════════════════════════
export const T3_FIXTURE = {
  threshold: 2,
  jobs: [
    { id: 'B', priority: 1, arrive: 0 },
    { id: 'A', priority: 2, arrive: 0 },
    { id: 'C', priority: 0, arrive: 1 },
    { id: 'D', priority: 3, arrive: 2 },
    { id: 'E', priority: 5, arrive: 0 },
  ],
};

export function t3Ref() {
  const F = T3_FIXTURE;
  const waiting = [];
  const order = [], finish = {}, wait = {};
  const done = new Set();
  let c = 0;
  while (done.size < F.jobs.length) {
    for (const j of F.jobs) if (!done.has(j.id) && j.arrive === c) waiting.push({ id: j.id, pr: j.priority, since: c, arrive: c });
    for (const w of waiting) {
      while (c - w.since >= F.threshold) { w.pr -= 1; w.since += F.threshold; }
    }
    waiting.sort((a, b) => (a.pr - b.pr) || (a.since - b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const w = waiting.shift();
    order.push(w.id);
    wait[w.id] = c - w.arrive;
    finish[w.id] = c + 1;
    done.add(w.id);
    c++;
  }
  return { order, finish, wait };
}

// ═══════════════════════════ T4: 正则子集 NFA 参考实现 ═══════════════════════════
// 语义：整串锚定匹配（非搜索）；支持 字面量 | ? . ( ) 组 [] 类 \转义 与 * + ? 量词。
// Thompson NFA + epsilon-closure + 状态集模拟（O(len(text)*|states|)，无回溯）。
export const T4_CASES = [
  { pattern: 'a*b', text: 'aaab' },
  { pattern: 'a*b', text: 'b' },
  { pattern: 'ab+c', text: 'abb' },
  { pattern: 'colou?r', text: 'color' },
  { pattern: 'a?b', text: 'b' },
  { pattern: '[0-9]+', text: '123' },
  { pattern: '[0-9]+', text: '12a' },
  { pattern: 'x|y', text: 'y' },
  { pattern: 'a.c', text: 'abc' },
  { pattern: 'a.c', text: 'ac' },
  { pattern: 'a\\.b', text: 'a.b' },
  { pattern: 'a\\.b', text: 'acb' },
  { pattern: '(ab)+', text: 'ababab' },
  { pattern: '(ab)+', text: 'aba' },
  { pattern: 'a[bc]*d', text: 'acd' },
  { pattern: 'a[bc]*d', text: 'axd' },
  { pattern: '', text: '' },
  { pattern: 'x*', text: '' },
];

export function t4RegexMatch(pattern, text) {
  let p = 0;
  const states = [];
  const newS = () => { states.push({ eps: [], out: {} }); return states.length - 1; };
  const link = (a, b) => states[a].eps.push(b);
  const edge = (a, label, b) => { (states[a].out[label] = states[a].out[label] || []).push(b); };

  function closure(set) {
    const out = new Set(set);
    const stack = [...out];
    while (stack.length) {
      const s = stack.pop();
      for (const t of states[s].eps) if (!out.has(t)) { out.add(t); stack.push(t); }
    }
    return out;
  }
  const matchesL = (label, code) => {
    if (label === '*') return true;
    if (label[0] === 'c') return label.slice(1).split(',').includes(String(code));
    return label === 'l' + String(code);
  };

  function parseSeq() {
    // 返回 [head, tail]：head->...->tail 链；空序列返回同一状态
    if (p >= pattern.length || pattern[p] === '|' || pattern[p] === ')') {
      const s = newS();
      return [s, s];
    }
    let head = null, tail = null;
    while (p < pattern.length && pattern[p] !== '|' && pattern[p] !== ')') {
      let [h, t] = parseAtom();
      if (head === null) { head = h; }
      else link(tail, h);
      tail = t;
      // 量词（可叠加，a**? ≡ a*）：* ? 加旁路 h→t；* + 加回环 t→h
      let q = pattern[p];
      while (q === '*' || q === '+' || q === '?') {
        p++;
        if (q === '*' || q === '?') link(h, t);
        if (q === '*' || q === '+') link(t, h);
        q = pattern[p];
      }
    }
    if (head === null) return [tail, tail]; // 空序列：同一状态
    return [head, tail];
  }
  function parseAtom() {
    const c = pattern[p];
    let h = newS(), t = newS();
    if (c === '(') {
      p++;
      const [hh, tt] = parseAlt();
      if (p < pattern.length && pattern[p] === ')') p++;
      link(h, hh);
      link(tt, t);
      return [h, t];
    }
    if (c === '[') {
      p++;
      const codes = [];
      while (pattern[p] !== ']') {
        if (pattern[p + 1] === '-') {
          for (let x = pattern[p].charCodeAt(0); x <= pattern[p + 2].charCodeAt(0); x++) codes.push(x);
          p += 2;
        } else {
          codes.push(pattern[p].charCodeAt(0));
          p++;
        }
      }
      p++;
      edge(h, 'c' + codes.join(','), t);
      return [h, t];
    }
    if (c === '\\') {
      p++;
      edge(h, 'l' + pattern[p].charCodeAt(0), t);
      p++;
      return [h, t];
    }
    if (c === '.') {
      edge(h, '*', t);
      p++;
      return [h, t];
    }
    edge(h, 'l' + c.charCodeAt(0), t);
    p++;
    return [h, t];
  }
  function parseAlt() {
    let head = null, tail = null;
    const branches = [];
    for (;;) {
      const [h, t] = parseSeq();
      branches.push([h, t]);
      if (p < pattern.length && pattern[p] === '|') { p++; continue; }
      break;
    }
    const H = newS(), T = newS();
    for (const [h, t] of branches) { link(H, h); link(t, T); }
    return [H, T];
  }
  const [H, T] = parseAlt();
  const start = closure([H]);
  let set = start;
  for (let k = 0; k < text.length; k++) {
    const code = text.charCodeAt(k);
    const next = new Set();
    for (const s of set) {
      for (const label of Object.keys(states[s].out)) {
        if (matchesL(label, code)) for (const t of states[s].out[label]) next.add(t);
      }
    }
    set = closure(next);
    if (set.size === 0) return false;
  }
  return set.has(T);
}
export function t4Ref() {
  return T4_CASES.map((c) => ({ pattern: c.pattern, text: c.text, matched: t4RegexMatch(c.pattern, c.text) }));
}

// ═══════════════════════════ T5: 分层配置参考实现 ═══════════════════════════
export const T5_FIXTURE = {
  layers: [
    { name: 'base', config: { db: { host: 'h0', port: 5432, user: 'app' }, retries: 3, name: 'app', url: '', x: 7 } },
    { name: 'prod', config: { db: { host: 'prod-db', port: 5433 }, features: ['a', 'b'], x: null } },
    { name: 'override', config: { db: { user: 'svc' }, url: 'http://${db.host}:${db.port}/api', retries: 5 } },
  ],
};

export function t5Ref() {
  const deepMerge = (a, b) => {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return { ...b };
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
    return out;
  };
  let merged = null;
  for (const L of T5_FIXTURE.layers) {
    merged = merged === null ? JSON.parse(JSON.stringify(L.config)) : deepMerge(merged, L.config);
  }
  const resolve = (refPath) => {
    let o = merged;
    for (const part of refPath) {
      if (o === null || typeof o !== 'object' || !(part in o)) return undefined;
      o = o[part];
    }
    return o;
  };
  const walk = (v) => {
    if (typeof v === 'string') {
      return v.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (m, ref) => {
        const val = resolve(ref.split('.'));
        if (val === undefined || val === null || typeof val === 'object') throw new Error('T5 参考: 插值引用无效 ' + ref);
        return String(val);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  merged = walk(merged);
  return { merged };
}

// ═══════════════════════════ T6: 日志轮转与保留参考实现 ═══════════════════════════
export const T6_FIXTURE = {
  days: 5,
  policies: {
    'app.log': { maxMB: 10, keep: 2, maxAgeDays: 3 },
    'access.log': { maxMB: 5, keep: 3, maxAgeDays: 2 },
  },
  daily: [
    { day: 1, name: 'app.log', mb: 6 }, { day: 1, name: 'access.log', mb: 4 },
    { day: 2, name: 'app.log', mb: 6 }, { day: 2, name: 'access.log', mb: 5 },
    { day: 3, name: 'app.log', mb: 3 }, { day: 3, name: 'access.log', mb: 5 },
    { day: 4, name: 'app.log', mb: 1 }, { day: 4, name: 'access.log', mb: 0 },
    { day: 5, name: 'app.log', mb: 2 }, { day: 5, name: 'access.log', mb: 2 },
  ],
};

export function t6Ref() {
  const F = T6_FIXTURE;
  const state = {};
  for (const name of Object.keys(F.policies)) state[name] = { active: 0, files: [], dropped: 0 };
  const sizes = {};
  for (const e of F.daily) {
    (sizes[e.day] = sizes[e.day] || {})[e.name] = ((sizes[e.day] || {})[e.name] || 0) + e.mb;
  }
  for (let d = 1; d <= F.days; d++) {
    for (const name of Object.keys(F.policies)) {
      const p = F.policies[name];
      const s = state[name];
      s.active += (sizes[d] && sizes[d][name]) || 0;
      if (s.active > p.maxMB) {
        s.files.unshift({ mb: s.active, day: d });
        s.active = 0;
        while (s.files.length > p.keep) { s.files.pop(); s.dropped++; }
      }
      for (let i = s.files.length - 1; i >= 0; i--) {
        if (d - s.files[i].day >= p.maxAgeDays) { s.files.splice(i, 1); s.dropped++; }
      }
    }
  }
  const logs = {};
  let total = 0;
  for (const name of Object.keys(F.policies)) {
    const s = state[name];
    total += s.active;
    logs[name] = {
      activeMB: s.active,
      retained: s.files.map((f, idx) => ({ suffix: '.' + (idx + 1), mb: f.mb, day: f.day })),
      dropped: s.dropped,
    };
  }
  return { logs, totalActiveMB: total };
}

// ═══════════════════════════ T7: Gossip 反熵参考实现 ═══════════════════════════
export const T7_FIXTURE = {
  n: 4,
  seed: 42,
  rounds: 5,
  k: 2,
  initial: [
    { entries: { a: { v: 'v1', ver: 2 }, b: { v: 'x', ver: 1 } } },
    { entries: { a: { v: 'v0', ver: 1 }, c: { v: 'y', ver: 3 } } },
    { entries: {} },
    { entries: { b: { v: 'y', ver: 1 } } },
  ],
  quorum: { n: 4, w: 3, r: 2 },
};

export function t7Ref() {
  const F = T7_FIXTURE;
  let x = F.seed;
  const lcg = () => { x = (x * 1103515245 + 12345) % 2147483648; return x; };
  // state[i][key] = {v, ver}（克隆存储）
  const state = F.initial.map((n0) => Object.fromEntries(Object.entries(n0.entries).map(([k, e]) => [k, { v: e.v, ver: e.ver }])));
  const pairs = [];
  for (let i = 0; i < F.n; i++) for (let j = i + 1; j < F.n; j++) pairs.push([i, j]);
  const mergeInto = (dst, src) => {
    for (const [k, e] of Object.entries(state[src])) {
      const cur = state[dst][k];
      if (!cur || e.ver > cur.ver || (e.ver === cur.ver && src > dst)) state[dst][k] = { v: e.v, ver: e.ver };
    }
  };
  for (let r = 0; r < F.rounds; r++) {
    const arr = pairs.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = lcg() % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    for (const [a, b] of arr.slice(0, F.k)) {
      mergeInto(a, b);
      mergeInto(b, a);
    }
  }
  const finalState = state.map((s) => Object.fromEntries(Object.entries(s).map(([k, e]) => [k, e.v])));
  const canon0 = JSON.stringify(canon(finalState[0]));
  const converged = finalState.every((s) => JSON.stringify(canon(s)) === canon0);
  const q = F.quorum;
  return {
    converged,
    state: finalState,
    quorum: { n: q.n, w: q.w, r: q.r, guaranteed: q.w + q.r > q.n },
  };
}

// ═══════════════════════════ T8: Count-min 参考实现 ═══════════════════════════
export const T8_FIXTURE = {
  width: 5,
  depth: 3,
  k: 3,
  stream: ['cat', 'dog', 'cat', 'bird', 'cat', 'fish', 'dog', 'bird', 'ant', 'ant', 'ant', 'ant', 'ant', 'ant', 'ant'],
};

// 注意：h≈2^31 时 h*16777619≈3.6e16 > 2^53，JS 浮点乘法会舍入丢精度（产生 3538609408，
// 而非真 FNV-1a 的 3146166556）。须用有符号 32 位乘法：
// Math.imul(h, 16777619) 精确完成模 2^32，再 >>>0 取无符号 32 位结果。
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
export const t8Fnv = fnv1a;
export function t8Ref() {
  const F = T8_FIXTURE;
  const rows = Array.from({ length: F.depth }, () => new Array(F.width).fill(0));
  for (const key of F.stream) {
    for (let r = 0; r < F.depth; r++) rows[r][fnv1a(key + '|' + r) % F.width] += 1;
  }
  const est = (key) => {
    let m = Infinity;
    for (let r = 0; r < F.depth; r++) m = Math.min(m, rows[r][fnv1a(key + '|' + r) % F.width]);
    return m;
  };
  const seen = [...new Set(F.stream)];
  const ranked = seen.map((key) => ({ key, est: est(key) })).sort((a, b) => (b.est - a.est) || (a.key < b.key ? -1 : 1));
  return {
    top: ranked.slice(0, F.k).map(({ key, est: e }) => ({ key, est: e })),
    distinct: seen.length,
  };
}

// ═══════════════════════════ T9: EDF 调度参考实现 ═══════════════════════════
export const T9_FIXTURE = {
  horizon: 10,
  jobs: [
    { id: 'A', release: 0, period: 0, deadline: 4, exec: 3 },
    { id: 'B', release: 1, period: 0, deadline: 5, exec: 2 },
    { id: 'C', release: 0, period: 4, deadline: 3, exec: 2 },
  ],
};

export function t9Ref() {
  const F = T9_FIXTURE;
  const inst = [];
  for (const j of F.jobs) {
    if (j.period > 0) {
      for (let k = 0; ; k++) {
        const r = j.release + k * j.period;
        if (r > F.horizon) break;
        inst.push({ id: j.id + '#' + k, release: r, deadline: j.deadline + k * j.period, left: j.exec, done: false });
      }
    } else {
      inst.push({ id: j.id + '#0', release: j.release, deadline: j.deadline, left: j.exec, done: false });
    }
  }
  const order = [], finish = {}, missed = [];
  for (let c = 0; c <= F.horizon; c++) {
    const ready = inst.filter((i) => !i.done && i.release <= c).sort((a, b) => (a.deadline - b.deadline) || (a.id < b.id ? -1 : 1));
    if (!ready.length) { order.push(null); continue; } // 空转步记 null（与任务书一致）
    const j = ready[0];
    j.left--;
    order.push(j.id);
    if (j.left === 0) {
      j.done = true;
      finish[j.id] = c + 1;
      if (c + 1 > j.deadline) missed.push(j.id);
    }
  }
  return { order, finish, missed };
}

// ═══════════════════════════ T10: 图形原语参考实现 ═══════════════════════════
export const T10_FIXTURE = {
  w: 12,
  h: 8,
  ops: [
    { op: 'line', x0: 0, y0: 0, x1: 11, y1: 7 },
    { op: 'rect', x: 2, y: 2, w: 4, h: 3 },
    { op: 'fill', x: 3, y: 3 },
    { op: 'line', x0: 11, y0: 0, x1: 0, y1: 7 },
    { op: 'fill', x: 6, y: 0 },
    { op: 'fill', x: 0, y: 0 },
  ],
};

export function t10Ref() {
  const F = T10_FIXTURE;
  const W = F.w, H = F.h;
  const px = Array.from({ length: H }, () => new Array(W).fill(0));
  const stats = [];
  F.ops.forEach((op, idx) => {
    let n = 0;
    const set = (x, y) => { if (x >= 0 && x < W && y >= 0 && y < H && px[y][x] !== 255) n++; if (x >= 0 && x < W && y >= 0 && y < H) px[y][x] = 255; };
    if (op.op === 'line') {
      let x = op.x0, y = op.y0;
      const x1 = op.x1, y1 = op.y1;
      const dx = Math.abs(x1 - x), sx = x < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y), sy = y < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        set(x, y);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
      }
    } else if (op.op === 'rect') {
      for (let x = op.x; x < op.x + op.w; x++) { set(x, op.y); set(x, op.y + op.h - 1); }
      for (let y = op.y + 1; y < op.y + op.h - 1; y++) { set(op.x, y); set(op.x + op.w - 1, y); }
    } else if (op.op === 'fill') {
      if (op.x >= 0 && op.x < W && op.y >= 0 && op.y < H && px[op.y][op.x] === 0) {
        const q = [[op.x, op.y]];
        while (q.length) {
          const [cx, cy] = q.shift();
          if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
          if (px[cy][cx] !== 0) continue;
          n++;
          px[cy][cx] = 255;
          q.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
      }
    }
    stats.push({ i: idx, op: op.op, pixels: n });
  });
  const buf = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = px[y][x];
  return { rowsB64: buf.toString('base64'), stats };
}

// ═══════════════════════════ 夹具写入 / 自校准 ═══════════════════════════
export function seed() {
  writeFixture(D(1), 'cases.json', JSON.stringify(T1_CASES, null, 2));
  writeFixture(D(2), 'books.json', JSON.stringify(T2_FIXTURE, null, 2));
  writeFixture(D(3), 'jobs.json', JSON.stringify(T3_FIXTURE, null, 2));
  writeFixture(D(4), 'cases.json', JSON.stringify({ cases: T4_CASES }, null, 2));
  writeFixture(D(5), 'layers.json', JSON.stringify(T5_FIXTURE, null, 2));
  writeFixture(D(6), 'rotation.json', JSON.stringify(T6_FIXTURE, null, 2));
  writeFixture(D(7), 'gossip.json', JSON.stringify(T7_FIXTURE, null, 2));
  writeFixture(D(8), 'counts.json', JSON.stringify(T8_FIXTURE, null, 2));
  writeFixture(D(9), 'edf.json', JSON.stringify(T9_FIXTURE, null, 2));
  writeFixture(D(10), 'ops.json', JSON.stringify(T10_FIXTURE, null, 2));
}
export function saveFixtureHashes(file = `${WS}/v31-fixture-hashes.json`) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURE_HASHES), null, 2));
}
export function loadFixtureHashes(file = `${WS}/v31-fixture-hashes.json`) {
  try {
    for (const [p, h] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) FIXTURE_HASHES.set(p, h);
  } catch { /* 首次 */ }
}

/** harness 自校准：参考实现一致性 + 期望值固化核对 */
export function selfCheck() {
  const bad = [];
  // T1
  const r1 = t1Ref();
  if (!sameJson(r1.y1, { name: 'acme', replicas: 3, labels: { app: 'web', tier: 1 }, empty: null })) bad.push('T1 y1 漂移: ' + JSON.stringify(r1.y1));
  if (!sameJson(r1.y2, { list: [1, -2, 3.5], flags: [true, false, null] })) bad.push('T1 y2 漂移: ' + JSON.stringify(r1.y2));
  if (!sameJson(r1.y3, { a: { b: { c: ['x', 'y z'] } } })) bad.push('T1 y3 漂移: ' + JSON.stringify(r1.y3));
  if (!sameJson(r1.y4, { i: 42, f: -3.25, s1: 'a#b', s2: 'done', b1: true, n1: null })) bad.push('T1 y4 漂移: ' + JSON.stringify(r1.y4));
  if (r1.y5 !== null) bad.push('T1 y5 漂移: ' + JSON.stringify(r1.y5));
  if (!sameJson(r1.y6, { x: -1, y: 0, z: 'FALSE' })) bad.push('T1 y6 漂移: ' + JSON.stringify(r1.y6));
  // T2
  const r2 = t2Ref();
  if (!sameJson(r2.journals, { j_open: 'OK', j_sale: 'OK', j_bad: 'UNBALANCED', j_zero: 'OK' })) bad.push('T2 journals 漂移: ' + JSON.stringify(r2.journals));
  if (!sameJson(r2.balances, { CA: 108000, INV: -60000, AP: -40000, REV: -8000 })) bad.push('T2 balances 漂移: ' + JSON.stringify(r2.balances));
  if (r2.totalDebit !== 108000) bad.push('T2 totalDebit 漂移 ' + r2.totalDebit);
  // T3
  const r3 = t3Ref();
  if (JSON.stringify(r3.order) !== JSON.stringify(['B', 'C', 'A', 'D', 'E'])) bad.push('T3 order 漂移: ' + JSON.stringify(r3.order));
  if (!sameJson(r3.wait, { B: 0, C: 0, A: 2, D: 1, E: 4 })) bad.push('T3 wait 漂移: ' + JSON.stringify(r3.wait));
  if (!sameJson(r3.finish, { B: 1, C: 2, A: 3, D: 4, E: 5 })) bad.push('T3 finish 漂移: ' + JSON.stringify(r3.finish));
  // T4 已知向量钉死
  if (!t4RegexMatch('a*b', 'aaab') || t4RegexMatch('a*b', 'xxb') || t4RegexMatch('[0-9]+', '12a') ||
      !t4RegexMatch('colou?r', 'color') || !t4RegexMatch('(ab)+', 'ababab') || t4RegexMatch('(ab)+', 'aba') ||
      !t4RegexMatch('a\\.b', 'a.b') || t4RegexMatch('a\\.b', 'acb') || !t4RegexMatch('', '')) bad.push('T4 已知向量漂移');
  const r4 = t4Ref();
  if (r4.length !== T4_CASES.length) bad.push('T4 结果数漂移 ' + r4.length);
  // T5
  const r5 = t5Ref();
  if (r5.merged.url !== 'http://prod-db:5433/api') bad.push('T5 url 漂移: ' + r5.merged.url);
  if (!sameJson(r5.merged.db, { host: 'prod-db', port: 5433, user: 'svc' })) bad.push('T5 db 漂移: ' + JSON.stringify(r5.merged.db));
  if (r5.merged.x !== null || r5.merged.retries !== 5 || !sameJson(r5.merged.features, ['a', 'b'])) bad.push('T5 标量漂移: ' + JSON.stringify(r5.merged));
  // T6
  const r6 = t6Ref();
  if (!sameJson(r6.logs['app.log'], { activeMB: 6, retained: [], dropped: 1 })) bad.push('T6 app.log 漂移: ' + JSON.stringify(r6.logs['app.log']));
  if (!sameJson(r6.logs['access.log'], { activeMB: 0, retained: [{ suffix: '.1', mb: 7, day: 5 }], dropped: 1 })) bad.push('T6 access.log 漂移: ' + JSON.stringify(r6.logs['access.log']));
  if (r6.totalActiveMB !== 6) bad.push('T6 totalActiveMB 漂移 ' + r6.totalActiveMB);
  // T7
  const r7 = t7Ref();
  if (!r7.quorum.guaranteed || r7.quorum.n !== 4) bad.push('T7 quorum 漂移: ' + JSON.stringify(r7.quorum));
  // 收敛后每节点 c 键必为 v:y（ver 3 最高）
  if (r7.state.some((s) => s.c !== 'y')) bad.push('T7 state c 漂移: ' + JSON.stringify(r7.state));
  // T8（Count-min 有冲突上偏：ant est=7 > 实际 6 是正常碰撞上偏，不判死）
  const r8 = t8Ref();
  if (r8.distinct !== 5) bad.push('T8 distinct 漂移 ' + r8.distinct);
  // Count-min 有冲突上偏：ant est=9 > 实际 6、bird est=9 > 实际 2 是正常碰撞上偏，不判死
  // （top 排序 est 相同时按 key 字母序：ant < bird < cat）
  if (JSON.stringify(r8.top) !== JSON.stringify([
    { key: 'ant', est: 9 }, { key: 'bird', est: 9 }, { key: 'cat', est: 3 },
  ])) bad.push('T8 top 漂移: ' + JSON.stringify(r8.top));
  // T9
  const r9 = t9Ref();
  if (JSON.stringify(r9.missed) !== JSON.stringify(['A#0', 'B#0', 'C#1'])) bad.push('T9 missed 漂移: ' + JSON.stringify(r9.missed));
  if (!r9.order.every((id) => /#/.test(id))) bad.push('T9 实例 id 漂移: ' + JSON.stringify(r9.order.slice(0, 4)));
  // T10
  const r10 = t10Ref();
  if (r10.stats.length !== T10_FIXTURE.ops.length) bad.push('T10 stats 数漂移 ' + r10.stats.length);
  if (r10.stats[0].pixels !== 12) bad.push('T10 首条线像素漂移 ' + r10.stats[0].pixels);
  if (Buffer.from(r10.rowsB64, 'base64').length !== T10_FIXTURE.w * T10_FIXTURE.h) bad.push('T10 画布尺寸漂移');
  return bad;
}
