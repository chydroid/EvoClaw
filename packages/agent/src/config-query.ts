// System config query handling for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { PersonaConfig } from "@evoclaw/core";
import type { ProviderConfig, ToolDefinition } from "./types";
import type { EarlyReturnResult } from "./email-handler";
import { taskStatusTracker } from "./task-status-tracker";

/** Dependencies needed by config query function */
export interface ConfigQueryDeps {
  providers: ProviderConfig[];
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  persona: PersonaConfig;
  maxHistoryLength: number;
  autoCompactionEnabled: boolean;
  compactionTokenThreshold: number;
  memoryHub: { getLongTerm(): { store(entry: import("@evoclaw/core").MemoryEntry): Promise<import("@evoclaw/core").MemoryEntry>; search(query: import("@evoclaw/core").MemorySearchQuery): Promise<import("@evoclaw/core").MemorySearchResult[]> } } | null;
}

/**
 * Direct response for config queries without LLM.
 * Handles "查配置", "check config", "system info" etc.
 */
export function handleSystemConfigQuery(
  deps: ConfigQueryDeps,
  message: string,
  skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>; } | undefined,
  startTime: number,
  sessionId: string,
): EarlyReturnResult | null {
  if (message.length > 30) return null;

  const configKeywords = [
    /^(?:查|查看|显示|展示|告诉我)\s*(?:当前\s*)?(?:的\s*)?(?:配置|设置|模型|provider|模型列表|提供商|技能列表)/i,
    /^(?:当前|现在)\s*(?:的\s*)?(?:配置|设置|模型|provider|提供商)/i,
    /^系统(?:配置|设置|信息|模型|状态)/i,
    /^(?:config|configuration|system\s*info|model\s*info|check\s*config)\s*$/i,
    /^(?:什么|哪些)\s*(?:模型|provider|提供商|配置)\s*[？?]?\s*$/i,
    /^(?:how\s*(?:many|to)\s*|what\s*)(?:model|skill|provider|config)/i,
    /^(?:列出|list)\s*(?:模型|技能|配置|系统)/i,
  ];

  const matches = configKeywords.some(re => re.test(message.trim()));
  if (!matches) return null;

  process.stdout.write(`[ConfigQuery] System config query detected: "${message}" — responding directly`);
  taskStatusTracker.set(sessionId, "done", "配置查询完成", 100);

  const enabledProviders = deps.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
  const totalProviders = deps.providers.length;
  const allSkills = skillManager ? (skillManager.listSkills() as Array<{ name: string; description?: string }>) : [];
  const toolCount = deps.registeredTools.size;

  const lines: string[] = [];
  const ts = new Date().toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const separator = "─".repeat(36);

  lines.push(`📅 ${ts}\n`);
  lines.push(`## 🧬 EvoClaw 系统配置\n`);
  lines.push(`### 🤖 推理模型`);
  if (enabledProviders.length > 0) {
    for (let i = 0; i < enabledProviders.length; i++) {
      const p = enabledProviders[i];
      const tag = i === 0 ? " (主)" : "";
      lines.push(`  ${i + 1}. **${p.name}**${tag}`);
      lines.push(`     - 模型: \`${p.model}\``);
      lines.push(`     - 类型: \`${p.provider}\``);
      lines.push(`     - 超时: ${p.timeout / 1000}s | 最大 Token: ${p.maxTokens}`);
      if (p.baseURL) {
        lines.push(`     - 端点: \`${p.baseURL.replace(/\/+$/, "")}\``);
      }
    }
  } else {
    lines.push(`  - ⚠ 无已启用模型`);
  }
  if (totalProviders > enabledProviders.length) {
    lines.push(`  - 已禁用: ${totalProviders - enabledProviders.length} 个`);
  }

  lines.push(`\n### 🛠 可用工具 (${toolCount})`);
  if (toolCount > 0) {
    const toolNames = Array.from(deps.registeredTools.keys()).slice(0, 12);
    lines.push(`  ${toolNames.map(t => `\`${t}\``).join(", ")}`);
    if (toolCount > 12) lines.push(`  ...及其他 ${toolCount - 12} 个工具`);
  } else {
    lines.push(`  - 无已注册工具`);
  }

  lines.push(`\n### 📦 技能 (Skills)`);
  if (allSkills.length > 0) {
    const statusMap = new Map<string, "installed" | "available">();
    for (const s of allSkills) {
      const name = s.name || (s as Record<string, unknown>).id as string || "unknown";
      statusMap.set(name,
        (s as Record<string, unknown>).installed === false || (s as Record<string, unknown>).installed === "false"
          ? "available" : "installed"
      );
    }
    const installed = Array.from(statusMap.entries()).filter(([, v]) => v === "installed");
    const available = Array.from(statusMap.entries()).filter(([, v]) => v === "available");

    if (installed.length > 0) {
      lines.push(`  **已安装** (${installed.length}): ${installed.map(([n]) => `\`${n}\``).join(", ")}`);
    }
    if (available.length > 0) {
      lines.push(`  **可安装** (${available.length}): ${available.map(([n]) => `\`${n}\``).join(", ")}`);
    }
  } else {
    lines.push(`  - 无已扫描技能，可执行"搜索技能"来发现可用技能`);
  }

  lines.push(`\n### 💾 系统信息`);
  lines.push(`  - Agent: ${deps.persona.name} (${deps.persona.title})`);
  lines.push(`  - 会话历史上限: ${deps.maxHistoryLength} 轮`);
  lines.push(`  - 自动压缩: ${deps.autoCompactionEnabled ? "已启用" : "未启用"}`);
  lines.push(`  - 压缩阈值: ${deps.compactionTokenThreshold} tokens`);

  // Memory stats
  if (deps.memoryHub) {
    try {
      const mem = deps.memoryHub.getLongTerm();
      lines.push(`  - 长期记忆: 已集成`);
    } catch { /* ignore */ }
  }

  lines.push(`\n${separator}`);
  lines.push(`> 查询时间: ${ts} | 响应耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return {
    reply: lines.join("\n"),
    tokensUsed: 0,
    duration: Date.now() - startTime,
    permissionRequests: [],
    toolsExecuted: false,
  };
}
