---
name: internal-comms
version: 1.0.0
description: "内部沟通文档 — 撰写 3P 更新（进展/计划/问题）、FAQ 回答、通用内部沟通文档。"
author: evoclaw-port
category: generation
keywords:
  - communication
  - internal
  - memo
  - update
  - announcement
  - 内部沟通
  - 备忘录
  - 公告
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "内部沟通|internal comms|memo|公司公告"
    description: 当用户撰写内部沟通文档时触发
metadata:
  openclaw:
    emoji: "📢"
---

## When to use this skill
To write internal communications, use this skill for:
- 3P updates (Progress, Plans, Problems)
- Company newsletters
- FAQ responses
- Status reports
- Leadership updates
- Project updates
- Incident reports

## How to use this skill

To write any internal communication:

1. **Identify the communication type** from the request
2. **Load the appropriate guideline file** from the `examples/` directory:
    - `examples/3p-updates.md` - For Progress/Plans/Problems team updates
    - `examples/company-newsletter.md` - For company-wide newsletters
    - `examples/faq-answers.md` - For answering frequently asked questions
    - `examples/general-comms.md` - For anything else that doesn't explicitly match one of the above
3. **Follow the specific instructions** in that file for formatting, tone, and content gathering

If the communication type doesn't match any existing guideline, ask for clarification or more context about the desired format.

## Keywords
3P updates, company newsletter, company comms, weekly update, faqs, common questions, updates, internal comms
