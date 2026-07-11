---
name: brooks-lint
version: 1.4.0
description: "代码质量评审工具 — 基于十二本经典工程著作，提供代码腐烂诊断、架构审计、技术债务评估、测试质量审查、健康度评分和全量扫描自动修复六种模式。当用户需要代码评审、架构审计、健康检查或代码清理时触发。AI code reviews grounded in twelve classic engineering books — decay risk diagnostics with book citations, severity labels, and six analysis modes."
author: hyhmrright
category: analysis
keywords:
  - brooks-lint
  - code-review
  - code-quality
  - architecture
  - tech-debt
  - test-quality
  - refactoring
  - code-smell
  - decay-risk
  - mythical-man-month
  - 代码评审
  - 代码质量
  - 架构审计
  - 技术债务
  - 测试质量
  - 代码坏味道
  - 代码腐烂
  - 全量扫描
  - 自动修复
  - 健康评分
  - 健康度
  - 健康检查
  - 模块依赖
  - 代码库健康
  - 审计
license: MIT
homepage: https://github.com/hyhmrright/brooks-lint
triggers:
  - type: keyword
    pattern: "brooks|code review|code smell|tech debt|architecture audit|test quality|health dashboard|decay risk|代码评审|架构审计|技术债务|测试质量|代码坏味道|全量扫描|自动修复|健康评分|健康度|模块依赖|审计"
    description: 当用户进行代码审查、架构审计、技术债务评估或测试质量审查时触发
  - type: intent
    pattern: "review this PR|audit architecture|assess debt|review tests|sweep codebase|fix findings"
    description: 代码质量诊断与改进意图
metadata:
  openclaw:
    emoji: "📚"
    always: false
---

# Brooks-Lint — AI Code Reviews Grounded in Twelve Classic Engineering Books

Consistent. Traceable. Actionable.

brooks-lint diagnoses code against six decay risk dimensions synthesized from twelve
classic engineering books, producing structured findings with book citations, severity
labels, and concrete remedies every time.

## The Iron Law

```
NEVER suggest fixes before completing risk diagnosis.
EVERY finding must follow: Symptom → Source → Consequence → Remedy.
```

## Setup

1. Read `_shared/common.md` for the Iron Law, Project Config, Report Template, and Health Score rules
2. Read `_shared/source-coverage.md` for book-level coverage, exceptions, and tradeoffs
3. Read `_shared/decay-risks.md` for production risk symptom definitions and source attributions
4. Read `_shared/test-decay-risks.md` for test risk symptom definitions

## Six Analysis Modes

brooks-lint ships six modes. Each has its own sub-skill directory with a SKILL.md and
a mode-specific guide. Read the SKILL.md of the matching mode before proceeding.

| Mode | Sub-skill | Purpose |
|------|-----------|---------|
| PR Review | `brooks-review/` | Analyze a code diff or specific files for decay risks |
| Architecture Audit | `brooks-audit/` | Map module dependencies, check layering integrity, flag structural decay |
| Tech Debt Assessment | `brooks-debt/` | Identify, classify, and prioritize maintainability problems |
| Test Quality Review | `brooks-test/` | Diagnose structural problems in an existing test suite |
| Health Dashboard | `brooks-health/` | Score a project across all four quality dimensions in a single pass |
| Full Sweep & Auto-Fix | `brooks-sweep/` | Unified analysis across all dimensions, then applies fixes in place |

## The Six Decay Risks (R1–R6)

| Code | Risk | Diagnostic Question |
|------|------|---------------------|
| R1 | Cognitive Overload | How much mental effort to understand this? |
| R2 | Change Propagation | How many unrelated things break on one change? |
| R3 | Knowledge Duplication | Is the same decision expressed in multiple places? |
| R4 | Accidental Complexity | Is the code more complex than the problem? |
| R5 | Dependency Disorder | Do dependencies flow in a consistent direction? |
| R6 | Domain Model Distortion | Does the code faithfully represent the domain? |

## The Six Test Decay Risks (T1–T6)

| Code | Risk | Diagnostic Question |
|------|------|---------------------|
| T1 | Test Obscurity | How much effort to understand what this test verifies? |
| T2 | Test Brittleness | Do tests break when you refactor without changing behavior? |
| T3 | Test Duplication | Is the same test scenario expressed in more than one place? |
| T4 | Mock Abuse | Is the test more complex than the behavior it tests? |
| T5 | Coverage Illusion | Does the test suite actually protect against failures that matter? |
| T6 | Architecture Mismatch | Does the test suite structure reflect the system's actual risk profile? |

## Reference Files

| File | When to Read |
|------|-------------|
| `_shared/common.md` | At the start of every review — Iron Law, config, report template, scoring |
| `_shared/source-coverage.md` | Before writing findings — book-level coverage, exceptions, tradeoffs |
| `_shared/decay-risks.md` | Before any production-code review or architecture/debt assessment |
| `_shared/test-decay-risks.md` | Before any test review and before the PR Review Quick Test Check |
| `_shared/remedy-guide.md` | When `--fix` is active — actionable remedy enhancement rules |
| `_shared/custom-risks-guide.md` | When `.brooks-lint.yaml` contains `custom_risks` |

## Process

1. Determine the mode from the user's request (see mode triggers in each sub-skill's SKILL.md)
2. Read the shared framework files listed in Setup
3. Read the mode-specific guide in the sub-skill directory
4. Apply Auto Scope Detection from `_shared/common.md` if no files are specified
5. Scan for each decay risk in the order specified by the mode guide
6. Apply the Iron Law to every finding: Symptom → Source → Consequence → Remedy
7. Output using the Report Template from `_shared/common.md`
