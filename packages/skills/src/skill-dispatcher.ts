import { ServiceRegistry, EventBus, type SkillExecutionResult, type Skill } from "@evoclaw/core";
import type { AutoSkillManager, SkillMatch, AutoInstallResult, ProgressCallback } from "./auto-skill-manager";
import type { SkillRegistry, RegistrySearchResult } from "./skill-registry";
import type { SkillCircuitBreaker } from "./skill-circuit-breaker";
import type { SkillCapabilityEvaluator } from "./skill-capability-evaluator";

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
  private circuitBreaker: SkillCircuitBreaker | null = null;
  private capabilityEvaluator: SkillCapabilityEvaluator | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("skillDispatcher", this);
  }

  initialize(): void {
    this.autoSkillManager = this.registry.resolveService<AutoSkillManager>("autoSkillManager") ?? null;
    this.skillRegistry = this.registry.resolveService<SkillRegistry>("skillRegistry") ?? null;
    this.circuitBreaker = this.registry.resolveService<SkillCircuitBreaker>("skillCircuitBreaker") ?? null;
    this.capabilityEvaluator = this.registry.resolveService<SkillCapabilityEvaluator>("skillCapabilityEvaluator") ?? null;
    
    // Build TF-IDF corpus from existing skills
    this.autoSkillManager?.buildCorpus();
    
    // Fetch remote skills to populate fusion matching
    this.fetchRemoteSkills().catch(err => {
      console.debug("[SkillDispatcher] Initial remote skill fetch failed:", err instanceof Error ? err.message : String(err));
    });

    process.stdout.write(`[SkillDispatcher] Initialized — ${this.autoSkillManager ? "AutoSkillManager" : "no AutoSkillManager"}, ${this.skillRegistry ? "SkillRegistry" : "no SkillRegistry"}`);
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

    // ── Step 1: Search local skills with TF-IDF (multi-candidate) ──
    if (!this.autoSkillManager) {
      reasoning.push("AutoSkillManager 未初始化，跳过本地搜索");
    } else {
      const localMatches = await this.autoSkillManager.findAllMatches(context.task, opts.maxCandidates!);

      const rankedMatches = await this.rerankWithEvaluator(localMatches, context.task);

      if (rankedMatches.length > 0) {
        reasoning.push(`本地匹配 ${rankedMatches.length} 个技能`);

        const skillManager = this.registry.resolveService<{
          listSkills(): Promise<Array<{ name: string; id: string; config?: Record<string, unknown> }>>;
          executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
        }>("skillManager");

        if (skillManager) {
          const installedSkills = await skillManager.listSkills();
          let autoInstallAttempted = false;

          for (const match of rankedMatches) {
            if (match.relevance < opts.autoInstallThreshold!) {
              reasoning.push(`候选 "${match.skillName}" 相关度过低 (${(match.relevance * 100).toFixed(0)}%)，停止本地尝试`);
              break;
            }

            if (match.skillId && this.circuitBreaker && !this.circuitBreaker.isAvailable(match.skillId)) {
              reasoning.push(`候选 "${match.skillName}" 已被熔断，跳过`);
              continue;
            }

            reasoning.push(`尝试候选: ${match.skillName} (相关度 ${(match.relevance * 100).toFixed(0)}%)`);

            const installed = installedSkills.find(s => s.name === match.skillName);

            if (!installed) {
              if (opts.autoInstall && !autoInstallAttempted) {
                autoInstallAttempted = true;
                reasoning.push(`技能 "${match.skillName}" 未安装，自动安装中...`);
                const installResult = await this.autoSkillManager.autoInstallForTask(context.task);

                if (installResult.installed && installResult.skillId) {
                  reasoning.push(`安装成功，检查配置...`);
                  const refreshedSkills = await skillManager.listSkills();
                  const refreshedSkill = refreshedSkills.find(s => s.id === installResult.skillId);

                  if (refreshedSkill && !this.isSkillConfigured(refreshedSkill)) {
                    reasoning.push(`技能 "${match.skillName}" 配置不完整，跳过`);
                    continue;
                  }

                  reasoning.push(`配置完整，执行中...`);
                  try {
                    const params = this.extractSkillParams(context.task, match.skillName);
                    const result = await skillManager.executeSkill(installResult.skillId, params);
                    if (result.success) {
                      this.circuitBreaker?.recordSuccess(installResult.skillId);
                      return {
                        success: true,
                        path: "skill",
                        skillName: installResult.skillName,
                        skillId: installResult.skillId,
                        output: result.output,
                        reasoning: reasoning.join("\n"),
                        duration: Date.now() - startTime,
                        matchedSkills: rankedMatches,
                        autoInstallResult: installResult,
                      };
                    }
                    this.circuitBreaker?.recordFailure(installResult.skillId, "执行未成功");
                    reasoning.push(`技能 "${match.skillName}" 执行未成功，尝试下一个候选`);
                  } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.circuitBreaker?.recordFailure(installResult.skillId, errMsg);
                    reasoning.push(`技能 "${match.skillName}" 执行异常: ${errMsg}`);
                  }
                } else {
                  reasoning.push(`自动安装失败: ${installResult.reason}`);
                }
              } else {
                reasoning.push(`技能 "${match.skillName}" 未安装${autoInstallAttempted ? "（已尝试过自动安装）" : "（自动安装未启用）"}，跳过`);
              }
              continue;
            }

            if (!this.isSkillConfigured(installed)) {
              reasoning.push(`技能 "${match.skillName}" 配置不完整，跳过`);
              continue;
            }

            reasoning.push(`技能 "${match.skillName}" 已安装且配置完整，执行中...`);
            try {
              const params = this.extractSkillParams(context.task, match.skillName);
              const result = await skillManager.executeSkill(installed.id, params);
              if (result.success) {
                this.circuitBreaker?.recordSuccess(installed.id);
                return {
                  success: true,
                  path: "skill",
                  skillName: match.skillName,
                  skillId: installed.id,
                  output: result.output,
                  reasoning: reasoning.join("\n"),
                  duration: Date.now() - startTime,
                  matchedSkills: rankedMatches,
                };
              }
              this.circuitBreaker?.recordFailure(installed.id, "执行未成功");
              reasoning.push(`技能 "${match.skillName}" 执行未成功，尝试下一个候选`);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this.circuitBreaker?.recordFailure(installed.id, errMsg);
              reasoning.push(`技能 "${match.skillName}" 执行异常: ${errMsg}`);
            }
          }
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
                    listSkills(): Promise<Array<{ name: string; id: string; config?: Record<string, unknown> }>>;
                    executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
                  }>("skillManager");

                  if (skillManager) {
                    const refreshedSkills = await skillManager.listSkills();
                    const refreshedSkill = refreshedSkills.find(s => s.id === installResult.skillId);

                    if (refreshedSkill && !this.isSkillConfigured(refreshedSkill)) {
                      reasoning.push(`远端技能 "${skillName}" 配置不完整，跳过`);
                    } else {
                      try {
                        const params = this.extractSkillParams(context.task, skillName);
                        const result = await skillManager.executeSkill(installResult.skillId, params);
                        if (result.success) {
                          this.circuitBreaker?.recordSuccess(installResult.skillId);
                        } else {
                          this.circuitBreaker?.recordFailure(installResult.skillId, "执行未成功");
                        }
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
                        const errMsg = err instanceof Error ? err.message : String(err);
                        this.circuitBreaker?.recordFailure(installResult.skillId, errMsg);
                        reasoning.push(`远端技能执行失败: ${errMsg}`);
                      }
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
            listSkills(): Promise<Array<{ name: string; id: string }>>;
          }>("skillManager");

          if (skillManager) {
            const installedSkills = await skillManager.listSkills();
            const webSearch = installedSkills.find(
              s => s.name === "tavily-search" || s.name === "baidu-search" || s.name === "web-search" || s.name === "web_search" || s.name === "webSearch"
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
      listSkills(): Promise<Array<{ name: string; id: string }>>;
      executeSkill(id: string, params: Record<string, unknown>): Promise<SkillExecutionResult>;
    }>("skillManager");

    if (skillManager) {
      const skills = await skillManager.listSkills();
      const match = skills.find(s => s.name === installed.skillName);
      
      if (match) {
        reasoning.push("执行中...");
        try {
          const params = this.extractSkillParams(task, installed.skillName);
          const result = await skillManager.executeSkill(match.id, params);

          if (result.success) {
            this.circuitBreaker?.recordSuccess(match.id);
          } else {
            this.circuitBreaker?.recordFailure(match.id, "执行未成功");
          }

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
          const errMsg = err instanceof Error ? err.message : String(err);
          this.circuitBreaker?.recordFailure(match.id, errMsg);
          return {
            success: false,
            path: "skill",
            skillName: installed.skillName,
            skillId: match.id,
            reasoning: reasoning.join("\n"),
            duration: Date.now() - startTime,
            error: `执行失败: ${errMsg}`,
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
      listSkills(): Promise<Array<{ name: string; id: string }>>;
    }>("skillManager");
    const installed = await skillManager?.listSkills() || [];

    return { local, remote, installed };
  }

  // ── Private ──

  private async rerankWithEvaluator(matches: SkillMatch[], taskDescription: string): Promise<SkillMatch[]> {
    if (!this.capabilityEvaluator || matches.length === 0) return matches;

    try {
      const skillManager = this.registry.resolveService<{
        listSkills(): Promise<Skill[]>;
      }>("skillManager");

      if (!skillManager) return matches;

      const allSkills = await skillManager.listSkills();
      const matchSkillIds = new Set(matches.map(m => m.skillId).filter(Boolean));
      const relevantSkills = allSkills.filter(s => matchSkillIds.has(s.id));

      if (relevantSkills.length === 0) return matches;

      this.capabilityEvaluator.buildCorpus(relevantSkills);

      const ranked = this.capabilityEvaluator.rankSkills(relevantSkills, taskDescription);

      const skillById = new Map(relevantSkills.map(s => [s.id, s]));
      const rankedMatches: SkillMatch[] = [];
      const seen = new Set<string>();

      for (const { skill, score } of ranked) {
        const originalMatch = matches.find(m => m.skillId === skill.id);
        if (originalMatch && !seen.has(originalMatch.skillName)) {
          seen.add(originalMatch.skillName);
          rankedMatches.push({
            ...originalMatch,
            relevance: score.overall,
            reason: `${originalMatch.reason} [评估: ${(score.overall * 100).toFixed(0)}%]`,
          });
        }
      }

      for (const m of matches) {
        if (!seen.has(m.skillName)) {
          seen.add(m.skillName);
          rankedMatches.push(m);
        }
      }

      return rankedMatches;
    } catch {
      return matches;
    }
  }

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
      { regex: /音乐|歌曲|播放|听歌/, keyword: "music" },
      { regex: /视频|电影|看片/, keyword: "video" },
      { regex: /地图|导航|路线|位置/, keyword: "map" },
      { regex: /购物|买|价格|比价/, keyword: "shopping" },
      { regex: /日历|日程|安排|计划/, keyword: "calendar" },
      { regex: /笔记|记录|备忘/, keyword: "notes" },
      { regex: /聊天|对话|问答/, keyword: "chat" },
      { regex: /数据|统计|图表|分析/, keyword: "analytics" },
    ];

    for (const { regex, keyword } of cnPatterns) {
      if (regex.test(lower)) return keyword;
    }

    // English: extract the most meaningful word pair
    const words = lower
      .replace(/[，。！？、；：（）【】《》""'']/g, " ")
      .split(/[\s,.;:!?()]+/)
      .filter(w => w.length >= 3 && !["the", "and", "for", "get", "how", "can", "you", "what", "when", "where", "pls", "please", "want", "need", "help", "with", "from", "into", "about", "that", "this", "just", "like", "also", "帮我", "一下", "一个", "这个", "那个", "哪个", "怎么", "什么", "为什么"].includes(w));

    // Return up to 3 most meaningful words
    if (words.length > 0) {
      return words.slice(0, 3).join(" ");
    }

    return "";
  }

  private isSkillConfigured(skill: { config?: Record<string, unknown> }): boolean {
    if (!skill.config) return true;
    const configObj = skill.config;
    const primaryEnv = configObj._primaryEnv as string | undefined;
    const envMeta = configObj._envMeta as Record<string, { required: boolean; currentSource: string }> | undefined;

    if (!primaryEnv || !envMeta) return true;

    const meta = envMeta[primaryEnv];
    if (!meta || !meta.required) return true;

    const hasValue = !!configObj[primaryEnv] && String(configObj[primaryEnv]).trim() !== "";
    return hasValue || meta.currentSource === "env";
  }

  private extractSkillParams(task: string, skillName: string): Record<string, unknown> {
    const params: Record<string, unknown> = { prompt: task, query: task };

    const lower = task.toLowerCase();

    if (skillName.includes("search") || skillName.includes("搜索")) {
      const searchPatterns = [
        /搜索\s*[""「]?([^""」]+)[""」]?/i,
        /查找\s*[""「]?([^""」]+)[""」]?/i,
        /search\s+(?:for\s+)?["']?([^"']+)["']?/i,
        /find\s+(?:me\s+)?["']?([^"']+)["']?/i,
        /搜一下\s*[""「]?([^""」]+)[""」]?/i,
        /查一下\s*[""「]?([^""」]+)[""」]?/i,
        /帮我搜\s*[""「]?([^""」]+)[""」]?/i,
        /帮我查\s*[""「]?([^""」]+)[""」]?/i,
        /有没有.*?([\u4e00-\u9fa5a-zA-Z0-9\s]{2,30})的?(?:开源|项目|软件|工具)/i,
        /最近.*?(?:火|热门|上升|流行).*?([\u4e00-\u9fa5a-zA-Z0-9\s]{2,30})/i,
        /本周.*?(?:重大|热门|重要).*?([\u4e00-\u9fa5a-zA-Z0-9\s]{2,30})/i,
        /最新.*?([\u4e00-\u9fa5a-zA-Z0-9\s]{2,30})/i,
      ];
      let extracted = false;
      for (const p of searchPatterns) {
        const m = task.match(p);
        if (m) {
          params.query = m[1].trim();
          extracted = true;
          break;
        }
      }

      if (!extracted) {
        const cleaned = task
          .replace(/^(请问|请问一下|麻烦|帮忙|帮我|能不能|可以|请|我想|我想要|我想看|我想了解|我想知道)\s*/g, "")
          .replace(/^(搜索|查找|搜一下|查一下|搜搜|查查)\s*/g, "")
          .replace(/(并整理后发给我|整理后发给我|整理一下|并整理|并总结|并汇总|是什么|怎么样|有哪些|有没有).*/g, "")
          .trim();
        if (cleaned.length > 2 && cleaned.length < 200) {
          params.query = cleaned;
        }
      }

      if (/今天|今日|today/i.test(lower)) params.freshness = "pd";
      else if (/本周|这周|this week/i.test(lower)) params.freshness = "pw";
      else if (/本月|这个月|this month/i.test(lower)) params.freshness = "pm";
      else if (/今年|今年内|this year/i.test(lower)) params.freshness = "py";

      const countMatch = task.match(/(\d+)\s*(条|个|项|results?)/i);
      if (countMatch) params.count = parseInt(countMatch[1]);
    }

    if (skillName.includes("weather") || skillName.includes("天气")) {
      const cityPatterns = [
        /(\S+市|\S+区)\s*天气/i,
        /weather\s+(?:in\s+)?(\S+)/i,
        /(\S+)\s*的?天气/i,
      ];
      for (const p of cityPatterns) {
        const m = task.match(p);
        if (m) {
          params.city = m[1].trim();
          params.query = m[1].trim();
          break;
        }
      }
    }

    return params;
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
        process.stdout.write(`[SkillDispatcher] Fetched ${result.entries.length} remote skills`);
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