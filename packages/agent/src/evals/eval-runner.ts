import type { EvalCase, EvalResult, EvalRunSummary, EvalConfig } from "./types";

export class EvalRunner {
  private cases: EvalCase[] = [];
  private runHistory: EvalRunSummary[] = [];

  /** Add evaluation cases */
  addCases(cases: EvalCase[]): void {
    this.cases.push(...cases);
  }

  /** Add a single case */
  addCase(evalCase: EvalCase): void {
    this.cases.push(evalCase);
  }

  /** Remove a case by id */
  removeCase(id: string): boolean {
    const idx = this.cases.findIndex(c => c.id === id);
    if (idx === -1) return false;
    this.cases.splice(idx, 1);
    return true;
  }

  /** Get all cases */
  getCases(): EvalCase[] {
    return [...this.cases];
  }

  /** Get cases filtered by category */
  getCasesByCategory(category: string): EvalCase[] {
    return this.cases.filter(c => c.category === category);
  }

  /** Get cases filtered by difficulty */
  getCasesByDifficulty(difficulty: EvalCase["difficulty"]): EvalCase[] {
    return this.cases.filter(c => c.difficulty === difficulty);
  }

  /** Get cases filtered by tag */
  getCasesByTag(tag: string): EvalCase[] {
    return this.cases.filter(c => c.tags?.includes(tag));
  }

  /** Get all unique categories */
  getCategories(): string[] {
    return [...new Set(this.cases.map(c => c.category))];
  }

  /** Get run history */
  getRunHistory(): EvalRunSummary[] {
    return [...this.runHistory];
  }

  /** Get a specific run by id */
  getRunById(id: string): EvalRunSummary | undefined {
    return this.runHistory.find(r => r.id === id);
  }

  /** Run evaluation against an agent chat function */
  async run(
    chatFn: (message: string, sessionId: string) => Promise<string>,
    config: EvalConfig,
    categoryFilter?: string,
  ): Promise<EvalRunSummary> {
    const casesToRun = categoryFilter
      ? this.cases.filter(c => c.category === categoryFilter)
      : this.cases;

    const results: EvalResult[] = [];

    for (const evalCase of casesToRun) {
      const startTime = Date.now();
      const sessionId = `eval-${evalCase.id}-${Date.now()}`;

      try {
        const output = await Promise.race([
          chatFn(evalCase.input, sessionId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), config.timeoutPerCase)
          ),
        ]);

        const durationMs = Date.now() - startTime;
        const result = this.evaluateOutput(evalCase, output, durationMs, config);
        results.push(result);
      } catch (err) {
        results.push({
          caseId: evalCase.id,
          caseName: evalCase.name,
          actualOutput: "",
          taskCompleted: false,
          score: 0,
          toolsCalled: [],
          tokensUsed: 0,
          durationMs: Date.now() - startTime,
          details: `Evaluation error: ${err instanceof Error ? err.message : String(err)}`,
          patternMatched: false,
          hallucinationDetected: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = this.buildSummary(config.name, results, casesToRun);
    this.runHistory.push(summary);
    return summary;
  }

  /** Evaluate a single output against its expected case */
  private evaluateOutput(evalCase: EvalCase, output: string, durationMs: number, config: EvalConfig): EvalResult {
    // Check pattern match
    let patternMatched = false;
    if (evalCase.expectedOutputPattern) {
      if (typeof evalCase.expectedOutputPattern === "string") {
        patternMatched = output.includes(evalCase.expectedOutputPattern);
      } else {
        patternMatched = evalCase.expectedOutputPattern.test(output);
      }
    }

    // Simple heuristic scoring
    let score = 0;
    const details: string[] = [];

    // 1. Output non-empty (0.1)
    if (output.length > 0) {
      score += 0.1;
      details.push("Output non-empty");
    }

    // 2. Pattern match (0.3)
    if (patternMatched) {
      score += 0.3;
      details.push("Pattern matched");
    }

    // 3. Relevance check - output mentions key terms from expected behavior (0.3)
    const keyTerms = evalCase.expectedBehavior.split(/\s+/).filter(w => w.length > 3);
    const matchedTerms = keyTerms.filter(term => output.toLowerCase().includes(term.toLowerCase()));
    if (keyTerms.length > 0) {
      const termScore = matchedTerms.length / keyTerms.length;
      score += Math.min(termScore, 1) * 0.3;
      details.push(`Relevance: ${matchedTerms.length}/${keyTerms.length} key terms`);
    }

    // 4. No obvious hallucination indicators (0.3)
    const hallucinationPatterns = [
      /I don't have access to/i,
      /I cannot (?:access|browse|connect to)/i,
      /as an AI/i,
      /I'm not able to/i,
    ];
    const hallucinationDetected = hallucinationPatterns.some(p => p.test(output));
    if (!hallucinationDetected) {
      score += 0.3;
      details.push("No hallucination indicators");
    }

    const taskCompleted = score >= config.passThreshold;

    return {
      caseId: evalCase.id,
      caseName: evalCase.name,
      actualOutput: output.slice(0, 500),
      taskCompleted,
      score: Math.round(score * 100) / 100,
      toolsCalled: [], // Would need instrumentation to track
      tokensUsed: 0, // Would need instrumentation to track
      durationMs,
      details: details.join("; "),
      patternMatched,
      hallucinationDetected,
    };
  }

  /** Build a summary from results */
  private buildSummary(name: string, results: EvalResult[], cases: EvalCase[]): EvalRunSummary {
    const passed = results.filter(r => r.taskCompleted).length;
    const failed = results.length - passed;
    const averageScore = results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
    const averageDurationMs = results.length > 0 ? results.reduce((s, r) => s + r.durationMs, 0) / results.length : 0;
    const averageTokensUsed = results.length > 0 ? results.reduce((s, r) => s + r.tokensUsed, 0) / results.length : 0;
    const hallucinationRate = results.filter(r => r.hallucinationDetected).length / (results.length || 1);

    // Category breakdown
    const categoryBreakdown: Record<string, { total: number; passed: number; averageScore: number }> = {};
    for (let i = 0; i < results.length; i++) {
      const cat = cases[i]?.category;
      if (!cat) continue;
      if (!categoryBreakdown[cat]) {
        categoryBreakdown[cat] = { total: 0, passed: 0, averageScore: 0 };
      }
      categoryBreakdown[cat].total++;
      if (results[i].taskCompleted) categoryBreakdown[cat].passed++;
      categoryBreakdown[cat].averageScore += results[i].score;
    }
    for (const cat of Object.keys(categoryBreakdown)) {
      const entry = categoryBreakdown[cat];
      entry.averageScore = Math.round((entry.averageScore / entry.total) * 100) / 100;
    }

    return {
      id: `eval-${Date.now()}`,
      name,
      timestamp: Date.now(),
      totalCases: results.length,
      passed,
      failed,
      averageScore: Math.round(averageScore * 100) / 100,
      averageDurationMs: Math.round(averageDurationMs),
      averageTokensUsed: Math.round(averageTokensUsed),
      toolAccuracy: 0, // Would need instrumentation
      hallucinationRate: Math.round(hallucinationRate * 100) / 100,
      results,
      categoryBreakdown,
    };
  }
}
