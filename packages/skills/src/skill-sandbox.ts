import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillExecutionResult,
  type SandboxPolicy,
} from "@evoclaw/core";
import { Script, createContext } from "vm";
import { spawn } from "child_process";
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
    if (skill.requires?.some(r => r.name === "python3" || r.name === "python")) {
      return "python";
    }

    // Default: JavaScript
    return "javascript";
  }

  /** Resolve the Python binary name, preferring python3 over python */
  private resolvePythonBin(): string {
    const { execSync } = require("child_process");

    // Check python3 first (common on Linux/macOS)
    try {
      execSync("python3 --version", { stdio: "pipe", timeout: 3000 });
      return "python3";
    } catch {
      // Fall back to python
      try {
        execSync("python --version", { stdio: "pipe", timeout: 3000 });
        return "python";
      } catch {
        // Search common installation locations
        const candidates = this.findPythonCandidates();
        for (const candidate of candidates) {
          try {
            execSync(`"${candidate}" --version`, { stdio: "pipe", timeout: 5000 });
            process.stdout.write(`[SkillSandbox] Python auto-discovered at: ${candidate}`);
            return candidate;
          } catch {
            // Not executable, skip
          }
        }
        process.stderr.write("[SkillSandbox] Neither python3 nor python found in PATH, and auto-discovery found nothing");
        return "python3"; // Default to python3, will fail with clear error
      }
    }
  }

  /** Search common Python installation locations */
  private findPythonCandidates(): string[] {
    const candidates: string[] = [];
    const fsMod = require("fs");
    const pathMod = require("path");

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || "";
      const userProfile = process.env.USERPROFILE || "";
      const searchRoots = [localAppData, userProfile].filter(Boolean);

      for (const root of searchRoots) {
        const pythonDir = pathMod.join(root, "Programs", "Python");
        try {
          const entries = fsMod.readdirSync(pythonDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && /^Python\d+/.test(entry.name)) {
              const exePath = pathMod.join(pythonDir, entry.name, "python.exe");
              if (fsMod.existsSync(exePath)) {
                candidates.push(exePath);
              }
            }
          }
        } catch { /* ignore */ }
      }

      // Also check common system locations
      const systemPaths = [
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
      ];
      for (const p of systemPaths) {
        if (fsMod.existsSync(p)) candidates.push(p);
      }
    } else {
      const unixPaths = [
        "/usr/bin/python3",
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
        "/opt/local/bin/python3",
      ];
      for (const p of unixPaths) {
        if (fsMod.existsSync(p)) candidates.push(p);
      }
    }

    return candidates;
  }

  /** Execute a Python script via subprocess */
  private async executePython(
    code: string,
    skill: Skill,
    params: Record<string, unknown>,
    policy: SandboxPolicy
  ): Promise<unknown> {
    if (!policy.allowSubprocess) {
      throw new Error(`Skill "${skill.name}" requires subprocess execution but sandbox policy denies it`);
    }

    const skillDir = this.resolveSkillDir(skill);

    let scriptFile: string | null = null;
    let args: string[];
    let tmpFile: string | null = null;

    const scriptPath = this.extractScriptPath(code, skillDir, "py");
    if (scriptPath && fs.existsSync(scriptPath)) {
      scriptFile = scriptPath;
      // 将用户参数映射为 Python 脚本的命令行参数
      args = [scriptFile, ...this.buildCliArgs(params)];
    } else {
      const tmpDir = path.join(process.cwd(), "data", "tmp");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const safeName = skill.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      tmpFile = path.join(tmpDir, `skill-${safeName}-${Date.now()}.py`);
      const cleanCode = code.replace(/^python3?\s+\S+\s*/m, "").trim();
      fs.writeFileSync(tmpFile, cleanCode || code, "utf-8");
      scriptFile = tmpFile;
      // 对于内联脚本，传递完整参数作为 JSON
      const jsonArgs = JSON.stringify(params);
      args = [tmpFile, jsonArgs];
    }

    const timeout = policy.maxExecutionTime || 30000;
    const env = { ...process.env };
    if (skill.config && typeof skill.config === "object") {
      for (const [k, v] of Object.entries(skill.config as Record<string, unknown>)) {
        if (typeof v === "string" && !k.startsWith("_")) env[k] = v;
      }
    }

    // Prefer python3, fall back to python
    const pythonBin = this.resolvePythonBin();

    process.stdout.write(`[SkillSandbox] Executing Python: ${scriptFile}`);

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, args, {
          timeout,
          env,
          cwd: skillDir || process.cwd(),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

        const timeoutId = setTimeout(() => {
          child.kill();
          reject(new Error(`Python execution timed out after ${timeout}ms`));
        }, timeout);

        child.on("close", (code) => {
          clearTimeout(timeoutId);
          if (code === 0) {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              resolve({ raw: stdout, text: stdout.slice(0, 8000) });
            }
          } else {
            reject(new Error(`Python execution failed (exit ${code}): ${stderr || "no output"}`));
          }
        });

        child.on("error", (err) => {
          clearTimeout(timeoutId);
          reject(new Error(`Python execution error: ${err.message}`));
        });
      });
    } finally {
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch { }
      }
    }
  }

  /** Execute a shell script via subprocess */
  private async executeShell(
    code: string,
    skill: Skill,
    params: Record<string, unknown>,
    policy: SandboxPolicy
  ): Promise<unknown> {
    const queryParams = typeof params.query === "string" ? params.query : JSON.stringify(params);

    // Replace template placeholders with proper shell escaping
    const jsonPayload = JSON.stringify({ query: queryParams });
    // Escape single quotes for safe insertion into single-quoted shell argument
    const escapedJson = jsonPayload.replace(/'/g, "'\\''");
    // Escape shell-special characters in QUERY value
    const escapedQuery = queryParams.replace(/'/g, "'\\''").replace(/\\/g, "\\\\");

    let cmd = code
      .replace(/'<JSON>'|"<JSON>"/g, `'${escapedJson}'`)
      .replace(/<QUERY>/g, `'${escapedQuery}'`);

    const dangerousPatterns = [
      /\$\(/,           // Command substitution $()
      /`/,              // Backtick command substitution
      /&&/,             // Command chaining AND
      /\|\|/,           // Command chaining OR
      /\|(?!\|)/,       // Pipe (single |, not ||)
      /;(?!\s*$)/,      // Semicolon command separator
      />(?!\>)/,        // Output redirection >
      />>/,             // Append redirection >>
      /</,              // Input redirection <
      /\n/,             // Newline injection
      /\r/,             // Carriage return injection
      /\b(rm|del|format|shutdown|reboot|wget|curl)\b\s+/i,  // Dangerous commands
    ];
    for (const pat of dangerousPatterns) {
      if (pat.test(cmd)) {
        throw new Error(`[SkillSandbox] Command blocked by security policy: contains potentially dangerous pattern`);
      }
    }

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
      throw new Error(`Skill "${skill.name}" requires subprocess execution but sandbox policy denies it`);
    }

    const timeout = policy.maxExecutionTime || 30000;
    const env = { ...process.env };

    // Pass skill config as environment variables
    if (skill.config && typeof skill.config === "object") {
      for (const [k, v] of Object.entries(skill.config as Record<string, unknown>)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }
    }

    process.stdout.write(`[SkillSandbox] Executing: ${cmd.slice(0, 200)}`);

    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      const shell = isWindows ? "cmd" : "/bin/sh";
      const shellArg = isWindows ? "/c" : "-c";

      const child = spawn(shell, [shellArg, cmd], {
        timeout,
        env,
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        child.kill();
        reject(new Error(`Skill subprocess timed out after ${timeout}ms`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve({ raw: stdout, text: stdout.slice(0, 8000) });
          }
        } else {
          reject(new Error(`Subprocess failed (exit ${code}): ${stderr || "no output"}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`Subprocess error: ${err.message}`));
      });
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
      executionPromise.catch(() => {}); // Prevent unhandled rejection if timeout wins the race

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

    if (policy.allowNetwork && (policy.allowedHosts || []).length > 0) {
      sandbox["fetch"] = this.createControlledFetch(policy);
    }

    if (policy.allowFileSystem) {
      const skillDir = this.resolveSkillDir(skill) || undefined;
      sandbox._fs = this.createControlledFS(policy, skillDir);
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
        // 支持通配符 "*" 允许所有主机
        const allowed = allowedHosts.includes("*") ||
          allowedHosts.some(
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

  private createControlledFS(policy: SandboxPolicy, skillDir?: string): Record<string, unknown> {
  const allowedPaths = policy.allowedPaths || [];
  const isAllowed = (filePath: string): boolean => {
    if (allowedPaths.length === 0 && !skillDir) return false;
    const resolved = path.resolve(filePath);
    // Always allow access to the skill's own install directory
    if (skillDir && resolved.startsWith(path.resolve(skillDir) + path.sep)) return true;
    if (skillDir && resolved === path.resolve(skillDir)) return true;
    if (allowedPaths.length === 0) return false;
    return allowedPaths.some(allowed => {
      const resolvedAllowed = path.resolve(allowed);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
    });
  };

  return {
    allowedPaths,
    readFile: (filePath: string, encoding?: BufferEncoding): string | null => {
      if (!isAllowed(filePath)) {
        throw new Error(`File access denied: "${filePath}" is not in allowed paths`);
      }
      try {
        return fs.readFileSync(filePath, encoding || "utf-8");
      } catch (err) {
        throw new Error(`Failed to read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    writeFile: (filePath: string, content: string, encoding?: BufferEncoding): void => {
      if (!isAllowed(filePath)) {
        throw new Error(`File access denied: "${filePath}" is not in allowed paths`);
      }
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, encoding || "utf-8");
      } catch (err) {
        throw new Error(`Failed to write file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    listDir: (dirPath: string): string[] | null => {
      if (!isAllowed(dirPath)) {
        throw new Error(`Directory access denied: "${dirPath}" is not in allowed paths`);
      }
      try {
        return fs.readdirSync(dirPath);
      } catch (err) {
        throw new Error(`Failed to list directory "${dirPath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    exists: (filePath: string): boolean => {
      if (!isAllowed(filePath)) return false;
      return fs.existsSync(filePath);
    },
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

  private async createDefaultResult(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<unknown> {
    // Check if the skill has command templates in its instructions
    // (e.g., `python3 {baseDir}/scripts/xxx.py` in SKILL.md)
    const instructions = skill.body?.instructions || "";
    const commandLines = this.extractCommandTemplates(instructions);

    if (commandLines.length > 0) {
      // Enforce sandbox policy - same check as executePython/execCommand
      const policy = skill.sandboxPolicy;
      if (!policy.allowSubprocess) {
        return {
          skillName: skill.name,
          skillVersion: skill.version,
          executedAt: new Date().toISOString(),
          params,
          result: {
            status: "error",
            message: `Skill "${skill.name}" requires subprocess execution but sandbox policy denies it. Use shell_exec tool instead.`,
          },
        };
      }

      // 选择最佳命令模板：根据用户参数中的 action/command 匹配
      const selectedCmd = this.selectBestCommand(commandLines, params);
      const skillDir = skill.installPath
        ? require("path").dirname(skill.installPath)
        : "";
      const resolvedCmd = selectedCmd.replace(/\{baseDir\}/g, skillDir);

      try {
        const { execFile } = require("child_process");
        const pythonBin = this.resolvePythonBin();
        // Replace python3 with the resolved python path
        const finalCmd = resolvedCmd.replace(/^python3\b/, pythonBin).replace(/^python\b/, pythonBin);

        // 将用户参数注入到命令行中
        const cmdWithParams = this.injectParamsToCommand(finalCmd, params);

        // Use async execFile to avoid blocking the event loop
        // Split command into program and args to avoid shell injection with shell:true
        const cmdParts = cmdWithParams.split(/\s+/);
        const program = cmdParts[0];
        const cmdArgs = cmdParts.slice(1);
        const result = await new Promise<string>((resolve, reject) => {
          const child = execFile(program, cmdArgs, {
            cwd: skillDir || undefined,
            timeout: 30000,
            encoding: "utf-8",
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            windowsHide: true,
          }, (err: Error | null, stdout: string, stderr: string) => {
            if (err) { reject(err); } else { resolve(stdout); }
          });
        });
        return {
          skillName: skill.name,
          skillVersion: skill.version,
          executedAt: new Date().toISOString(),
          params,
          result: {
            status: "completed",
            data: result.slice(0, 8000),
          },
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          skillName: skill.name,
          skillVersion: skill.version,
          executedAt: new Date().toISOString(),
          params,
          result: {
            status: "error",
            message: `Command execution failed: ${errMsg.slice(0, 500)}`,
          },
        };
      }
    }

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

  /** Extract command templates from SKILL.md instructions */
  private extractCommandTemplates(instructions: string): string[] {
    const commands: string[] = [];
    const codeBlockRegex = /```(?:bash|shell|sh)?\s*\n([\s\S]*?)```/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = codeBlockRegex.exec(instructions)) !== null) {
      const block = blockMatch[1];
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && (
          trimmed.startsWith("python") ||
          trimmed.startsWith("node ") ||
          trimmed.startsWith("bash ") ||
          trimmed.startsWith("sh ")
        )) {
          commands.push(trimmed);
        }
      }
    }
    return commands;
  }

  /** 将 params 对象构建为 CLI 参数数组（如 --code 600519 --market 1） */
  private buildCliArgs(params: Record<string, unknown>): string[] {
    const args: string[] = [];
    // 如果有 action/command 子命令，放在最前面
    const action = params.action || params.command || params.subcommand;
    if (typeof action === "string") {
      args.push(action);
    }
    for (const [key, value] of Object.entries(params)) {
      if (key === "action" || key === "command" || key === "subcommand" || key === "query") continue;
      if (value === undefined || value === null) continue;
      const strValue = String(value);
      args.push(`--${key}`, strValue);
    }
    return args;
  }

  /** 根据用户参数选择最佳命令模板 */
  private selectBestCommand(commandLines: string[], params: Record<string, unknown>): string {
    if (commandLines.length === 0) return "";
    if (commandLines.length === 1) return commandLines[0];

    const action = String(params.action || params.command || params.subcommand || "").toLowerCase();
    const query = String(params.query || "").toLowerCase();

    // 尝试根据 action 匹配命令模板
    if (action) {
      for (const cmd of commandLines) {
        const cmdLower = cmd.toLowerCase();
        // 匹配子命令：如 "info" 匹配 "market_query.py info"
        if (cmdLower.includes(` ${action} `) || cmdLower.includes(` ${action}--`) || cmdLower.endsWith(` ${action}`)) {
          return cmd;
        }
      }
    }

    // 尝试根据 query 意图匹配
    const intentKeywords: Record<string, string[]> = {
      info: ["详情", "行情", "信息", "detail", "info", "quote", "价格", "股价"],
      fund: ["资金", "流向", "fund", "flow", "流入", "流出"],
      ranking: ["排行", "涨幅", "跌幅", "排名", "ranking", "top", "榜"],
      history: ["历史", "走势", "history", "k线", "日线"],
      related: ["板块", "关联", "related", "所属", "概念"],
      indicators: ["指标", "财务", "indicators", "fundamental"],
      income: ["利润", "营收", "income", "利润表"],
      cashflow: ["现金流", "cashflow", "现金"],
      balance: ["资产负债", "balance", "资产表"],
      hot_rank: ["热榜", "热门", "hot", "rank"],
      topic: ["专题", "资讯", "topic", "新闻"],
    };

    for (const [intent, keywords] of Object.entries(intentKeywords)) {
      if (keywords.some(kw => query.includes(kw))) {
        for (const cmd of commandLines) {
          const cmdLower = cmd.toLowerCase();
          if (cmdLower.includes(` ${intent} `) || cmdLower.includes(` ${intent}--`) || cmdLower.endsWith(` ${intent}`)) {
            return cmd;
          }
        }
      }
    }

    // 回退到第一个命令模板
    return commandLines[0];
  }

  /** 将用户参数注入到命令模板中（替换已有参数值或追加新参数） */
  private injectParamsToCommand(cmd: string, params: Record<string, unknown>): string {
    let result = cmd;
    const action = params.action || params.command || params.subcommand;

    for (const [key, value] of Object.entries(params)) {
      if (key === "action" || key === "command" || key === "subcommand" || key === "query") continue;
      if (value === undefined || value === null) continue;
      const strValue = String(value);

      // 检查命令中是否已有该参数
      const paramRegex = new RegExp(`--${key}(?:\\s+|=)(\\S*)`);
      if (paramRegex.test(result)) {
        // 替换已有参数值
        result = result.replace(paramRegex, `--${key} ${strValue}`);
      } else {
        // 追加新参数（在 action 子命令之后）
        if (action && typeof action === "string") {
          const actionIdx = result.indexOf(` ${action} `);
          if (actionIdx !== -1) {
            const afterAction = actionIdx + action.length + 1;
            // 找到 action 后第一个 -- 参数的位置
            const nextParamIdx = result.indexOf(" --", afterAction);
            if (nextParamIdx !== -1) {
              result = result.slice(0, nextParamIdx) + ` --${key} ${strValue}` + result.slice(nextParamIdx);
            } else {
              result += ` --${key} ${strValue}`;
            }
          } else {
            result += ` --${key} ${strValue}`;
          }
        } else {
          result += ` --${key} ${strValue}`;
        }
      }
    }
    return result;
  }
}