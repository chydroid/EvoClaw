---
name: uuid-generator
version: 1.0.0
description: "UUID 生成器 — 生成 UUID v4（随机）和 v7（时间戳排序），支持批量生成与版本解析。无外部依赖（脚本内使用 Math.random 兜底）。"
author: evoclaw-official
category: utility
keywords:
  - uuid
  - guid
  - v4
  - v7
  - 标识符
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "uuid|guid|唯一标识|id 生成"
    description: 当用户需要生成 UUID 时触发
metadata:
  openclaw:
    emoji: "🆔"
    requires:
      bins: []
    install:
      - id: npm
        kind: npm
        package: uuid
        bins: ["uuid"]
        label: "Install uuid CLI (npm)"
---

# UUID Generator

生成符合 RFC 4122 的 UUID。脚本内置 v4（随机）与 v7（时间戳前缀 + 随机尾）实现，
无需 `uuid` npm 包；但 frontmatter 中的 `openclaw.install` 字段声明了 npm 安装方式，
便于用户在需要 CLI 工具时通过 `npm install -g uuid` 获取。

## Instructions

1. 读取 `params.operation`，可选值：`v4`、`v7`、`parse`、`batch`
2. `v4`：生成单个 UUID v4
3. `v7`：生成单个 UUID v7（毫秒时间戳 + 随机尾）
4. `batch`：批量生成（`count` 个 v4，默认 5，上限 100）
5. `parse`：解析 UUID 版本与变体（需传 `params.uuid`）
6. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function randomUint32() {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  }
  return Math.floor(Math.random() * 0x100000000);
}

function hex(n, len) {
  return n.toString(16).padStart(len, "0");
}

function uuidV4() {
  // RFC 4122 §4.4 / §4.1 — 设置 version=4, variant=10xx
  const r1 = randomUint32();
  const r2 = randomUint32();
  const r3 = randomUint32();
  const r4 = randomUint32();
  // 时间戳低位与版本位
  const timeLow = ((r2 & 0xffff0000) >>> 0) | 0;
  const timeMid = (r2 & 0x0000ffff) | 0;
  // 版本 4：高 4 位固定为 0100
  const timeHiAndVersion = ((r3 & 0x0fff) | 0x4000) >>> 0;
  // variant 10xx：高 2 位固定为 10
  const clockSeqHiRes = ((r3 & 0xc0000000) >>> 24) | 0x80;
  const clockSeqLow = (r3 & 0x00ff0000) >>> 16;
  const node = r4 >>> 0;
  return [
    hex(timeLow, 8),
    hex(timeMid, 4),
    hex(timeHiAndVersion, 4),
    hex(clockSeqHiRes, 2) + hex(clockSeqLow, 2),
    hex(node, 12),
  ].join("-");
}

function uuidV7() {
  // RFC 9562 §5.7 — 48-bit 毫秒时间戳 + 12-bit rand_a + 62-bit rand_b
  const ts = Date.now();
  const tsHigh = Math.floor(ts / 0x100000000); // 高 16 位
  const tsLow = ts & 0xffffffff; // 低 32 位
  const randA = (randomUint32() & 0x0fff) | 0x7000; // version=7
  const randBHi = ((randomUint32() & 0x3fff) | 0x8000) >>> 0; // variant=10
  const randBLo = randomUint32() >>> 0;
  return [
    hex(tsHigh, 4) + hex(tsLow, 8),
    hex((randA & 0xffff), 4),
    hex(randBHi, 4),
    hex((randBLo & 0xffff0000) >>> 16, 2) + hex(randBLo & 0xffff, 2),
    hex(randomUint32(), 8) + hex(randomUint32() & 0xffff, 4),
  ].join("-");
}

function parseUuid(str) {
  const m = String(str || "").trim().toLowerCase().match(
    /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/
  );
  if (!m) return { valid: false };
  const version = parseInt(m[3][0], 16);
  const variantByte = parseInt(m[4][0], 16);
  const variant = (variantByte & 0xc) === 0x8 ? "RFC 4122"
    : (variantByte & 0xe) === 0xc ? "Microsoft"
    : (variantByte & 0xe) === 0x0 ? "NCS"
    : "Reserved";
  return { valid: true, version, variant, raw: m[0] };
}

try {
  const op = String(params.operation || "v4");
  let value;
  switch (op) {
    case "v4": value = { uuid: uuidV4() }; break;
    case "v7": value = { uuid: uuidV7(), version: 7 }; break;
    case "batch": {
      const count = Math.max(1, Math.min(100, Number(params.count) || 5));
      const uuids = [];
      for (let i = 0; i < count; i++) uuids.push(uuidV4());
      value = { count, uuids };
      break;
    }
    case "parse": {
      const parsed = parseUuid(params.uuid);
      if (!parsed.valid) throw new Error("Invalid UUID format");
      value = parsed;
      break;
    }
    default: throw new Error("Unknown operation: " + op);
  }
  _result = JSON.stringify({ success: true, operation: op, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：生成 v4 UUID**

参数：
```json
{ "operation": "v4" }
```

返回：
```json
{ "success": true, "value": { "uuid": "550e8400-e29b-41d4-a716-446655440000" } }
```

**示例 2：批量生成**

参数：
```json
{ "operation": "batch", "count": 3 }
```

返回：
```json
{ "success": true, "value": { "count": 3, "uuids": ["...", "...", "..."] } }
```

**示例 3：解析 UUID 版本**

参数：
```json
{ "operation": "parse", "uuid": "550e8400-e29b-41d4-a716-446655440000" }
```

返回：
```json
{ "success": true, "value": { "valid": true, "version": 4, "variant": "RFC 4122" } }
```
