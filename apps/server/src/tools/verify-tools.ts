/**
 * verify-tools — 项目验证工具（对标 hermes-agent agent/verify/）
 *
 * 提供 verify_project 工具，让 agent 能自主验证一个项目是否真的能跑起来：
 *   1. 静态检测项目框架（package.json/pyproject.toml/go.mod/Cargo.toml/Makefile/docker-compose）
 *   2. 按配方执行 bootstrap → build → test → start → readiness 检查
 *   3. 返回结构化结果（每阶段 exit code、输出尾部、readiness 状态）
 *
 * 安全：路径校验阻止 path traversal；命令来自项目自身配方（同 terminal 工具信任级别）。
 */

import * as path from "path";
import { detectRecipe, runVerify, getRecipe, saveManifest, type Recipe } from "@evoclaw/agent";
import type { AgentModelExecutor } from "@evoclaw/agent";

const DEFAULT_PHASE_TIMEOUT_MS = 600_000; // 10 min
const DEFAULT_READY_TIMEOUT_MS = 60_000; // 1 min

export function registerVerifyTools(
  executor: AgentModelExecutor,
  options?: { workspaceRoot?: string },
): void {
  const workspaceRoot =
    options?.workspaceRoot || path.resolve(__dirname, "..", "..", "..", "..");

  executor.registerTool(
    "verify_project",
    {
      name: "verify_project",
      description:
        "Verify that a project actually works by detecting its framework and running its bootstrap/build/test/start commands. " +
        "Auto-detects Node.js (package.json), Python (pyproject.toml/requirements.txt/manage.py), Go, Rust, Java, Makefile, and docker-compose projects. " +
        "Returns structured results for each phase (exit code, output tail, readiness status). " +
        "Use this to verify code changes actually compile/test/boot — not just that you wrote the code.",
      parameters: {
        projectPath: {
          type: "string",
          description:
            "Path to the project root (optional, default: workspace root). Use relative paths from the workspace.",
        },
        phases: {
          type: "string",
          description:
            "Which phases to run, comma-separated: 'bootstrap,build,test,start' (default: all). " +
            "Omit 'start' to skip booting the server (useful for CI/test-only verification).",
        },
        port: {
          type: "string",
          description: "Override the default port for the start/readiness check.",
        },
        saveManifest: {
          type: "boolean",
          description:
            "Save the detected recipe to .evoclaw/environment.json for future runs (default: false).",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      // ── 路径校验 ──
      const projectPath = params.projectPath ? String(params.projectPath) : "";
      let projectAbs: string;
      if (projectPath) {
        if (projectPath.startsWith("-")) {
          return { success: false, error: "projectPath cannot start with '-'" };
        }
        projectAbs = path.resolve(workspaceRoot, projectPath);
        if (!projectAbs.startsWith(workspaceRoot + path.sep) && projectAbs !== workspaceRoot) {
          return { success: false, error: `Path traversal blocked: ${projectPath}` };
        }
      } else {
        projectAbs = workspaceRoot;
      }

      // ── 检测配方 ──
      const recipe = getRecipe(projectAbs);
      if (!recipe) {
        return {
          success: false,
          error: "No recognized project framework detected. Supported: package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle, Makefile, docker-compose.yml",
        };
      }

      // ── 保存 manifest（可选）──
      if (params.saveManifest === true) {
        try {
          saveManifest(projectAbs, recipe);
        } catch {
          // 保存失败不阻断验证
        }
      }

      // ── 解析阶段 ──
      const phasesParam = params.phases ? String(params.phases) : "";
      const allPhases = ["bootstrap", "build", "test", "start"];
      const selectedPhases = phasesParam.trim()
        ? phasesParam.split(",").map((p) => p.trim()).filter((p) => allPhases.includes(p))
        : allPhases;

      // ── 端口覆盖 ──
      const portOverride = params.port ? parseInt(String(params.port), 10) : undefined;

      // ── 运行验证 ──
      const result = await runVerify(projectAbs, recipe, {
        phases: selectedPhases,
        phaseTimeoutMs: DEFAULT_PHASE_TIMEOUT_MS,
        readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
        portOverride: portOverride && portOverride > 0 && portOverride < 65536 ? portOverride : undefined,
        stopOnFailure: true,
      });

      // ── 结构化返回 ──
      return {
        success: result.phases.every((p) => p.exitCode === 0 && !p.timedOut) &&
          (result.readiness === null || result.readiness.ready),
        recipe: recipe.name,
        kind: recipe.kind,
        phases: result.phases.map((p) => ({
          phase: p.phase,
          command: p.command,
          exitCode: p.exitCode,
          ok: p.exitCode === 0 && !p.timedOut,
          durationMs: Math.round(p.durationMs),
          outputTail: p.outputTail,
        })),
        readiness: result.readiness
          ? {
            url: result.readiness.url,
            ready: result.readiness.ready,
            statusCode: result.readiness.statusCode,
            durationMs: Math.round(result.readiness.durationMs),
            error: result.readiness.error,
          }
          : null,
        evidence: recipe.evidence,
      };
    },
  );
}
