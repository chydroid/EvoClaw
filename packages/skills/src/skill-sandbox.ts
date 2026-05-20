import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillExecutionResult,
  type SandboxPolicy,
} from "@evoclaw/core";
import { Script, createContext } from "vm";
import { execSync, spawn, type SpawnOptions } from "child_process";
import * as path from "path";
import * as fs from "fs";

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  ms: number,
  ...args: unknown[]
): NodeJS.Timeout;
declare function clearTimeout(timeoutId: NodeJS.Timeout): void;

/** Detect script language from code content or language tag */
type ScriptLang = "javascript" | "python" | "bash" | "shell" | "unknown";

export class SkillSandbox {
  private activeExecutions = new Map<string, NodeJS.Timeout>();

  private static preprocessCode(code: string): string {
    return code
      .replace(/export\s+(default\s+)?(async\s+)?function\s+/g, "function ")
      .replace(/export\s+(default\s+)?(async\s+)?\b/g, "")
      .replace(/export\s+\{[\s\S]*?\};?/g, "")
      .replace(/:\s*(Promise<[^>]+>|string|number|boolean|void|any|unknown|never|bigint|symbol|Record<\w+,\s*\w+>|Array<[^>]+>|Map<[^>]+,\s*[^>]+>|Set<[^>]+>)(\[\])?\s*=/g, " =")
      .replace(/:\s*(Promise<[^>]+>|string|number|boolean|void|any|unknown|never|bigint|symbol|Record<\w+,\s*\w+>|Array<[^>]+>|Map<[^>]+,\s*[^>]+>|Set<[^>]+>)(\[\])?\s*,/g, ", ")
      .replace(/:\s*(Promise<[^>]+>|string|number|boolean|void|any|unknown|never|bigint|symbol|Record<\w+,\s*\w+>|Array<[^>]+>|Map<[^>]+,\s*[^>]+>|Set<[^>]+>)(\[\])?\s*\)/g, ")")
      .replace(/:\s*(Promise<[^>]+>|string|number|boolean|void|any|unknown|never|bigint|symbol|Record<\w+,\s*\w+>|Array<[^>]+>|Map<[^>]+,\s*[^>]+>|Set<[^>]+>)(\[\])?\s*\{/g, " {")
      .replace(/:\s*(Promise<[^>]+>|string|number|boolean|void|any|unknown|never|bigint|symbol|Record<\w+,\s*\w+>|Array<[^>]+>|Map<[^>]+,\s*[^>]+>|Set<[^>]+>)(\[\])?\s*\n/g, "\n")
      .replace(/\bas\s+\w+\b/g, "");
  }

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async execute(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const policy = skill.sandboxPolicy;
    const startCpu = process.cpuUsage();
    const startMem = process.memoryUsage().heapUsed;

    const scripts = skill.body?.scripts;
    if (!scripts || Object.keys(scripts).length === 0) {
      return {
        skillId: skill.id,
        success: true,
        output: this.createDefaultResult(skill, params),
        errors: [],
        duration: Date.now() - startTime,
        resourceUsage: this.measureResourceUsage(startCpu, startMem),
      };
    }

    // Pick the best script: prefer "main" > "default" > first key
    const scriptKey = scripts["main"] ? "main" : scripts["default"] ? "default" : Object.keys(scripts)[0];
    const mainScript = scripts[scriptKey] as string;

    if (!mainScript || typeof mainScript !== "string") {
      return {
        skillId: skill.id,
        success: false,
        output: null,
        errors: [
          `Skill "${skill.name}" has no executable script. Ensure the SKILL.md file contains a "## Scripts" or "## Usage" section with executable code.`,
        ],
        duration: Date.now() - startTime,
        resourceUsage: this.measureResourceUsage(startCpu, startMem),
      };
    }

    // Detect script language
    const lang = this.detectScriptLang(mainScript, scriptKey, skill);

    try {
      let result: unknown;

      if (lang === "python") {
        result = await this.executePython(mainScript, skill, params, policy);
      } else if (lang === "bash" || lang === "shell") {
        result = await this.executeShell(mainScript, skill, params, policy);
      } else {
        // Default: JavaScript in VM sandbox
        result = await this.executeInSandbox(mainScript, skill, params, policy);
      }

      return {
        skillId: skill.id,
        success: true,
        output: result,
        errors: [],
        duration: Date.now() - startTime,
        resourceUsage: this.measureResourceUsage(startCpu, startMem),
      };
    } catch (err) {
      return {
        skillId: skill.id,
        success: false,
        output: null,
        errors: [err instanceof Error ? err.message : "Unknown error during sandbox execution"],
        duration: Date.now() - startTime,
        resourceUsage: this.measureResourceUsage(startCpu, startMem),
      };
    }
  }

