import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type EvolutionCycle,
  type ReinforcementFeedback,
  type LearningEntry,
  type LearningSession,
  type LearningTrigger,
  type LearningCategory,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import { RequirementMiner } from "./requirement-miner";
import { EvolutionProposer } from "./evolution-proposer";
import { EvolutionEvaluator } from "./evolution-evaluator";
import { HotReloadManager } from "./hot-reload-manager";
import { ExperienceAnalyzer } from "./experience-analyzer";
import { ReinforcementFeedbackSystem } from "./reinforcement-feedback";
import { LearningJournal } from "./learning-journal";
import { ProgressReporter } from "./progress-reporter";
import { ConstraintGate } from "./constraint-gate";
import { ExternalReflector } from "./external-reflector";
import type { ExecutionTrace } from "./external-reflector";
import { LLMReflector } from "./llm-reflector";
import { EvolutionThreshold, type EvolutionThresholdConfig } from "./evolution-threshold";
import { SandboxExecutor } from "./sandbox-executor";
import { GeneticEvolutionEngine, type FitnessScore } from "./genetic-engine";
import { ExperienceDistiller } from "./experience-distiller";
import type { ExperienceAnalysis } from "./experience-analyzer";
import type { SkillExecutionResult } from "@evoclaw/core";

export class EvolutionEngine {
  requirementMiner: RequirementMiner;
  proposer: EvolutionProposer;
  evaluator: EvolutionEvaluator;
  hotReload: HotReloadManager;
  experienceAnalyzer: ExperienceAnalyzer;
  reinforcement: ReinforcementFeedbackSystem;
  learningJournal: LearningJournal;
  progressReporter: ProgressReporter;
  private constraintGate: ConstraintGate;
  private externalReflector: ExternalReflector;
  private llmReflector: LLMReflector;
  private evolutionThreshold: EvolutionThreshold;
  private sandboxExecutor: SandboxExecutor;
  private geneticEngine: GeneticEvolutionEngine;
  private experienceDistiller: ExperienceDistiller;
  private skillAutoGenerator: import("./skill-auto-generator").SkillAutoGenerator | null = null;
  private evolutionABTest: import("./evolution-ab-test").EvolutionABTest | null = null;

  private cycles = new Map<string, EvolutionCycle>();
  private feedbackStore: ReinforcementFeedback[] = [];
  private maxFeedbackStoreEntries = 500;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.requirementMiner = new RequirementMiner(registry, eventBus);
    this.proposer = new EvolutionProposer(registry, eventBus);
    this.evaluator = new EvolutionEvaluator(registry, eventBus);
    this.hotReload = new HotReloadManager(registry, eventBus);
    this.experienceAnalyzer = new ExperienceAnalyzer(registry, eventBus);
    this.reinforcement = new ReinforcementFeedbackSystem(registry, eventBus);
    this.learningJournal = new LearningJournal(registry, eventBus);
    this.progressReporter = new ProgressReporter(registry, eventBus);
    this.constraintGate = new ConstraintGate();
    this.externalReflector = new ExternalReflector(registry, eventBus);
    this.llmReflector = new LLMReflector(registry, eventBus);
    this.evolutionThreshold = new EvolutionThreshold();
    this.sandboxExecutor = new SandboxExecutor(registry, eventBus);
    this.geneticEngine = new GeneticEvolutionEngine(registry, eventBus);
    this.experienceDistiller = new ExperienceDistiller(registry, eventBus);

    try {
      const { SkillAutoGenerator } = require("./skill-auto-generator");
      this.skillAutoGenerator = new SkillAutoGenerator();
    } catch {}
    try {
      const { EvolutionABTest } = require("./evolution-ab-test");
      this.evolutionABTest = new EvolutionABTest();
    } catch {}

    registry.registerService("evolutionEngine", this);

