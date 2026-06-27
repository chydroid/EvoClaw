---
name: calculator
version: 1.0.0
description: "数学计算器 — 支持四则运算、幂运算、三角函数、对数、统计等数学计算。无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - calculator
  - math
  - 计算
  - 数学
  - 算术
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "计算|calculator|math|算|等于"
    description: 当用户进行数学计算时触发
  - type: intent
    pattern: "求值|开方|三角函数|对数"
    description: 数学运算意图
metadata:
  openclaw:
    emoji: "🧮"
    always: false
---

# Calculator

提供基础到中级的数学计算能力。所有运算使用沙箱内 Math/Number 完成，不调用外部 API。

## Instructions

1. 解析 `params.operation` 决定运算类型：
   - `basic` — 四则运算（add/subtract/multiply/divide）
   - `power` — 幂运算（pow/sqrt/cbrt）
   - `trig` — 三角函数（sin/cos/tan/asin/acos/atan）
   - `log` — 对数（log/ln/log10/exp）
   - `stats` — 统计（sum/mean/median/min/max/variance/stddev）
   - `round` — 取整（round/floor/ceil/trunc）
   - `expr` — 表达式求值（受限解析，禁用 eval/Function）
2. 所有数值参数用 `Number()` 转换并校验 `Number.isFinite`
3. 除零、负数开偶次方等异常通过 try/catch 捕获并返回 `error` 字段
4. 通过 `_result` 返回 JSON 字符串（包含 success/value/operation）

## Scripts