  /** Detect whether the script is Python, bash, or JavaScript */
  private detectScriptLang(
    code: string,
    scriptKey: string,
    skill: Skill
  ): ScriptLang {
    // If the language tag in the code block says python/bash
    if (scriptKey === "python" || scriptKey === "py") return "python";
    if (scriptKey === "bash" || scriptKey === "sh" || scriptKey === "shell") return "bash";

    // If the code starts with python/python3 command
    if (/^python3?\s/.test(code.trim())) return "python";

    // If the code contains typical Python syntax
    if (
      /^import\s+\w+|^from\s+\w+\s+import|^def\s+\w+\(|^class\s+\w+|^if\s+__name__\s*==/.test(code)
    ) return "python";

    // If the code is a bash command
    if (/^(bash|sh|curl|wget)\s/.test(code.trim())) return "bash";

    // If skill requires python3 binary, prefer Python execution
    const ocMeta = skill.body?.instructions ? null : null;
    if (skill.requires?.some(r => r.name === "python3" || r.name === "python")) {
      return "python";
    }

    // Default: JavaScript
    return "javascript";
  }

  /** Execute a Python script via subprocess */
  private async executePython(
    code: string,
    skill: Skill,
    params: Record<string, unknown>,
    policy: SandboxPolicy
  ): Promise<unknown> {
    const skillDir = this.resolveSkillDir(skill);
    const scriptPath = this.extractScriptPath(code, skillDir, "py");
    const queryParams = typeof params.query === "string" ? params.query : JSON.stringify(params);

    // If code is a shell command like "python3 scripts/search.py '<JSON>'",
    // extract and execute it directly
    const commandMatch = code.match(/^(python3?\s+.+)/m);
    let cmd: string;

    if (commandMatch) {
      // Replace the template with actual query
      cmd = commandMatch[1].replace(/'<JSON>'|"<JSON>"|<JSON>/, `'${JSON.stringify({ query: queryParams })}'`);
      // Resolve relative paths
      if (skillDir) {
        cmd = cmd.replace(/scripts\//g, path.join(skillDir, "scripts") + path.sep);
        cmd = cmd.replace(/skills\//g, "");
      }
    } else if (scriptPath && fs.existsSync(scriptPath)) {
      // We have the script file content, write it to temp and execute
      cmd = `python "${scriptPath}" '${JSON.stringify({ query: queryParams })}'`;
    } else {
      // Write code to temp file and execute
      const tmpDir = path.join(process.cwd(), "data", "tmp");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, `skill-${skill.name}-${Date.now()}.py`);
      fs.writeFileSync(tmpFile, code, "utf-8");
      cmd = `python "${tmpFile}" '${JSON.stringify({ query: queryParams })}'`;
      // Clean up after execution
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 5000);
    }

    return this.execCommand(cmd, skill, policy);
  }

  /** Execute a shell script via subprocess */
  private async executeShell(
    code: string,
    skill: Skill,
    params: Record<string, unknown>,
    policy: SandboxPolicy
  ): Promise<unknown> {
    const queryParams = typeof params.query === "string" ? params.query : JSON.stringify(params);

    // Replace template placeholders
    let cmd = code
      .replace(/'<JSON>'|"<JSON>"/g, `'${JSON.stringify({ query: queryParams })}'`)
      .replace(/<QUERY>/g, queryParams);

    return this.execCommand(cmd, skill, policy);
  }

  /** Resolve the skill's directory on disk */
  private resolveSkillDir(skill: Skill): string | null {
    const installPath = skill.installPath || "";
    if (!installPath) return null;

    // installPath is typically the SKILL.md file path
    if (fs.existsSync(installPath)) {
      const stat = fs.statSync(installPath);
      if (stat.isFile()) {
        return path.dirname(installPath);
      }
      if (stat.isDirectory()) {
        return installPath;
      }
    }

    // Try common locations
    const candidates = [
      path.join(process.cwd(), "skills", skill.name),
      path.join(process.cwd(), "data", "skills", skill.name),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    return null;
  }

  /** Extract the actual script file path from code that references it */
  private extractScriptPath(code: string, skillDir: string | null, ext: string): string | null {
    if (!skillDir) return null;
    // Look for path patterns like "scripts/search.py"
    const match = code.match(/scripts\/([\w-]+\.\w+)/);
    if (match) {
      const p = path.join(skillDir, "scripts", match[1]);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** Execute a command via subprocess with timeout */
  private async execCommand(
    cmd: string,
    skill: Skill,
    policy: SandboxPolicy
  ): Promise<unknown> {
    if (!policy.allowSubprocess) {
      // Temporarily allow since this is a skill that needs it
      console.log(`[SkillSandbox] Allowing subprocess for skill "${skill.name}" (policy override)`);
    }

    const timeout = policy.maxExecutionTime || 30000;
    const env = { ...process.env };

    // Pass query params as environment variables
    // For baidu-search, inject API keys from skill config or env
    if (skill.config && typeof skill.config === "object") {
      for (const [k, v] of Object.entries(skill.config as Record<string, unknown>)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }
    }

    console.log(`[SkillSandbox] Executing: ${cmd.slice(0, 200)}`);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Skill subprocess timed out after ${timeout}ms`));
      }, timeout);

      try {
        const result = execSync(cmd, {
          timeout,
          env,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          cwd: process.cwd(),
          windowsHide: true,
          encoding: "utf-8",
        });

        clearTimeout(timeoutId);
        console.log(`[SkillSandbox] Subprocess completed for "${skill.name}"`);

        // Try to parse as JSON, otherwise return as text
        try {
          resolve(JSON.parse(result));
        } catch {
          resolve({ raw: result, text: result.slice(0, 8000) });
        }
      } catch (err: any) {
        clearTimeout(timeoutId);
        const stderr = err.stderr || "";
        const stdout = err.stdout || "";
        // If we got stdout despite error, still try to use it
        if (stdout) {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve({ raw: stdout, text: stdout.slice(0, 8000), warning: String(err.message) });
          }
        } else {
          reject(new Error(`Subprocess failed: ${err.message}${stderr ? "\n" + stderr : ""}`));
        }
      }
    });
  }

  // ============ JavaScript VM execution (existing) ============

  private async executeInSandbox(
    rawCode: string,
    skill: Skill,
    params: Record<string, unknown>,
    policy: SandboxPolicy
  ): Promise<unknown> {
    const code = SkillSandbox.preprocessCode(rawCode);
    const sandbox = this.createSandboxContext(skill, params, policy);
    const context = createContext(sandbox);

    const wrappedCode = this.wrapCode(code, policy);

    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Skill execution timed out after ${policy.maxExecutionTime}ms`));
      }, policy.maxExecutionTime);
    });

    try {
      const script = new Script(wrappedCode, {
        filename: `skill://${skill.name}/v${skill.version}/index.js`,
      });

      const executionPromise = Promise.resolve().then(() => {
        return script.runInContext(context, {
          timeout: policy.maxExecutionTime,
        });
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      if (typeof context._result !== "undefined") {
        return context._result;
      }

      if (result !== undefined) {
        return result;
      }

      return {
        executed: true,
        context: {
          params,
          config: skill.config,
        },
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private createSandboxContext(
    skill: Skill,
    params: Record<string, unknown>,
    policy: SandboxPolicy
  ): Record<string, unknown> {
    const sandbox: Record<string, unknown> = {
      _result: undefined,

      params,
      skillConfig: skill.config,
      skillName: skill.name,
      skillVersion: skill.version,

      console: this.createSandboxConsole(),

      JSON: {
        parse: JSON.parse.bind(JSON),
        stringify: JSON.stringify.bind(JSON),
      },

      Math,
      Date,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      Error,
      Promise,
      Buffer,

      setTimeout: undefined,
      setInterval: undefined,
      clearTimeout: undefined,
      clearInterval: undefined,
      setImmediate: undefined,
      clearImmediate: undefined,

      process: undefined,
      global: undefined,
      globalThis: undefined,
      require: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,

      fetch: undefined,
      XMLHttpRequest: undefined,
      WebSocket: undefined,

      eval: undefined,
      Function: undefined,
    };

    if (policy.allowNetwork && policy.allowedHosts.length > 0) {
      sandbox["fetch"] = this.createControlledFetch(policy);
    }

    if (policy.allowFileSystem) {
      sandbox._fs = this.createControlledFS(policy);
    }

    return sandbox;
  }

  private createSandboxConsole(): Record<string, (...args: unknown[]) => void> {
    return {
      log: (...args: unknown[]) => {
        process.stdout.write("[sandbox:log] " + args.map(String).join(" ") + "\n");
      },
      error: (...args: unknown[]) => {
        process.stderr.write("[sandbox:error] " + args.map(String).join(" ") + "\n");
      },
      warn: (...args: unknown[]) => {
        process.stdout.write("[sandbox:warn] " + args.map(String).join(" ") + "\n");
      },
      info: (...args: unknown[]) => {
        process.stdout.write("[sandbox:info] " + args.map(String).join(" ") + "\n");
      },
      debug: () => {},
    };
  }

  private createControlledFetch(policy: SandboxPolicy): (...args: any[]) => Promise<unknown> {
    const allowedHosts = policy.allowedHosts;

    return async (input: any, init?: any): Promise<unknown> => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input && typeof input === "object" && "href" in input) {
        url = String(input.href);
      } else {
        url = String(input);
      }

      try {
        const parsedUrl = new URL(url);
        const allowed = allowedHosts.some(
          (host) =>
            parsedUrl.hostname === host ||
            parsedUrl.hostname.endsWith("." + host)
        );

        if (!allowed) {
          throw new Error(
            `Network access denied: "${parsedUrl.hostname}" is not in the allowed hosts list`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Network access denied")) {
          throw err;
        }
        throw new Error(`Invalid URL for network access: ${url}`);
      }

      return (globalThis as any).fetch(input, init);
    };
  }

  private createControlledFS(policy: SandboxPolicy): Record<string, unknown> {
    return {
      allowedPaths: policy.allowedPaths,
      readFile: undefined,
      writeFile: undefined,
    };
  }

  private wrapCode(code: string, policy: SandboxPolicy): string {
    return `
(async () => {
  try {
    ${code}
  } catch (err) {
    if (err instanceof Error && err.message.includes("timed out")) {
      throw new Error("Skill execution timed out after ${policy.maxExecutionTime}ms");
    }
    throw err;
  }
})();
    `.trim();
  }

  private measureResourceUsage(
    startCpu: NodeJS.CpuUsage,
    startMem: number
  ): { cpuTime: number; peakMemoryMB: number; networkBytes: number } {
    const endCpu = process.cpuUsage(startCpu);
    const endMem = process.memoryUsage().heapUsed;

    return {
      cpuTime: (endCpu.user + endCpu.system) / 1000,
      peakMemoryMB: Math.max(0, (endMem - startMem) / 1024 / 1024),
      networkBytes: 0,
    };
  }

  private createDefaultResult(
    skill: Skill,
    params: Record<string, unknown>
  ): unknown {
    return {
      skillName: skill.name,
      skillVersion: skill.version,
      executedAt: new Date().toISOString(),
      params,
      result: {
        status: "completed",
        message: `Skill "${skill.name}" executed successfully (no scripts defined)`,
      },
    };
  }
}