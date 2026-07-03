import type { EvalCase, EvalResult, EvalRunSummary, EvalConfig, CustomEvaluator, LLMJudgeCriteria } from "./types";
import { DEFAULT_JUDGE_CRITERIA } from "./types";

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

  /** Alias for getCases() — WebUI expects this name. */
  getAllCases(): EvalCase[] {
    return this.getCases();
  }

  /**
   * Run a quick eval pass against an injected chat function. If no chat
   * function is provided, each case is scored on length/pattern checks only
   * (useful for dry-runs in CI without a live LLM).
   */
  async runAll(options?: {
    chatFn?: (message: string, sessionId: string) => Promise<string>;
    config?: Partial<EvalConfig>;
    categoryFilter?: string;
  }): Promise<EvalRunSummary> {
    const config: EvalConfig = {
      name: options?.config?.name ?? "auto-run",
      timeoutPerCase: options?.config?.timeoutPerCase ?? 30_000,
      passThreshold: options?.config?.passThreshold ?? 0.6,
      useLLMJudge: options?.config?.useLLMJudge ?? false,
      judgeProvider: options?.config?.judgeProvider,
    };
    const chatFn = options?.chatFn ?? (async (input: string) => `[dry-run] would process: ${input}`);
    return this.run(chatFn, config, options?.categoryFilter);
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

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = await Promise.race([
          chatFn(evalCase.input, sessionId),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error("Timeout")),
              config.timeoutPerCase
            );
          }),
        ]);

        const durationMs = Date.now() - startTime;
        // Use async evaluation to support LLM judge and custom evaluators.
        const result = await this.evaluateOutputAsync(evalCase, output, durationMs, config, sessionId);
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
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    const summary = this.buildSummary(config.name, results, casesToRun);
    this.runHistory.push(summary);
    return summary;
  }

  /**
   * Async evaluation wrapper — supports LLM-as-judge and custom evaluators.
   * Falls back to the synchronous heuristic evaluator when neither is enabled.
   */
  private async evaluateOutputAsync(
    evalCase: EvalCase,
    output: string,
    durationMs: number,
    config: EvalConfig,
    sessionId: string,
  ): Promise<EvalResult> {
    // Start with the heuristic baseline.
    const heuristic = this.evaluateOutput(evalCase, output, durationMs, config);

    // If LLM judge is enabled, override the score with the judge's verdict.
    if (config.useLLMJudge && config.judgeProvider) {
      try {
        const judgeResult = await this.runLLMJudge(evalCase, output, config.judgeProvider, DEFAULT_JUDGE_CRITERIA);
        // Blend: 70% judge, 30% heuristic (preserves pattern-match signal).
        const blended = judgeResult.score * 0.7 + heuristic.score * 0.3;
        return {
          ...heuristic,
          score: Math.round(blended * 100) / 100,
          taskCompleted: blended >= config.passThreshold,
          details: `${heuristic.details}; [LLM-judge] ${judgeResult.rationale}`,
          hallucinationDetected: judgeResult.hallucinationFlagged ?? heuristic.hallucinationDetected,
        };
      } catch (err) {
        // Judge failed — fall back to heuristic and annotate.
        return {
          ...heuristic,
          details: `${heuristic.details}; [LLM-judge failed: ${err instanceof Error ? err.message : String(err)}]`,
        };
      }
    }

    // If custom evaluators are provided, blend their scores with the heuristic.
    if (config.customEvaluators && config.customEvaluators.length > 0) {
      try {
        const customScores = await Promise.all(
          config.customEvaluators.map(ev =>
            ev(evalCase, output, { sessionId, durationMs }).catch(() => ({ score: 0, rationale: "evaluator error" }))
          )
        );
        const avgCustom = customScores.reduce((s, r) => s + r.score, 0) / customScores.length;
        const blended = avgCustom * 0.6 + heuristic.score * 0.4;
        const rationales = customScores.map(r => r.rationale).filter(Boolean).join("; ");
        return {
          ...heuristic,
          score: Math.round(blended * 100) / 100,
          taskCompleted: blended >= config.passThreshold,
          details: `${heuristic.details}; [custom] ${rationales}`,
        };
      } catch {
        // Custom evaluators failed — fall back to heuristic.
        return heuristic;
      }
    }

    return heuristic;
  }

  /**
   * LLM-as-judge: asks the judge LLM to score the output on multiple criteria.
   * Returns a weighted score in [0, 1] and a rationale.
   *
   * Inspired by LangSmith's LLM-as-judge evaluator and OpenAI Evals scoring templates.
   */
  private async runLLMJudge(
    evalCase: EvalCase,
    output: string,
    provider: { provider: string; model: string; apiKey?: string; baseURL?: string },
    criteria: LLMJudgeCriteria[],
  ): Promise<{ score: number; rationale: string; hallucinationFlagged?: boolean }> {
    const apiKey = provider.apiKey || process.env.OPENAI_API_KEY || process.env.EVOCLAW_JUDGE_API_KEY;
    if (!apiKey) {
      throw new Error("LLM judge requires an API key (set judgeProvider.apiKey or OPENAI_API_KEY)");
    }
    const baseURL = (provider.baseURL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

    const criteriaText = criteria.map((c, i) => `${i + 1}. ${c.name} (weight ${c.weight}): ${c.description}`).join("\n");
    const prompt = `You are an expert evaluator. Score the following AI assistant response on these criteria:
${criteriaText}

For each criterion, give a score from 0 to 5 (0=terrible, 5=excellent). Then compute a weighted average normalized to [0, 1].

User request:
${evalCase.input}

Expected behavior:
${evalCase.expectedBehavior}

Assistant response:
${output}

Respond in JSON only:
{
  "scores": { "${criteria[0].name}": <0-5>, ... },
  "weighted_score": <0.0-1.0>,
  "rationale": "<one-sentence explanation>",
  "hallucination_flagged": <true|false>
}`;

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: "You are a strict but fair evaluator. Respond only in JSON." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      throw new Error(`Judge LLM returned ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content) as {
      weighted_score?: number;
      rationale?: string;
      hallucination_flagged?: boolean;
    };

    return {
      score: typeof parsed.weighted_score === "number" ? Math.max(0, Math.min(1, parsed.weighted_score)) : 0,
      rationale: parsed.rationale ?? "no rationale provided",
      hallucinationFlagged: parsed.hallucination_flagged === true,
    };
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
