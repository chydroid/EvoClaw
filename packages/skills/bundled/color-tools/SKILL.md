---
name: color-tools
version: 1.0.0
description: "颜色工具 — 支持 HEX/RGB/HSL 互转、颜色混合、明暗调整、对比度计算、配色生成。无外部依赖。"
author: evoclaw-official
category: utility
keywords:
  - color
  - hex
  - rgb
  - hsl
  - 颜色
  - 配色
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "颜色|color|hex|rgb|hsl|配色"
    description: 当用户处理颜色时触发
metadata:
  openclaw:
    emoji: "🎨"
    always: false
---

# Color Tools

提供颜色空间转换与颜色操作能力。所有计算使用沙箱内 Math/Number 完成。

## Instructions

1. 解析 `params.operation` 决定操作类型：
   - `convert` — HEX/RGB/HSL 互转
   - `lighten` — 颜色变亮（百分比）
   - `darken` — 颜色变暗（百分比）
   - `mix` — 混合两种颜色（比例 0-1）
   - `contrast` — 计算两个颜色的对比度（WCAG）
   - `complement` — 互补色
   - `scheme` — 生成配色方案（analogous/triadic/tetradic/monochromatic）
   - `gradient` — 生成两色之间的渐变（指定数量）
2. 通过 `_result` 返回 JSON 字符串

## Scripts

```javascript
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function hexToRgb(hex) {
  let h = String(hex).replace(/^#/, "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) throw new Error("Invalid hex: " + hex);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function parseColorAny(input) {
  if (typeof input === "object" && input !== null) {
    if ("r" in input && "g" in input && "b" in input) return input;
    if ("h" in input && "s" in input && "l" in input) return hslToRgb(input.h, input.s, input.l);
  }
  const s = String(input).trim();
  if (s.startsWith("#")) return hexToRgb(s);
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  const hm = s.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/i);
  if (hm) return hslToRgb(+hm[1], +hm[2], +hm[3]);
  throw new Error("Cannot parse color: " + s);
}

function relativeLuminance(r, g, b) {
  const ch = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(c1, c2, ratio) {
  const t = clamp(ratio, 0, 1);
  return {
    r: Math.round(c1.r * (1 - t) + c2.r * t),
    g: Math.round(c1.g * (1 - t) + c2.g * t),
    b: Math.round(c1.b * (1 - t) + c2.b * t),
  };
}

function lighten(rgb, percent) {
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.l = clamp(hsl.l + percent, 0, 100);
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

function darken(rgb, percent) {
  return lighten(rgb, -percent);
}

function complement(rgb) {
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.h = (hsl.h + 180) % 360;
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

function scheme(rgb, type) {
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const result = [];
  switch (type) {
    case "analogous":
      result.push(hslToRgb(hsl.h - 30, hsl.s, hsl.l));
      result.push(rgb);
      result.push(hslToRgb(hsl.h + 30, hsl.s, hsl.l));
      break;
    case "triadic":
      result.push(rgb);
      result.push(hslToRgb(hsl.h + 120, hsl.s, hsl.l));
      result.push(hslToRgb(hsl.h + 240, hsl.s, hsl.l));
      break;
    case "tetradic":
      result.push(rgb);
      result.push(hslToRgb(hsl.h + 90, hsl.s, hsl.l));
      result.push(hslToRgb(hsl.h + 180, hsl.s, hsl.l));
      result.push(hslToRgb(hsl.h + 270, hsl.s, hsl.l));
      break;
    case "monochromatic":
      for (let i = 0; i < 5; i++) {
        result.push(hslToRgb(hsl.h, hsl.s, clamp(hsl.l - 20 + i * 10, 0, 100)));
      }
      break;
    default: throw new Error("Unknown scheme type: " + type);
  }
  return result;
}

function gradient(c1, c2, count) {
  const n = Math.max(2, Math.min(20, Math.floor(count)));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(mix(c1, c2, i / (n - 1)));
  }
  return out;
}

function colorToObject(rgb) {
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return {
    hex: rgbToHex(rgb.r, rgb.g, rgb.b),
    rgb: { r: rgb.r, g: rgb.g, b: rgb.b },
    hsl: hsl,
  };
}

try {
  const op = String(params.operation || "convert");
  let value;
  switch (op) {
    case "convert": {
      const rgb = parseColorAny(params.color);
      value = colorToObject(rgb);
      break;
    }
    case "lighten": {
      const rgb = parseColorAny(params.color);
      const percent = Number(params.percent) || 10;
      value = colorToObject(lighten(rgb, percent));
      break;
    }
    case "darken": {
      const rgb = parseColorAny(params.color);
      const percent = Number(params.percent) || 10;
      value = colorToObject(darken(rgb, percent));
      break;
    }
    case "mix": {
      const c1 = parseColorAny(params.color1);
      const c2 = parseColorAny(params.color2);
      const ratio = Number(params.ratio != null ? params.ratio : 0.5);
      value = colorToObject(mix(c1, c2, ratio));
      break;
    }
    case "contrast": {
      const c1 = parseColorAny(params.color1);
      const c2 = parseColorAny(params.color2);
      const ratio = contrastRatio(c1, c2);
      value = { ratio: Math.round(ratio * 100) / 100, wcagAA: ratio >= 4.5, wcagAAA: ratio >= 7 };
      break;
    }
    case "complement": {
      const rgb = parseColorAny(params.color);
      value = colorToObject(complement(rgb));
      break;
    }
    case "scheme": {
      const rgb = parseColorAny(params.color);
      const type = String(params.schemeType || "analogous");
      value = scheme(rgb, type).map(colorToObject);
      break;
    }
    case "gradient": {
      const c1 = parseColorAny(params.color1);
      const c2 = parseColorAny(params.color2);
      const count = Number(params.count) || 5;
      value = gradient(c1, c2, count).map(colorToObject);
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

**示例 1：颜色转换**

参数：
```json
{ "operation": "convert", "color": "#ff5733" }
```

返回：
```json
{ "success": true, "value": { "hex": "#ff5733", "rgb": { "r": 255, "g": 87, "b": 51 }, "hsl": { "h": 11, "s": 100, "l": 60 } } }
```

**示例 2：颜色混合**

参数：
```json
{ "operation": "mix", "color1": "#ff0000", "color2": "#0000ff", "ratio": 0.5 }
```

返回：
```json
{ "success": true, "value": { "hex": "#800080", "rgb": { "r": 128, "g": 0, "b": 128 } } }
```

**示例 3：对比度**

参数：
```json
{ "operation": "contrast", "color1": "#ffffff", "color2": "#000000" }
```

返回：
```json
{ "success": true, "value": { "ratio": 21, "wcagAA": true, "wcagAAA": true } }
```