    this.subscribeToEvents();
  }

  private subscribeToEvents(): void {
    this.eventBus.subscribe(SystemEvents.TASK_FAILED, async (event) => {
      const taskData = event.data as Record<string, unknown>;
      if (taskData?.error) {
        const skillId = taskData.skillId ? String(taskData.skillId) : null;
        const source = String(taskData.source || "task-executor");

        // 记录失败到进化门槛
        this.evolutionThreshold.recordFailure(skillId, source);

        const session = this.learningJournal.startSession(
          String(taskData.taskId || uuid()),
          String(taskData.description || "任务执行失败")
        );

        const entry = this.learningJournal.recordLearning({
          trigger: "task_failure",
          category: "error_fix",
          title: `任务执行失败: ${String(taskData.description || taskData.error).slice(0, 80)}`,
          context: `在执行任务时发生错误`,
          error: String(taskData.error),
          rootCause: taskData.rootCause ? String(taskData.rootCause) : undefined,
          source: String(taskData.source || taskData.skillId || "task-executor"),
          tags: ["task-failure", "auto-detected"],
          metadata: { taskData },
        });

        this.learningJournal.addEntryToSession(session.id, entry);

        const similarEntries = this.learningJournal.findSimilarEntries(
          String(taskData.error),
          String(taskData.source || taskData.skillId || "")
        );

        if (similarEntries.length > 0) {
          const entryForCorrection = similarEntries[0];
          if (!entryForCorrection.resolved) {
            this.learningJournal.resolveEntry(
              entryForCorrection.id,
              "evolution-engine",
              `发现相似错误模式，自动关联: ${entry.id}`
            );
          }
        }

        this.learningJournal.completeSession(session.id, false);

        // 使用 LLM 驱动的反思分析
        const trace: ExecutionTrace = {
          taskId: String(taskData.taskId || event.id),
          skillId: taskData.skillId ? String(taskData.skillId) : undefined,
          error: taskData.error ? String(taskData.error) : undefined,
          steps: [],
          context: taskData,
        };
        const reflection = await this.llmReflector.reflect(trace);

        if (!reflection.shouldEvolve) {
          return;
        }

        // 进化门槛检查
        const currentSuccessRate = taskData.successRate !== undefined
          ? Number(taskData.successRate)
          : undefined;
        const thresholdCheck = this.evolutionThreshold.check(
          "task_failure",
          skillId,
          currentSuccessRate
        );

        if (!thresholdCheck.allowed) {
          process.stdout.write(`[EvolutionEngine] Evolution threshold blocked: ${thresholdCheck.reason}`);
          return;
        }

        this.evolutionThreshold.recordEvolution();
        await this.startEvolutionCycle("task_failure", {
          taskData,
          reflection,
          thresholdCheck,
        });
      }
    });

    this.eventBus.subscribe(SystemEvents.USER_CORRECTION_RECEIVED, async (event) => {
      const data = event.data as Record<string, unknown>;

      const session = this.learningJournal.startSession(
        String(data.taskId || uuid()),
        String(data.description || "用户纠正")
      );

      const entry = this.learningJournal.recordLearning({
        trigger: "user_correction",
        category: "correction",
        title: `用户纠正: ${String(data.title || data.context || "").slice(0, 80)}`,
        context: String(data.context || "用户提供了纠正"),
        error: data.originalError ? String(data.originalError) : undefined,
        correction: data.correction ? String(data.correction) : undefined,
        solution: data.preferredApproach ? String(data.preferredApproach) : undefined,
        source: String(data.source || "user-interaction"),
        tags: ["user-correction", ...(Array.isArray(data.tags) ? data.tags as string[] : [])],
        metadata: { userData: data },
      });

      this.learningJournal.addEntryToSession(session.id, entry);
      this.learningJournal.completeSession(session.id, true);

      if (data.triggerEvolution !== false) {
        // 用户反馈直接允许进化（用户主动触发）
        this.evolutionThreshold.recordEvolution();
        await this.startEvolutionCycle("user_feedback", {
          correctionEvent: data,
          description: data.description || data.context,
        });
      }
    });

    this.eventBus.subscribe(SystemEvents.CAPABILITY_GAP_DETECTED, async (event) => {
      const data = event.data as Record<string, unknown>;

      const existingGaps = this.learningJournal.getEntries({
        trigger: "capability_gap",
        resolved: false,
      });

      const isDuplicate = existingGaps.some(
        (e) => e.title.includes(String(data.capability || "").slice(0, 30))
      );

      if (!isDuplicate) {
        const session = this.learningJournal.startSession(
          String(data.taskId || uuid()),
          String(data.description || "能力缺口检测")
        );

        const entry = this.learningJournal.recordLearning({
          trigger: "capability_gap",
          category: "new_capability_needed",
          title: `缺少能力: ${String(data.capability || data.title || "").slice(0, 80)}`,
          context: String(data.context || "用户请求了当前系统不具备的能力"),
          solution: data.suggestedSolution ? String(data.suggestedSolution) : undefined,
          source: String(data.source || "capability-detector"),
          tags: ["capability-gap", "feature-request", ...(Array.isArray(data.tags) ? data.tags as string[] : [])],
          metadata: { capabilityData: data },
        });

        this.learningJournal.addEntryToSession(session.id, entry);
        this.learningJournal.completeSession(session.id, true);

        if (data.triggerEvolution !== false) {
          const thresholdCheck = this.evolutionThreshold.check("usage_pattern", null);
          if (!thresholdCheck.allowed) {
            process.stdout.write(`[EvolutionEngine] Evolution threshold blocked (capability gap): ${thresholdCheck.reason}`);
            return;
          }
          this.evolutionThreshold.recordEvolution();
          await this.startEvolutionCycle("usage_pattern", {
            capabilityGap: data,
            gapDescription: data.description || data.context,
          });
        }
      }
    });

    this.eventBus.subscribe(SystemEvents.EXTERNAL_FAILURE_DETECTED, async (event) => {
      const data = event.data as Record<string, unknown>;

      const session = this.learningJournal.startSession(
        String(data.taskId || uuid()),
        String(data.description || "外部依赖失败")
      );

      const entry = this.learningJournal.recordLearning({
        trigger: "api_failure",
        category: "external_dependency",
        title: `外部依赖失败: ${String(data.service || data.endpoint || "").slice(0, 80)}`,
        context: String(data.context || "调用外部服务或API时发生错误"),
        error: data.error ? String(data.error) : undefined,
        rootCause: data.rootCause ? String(data.rootCause) : undefined,
        solution: data.fallback ? String(data.fallback) : "考虑添加降级策略或备用方案",
        codeSnippet: data.fallbackCode ? String(data.fallbackCode) : undefined,
        source: String(data.source || data.service || "external-dependency"),
        severity: data.severity as "critical" | "high" | "medium" | "low" | "info" | undefined,
        tags: ["api-failure", "external-dependency", ...(Array.isArray(data.tags) ? data.tags as string[] : [])],
        metadata: { externalData: data },
      });

      this.learningJournal.addEntryToSession(session.id, entry);

      if (data.solution || data.fallback) {
        this.learningJournal.resolveEntry(
          entry.id,
          "evolution-engine",
          String(data.solution || data.fallback || "已提供降级方案")
        );
      }

      this.learningJournal.completeSession(session.id, !!data.solution);

      if (data.triggerEvolution !== false) {
        const thresholdCheck = this.evolutionThreshold.check("performance_degradation", null);
        if (!thresholdCheck.allowed) {
          process.stdout.write(`[EvolutionEngine] Evolution threshold blocked (external failure): ${thresholdCheck.reason}`);
          return;
        }
        this.evolutionThreshold.recordEvolution();
        await this.startEvolutionCycle("performance_degradation", {
          externalFailure: data,
          errorInfo: data.error,
        });
      }
    });

    this.eventBus.subscribe(SystemEvents.KNOWLEDGE_IMPROVEMENT_FOUND, async (event) => {
      const data = event.data as Record<string, unknown>;

      const session = this.learningJournal.startSession(
        String(data.taskId || uuid()),
        String(data.description || "知识改进发现")
      );

      const entry = this.learningJournal.recordLearning({
        trigger: data.isOutdated ? "knowledge_outdated" : "pattern_improvement",
        category: data.isOutdated ? "knowledge_update" : "better_approach",
        title: `${data.isOutdated ? "知识过时" : "更优方法"}: ${String(data.title || data.description || "").slice(0, 80)}`,
        context: String(data.context || "发现了更好的实现方式或知识需要更新"),
        correction: data.newApproach ? String(data.newApproach) : undefined,
        solution: data.recommendedAction ? String(data.recommendedAction) : undefined,
        codeSnippet: data.improvedCode ? String(data.improvedCode) : undefined,
        source: String(data.source || "knowledge-scanner"),
        tags: [data.isOutdated ? "outdated-knowledge" : "better-approach", "improvement", ...(Array.isArray(data.tags) ? data.tags as string[] : [])],
        metadata: { knowledgeData: data },
      });

      this.learningJournal.addEntryToSession(session.id, entry);

      if (data.solution || data.recommendedAction) {
        this.learningJournal.resolveEntry(
          entry.id,
          "evolution-engine",
          String(data.solution || data.recommendedAction || "已记录改进方案")
        );
      }

      this.learningJournal.completeSession(session.id, true);

      if (data.triggerEvolution !== false) {
        const thresholdCheck = this.evolutionThreshold.check("manual", null);
        if (!thresholdCheck.allowed) {
          process.stdout.write(`[EvolutionEngine] Evolution threshold blocked (knowledge improvement): ${thresholdCheck.reason}`);
          return;
        }
        this.evolutionThreshold.recordEvolution();
        await this.startEvolutionCycle("manual", {
          improvement: data,
          description: data.description || data.context,
        });
      }
    });
  }

  async startEvolutionCycle(
    source: "task_failure" | "user_feedback" | "usage_pattern" | "performance_degradation" | "manual",
    input: Record<string, unknown>
  ): Promise<EvolutionCycle> {
    const cycle: EvolutionCycle = {
      id: uuid(),
      status: "mining",
      source,
      targetSkill: null,
      input: {
        triggerEvent: source,
        context: input,
        failureLogs: [],
        successRate: 0,
        relatedSkills: [],
      },
      candidates: [],
      selectedCandidate: null,
      evaluation: null,
      feedback: null,
      startedAt: new Date(),
      completedAt: null,
    };

    this.cycles.set(cycle.id, cycle);
    await this.eventBus.publish(SystemEvents.EVOLUTION_STARTED, cycle, "evolution-engine");

    await this.runEvolutionPipeline(cycle);

    return cycle;
  }

  private async runEvolutionPipeline(cycle: EvolutionCycle): Promise<void> {
    try {
      cycle.status = "analyzing";
      const analyzed = await this.requirementMiner.analyze(cycle.input);

      const recentFailures = this.feedbackStore
        .filter((f) => f.errorRate > 0.3)
        .slice(-10)
        .map((f) => ({
          skillId: f.skillId,
          skillName: f.skillId,
          error: `Success rate: ${Math.round((1 - f.errorRate) * 100)}%`,
          context: { feedback: f },
        }));

      let experienceAnalysis: ExperienceAnalysis | null = null;
      if (recentFailures.length > 0) {
        experienceAnalysis = await this.experienceAnalyzer.analyzeFailures(
          recentFailures
        );

        if (experienceAnalysis.recommendations.length > 0) {
          await this.eventBus.publish(
            "evolution.experience_insights",
            { cycleId: cycle.id, recommendations: experienceAnalysis.recommendations },
            "evolution-engine"
          );
        }
      }

      cycle.status = "generating";
      const candidates = await this.proposer.generate(analyzed);

      for (const candidate of candidates) {
        cycle.candidates.push(candidate);
        await this.eventBus.publish(
          SystemEvents.EVOLUTION_CANDIDATE_GENERATED,
          { cycleId: cycle.id, candidate },
          "evolution-engine"
        );
      }

      cycle.status = "evaluating";
      for (const candidate of candidates) {
        const evaluation = await this.evaluator.evaluate(candidate);
        if (evaluation.passed) {
          const gateResult = await this.constraintGate.validate(candidate);
          if (!gateResult.passed) {
            const failedGates = gateResult.results
              .filter((r) => !r.passed)
              .map((r) => `${r.gateName}: ${r.reason}`)
              .join("; ");
            process.stderr.write(`[EvolutionEngine] Candidate ${candidate.id} failed constraint gate: ${failedGates}`);
            await this.eventBus.publish(
              "evolution.constraint_gate_failed" as any,
              { cycleId: cycle.id, candidateId: candidate.id, gateResults: gateResult.results },
              "evolution-engine"
            );
            continue;
          }

          cycle.selectedCandidate = candidate.id;
          cycle.evaluation = evaluation;
          break;
        }
      }

      if (cycle.selectedCandidate) {
        cycle.status = "publishing";
        const candidate = cycle.candidates.find((c) => c.id === cycle.selectedCandidate);
        if (candidate) {
          // 沙箱执行验证：在实际环境中运行候选代码
          const sandboxResult = await this.sandboxExecutor.execute(candidate);
          if (!sandboxResult.success) {
            // 沙箱执行失败，拒绝候选并阻断发布
            cycle.status = "rejected";
            cycle.feedback = { ...cycle.feedback, rejectionReason: `Sandbox validation failed: ${sandboxResult.error}` };
            process.stderr.write(
              `[EvolutionEngine] Evolution candidate rejected: sandbox validation failed for candidate ${candidate.id} - ${sandboxResult.error}`
            );

            // 将沙箱失败记录为反馈
            await this.recordFeedback({
              cycleId: cycle.id,
              skillId: "unknown",
              successRate: sandboxResult.testResults.length > 0
                ? sandboxResult.testResults.filter((t) => t.passed).length / sandboxResult.testResults.length
                : 0,
              userAdoptionRate: 0,
              tokenConsumption: 0,
              errorRate: sandboxResult.testResults.length > 0
                ? sandboxResult.testResults.filter((t) => !t.passed).length / sandboxResult.testResults.length
                : 1,
            });

            // 将沙箱失败轨迹加入经验蒸馏器
            const sandboxReflection = await this.llmReflector.reflect(sandboxResult.executionTrace);
            this.experienceDistiller.addTrajectory(
              sandboxResult.executionTrace,
              sandboxReflection
            ).catch(() => {});

            return;
          }

          // 沙箱执行成功，记录轨迹供经验蒸馏
          const successTrace = sandboxResult.executionTrace;
          this.experienceDistiller.addTrajectory(
            successTrace,
            {
              rootCause: "Sandbox execution successful",
              failureCategory: "unknown",
              suggestedImprovements: [],
              confidenceScore: 1.0,
              shouldEvolve: false,
            }
          ).catch(() => {});

          // 仅当沙箱验证通过时才发布
          await this.hotReload.publish(candidate);
          await this.eventBus.publish(
            SystemEvents.EVOLUTION_PUBLISHED,
            { cycleId: cycle.id, candidateId: candidate.id },
            "evolution-engine"
          );

          // Auto-generate skill from successful evolution
          if (this.skillAutoGenerator) {
            try {
              const skillResult = await this.skillAutoGenerator.generateFromEvolution({
                trigger: cycle.source,
                solution: candidate.proposedChanges.description || "",
                beforeCode: "",
                afterCode: candidate.codeArtifacts.map((a) => a.source).join("\n") || "",
              });
              if (skillResult) {
                process.stdout.write(`[EvolutionEngine] Auto-generated skill: ${skillResult.skillName} at ${skillResult.skillPath}`);
              }
            } catch (err) {
              process.stderr.write(`[EvolutionEngine] Skill auto-generation failed: ${err}`);
            }
          }

          // Start A/B test for the evolution
          if (this.evolutionABTest) {
            try {
              const testId = this.evolutionABTest.startTest(
                cycle.id,
                "original",
                "evolved"
              );
              process.stdout.write(`[EvolutionEngine] A/B test started: ${testId} for evolution ${cycle.id}`);
            } catch (err) {
              process.stderr.write(`[EvolutionEngine] A/B test start failed: ${err}`);
            }
          }

          await this.curateFromEvolutionCandidate(candidate, cycle);
        }
        cycle.status = "completed";
      } else {
        // 无候选方案通过评估，尝试遗传算法优化
        if (cycle.candidates.length > 0) {
          process.stdout.write(`[EvolutionEngine] No candidates passed evaluation, attempting genetic optimization...`);
          const geneticResult = await this.geneticEngine.tryGeneticOptimization(cycle.candidates);
          if (geneticResult && geneticResult.bestCandidate) {
            cycle.candidates.push(geneticResult.bestCandidate);
            const evalResult = await this.evaluator.evaluate(geneticResult.bestCandidate);
            if (evalResult.passed) {
              const gateResult = await this.constraintGate.validate(geneticResult.bestCandidate);
              if (gateResult.passed) {
                cycle.selectedCandidate = geneticResult.bestCandidate.id;
                cycle.evaluation = evalResult;
                cycle.status = "publishing";

                const sandboxResult = await this.sandboxExecutor.execute(geneticResult.bestCandidate);
                if (!sandboxResult.success) {
                  process.stderr.write(
                    `[EvolutionEngine] Genetic candidate sandbox failed: ${sandboxResult.error}`
                  );
                  // 沙箱执行失败，拒绝候选并阻断发布
                  cycle.status = "rejected";
                  cycle.feedback = { ...cycle.feedback, rejectionReason: `Sandbox validation failed (genetic): ${sandboxResult.error}` };
                  process.stderr.write(
                    `[EvolutionEngine] Evolution candidate rejected: sandbox validation failed for genetic candidate - ${sandboxResult.error}`
                  );

                  // 将遗传优化的沙箱失败轨迹加入经验蒸馏器
                  const sandboxReflection = await this.llmReflector.reflect(sandboxResult.executionTrace);
                  this.experienceDistiller.addTrajectory(
                    sandboxResult.executionTrace,
                    sandboxReflection
                  ).catch(() => {});

                  return;
                }

                this.experienceDistiller.addTrajectory(
                  sandboxResult.executionTrace,
                  {
                    rootCause: "Genetic optimization sandbox successful",
                    failureCategory: "unknown",
                    suggestedImprovements: [],
                    confidenceScore: 1.0,
                    shouldEvolve: false,
                  }
                ).catch(() => {});

                // 仅当沙箱验证通过时才发布
                await this.hotReload.publish(geneticResult.bestCandidate);
                await this.eventBus.publish(
                  SystemEvents.EVOLUTION_PUBLISHED,
                  { cycleId: cycle.id, candidateId: geneticResult.bestCandidate.id, source: "genetic" },
                  "evolution-engine"
                );

                // Auto-generate skill from successful genetic evolution
                if (this.skillAutoGenerator) {
                  try {
                    const skillResult = await this.skillAutoGenerator.generateFromEvolution({
                      trigger: cycle.source,
                      solution: geneticResult.bestCandidate.proposedChanges.description || "",
                      beforeCode: "",
                      afterCode: geneticResult.bestCandidate.codeArtifacts.map((a) => a.source).join("\n") || "",
                    });
                    if (skillResult) {
                      process.stdout.write(`[EvolutionEngine] Auto-generated skill (genetic): ${skillResult.skillName} at ${skillResult.skillPath}`);
                    }
                  } catch (err) {
                    process.stderr.write(`[EvolutionEngine] Skill auto-generation failed (genetic): ${err}`);
                  }
                }

                // Start A/B test for the genetic evolution
                if (this.evolutionABTest) {
                  try {
                    const testId = this.evolutionABTest.startTest(
                      cycle.id,
                      "original",
                      "evolved"
                    );
                    process.stdout.write(`[EvolutionEngine] A/B test started (genetic): ${testId} for evolution ${cycle.id}`);
                  } catch (err) {
                    process.stderr.write(`[EvolutionEngine] A/B test start failed (genetic): ${err}`);
                  }
                }

                await this.curateFromEvolutionCandidate(geneticResult.bestCandidate, cycle);
                cycle.status = "completed";
              }
            }
          }
        }

        if (cycle.status !== "completed") {
          cycle.status = "rejected";
        }
      }
    } catch (err) {
      cycle.status = "failed";
      process.stderr.write("[EvolutionEngine] Cycle failed:" + " " + err);
    }

    cycle.completedAt = new Date();
  }

  async recordFeedback(feedback: Omit<ReinforcementFeedback, "collectedAt">): Promise<void> {
    const fullFeedback: ReinforcementFeedback = {
      ...feedback,
      collectedAt: new Date(),
    };
    this.feedbackStore.push(fullFeedback);

    if (this.feedbackStore.length > this.maxFeedbackStoreEntries) {
      this.feedbackStore = this.feedbackStore.slice(-this.maxFeedbackStoreEntries);
    }

    if (fullFeedback.errorRate > 0.3) {
      const recentFailures = [
        {
          skillId: fullFeedback.skillId,
          skillName: fullFeedback.skillId,
          error: `Error rate: ${Math.round(fullFeedback.errorRate * 100)}%, Success rate: ${Math.round(fullFeedback.successRate * 100)}%`,
          context: { feedback: fullFeedback },
        },
      ];

      try {
        await this.experienceAnalyzer.analyzeFailures(recentFailures);
      } catch (analyzeErr) {
        process.stderr.write("[EvolutionEngine] Experience analysis failed:" + " " + analyzeErr);
      }
    }

    try {
      await this.reinforcement.processFeedback(fullFeedback);
    } catch (reinforceErr) {
      process.stderr.write("[EvolutionEngine] Reinforcement feedback processing failed:" + " " + reinforceErr);
    }
  }

  async getCycleHistory(): Promise<EvolutionCycle[]> {
    return Array.from(this.cycles.values());
  }

  getFeedbackHistory(): ReinforcementFeedback[] {
    return [...this.feedbackStore];
  }

  private async onTaskFailure(
    traceId: string,
    taskData: Record<string, unknown>
  ): Promise<void> {
    const trace: ExecutionTrace = {
      taskId: String(taskData.taskId || traceId),
      skillId: taskData.skillId ? String(taskData.skillId) : undefined,
      error: taskData.error ? String(taskData.error) : undefined,
      steps: [],
      context: taskData,
    };

    const reflection = await this.externalReflector.reflect(trace);

    if (!reflection.shouldEvolve) {
      return;
    }

    const recentFailures = this.feedbackStore.filter(
      (f) => f.errorRate > 0.5
    );

    if (recentFailures.length >= 3) {
      await this.startEvolutionCycle("task_failure", {
        traceId,
        failedTask: taskData,
        recentFailures,
        reflection,
      });
    }
  }

  async analyzeFailureWithReflection(trace: ExecutionTrace): Promise<import("./external-reflector").ReflectionResult> {
    const reflection = await this.llmReflector.reflect(trace);

    await this.eventBus.publish(
      "evolution.failure_reflection" as any,
      { taskId: trace.taskId, reflection },
      "evolution-engine"
    );

    return reflection;
  }

  /** 获取进化门槛状态 */
  getEvolutionThreshold(): EvolutionThreshold {
    return this.evolutionThreshold;
  }

  /** 配置进化门槛 */
  configureEvolutionThreshold(config: Partial<EvolutionThresholdConfig>): void {
    this.evolutionThreshold.configure(config);
  }

  /** 获取 LLM 反思器 */
  getLLMReflector(): LLMReflector {
    return this.llmReflector;
  }

  /** 获取经验蒸馏器 */
  getExperienceDistiller(): ExperienceDistiller {
    return this.experienceDistiller;
  }

  async triggerManualEvolution(
    targetSkill: string | null,
    description: string,
    source: "task_failure" | "user_feedback" | "usage_pattern" | "performance_degradation" | "manual" = "manual"
  ): Promise<EvolutionCycle> {
    return this.startEvolutionCycle(source, {
      targetSkill,
      description,
      triggerReason: "user_triggered",
    });
  }

  async triggerSkillEvolution(skillId: string, skillName: string, errorInfo?: string): Promise<EvolutionCycle> {
    const input: Record<string, unknown> = {
      targetSkill: skillId,
      skillName,
      description: `针对技能 "${skillName}" 的进化优化`,
    };

    if (errorInfo) {
      input.failureLogs = [errorInfo];
      input.successRate = 0;
      input.relatedSkills = [skillName];
    } else {
      input.successRate = 0.5;
      input.relatedSkills = [skillName];
    }

    return this.startEvolutionCycle("usage_pattern", input);
  }

  async submitUserFeedback(
    cycleId: string,
    adopted: boolean,
    comment?: string
  ): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) return;

    const feedback: Omit<ReinforcementFeedback, "collectedAt"> = {
      cycleId,
      skillId: cycle.targetSkill || "unknown",
      successRate: adopted ? 1.0 : 0.0,
      userAdoptionRate: adopted ? 1.0 : 0.0,
      tokenConsumption: 0,
      errorRate: adopted ? 0.0 : 1.0,
    };

    await this.recordFeedback(feedback);

    if (!adopted) {
      await this.curateImproveFromFeedback(cycle, comment);
    }

    if (comment) {
      this.learningJournal.recordLearning({
        trigger: "user_feedback",
        category: adopted ? "better_approach" : "correction",
        title: `用户反馈: 进化周期 ${cycleId.slice(0, 8)}`,
        context: `用户${adopted ? "采纳" : "拒绝"}了进化建议`,
        correction: adopted ? undefined : comment,
        solution: adopted ? comment : undefined,
        source: "user-feedback",
        tags: ["evolution-feedback", adopted ? "adopted" : "rejected"],
        metadata: { cycleId, adopted, comment },
      });
    }

    await this.eventBus.publish(
      "evolution.user_feedback" as any,
      { cycleId, adopted, comment },
      "evolution-engine"
    );
  }

  getEvolutionStats() {
    const cycles = Array.from(this.cycles.values());
    const completed = cycles.filter(c => c.status === "completed");
    const rejected = cycles.filter(c => c.status === "rejected");
    const failed = cycles.filter(c => c.status === "failed");

    return {
      totalCycles: cycles.length,
      completedCycles: completed.length,
      rejectedCycles: rejected.length,
      failedCycles: failed.length,
      successRate: cycles.length > 0 ? completed.length / cycles.length : 0,
      totalCandidates: cycles.reduce((sum, c) => sum + c.candidates.length, 0),
      averageCandidatesPerCycle: cycles.length > 0
        ? cycles.reduce((sum, c) => sum + c.candidates.length, 0) / cycles.length
        : 0,
      recentCycles: cycles.slice(-10).map(c => ({
        id: c.id,
        source: c.source,
        status: c.status,
        candidatesCount: c.candidates.length,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        duration: c.completedAt
          ? c.completedAt.getTime() - c.startedAt.getTime()
          : null,
      })),
    };
  }

  getLearningStats() {
    return this.learningJournal.getStats();
  }

  getLearningEntries(filter?: Parameters<LearningJournal["getEntries"]>[0]) {
    return this.learningJournal.getEntries(filter);
  }

  getLearningSessions() {
    return this.learningJournal.getSessions();
  }

  getActiveProgressReports() {
    return this.progressReporter.getActiveReports();
  }

  private async curateFromEvolutionCandidate(
    candidate: import("@evoclaw/core").EvolutionCandidate,
    cycle: EvolutionCycle
  ): Promise<void> {
    const skillCurator = this.registry.resolveService<{
      extractSkillFromSolution(task: string, solution: string, context: Record<string, unknown>): Promise<unknown>;
    }>("skillCurator");

    if (!skillCurator) return;

    try {
      const task = cycle.input.triggerEvent || candidate.proposedChanges.description || "evolution-candidate";
      const solution = candidate.proposedChanges.description || candidate.codeArtifacts.map((a) => a.source).join("\n") || "";
      const context: Record<string, unknown> = {
        cycleId: cycle.id,
        source: cycle.source,
        candidateType: candidate.type,
        riskLevel: candidate.risk.level,
      };

      await skillCurator.extractSkillFromSolution(task, solution, context);
    } catch (err) {
      process.stderr.write("[EvolutionEngine] SkillCurator extraction failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  private async curateImproveFromFeedback(
    cycle: EvolutionCycle,
    comment: string | undefined
  ): Promise<void> {
    const skillCurator = this.registry.resolveService<{
      improveSkill(skillId: string, executionResult: SkillExecutionResult, userFeedback: string | null): Promise<unknown>;
    }>("skillCurator");

    if (!skillCurator || !cycle.targetSkill) return;

    try {
      const executionResult: SkillExecutionResult = {
        skillId: cycle.targetSkill,
        success: false,
        output: null,
        errors: comment ? [comment] : ["用户拒绝进化建议"],
        duration: 0,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      };

      await skillCurator.improveSkill(cycle.targetSkill, executionResult, comment || null);
    } catch (err) {
      process.stderr.write("[EvolutionEngine] SkillCurator improvement failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}