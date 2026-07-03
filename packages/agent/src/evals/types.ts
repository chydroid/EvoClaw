/** An evaluation dataset entry */
export interface EvalCase {
  id: string;
  name: string;
  /** The input message to the agent */
  input: string;
  /** Expected behavior description */
  expectedBehavior: string;
  /** Optional expected output pattern (regex or string) */
  expectedOutputPattern?: string | RegExp;
  /** Category for grouping */
  category: string;
  /** Difficulty level */
  difficulty: "easy" | "medium" | "hard";
  /** Tags for filtering */
  tags?: string[];
}

/** Result of evaluating a single case */
export interface EvalResult {
  caseId: string;
  caseName: string;
  /** The actual agent output */
  actualOutput: string;
  /** Whether the agent completed the task */
  taskCompleted: boolean;
  /** Score from 0 to 1 */
  score: number;
  /** Which tools were called */
  toolsCalled: string[];
  /** Total tokens used */
  tokensUsed: number;
  /** Duration in ms */
  durationMs: number;
  /** Evaluation details */
  details: string;
  /** Whether the output matches the expected pattern */
  patternMatched: boolean;
  /** Whether any hallucination was detected */
  hallucinationDetected: boolean;
  /** Error if the evaluation failed */
  error?: string;
}

/** Summary of an evaluation run */
export interface EvalRunSummary {
  id: string;
  name: string;
  timestamp: number;
  totalCases: number;
  passed: number;
  failed: number;
  averageScore: number;
  averageDurationMs: number;
  averageTokensUsed: number;
  toolAccuracy: number;
  hallucinationRate: number;
  results: EvalResult[];
  /** Per-category breakdown */
  categoryBreakdown: Record<string, { total: number; passed: number; averageScore: number }>;
}

/** Configuration for an evaluation run */
export interface EvalConfig {
  /** Name of this evaluation run */
  name: string;
  /** Maximum duration per case in ms */
  timeoutPerCase: number;
  /** Minimum score to consider a case "passed" */
  passThreshold: number;
  /** Whether to use LLM-as-judge for scoring */
  useLLMJudge: boolean;
  /** Provider to use for LLM judge */
  judgeProvider?: { provider: string; model: string; apiKey?: string; baseURL?: string };
  /** Custom evaluators to run alongside the built-in heuristics. */
  customEvaluators?: CustomEvaluator[];
}

/**
 * Custom evaluator: a user-supplied function that scores a case's output.
 * Returns a score in [0, 1] and an optional rationale string.
 *
 * Inspired by LangSmith's `Evaluator` interface and Inspect AI's `scorer`.
 */
export type CustomEvaluator = (
  evalCase: EvalCase,
  output: string,
  context: { sessionId: string; durationMs: number },
) => Promise<{ score: number; rationale?: string } | { score: number; rationale?: string }>;

/**
 * LLM judge configuration: which criteria to evaluate, and how to weight them.
 * Each criterion is scored 0-5 by the judge LLM; weights are normalized.
 */
export interface LLMJudgeCriteria {
  name: string;
  description: string;
  weight: number;
}

export const DEFAULT_JUDGE_CRITERIA: LLMJudgeCriteria[] = [
  { name: "correctness", description: "Does the output answer the question correctly?", weight: 0.4 },
  { name: "completeness", description: "Does the output cover all aspects of the request?", weight: 0.3 },
  { name: "clarity", description: "Is the output clear and well-structured?", weight: 0.2 },
  { name: "hallucination", description: "Does the output avoid fabricating information?", weight: 0.1 },
];
