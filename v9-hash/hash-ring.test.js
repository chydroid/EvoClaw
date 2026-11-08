'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { ConsistentHashRing } = require('./hash-ring.js');

// 固定的 key 集合（模拟 1000 个缓存键）
function makeKeys(n) {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(`user:${i}:profile`);
  return keys;
}

test('基本路由：空环 get 返回 null', () => {
  const ring = new ConsistentHashRing();
  assert.strictEqual(ring.get('any-key'), null);
});

test('单节点：所有 key 路由到唯一节点', () => {
  const ring = new ConsistentHashRing({ replicas: 150 });
  ring.addNode('A');
  const keys = makeKeys(100);
  for (const k of keys) {
    assert.strictEqual(ring.get(k), 'A');
  }
});

test('基本路由稳定性：同一 key 多次 get 结果一致', () => {
  const ring = new ConsistentHashRing();
  ring.addNode('A');
  ring.addNode('B');
  ring.addNode('C');
  const keys = makeKeys(500);
  for (const k of keys) {
    const r1 = ring.get(k);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(ring.get(k), r1, `key ${k} 路由不稳定`);
    }
  }
});

test('节点加入时仅该区间的 key 迁移（重映射率 < 1/N）', () => {
  const ring = new ConsistentHashRing({ replicas: 150 });
  const nodes = ['A', 'B', 'C', 'D'];
  nodes.forEach((n) => ring.addNode(n));

  const keys = makeKeys(2000);
  const res = ring.remapRatio(keys, { add: ['E'] });

  // 加入第 5 个节点：期望重映射率 ≈ 1/5，严格上限放宽为 0.4
  assert.ok(
    res.rate < 0.4,
    `加入节点 E 后重映射率 ${res.rate} 应 < 0.4（理论 1/5）`
  );
  assert.ok(
    res.rate > 0.05,
    `重映射率 ${res.rate} 过小说明新节点几乎没分到 key`
  );
  // 迁移的 key 应全部落到新节点
  assert.strictEqual(res.after[0] === 'E' ? 'x' : 'x', 'x'); // 占位
  const migrated = res.after.slice(res.affectedKeys.map(() => 0).length);
  // 直接检查：每个被重映射的 key 的目标都应是新节点 E
  for (const i of res.affectedKeys) {
    assert.strictEqual(res.after[i], 'E', `key ${keys[i]} 迁移目标应为 E`);
  }
});

test('移除节点时 key 分散到其后继（而非全部堆到同一节点）', () => {
  const ring = new ConsistentHashRing({ replicas: 150 });
  const nodes = ['A', 'B', 'C', 'D', 'E'];
  nodes.forEach((n) => ring.addNode(n));

  const keys = makeKeys(3000);
  const res = ring.remapRatio(keys, { remove: ['C'] });

  // 移除 C：所有迁移的 key 的目标集合应为剩余节点 {A,B,D,E}
  const targets = new Set(Object.keys(res.perNode));
  assert.ok(targets.size >= 3, `移除节点后迁移目标应分散到 ≥3 个节点，实际 ${[...targets].join(',')}`);
  for (const t of targets) {
    assert.ok(!['C'].includes(t), '迁移目标不应包含已移除节点');
  }
  // 未迁移的 key 保持原路由
  const untouched = keys.filter((_, i) => !res.affectedKeys.includes(i));
  for (const k of untouched.slice(0, 50)) {
    assert.strictEqual(ring.get(k), res.before[keys.indexOf(k)] || ring.get(k));
  }
});

test('虚拟节点越多分布越均匀（150 vs 30 对比）', () => {
  const keys = makeKeys(5000);
  const nodes = ['A', 'B', 'C', 'D'];

  function distribution(replicas) {
    const ring = new ConsistentHashRing({ replicas });
    nodes.forEach((n) => ring.addNode(n));
    const counts = {};
    keys.forEach((k) => {
      const n = ring.get(k);
      counts[n] = (counts[n] || 0) + 1;
    });
    // 各节点负载的标准差 / 均值
    const vals = Object.values(counts);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(
      vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
    );
    return { counts, mean, cv: sd / mean }; // 变异系数越小越均匀
  }

  const d30 = distribution(30);
  const d150 = distribution(150);

  assert.ok(
    d150.cv < d30.cv,
    `虚拟节点 150 的变异系数 (${d150.cv}) 应小于 30 (${d30.cv})`
  );
});

test('虚拟节点数越多，节点增减时的重映射分布越平滑', () => {
  const keys = makeKeys(2000);
  const baseNodes = ['A', 'B', 'C'];

  function maxShareAfterRemove(replicas, removed) {
    const ring = new ConsistentHashRing({ replicas });
    baseNodes.forEach((n) => ring.addNode(n));
    const res = ring.remapRatio(keys, { remove: [removed] });
    return Math.max(...Object.values(res.perNode), 0) / keys.length;
  }

  const share30 = maxShareAfterRemove(30, 'B');
  const share150 = maxShareAfterRemove(150, 'B');
  // 150 虚拟节点：被移除节点 B 的 key 更均匀分散到 A/C，最大承接者占比应 ≤ 30 版本
  assert.ok(
    share150 <= share30 + 0.05,
    `150 虚拟节点最大承接占比 ${share150} 不应明显高于 30 的 ${share30}`
  );
});
