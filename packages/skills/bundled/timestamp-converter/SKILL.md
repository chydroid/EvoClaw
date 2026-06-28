---
name: timestamp-converter
version: 1.0.0
description: "时间戳转换器 — Unix 时间戳与 ISO8601/本地时间互转，支持时区、相对时间、人类可读格式。无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - timestamp
  - unix
  - epoch
  - iso8601
  - date
  - 时间戳
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "时间戳|timestamp|epoch|unix 时间"
    description: 当用户处理 Unix 时间戳或时间格式转换时触发
metadata:
  openclaw:
    emoji: "⏱️"
    requires:
      bins: []
    install:
      - id: brew
        kind: brew
        formula: coreutils
        bins: ["date"]
        label: "Install coreutils (brew)"
      - id: apt
        kind: apt
        package: coreutils
        bins: ["date"]
        label: "Install coreutils (apt)"
---

# Timestamp Converter

Unix 时间戳（秒/毫秒）与 ISO8601、本地时间之间的互转。脚本使用内置 `Date` 对象完成
所有计算；`openclaw.install` 字段声明了 `coreutils`（提供 `date` CLI）作为可选的外部工具，
便于用户在需要 shell 兜底时安装。

## Instructions

1. 读取 `params.operation`：
   - `to_iso` — 时间戳 → ISO8601
   - `to_unix` — ISO8601 → 时间戳
   - `to_local` — 时间戳 → 本地可读时间
   - `relative` — 计算时间戳相对当前时间的人话描述
   - `add` — 时间戳 ± 单位（seconds/minutes/hours/days）
2. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function toIso(ts, isMs) {
  const ms = isMs ? Number(ts) : Number(ts) * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) throw new Error("Invalid timestamp: " + ts);
  return d.toISOString();
}

function toUnix(iso) {
  const d = new Date(String(iso));
  if (isNaN(d.getTime())) throw new Error("Invalid ISO string: " + iso);
  return { seconds: Math.floor(d.getTime() / 1000), milliseconds: d.getTime() };
}

function toLocal(ts, isMs, tz) {
  const ms = isMs ? Number(ts) : Number(ts) * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) throw new Error("Invalid timestamp: " + ts);
  try {
    const opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
    if (tz) opts.timeZone = String(tz);
    return d.toLocaleString("zh-CN", opts);
  } catch {
    return d.toString();
  }
}

function relative(ts, isMs) {
  const ms = isMs ? Number(ts) : Number(ts) * 1000;
  const now = Date.now();
  const diff = ms - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const units = [
    { name: "year", ms: 365.25 * 24 * 3600 * 1000 },
    { name: "month", ms: 30.44 * 24 * 3600 * 1000 },
    { name: "day", ms: 24 * 3600 * 1000 },
    { name: "hour", ms: 3600 * 1000 },
    { name: "minute", ms: 60 * 1000 },
    { name: "second", ms: 1000 },
  ];
  for (const u of units) {
    const v = Math.floor(abs / u.ms);
    if (v >= 1) {
      return future ? `in ${v} ${u.name}${v > 1 ? "s" : ""}` : `${v} ${u.name}${v > 1 ? "s" : ""} ago`;
    }
  }
  return "just now";
}

function add(ts, amount, unit, isMs) {
  const ms = isMs ? Number(ts) : Number(ts) * 1000;
  const a = Number(amount);
  if (!Number.isFinite(a)) throw new Error("Invalid amount");
  const unitMs = {
    seconds: 1000, minutes: 60 * 1000, hours: 3600 * 1000, days: 24 * 3600 * 1000,
  }[String(unit)];
  if (!unitMs) throw new Error("Invalid unit (use seconds|minutes|hours|days)");
  return new Date(ms + a * unitMs).toISOString();
}

try {
  const op = String(params.operation || "to_iso");
  const isMs = Boolean(params.unit === "ms" || params.isMilliseconds);
  let value;
  switch (op) {
    case "to_iso": value = { iso: toIso(params.timestamp, isMs) }; break;
    case "to_unix": value = toUnix(params.iso); break;
    case "to_local": value = { local: toLocal(params.timestamp, isMs, params.timezone) }; break;
    case "relative": value = { human: relative(params.timestamp, isMs) }; break;
    case "add": value = { iso: add(params.timestamp, params.amount, params.unit, isMs) }; break;
    default: throw new Error("Unknown operation: " + op);
  }
  _result = JSON.stringify({ success: true, operation: op, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：时间戳 → ISO**

参数：
```json
{ "operation": "to_iso", "timestamp": 1700000000, "unit": "s" }
```

返回：
```json
{ "success": true, "value": { "iso": "2023-11-14T22:13:20.000Z" } }
```

**示例 2：相对时间**

参数：
```json
{ "operation": "relative", "timestamp": 1700000000, "unit": "s" }
```

返回：
```json
{ "success": true, "value": { "human": "..." } }
```

**示例 3：时间戳加 1 天**

参数：
```json
{ "operation": "add", "timestamp": 1700000000, "unit": "s", "amount": 1, "unit": "days" }
```

返回：
```json
{ "success": true, "value": { "iso": "2023-11-15T22:13:20.000Z" } }
```
