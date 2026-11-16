/**
 * Round 6 — 算法 / 数据结构
 * 21. 行级 diff + unified patch 应用
 * 22. 图算法（拓扑排序 + Dijkstra + 环检测）
 * 23. 文本压缩编解码（往返 + 校验 + 压缩率）
 * 24. LRU + TTL 缓存
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  WS, defineChecks, runProbe, runNodeTest, runNodeWithCode, readFileSafe, writeFixture,
} from './lib.mjs';

const D21 = `${WS}/v14-diff`;
const D22 = `${WS}/v14-graph`;
const D23 = `${WS}/v14-codec`;
const D24 = `${WS}/v14-lru`;

const OLD_TXT = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
const NEW_TXT = 'alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\n';

const GRAPH = {
  nodes: ['A', 'B', 'C', 'D', 'E', 'F'],
  edges: [
    { from: 'A', to: 'B', weight: 2 },
    { from: 'A', to: 'C', weight: 5 },
    { from: 'B', to: 'C', weight: 1 },
    { from: 'C', to: 'D', weight: 4 },
    { from: 'B', to: 'D', weight: 7 },
    { from: 'E', to: 'F', weight: 3 },
    { from: 'D', to: 'F', weight: 1 },
  ],
};
const CYCLE_GRAPH = {
  nodes: ['X', 'Y', 'Z'],
  edges: [
    { from: 'X', to: 'Y', weight: 1 },
    { from: 'Y', to: 'Z', weight: 2 },
    { from: 'Z', to: 'X', weight: 3 },
  ],
};
const DIST_FROM_A = { A: 0, B: 2, C: 3, D: 7, E: null, F: 8 };

const REPETITIVE = 'abcabc'.repeat(3000) + '\n';
const UNICODE_TXT = '中文测试 🚀 emoji ✓\n第二行：重复重复重复\n';

const DIFF_VECTORS = [
  ['identical', 'same\nline\n', 'same\nline\n'],
  ['insert-middle', 'a\nc\n', 'a\nb\nc\n'],
  ['delete-middle', 'a\nb\nc\n', 'a\nc\n'],
  ['multi-hunk', '1\n2\n3\n4\n5\n6\n7\n8\n9\n', '1\nTWO\n3\n4\nFIVE\n6\n7\n8\nNINE\n'],
  ['empty-to-text', '', 'hello\nworld\n'],
  ['text-to-empty', 'hello\nworld\n', ''],
  ['no-trailing-newline', 'a\nb', 'a\nB'],
];

function seed() {
  writeFixture(D21, 'fixtures/old.txt', OLD_TXT);
  writeFixture(D21, 'fixtures/new.txt', NEW_TXT);
  writeFixture(D22, 'fixtures/graph.json', JSON.stringify(GRAPH, null, 2));
  writeFixture(D22, 'fixtures/cyclic.json', JSON.stringify(CYCLE_GRAPH, null, 2));
  writeFixture(D23, 'fixtures/repetitive.txt', REPETITIVE);
  writeFixture(D23, 'fixtures/unicode.txt', UNICODE_TXT);
}

function edgeOrderValid(order, edges, nodes) {
  const pos = new Map(order.map((n, i) => [n, i]));
  if (order.length !== nodes.length) return '节点数不符';
  for (const n of nodes) if (!pos.has(n)) return `缺节点 ${n}`;
  for (const e of edges) if (pos.get(e.from) >= pos.get(e.to)) return `边 ${e.from}->${e.to} 顺序错误`;
  return null;
}

const tasks = defineChecks([
  {
    id: 21, round: 6, name: '行级 diff + patch 应用', type: '算法/Diff',
    prompt: `你是版本控制工程师。在 ${D21}/ 下交付 diff.js（CommonJS，无第三方依赖）：
1）导出 createPatch(oldText, newText, context=3) → unified diff 字符串。格式必须包含 "--- a" 与 "+++ b" 头、以及至少一个 "@@ -x,y +u,v @@" 块；文本相同返回空串。
2）导出 applyPatch(oldText, patchText) → 应用补丁后的文本；补丁不匹配（上下文/行号错误）时抛出 Error（message 含 "does not apply"）。必须正确处理文件末尾无换行的情况。
3）diff.js CLI：\`node diff.js <old> <new> --out <patch文件>\`；patch.js CLI：\`node patch.js <patch文件> <old> --out <结果文件>\`。
4）diff.test.js（node --test，≥7 用例）覆盖相同文件、插入、删除、多处修改、空文件、末尾无换行、补丁失败。
5）README.md（≥250 字节）：格式、上下文行数、失败语义。
6）必须真实执行：对夹具 fixtures/old.txt 与 fixtures/new.txt 生成 patch.diff，再用 patch.js 还原出 applied.txt，并确认与 new.txt 一致；把结果写进回复。`,
    expect: 'diff.js + patch.js + patch.diff + applied.txt + diff.test.js + README.md',
    dir: D21, frozen: ['fixtures/old.txt', 'fixtures/new.txt'],
    deliverables: [
      { file: 'diff.js', minBytes: 800 },
      { file: 'patch.js', minBytes: 400 },
      { file: 'patch.diff', minBytes: 50 },
      { file: 'applied.txt', minBytes: 30 },
      { file: 'diff.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const probe = `
        const vec = ${JSON.stringify(DIFF_VECTORS)};
        const out = { rounds: [] };
        for (const [name, a, b] of vec) {
          const patch = m.createPatch(a, b);
          let applied = null, err = null;
          try { applied = m.applyPatch(a, patch); } catch (e) { err = String(e.message); }
          out.rounds.push({ name, patch, applied, err, ok: applied === b });
        }
        let failed = null;
        try { m.applyPatch('wrong\\ncontent\\n', m.createPatch('a\\nb\\n', 'a\\nc\\n')); } catch (e) { failed = String(e.message); }
        const sample = m.createPatch('a\\nb\\nc\\nd\\ne\\nf\\ng\\n', 'a\\nB\\nc\\nd\\ne\\nF\\ng\\n');
        return { rounds: out.rounds, failed, sample };
      `;
      const p = runProbe(dir, 'diff.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      if (!p.value.rounds.every((x) => x.ok)) bad.push('往返失败: ' + p.value.rounds.filter((x) => !x.ok).map((x) => `${x.name}(${x.err || 'mismatch'})`).join(','));
      if (!/does not apply/i.test(p.value.failed || '')) bad.push(`补丁失败未抛指定错误 ${p.value.failed}`);
      if (!/--- a/.test(p.value.sample) || !/\+\+\+ b/.test(p.value.sample) || !/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(p.value.sample)) bad.push('unified 头/@@ 格式缺失');
      const d = runNodeWithCode(dir, 'diff.js fixtures/old.txt fixtures/new.txt --out verify.diff');
      const a = runNodeWithCode(dir, 'patch.js verify.diff fixtures/old.txt --out verify.applied.txt');
      if (d.code !== 0 || a.code !== 0) bad.push(`CLI 退出码 ${d.code}/${a.code}`);
      if (readFileSafe(path.join(dir, 'verify.applied.txt')) !== NEW_TXT) bad.push('CLI 还原结果与 new.txt 不一致');
      const t = runNodeTest(path.join(dir, 'diff.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓7组往返/补丁失败/@@格式/CLI还原/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'diff.js'));
      return [['unified 头', /--- a|\+\+\+ b/i.test(s)], ['上下文', /context|@@/i.test(s)], ['失败语义', /does not apply/i.test(s)]];
    },
  },
  {
    id: 22, round: 6, name: '图算法（拓扑/Dijkstra/环）', type: '算法/图',
    prompt: `你是算法工程师。在 ${D22}/ 下交付 graph.js（CommonJS，无第三方依赖），夹具 fixtures/graph.json、fixtures/cyclic.json（{"nodes":[...],"edges":[{"from","to","weight"}]}）由我提供，**禁止修改**：
1）导出 topoSort(nodes, edges) → {ok:true,order:[...]} 或 {ok:false,error:'cycle'}；order 必须满足所有边 from 在 to 之前。
2）导出 dijkstra(nodes, edges, start) → 对象，包含所有节点：可达节点为最短距离数字，不可达为 null。
3）CLI：\`node graph.js <图文件> --start <起点> --out <输出>\`：
   - 无环图输出 {"hasCycle":false,"topoOrder":[...],"distances":{...}}；
   - 有环图输出 {"hasCycle":true,"cycleNodes":[...]}，cycleNodes 必须包含该环上的全部节点（顺序不限）。
4）graph.test.js（node --test，≥6 用例）覆盖拓扑合法性、环检测、Dijkstra 最短路径、不可达节点、单节点图。
5）README.md（≥250 字节）：算法、复杂度、输出格式。
6）必须真实对两份夹具各运行一次 CLI，把 A 到 F 的距离与是否成环写进回复。`,
    expect: 'graph.js + graph-report.json + cycle-report.json + graph.test.js + README.md',
    dir: D22, frozen: ['fixtures/graph.json', 'fixtures/cyclic.json'],
    deliverables: [
      { file: 'graph.js', minBytes: 800 },
      // graph-report.json / cycle-report.json 由 exec 独立运行 CLI 生成并校验，
      // 不要求落在交付根目录（且文件名由 harness 自拟，prompt 未强制）。
      { file: 'graph.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const r1 = runNodeWithCode(dir, 'graph.js fixtures/graph.json --start A --out verify-graph.json');
      // prompt 的 CLI 签名始终要求 --start；有环图起点不影响结果，但仍须传入。
      const r2 = runNodeWithCode(dir, 'graph.js fixtures/cyclic.json --start X --out verify-cycle.json');
      if (r1.code !== 0 || r2.code !== 0) bad.push(`CLI 退出码 ${r1.code}/${r2.code}`);
      let g1, g2;
      try { g1 = JSON.parse(readFileSafe(path.join(dir, 'verify-graph.json'))); } catch { bad.push('verify-graph.json 非法'); }
      try { g2 = JSON.parse(readFileSafe(path.join(dir, 'verify-cycle.json'))); } catch { bad.push('verify-cycle.json 非法'); }
      if (g1) {
        if (g1.hasCycle !== false) bad.push('无环图 hasCycle ≠ false');
        const err = edgeOrderValid(g1.topoOrder || [], GRAPH.edges, GRAPH.nodes);
        if (err) bad.push('拓扑 ' + err);
        if (JSON.stringify(g1.distances) !== JSON.stringify(DIST_FROM_A)) bad.push(`距离 ${JSON.stringify(g1.distances)}`);
      }
      if (g2) {
        if (g2.hasCycle !== true) bad.push('有环图 hasCycle ≠ true');
        const set = new Set(g2.cycleNodes || []);
        for (const n of CYCLE_GRAPH.nodes) if (!set.has(n)) bad.push(`cycleNodes 缺 ${n}`);
      }
      const probe = `
        const topo = m.topoSort(${JSON.stringify(GRAPH.nodes)}, ${JSON.stringify(GRAPH.edges)});
        const cyc = m.topoSort(${JSON.stringify(CYCLE_GRAPH.nodes)}, ${JSON.stringify(CYCLE_GRAPH.edges)});
        const dist = m.dijkstra(${JSON.stringify(GRAPH.nodes)}, ${JSON.stringify(GRAPH.edges)}, 'A');
        return { topo, cyc, dist };
      `;
      const p = runProbe(dir, 'graph.js', probe);
      if (!p.ok) bad.push('probe 失败 ' + p.out);
      else {
        const err = edgeOrderValid(p.value.topo?.order || [], GRAPH.edges, GRAPH.nodes);
        if (err) bad.push('导出 topoSort ' + err);
        if (p.value.cyc?.ok !== false || p.value.cyc?.error !== 'cycle') bad.push(`环检测导出 ${JSON.stringify(p.value.cyc)}`);
        if (JSON.stringify(p.value.dist) !== JSON.stringify(DIST_FROM_A)) bad.push(`导出 dijkstra ${JSON.stringify(p.value.dist)}`);
      }
      const t = runNodeTest(path.join(dir, 'graph.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓拓扑边序/环/距离A-F精确/不可达null/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'graph.js'));
      return [['拓扑', /topo/i.test(s)], ['Dijkstra', /dijkstra/i.test(s)], ['环', /cycle/i.test(s)]];
    },
  },
  {
    id: 23, round: 6, name: '文本压缩编解码（往返）', type: '算法/压缩',
    prompt: `你是数据压缩工程师。在 ${D23}/ 下交付 codec.js（CommonJS，无第三方依赖）：
1）导出 encode(text) → 可安全写入文本文件的无换行字符串；decode(encoded) → 原始 UTF-8 文本。必须对任意 Unicode 往返一致。
2）编码格式必须包含完整性校验（如长度/哈希/校验和）：任何篡改（包括改 1 个字符）后 decode 必须抛出 Error，不得静默返回错误结果。
3）对高度重复文本必须有实际压缩效果：fixtures/repetitive.txt 的编码字符串长度不得超过原文的 50%。
4）CLI：\`node codec.js encode <输入> --out <编码文件>\` 与 \`node codec.js decode <编码文件> --out <输出文件>\`。
5）codec.test.js（node --test，≥6 用例）覆盖英文/中文/emoji/空串/重复文本压缩率/篡改检测。
6）README.md（≥250 字节）：算法、校验、比例数据。
7）必须真实执行 encode 与 decode fixtures/repetitive.txt 和 fixtures/unicode.txt，确认解码后逐字一致，把压缩率写进回复。`,
    expect: 'codec.js + encoded.txt + decoded.txt + codec.test.js + README.md',
    dir: D23, frozen: ['fixtures/repetitive.txt', 'fixtures/unicode.txt'],
    deliverables: [
      { file: 'codec.js', minBytes: 800 },
      { file: 'encoded.txt', minBytes: 100 },
      { file: 'decoded.txt', minBytes: 100 },
      { file: 'codec.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const probe = `
        const fs = require('fs');
        const rep = fs.readFileSync('fixtures/repetitive.txt', 'utf8');
        const uni = fs.readFileSync('fixtures/unicode.txt', 'utf8');
        const encRep = m.encode(rep);
        const decRep = m.decode(encRep);
        const encUni = m.encode(uni);
        const decUni = m.decode(encUni);
        const empty = m.decode(m.encode(''));
        let corrupt = null;
        const enc = m.encode('hello world hello world');
        const pos = Math.floor(enc.length / 2);
        const alt = enc[pos] === 'A' ? 'B' : 'A';
        const tampered = enc.slice(0, pos) + alt + enc.slice(pos + 1);
        try { m.decode(tampered); corrupt = false; } catch { corrupt = true; }
        let garbage = null; try { m.decode('!!!not-a-valid-payload!!!'); } catch { garbage = true; }
        return { okRep: decRep === rep, okUni: decUni === uni, empty, repLen: rep.length, encLen: encRep.length, corrupt, garbage, newlineInEnc: encRep.includes('\\n') };
      `;
      const p = runProbe(dir, 'codec.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value;
      if (!v.okRep) bad.push('重复文本往返失败');
      if (!v.okUni) bad.push('Unicode 往返失败');
      if (v.empty !== '') bad.push(`空串往返 ${JSON.stringify(v.empty)}`);
      if (!(v.encLen <= v.repLen * 0.5)) bad.push(`压缩率 ${v.encLen}/${v.repLen}`);
      if (v.corrupt !== true) bad.push('篡改未抛错');
      if (v.garbage !== true) bad.push('垃圾输入未抛错');
      if (v.newlineInEnc) bad.push('编码含换行');
      const e = runNodeWithCode(dir, 'codec.js encode fixtures/repetitive.txt --out verify-encoded.txt');
      const d = runNodeWithCode(dir, 'codec.js decode verify-encoded.txt --out verify-decoded.txt');
      if (e.code !== 0 || d.code !== 0) bad.push(`CLI 退出码 ${e.code}/${d.code}`);
      if (readFileSafe(path.join(dir, 'verify-decoded.txt')) !== REPETITIVE) bad.push('CLI 解码与原文不一致');
      const t = runNodeTest(path.join(dir, 'codec.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : `exec=✓往返/Unicode/空串/压缩率${(v.encLen / v.repLen * 100).toFixed(1)}%/篡改抛错/node-test` };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'codec.js'));
      return [['校验和', /checksum|hash|crc|length/i.test(s)], ['往返', /encode|decode/i.test(s)], ['UTF-8', /utf8|string/i.test(s)]];
    },
  },
  {
    id: 24, round: 6, name: 'LRU + TTL 缓存', type: '数据结构/缓存',
    prompt: `你是数据结构工程师。在 ${D24}/ 下交付 cache.js（CommonJS，无第三方依赖）：
1）导出 createCache({max, ttlMs=Infinity, now=Date.now})，方法：
   - set(key, value)：插入/更新；更新视为最近使用；容量超过 max 时淘汰**最久未使用**的键；
   - get(key)：不存在返回 undefined；已过期（now() ≥ 写入时刻 + ttlMs）则删除并记一次 miss + 一次 expiration，否则记 hit 并移到最近使用；返回 value；
   - has(key)：存在且未过期返回 true；过期则删除并记 expiration；**不改变 LRU 顺序**；
   - delete(key)：存在返回 true 并删除；
   - stats() → {"hits","misses","evictions","expirations","size"}。
2）cache.test.js（node --test，≥7 用例）覆盖 LRU 淘汰、get 提升近期性、更新提升、TTL 边界（ttlMs-1 命中、ttlMs 过期）、has 不改顺序、统计计数。
3）README.md（≥250 字节）：复杂度与过期语义。
4）必须真实运行一段 LRU+TTL 场景，把 hits/misses/evictions/expirations 写进回复。`,
    expect: 'cache.js + cache.test.js + README.md（LRU/TTL 精确探针）',
    dir: D24,
    deliverables: [
      { file: 'cache.js', minBytes: 700 },
      { file: 'cache.test.js', minBytes: 600 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const probe = `
        let t = 0;
        const c = m.createCache({ max: 2, ttlMs: 1000, now: () => t });
        c.set('a', 1); c.set('b', 2);
        const ga = c.get('a');        // hit, a MRU
        c.set('c', 3);                // 淘汰 b
        const gb = c.get('b');        // miss
        const s1 = c.stats();
        t = 999;
        c.set('x', 9);                // 淘汰 c? 当前 a,x -> wait: 之前 size2 = {a,c}; set x -> evict LRU = c
        const sx999 = c.get('x');     // hit
        t = 1000;                     // x 写入于 999 → 到期 1999? 注意 set x 时 t=999
        const sx1000 = c.get('x');    // 仍未过期(999+1000=1999)
        t = 2000;
        const sxExpired = c.get('x'); // miss + expiration
        const s2 = c.stats();
        // 更新提升
        let t2 = 0;
        const c2 = m.createCache({ max: 2, ttlMs: Infinity, now: () => t2 });
        c2.set('p', 1); c2.set('q', 2); c2.set('p', 10); c2.set('r', 3);
        const q2 = c2.get('q');
        // has 不改顺序
        let t3 = 0;
        const c3 = m.createCache({ max: 2, ttlMs: 1000, now: () => t3 });
        c3.set('m', 1); c3.set('n', 2); c3.has('m'); c3.set('o', 3);
        const m3 = c3.get('m'); // 若 has 未提升，m 应已被淘汰 -> undefined
        t3 = 0; c3.set('p', 1); t3 = 1000;
        const pExp = c3.has('p');
        const s3 = c3.stats();
        return { ga, gb, s1, sx999, sx1000, sxExpired, s2, q2, m3, pExp, s3 };
      `;
      const p = runProbe(dir, 'cache.js', probe);
      if (!p.ok) return { ok: false, detail: 'exec=probe 失败 ' + p.out };
      const v = p.value; const bad = [];
      if (v.ga !== 1 || v.gb !== undefined) bad.push(`LRU 基本 ${v.ga}/${v.gb}`);
      if (v.s1?.hits !== 1 || v.s1?.misses !== 1 || v.s1?.evictions !== 1 || v.s1?.size !== 2) bad.push(`s1 ${JSON.stringify(v.s1)}`);
      if (v.sx999 !== 9 || v.sx1000 !== 9) bad.push(`TTL 边界 ${v.sx999}/${v.sx1000}`);
      if (v.sxExpired !== undefined || v.s2?.expirations < 1) bad.push(`过期 ${v.sxExpired}/${JSON.stringify(v.s2)}`);
      if (v.q2 !== undefined) bad.push('更新未提升近期性');
      if (v.m3 !== undefined) bad.push('has 改变了 LRU 顺序');
      if (v.pExp !== false) bad.push(`has 过期判定 ${v.pExp}`);
      if (v.s3?.expirations < 1) bad.push(`has 过期未计 expiration ${JSON.stringify(v.s3)}`);
      const t = runNodeTest(path.join(dir, 'cache.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓LRU 淘汰/get 提升/更新提升/TTL 边界/has 语义/统计/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'cache.js'));
      return [['Map 结构', /new\s+Map|Map\(/i.test(s)], ['LRU', /delete|set.*key|evict/i.test(s)], ['TTL', /ttl|expire/i.test(s)]];
    },
  },
]);

export const round = 6;
export const title = '算法 / 数据结构';
export default { round, title, outTag: 'r6', seed, tasks };
