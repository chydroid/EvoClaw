---
name: unit-converter
version: 1.0.0
description: "单位转换器 — 支持长度、重量、温度、面积、体积、速度、时间、数据存储等多种单位换算。无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - unit
  - converter
  - conversion
  - 单位
  - 换算
  - 转换
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "换算|转换|convert|unit|公里|英里|摄氏|华氏"
    description: 当用户进行单位换算时触发
metadata:
  openclaw:
    emoji: "📏"
    always: false
---

# Unit Converter

提供多种物理量单位之间的换算能力。所有换算使用本地预定义的换算因子完成。

## Instructions

1. 解析 `params.category` 选择单位类别：
   - `length` — 长度（m/km/cm/mm/mile/yard/foot/inch/nautical_mile）
   - `weight` — 重量（kg/g/mg/ton/lb/oz）
   - `temperature` — 温度（celsius/fahrenheit/kelvin）
   - `area` — 面积（m2/km2/ha/acre/ft2）
   - `volume` — 体积（l/ml/m3/gallon/quart/pint）
   - `speed` — 速度（m/s/km/h/mph/knot）
   - `time` — 时间（ms/s/min/h/day/week/month/year）
   - `data` — 数据存储（B/KB/MB/GB/TB/PB）
2. 调用对应换算函数，先转到基础单位，再从基础单位转到目标单位
3. 温度换算特殊处理（非纯比例）
4. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function toNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error("Invalid number: " + String(x));
  return n;
}

const FACTORS = {
  length: {
    base: "m",
    units: {
      mm: 0.001, cm: 0.01, m: 1, km: 1000,
      mile: 1609.344, yard: 0.9144, foot: 0.3048, inch: 0.0254,
      nautical_mile: 1852,
    },
  },
  weight: {
    base: "kg",
    units: { mg: 0.000001, g: 0.001, kg: 1, ton: 1000, lb: 0.45359237, oz: 0.028349523125 },
  },
  area: {
    base: "m2",
    units: { mm2: 0.000001, cm2: 0.0001, m2: 1, km2: 1000000, ha: 10000, acre: 4046.8564224, ft2: 0.09290304 },
  },
  volume: {
    base: "l",
    units: { ml: 0.001, l: 1, m3: 1000, gallon: 3.785411784, quart: 0.946352946, pint: 0.473176473 },
  },
  speed: {
    base: "m/s",
    units: { "m/s": 1, "km/h": 0.277777778, mph: 0.44704, knot: 0.514444444 },
  },
  time: {
    base: "s",
    units: { ms: 0.001, s: 1, min: 60, h: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 },
  },
  data: {
    base: "B",
    units: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776, PB: 1125899906842624 },
  },
};

function convertLinear(category, value, from, to) {
  const cat = FACTORS[category];
  if (!cat) throw new Error("Unknown category: " + category);
  const fromFactor = cat.units[from];
  const toFactor = cat.units[to];
  if (fromFactor == null) throw new Error("Unknown source unit: " + from);
  if (toFactor == null) throw new Error("Unknown target unit: " + to);
  const baseValue = toNum(value) * fromFactor;
  return baseValue / toFactor;
}

function convertTemperature(value, from, to) {
  const v = toNum(value);
  let celsius;
  switch (from) {
    case "celsius": case "C": celsius = v; break;
    case "fahrenheit": case "F": celsius = (v - 32) * 5 / 9; break;
    case "kelvin": case "K": celsius = v - 273.15; break;
    default: throw new Error("Unknown temperature unit: " + from);
  }
  switch (to) {
    case "celsius": case "C": return celsius;
    case "fahrenheit": case "F": return celsius * 9 / 5 + 32;
    case "kelvin": case "K": return celsius + 273.15;
    default: throw new Error("Unknown temperature unit: " + to);
  }
}

function listUnits(category) {
  if (category === "temperature") return ["celsius", "fahrenheit", "kelvin"];
  const cat = FACTORS[category];
  if (!cat) throw new Error("Unknown category: " + category);
  return Object.keys(cat.units);
}

function listCategories() {
  return Object.keys(FACTORS).concat("temperature");
}

try {
  const category = String(params.category || "length");
  let value;
  if (params.action === "list_units") {
    value = { units: listUnits(category) };
  } else if (params.action === "list_categories") {
    value = { categories: listCategories() };
  } else {
    const v = toNum(params.value);
    const from = String(params.from);
    const to = String(params.to);
    const result = category === "temperature"
      ? convertTemperature(v, from, to)
      : convertLinear(category, v, from, to);
    value = { result, from, to, input: v, category };
  }
  _result = JSON.stringify({ success: true, value });
} catch (err) {
  _result = JSON.stringify({ success: false, error: String(err && err.message || err) });
}
```

## Examples

**示例 1：长度换算**

参数：
```json
{ "category": "length", "value": 100, "from": "km", "to": "mile" }
```

返回：
```json
{ "success": true, "value": { "result": 62.137, "from": "km", "to": "mile" } }
```

**示例 2：温度换算**

参数：
```json
{ "category": "temperature", "value": 100, "from": "celsius", "to": "fahrenheit" }
```

返回：
```json
{ "success": true, "value": { "result": 212, "from": "celsius", "to": "fahrenheit" } }
```

**示例 3：数据存储换算**

参数：
```json
{ "category": "data", "value": 1073741824, "from": "B", "to": "GB" }
```

返回：
```json
{ "success": true, "value": { "result": 1, "from": "B", "to": "GB" } }
```
