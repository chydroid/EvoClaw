---
name: brooks-test
version: 1.4.0
description: >
  Test quality review drawing on twelve classic engineering books — with primary focus
  on xUnit Test Patterns, The Art of Unit Testing, How Google Tests Software, and
  Working Effectively with Legacy Code — that diagnoses structural problems in an
  existing test suite: brittleness, mock abuse, coverage illusions, slow execution,
  poor readability.
  Triggers when: user asks about test quality, shares test files for review, or
  expresses frustration: "tests keep breaking whenever I change anything", "our tests
  take forever", "tests pass but bugs still reach production", or "we have too many mocks".
  Do NOT trigger for: writing new tests from scratch (use the regular test-writing
  workflow) or testing framework/syntax questions — this skill reviews an existing
  suite for structural quality problems, not individual test authoring.
author: hyhmrright
category: analysis
keywords:
  - test-quality
  - test-review
  - brittleness
  - mock-abuse
  - 测试质量
  - 测试评审
  - 脆弱测试
  - mock滥用
license: MIT
homepage: https://github.com/chydroid/EvoClaw
triggers:
  - type: keyword
    pattern: "测试质量|test quality|测试评审|test review|脆弱测试"
    description: 评审测试质量时触发
  - type: intent
    pattern: "tests keep breaking|too many mocks|测试太慢"
    description: 测试结构问题时触发
metadata:
  openclaw:
    emoji: "🧪"
---
# Brooks-Lint — Test Quality Review
## Setup
1. Read `../_shared/common.md` for the Iron Law, Project Config, Report Template, and Health Score rules
2. Read `../_shared/source-coverage.md` for book-level coverage, exceptions, and tradeoffs
3. Read `../_shared/test-decay-risks.md` for test-space symptom definitions and source attributions
4. Read `test-guide.md` in this directory for the test quality review framework
## Process
**If the user has not shared test files or pointed to a test directory:** apply Auto
Scope Detection from `../_shared/common.md` to determine the review scope before proceeding.
1. Build the test suite map (guide's "Before You Start" section)
2. Scan for each test decay risk in the order specified (Steps 1–4 of the guide)
3. Apply the Iron Law and output using the Report Template (Step 5 of the guide)
**Mode line in report:** `Test Quality Review`
