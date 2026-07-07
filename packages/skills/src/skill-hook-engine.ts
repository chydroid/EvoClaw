import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillHooks,
} from "@evoclaw/core";
import { SkillSandbox } from "./skill-sandbox";

const DEFAULT_HOOK_TIMEOUT = 10_000;

export class SkillHookEngine {
  private sandbox: SkillSandbox;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.sandbox = new SkillSandbox(registry, eventBus);
  }

  async executeHook(
    skill: Skill,
    hookName: keyof SkillHooks,
    context?: Record<string, unknown>
  ): Promise<void> {
    const hookScript = skill.body?.hooks?.[hookName];
    if (!hookScript || typeof hookScript !== "string") {
      return;
    }

    let timeoutId: NodeJS.Timeout | undefined;

    try {
      const hookSkill = this.createHookSkill(skill, hookScript);
      const params = context || {};

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `Hook "${hookName}" timed out after ${DEFAULT_HOOK_TIMEOUT}ms`
            )
          );
        }, DEFAULT_HOOK_TIMEOUT);
        if (timeoutId.unref) timeoutId.unref();
      });
      const sandboxPromise = this.sandbox.execute(hookSkill, params);
      sandboxPromise.catch(() => {}); // 防止超时后 unhandledRejection

      const result = await Promise.race([
        sandboxPromise,
        timeoutPromise,
      ]);

      if (!result.success) {
        process.stderr.write(
          `[SkillHookEngine] Hook "${hookName}" execution failed for skill "${skill.name}": ${result.errors?.join("; ") || "unknown error"}\n`
        );
      }
    } catch (err) {
      process.stderr.write(
        `[SkillHookEngine] Hook "${hookName}" execution failed for skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}\n`
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private createHookSkill(skill: Skill, hookScript: string): Skill {
    return {
      ...skill,
      sandboxPolicy: {
        ...skill.sandboxPolicy,
        maxExecutionTime: DEFAULT_HOOK_TIMEOUT,
      },
      body: {
        ...skill.body,
        scripts: { main: hookScript },
      },
    };
  }
}
