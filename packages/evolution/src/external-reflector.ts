import { ServiceRegistry, EventBus } from "@evoclaw/core";

export interface ReflectionResult {
  rootCause: string;
  failureCategory: "transient" | "systematic" | "environmental" | "unknown";
  suggestedImprovements: string[];
  confidenceScore: number;
  shouldEvolve: boolean;
}

export interface ExecutionTrace {
  taskId: string;
  skillId?: string;
  error?: string;
  steps: Array<{ action: string; result: string; success: boolean; timestamp: number }>;
  context: Record<string, unknown>;
}

const TRANSIENT_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\btime.out\b/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\brate.limit\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\b503\b/,
  /\bservice.unavailable\b/i,
  /\btemporarily unavailable\b/i,
  /\bnetwork error\b/i,
  /\bsocket hang up\b/i,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bretry\b/i,
  /\btransient\b/i,
];

const ENVIRONMENTAL_PATTERNS: RegExp[] = [
  /\bpermission denied\b/i,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bnot found\b/i,
  /\bENOENT\b/,
  /\bresource not found\b/i,
  /\baccess denied\b/i,
  /\bforbidden\b/i,
  /\b403\b/,
  /\b404\b/,
  /\bquota exceeded\b/i,
  /\binsufficient permissions\b/i,
  /\bauthentication failed\b/i,
  /\bunauthorized\b/i,
  /\b401\b/,
];

const SYSTEMATIC_PATTERNS: RegExp[] = [
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\bsyntaxerror\b/i,
  /\brangeerror\b/i,
  /\blogic error\b/i,
  /\bmissing feature\b/i,
  /\bincorrect\b/i,
  /\bwrong result\b/i,
  /\bassertion failed\b/i,
  /\bvalidation error\b/i,
  /\binvalid argument\b/i,
  /\binvalid input\b/i,
  /\bparse error\b/i,
  /\bimplementation error\b/i,
];

export class ExternalReflector {
  private registry: ServiceRegistry;
  private eventBus: EventBus;

  constructor(registry: ServiceRegistry, eventBus: EventBus) {
    this.registry = registry;
    this.eventBus = eventBus;
  }

  async reflect(trace: ExecutionTrace): Promise<ReflectionResult> {
    const error = trace.error || "";

    if (!error && trace.steps.length > 0) {
      const failedSteps = trace.steps.filter((s) => !s.success);
      if (failedSteps.length === 0) {
        return {
          rootCause: "No failure detected in trace",
          failureCategory: "unknown",
          suggestedImprovements: [],
          confidenceScore: 0,
          shouldEvolve: false,
        };
      }
    }

    const failureCategory = this.classifyFailure(error);
    const isTransient = this.isTransientFailure(error);

    const rootCause = this.inferRootCause(error, trace, failureCategory);
    const suggestedImprovements = this.generateSuggestions(error, trace, failureCategory);

    let confidenceScore = 0.5;
    if (error) {
      const matchedCategories = [TRANSIENT_PATTERNS, ENVIRONMENTAL_PATTERNS, SYSTEMATIC_PATTERNS].filter(
        (patterns) => patterns.some((p) => p.test(error))
      );
      confidenceScore = Math.min(0.3 + matchedCategories.length * 0.25, 1.0);
    }

    const shouldEvolve = !isTransient && failureCategory !== "environmental";

    return {
      rootCause,
      failureCategory,
      suggestedImprovements,
      confidenceScore,
      shouldEvolve,
    };
  }

  async crossValidate(
    internalScore: number,
    reflection: ReflectionResult
  ): Promise<{ finalScore: number; trusted: boolean }> {
    if (reflection.failureCategory === "transient" && internalScore > 0.5) {
      const finalScore = internalScore * 0.3;
      return { finalScore, trusted: false };
    }

    if (reflection.failureCategory === "systematic" && internalScore < 0.5) {
      const finalScore = Math.max(internalScore, reflection.confidenceScore * 0.7);
      return { finalScore, trusted: true };
    }

    if (reflection.failureCategory === "environmental") {
      const finalScore = internalScore * 0.5;
      return { finalScore, trusted: false };
    }

    const finalScore = internalScore * 0.6 + reflection.confidenceScore * 0.4;
    return { finalScore, trusted: reflection.confidenceScore >= 0.5 };
  }

  private classifyFailure(error: string): ReflectionResult["failureCategory"] {
    if (!error) return "unknown";

    if (TRANSIENT_PATTERNS.some((p) => p.test(error))) {
      return "transient";
    }

    if (ENVIRONMENTAL_PATTERNS.some((p) => p.test(error))) {
      return "environmental";
    }

    if (SYSTEMATIC_PATTERNS.some((p) => p.test(error))) {
      return "systematic";
    }

    return "unknown";
  }

  private isTransientFailure(error: string): boolean {
    if (!error) return false;
    return TRANSIENT_PATTERNS.some((p) => p.test(error));
  }

  private inferRootCause(error: string, trace: ExecutionTrace, category: ReflectionResult["failureCategory"]): string {
    if (!error) {
      const failedSteps = trace.steps.filter((s) => !s.success);
      if (failedSteps.length > 0) {
        return `Step failure: ${failedSteps[failedSteps.length - 1].action} - ${failedSteps[failedSteps.length - 1].result}`;
      }
      return "Unknown root cause: no error message and no failed steps";
    }

    switch (category) {
      case "transient":
        return `Transient failure: ${error.slice(0, 200)}`;
      case "systematic":
        return `Systematic error: ${error.slice(0, 200)}`;
      case "environmental":
        return `Environmental constraint: ${error.slice(0, 200)}`;
      default:
        return `Unclassified failure: ${error.slice(0, 200)}`;
    }
  }

  private generateSuggestions(error: string, trace: ExecutionTrace, category: ReflectionResult["failureCategory"]): string[] {
    const suggestions: string[] = [];

    switch (category) {
      case "transient":
        suggestions.push("Add retry logic with exponential backoff");
        suggestions.push("Implement circuit breaker pattern");
        suggestions.push("Add timeout configuration and fallback behavior");
        break;
      case "systematic":
        suggestions.push("Review and fix the logic error in the skill implementation");
        suggestions.push("Add input validation and error handling");
        suggestions.push("Consider evolving the skill to handle this case correctly");
        break;
      case "environmental":
        suggestions.push("Verify resource availability and permissions");
        suggestions.push("Add pre-flight checks for required resources");
        suggestions.push("Implement graceful degradation for missing resources");
        break;
      default:
        suggestions.push("Investigate the failure with additional logging");
        suggestions.push("Add more detailed error reporting");
        break;
    }

    if (trace.steps.length > 0) {
      const failedSteps = trace.steps.filter((s) => !s.success);
      if (failedSteps.length > 1) {
        suggestions.push("Multiple steps failed - consider reviewing the overall execution strategy");
      }
    }

    return suggestions;
  }
}
