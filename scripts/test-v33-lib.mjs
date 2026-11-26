/**
 * EvoClaw v33 压测共享库 —— 10 项「实用性更强」的复杂多步工作任务，领域与 v12–v32 零重叠：
 *   T1  功能开关求值引擎（Python，规则优先级 + fnv1a32 灰度分桶）
 *   T2  Webhook 投递引擎（Node，HMAC 签名 + 重试时间线 + 幂等去重 + 死信）
 *   T3  时序指标下采样 + 分层 rollup（Python，乱序/迟到/空窗补零/nearest-rank p95）
 *   T4  不透明游标分页（Node，base64url + HMAC 防篡改 + 排序签名）
 *   T5  数据库迁移编排器（Python，拓扑 + 校验和幂等 + 失败逆序回滚）
 *   T6  一致性哈希环 + 再平衡（Node，虚拟节点 + crc32 钉死 + 最小迁移）
 *   T7  日志异常检测 EWMA + 3σ（Python，冷启动 + 连续去抖）
 *   T8  审计日志哈希链（Node，规范 JSON + SHA-256 链 + 断链定位）
 *   T9  i18n 消息格式化（Python，CLDR 复数类别 + ICU-lite 模板 + 回退链）
 *   T10 Snowflake ID 生成器（Node，位布局 + 序列溢出 + 时钟回拨策略）
 *
 * 参考实现用于 harness 自校准与对模型交付物的独立复算（不依赖被测产物）。
 * 夹具由 seed() 写入各任务目录，写入时记录哈希（frozen 校验）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { writeFixture, FIXTURE_HASHES, canon as canonShared, pyReadTextLiteral } from './v14/lib.mjs';
export { pyReadTextLiteral };

export const WS = '/home/chy/EvoClaw/data/workspace';
export const D = (n) => `${WS}/v33-t${n}`;
export const canon = canonShared;
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * 路径级 JSON 差异（诊断用）：返回最多 max 条 `$.path: 期望→实际`。
 * 比对口径与 sameJson 一致（对象键序无关、数组按下标逐项），但只报差异点，
 * 便于一眼看出「差在哪一个字段」，而不是从整段 JSON 里人肉找。
 */
export function jsonDiff(expected, actual, max = 5) {
  const out = [];
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? 'undefined' : s.length > 72 ? s.slice(0, 72) + '…' : s;
  };
  const walk = (e, a, p) => {
    if (out.length >= max) return;
    const arrE = Array.isArray(e), arrA = Array.isArray(a);
    if (arrE || arrA) {
      if (!arrE || !arrA) { out.push(`${p}: 类型不符 ${brief(e)}→${brief(a)}`); return; }
      if (e.length !== a.length) out.push(`${p}.length: ${e.length}→${a.length}`);
      for (let i = 0; i < Math.max(e.length, a.length) && out.length < max; i++) walk(e[i], a[i], `${p}[${i}]`);
      return;
    }
    const objE = e && typeof e === 'object', objA = a && typeof a === 'object';
    if (objE || objA) {
      if (!objE || !objA) { out.push(`${p}: 类型不符 ${brief(e)}→${brief(a)}`); return; }
      for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
        if (out.length >= max) return;
        if (!(k in e)) out.push(`${p}.${k}: 多余字段 = ${brief(a[k])}`);
        else if (!(k in a)) out.push(`${p}.${k}: 缺失字段（期望 ${brief(e[k])}）`);
        else walk(e[k], a[k], `${p}.${k}`);
      }
      return;
    }
    if (e !== a) out.push(`${p}: ${brief(e)}→${brief(a)}`);
  };
  walk(expected, actual, '$');
  return out;
}
/** 差异摘要（失败文案用）：无差异返回空串。 */
export const diffNote = (actual, expected, max = 5) => jsonDiff(expected, actual, max).join(' | ');

/**
 * Python 模块装载片段（v32 T9 教训）：`sys.path.insert + import x` 遇到内置/frozen
 * 模块（如 select）会被无条件遮蔽。所有 Python 探针统一用 importlib 按**文件路径**装载。
 */
export function pyLoadModule(alias, file) {
  return `import importlib.util as _ilu\n` +
    `_spec = _ilu.spec_from_file_location(${JSON.stringify(alias)}, ${JSON.stringify(file)})\n` +
    `m = _ilu.module_from_spec(_spec)\n` +
    `_spec.loader.exec_module(m)`;
}

// ═════════════════════ 通用：规范 JSON / 哈希 ═════════════════════
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}
/** 规范 JSON：对象键递归字典序、无空白（Python 侧须 json.dumps(sort_keys=True, separators=(',',':'))）。 */
export const canonicalJson = (v) => JSON.stringify(canonicalize(v));
export const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hmac256hex = (secret, s) => createHmac('sha256', secret).update(s, 'utf8').digest('hex');

/** 32 位 FNV-1a（UTF-8 字节）。JS 必须 Math.imul，Python 用 & 0xffffffff。 */
export function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// ═══════════════════════════ T1: 功能开关求值 ═══════════════════════════
// 口径：kill switch → 规则（首个命中，条件全 AND，缺属性=不匹配）→ 灰度分桶 → default。
// 分桶 = fnv1a32(`${salt}:${userId}`) % 100 < percentage。

export const T1_FIXTURE = {
  flags: [
    {
      key: 'checkout-v2', enabled: true, default: false,
      rules: [
        { conditions: [{ attr: 'plan', op: 'eq', value: 'enterprise' }], value: true },
        { conditions: [{ attr: 'country', op: 'in', value: ['CN', 'JP'] }, { attr: 'age', op: 'gt', value: 18 }], value: true },
      ],
      rollout: { percentage: 50, salt: 'co-v2' },
    },
    {
      key: 'beta-ui', enabled: false, default: true,
      rules: [{ conditions: [{ attr: 'plan', op: 'eq', value: 'pro' }], value: true }],
      rollout: null,
    },
    {
      key: 'search-rank', enabled: true, default: true, rules: [],
      rollout: { percentage: 10, salt: 'sr' },
    },
  ],
  contexts: [
    { userId: 'u-1001', plan: 'enterprise', country: 'CN', age: 30 },
    { userId: 'u-1002', plan: 'free', country: 'JP', age: 17 },
    { userId: 'u-1003', plan: 'free', country: 'JP', age: 22 },
    { userId: 'u-1004', plan: 'pro', country: 'US', age: 40 },
    { userId: 'u-1005', plan: 'free', country: 'US' },
  ],
};

