import { ServiceRegistry, EventBus, type SkillExecutionResult } from "@evoclaw/core";
import type { AutoSkillManager, SkillMatch, AutoInstallResult, ProgressCallback } from "./auto-skill-manager";
import type { SkillRegistry, RegistrySearchResult } from "./skill-registry";

export interface DispatchContext {
  task: string;
  sessionId: string;
  userId?: string;
  preferLocal?: boolean;
  allowAutoInstall?: boolean;
  fallbackFn?: () => Promise<unknown>;
}

export interface DispatchResult {
  success: boolean;
  path: "skill" | "web_search" | "fallback" | "none";
  skillName?: string;
  skillId?: string;
  output?: unknown;
  reasoning: string;
  duration: number;
  matchedSkills?: SkillMatch[];
  autoInstallResult?: AutoInstallResult;
  error?: string;
}

export interface DispatchOptions {
  /** Max number of skills to search before deciding */
  maxCandidates?: number;
  /** Min relevance score to trigger auto-install */
  autoInstallThreshold?: number;
  /** Whether to auto-install missing skills */
  autoInstall?: boolean;
  /** Whether to fallback to web_search when no skill matches */
  fallbackToWebSearch?: boolean;
}

const DEFAULT_OPTIONS: DispatchOptions = {
  maxCandidates: 5,
  autoInstallThreshold: 0.25,
  autoInstall: true,
  fallbackToWebSearch: true,
};

