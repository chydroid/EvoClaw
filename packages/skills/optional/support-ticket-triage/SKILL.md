---
name: support-ticket-triage
version: 1.0.0
description: "支持工单分诊 — 解析工单、分类、判定优先级、起草回复、添加内部备注，含 PII 脱敏提醒。"
author: evoclaw-port
category: analysis
keywords:
  - support
  - ticket
  - triage
  - customer
  - priority
  - 工单
  - 客服
  - 分类
  - 优先级
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "工单分类|ticket triage|客服工单|support ticket"
    description: 当用户对客服工单进行分诊时触发
metadata:
  openclaw:
    emoji: "🎫"
---

# Support Ticket Triage

Standardize how to classify and respond to incoming tickets.

## Inputs to gather
- Ticket text (include attachments/links), product area, customer plan/tier if known.
- Desired outputs: category taxonomy, priority levels, SLA hints, tone/brand voice, whether to draft a reply.

## Workflow
1) Parse context: identify issue type, product surface, severity, customer impact, reproduction hints, and blockers.
2) Categorize: assign category and subcategory; set priority (e.g., P0–P3) with short justification.
3) Draft response (if asked): concise acknowledgment, empathy, restate issue, next steps, and ask for missing info; include reproduction checklist when uncertain.
4) Internal notes: suspected root cause, logs to pull, teams to loop, and tracking IDs to create/attach.
5) Output: tabular or bullet summary with `Category`, `Priority`, `Summary`, `Proposed Fix/Next Steps`, `Reply Draft`.

## Quality checks
- Avoid promises; give ranges not exact ETAs unless provided.
- Mask PII if copying to public channels.
- If signal is weak, present 2–3 likely categories and what evidence would disambiguate.
