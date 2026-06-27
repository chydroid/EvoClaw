---
name: text-utils
version: 1.0.0
description: "文本工具集 — 提供文本统计、大小写转换、编码解码、JSON 美化、字符串哈希等实用文本处理能力。无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - text
  - string
  - encoding
  - base64
  - 文本
  - 字符串
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "文本|字符串|base64|encode|decode|json"
    description: 当用户处理文本/字符串时触发
metadata:
  openclaw:
    emoji: "📝"
    always: false
---

# Text Utils

提供文本处理相关的实用功能。所有操作在沙箱内完成。

## Instructions

1. 解析 `params.operation` 决定执行哪种操作：
   - `stats` — 统计字符数、单词数、行数
   - `case` — 大小写转换（upper/lower/title/camel/snake/kebab）
   - `base64` — 编码/解码（encode/decode）
   - `url` — URL 编码/解码
   - `json` — JSON 美化/压缩（pretty/minify）
   - `hash` — 字符串哈希（djb2/sdbm/fnv1a）
   - `trim` — 去除空白与换行
   - `repeat` — 重复字符串
   - `reverse` — 反转字符串
   - `replace` — 字符串替换
2. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function stats(text) {
  const s = String(text);
  const lines = s.split(/\r?\n/);
  const words = s.split(/\s+/).filter(Boolean);
  return {
    chars: s.length,
    charsNoSpaces: s.replace(/\s/g, "").length,
    words: words.length,
    lines: lines.length,
    bytes: Buffer ? Buffer.byteLength(s, "utf-8") : s.length,
  };
}

function caseOp(text, mode) {
  const s = String(text);
  switch (mode) {
    case "upper": return s.toUpperCase();
    case "lower": return s.toLowerCase();
    case "title": return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
    case "camel":
      return s.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toLowerCase());
    case "snake":
      return s.replace(/([A-Z])/g, "_$1").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_/, "").toLowerCase();
    case "kebab":
      return s.replace(/([A-Z])/g, "-$1").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-/, "").toLowerCase();
    default: throw new Error("Unknown case mode: " + mode);
  }
}

function base64Op(text, mode) {
  const s = String(text);
  if (mode === "encode") {
    if (typeof Buffer !== "undefined") return Buffer.from(s, "utf-8").toString("base64");
    // 沙箱回退实现
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = Array.from(s).map((c) => c.charCodeAt(0));
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b1 = bytes[i] || 0;
      const b2 = bytes[i + 1] || 0;
      const b3 = bytes[i + 2] || 0;
      const e1 = b1 >> 2;
      const e2 = ((b1 & 3) << 4) | (b2 >> 4);
      const e3 = ((b2 & 15) << 2) | (b3 >> 6);
      const e4 = b3 & 63;
      result += chars[e1] + chars[e2];
      result += (i + 1 < bytes.length) ? chars[e3] : "=";
      result += (i + 2 < bytes.length) ? chars[e4] : "=";
    }
    return result;
  }
  if (mode === "decode") {
    if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
    throw new Error("base64 decode requires Buffer");
  }
  throw new Error("Unknown base64 mode: " + mode);
}

function urlOp(text, mode) {
  const s = String(text);
  if (mode === "encode") return encodeURIComponent(s);
  if (mode === "decode") return decodeURIComponent(s);
  throw new Error("Unknown url mode: " + mode);
}

function jsonOp(text, mode) {
  const obj = typeof text === "string" ? JSON.parse(text) : text;
  if (mode === "pretty") return JSON.stringify(obj, null, 2);
  if (mode === "minify") return JSON.stringify(obj);
  throw new Error("Unknown json mode: " + mode);
}

function hashOp(text, algo) {
  const s = String(text);
  switch (algo) {
    case "djb2": {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(16);
    }
    case "sdbm": {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (s.charCodeAt(i) + (h << 6) + (h << 16) - h) >>> 0;
      return h.toString(16);
    }
    case "fnv1a": {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16);
    }
    default: throw new Error("Unknown hash algo: " + algo);
  }
}

function trimOp(text, mode) {
  const s = String(text);
  switch (mode) {
    case "both": return s.trim();
    case "left": return s.replace(/^\s+/, "");
    case "right": return s.replace(/\s+$/, "");
    case "all": return s.replace(/\s+/g, "");
    case "lines": return s.split(/\r?\n/).map((l) => l.trim()).join("\n");
    default: throw new Error("Unknown trim mode: " + mode);
  }
}

function repeatOp(text, count) {
  const n = Math.max(0, Math.min(10000, Math.floor(Number(count) || 0)));
  return String(text).repeat(n);
}

function reverseOp(text) {
  return String(text).split("").reverse().join("");
}

function replaceOp(text, from, to, flags) {
  const f = flags || "g";
  const re = new RegExp(String(from), f);
  return String(text).replace(re, String(to));
}

try {
  const op = String(params.operation || "stats");
  let value;
  switch (op) {
    case "stats": value = stats(params.text || params.input); break;
    case "case": value = caseOp(params.text || params.input, params.mode); break;
    case "base64": value = base64Op(params.text || params.input, params.mode); break;
    case "url": value = urlOp(params.text || params.input, params.mode); break;
    case "json": value = jsonOp(params.text || params.input, params.mode || "pretty"); break;
    case "hash": value = hashOp(params.text || params.input, params.algo || "djb2"); break;
    case "trim": value = trimOp(params.text || params.input, params.mode || "both"); break;
    case "repeat": value = repeatOp(params.text || params.input, params.count || 1); break;
    case "reverse": value = reverseOp(params.text || params.input); break;
    case "replace": value = replaceOp(params.text || params.input, params.from, params.to, params.flags); break;
    default: throw new Error("Unknown operation: " + op);
  }
  _result = JSON.stringify({ success: true, operation: op, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：文本统计**

参数：
```json
{ "operation": "stats", "text": "hello world\nfoo bar" }
```

返回：
```json
{ "success": true, "value": { "chars": 20, "words": 4, "lines": 2 } }
```

**示例 2：Base64 编码**

参数：
```json
{ "operation": "base64", "mode": "encode", "text": "Hello, 世界" }
```

返回：
```json
{ "success": true, "value": "SGVsbG8sIOS4lueVjA==" }
```

**示例 3：JSON 美化**

参数：
```json
{ "operation": "json", "mode": "pretty", "text": "{\"a\":1,\"b\":[2,3]}" }
```

返回：
```json
{ "success": true, "value": "{\n  \"a\": 1,\n  \"b\": [\n    2,\n    3\n  ]\n}" }
```
