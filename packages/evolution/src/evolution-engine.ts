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
import type { ExperienceAnalysis } from "./experience-analyzer";

export class EvolutionEngine {
  requirementMiner: RequirementMiner;
  proposer: EvolutionProposer;
  evaluator: EvolutionEvaluator;
  hotReload: HotReloadManager;
  experienceAnalyzer: ExperienceAnalyzer;
  reinforcement: ReinforcementFeedbackSystem;
  learningJournal: LearningJournal;
  progressReporter: ProgressReporter;

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

    registry.registerService("evolutionEngine", this);

    this.subscribeToEvents();
  }

  private subscribeToEvents(): void {
    this.eventBus.subscribe(SystemEvents.TASK_FAILED, async (event) => {
      const taskData = event.data as Record<string, unknown>;
      if (taskData?.error) {
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

        await this.onTaskFailure(event.id, taskData);
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
          cycle.selectedCandidate = candidate.id;
          cycle.evaluation = evaluation;
          break;
        }
      }

      if (cycle.selectedCandidate) {
        cycle.status = "publishing";
        const candidate = cycle.candidates.find((c) => c.id === cycle.selectedCandidate);
        if (candidate) {
          await this.hotReload.publish(candidate);
          await this.eventBus.publish(
            SystemEvents.EVOLUTION_PUBLISHED,
            { cycleId: cycle.id, candidateId: candidate.id },
            "evolution-engine"
          );
        }
        cycle.status = "completed";
      } else {
        cycle.status = "rejected";
      }
    } catch (err) {
      cycle.status = "failed";
      console.error("[EvolutionEngine] Cycle failed:", err);
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
        console.warn("[EvolutionEngine] Experience analysis failed:", analyzeErr);
      }
    }

    try {
      await this.reinforcement.processFeedback(fullFeedback);
    } catch (reinforceErr) {
      console.warn("[EvolutionEngine] Reinforcement feedback processing failed:", reinforceErr);
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
    const recentFailures = this.feedbackStore.filter(
      (f) => f.errorRate > 0.5
    );

    if (recentFailures.length >= 3) {
      await this.startEvolutionCycle("task_failure", {
        traceId,
        failedTask: taskData,
        recentFailures,
      });
    }
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

  async healthCheck(): Promise<boolean> {
    return true;
  }
}