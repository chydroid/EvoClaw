---
name: meeting-notes-and-actions
version: 1.0.0
description: "会议纪要与行动项 — 从会议转录生成结构化纪要、行动项、决策记录、责任分配。"
author: evoclaw-port
category: generation
keywords:
  - meeting
  - notes
  - action
  - agenda
  - 会议纪要
  - 行动项
  - 议程
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "会议纪要|meeting notes|会议记录|action items"
    description: 当用户生成会议纪要与行动项时触发
metadata:
  openclaw:
    emoji: "📝"
---

# Meeting Notes & Actions

Process transcripts into structured notes and action items.

## Inputs to ask for
- Source: pasted transcript/text or file path; meeting title/date; attendees and their handles.
- Output style: terse bullets vs. narrative, action-item format, due date/owner tags, redaction rules if any.

## Workflow
1) Normalize text: strip timestamps/speaker labels if noisy; lightly clean filler words; keep quoted statements intact.
2) Extract essentials: agenda topics, key decisions, open questions, risks/blocked items.
3) Action items: who/what/when. Convert vague asks into concrete tasks; propose due dates if missing.
4) Produce output:
   - Header with meeting title, date, attendees.
   - Sections: `Summary`, `Decisions`, `Open Questions/Risks`, `Action Items` (checkboxes with owner + due).
5) Quality checks: ensure names are consistent; no hallucinated facts; flag ambiguities as clarifying questions.

## Optional extras
- Include timeline of major moments if timestamps exist.
- Provide short Slack/Email-ready blurb (2–3 sentences) plus the full notes.
