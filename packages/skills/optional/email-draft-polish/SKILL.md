---
name: email-draft-polish
version: 1.0.0
description: "邮件起草与润色 — 根据要点生成专业邮件，调整语气、修正语法、优化表达。"
author: evoclaw-port
category: generation
keywords:
  - email
  - draft
  - polish
  - write
  - 邮件
  - 撰写
  - 润色
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "写邮件|email draft|polish email|邮件润色"
    description: 当用户起草或润色邮件时触发
metadata:
  openclaw:
    emoji: "✉️"
---

# Email Draft & Polish

Create or refine emails with precise tone and constraints.

## Inputs to ask for
- Goal (inform, persuade, apologize, escalate), audience, tone (warm/formal/direct), desired length, must-include points, taboo topics, and call-to-action.
- If replying: include full thread and whether to quote or paraphrase.

## Workflow
1) Outline: list the key points, questions, and CTA; confirm any missing facts.
2) Draft: write a concise body with subject line; keep paragraphs short; surface CTA early.
3) Variants: offer 2–3 tone/length variants if the ask is vague (e.g., “concise,” “detailed,” “bullet-only”).
4) QA: check for hedging vs. directness as requested, remove jargon, ensure names/links are correct, and guard against over-promising.

## Output format
- Subject line, greeting, body, closing/signature placeholder.
- Optional TL;DR (1–2 sentences) and bullet summary for chat channels.
