---
name: hash-computer
version: 1.0.0
description: "哈希计算器 — 计算 MD5/SHA1/SHA256/SHA512，支持文件与字符串、十六进制/Base64 输出。使用 Node.js 内置 crypto，无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - hash
  - md5
  - sha1
  - sha256
  - sha512
  - 哈希
  - 摘要
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "hash|md5|sha1|sha256|sha512|哈希|摘要"
    description: 当用户需要计算哈希值时触发
metadata:
  openclaw:
    emoji: "🔑"
    requires:
      bins: []
---

# Hash Computer

计算字符串/Buffer 的密码学哈希。脚本使用 Node.js 内置 `crypto` 模块，无需任何外部依赖；
因此 frontmatter 中不声明 `openclaw.install` 字段。

## Instructions

1. 读取 `params.operation`：`hash`、`hmac`、`compare`、`algorithms`
2. `hash`：计算指定算法的哈希（`algorithm`: md5/sha1/sha256/sha512）
3. `hmac`：计算 HMAC（需 `secret`）
4. `compare`：定时安全比较两个哈希（避免时序攻击）
5. `algorithms`：列出当前 Node 支持的算法
6. 输入编码：`utf8`（默认）/`hex`/`base64`；输出编码：`hex`（默认）/`base64`/`latin1`
7. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function getAlgorithm(name) {
  const alg = String(name || "sha256").toLowerCase();
  const supported = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "ripemd160"];
  if (!supported.includes(alg)) {
    throw new Error(`Unsupported algorithm: ${alg}. Supported: ${supported.join(", ")}`);
  }
  return alg;
}

function getInputEncoding(name) {
  const enc = String(name || "utf8").toLowerCase();
  if (!["utf8", "hex", "base64", "latin1", "ascii"].includes(enc)) {
    throw new Error(`Unsupported input encoding: ${enc}`);
  }
  return enc;
}

function getOutputEncoding(name) {
  const enc = String(name || "hex").toLowerCase();
  if (!["hex", "base64", "latin1"].includes(enc)) {
    throw new Error(`Unsupported output encoding: ${enc}`);
  }
  return enc;
}

function toBuffer(input, encoding) {
  if (encoding === "utf8") return Buffer.from(String(input), "utf8");
  return Buffer.from(String(input), encoding);
}

function hash(input, algorithm, inEnc, outEnc) {
  const crypto = require("crypto");
  const h = crypto.createHash(algorithm);
  h.update(toBuffer(input, inEnc));
  return h.digest(outEnc);
}

function hmac(input, secret, algorithm, inEnc, outEnc) {
  const crypto = require("crypto");
  const h = crypto.createHmac(algorithm, toBuffer(secret, inEnc));
  h.update(toBuffer(input, inEnc));
  return h.digest(outEnc);
}

function safeEqual(a, b) {
  const crypto = require("crypto");
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function listAlgorithms() {
  const crypto = require("crypto");
  return crypto.getHashes().filter((a) =>
    ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "ripemd160"].includes(a)
  );
}

try {
  const op = String(params.operation || "hash");
  const algorithm = getAlgorithm(params.algorithm);
  const inEnc = getInputEncoding(params.inputEncoding);
  const outEnc = getOutputEncoding(params.outputEncoding);
  let value;
  switch (op) {
    case "hash":
      value = { algorithm, digest: hash(params.input, algorithm, inEnc, outEnc) };
      break;
    case "hmac":
      value = { algorithm, digest: hmac(params.input, params.secret, algorithm, inEnc, outEnc) };
      break;
    case "compare":
      value = { equal: safeEqual(params.a, params.b) };
      break;
    case "algorithms":
      value = { algorithms: listAlgorithms() };
      break;
    default: throw new Error("Unknown operation: " + op);
  }
  _result = JSON.stringify({ success: true, operation: op, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：SHA256**

参数：
```json
{ "operation": "hash", "input": "Hello, world!", "algorithm": "sha256" }
```

返回：
```json
{ "success": true, "value": { "algorithm": "sha256", "digest": "315f5bdb76d0784..." } }
```

**示例 2：HMAC-SHA256**

参数：
```json
{ "operation": "hmac", "input": "msg", "secret": "key", "algorithm": "sha256" }
```

返回：
```json
{ "success": true, "value": { "algorithm": "sha256", "digest": "2d93..." } }
```

**示例 3：定时安全比较**

参数：
```json
{ "operation": "compare", "a": "abc", "b": "abc" }
```

返回：
```json
{ "success": true, "value": { "equal": true } }
```