function t1CondOk(ctx, c) {
  const v = ctx[c.attr];
  if (v === undefined) return false;
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
    case 'gt': return typeof v === 'number' && typeof c.value === 'number' && v > c.value;
    case 'lt': return typeof v === 'number' && typeof c.value === 'number' && v < c.value;
    default: throw new Error('bad op ' + c.op);
  }
}

function t1EvalFlag(flag, ctx) {
  if (!flag.enabled) return { value: false, reason: 'disabled' };
  for (let i = 0; i < flag.rules.length; i++) {
    const r = flag.rules[i];
    if (r.conditions.every((c) => t1CondOk(ctx, c))) return { value: r.value, reason: 'rule:' + i };
  }
  if (flag.rollout) {
    const bucket = fnv1a32(`${flag.rollout.salt}:${ctx.userId}`) % 100;
    return { value: bucket < flag.rollout.percentage, reason: 'rollout' };
  }
  return { value: flag.default, reason: 'default' };
}

export function t1Run(spec) {
  const results = spec.contexts.map((ctx) => {
    const flags = {};
    for (const f of spec.flags) flags[f.key] = t1EvalFlag(f, ctx);
    return { userId: ctx.userId, flags };
  });
  const counts = {};
  for (const f of spec.flags) counts[f.key] = results.filter((r) => r.flags[f.key].value).length;
  return { results, counts };
}
export const t1Ref = () => t1Run(T1_FIXTURE);

// ═══════════════════════════ T2: Webhook 投递 ═══════════════════════════
// 口径：事件 id 幂等去重（首次投递，后续 duplicate）→ 逐次尝试（2xx 成功）；
// 失败后等待 retryDelaysMs[k]（不足则 capMs）；尝试数达 maxAttempts 进死信。
// 每次尝试签名 = HMAC-SHA256(secret, `${ts}.${canonicalJson(event)}`)，ts = baseTs + 时间线偏移。

export const T2_FIXTURE = {
  secret: 'whsec_v33',
  baseTs: 1700000000000,
  maxAttempts: 4,
  retryDelaysMs: [100, 300, 900],
  capMs: 5000,
  deliveries: [
    { id: 'd1', event: { id: 'evt_1', type: 'order.created', data: { amount: 1200 } }, outcomes: [500, 200] },
    { id: 'd2', event: { id: 'evt_2', type: 'order.created', data: { amount: 800 } }, outcomes: [503, 503, 503, 503] },
    { id: 'd3', event: { id: 'evt_1', type: 'order.created', data: { amount: 1200 } }, outcomes: [200] },
    { id: 'd4', event: { id: 'evt_3', type: 'user.updated', data: { name: 'Ada' } }, outcomes: [429, 200] },
  ],
};

export function t2Run(spec) {
  const seen = new Set();
  const deliveries = [];
  const dlq = [];
  let delivered = 0, dead = 0, duplicates = 0;
  for (const d of spec.deliveries) {
    const body = canonicalJson(d.event);
    if (seen.has(d.event.id)) {
      duplicates++;
      deliveries.push({ id: d.id, status: 'duplicate', attempts: 0, deadLettered: false, signatures: [], timeline: [] });
      continue;
    }
    seen.add(d.event.id);
    const signatures = [];
    const timeline = [];
    let t = 0;
    let status = 'dead';
    let attempts = 0;
    for (let k = 0; k < spec.maxAttempts; k++) {
      const ts = spec.baseTs + t;
      signatures.push(hmac256hex(spec.secret, `${ts}.${body}`));
      timeline.push(t);
      attempts = k + 1;
      const outcome = k < d.outcomes.length ? d.outcomes[k] : 599;
      if (outcome >= 200 && outcome < 300) { status = 'delivered'; break; }
      if (attempts >= spec.maxAttempts) break;
      t += k < spec.retryDelaysMs.length ? spec.retryDelaysMs[k] : spec.capMs;
    }
    if (status === 'delivered') delivered++;
    else { dead++; dlq.push(d.id); }
    deliveries.push({ id: d.id, status, attempts, deadLettered: status === 'dead', signatures, timeline });
  }
  return { deliveries, dlq, summary: { delivered, dead, duplicates } };
}
export const t2Ref = () => t2Run(T2_FIXTURE);

// ═══════════════════════ T3: 时序下采样 + rollup ═══════════════════════
// 口径：范围外点丢弃；按 ts 稳定排序；窗口内 count/avg(round6)/max/p95(nearest-rank
// ceil(0.95n)-1)；空窗三项 null；rollup 每 4 个窗口：count=sum，avg=按 count 加权，
// max=max(非空)，p95=max(非空 p95)。

export const T3_FIXTURE = {
  startMs: 1700000000000,
  widthMs: 60000,
  count: 8,
  points: [
    { ts: 1700000000000, v: 10 },
    { ts: 1700000001000, v: 20 },
    { ts: 1700000002000, v: 30 },
    { ts: 1700000125000, v: 5 },
    { ts: 1700000126000, v: 15 },
    { ts: 1700000181000, v: 7 },
    { ts: 1700000240000, v: 100 },
    { ts: 1700000365000, v: 42 },
    { ts: 1700000366000, v: 58 },
    { ts: 1700000421000, v: 1 },
    { ts: 1700000422000, v: 2 },
    { ts: 1700000423000, v: 3 },
    { ts: 1700000424000, v: 4 },
    // 范围外：早于 start / 超出 count*width
    { ts: 1699999999000, v: 999 },
    { ts: 1700000480500, v: 888 },
  ],
};

function t3Stats(values) {
  if (!values.length) return { count: 0, avg: null, max: null, p95: null };
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const k = Math.ceil(0.95 * values.length);
  return { count: values.length, avg: round6(sum / values.length), max: sorted[sorted.length - 1], p95: sorted[k - 1] };
}

