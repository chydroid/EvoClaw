import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillDependency,
  type SkillStatus,
} from "@evoclaw/core";
import { SkillRegistry } from "./skill-registry";
import * as semver from "semver";

export interface DependencyCheckResult {
  satisfied: boolean;
  missing: SkillDependency[];
  conflicts: DependencyConflict[];
  resolved: Record<string, Skill>;
  suggestions: DependencySuggestion[];
}

export interface DependencyConflict {
  dependency: SkillDependency;
  required: string;
  installed: string;
  message: string;
}

export interface DependencySuggestion {
  dependency: SkillDependency;
  availableVersion: string;
  source: "local" | "remote";
  confidence: number;
  installPath?: string;
}

export class SkillResolver {
  private resolutionCache = new Map<string, DependencyCheckResult>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    private skillRegistry: SkillRegistry,
    private getSkillFn: (id: string) => Skill | undefined
  ) {}

  async checkDependencies(
    skill: Skill
  ): Promise<DependencyCheckResult> {
    const cacheKey = `${skill.id}@${skill.requires.map((r) => `${r.name}:${r.version}`).join(",")}`;

    const cached = this.resolutionCache.get(cacheKey);
    if (cached) return cached;

    const result = await this.resolveDependencies(skill);
    this.resolutionCache.set(cacheKey, result);

    return result;
  }

  async autoInstall(
    skill: Skill,
    installFn: (path: string) => Promise<Skill>
  ): Promise<{
    success: boolean;
    installed: Skill[];
    failed: SkillDependency[];
    details: string[];
  }> {
    const check = await this.checkDependencies(skill);
    const installed: Skill[] = [];
    const failed: SkillDependency[] = [];
    const details: string[] = [];

    if (check.satisfied) {
      details.push("All dependencies satisfied");
      return { success: true, installed, failed, details };
    }

    for (const missing of check.missing) {
      const suggestion = check.suggestions.find(
        (s) => s.dependency.name === missing.name
      );

      if (suggestion && suggestion.installPath) {
        details.push(
          `Installing ${missing.name}@${suggestion.availableVersion} (from ${suggestion.source})`
        );
        try {
          const installedSkill = await installFn(suggestion.installPath);
          installed.push(installedSkill);
        } catch (err) {
          failed.push(missing);
          details.push(
            `Failed to install "${missing.name}": ${err instanceof Error ? err.message : "unknown error"}`
          );
        }
      } else {
        failed.push(missing);
        details.push(
          `Could not find suitable version of "${missing.name}" (required: ${missing.version})`
        );
      }
    }

    for (const conflict of check.conflicts) {
      details.push(conflict.message);
    }

    return {
      success: failed.length === 0 && check.conflicts.length === 0,
      installed,
      failed,
      details,
    };
  }

  getResolutionGraph(
    skillId: string
  ): {
    nodes: { id: string; name: string; version: string; status: SkillStatus }[];
    edges: { from: string; to: string; type: "requires" | "provides" }[];
  } {
    const skill = this.getSkillFn(skillId);
    if (!skill) return { nodes: [], edges: [] };

    const nodes = [{ id: skill.id, name: skill.name, version: skill.version, status: skill.lifecycle.status }];
    const edges: { from: string; to: string; type: "requires" | "provides" }[] = [];

    const visited = new Set<string>([skill.id]);
    const queue = [skill];

    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const dep of current.requires) {
        const resolvedSkills = this.skillRegistry.searchLocal({ keyword: dep.name });
        const match = resolvedSkills.entries[0];

        if (match) {
          edges.push({ from: current.id, to: match.skillId, type: "requires" });

          if (!visited.has(match.skillId)) {
            visited.add(match.skillId);
            const depSkill = this.getSkillFn(match.skillId);
            if (depSkill) {
              nodes.push({
                id: depSkill.id,
                name: depSkill.name,
                version: depSkill.version,
                status: depSkill.lifecycle.status,
              });
              queue.push(depSkill);
            }
          }
        }
      }
    }

    return { nodes, edges };
  }

  private async resolveDependencies(
    skill: Skill
  ): Promise<DependencyCheckResult> {
    const missing: SkillDependency[] = [];
    const conflicts: DependencyConflict[] = [];
    const resolved: Record<string, Skill> = {};
    const suggestions: DependencySuggestion[] = [];

    for (const dep of skill.requires) {
      const installed = this.findInstalledSkill(dep);

      if (installed) {
        if (this.versionMatches(dep.version, installed.version)) {
          resolved[dep.name] = installed;
        } else {
          conflicts.push({
            dependency: dep,
            required: dep.version,
            installed: installed.version,
            message: `Skill "${skill.name}" requires ${dep.name}@${dep.version}, but ${dep.name}@${installed.version} is installed`,
          });

          const suggestion = await this.findSuggestion(dep);
          if (suggestion) {
            suggestions.push(suggestion);
          }
        }
      } else {
        if (!dep.optional) {
          missing.push(dep);
        }

        const suggestion = await this.findSuggestion(dep);
        if (suggestion) {
          suggestions.push(suggestion);
        }
      }
    }

    const satisfied = missing.length === 0 && conflicts.length === 0;

    return {
      satisfied,
      missing,
      conflicts,
      resolved,
      suggestions,
    };
  }

  private findInstalledSkill(dep: SkillDependency): Skill | undefined {
    const entries = this.skillRegistry.listAllSkills();

    for (const entry of entries) {
      if (entry.name === dep.name) {
        return this.getSkillFn(entry.skillId);
      }
    }

    return undefined;
  }

  private versionMatches(wanted: string, actual: string): boolean {
    try {
      if (wanted === "*" || wanted === "latest") return true;

      const clean = semver.valid(actual);
      if (!clean) {
        // If actual version is not valid semver, do string comparison as fallback
        return actual === wanted;
      }

      return semver.satisfies(clean, wanted);
    } catch {
      return actual === wanted || wanted === "*";
    }
  }

  private async findSuggestion(
    dep: SkillDependency
  ): Promise<DependencySuggestion | null> {
    const local = this.skillRegistry.searchLocal({ keyword: dep.name });

    if (local.entries.length > 0) {
      const entry = local.entries[0];
      const localSkill = this.skillRegistry.getLocalSkill(entry.skillId);
      return {
        dependency: dep,
        availableVersion: entry.version,
        source: "local",
        confidence: 0.9,
        installPath: localSkill?.installPath || undefined,
      };
    }

    try {
      const remote = await this.skillRegistry.searchRemote({ keyword: dep.name, limit: 1 });

      if (remote.entries.length > 0) {
        return {
          dependency: dep,
          availableVersion: remote.entries[0].version,
          source: "remote",
          confidence: 0.7,
          installPath: `remote:${remote.entries[0].name}`,
        };
      }
    } catch {
            console.debug("[SkillResolver] Remote search unavailable for suggestion lookup");
          }

    return null;
  }

  invalidateCache(skillId: string): void {
    // Delete entries where the skillId matches exactly at the start followed by @
    for (const [key] of this.resolutionCache) {
      if (key.startsWith(skillId + "@") || key.startsWith(skillId + ":")) {
        this.resolutionCache.delete(key);
      }
    }
  }
}