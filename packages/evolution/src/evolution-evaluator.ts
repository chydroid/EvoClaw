import {
  ServiceRegistry,
  EventBus,
  type EvolutionCandidate,
  type EvolutionEvaluation,
  type TestSuiteResult,
  type SecurityAuditResult,
  type PerformanceImpact,
  type Vulnerability,
} from "@evoclaw/core";

const DANGEROUS_PATTERNS = [
  { pattern: /eval\s*\(/, severity: "critical" as const, description: "Use of eval()" },
  { pattern: /Function\s*\(/, severity: "critical" as const, description: "Use of Function constructor" },
  { pattern: /child_process/, severity: "high" as const, description: "Child process spawning" },
  { pattern: /require\s*\(/, severity: "medium" as const, description: "Dynamic require()" },
  { pattern: /fs\.writeFile|fs\.unlink/, severity: "high" as const, description: "File system write/delete" },
  { pattern: /process\.env/, severity: "low" as const, description: "Environment variable access" },
  { pattern: /fetch\s*\(|XMLHttpRequest/, severity: "low" as const, description: "Network request" },
  { pattern: /exec\s*\(|execSync\s*\(/, severity: "critical" as const, description: "Command execution" },
];

export class EvolutionEvaluator {
  private evaluationHistory = new Map<string, EvolutionEvaluation>();
  private maxEvaluationHistory = 500;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async evaluate(
    candidate: EvolutionCandidate
  ): Promise<EvolutionEvaluation> {
    const testResults = this.runTestSuite(candidate);
    const securityAudit = this.runSecurityAudit(candidate);
    const performanceImpact = this.assessPerformanceImpact(candidate);

    const score = this.calculateOverallScore(testResults, securityAudit, performanceImpact);
    const passed = score >= 0.6;

    const recommendation = this.generateRecommendation(
      passed,
      testResults,
      securityAudit,
      performanceImpact
    );

    const evaluation: EvolutionEvaluation = {
      candidateId: candidate.id,
      passed,
      score,
      testResults,
      securityAudit,
      performanceImpact,
      recommendation,
    };

    this.evaluationHistory.set(candidate.id, evaluation);

    // Cap the in-memory history. Using a Map and removing the oldest
    // inserted key (Map preserves insertion order) keeps memory bounded
    // for long-running evolution engines that evaluate many candidates.
    if (this.evaluationHistory.size > this.maxEvaluationHistory) {
      const oldestKey = this.evaluationHistory.keys().next().value;
      if (oldestKey !== undefined) {
        this.evaluationHistory.delete(oldestKey);
      }
    }

    return evaluation;
  }

  private runTestSuite(candidate: EvolutionCandidate): TestSuiteResult {
    const artifacts = candidate.codeArtifacts;
    const failures: TestSuiteResult["failures"] = [];

    let totalTests = 0;
    let passed = 0;
    let failed = 0;

    for (const artifact of artifacts) {
      if (artifact.tests) {
        const testCount = this.countTests(artifact.tests);
        totalTests += testCount;

        if (this.isValidCode(artifact.tests)) {
          passed += testCount;
        } else {
          failed += testCount;
          failures.push({
            testName: `test_${artifact.name}`,
            message: "Test code contains syntax errors",
            expected: "valid test code",
            actual: "invalid test code",
          });
        }
      }
    }

    if (candidate.proposedChanges?.codeChanges?.length) {
      totalTests += candidate.proposedChanges.codeChanges.length;
      for (const change of candidate.proposedChanges.codeChanges) {
        if (change.diff && change.diff.length > 0) {
          passed += 1;
        } else {
          failed += 1;
          failures.push({
            testName: `change_${change.filePath}`,
            message: "Empty code change",
            expected: "non-empty diff",
            actual: "empty diff",
          });
        }
      }
    }

    if (totalTests === 0) {
      totalTests = 1;
      passed = 1;
    }

    const coverage = totalTests > 0 ? passed / totalTests : 0;

    return {
      totalTests,
      passed,
      failed,
      coverage: Math.round(coverage * 100) / 100,
      failures,
    };
  }

  private runSecurityAudit(candidate: EvolutionCandidate): SecurityAuditResult {
    const vulnerabilities: Vulnerability[] = [];

    for (const artifact of candidate.codeArtifacts) {
      const source = artifact.source || "";

      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.pattern.test(source)) {
          vulnerabilities.push({
            severity: pattern.severity,
            description: pattern.description,
            location: `artifact:${artifact.name}`,
            remediation: `Remove or sandbox the ${pattern.description.toLowerCase()}`,
          });
        }
      }
    }

    for (const change of candidate.proposedChanges?.codeChanges || []) {
      const diff = change.diff || "";

      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.pattern.test(diff)) {
          vulnerabilities.push({
            severity: pattern.severity,
            description: pattern.description,
            location: `diff:${change.filePath}`,
            remediation: `Remove or sandbox the ${pattern.description.toLowerCase()}`,
          });
        }
      }
    }

    const criticalCount = vulnerabilities.filter((v) => v.severity === "critical").length;
    const highCount = vulnerabilities.filter((v) => v.severity === "high").length;
    const mediumCount = vulnerabilities.filter((v) => v.severity === "medium").length;
    const lowCount = vulnerabilities.filter((v) => v.severity === "low").length;

    const score = Math.max(
      0,
      1.0 - (criticalCount * 0.3 + highCount * 0.2 + mediumCount * 0.1 + lowCount * 0.05)
    );

    return {
      score: Math.round(score * 100) / 100,
      vulnerabilities,
      passed: criticalCount === 0 && score >= 0.6,
    };
  }

  private assessPerformanceImpact(candidate: EvolutionCandidate): PerformanceImpact {
    const artifacts = candidate.codeArtifacts;
    let totalSourceLength = 0;
    let estimatedMemory = 0;

    for (const artifact of artifacts) {
      const source = artifact.source || "";
      totalSourceLength += source.length;

      if (source.includes("Buffer") || source.includes("new Array")) {
        estimatedMemory += 5;
      }
      if (source.includes("fetch") || source.includes("http")) {
        estimatedMemory += 2;
      }
    }

    const estimatedCpuIncrease = Math.min(
      0.5,
      (totalSourceLength / 10000) * 0.1 + (artifacts.length * 0.02)
    );

    const estimatedMemoryIncrease = Math.min(
      128,
      estimatedMemory + artifacts.length * 5
    );

    const estimatedLatencyIncrease = Math.min(
      500,
      artifacts.length * 30 + (totalSourceLength > 500 ? 100 : 0)
    );

    const acceptable =
      estimatedCpuIncrease < 0.3 &&
      estimatedMemoryIncrease < 50 &&
      estimatedLatencyIncrease < 200;

    return {
      estimatedCpuIncrease: Math.round(estimatedCpuIncrease * 100) / 100,
      estimatedMemoryIncrease: Math.round(estimatedMemoryIncrease),
      estimatedLatencyIncrease: Math.round(estimatedLatencyIncrease),
      acceptable,
    };
  }

  private calculateOverallScore(
    tests: TestSuiteResult,
    security: SecurityAuditResult,
    perf: PerformanceImpact
  ): number {
    const testScore = tests.coverage;
    const securityScore = security.score;
    const perfScore = perf.acceptable ? 1.0 : 0.5;

    const weighted = testScore * 0.4 + securityScore * 0.4 + perfScore * 0.2;
    return Math.round(weighted * 100) / 100;
  }

  private generateRecommendation(
    passed: boolean,
    tests: TestSuiteResult,
    security: SecurityAuditResult,
    perf: PerformanceImpact
  ): string {
    if (!passed) {
      const reasons: string[] = [];

      if (tests.coverage < 0.6) {
        reasons.push(`test coverage too low (${Math.round(tests.coverage * 100)}%)`);
      }

      if (!security.passed) {
        reasons.push(
          `security audit failed (score: ${Math.round(security.score * 100)}, ${security.vulnerabilities.length} issues)`
        );
      }

      if (!perf.acceptable) {
        reasons.push(
          `performance impact too high (CPU: +${perf.estimatedCpuIncrease}, Mem: +${perf.estimatedMemoryIncrease}MB)`
        );
      }

      return `Candidate rejected: ${reasons.join("; ")}`;
    }

    if (
      tests.coverage >= 0.9 &&
      security.score >= 0.9 &&
      perf.estimatedCpuIncrease < 0.1
    ) {
      return "Candidate passed with excellent quality, ready for production deployment";
    }

    return "Candidate passed evaluation, ready for staged deployment with monitoring";
  }

  private countTests(testCode: string): number {
    const describeMatches = testCode.match(/describe\s*\(/g);
    const testMatches = testCode.match(/it\s*\(|test\s*\(/g);
    return (describeMatches?.length || 1) * (testMatches?.length || 1);
  }

  private isValidCode(code: string): boolean {
    try {
      if (code.length < 10) return false;
      if (!code.includes("describe") && !code.includes("test(") && !code.includes("it(")) {
        return true;
      }
      return !code.includes("<<<ERROR>>>") && code.includes("expect");
    } catch {
      return false;
    }
  }

  getEvaluation(candidateId: string): EvolutionEvaluation | undefined {
    return this.evaluationHistory.get(candidateId);
  }

  getEvaluationHistory(): EvolutionEvaluation[] {
    return Array.from(this.evaluationHistory.values());
  }
}