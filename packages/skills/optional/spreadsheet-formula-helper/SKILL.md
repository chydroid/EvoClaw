---
name: spreadsheet-formula-helper
version: 1.0.0
description: "表格公式助手 — 生成和解释 Excel/Google Sheets 公式，支持 VLOOKUP、数据透视、条件格式等。"
author: evoclaw-port
category: utility
keywords:
  - spreadsheet
  - formula
  - Excel
  - sheet
  - 表格
  - 公式
  - 函数
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "Excel公式|spreadsheet formula|表格公式|formula help"
    description: 当用户编写或调试表格公式时触发
metadata:
  openclaw:
    emoji: "📊"
---

# Spreadsheet Formula Helper

Produce reliable spreadsheet formulas with explanations.

## Inputs to gather
- Platform (Excel/Sheets), locale (comma vs. semicolon separators), sample data layout (headers, ranges), expected outputs, and constraints (volatile functions allowed?).
- Provide small example rows and the desired result for them.

## Workflow
1) Restate the problem with explicit ranges and sheet names; propose a minimal sample to verify.
2) Draft formula(s); when dynamic arrays are available, prefer them over copy-down formulas.
3) Explain how it works and where to place it; include named ranges if helpful.
4) Edge cases: blank rows, mixed types, timezone/date quirks, duplicates; offer guardrails (e.g., `IFERROR`, `LET`, `LAMBDA`).
5) Variants: if porting between Excel and Sheets, provide both versions.

## Output
- Primary formula, short explanation, and a 2–3 row worked example showing inputs → outputs.
- Optional: quick troubleshooting checklist for common errors.