export function t3Run(spec) {
  const endMs = spec.startMs + spec.count * spec.widthMs;
  const inRange = [];
  let dropped = 0;
  spec.points.forEach((p, idx) => {
    if (p.ts < spec.startMs || p.ts >= endMs) { dropped++; return; }
    inRange.push({ ...p, idx });
  });
  inRange.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));
  const buckets = Array.from({ length: spec.count }, () => []);
  for (const p of inRange) buckets[Math.floor((p.ts - spec.startMs) / spec.widthMs)].push(p.v);
  const windows = buckets.map(t3Stats);
  const rollups = [];
  for (let g = 0; g + 4 <= spec.count; g += 4) {
    const group = windows.slice(g, g + 4).filter((w) => w.count > 0);
    const cnt = group.reduce((a, w) => a + w.count, 0);
    if (!cnt) { rollups.push({ count: 0, avg: null, max: null, p95: null }); continue; }
    const weighted = group.reduce((a, w) => a + w.avg * w.count, 0);
    rollups.push({
      count: cnt,
      avg: round6(weighted / cnt),
      max: Math.max(...group.map((w) => w.max)),
      p95: Math.max(...group.map((w) => w.p95)),
    });
  }
  return { windows, rollups, dropped };
}
export const t3Ref = () => t3Run(T3_FIXTURE);

// ═══════════════════════════ T4: 游标分页 ═══════════════════════════
// 口径：多键排序（dir=asc|desc，全等时 id 升序）；游标 payload =
// {"o":<offset>,"s":<sortHash>,"v":1} 的规范 JSON，base64url 编码；游标 =
// `<b64>.<HMAC-SHA256(secret,b64) 前 16 位 hex>`。sortHash = sha256(规范 JSON(sort)) 前 8 hex。
// decode 校验格式/HMAC/排序签名，任一不符抛错。

export const T4_FIXTURE = {
  secret: 'cursor-secret-v33',
  pageSize: 3,
  sort: [{ field: 'score', dir: 'desc' }, { field: 'id', dir: 'asc' }],
  items: [
    { id: 'a1', score: 10 }, { id: 'a2', score: 30 }, { id: 'a3', score: 20 },
    { id: 'a4', score: 30 }, { id: 'a5', score: 5 }, { id: 'a6', score: 20 },
    { id: 'a7', score: 15 }, { id: 'a8', score: 15 }, { id: 'a9', score: 25 },
  ],
};

export const t4SortHash = (sort) => sha256hex(canonicalJson(sort)).slice(0, 8);

export function t4SortItems(items, sort) {
  return items.slice().sort((a, b) => {
    for (const s of sort) {
      const va = a[s.field], vb = b[s.field];
      if (va === vb) continue;
      const cmp = va < vb ? -1 : 1;
      return s.dir === 'desc' ? -cmp : cmp;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function t4EncodeCursor(offset, sort, secret) {
  const payload = JSON.stringify({ o: offset, s: t4SortHash(sort), v: 1 });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  const mac = hmac256hex(secret, b64).slice(0, 16);
  return `${b64}.${mac}`;
}

export function t4DecodeCursor(cursor, sort, secret) {
  const parts = String(cursor).split('.');
  if (parts.length !== 2) throw new Error('bad_cursor_format');
  const [b64, mac] = parts;
  if (hmac256hex(secret, b64).slice(0, 16) !== mac) throw new Error('bad_cursor_mac');
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  if (payload.v !== 1) throw new Error('bad_cursor_version');
  if (payload.s !== t4SortHash(sort)) throw new Error('sort_mismatch');
  return { offset: payload.o };
}

export function t4Run(spec) {
  const sorted = t4SortItems(spec.items, spec.sort);
  const pages = [];
  for (let o = 0; o < sorted.length; o += spec.pageSize) {
    const slice = sorted.slice(o, o + spec.pageSize).map((x) => x.id);
    const next = o + spec.pageSize < sorted.length ? t4EncodeCursor(o + spec.pageSize, spec.sort, spec.secret) : null;
    pages.push({ items: slice, cursor: next });
  }
  const firstCursor = pages[0].cursor;
  const resumed = t4DecodeCursor(firstCursor, spec.sort, spec.secret);
  const resumedIds = sorted.slice(resumed.offset, resumed.offset + spec.pageSize).map((x) => x.id);
  let tamperRejected = false;
  try {
    const bad = (firstCursor[0] === 'A' ? 'B' : 'A') + firstCursor.slice(1);
    t4DecodeCursor(bad, spec.sort, spec.secret);
  } catch { tamperRejected = true; }
  let sortMismatchRejected = false;
  try {
    t4DecodeCursor(firstCursor, [{ field: 'id', dir: 'asc' }], spec.secret);
  } catch { sortMismatchRejected = true; }
  return { pages, resumed: resumedIds, tamperRejected, sortMismatchRejected };
}
export const t4Ref = () => t4Run(T4_FIXTURE);

// ═══════════════════════ T5: 迁移编排 ═══════════════════════
// 口径：checksum = sha256(sql) 全 hex；已应用且校验和不符 → invalid/checksum_mismatch；
// 拓扑序 = Kahn + 字典序最小堆；已应用且校验和一致 → skip；执行到 failAt 报错后，
// 逆序回滚本次已应用的迁移。

const T5_SQL = {
  '001_init': 'CREATE TABLE users(id INTEGER PRIMARY KEY);',
  '002_add_email': 'ALTER TABLE users ADD COLUMN email TEXT;',
  '003_orders': 'CREATE TABLE orders(id INTEGER PRIMARY KEY);',
  '004_orders_fk': 'ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id);',
  '005_idx': 'CREATE INDEX idx_orders_user ON orders(user_id);',
};

export const T5_FIXTURE = {
  applied: [{ id: '001_init', checksum: sha256hex(T5_SQL['001_init']) }],
  migrations: [
    { id: '001_init', deps: [], sql: T5_SQL['001_init'] },
    { id: '002_add_email', deps: ['001_init'], sql: T5_SQL['002_add_email'] },
    { id: '003_orders', deps: ['001_init'], sql: T5_SQL['003_orders'] },
    { id: '004_orders_fk', deps: ['002_add_email', '003_orders'], sql: T5_SQL['004_orders_fk'] },
    { id: '005_idx', deps: ['004_orders_fk'], sql: T5_SQL['005_idx'] },
  ],
  failAt: '004_orders_fk',
};

export function t5Run(spec) {
  const errors = [];
  const byId = new Map(spec.migrations.map((m) => [m.id, m]));
  const applied = new Map(spec.applied.map((a) => [a.id, a.checksum]));
  for (const [id, sum] of applied) {
    const m = byId.get(id);
    if (m && sha256hex(m.sql) !== sum) {
      return { order: [], plan: [], executed: [], rolledBack: [], status: 'invalid', errors: ['checksum_mismatch:' + id] };
    }
  }
  // 依赖完整性
  for (const m of spec.migrations) {
    for (const d of m.deps) if (!byId.has(d)) errors.push('missing_dep:' + m.id + '->' + d);
  }
  if (errors.length) return { order: [], plan: [], executed: [], rolledBack: [], status: 'invalid', errors };
  // Kahn + 字典序
  const indeg = new Map(spec.migrations.map((m) => [m.id, m.deps.length]));
  const children = new Map(spec.migrations.map((m) => [m.id, []]));
  for (const m of spec.migrations) for (const d of m.deps) children.get(d).push(m.id);
  const ready = spec.migrations.filter((m) => indeg.get(m.id) === 0).map((m) => m.id).sort();
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const c of children.get(id).slice().sort()) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) { ready.push(c); ready.sort(); }
    }
  }
  if (order.length !== spec.migrations.length) {
    return { order: [], plan: [], executed: [], rolledBack: [], status: 'invalid', errors: ['cycle'] };
  }
  const plan = order.map((id) => ({ id, action: applied.has(id) ? 'skip' : 'apply' }));
  const executed = [];
  const rolledBack = [];
  let status = 'ok';
  for (const p of plan) {
    if (p.action !== 'apply') continue;
    if (p.id === spec.failAt) {
      status = 'aborted';
      errors.push('failed:' + p.id);
      for (const id of executed.slice().reverse()) rolledBack.push(id);
      break;
    }
    executed.push(p.id);
  }
  return { order, plan, executed, rolledBack, status, errors };
}
export const t5Ref = () => t5Run(T5_FIXTURE);

