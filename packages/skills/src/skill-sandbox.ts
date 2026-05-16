import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillExecutionResult,
  type SandboxPolicy,
} from "@evoclaw/core";
import { Script, createContext } from "vm";

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  ms: number,
  ...args: unknown[]
): NodeJS.Timeout;
declare function clearTimeout(timeoutId: NodeJS.Timeout): void;

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

    const mainScript = (scripts.main || scripts.default || scripts[Object.keys(scripts)[0]]) as unknown as string;
    if (!mainScript || typeof mainScript !== "string") {
      return {
        skillId: skill.id,
        success: false,
        output: null,
        errors: [
          `Skill "${skill.name}" has no executable script. ` +
          `Ensure the SKILL.md file contains a "## Scripts" section with at least one code block.`,
        ],
        duration: Date.now() - startTime,
        resourceUsage: this.measureResourceUsage(startCpu, startMem),
      };
    }

    try {
      const result = await this.executeInSandbox(mainScript, skill, params, policy);

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

      // 立即清除超时定时器，防止 Promise.race 结束后超时回调仍触发导致未处理的 rejection 泄漏
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