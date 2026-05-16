import {
  ServiceRegistry,
  EventBus,
  type ReinforcementFeedback,
} from "@evoclaw/core";

export interface RewardSignal {
  cycleId: string;
  totalReward: number;
  components: {
    successReward: number;
    adoptionReward: number;
    efficiencyReward: number;
    noveltyBonus: number;
    consistencyBonus: number;
  };
  weights: {
    successWeight: number;
    adoptionWeight: number;
    efficiencyWeight: number;
    noveltyWeight: number;
    consistencyWeight: number;
  };
  normalizedReward: number;
  timestamp: Date;
}

export interface AdaptiveWeights {
  successWeight: number;
  adoptionWeight: number;
  efficiencyWeight: number;
  noveltyWeight: number;
  consistencyWeight: number;
}

export interface FeedbackSummary {
  totalFeedback: number;
  averageReward: number;
  trend: "improving" | "stable" | "declining";
  topPerformers: Array<{ cycleId: string; reward: number }>;
  improvementRate: number;
}

export class ReinforcementFeedbackSystem {
  private feedbackHistory: ReinforcementFeedback[] = [];
  private rewardHistory: RewardSignal[] = [];
  private maxHistoryEntries = 500;
  private weights: AdaptiveWeights = {
    successWeight: 0.4,
    adoptionWeight: 0.25,
    efficiencyWeight: 0.15,
    noveltyWeight: 0.1,
    consistencyWeight: 0.1,
  };
  private baselineSuccessRate = 0.7;
  private baselineAdoptionRate = 0.5;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("reinforcementFeedback", this);
  }

  async processFeedback(
    feedback: ReinforcementFeedback
  ): Promise<RewardSignal> {
    this.feedbackHistory.push(feedback);

    if (this.feedbackHistory.length > this.maxHistoryEntries) {
      this.feedbackHistory = this.feedbackHistory.slice(-this.maxHistoryEntries);
    }

    const components = this.calculateRewardComponents(feedback);
    const totalReward =
      components.successReward * this.weights.successWeight +
      components.adoptionReward * this.weights.adoptionWeight +
      components.efficiencyReward * this.weights.efficiencyWeight +
      components.noveltyBonus * this.weights.noveltyWeight +
      components.consistencyBonus * this.weights.consistencyWeight;

    const normalizedReward = this.normalizeReward(totalReward);

    const signal: RewardSignal = {
      cycleId: feedback.cycleId,
      totalReward,
      components,
      weights: { ...this.weights },
      normalizedReward,
      timestamp: new Date(),
    };

    this.rewardHistory.push(signal);

    if (this.rewardHistory.length > this.maxHistoryEntries) {
      this.rewardHistory = this.rewardHistory.slice(-this.maxHistoryEntries);
    }

    this.adaptWeights(signal);

    await this.eventBus?.publish(
      "evolution.reward_calculated",
      {
        cycleId: feedback.cycleId,
        reward: normalizedReward,
        components,
      },
      "reinforcement-feedback"
    );

    return signal;
  }

  getRewardHistory(): RewardSignal[] {
    return [...this.rewardHistory];
  }

  getFeedbackSummary(): FeedbackSummary {
    const recentRewards = this.rewardHistory.slice(-20);
    const averageReward =
      recentRewards.reduce((sum, r) => sum + r.normalizedReward, 0) /
      Math.max(1, recentRewards.length);

    let trend: "improving" | "stable" | "declining" = "stable";
    if (recentRewards.length >= 5) {
      const firstHalf = recentRewards.slice(0, Math.floor(recentRewards.length / 2));
      const secondHalf = recentRewards.slice(Math.floor(recentRewards.length / 2));
      const firstAvg = firstHalf.reduce((sum, r) => sum + r.normalizedReward, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((sum, r) => sum + r.normalizedReward, 0) / secondHalf.length;
      const diff = secondAvg - firstAvg;
      if (diff > 0.05) trend = "improving";
      else if (diff < -0.05) trend = "declining";
    }

    const sorted = [...recentRewards].sort(
      (a, b) => b.normalizedReward - a.normalizedReward
    );

    const topPerformers = sorted.slice(0, 5).map((r) => ({
      cycleId: r.cycleId,
      reward: Math.round(r.normalizedReward * 100),
    }));

    const improving = recentRewards.filter((r) => r.totalReward > 0.5).length;
    const improvementRate = recentRewards.length > 0
      ? improving / recentRewards.length
      : 0;

    return {
      totalFeedback: this.feedbackHistory.length,
      averageReward: Math.round(averageReward * 100) / 100,
      trend,
      topPerformers,
      improvementRate: Math.round(improvementRate * 100) / 100,
    };
  }

  getWeights(): AdaptiveWeights {
    return { ...this.weights };
  }

  updateWeights(newWeights: Partial<AdaptiveWeights>): void {
    this.weights = { ...this.weights, ...newWeights };
  }

  setBaselines(successRate: number, adoptionRate: number): void {
    this.baselineSuccessRate = successRate;
    this.baselineAdoptionRate = adoptionRate;
  }

  private calculateRewardComponents(feedback: ReinforcementFeedback) {
    const successReward = Math.max(
      0,
      feedback.successRate - this.baselineSuccessRate
    );

    const adoptionReward = Math.max(
      0,
      feedback.userAdoptionRate - this.baselineAdoptionRate
    );

    const efficiencyReward = Math.max(
      0,
      1 - feedback.tokenConsumption / 10000
    );

    const noveltyBonus = this.calculateNoveltyBonus(feedback);

    const consistencyBonus = 1 - Math.min(1, feedback.errorRate);

    return {
      successReward: Math.round(successReward * 100) / 100,
      adoptionReward: Math.round(adoptionReward * 100) / 100,
      efficiencyReward: Math.round(efficiencyReward * 100) / 100,
      noveltyBonus: Math.round(noveltyBonus * 100) / 100,
      consistencyBonus: Math.round(consistencyBonus * 100) / 100,
    };
  }

  private calculateNoveltyBonus(feedback: ReinforcementFeedback): number {
    const historyForSkill = this.feedbackHistory.filter(
      (f) => f.skillId === feedback.skillId
    );

    if (historyForSkill.length <= 1) return 0.5;

    const avgSuccess = historyForSkill.reduce((sum, f) => sum + f.successRate, 0) /
      historyForSkill.length;

    return feedback.successRate > avgSuccess ? 0.3 : 0;
  }

  private normalizeReward(rawReward: number): number {
    return Math.max(0, Math.min(1, rawReward));
  }

  private adaptWeights(signal: RewardSignal): void {
    if (this.rewardHistory.length < 10) return;

    const recentSignals = this.rewardHistory.slice(-10);

    const avgSuccessReward = recentSignals.reduce(
      (sum, s) => sum + s.components.successReward,
      0
    ) / recentSignals.length;

    const avgAdoptionReward = recentSignals.reduce(
      (sum, s) => sum + s.components.adoptionReward,
      0
    ) / recentSignals.length;

    if (avgSuccessReward < 0.2 && this.weights.successWeight > 0.2) {
      this.weights.successWeight -= 0.02;
      this.weights.adoptionWeight += 0.01;
      this.weights.consistencyWeight += 0.01;
    }

    if (avgAdoptionReward < 0.1 && this.weights.adoptionWeight > 0.1) {
      this.weights.adoptionWeight -= 0.02;
      this.weights.successWeight += 0.02;
    }

    const totalWeight =
      this.weights.successWeight +
      this.weights.adoptionWeight +
      this.weights.efficiencyWeight +
      this.weights.noveltyWeight +
      this.weights.consistencyWeight;

    if (Math.abs(totalWeight - 1) > 0.001) {
      const scale = 1 / totalWeight;
      this.weights.successWeight *= scale;
      this.weights.adoptionWeight *= scale;
      this.weights.efficiencyWeight *= scale;
      this.weights.noveltyWeight *= scale;
      this.weights.consistencyWeight *= scale;
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}