// ═══════════════════════ T6: 一致性哈希环 ═══════════════════════
// 口径：环点 = crc32(`${node}#${i}`)，i∈[0,vnodes)；按 (point, node, i) 升序；
// 键归属 = 首个 point ≥ crc32(key)，否则回绕到 0 号点。再平衡：add 后 / remove 前
// 各自独立建环，键归属变化者按 key 升序列出。

export const T6_FIXTURE = {
  vnodes: 16,
  nodes: ['node-a', 'node-b', 'node-c'],
  keys: Array.from({ length: 40 }, (_, i) => `user:${i + 1}`),
  add: 'node-d',
  remove: 'node-c',
};

function t6Ring(nodes, vnodes) {
  const pts = [];
  for (const node of nodes) {
    for (let i = 0; i < vnodes; i++) pts.push({ point: crc32(Buffer.from(`${node}#${i}`, 'utf8')), node, i });
  }
  pts.sort((a, b) => (a.point - b.point) || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0) || (a.i - b.i));
  return pts;
}
function t6Owner(pts, key) {
  const h = crc32(Buffer.from(key, 'utf8'));
  for (const p of pts) if (p.point >= h) return p.node;
  return pts[0].node;
}
function t6Map(nodes, spec) {
  const pts = t6Ring(nodes, spec.vnodes);
  const owners = {};
  for (const k of spec.keys) owners[k] = t6Owner(pts, k);
  return owners;
}
function t6Moved(base, next, keys) {
  const moved = [];
  for (const k of keys.slice().sort()) if (base[k] !== next[k]) moved.push({ key: k, from: base[k], to: next[k] });
  return { moved, count: moved.length };
}

export function t6Run(spec) {
  const base = t6Map(spec.nodes, spec);
  const added = t6Map([...spec.nodes, spec.add], spec);
  const removed = t6Map(spec.nodes.filter((n) => n !== spec.remove), spec);
  const distribution = {};
  for (const n of spec.nodes) distribution[n] = 0;
  for (const k of spec.keys) distribution[base[k]]++;
  return {
    owners: base,
    rebalanceAdd: t6Moved(base, added, spec.keys),
    rebalanceRemove: t6Moved(base, removed, spec.keys),
    distribution,
  };
}
export const t6Ref = () => t6Run(T6_FIXTURE);

// ═══════════════════════ T7: EWMA + 3σ 异常检测 ═══════════════════════
// 口径：mean0=x[0]、var0=0；i≥1 时先算 z_i=(x_i−mean_{i−1})/sqrt(var_{i−1})（var=0→0），
// 再更新 mean_i=αx_i+(1−α)mean_{i−1}、var_i=α(x_i−mean_{i−1})²+(1−α)var_{i−1}；
// 仅在 i≥warmup 评估；|z|>threshold 为异常；连续异常数达到 minStreak 时在该下标告警一次。

export const T7_FIXTURE = {
  alpha: 0.05,
  warmup: 5,
  threshold: 3.0,
  minStreak: 2,
  // 手算锚点（α=0.05）：单点尖峰 160@7 只产生 1 次异常（不告警）；
  // 连续 160@13 → z≈4.858、165@14 → z≈3.451 均为异常，第 2 次触发唯一告警。
  series: [100, 100, 100, 100, 100, 100, 100, 160, 100, 100, 100, 100, 100, 160, 165, 100, 100, 100, 100],
};