```javascript
function toNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error("Invalid number: " + String(x));
  return n;
}

function basic(op, a, b) {
  const x = toNum(a), y = toNum(b);
  switch (op) {
    case "add": return x + y;
    case "subtract": return x - y;
    case "multiply": return x * y;
    case "divide":
      if (y === 0) throw new Error("Division by zero");
      return x / y;
    case "mod":
      if (y === 0) throw new Error("Modulo by zero");
      return x % y;
    default: throw new Error("Unknown basic op: " + op);
  }
}

function powerOp(op, a, b) {
  const x = toNum(a);
  switch (op) {
    case "pow": return Math.pow(x, toNum(b));
    case "sqrt":
      if (x < 0) throw new Error("sqrt of negative");
      return Math.sqrt(x);
    case "cbrt": return Math.cbrt(x);
    case "abs": return Math.abs(x);
    case "factorial": {
      const n = Math.floor(x);
      if (n < 0 || n > 170) throw new Error("factorial out of range");
      let r = 1;
      for (let i = 2; i <= n; i++) r *= i;
      return r;
    }
    default: throw new Error("Unknown power op: " + op);
  }
}

function trigOp(op, x) {
  const v = toNum(x);
  switch (op) {
    case "sin": return Math.sin(v);
    case "cos": return Math.cos(v);
    case "tan": return Math.tan(v);
    case "asin":
      if (v < -1 || v > 1) throw new Error("asin domain");
      return Math.asin(v);
    case "acos":
      if (v < -1 || v > 1) throw new Error("acos domain");
      return Math.acos(v);
    case "atan": return Math.atan(v);
    case "atan2": return Math.atan2(v, toNum(arguments[2]));
    default: throw new Error("Unknown trig op: " + op);
  }
}

function logOp(op, x) {
  const v = toNum(x);
  switch (op) {
    case "log":
      if (v <= 0) throw new Error("log of non-positive");
      return Math.log(v);
    case "ln":
      if (v <= 0) throw new Error("ln of non-positive");
      return Math.log(v);
    case "log10":
      if (v <= 0) throw new Error("log10 of non-positive");
      return Math.log10(v);
    case "log2":
      if (v <= 0) throw new Error("log2 of non-positive");
      return Math.log2(v);
    case "exp": return Math.exp(v);
    default: throw new Error("Unknown log op: " + op);
  }
}

function statsOp(op, arr) {
  if (!Array.isArray(arr)) throw new Error("stats requires array");
  const xs = arr.map(toNum);
  if (xs.length === 0) throw new Error("empty array");
  switch (op) {
    case "sum": return xs.reduce((a, b) => a + b, 0);
    case "mean":
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    case "median": {
      const s = xs.slice().sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
    case "min": return Math.min.apply(null, xs);
    case "max": return Math.max.apply(null, xs);
    case "range": return Math.max.apply(null, xs) - Math.min.apply(null, xs);
    case "variance": {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return xs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / xs.length;
    }
    case "stddev": {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const variance = xs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / xs.length;
      return Math.sqrt(variance);
    }
    default: throw new Error("Unknown stats op: " + op);
  }
}

function roundOp(op, x, digits) {
  const v = toNum(x);
  const d = Number.isFinite(Number(digits)) ? Math.max(0, Math.min(15, Math.floor(Number(digits)))) : 0;
  const p = Math.pow(10, d);
  switch (op) {
    case "round": return Math.round(v * p) / p;
    case "floor": return Math.floor(v * p) / p;
    case "ceil": return Math.ceil(v * p) / p;
    case "trunc": return Math.trunc(v * p) / p;
    default: throw new Error("Unknown round op: " + op);
  }
}

// 表达式求值：在沙箱中受限制，仅支持递归下降解析算术表达式
// 支持运算符：+ - * / % ( ) 与 Math.* 函数调用
function safeExpr(input) {
  if (typeof input !== "string") throw new Error("expr must be string");
  const expr = input.trim();
  if (expr.length === 0 || expr.length > 200) throw new Error("expr length invalid");
  if (/[;{}\[\]]|=>|function|new |require|process|eval|while|for/.test(expr)) {
    throw new Error("dangerous token in expr");
  }
  let pos = 0;
  function peek() { return expr[pos]; }
  function next() { return expr[pos++]; }
  function skipWs() { while (pos < expr.length && /\s/.test(expr[pos])) pos++; }
  function parseNumber() {
    let s = "";
    while (pos < expr.length && /[0-9.]/.test(expr[pos])) { s += expr[pos++]; }
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error("bad number: " + s);
    return n;
  }
  function parseIdent() {
    let s = "";
    while (pos < expr.length && /[a-zA-Z0-9_.]/.test(expr[pos])) { s += expr[pos++]; }
    return s;
  }
  function parseAtom() {
    skipWs();
    const c = peek();
    if (c === "(") {
      next(); skipWs();
      const v = parseExpr(); skipWs();
      if (next() !== ")") throw new Error("missing )");
      return v;
    }
    if (c >= "0" && c <= "9") return parseNumber();
    if (/[a-zA-Z]/.test(c)) {
      const name = parseIdent();
      skipWs();
      if (peek() === "(") {
        next(); skipWs();
        const args = [];
        if (peek() !== ")") {
          args.push(parseExpr());
          skipWs();
          while (peek() === ",") { next(); skipWs(); args.push(parseExpr()); skipWs(); }
        }
        if (next() !== ")") throw new Error("missing ) in call");
        if (name.indexOf("Math.") === 0) {
          const fn = Math[name.slice(5)];
          if (typeof fn !== "function") throw new Error("unknown Math method: " + name);
          return fn.apply(null, args);
        }
        throw new Error("only Math.* functions allowed, got: " + name);
      }
      throw new Error("bare identifier not allowed: " + name);
    }
    throw new Error("unexpected char: " + c);
  }
  function parseUnary() {
    skipWs();
    if (peek() === "-") { next(); return -parseUnary(); }
    if (peek() === "+") { next(); return parseUnary(); }
    return parseAtom();
  }
  function parseMul() {
    let v = parseUnary(); skipWs();
    while (pos < expr.length && (peek() === "*" || peek() === "/" || peek() === "%")) {
      const op = next(); const r = parseUnary();
      if (op === "*") v = v * r;
      else if (op === "/") { if (r === 0) throw new Error("div by zero"); v = v / r; }
      else v = v % r;
      skipWs();
    }
    return v;
  }
  function parseExpr() {
    let v = parseMul(); skipWs();
    while (pos < expr.length && (peek() === "+" || peek() === "-")) {
      const op = next(); const r = parseMul();
      if (op === "+") v = v + r; else v = v - r;
      skipWs();
    }
    return v;
  }
  const result = parseExpr();
  skipWs();
  if (pos < expr.length) throw new Error("trailing chars: " + expr.slice(pos));
  return result;
}

try {
  const op = String(params.operation || "basic");
  let value;
  switch (op) {
    case "basic": value = basic(params.op || params.subop, params.a, params.b); break;
    case "power": value = powerOp(params.op || params.subop, params.a, params.b); break;
    case "trig": value = trigOp(params.op || params.subop, params.x); break;
    case "log": value = logOp(params.op || params.subop, params.x); break;
    case "stats": value = statsOp(params.op || params.subop, params.array || params.values); break;
    case "round": value = roundOp(params.op || params.subop, params.x, params.digits); break;
    case "expr": value = safeExpr(params.expr); break;
    default: throw new Error("Unknown operation: " + op);
  }
  _result = JSON.stringify({ success: true, operation: op, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：四则运算**

参数：
```json
{ "operation": "basic", "op": "add", "a": 5, "b": 3 }
```

返回：
```json
{ "success": true, "operation": "basic", "value": 8 }
```

**示例 2：统计计算**

参数：
```json
{ "operation": "stats", "op": "mean", "array": [1, 2, 3, 4, 5] }
```

返回：
```json
{ "success": true, "operation": "stats", "value": 3 }
```

**示例 3：三角函数**

参数：
```json
{ "operation": "trig", "op": "sin", "x": 1.5707963267948966 }
```

返回：
```json
{ "success": true, "operation": "trig", "value": 1 }
```
