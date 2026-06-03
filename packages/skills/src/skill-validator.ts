import {
  type SKILLmdDocument,
  type SKILLmdMeta,
  type SkillTrigger,
  type Skill,
  type SecurityScanResult,
  type SecurityFinding,
} from "@evoclaw/core";

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;
const NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const VALID_TRIGGER_TYPES: SkillTrigger["type"][] = [
  "keyword",
  "intent",
  "schedule",
  "event",
  "webhook",
];

// Content quality: patterns that indicate placeholder/garbage skill content
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^执行操作(?:。)?$/,
  /^execut(?:e|ing)\s+(?:the\s+)?task/i,
  /^方案\d*$/,
  /^解决[方方]案[ABCDEFG]?(?:方案)?$/,
  /^任务[ABCDEFG]?(?:描述)?$/,
  /^auto-generated/i,
  /^placeholder/i,
  /^te?mp$/i,
  /^follow\s+the\s+steps$/i,
  /^do\s+the\s+thing$/i,
];

const RESERVED_PREFIXES = ["curated-skill", "custom-skill", "new-skill", "test-skill", "temp-"];
const GENERIC_NAMES = ["task", "test", "skill", "tool", "helper", "util", "plugin", "script", "module", "action"];

export class SkillValidator {
  validateManifest(meta: SKILLmdMeta): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!meta.name || meta.name.trim() === "") {
      errors.push("Skill name is required");
    } else if (!NAME_REGEX.test(meta.name)) {
      errors.push(
        `Skill name "${meta.name}" does not follow naming convention (lowercase, starts with letter, alphanumeric and hyphens only)`
      );
    } else {
      if (meta.name.length < 3) {
        warnings.push(`Skill name "${meta.name}" is very short — consider a more descriptive name`);
      }
      if (meta.name.length > 64) {
        errors.push(`Skill name "${meta.name}" exceeds 64 characters`);
      }
      for (const prefix of RESERVED_PREFIXES) {
        if (meta.name.startsWith(prefix)) {
          warnings.push(`Skill name "${meta.name}" starts with reserved prefix "${prefix}" — may indicate an auto-generated placeholder skill`);
          break;
        }
      }
      if (GENERIC_NAMES.includes(meta.name)) {
        warnings.push(`Skill name "${meta.name}" is too generic — consider a more specific name describing the actual workflow`);
      }
    }

    if (!meta.version || meta.version.trim() === "") {
      errors.push("Skill version is required");
    } else if (!SEMVER_REGEX.test(meta.version)) {
      errors.push(
        `Skill version "${meta.version}" is not a valid semver (e.g., 1.0.0)`
      );
    }

    if (!meta.description || meta.description.trim() === "") {
      errors.push("Skill description is required and cannot be empty");
    } else {
      const desc = meta.description.trim();
      if (desc.length < 20) {
        warnings.push(
          `Skill description is very short (${desc.length} chars) — provide a meaningful description of what problem this solves and when to use it`
        );
      }
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(desc)) {
          warnings.push(
            `Skill description "${desc}" appears to be a placeholder — this skill may be auto-generated garbage`
          );
          break;
        }
      }
    }

    if (
      !meta.triggers ||
      !Array.isArray(meta.triggers) ||
      meta.triggers.length === 0
    ) {
      warnings.push("Skill has no triggers defined — it will only be invocable by the LLM based on its description. Consider adding keyword/intent triggers for better discoverability.");
    }

    if (!meta.author || meta.author.trim() === "") {
      errors.push("Skill author is required and cannot be empty");
    } else if (meta.author === "evoclaw-curator") {
      warnings.push(
        "Skill author is 'evoclaw-curator' — this skill may be auto-generated and should be reviewed for quality"
      );
    }

    return { errors, warnings };
  }

  validateTriggers(triggers: SkillTrigger[]): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(triggers)) {
      errors.push("Triggers must be an array");
      return { errors, warnings };
    }

    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i];
      if (!trigger.type || !VALID_TRIGGER_TYPES.includes(trigger.type)) {
        errors.push(
          `Trigger[${i}] has invalid type "${trigger.type}" (must be one of: ${VALID_TRIGGER_TYPES.join(", ")})`
        );
      }
      if (!trigger.pattern || trigger.pattern.trim() === "") {
        errors.push(`Trigger[${i}] has empty pattern`);
      }
    }

    return { errors, warnings };
  }

  validateScripts(scripts: Record<string, string>): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!scripts || typeof scripts !== "object") {
      return { errors, warnings };
    }

    for (const [key, code] of Object.entries(scripts)) {
      if (typeof code !== "string") {
        errors.push(`Script "${key}" is not a string`);
        continue;
      }

      const isTypeScript =
        /:\s*(string|number|boolean|void|any|unknown|Promise|Record|Array)\b/.test(
          code
        ) ||
        /interface\s+\w+/.test(code) ||
        /type\s+\w+\s*=/.test(code);

      if (isTypeScript && !/export\s+(async\s+)?function\s+/.test(code)) {
        warnings.push(
          `TypeScript script "${key}" should contain an export function`
        );
      }
    }

    return { errors, warnings };
  }

  validate(skill: SKILLmdDocument): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const allErrors: string[] = [];
    const allWarnings: string[] = [];

    const manifestResult = this.validateManifest(skill.meta);
    allErrors.push(...manifestResult.errors);
    allWarnings.push(...manifestResult.warnings);

    const triggersResult = this.validateTriggers(skill.meta.triggers);
    allErrors.push(...triggersResult.errors);
    allWarnings.push(...triggersResult.warnings);

    // Validate instructions content quality
    if (skill.instructions && skill.instructions.trim()) {
      const instr = skill.instructions.trim();
      if (instr.length < 50) {
        allWarnings.push(
          `Skill instructions are very short (${instr.length} chars) — provide detailed step-by-step instructions`
        );
      }
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(instr)) {
          allWarnings.push(
            `Skill instructions appear to be a placeholder — this skill may be auto-generated garbage`
          );
          break;
        }
      }
    } else {
      allWarnings.push("Skill has no instructions — add detailed step-by-step instructions for how to use this skill");
    }

    if (skill.scripts && Object.keys(skill.scripts).length > 0) {
      const scriptsResult = this.validateScripts(skill.scripts);
      allErrors.push(...scriptsResult.errors);
      allWarnings.push(...scriptsResult.warnings);
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
    };
  }

  /** Perform a static security scan on a skill */
  securityScan(skill: Skill): SecurityScanResult {
    const findings: SecurityFinding[] = [];

    // Scan scripts for security issues
    if (skill.body?.scripts) {
      for (const [scriptName, scriptContent] of Object.entries(skill.body.scripts)) {
        this.scanScriptForInjection(scriptContent, scriptName, findings);
        this.scanScriptForExfiltration(scriptContent, scriptName, findings);
        this.scanScriptForPrivilegeEscalation(scriptContent, scriptName, findings);
        this.scanScriptForSuspiciousPatterns(scriptContent, scriptName, findings);
      }
    }

    // Scan instructions for suspicious patterns
    if (skill.body?.instructions) {
      this.scanInstructionsForExfiltration(skill.body.instructions, findings);
    }

    // Scan hooks for security issues
    if (skill.body?.hooks) {
      for (const [hookName, hookScript] of Object.entries(skill.body.hooks)) {
        if (hookScript) {
          this.scanScriptForInjection(hookScript, `hook:${hookName}`, findings);
          this.scanScriptForSuspiciousPatterns(hookScript, `hook:${hookName}`, findings);
        }
      }
    }

    // Scan dependencies for supply chain risks
    this.scanDependenciesForSupplyChain(skill, findings);

    // Determine overall risk level
    const riskLevel = this.computeRiskLevel(findings);
    const safe = riskLevel !== "critical";

    return { safe, riskLevel, findings };
  }

  private scanScriptForInjection(content: string, location: string, findings: SecurityFinding[]): void {
    const lines = content.split("\n");

    // Check for unsanitized user input in shell commands
    const shellExecPatterns = [
      { pattern: /exec(?:Sync)?\s*\(\s*[`"'].*\$\{/g, desc: "Unsanitized template literal in exec call — potential command injection" },
      { pattern: /execFile(?:Sync)?\s*\(\s*[`"'].*\$\{/g, desc: "Unsanitized template literal in execFile call — potential command injection" },
      { pattern: /spawn\s*\(\s*[`"'].*\$\{/g, desc: "Unsanitized template literal in spawn call — potential command injection" },
      { pattern: /exec\s*\(\s*[^`"']/g, desc: "Variable passed directly to exec — potential command injection" },
    ];

    for (const { pattern, desc } of shellExecPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            type: "injection",
            severity: "high",
            description: desc,
            location: `${location}:${i + 1}`,
            recommendation: "Use execFile with argument arrays instead of string concatenation, or sanitize all user inputs before passing to shell commands",
          });
        }
      }
    }

    // Check for SQL injection patterns
    const sqlPatterns = [
      { pattern: /(?:query|execute|run)\s*\(\s*[`"'].*\$\{/gi, desc: "Template literal in SQL query — potential SQL injection" },
    ];

    for (const { pattern, desc } of sqlPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            type: "injection",
            severity: "high",
            description: desc,
            location: `${location}:${i + 1}`,
            recommendation: "Use parameterized queries instead of string interpolation",
          });
        }
      }
    }
  }

  private scanScriptForExfiltration(content: string, location: string, findings: SecurityFinding[]): void {
    const lines = content.split("\n");

    // Check for posting data to unknown URLs
    const exfilPatterns = [
      { pattern: /fetch\s*\(\s*[`"']https?:\/\/(?!api\.openai\.com|api\.anthropic\.com|localhost|127\.0\.0\.1)[^`"']+/g, desc: "Network request to potentially untrusted host", severity: "medium" as const },
      { pattern: /axios\.(?:post|put|patch)\s*\(\s*[`"']https?:\/\/(?!api\.openai\.com|api\.anthropic\.com|localhost|127\.0\.0\.1)[^`"']+/g, desc: "Data submission to potentially untrusted host", severity: "medium" as const },
      { pattern: /process\.env/g, desc: "Access to process.env — may exfiltrate environment variables", severity: "low" as const },
      { pattern: /(?:fetch|axios|http\.request)\s*\([^)]*process\.env/s, desc: "Sending environment variables over network — potential data exfiltration", severity: "critical" as const },
    ];

    for (const { pattern, desc, severity } of exfilPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            type: "exfiltration",
            severity,
            description: desc,
            location: `${location}:${i + 1}`,
            recommendation: severity === "critical"
              ? "Never send environment variables over the network. Use specific config values instead."
              : "Review network destinations and ensure only necessary data is transmitted.",
          });
        }
      }
    }
  }

  private scanScriptForPrivilegeEscalation(content: string, location: string, findings: SecurityFinding[]): void {
    const lines = content.split("\n");

    const privPatterns = [
      { pattern: /(?:fs\.(?:readFileSync|writeFileSync|appendFileSync|unlinkSync|rmdirSync|mkdirSync))\s*\(\s*path\.(?:join|resolve)\s*\([^)]*\.\.\//g, desc: "Filesystem access with path traversal (..) — potential privilege escalation", severity: "high" as const },
      { pattern: /fs\.(?:readFileSync|writeFileSync|appendFileSync)\s*\(\s*['"`]\/etc\/|fs\.(?:readFileSync|writeFileSync|appendFileSync)\s*\(\s*['"`]\/var\/|fs\.(?:readFileSync|writeFileSync|appendFileSync)\s*\(\s*['"`]C:\\(?:Windows|Program Files)/g, desc: "Access to system directories — potential privilege escalation", severity: "high" as const },
      { pattern: /chmod|chown|sudo/gi, desc: "Attempt to change file permissions or run as superuser", severity: "high" as const },
      { pattern: /process\.setuid|process\.setgid|process\.initGroups/g, desc: "Attempt to change process privileges", severity: "critical" as const },
    ];

    for (const { pattern, desc, severity } of privPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            type: "privilege_escalation",
            severity,
            description: desc,
            location: `${location}:${i + 1}`,
            recommendation: "Skills should only access files within their own directory. Avoid modifying system files or changing process privileges.",
          });
        }
      }
    }
  }

  private scanScriptForSuspiciousPatterns(content: string, location: string, findings: SecurityFinding[]): void {
    const lines = content.split("\n");

    const suspiciousPatterns = [
      { pattern: /\beval\s*\(/g, desc: "Use of eval() — arbitrary code execution risk", severity: "critical" as const },
      { pattern: /new\s+Function\s*\(/g, desc: "Use of new Function() — arbitrary code execution risk", severity: "critical" as const },
      { pattern: /child_process\.exec\s*\(\s*[^`"']/g, desc: "child_process.exec with non-literal string — command injection risk", severity: "high" as const },
      { pattern: /child_process\.exec\s*\(\s*[`"'].*\+/g, desc: "child_process.exec with string concatenation — command injection risk", severity: "high" as const },
      { pattern: /require\s*\(\s*[^`"']/g, desc: "Dynamic require() — may load arbitrary modules", severity: "medium" as const },
      { pattern: /import\s*\(/g, desc: "Dynamic import() — may load arbitrary modules", severity: "medium" as const },
      { pattern: /vm\.(?:runInNewContext|runInThisContext|compileFunction)/g, desc: "Use of vm module — sandbox escape risk", severity: "high" as const },
      { pattern: /Buffer\s*\.\s*from\s*\([^)]*base64/gi, desc: "Base64 decoding — may decode and execute hidden payloads", severity: "low" as const },
    ];

    for (const { pattern, desc, severity } of suspiciousPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            type: "suspicious_pattern",
            severity,
            description: desc,
            location: `${location}:${i + 1}`,
            recommendation: severity === "critical"
              ? "Remove eval()/Function() usage. Use safer alternatives."
              : "Review this pattern and ensure it cannot be exploited.",
          });
        }
      }
    }
  }

  private scanInstructionsForExfiltration(instructions: string, findings: SecurityFinding[]): void {
    const lines = instructions.split("\n");

    const exfilPatterns = [
      { pattern: /(?:send|post|upload|transmit)\s+(?:the\s+)?(?:environment|env|secrets?|credentials?|tokens?|API\s+keys?)\s+to/gi, desc: "Instructions may direct the AI to exfiltrate sensitive data", severity: "critical" as const },
      { pattern: /(?:send|post|upload|transmit)\s+.*(?:password|secret|token|api[_-]?key)/gi, desc: "Instructions may direct the AI to transmit sensitive data", severity: "high" as const },
    ];

    for (const { pattern, desc, severity } of exfilPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          findings.push({
            type: "exfiltration",
            severity,
            description: desc,
            location: `instructions:${i + 1}`,
            recommendation: "Remove instructions that direct the AI to transmit sensitive data.",
          });
        }
      }
    }
  }

  private scanDependenciesForSupplyChain(skill: Skill, findings: SecurityFinding[]): void {
    if (!skill.requires || skill.requires.length === 0) return;

    for (const dep of skill.requires) {
      const name = dep.name.toLowerCase();

      // Check for suspicious registry references
      if (name.includes("http://") || name.includes("https://") || name.includes("://")) {
        findings.push({
          type: "supply_chain",
          severity: "critical",
          description: `Dependency "${dep.name}" points to a URL instead of a package name — potential supply chain attack`,
          location: "manifest:requires",
          recommendation: "Use only standard package names from official registries (npm, PyPI).",
        });
      }

      // Check for known suspicious package patterns
      if (name.startsWith("@") && name.includes("/") && /^(npm|node|pkg|core-js|lodash-es)-/.test(name.split("/")[1])) {
        findings.push({
          type: "supply_chain",
          severity: "medium",
          description: `Dependency "${dep.name}" may be a typosquatting package — verify it is the intended package`,
          location: "manifest:requires",
          recommendation: "Verify the package name is correct and matches the official package on the registry.",
        });
      }
    }

    // Check sandbox policy for overly permissive network access
    if (skill.sandboxPolicy?.allowNetwork && skill.sandboxPolicy?.allowedHosts?.includes("*")) {
      findings.push({
        type: "supply_chain",
        severity: "high",
        description: "Skill requests wildcard network access (*) — may communicate with any host",
        location: "manifest:sandboxPolicy.allowedHosts",
        recommendation: "Restrict allowedHosts to specific domains required by the skill.",
      });
    }
  }

  private computeRiskLevel(findings: SecurityFinding[]): SecurityScanResult["riskLevel"] {
    if (findings.some(f => f.severity === "critical")) return "critical";
    if (findings.some(f => f.severity === "high")) return "high";
    if (findings.some(f => f.severity === "medium")) return "medium";
    if (findings.some(f => f.severity === "low")) return "low";
    return "low";
  }
}
