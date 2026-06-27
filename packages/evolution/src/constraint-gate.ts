import type { EvolutionCandidate } from "@evoclaw/core";

export interface ConstraintGateConfig {
  maxSkillSizeBytes: number;
  maxToolDescriptionChars: number;
  semanticSimilarityThreshold: number;
  requireTestPass: boolean;
}

export interface GateResult {
  passed: boolean;
  gateName: string;
  reason?: string;
  score?: number;
}

const DEFAULT_CONFIG: ConstraintGateConfig = {
  maxSkillSizeBytes: 15360,
  maxToolDescriptionChars: 500,
  semanticSimilarityThreshold: 0.7,
  requireTestPass: true,
};

export class ConstraintGate {
  private config: ConstraintGateConfig;

  constructor(config?: Partial<ConstraintGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async validate(candidate: EvolutionCandidate): Promise<{ passed: boolean; results: GateResult[] }> {
    const results: GateResult[] = [
      this.sizeGate(candidate),
      this.descriptionGate(candidate),
      this.semanticGate(candidate),
      this.compatibilityGate(candidate),
      this.transientFailureGate(candidate),
    ];

    const passed = results.every((r) => r.passed);
    return { passed, results };
  }

  private sizeGate(candidate: EvolutionCandidate): GateResult {
    const totalSize = candidate.codeArtifacts.reduce(
      (sum, artifact) => {
        const sourceSize = artifact.source
          ? Buffer.byteLength(artifact.source, "utf-8")
          : 0;
        // `tests` is optional on CodeArtifact; coerce safely so a missing
        // field doesn't throw a TypeError that would block the whole gate.
        const testsSize = artifact.tests
          ? Buffer.byteLength(artifact.tests, "utf-8")
          : 0;
        return sum + sourceSize + testsSize;
      },
      0
    );

    const maxSize = this.config.maxSkillSizeBytes;
    if (maxSize <= 0) {
      return { passed: true, gateName: "size", score: 0 };
    }
    if (totalSize <= maxSize) {
      return { passed: true, gateName: "size", score: totalSize / maxSize };
    }

    return {
      passed: false,
      gateName: "size",
      reason: `Skill size ${totalSize} bytes exceeds maximum ${maxSize} bytes`,
      score: totalSize / maxSize,
    };
  }

  private descriptionGate(candidate: EvolutionCandidate): GateResult {
    const provides = candidate.proposedChanges.skillManifest?.provides;
    if (!provides || provides.length === 0) {
      return { passed: true, gateName: "description" };
    }

    const oversized = provides.filter(
      (cap) => cap.description && cap.description.length > this.config.maxToolDescriptionChars
    );

    if (oversized.length === 0) {
      return { passed: true, gateName: "description" };
    }

    return {
      passed: false,
      gateName: "description",
      reason: `${oversized.length} tool description(s) exceed maximum ${this.config.maxToolDescriptionChars} characters`,
    };
  }

  private semanticGate(candidate: EvolutionCandidate): GateResult {
    const description = candidate.proposedChanges.description;
    if (!description) {
      return { passed: false, gateName: "semantic", reason: "No description provided for semantic analysis" };
    }

    const codeTerms = new Set<string>();
    for (const artifact of candidate.codeArtifacts) {
      const identifiers = artifact.source.match(/\b[a-zA-Z_]\w{2,}\b/g) || [];
      for (const id of identifiers) {
        codeTerms.add(id.toLowerCase());
      }
    }

    const descriptionTerms = new Set<string>();
    const words = description.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    for (const word of words) {
      descriptionTerms.add(word);
    }

    if (descriptionTerms.size === 0) {
      return { passed: false, gateName: "semantic", reason: "No meaningful terms found in description", score: 0 };
    }

    let matched = 0;
    for (const term of descriptionTerms) {
      if (codeTerms.has(term)) {
        matched++;
      }
    }

    const similarity = matched / descriptionTerms.size;

    if (similarity >= this.config.semanticSimilarityThreshold) {
      return { passed: true, gateName: "semantic", score: similarity };
    }

    return {
      passed: false,
      gateName: "semantic",
      reason: `Semantic similarity ${similarity.toFixed(2)} below threshold ${this.config.semanticSimilarityThreshold}`,
      score: similarity,
    };
  }

  private compatibilityGate(candidate: EvolutionCandidate): GateResult {
    const provides = candidate.proposedChanges.skillManifest?.provides;
    if (!provides || provides.length === 0) {
      return { passed: true, gateName: "compatibility" };
    }

    for (const cap of provides) {
      if (!cap.name) {
        return {
          passed: false,
          gateName: "compatibility",
          reason: `Capability missing name field`,
        };
      }

      if (cap.schema && typeof cap.schema !== "object") {
        return {
          passed: false,
          gateName: "compatibility",
          reason: `Capability "${cap.name}" has invalid schema`,
        };
      }
    }

    return { passed: true, gateName: "compatibility" };
  }

  private transientFailureGate(candidate: EvolutionCandidate): GateResult {
    const transientPatterns = [
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
    ];

    const instructions = candidate.codeArtifacts
      .map((a) => a.source)
      .join("\n");

    const description = candidate.proposedChanges.description || "";

    const combinedText = `${instructions}\n${description}`;

    const matchedPatterns: string[] = [];
    for (const pattern of transientPatterns) {
      if (pattern.test(combinedText)) {
        matchedPatterns.push(pattern.source);
      }
    }

    if (matchedPatterns.length === 0) {
      return { passed: true, gateName: "transient_failure" };
    }

    return {
      passed: false,
      gateName: "transient_failure",
      reason: `Candidate encodes transient failure patterns as permanent: ${matchedPatterns.join(", ")}`,
    };
  }
}
