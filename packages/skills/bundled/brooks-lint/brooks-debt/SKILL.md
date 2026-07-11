---
name: brooks-debt
version: 1.4.0
description: >
  Tech debt assessment that identifies, classifies, and prioritizes maintainability
  problems — helping teams build a refactoring roadmap — drawing on twelve classic
  engineering books.
  Triggers when: user asks about tech debt, refactoring priorities, what to clean up
  first, or asks "why is this so hard to change?", "what should we fix first?", or
  "how do I justify refactoring to management?".
  Do NOT trigger for: server health checks, HTTP /health endpoints, Kubernetes probes,
  database health, or application uptime — "health" in those contexts is infrastructure,
  not code quality. Also not for single-function refactoring questions.
author: hyhmrright
category: analysis
keywords:
  - tech-debt
  - refactoring
  - maintainability
  - 技术债务
  - 重构优先级
  - 可维护性
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "技术债务|tech debt|重构优先级|refactor priority|可维护性"
    description: 评估技术债务时触发
  - type: intent
    pattern: "what to fix first|清理代码|refactoring roadmap"
    description: 制定重构路线图时触发
metadata:
  openclaw:
    emoji: "💳"
---
# Brooks-Lint — Tech Debt Assessment
## Setup
1. Read `../_shared/common.md` for the Iron Law, Project Config, Report Template, and Health Score rules
2. Read `../_shared/source-coverage.md` for book-level coverage, exceptions, and tradeoffs
3. Read `../_shared/decay-risks.md` for symptom definitions and source attributions
4. Read `debt-guide.md` in this directory for the debt classification framework
## Process
**If the user has not described the codebase or pointed to specific areas:** apply Auto
Scope Detection from `../_shared/common.md` to determine the assessment scope before proceeding.
1. Scan for all six decay risks (Step 1 of the guide); list every finding before scoring
2. Apply the Pain × Spread priority formula and classify debt intent (Steps 2–3 of the guide)
3. Group findings by decay risk (Step 4 of the guide)
4. Output using the Report Template from common.md, plus the Debt Summary Table
**Mode line in report:** `Tech Debt Assessment`
