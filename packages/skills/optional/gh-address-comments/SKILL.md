---
name: gh-address-comments
version: 1.0.0
description: "处理 GitHub PR 上的评审评论 — 自动获取评论、澄清需求、修复问题、回复评审人。"
author: evoclaw-port
category: analysis
keywords:
  - PR
  - review
  - comment
  - GitHub
  - PR评论
  - 代码审查
  - 评审
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "PR评论|review comment|代码评审|address comment"
    description: 当用户处理 GitHub PR 评审评论时触发
metadata:
  openclaw:
    emoji: "🔍"
---

# PR Comment Handler

Guide to find the open PR for the current branch and address its comments with gh CLI. 运行 gh 命令需要网络访问权限。

Prereq: ensure `gh` is authenticated (for example, run `gh auth login` once), then run `gh auth status` (include workflow/repo scopes) so `gh` commands succeed.

## 1) Inspect comments needing attention
- Run scripts/fetch_comments.py which will print out all the comments and review threads on the PR

## 2) Ask the user for clarification
- Number all the review threads and comments and provide a short summary of what would be required to apply a fix for it
- Ask the user which numbered comments should be addressed

## 3) If user chooses comments
- Apply fixes for the selected comments

Notes:
- If gh hits auth/rate issues mid-run, prompt the user to re-authenticate with `gh auth login`, then retry.
