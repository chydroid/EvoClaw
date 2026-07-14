import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type ProgressReport,
  type LearningSession,
} from "@evoclaw/core";
import { randomUUID } from "crypto";

export interface ProgressPhase {
  name: string;
  totalSteps: number;
  description: string;
}

export class ProgressReporter {
  private static readonly MAX_REPORTS = 200;
  private static readonly MAX_TASKS = 200;

  private activeReports = new Map<string, ProgressReport[]>();
  private activeTasks = new Map<string, {
    sessionId: string;
    taskId: string;
    phases: ProgressPhase[];
    currentPhaseIndex: number;
    currentStep: number;
    startedAt: Date;
  }>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("progressReporter", this);
  }

  startTask(
    sessionId: string,
    taskId: string,
    taskDescription: string,
    phases: ProgressPhase[]
  ): string {
    const reportId = randomUUID();

    // LRU 淘汰：超过最大条目数时删除最旧的（activeTasks 与 activeReports 同步淘汰）
    if (this.activeTasks.size >= ProgressReporter.MAX_TASKS) {
      const oldestKey = this.activeTasks.keys().next().value;
      if (oldestKey) {
        this.activeTasks.delete(oldestKey);
        this.activeReports.delete(oldestKey);
      }
    }

    this.activeTasks.set(reportId, {
      sessionId,
      taskId,
      phases,
      currentPhaseIndex: 0,
      currentStep: 0,
      startedAt: new Date(),
    });

    this.activeReports.set(reportId, []);

    const totalSteps = phases.reduce((sum, p) => sum + p.totalSteps, 0);

    this.report(reportId, {
      sessionId,
      taskId,
      phase: "init",
      step: 0,
      totalSteps,
      message: `🧬 开始执行: ${taskDescription}`,
      details: `共 ${phases.length} 个阶段，${totalSteps} 个步骤`,
    });

    return reportId;
  }

  reportProgress(
    reportId: string,
    message: string,
    details?: string
  ): ProgressReport | null {
    const task = this.activeTasks.get(reportId);
    if (!task) return null;

    const phase = task.phases[task.currentPhaseIndex];
    if (!phase) return null;

    task.currentStep++;

    const totalSteps = task.phases.reduce((sum, p) => sum + p.totalSteps, 0);
    let completedSteps = 0;

    for (let i = 0; i < task.currentPhaseIndex; i++) {
      completedSteps += task.phases[i].totalSteps;
    }
    completedSteps += task.currentStep;

    const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const report = this.report(reportId, {
      sessionId: task.sessionId,
      taskId: task.taskId,
      phase: phase.name,
      step: task.currentStep,
      totalSteps,
      progress,
      message,
      details: details || null,
    });

    if (task.currentStep >= phase.totalSteps) {
      task.currentPhaseIndex++;
      task.currentStep = 0;
    }

    return report;
  }

  advancePhase(reportId: string, phaseMessage: string): ProgressReport | null {
    const task = this.activeTasks.get(reportId);
    if (!task) return null;

    // 先计算下一阶段索引并校验边界，再更新状态（与 skipPhase 保持一致）
    const nextIndex = task.currentPhaseIndex + 1;
    const nextPhase = task.phases[nextIndex];
    if (!nextPhase) return null;

    // 递增阶段索引并重置步骤计数，避免停留在当前阶段
    task.currentPhaseIndex = nextIndex;
    task.currentStep = 0;

    const totalSteps = task.phases.reduce((sum, p) => sum + p.totalSteps, 0);

    return this.report(reportId, {
      sessionId: task.sessionId,
      taskId: task.taskId,
      phase: nextPhase.name,
      step: 0,
      totalSteps,
      progress: totalSteps > 0
        ? Math.round(
            (task.phases
              .slice(0, task.currentPhaseIndex)
              .reduce((sum, p) => sum + p.totalSteps, 0) /
              totalSteps) *
              100
          )
        : 0,
      message: `📌 进入阶段: ${phaseMessage}`,
      details: nextPhase.description,
    });
  }

  completeTask(
    reportId: string,
    success: boolean,
    summary?: string
  ): ProgressReport | null {
    const task = this.activeTasks.get(reportId);
    if (!task) return null;

    const totalSteps = task.phases.reduce((sum, p) => sum + p.totalSteps, 0);
    const duration = Date.now() - task.startedAt.getTime();

    const finalReport = this.report(reportId, {
      sessionId: task.sessionId,
      taskId: task.taskId,
      phase: "complete",
      step: totalSteps,
      totalSteps,
      progress: 100,
      message: success
        ? `✅ 任务完成！${summary || ""}`
        : `❌ 任务失败。${summary || ""}`,
      details: `总用时: ${Math.round(duration / 1000)}秒，共 ${totalSteps} 个步骤`,
    });

    this.activeTasks.delete(reportId);
    this.activeReports.delete(reportId);

    return finalReport;
  }

  skipPhase(
    reportId: string,
    phaseName: string,
    reason: string
  ): ProgressReport | null {
    const task = this.activeTasks.get(reportId);
    if (!task) return null;

    const phaseIndex = task.phases.findIndex((p) => p.name === phaseName);
    if (phaseIndex < 0) return null;

    const phase = task.phases[phaseIndex];
    const totalSteps = task.phases.reduce((sum, p) => sum + p.totalSteps, 0);

    let completedSteps = 0;
    for (let i = 0; i < phaseIndex; i++) {
      completedSteps += task.phases[i].totalSteps;
    }

    const report = this.report(reportId, {
      sessionId: task.sessionId,
      taskId: task.taskId,
      phase: phaseName,
      step: phase.totalSteps,
      totalSteps,
      progress: totalSteps > 0 ? Math.round(((completedSteps + phase.totalSteps) / totalSteps) * 100) : 0,
      message: `⏭️ 跳过阶段 "${phaseName}": ${reason}`,
      details: null,
    });

    if (task.currentPhaseIndex === phaseIndex) {
      task.currentPhaseIndex++;
      task.currentStep = 0;
    }

    return report;
  }

  getReports(taskId: string): ProgressReport[] {
    for (const [, reports] of this.activeReports) {
      if (reports.length > 0 && reports[0].taskId === taskId) {
        return [...reports];
      }
    }
    return [];
  }

  getActiveReports(): ProgressReport[] {
    const all: ProgressReport[] = [];
    for (const [, reports] of this.activeReports) {
      if (reports.length > 0) {
        all.push(reports[reports.length - 1]);
      }
    }
    return all.sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
    );
  }

  private report(
    reportId: string,
    params: {
      sessionId: string;
      taskId: string;
      phase: string;
      step: number;
      totalSteps: number;
      progress?: number;
      message: string;
      details: string | null;
    }
  ): ProgressReport {
    const report: ProgressReport = {
      id: randomUUID(),
      sessionId: params.sessionId,
      taskId: params.taskId,
      phase: params.phase,
      step: params.step,
      totalSteps: params.totalSteps,
      progress: params.progress ?? 0,
      message: params.message,
      details: params.details,
      status: params.phase === "complete" ? "completed" : "running",
      startedAt: new Date(),
      completedAt: params.phase === "complete" ? new Date() : null,
      durationMs: null,
    };

    this.eventBus.publish(
      SystemEvents.PROGRESS_REPORTED,
      {
        sessionId: report.sessionId,
        taskId: report.taskId,
        phase: report.phase,
        progress: report.progress,
        message: report.message,
      },
      "progress-reporter"
    );

    if (report.progress >= 100) {
      this.eventBus.publish(
        SystemEvents.PROGRESS_COMPLETED,
        {
          sessionId: report.sessionId,
          taskId: report.taskId,
          totalSteps: report.totalSteps,
        },
        "progress-reporter"
      );
    }

    // Use the actual reportId as the storage key so all reports for a given
    // task batch live in the same list. Previously this used params.taskId,
    // which is the user's task identifier rather than the per-task report
    // batch id, causing reports to be lost or fragmented across keys.
    const reports = this.activeReports.get(reportId) || [];
    this.activeReports.set(reportId, [...reports, report]);

    return report;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}