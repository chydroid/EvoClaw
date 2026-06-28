---
name: base64-codec
version: 1.0.0
description: "Base64 编码/解码器 — 支持 UTF-8 字符串、字节数组、URL-safe 变体。无外部依赖（使用 Node Buffer）。"
author: evoclaw-official
category: utility
keywords:
  - base64
  - encode
  - decode
  - url-safe
  - 编码
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "base64|编码|解码|encode|decode"
    description: 当用户需要 Base64 编码或解码时触发
metadata:
  openclaw:
    emoji: "🔐"
    requires:
      bins: []
    install:
      - id: brew
        kind: brew
        formula: coreutils
        bins: ["base64"]
        label: "Install coreutils (brew)"
      - id: apt
        kind: apt
        package: coreutils
        bins: ["base64"]
        label: "Install coreutils (apt)"
---

# Base64 Codec

提供 Base64 编码/解码能力。脚本使用 Node.js 内置 `Buffer` 完成所有操作，无需外部依赖；
`openclaw.install` 字段声明了 `coreutils`（提供 `base64` CLI）作为可选的 shell 兜底工具。

## Instructions

1. 读取 `params.operation`：`encode`、`decode`、`encode_urlsafe`、`decode_urlsafe`、`is_valid`
2. `encode`：UTF-8 字符串 → Base64
3. `decode`：Base64 → UTF-8 字符串
4. `encode_urlsafe` / `decode_urlsafe`：URL-safe 变体（`-_` 替换 `+/`，去除 `=` 填充）
5. `is_valid`：检查字符串是否为合法 Base64
6. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function toBase64(str, urlSafe) {
  const b = Buffer.from(String(str), "utf-8").toString("base64");
  if (!urlSafe) return b;
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(b64, urlSafe) {
  let s = String(b64).trim();
  if (urlSafe) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4 !== 0) s += "=";
  }
  return Buffer.from(s, "base64").toString("utf-8");
}

function isValidBase64(str, urlSafe) {
  const s = String(str || "").trim();
  if (!s) return false;
  const re = urlSafe ? /^[A-Za-z0-9_-]+={0,2}$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!re.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  try {
    const decoded = fromBase64(s, urlSafe);
    return toBase64(decoded, urlSafe) === s.replace(/=+$/, "") ||
           toBase64(decoded, false) === s;
  } catch {
    return false;
  }
}

try {
  const op = String(params.operation || "encode");
  const urlSafe = op === "encode_urlsafe" || op === "decode_urlsafe" || Boolean(params.urlSafe);
  let value;
  switch (op) {
    case "encode":
    case "encode_urlsafe":
      value = { base64: toBase64(params.input, urlSafe) };
      break;
    case "decode":
    case "decode_urlsafe":
      value = { decoded: fromBase64(params.input, urlSafe) };
      break;
    case "is_valid":
      value = { valid: isValidBase64(params.input, urlSafe) };
      break;
    default: throw new Error("Unknown operation: " + op);
  }
  _result = JSON.stringify({ success: true, operation: op, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：编码**

参数：
```json
{ "operation": "encode", "input": "Hello, 世界" }
```

返回：
```json
{ "success": true, "value": { "base64": "SGVsbG8sIOS4lueVjA==" } }
```

**示例 2：解码**

参数：
```json
{ "operation": "decode", "input": "SGVsbG8sIOS4lueVjA==" }
```

返回：
```json
{ "success": true, "value": { "decoded": "Hello, 世界" } }
```

**示例 3：URL-safe 变体**

参数：
```json
{ "operation": "encode_urlsafe", "input": "Hello, 世界" }
```

返回：
```json
{ "success": true, "value": { "base64": "SGVsbG8sIOS4lueVjA" } }
```
