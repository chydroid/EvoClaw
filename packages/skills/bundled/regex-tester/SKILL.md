---
name: regex-tester
version: 1.0.0
description: "正则表达式测试器 — 匹配、捕获组、替换、全局匹配、标志位测试。使用 Node.js 内置 RegExp，无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - regex
  - regexp
  - pattern
  - match
  - replace
  - 正则
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "regex|regexp|正则|pattern"
    description: 当用户需要测试正则表达式时触发
metadata:
  openclaw:
    emoji: "🔍"
    requires:
      bins: []
---

# Regex Tester

提供正则表达式测试能力。脚本使用 Node.js 内置 `RegExp` 完成所有操作，无需任何外部依赖；
因此 frontmatter 中不声明 `openclaw.install` 字段。

## Instructions

1. 读取 `params.operation`：`match`、`match_all`、`replace`、`test`、`validate`、`extract_groups`
2. `pattern`：正则字符串；`flags`：标志位（默认无）
3. `match`：返回首个匹配（含捕获组）
4. `match_all`：返回所有匹配（`g` 标志自动启用）
5. `replace`：替换匹配（`replacement` 字段）
6. `test`：布尔判断是否匹配
7. `validate`：检查正则是否合法（不抛异常）
8. `extract_groups`：抽取所有匹配的命名捕获组
9. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function buildRegex(pattern, flags) {
  const f = String(flags || "").trim();
  return new RegExp(String(pattern), f);
}

function tryCompile(pattern, flags) {
  try {
    return { ok: true, regex: buildRegex(pattern, flags) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeMatch(input, regex, wantAll) {
  if (wantAll) {
    const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
    const re = new RegExp(regex.source, flags);
    const results = [];
    let m;
    while ((m = re.exec(String(input))) !== null) {
      results.push({
        match: m[0],
        index: m.index,
        groups: m.slice(1),
        namedGroups: m.groups || {},
      });
      if (m[0] === "") re.lastIndex++; // 防止零宽匹配死循环
    }
    return results;
  }
  const m = String(input).match(regex);
  if (!m) return null;
  return {
    match: m[0],
    index: m.index ?? 0,
    groups: m.slice(1),
    namedGroups: m.groups || {},
  };
}

function doReplace(input, regex, replacement) {
  const r = typeof replacement === "function" ? replacement : String(replacement);
  return String(input).replace(regex, r);
}

try {
  const op = String(params.operation || "match");
  const pattern = params.pattern;
  const flags = params.flags;
  const input = params.input != null ? String(params.input) : "";
  let value;

  switch (op) {
    case "validate": {
      const compiled = tryCompile(pattern, flags);
      value = compiled.ok
        ? { valid: true, source: compiled.regex.source, flags: compiled.regex.flags }
        : { valid: false, error: compiled.error };
      break;
    }
    case "test": {
      const compiled = tryCompile(pattern, flags);
      if (!compiled.ok) throw new Error(compiled.error);
      value = { matches: compiled.regex.test(input) };
      break;
    }
    case "match": {
      const compiled = tryCompile(pattern, flags);
      if (!compiled.ok) throw new Error(compiled.error);
      value = { result: safeMatch(input, compiled.regex, false) };
      break;
    }
    case "match_all": {
      const compiled = tryCompile(pattern, flags);
      if (!compiled.ok) throw new Error(compiled.error);
      value = { results: safeMatch(input, compiled.regex, true) };
      break;
    }
    case "replace": {
      const compiled = tryCompile(pattern, flags);
      if (!compiled.ok) throw new Error(compiled.error);
      value = { result: doReplace(input, compiled.regex, params.replacement) };
      break;
    }
    case "extract_groups": {
      const compiled = tryCompile(pattern, flags + (String(flags || "").includes("g") ? "" : "g"));
      if (!compiled.ok) throw new Error(compiled.error);
      const matches = safeMatch(input, compiled.regex, true);
      value = {
        groups: matches.map((m) => m.namedGroups),
        count: matches.length,
      };
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

**示例 1：测试匹配**

参数：
```json
{ "operation": "test", "pattern": "^\\\\d+$", "input": "12345" }
```

返回：
```json
{ "success": true, "value": { "matches": true } }
```

**示例 2：全局匹配**

参数：
```json
{ "operation": "match_all", "pattern": "\\\\w+", "flags": "g", "input": "Hello World" }
```

返回：
```json
{ "success": true, "value": { "results": [{ "match": "Hello", "index": 0 }, { "match": "World", "index": 6 }] } }
```

**示例 3：命名捕获组**

参数：
```json
{ "operation": "extract_groups", "pattern": "(?<year>\\\\d{4})-(?<month>\\\\d{2})", "input": "2024-01 2025-02" }
```

返回：
```json
{ "success": true, "value": { "groups": [{ "year": "2024", "month": "01" }, { "year": "2025", "month": "02" }], "count": 2 } }
```
