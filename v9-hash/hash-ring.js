'use strict';

const crypto = require('crypto');

function hashStr(str, algo) {
  const digest = crypto.createHash(algo).update(String(str)).digest();
  // 取前 16 字节作为无符号 64 位整数（避免精度损失：16 字节 = 128bit，超出 Number 安全范围）。
  // 为保持与 Number 精确运算兼容，采用 8 字节（64 位）无符号整数，Node 10+ BigInt 下无需 BigInt：
  const bytes = digest.subarray(0, 8);
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value; // BigInt 64 位，环空间 2^64
}

class ConsistentHashRing {
  /**
   * @param {object} [options]
   * @param {string} [options.algo='sha1'] 摘要算法：sha1 | md5
   * @param {number} [options.replicas=150] 每节点虚拟节点数
   */
  constructor(options = {}) {
    this.algo = options.algo || 'sha1';
    this.replicas = Number.isFinite(options.replicas) ? options.replicas : 150;
    // 有序环：position -> node（虚拟节点）
    this.positions = []; // 排序后的哈希位置数组（BigInt）
    this.nodeAt = new Map(); // position(BigInt 字符串 key) -> node
    this.nodes = new Set(); // 真实节点集合
  }

  get _positions() {
    return this.positions;
  }

  _hashValue(input) {
    return hashStr(input, this.algo);
  }

  addNode(name) {
    if (this.nodes.has(name)) return;
    this.nodes.add(name);
    for (let i = 0; i < this.replicas; i++) {
      const key = `${name}#${i}`;
      const pos = this._hashValue(key);
      this.positions.push({ pos, node: name });
      this.nodeAt.set(pos.toString(), name);
    }
    this.positions.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
  }

  removeNode(name) {
    if (!this.nodes.delete(name)) return;
    this.positions = this.positions.filter((e) => e.node !== name);
    this.nodeAt = new Map(
      this.positions.map((e) => [e.pos.toString(), e.node])
    );
  }

  _findIdx(pos) {
    // 二分查找：第一个 >= pos 的位置；若不存在则回绕到 0
    const arr = this.positions;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].pos < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo >= arr.length ? 0 : lo;
  }

  get(key) {
    if (this.positions.length === 0) return null;
    const pos = this._hashValue(key);
    return this.positions[this._findIdx(pos)].node;
  }

  get keys() {
    return Array.from(this.nodes);
  }

  /**
   * 计算 key 在节点变更后的重映射率。
   * @param {string[]} keys
   * @param {object} [mutation]
   * @param {string[]} [mutation.add] 加入的节点
   * @param {string[]} [mutation.remove] 移除的节点
   * @returns {{total:number, remapped:number, rate:number, perNode:Object<string,number>}}
   */
  remapRatio(keys, mutation) {
    const add = (mutation && mutation.add) || [];
    const remove = (mutation && mutation.remove) || [];
    const before = keys.map((k) => this.get(k));

    const saved = this._snapshot();
    const addSet = new Set(add);
    add.forEach((n) => this.addNode(n));
    remove.forEach((n) => this.removeNode(n));

    const after = keys.map((k) => this.get(k));
    this._restore(saved);

    const remapped = [];
    const perNode = {};
    for (let i = 0; i < keys.length; i++) {
      if (before[i] !== after[i]) {
        remapped.push(i);
        perNode[after[i]] = (perNode[after[i]] || 0) + 1;
      }
    }
    return {
      total: keys.length,
      remapped: remapped.length,
      rate: keys.length ? remapped.length / keys.length : 0,
      perNode,
      affectedKeys: remapped,
      before,
      after,
    };
  }

  _snapshot() {
    return {
      positions: [...this.positions],
      nodeAt: new Map(this.nodeAt),
      nodes: new Set(this.nodes),
    };
  }

  _restore(snap) {
    this.positions = snap.positions;
    this.nodeAt = snap.nodeAt;
    this.nodes = snap.nodes;
  }
}

module.exports = { ConsistentHashRing, hashStr };