export function t7Run(spec) {
  const xs = spec.series;
  let mean = xs[0], variance = 0;
  const alerts = [];
  let anomalies = 0, streak = 0;
  for (let i = 1; i < xs.length; i++) {
    const prevMean = mean;
    const z = variance > 0 ? (xs[i] - prevMean) / Math.sqrt(variance) : 0;
    mean = spec.alpha * xs[i] + (1 - spec.alpha) * prevMean;
    variance = spec.alpha * (xs[i] - prevMean) ** 2 + (1 - spec.alpha) * variance;
    if (i < spec.warmup) continue;
    const isAnom = Math.abs(z) > spec.threshold;
    if (isAnom) {
      anomalies++;
      streak++;
      if (streak === spec.minStreak) {
        alerts.push({ index: i, value: xs[i], direction: z > 0 ? 'up' : 'down' });
      }
    } else {
      streak = 0;
    }
  }
  return { alerts, anomalies, evaluated: Math.max(0, xs.length - spec.warmup) };
}
export const t7Ref = () => t7Run(T7_FIXTURE);

// ═══════════════════════ T8: 审计哈希链 ═══════════════════════
// 口径：hash_i = sha256hex(prev + "\n" + 规范 JSON(event_i))；prev_0 = 64 个 "0"；
// verify 重算并返回首个不符下标。

export const T8_FIXTURE = {
  events: [
    { actor: 'alice', action: 'login', target: 'web', ts: 1700000000000 },
    { actor: 'alice', action: 'export', target: 'report:Q4', ts: 1700000001000 },
    { actor: 'bob', action: 'delete', target: 'doc:42', ts: 1700000002000 },
    { actor: 'bob', action: 'logout', target: 'web', ts: 1700000003000 },
  ],
};

export function t8Chain(events) {
  const records = [];
  let prev = '0'.repeat(64);
  events.forEach((e, seq) => {
    const hash = sha256hex(prev + '\n' + canonicalJson(e));
    records.push({ seq, prev, hash });
    prev = hash;
  });
  return { records, head: records.length ? records[records.length - 1].hash : '0'.repeat(64) };
}

