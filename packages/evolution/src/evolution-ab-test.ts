/**
 * EvolutionABTest — 进化 A/B 测试 + 自动回滚
 *
 * 为进化结果实现 A/B 测试框架：
 *   - Variant A = 原始行为（baseline）
 *   - Variant B = 新进化行为
 *   - 当 B 的成功率显著低于 A 时自动建议回滚
 *   - 超过 24 小时的测试自动结束
 */

// ── Types ──────────────────────────────────────────────────

interface TestRecord {
  testId: string;
  evolutionId: string;
  variantA: { successes: number; failures: number };
  variantB: { successes: number; failures: number };
  metricsA: Array<Record<string, number>>;
  metricsB: Array<Record<string, number>>;
  startedAt: Date;
  concluded: boolean;
  winner?: "A" | "B";
}

export interface TestStatus {
  testId: string;
  variantA: { successes: number; failures: number };
  variantB: { successes: number; failures: number };
  winner?: "A" | "B";
  confidence: number;
}

// ── Constants ──────────────────────────────────────────────

const TEST_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_SAMPLES_FOR_ROLLBACK = 5;
const ROLLBACK_THRESHOLD = 0.7; // B's success rate must be < A's * 0.7

// ── EvolutionABTest ────────────────────────────────────────

export class EvolutionABTest {
  private tests: Map<string, TestRecord> = new Map();
  private idCounter = 0;

  /**
   * 启动一个 A/B 测试。
   * @returns testId
   */
  startTest(evolutionId: string, _originalBehavior: string, _newBehavior: string): string {
    this.expireOldTests();

    const testId = `abt-${Date.now()}-${++this.idCounter}`;

    this.tests.set(testId, {
      testId,
      evolutionId,
      variantA: { successes: 0, failures: 0 },
      variantB: { successes: 0, failures: 0 },
      metricsA: [],
      metricsB: [],
      startedAt: new Date(),
      concluded: false,
    });

    return testId;
  }

  /**
   * 记录一次测试结果。
   */
  recordResult(testId: string, variant: "A" | "B", success: boolean, metrics?: Record<string, number>): void {
    const test = this.tests.get(testId);
    if (!test || test.concluded) return;

    const bucket = variant === "A" ? test.variantA : test.variantB;
    const metricsBucket = variant === "A" ? test.metricsA : test.metricsB;

    if (success) {
      bucket.successes++;
    } else {
      bucket.failures++;
    }

    if (metrics) {
      metricsBucket.push(metrics);
    }

    // Check if we can conclude the test
    this.maybeConcludeTest(test);
  }

  /**
   * 获取当前测试状态。
   */
  getTestStatus(testId: string): TestStatus {
    const test = this.tests.get(testId);

    if (!test) {
      return {
        testId,
        variantA: { successes: 0, failures: 0 },
        variantB: { successes: 0, failures: 0 },
        confidence: 0,
      };
    }

    const totalA = test.variantA.successes + test.variantA.failures;
    const totalB = test.variantB.successes + test.variantB.failures;
    const rateA = totalA > 0 ? test.variantA.successes / totalA : 0;
    const rateB = totalB > 0 ? test.variantB.successes / totalB : 0;

    // Simple confidence: based on sample size and rate difference
    const minSamples = Math.min(totalA, totalB);
    const confidence = this.computeConfidence(rateA, rateB, minSamples);

    return {
      testId: test.testId,
      variantA: { ...test.variantA },
      variantB: { ...test.variantB },
      winner: test.winner,
      confidence,
    };
  }

  /**
   * 判断是否应该回滚（variant B 显著差于 variant A）。
   *
   * 条件：B 的成功率 < A 的成功率 * 0.7，且至少有 5 个样本。
   */
  shouldRollback(testId: string): boolean {
    const test = this.tests.get(testId);
    if (!test) return false;

    const totalA = test.variantA.successes + test.variantA.failures;
    const totalB = test.variantB.successes + test.variantB.failures;

    if (totalA < MIN_SAMPLES_FOR_ROLLBACK || totalB < MIN_SAMPLES_FOR_ROLLBACK) {
      return false;
    }

    const rateA = totalA > 0 ? test.variantA.successes / totalA : 0;
    const rateB = totalB > 0 ? test.variantB.successes / totalB : 0;

    // If A has zero success rate, B can't be "significantly worse" relative to A
    if (rateA === 0) return false;

    return rateB < rateA * ROLLBACK_THRESHOLD;
  }

  // ── Private Methods ──────────────────────────────────────

  /**
   * Compute a simple confidence score (0-1) based on rate difference and sample size.
   * Uses a heuristic: larger sample sizes and larger rate differences yield higher confidence.
   */
  private computeConfidence(rateA: number, rateB: number, minSamples: number): number {
    if (minSamples === 0) return 0;

    const rateDiff = Math.abs(rateA - rateB);
    // Sample size factor: confidence grows with sqrt(minSamples), capped at 1
    const sampleFactor = Math.min(1, Math.sqrt(minSamples) / 10);
    // Rate difference factor: larger differences = more confident
    const diffFactor = Math.min(1, rateDiff * 2);

    return Math.min(1, sampleFactor * diffFactor);
  }

  /**
   * Try to conclude a test if we have enough data.
   */
  private maybeConcludeTest(test: TestRecord): void {
    const totalA = test.variantA.successes + test.variantA.failures;
    const totalB = test.variantB.successes + test.variantB.failures;

    // Need at least 10 samples per variant to conclude
    if (totalA < 10 || totalB < 10) return;

    const rateA = totalA > 0 ? test.variantA.successes / totalA : 0;
    const rateB = totalB > 0 ? test.variantB.successes / totalB : 0;

    // Conclude if there's a clear winner (difference > 20%)
    if (Math.abs(rateA - rateB) > 0.2) {
      test.concluded = true;
      test.winner = rateB > rateA ? "B" : "A";
    }
  }

  /**
   * Auto-cleanup: expire tests older than 24 hours.
   */
  private expireOldTests(): void {
    const now = Date.now();

    for (const [testId, test] of this.tests) {
      const age = now - test.startedAt.getTime();
      if (age > TEST_EXPIRY_MS && !test.concluded) {
        test.concluded = true;

        // Determine winner at expiry time
        const totalA = test.variantA.successes + test.variantA.failures;
        const totalB = test.variantB.successes + test.variantB.failures;
        const rateA = totalA > 0 ? test.variantA.successes / totalA : 0;
        const rateB = totalB > 0 ? test.variantB.successes / totalB : 0;

        test.winner = rateB >= rateA ? "B" : "A";
      }

      // Remove concluded tests that are very old (> 48h) to prevent unbounded growth
      if (age > TEST_EXPIRY_MS * 2) {
        this.tests.delete(testId);
      }
    }
  }
}