export class SkillDispatcher {
  private autoSkillManager: AutoSkillManager | null = null;
  private skillRegistry: SkillRegistry | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("skillDispatcher", this);
  }

  /**
   * Initialize: resolve dependent services.
   */
  initialize(): void {
    this.autoSkillManager = this.registry.resolveService<AutoSkillManager>("autoSkillManager") ?? null;
    this.skillRegistry = this.registry.resolveService<SkillRegistry>("skillRegistry") ?? null;
    
    // Build TF-IDF corpus from existing skills
    this.autoSkillManager?.buildCorpus();
    
    // Fetch remote skills to populate fusion matching
    this.fetchRemoteSkills().catch(err => {
      console.debug("[SkillDispatcher] Initial remote skill fetch failed:", err instanceof Error ? err.message : String(err));
    });

    console.log(`[SkillDispatcher] Initialized — ${this.autoSkillManager ? "AutoSkillManager" : "no AutoSkillManager"}, ${this.skillRegistry ? "SkillRegistry" : "no SkillRegistry"}`);
  }

  /**
   * Main dispatch entry point.
   * 
   * Pipeline: Analyze task → Search local skills (TF-IDF) → Search remote skills →
   * Auto-install best match → Execute → Fallback
   */
  async dispatch(context: DispatchContext, options?: DispatchOptions): Promise<DispatchResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();
    const reasoning: string[] = [];

    reasoning.push(`任务分析: "${context.task.slice(0, 100)}"`);

    // ── Step 1: Search local skills with TF-IDF ──
    if (!this.autoSkillManager) {
      reasoning.push("AutoSkillManager 未初始化，跳过本地搜索");
    } else {
      const localMatches = await this.autoSkillManager.findAllMatches(context.task, opts.maxCandidates!);
      
      if (localMatches.length > 0) {
        reasoning.push(`本地匹配 ${localMatches.length} 个技能`);
        const best = localMatches[0];
        
        if (best.relevance >= opts.autoInstallThreshold!) {
          reasoning.push(`最佳匹配: ${best.skillName} (相关度 ${(best.relevance * 100).toFixed(0)}%)`);
          
          // Check if already installed
          const skillManager = this.registry.resolveService<{
            listSkills(): Array<{ name: string; id: string }>;
            executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
          }>("skillManager");
          
          if (skillManager) {
            const installedSkills = skillManager.listSkills();
            const installed = installedSkills.find(s => s.name === best.skillName);
            
            if (installed) {
              reasoning.push(`技能 "${best.skillName}" 已安装，直接执行`);
              try {
                const result = await skillManager.executeSkill(installed.id, {
                  prompt: context.task,
                  query: context.task,
                });
                return {
                  success: result.success,
                  path: "skill",
                  skillName: best.skillName,
                  skillId: installed.id,
                  output: result.output,
                  reasoning: reasoning.join("\n"),
                  duration: Date.now() - startTime,
                  matchedSkills: localMatches,
                };
              } catch (err) {
                reasoning.push(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
                // Fall through to try other skills or fallback
              }
            } else if (opts.autoInstall) {
              // Auto-install
              reasoning.push(`技能 "${best.skillName}" 未安装，自动安装中...`);
              const installResult = await this.autoSkillManager.autoInstallForTask(context.task);
              
              if (installResult.installed && installResult.skillId) {
                reasoning.push(`安装成功，执行中...`);
                try {
                  const result = await skillManager.executeSkill(installResult.skillId, {
                    prompt: context.task,
                    query: context.task,
                  });
                  return {
                    success: result.success,
                    path: "skill",
                    skillName: installResult.skillName,
                    skillId: installResult.skillId,
                    output: result.output,
                    reasoning: reasoning.join("\n"),
                    duration: Date.now() - startTime,
                    matchedSkills: localMatches,
                    autoInstallResult: installResult,
                  };
                } catch (err) {
                  reasoning.push(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
                }
              } else {
                reasoning.push(`自动安装失败: ${installResult.reason}`);
              }
            }
          }
        } else {
          reasoning.push(`最佳匹配 "${best.skillName}" 相关度过低 (${(best.relevance * 100).toFixed(0)}%)`);
        }
      } else {
        reasoning.push("本地未找到匹配技能");
      }
    }

    // ── Step 2: Search remote skills ──
    if (this.skillRegistry) {
      try {
        // Extract meaningful keywords from the task for remote search
        // rather than sending the full natural-language task text
        const remoteKeyword = this.extractSearchKeywords(context.task);
        if (remoteKeyword) {
          const remoteResult = await this.skillRegistry.searchRemote({
            keyword: remoteKeyword,
            limit: opts.maxCandidates,
            sortBy: "rating",
          });

          if (remoteResult.entries.length > 0) {
            reasoning.push(`远端注册表找到 ${remoteResult.entries.length} 个候选技能`);

            // If auto-install is enabled and we have a good remote match
            if (opts.autoInstall && this.autoSkillManager) {
              // Use enhanced scoring when we have both local and remote
              const topRemote = remoteResult.entries[0];
              const skillName = topRemote.name;

              // Enrich remote skills for matching, then re-match
              this.autoSkillManager.setRemoteSkills(
                remoteResult.entries.map(e => ({
                  name: e.name,
                  description: e.description,
                  keywords: e.keywords,
                }))
              );
              const allMatches = await this.autoSkillManager.findAllMatches(context.task, opts.maxCandidates!);
              const remoteMatch = allMatches.find(m => m.skillName === skillName && m.source === "remote");

              if (remoteMatch && remoteMatch.relevance >= opts.autoInstallThreshold!) {
                reasoning.push(`远端技能 "${skillName}" 匹配 (相关度 ${(remoteMatch.relevance * 100).toFixed(0)}%)，尝试安装`);

                const installResult = await this.autoSkillManager.autoInstallForTask(context.task);
                if (installResult.installed && installResult.skillId) {
                  const skillManager = this.registry.resolveService<{
                    executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
                  }>("skillManager");

                  if (skillManager) {
                    try {
                      const result = await skillManager.executeSkill(installResult.skillId, {
                        prompt: context.task,
                        query: context.task,
                      });
                      return {
                        success: result.success,
                        path: "skill",
                        skillName: installResult.skillName,
                        skillId: installResult.skillId,
                        output: result.output,
                        reasoning: reasoning.join("\n"),
                        duration: Date.now() - startTime,
                        autoInstallResult: installResult,
                      };
                    } catch (err) {
                      reasoning.push(`远端技能执行失败: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                }
              }
            }
          }
        } else {
          reasoning.push("无法从任务中提取有效关键词，跳过远端搜索");
        }
      } catch (err) {
        reasoning.push(`远端搜索失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Step 3: Fallback ──
    // Fallback 1: explicit fallback function
    if (context.fallbackFn) {
      reasoning.push("尝试用户提供的 fallback 函数");
      try {
        const fallbackResult = await context.fallbackFn();
        return {
          success: true,
          path: "fallback",
          output: fallbackResult,
          reasoning: reasoning.join("\n"),
          duration: Date.now() - startTime,
        };
      } catch (err) {
        reasoning.push(`Fallback 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fallback 2: web_search
    if (opts.fallbackToWebSearch) {
      reasoning.push("回退到 web_search");
      try {
        const webSearchFn = this.registry.resolveService<{
          executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
        }>("skillManager");
        
        if (webSearchFn) {
          // Try to find web-search skill
          const skillManager = this.registry.resolveService<{
            listSkills(): Array<{ name: string; id: string }>;
          }>("skillManager");
          
          if (skillManager) {
            const installedSkills = skillManager.listSkills();
            const webSearch = installedSkills.find(
              s => s.name === "web-search" || s.name === "web_search" || s.name === "webSearch" || s.name === "baidu-search"
            );
            
            if (webSearch) {
              const result = await webSearchFn.executeSkill(webSearch.id, {
                query: context.task,
                prompt: context.task,
              });
              
              return {
                success: result.success,
                path: "web_search",
                skillName: webSearch.name,
                skillId: webSearch.id,
                output: result.output,
                reasoning: reasoning.join("\n"),
                duration: Date.now() - startTime,
              };
            }
          }
        }
      } catch (err) {
        reasoning.push(`web_search 回退失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // No path available
    return {
      success: false,
      path: "none",
      reasoning: reasoning.join("\n"),
      duration: Date.now() - startTime,
      error: "无法找到适合的技能处理此任务。请尝试:\n1. 使用 \"安装技能\" 浏览和安装可用技能\n2. 明确描述你的需求\n3. 指定具体的技能名称",
    };
  }

  /**
   * Search for skills matching a task (without executing).
   */
  async searchForTask(taskDescription: string, maxResults = 10): Promise<SkillMatch[]> {
    const allMatches: SkillMatch[] = [];
    
    // Local TF-IDF search
    if (this.autoSkillManager) {
      const local = await this.autoSkillManager.findAllMatches(taskDescription, maxResults);
      allMatches.push(...local);
    }

    // Remote registry search
    if (this.skillRegistry) {
      try {
        const searchKeyword = this.extractSearchKeywords(taskDescription) || taskDescription.slice(0, 50);
        const remote = await this.skillRegistry.searchRemote({
          keyword: searchKeyword,
          limit: maxResults,
          sortBy: "downloads",
        });
        
        if (this.autoSkillManager) {
          // Enrich remote entries with relevance scoring
          this.autoSkillManager.setRemoteSkills(
            remote.entries.map(e => ({
              name: e.name,
              description: e.description,
              keywords: e.keywords,
            }))
          );
        }
        
        for (const entry of remote.entries) {
          if (!allMatches.some(m => m.skillName === entry.name)) {
            allMatches.push({
              skillPath: `remote:${entry.name}`,
              skillName: entry.name,
              relevance: 0.5, // default relevance for remote
              reason: `远端注册表: ${entry.description}`,
              source: "remote",
              description: entry.description,
              keywords: entry.keywords,
            });
          }
        }
      } catch {
        // Remote unavailable — not critical
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    const deduped: SkillMatch[] = [];
    for (const m of allMatches) {
      if (!seen.has(m.skillName)) {
        seen.add(m.skillName);
        deduped.push(m);
      }
    }

    deduped.sort((a, b) => b.relevance - a.relevance);
    return deduped.slice(0, maxResults);
  }

  /**
   * Install and execute a specific skill by name.
   */
  async installAndExecute(
    skillName: string,
    task: string,
    onProgress?: ProgressCallback
  ): Promise<DispatchResult> {
    const startTime = Date.now();
    const reasoning: string[] = [];

    if (!this.autoSkillManager) {
      return {
        success: false,
        path: "none",
        reasoning: "AutoSkillManager 未初始化",
        duration: Date.now() - startTime,
        error: "技能管理器不可用",
      };
    }

    // Install
    const installResult = await this.autoSkillManager.batchInstall([skillName], onProgress);

    if (installResult.success.length === 0) {
      return {
        success: false,
        path: "none",
        reasoning: `安装 "${skillName}" 失败: ${installResult.failed[0]?.reason || "未知错误"}`,
        duration: Date.now() - startTime,
        error: installResult.failed[0]?.reason || "安装失败",
      };
    }

    const installed = installResult.success[0];
    reasoning.push(`已安装: ${installed.skillName}`);

    // Find and execute
    const skillManager = this.registry.resolveService<{
      listSkills(): Array<{ name: string; id: string }>;
      executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
    }>("skillManager");

    if (skillManager) {
      const skills = skillManager.listSkills();
      const match = skills.find(s => s.name === installed.skillName);
      
      if (match) {
        reasoning.push("执行中...");
        try {
          const result = await skillManager.executeSkill(match.id, {
            prompt: task,
            query: task,
          });
          
          return {
            success: result.success,
            path: "skill",
            skillName: installed.skillName,
            skillId: match.id,
            output: result.output,
            reasoning: reasoning.join("\n"),
            duration: Date.now() - startTime,
          };
        } catch (err) {
          return {
            success: false,
            path: "skill",
            skillName: installed.skillName,
            skillId: match.id,
            reasoning: reasoning.join("\n"),
            duration: Date.now() - startTime,
            error: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    return {
      success: true,
      path: "skill",
      skillName: installed.skillName,
      reasoning: `${reasoning.join("\n")} (已安装，等待下次调用执行)`,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Get a summary of all discoverable skills (local + remote).
   */
  async getSkillSummary(): Promise<{
    local: Array<{ name: string; description: string; version: string }>;
    remote: Array<{ name: string; description: string; rating: number; downloads: number }>;
    installed: Array<{ name: string; id: string }>;
  }> {
    const local = this.autoSkillManager?.listDiscoverableSkills() || [];
    const remote: Array<{ name: string; description: string; rating: number; downloads: number }> = [];
    
    if (this.skillRegistry) {
      try {
        const result = await this.skillRegistry.searchRemote({ limit: 20, sortBy: "downloads" });
        for (const entry of result.entries) {
          remote.push({
            name: entry.name,
            description: entry.description,
            rating: entry.rating,
            downloads: entry.downloads,
          });
        }
      } catch {
        // Remote unavailable
      }
    }

    const skillManager = this.registry.resolveService<{
      listSkills(): Array<{ name: string; id: string }>;
    }>("skillManager");
    const installed = skillManager?.listSkills() || [];

    return { local, remote, installed };
  }

  // ── Private ──

  /**
   * Extract concise keywords from natural-language task description
   * for use with remote registry search APIs.
   * E.g., "帮我查一下今天天气怎么样" → "天气"
   * E.g., "search for latest AI news" → "news search"
   */
  private extractSearchKeywords(task: string): string {
    const lower = task.toLowerCase();

    // Chinese keyword extraction: look for common task indicators
    const cnPatterns: Array<{ regex: RegExp; keyword: string }> = [
      { regex: /天气|气温|下雨|刮风/, keyword: "weather" },
      { regex: /新闻|热搜|热点|资讯/, keyword: "news" },
      { regex: /翻译|translate/, keyword: "translator" },
      { regex: /邮件|email|邮箱|发邮件/, keyword: "email" },
      { regex: /搜索|查找|搜索一下|查一下|找一下|搜一下/, keyword: "search" },
      { regex: /计算|算一下|等于|数学/, keyword: "calculator" },
      { regex: /文件|文件夹|目录|file|folder/, keyword: "file" },
      { regex: /提醒|闹钟|定时|remind/, keyword: "reminder" },
      { regex: /代码|code|编程|运行|执行/, keyword: "code" },
      { regex: /图片|图像|生成图|image|picture/, keyword: "image" },
      { regex: /pdf|文档|doc/, keyword: "pdf" },
      { regex: /数据库|database|sql/, keyword: "database" },
      { regex: /加密|货币|bitcoin|btc|eth/, keyword: "crypto" },
      { regex: /rss|订阅/, keyword: "rss" },
      { regex: /markdown|md/, keyword: "markdown" },
      { regex: /http|api|请求|request/, keyword: "http" },
    ];

    for (const { regex, keyword } of cnPatterns) {
      if (regex.test(lower)) return keyword;
    }

    // English: extract the most meaningful word pair
    const words = lower
      .replace(/[，。！？、；：（）【】《》""'']/g, " ")
      .split(/[\s,.;:!?()]+/)
      .filter(w => w.length >= 3 && !["the", "and", "for", "get", "how", "can", "you", "what", "when", "where", "帮我", "一下", "一个", "这个", "那个", "哪个", "怎么", "什么", "为什么"].includes(w));

    // Return up to 3 most meaningful words
    if (words.length > 0) {
      return words.slice(0, 3).join(" ");
    }

    return "";
  }

  private async fetchRemoteSkills(): Promise<void> {
    if (!this.skillRegistry || !this.autoSkillManager) return;

    try {
      const result = await this.skillRegistry.searchRemote({ limit: 50, sortBy: "downloads" });
      if (result.entries.length > 0) {
        this.autoSkillManager.setRemoteSkills(
          result.entries.map(e => ({
            name: e.name,
            description: e.description,
            keywords: e.keywords,
          }))
        );
        console.log(`[SkillDispatcher] Fetched ${result.entries.length} remote skills`);
      }
    } catch (err) {
      console.debug("[SkillDispatcher] Remote skill fetch unavailable:", err instanceof Error ? err.message : String(err));
    }
  }

  async refreshRemoteSkills(): Promise<void> {
    await this.fetchRemoteSkills();
  }

  async healthCheck(): Promise<boolean> {
    return this.autoSkillManager !== null;
  }
}