export function t8Verify(events, records) {
  let prev = '0'.repeat(64);
  for (let i = 0; i < events.length; i++) {
    const hash = sha256hex(prev + '\n' + canonicalJson(events[i]));
    const rec = records[i];
    if (!rec || rec.prev !== prev || rec.hash !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  if (records.length !== events.length) return { ok: false, brokenAt: Math.min(records.length, events.length) };
  return { ok: true, brokenAt: null };
}

export function t8Run(spec) {
  const { records, head } = t8Chain(spec.events);
  const verified = t8Verify(spec.events, records);
  const tampered = spec.events.map((e, i) => (i === 2 ? { ...e, action: 'login' } : e));
  const tamperCheck = t8Verify(tampered, records);
  return { records, head, verified, tamperCheck };
}
export const t8Ref = () => t8Run(T8_FIXTURE);

// ═══════════════════════ T9: i18n 格式化 ═══════════════════════
// 口径：回退链 = locale → 其基础语言（首个 '-' 前）→ "en" → 键名本身；
// 复数类别：en（one 当 n==1，否则 other）；zh（恒 other）；ru（n%10==1 且 n%100!=11 → one；
// n%10∈2..4 且 n%100∉12..14 → few；n%10==0 或 n%10∈5..9 或 n%100∈11..14 → many；否则 other）。
// 模板：{name} 插值；{count, plural, one{..} few{..} many{..} other{..}}，分支内 # 替换为 count。

export const T9_FIXTURE = {
  locale: 'ru',
  catalogs: {
    ru: {
      'items.count': '{count, plural, one{# товар} few{# товара} many{# товаров} other{# товара}}',
      greet: 'Привет, {name}!',
      'only.ru': 'Только RU',
    },
    en: {
      'items.count': '{count, plural, one{# item} other{# items}}',
      greet: 'Hello, {name}!',
      'only.en': 'EN only',
    },
    zh: {
      'items.count': '{count, plural, other{# 件商品}}',
      greet: '你好，{name}！',
    },
  },
  cases: [
    { key: 'items.count', locale: 'ru', vars: { count: 1 } },
    { key: 'items.count', locale: 'ru', vars: { count: 3 } },
    { key: 'items.count', locale: 'ru', vars: { count: 21 } },
    { key: 'items.count', locale: 'ru', vars: { count: 7 } },
    { key: 'items.count', locale: 'en', vars: { count: 1 } },
    { key: 'items.count', locale: 'en', vars: { count: 5 } },
    { key: 'items.count', locale: 'zh', vars: { count: 7 } },
    { key: 'greet', locale: 'ru', vars: { name: 'Ada' } },
    { key: 'only.en', locale: 'ru', vars: {} },
    { key: 'missing.key', locale: 'ru', vars: {} },
    { key: 'only.ru', locale: 'en', vars: {} },
  ],
};

export function t9Plural(locale, n) {
  if (locale === 'en') return n === 1 ? 'one' : 'other';
  if (locale === 'zh') return 'other';
  if (locale === 'ru') {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'one';
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'few';
    if (m10 === 0 || (m10 >= 5 && m10 <= 9) || (m100 >= 11 && m100 <= 14)) return 'many';
    return 'other';
  }
  return 'other';
}

function t9Format(template, vars, locale) {
  // 复数块：手工做花括号配对（正则无法正确处理 one{...} 里的嵌套 }）
  let out = '';
  let i = 0;
  while (i < template.length) {
    if (template[i] !== '{') { out += template[i++]; continue; }
    // 找配对的 }
    let depth = 0;
    let j = i;
    for (; j < template.length; j++) {
      if (template[j] === '{') depth++;
      else if (template[j] === '}') { depth--; if (depth === 0) break; }
    }
    if (j >= template.length) { out += template.slice(i); break; }
    const inner = template.slice(i + 1, j);
    const pm = inner.match(/^(\w+),\s*plural,([\s\S]*)$/);
    if (pm) {
      const n = vars[pm[1]];
      const branches = {};
      const body = pm[2];
      let k = 0;
      while (k < body.length) {
        const bm = /^\s*(one|few|many|other)\s*\{/.exec(body.slice(k));
        if (!bm) { k++; continue; }
        const start = k + bm[0].length;
        let d = 1, e = start;
        for (; e < body.length; e++) {
          if (body[e] === '{') d++;
          else if (body[e] === '}') { d--; if (d === 0) break; }
        }
        branches[bm[1]] = body.slice(start, e);
        k = e + 1;
      }
      const cat = t9Plural(locale, n);
      const chosen = branches[cat] ?? branches.other ?? '';
      out += chosen.replace(/#/g, String(n));
    } else {
      const name = inner.trim();
      out += Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`;
    }
    i = j + 1;
  }
  return out;
}

function t9Resolve(catalogs, locale, key) {
  const chain = [locale];
  const base = String(locale).split('-')[0];
  if (base !== locale) chain.push(base);
  if (!chain.includes('en')) chain.push('en');
  for (const loc of chain) {
    const cat = catalogs[loc];
    if (cat && Object.prototype.hasOwnProperty.call(cat, key)) return { template: cat[key], source: loc };
  }
  return { template: key, source: 'key' };
}

export function t9Run(spec) {
  const rendered = [];
  const missing = [];
  for (const c of spec.cases) {
    const { template, source } = t9Resolve(spec.catalogs, c.locale, c.key);
    if (source === 'key') missing.push(c.key);
    rendered.push({ key: c.key, locale: c.locale, text: t9Format(template, c.vars, c.locale), source });
  }
  return { rendered, missing };
}
export const t9Ref = () => t9Run(T9_FIXTURE);

// ═══════════════════════ T10: Snowflake ID ═══════════════════════
// 口径：id = ((ts−epoch)<<(dcBits+workerBits+seqBits)) | (dc<<(workerBits+seqBits))
// | (worker<<seqBits) | seq（BigInt，十进制字符串输出）；同 ms 内 seq+1；seq 溢出 →
// 进位到 lastTs+1、seq=0；ts<lastTs 时 policy=wait → 用 lastTs 续 seq，policy=reject → 报错。

export const T10_FIXTURE = {
  epoch: 1700000000000,
  datacenterId: 3,
  workerId: 7,
  dcBits: 5,
  workerBits: 5,
  seqBits: 12,
  policy: 'wait',
  requests: [
    { ts: 1700000000001 },
    { ts: 1700000000001 },
    { ts: 1700000000001 },
    { ts: 1700000000002 },
    { ts: 1700000000000 },
    { ts: 1700000000003 },
  ],
};

export function t10Run(spec) {
  const maxSeq = 1n << BigInt(spec.seqBits);
  const shiftDc = BigInt(spec.workerBits + spec.seqBits);
  const shiftWorker = BigInt(spec.seqBits);
  const shiftTs = BigInt(spec.dcBits + spec.workerBits + spec.seqBits);
  let lastTs = -1;
  let seq = 0n;
  const ids = [];
  const parsed = [];
  const errors = [];
  for (let i = 0; i < spec.requests.length; i++) {
    let ts = spec.requests[i].ts;
    if (lastTs >= 0 && ts < lastTs) {
      if (spec.policy === 'reject') {
        errors.push({ index: i, reason: 'clock_backwards' });
        ids.push(null);
        parsed.push(null);
        continue;
      }
      ts = lastTs;
    }
    if (ts === lastTs) {
      seq += 1n;
      if (seq >= maxSeq) {
        seq = 0n;
        ts = lastTs + 1;
        lastTs = ts;
      }
    } else {
      seq = 0n;
      lastTs = ts;
    }
    const id = ((BigInt(ts) - BigInt(spec.epoch)) << shiftTs) |
      (BigInt(spec.datacenterId) << shiftDc) |
      (BigInt(spec.workerId) << shiftWorker) |
      seq;
    ids.push(id.toString());
    parsed.push({ ts, datacenterId: spec.datacenterId, workerId: spec.workerId, seq: Number(seq) });
  }
  return { ids, parsed, errors };
}
export const t10Ref = () => t10Run(T10_FIXTURE);

// ═══════════════════════════ 夹具写入 ═══════════════════════════

export function seed() {
  writeFixture(D(1), 'flags.json', JSON.stringify(T1_FIXTURE, null, 2));
  writeFixture(D(2), 'hooks.json', JSON.stringify(T2_FIXTURE, null, 2));
  writeFixture(D(3), 'metrics.json', JSON.stringify(T3_FIXTURE, null, 2));
  writeFixture(D(4), 'page.json', JSON.stringify(T4_FIXTURE, null, 2));
  writeFixture(D(5), 'migrations.json', JSON.stringify(T5_FIXTURE, null, 2));
  writeFixture(D(6), 'ring.json', JSON.stringify(T6_FIXTURE, null, 2));
  writeFixture(D(7), 'anomaly.json', JSON.stringify(T7_FIXTURE, null, 2));
  writeFixture(D(8), 'audit.json', JSON.stringify(T8_FIXTURE, null, 2));
  writeFixture(D(9), 'i18n.json', JSON.stringify(T9_FIXTURE, null, 2));
  writeFixture(D(10), 'snowflake.json', JSON.stringify(T10_FIXTURE, null, 2));
}

export function saveFixtureHashes(file = `${WS}/v33-fixture-hashes.json`) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURE_HASHES), null, 2));
}

export function loadFixtureHashes(file = `${WS}/v33-fixture-hashes.json`) {
  if (!fs.existsSync(file)) return;
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8')))) FIXTURE_HASHES.set(k, v);
}

// ═══════════════════════════ 自校准 ═══════════════════════════
// 每条都锚定外部已知向量或手算不变量（不复用被测产物），防止参考实现漂移。

export function selfCheck() {
  const bad = [];
  // 通用哈希外部向量（RFC / 公开标准）
  if (fnv1a32('hello') !== 1335831723) bad.push('fnv1a32(hello) 向量');
  if (sha256hex('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') bad.push('sha256(abc) 向量');
  if (hmac256hex('key', 'The quick brown fox jumps over the lazy dog') !==
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8') bad.push('hmac256 RFC4231 向量');
  if (crc32(Buffer.from('123456789', 'utf8')) !== 3421780262) bad.push('crc32 向量');

  // T1：kill switch 优先于规则；缺属性不匹配；灰度确定性
  const R1 = t1Ref();
  if (R1.results[0].flags['checkout-v2'].reason !== 'rule:0') bad.push('T1 enterprise 应命中 rule:0');
  if (R1.results[0].flags['beta-ui'].value !== false || R1.results[0].flags['beta-ui'].reason !== 'disabled') bad.push('T1 kill switch');
  if (R1.results[4].flags['checkout-v2'].reason === 'rule:1') bad.push('T1 缺 age 不应命中 rule:1');
  if (R1.counts['beta-ui'] !== 0) bad.push('T1 beta-ui 计数');
  if (t1EvalFlag(T1_FIXTURE.flags[2], { userId: 'u-1004' }).reason !== 'rollout') bad.push('T1 search-rank 应走灰度');

  // T2：去重、死信、签名条数 = 尝试次数
  const R2 = t2Ref();
  if (R2.summary.delivered !== 2 || R2.summary.dead !== 1 || R2.summary.duplicates !== 1) bad.push('T2 摘要漂移: ' + JSON.stringify(R2.summary));
  if (JSON.stringify(R2.dlq) !== '["d2"]') bad.push('T2 死信漂移');
  if (R2.deliveries[0].timeline.join(',') !== '0,100') bad.push('T2 d1 时间线漂移');
  if (R2.deliveries[1].timeline.join(',') !== '0,100,400,1300') bad.push('T2 d2 时间线漂移');
  if (R2.deliveries[0].signatures.length !== 2) bad.push('T2 签名条数');
  if (R2.deliveries[2].status !== 'duplicate' || R2.deliveries[2].attempts !== 0) bad.push('T2 幂等漂移');

  // T3：手算窗口 + 空窗 + rollup 加权
  const R3 = t3Ref();
  if (R3.dropped !== 2) bad.push('T3 丢弃数漂移');
  if (R3.windows[0].count !== 3 || R3.windows[0].avg !== 20 || R3.windows[0].p95 !== 30) bad.push('T3 w0 漂移: ' + JSON.stringify(R3.windows[0]));
  if (R3.windows[1].count !== 0 || R3.windows[1].avg !== null) bad.push('T3 空窗漂移');
  if (R3.windows[7].avg !== 2.5 || R3.windows[7].p95 !== 4) bad.push('T3 w7 漂移');
  if (R3.rollups[0].count !== 6 || R3.rollups[0].avg !== 14.5 || R3.rollups[0].max !== 30) bad.push('T3 rollup0 漂移: ' + JSON.stringify(R3.rollups[0]));
  if (R3.rollups[1].count !== 7 || R3.rollups[1].avg !== 30 || R3.rollups[1].p95 !== 100) bad.push('T3 rollup1 漂移');

  // T4：排序/分页/防篡改
  const R4 = t4Ref();
  if (JSON.stringify(R4.pages[0].items) !== '["a2","a4","a9"]') bad.push('T4 首页漂移: ' + JSON.stringify(R4.pages[0].items));
  if (R4.pages.length !== 3 || R4.pages[2].cursor !== null) bad.push('T4 页数/末页游标');
  if (JSON.stringify(R4.resumed) !== '["a3","a6","a7"]') bad.push('T4 续页漂移');
  if (!R4.tamperRejected || !R4.sortMismatchRejected) bad.push('T4 拒绝路径');
  const badMac = R4.pages[0].cursor.slice(0, -1) + (R4.pages[0].cursor.slice(-1) === '0' ? '1' : '0');
  let threw = false;
  try { t4DecodeCursor(badMac, T4_FIXTURE.sort, T4_FIXTURE.secret); } catch { threw = true; }
  if (!threw) bad.push('T4 改 MAC 未拒绝');

  // T5：拓扑序、skip、失败回滚
  const R5 = t5Ref();
  if (JSON.stringify(R5.order) !== '["001_init","002_add_email","003_orders","004_orders_fk","005_idx"]') bad.push('T5 拓扑序漂移: ' + JSON.stringify(R5.order));
  if (R5.plan[0].action !== 'skip') bad.push('T5 已应用应 skip');
  if (R5.status !== 'aborted' || JSON.stringify(R5.executed) !== '["002_add_email","003_orders"]') bad.push('T5 执行集漂移');
  if (JSON.stringify(R5.rolledBack) !== '["003_orders","002_add_email"]') bad.push('T5 回滚序漂移');
  const badSum = t5Run({ ...T5_FIXTURE, applied: [{ id: '001_init', checksum: 'deadbeef' }] });
  if (badSum.status !== 'invalid' || !badSum.errors.includes('checksum_mismatch:001_init')) bad.push('T5 校验和不符未拦截');

  // T6：环确定性 + 最小迁移
  const R6 = t6Ref();
  const ownerCount = Object.keys(R6.owners).length;
  if (ownerCount !== T6_FIXTURE.keys.length) bad.push('T6 归属缺失');
  if (R6.rebalanceAdd.moved.length !== R6.rebalanceAdd.count) bad.push('T6 add count 不一致');
  if (R6.rebalanceRemove.moved.length !== R6.rebalanceRemove.count) bad.push('T6 remove count 不一致');
  if (R6.rebalanceAdd.moved.some((m) => m.to !== 'node-d')) bad.push('T6 新增节点迁移目标错误');
  if (R6.rebalanceRemove.moved.some((m) => m.from !== 'node-c')) bad.push('T6 删除节点迁移来源错误');

  // T7：连续去抖（手算 α=0.05：单点尖峰不告警；13→14 连续异常触发唯一告警）
  const R7 = t7Ref();
  if (!R7.alerts.some((a) => a.index === 14 && a.direction === 'up')) bad.push('T7 连续上探未告警: ' + JSON.stringify(R7.alerts));
  if (R7.alerts.some((a) => a.index === 7)) bad.push('T7 单点异常不应告警');
  if (R7.alerts.length !== 1) bad.push('T7 告警条数漂移: ' + JSON.stringify(R7.alerts));
  const noStreak = t7Run({ ...T7_FIXTURE, minStreak: 1 });
  if (noStreak.alerts.length !== 1 || noStreak.alerts[0].index !== 13) bad.push('T7 minStreak=1 应在首个异常告警: ' + JSON.stringify(noStreak.alerts));

  // T8：链/断链
  const R8 = t8Ref();
  if (!R8.verified.ok || R8.verified.brokenAt !== null) bad.push('T8 原始链校验失败');
  if (R8.tamperCheck.ok || R8.tamperCheck.brokenAt !== 2) bad.push('T8 篡改未定位到 2: ' + JSON.stringify(R8.tamperCheck));
  if (R8.records[0].prev !== '0'.repeat(64)) bad.push('T8 创世 prev');
  if (R8.head !== R8.records[3].hash) bad.push('T8 head');

  // T9：复数类别外部锚点（CLDR 俄语规则）
  const R9 = t9Ref();
  const byKey = (i) => R9.rendered[i].text;
  if (byKey(0) !== '1 товар') bad.push('T9 ru one: ' + byKey(0));
  if (byKey(1) !== '3 товара') bad.push('T9 ru few: ' + byKey(1));
  if (byKey(2) !== '21 товар') bad.push('T9 ru 21: ' + byKey(2));
  if (byKey(3) !== '7 товаров') bad.push('T9 ru many: ' + byKey(3));
  if (byKey(4) !== '1 item' || byKey(5) !== '5 items') bad.push('T9 en');
  if (byKey(6) !== '7 件商品') bad.push('T9 zh: ' + byKey(6));
  if (byKey(7) !== 'Привет, Ada!') bad.push('T9 插值');
  if (byKey(8) !== 'EN only' || R9.rendered[8].source !== 'en') bad.push('T9 ru→en 回退');
  if (byKey(9) !== 'missing.key' || R9.rendered[9].source !== 'key') bad.push('T9 键名回退');
  if (byKey(10) !== 'only.ru' || R9.rendered[10].source !== 'key') bad.push('T9 en 无 only.ru 应回退键名');
  if (JSON.stringify(R9.missing) !== '["missing.key","only.ru"]') bad.push('T9 missing 漂移: ' + JSON.stringify(R9.missing));

  // T10：位布局手算（epoch/ts 差 1、dc=3、worker=7、seq=0 → 1<<22 | 3<<17 | 7<<12）
  const R10 = t10Ref();
  const expectFirst = ((1n << 22n) | (3n << 17n) | (7n << 12n)).toString();
  if (R10.ids[0] !== expectFirst) bad.push('T10 首个 ID 位布局漂移: ' + R10.ids[0] + ' vs ' + expectFirst);
  if (R10.parsed[1].seq !== 1 || R10.parsed[2].seq !== 2) bad.push('T10 同 ms 序列漂移');
  if (R10.parsed[4].ts !== 1700000000002 || R10.parsed[4].seq !== 1) bad.push('T10 回拨 wait 策略漂移: ' + JSON.stringify(R10.parsed[4]));
  if (R10.errors.length !== 0) bad.push('T10 wait 策略不应报错');
  const rej = t10Run({ ...T10_FIXTURE, policy: 'reject' });
  if (rej.errors.length !== 1 || rej.errors[0].index !== 4 || rej.ids[4] !== null) bad.push('T10 reject 策略漂移');
  const overflow = t10Run({ ...T10_FIXTURE, seqBits: 2, requests: [{ ts: 5 }, { ts: 5 }, { ts: 5 }, { ts: 5 }, { ts: 5 }] });
  if (overflow.parsed[4].ts !== 6 || overflow.parsed[4].seq !== 0) bad.push('T10 序列溢出进位漂移: ' + JSON.stringify(overflow.parsed[4]));

  return bad;
}

/**
 * 交叉校验：任务核验器里的硬编码探针向量必须由参考实现复算得出（v32 F1 教训：
 * 探针期望与参考实现三方撕裂时，只有交叉校验能挡住）。
 */
export const PROBE_VECTORS = {
  t1Fnv: { input: 'hello', expected: 1335831723 },
  t2Hmac: { secret: 'key', data: 'The quick brown fox jumps over the lazy dog', expected: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8' },
  t3P95: { values: [1, 2, 3, 4], expected: 4 },
  t4FirstPage: { expected: ['a2', 'a4', 'a9'] },
  t5Sha: { input: 'abc', expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  t6Crc: { input: '123456789', expected: 3421780262 },
  t7Alert: { index: 14, direction: 'up' },
  t8Tamper: { brokenAt: 2 },
  t9Ru21: { locale: 'ru', n: 21, expected: 'one' },
  t10Layout: { expected: ((1n << 22n) | (3n << 17n) | (7n << 12n)).toString() },
};

export function crossCheck() {
  const bad = [];
  const p = PROBE_VECTORS;
  if (fnv1a32(p.t1Fnv.input) !== p.t1Fnv.expected) bad.push('cross T1 fnv');
  if (hmac256hex(p.t2Hmac.secret, p.t2Hmac.data) !== p.t2Hmac.expected) bad.push('cross T2 hmac');
  if (t3Stats(p.t3P95.values).p95 !== p.t3P95.expected) bad.push('cross T3 p95');
  if (JSON.stringify(t4Ref().pages[0].items) !== JSON.stringify(p.t4FirstPage.expected)) bad.push('cross T4 first page');
  if (sha256hex(p.t5Sha.input) !== p.t5Sha.expected) bad.push('cross T5 sha');
  if (crc32(Buffer.from(p.t6Crc.input, 'utf8')) !== p.t6Crc.expected) bad.push('cross T6 crc');
  const a = t7Ref().alerts.find((x) => x.index === p.t7Alert.index);
  if (!a || a.direction !== p.t7Alert.direction) bad.push('cross T7 alert');
  if (t8Ref().tamperCheck.brokenAt !== p.t8Tamper.brokenAt) bad.push('cross T8 tamper');
  if (t9Plural(p.t9Ru21.locale, p.t9Ru21.n) !== p.t9Ru21.expected) bad.push('cross T9 ru21');
  if (t10Ref().ids[0] !== p.t10Layout.expected) bad.push('cross T10 layout');
  return bad;
}
