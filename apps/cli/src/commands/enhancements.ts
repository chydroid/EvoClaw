/** enhancements — Show recent capability enhancements (v0.56/v0.57) */
import { Command } from "commander";
import { c, ICONS, section, divider } from "../utils/colors";
import { checkServer, serverRequired, DEFAULT_PORT } from "../utils/api";

interface CapabilityDef {
  id: string;
  name: string;
  nameEn: string;
  version: string;
  icon: string;
  description: string;
  module: string;
  tags: string[];
}

const CAPABILITIES: CapabilityDef[] = [
  {
    id: "filesystem-checkpoint",
    name: "文件系统检查点",
    nameEn: "FileSystem Checkpoint",
    version: "v0.56",
    icon: "💾",
    description: "基于 Git 影子存储的文件快照与回滚，支持 per-project 隔离、每轮去重、三层清理与 pre-rollback 快照。",
    module: "@evoclaw/infrastructure",
    tags: ["可靠性", "状态回滚"],
  },
  {
    id: "tool-output-pruner",
    name: "工具输出 3-pass 裁剪",
    nameEn: "Tool Output Pruner",
    version: "v0.56",
    icon: "✂️",
    description: "MD5 去重 → 工具特定摘要 → args JSON 安全截断，保持上下文简洁与 JSON 有效性。",
    module: "@evoclaw/agent",
    tags: ["上下文管理", "压缩"],
  },
  {
    id: "error-recovery-executor",
    name: "错误恢复执行分支",
    nameEn: "Error Recovery Executor",
    version: "v0.56",
    icon: "🛡️",
    description: "20+ FailoverReason 对应的实际恢复动作，含 TurnRetryState 一次性守卫防止无限循环。",
    module: "@evoclaw/agent",
    tags: ["容错", "恢复"],
  },
  {
    id: "concurrent-tool-executor",
    name: "并发工具执行池",
    nameEn: "Concurrent Tool Executor",
    version: "v0.56",
    icon: "⚡",
    description: "8 worker + 3 类安全分类（never-parallel / path-scoped / safe-parallel）+ 心跳监控 + 中断扇出。",
    module: "@evoclaw/agent",
    tags: ["性能", "并发"],
  },
  {
    id: "iteration-budget",
    name: "迭代预算退款机制",
    nameEn: "Iteration Budget",
    version: "v0.56",
    icon: "💰",
    description: "execute_code / runtime_error / compaction 三种退款，让预算真正反映决策次数。",
    module: "@evoclaw/agent",
    tags: ["成本控制", "预算"],
  },
  {
    id: "process-tree-killer",
    name: "跨平台进程树终止",
    nameEn: "Process Tree Killer",
    version: "v0.56",
    icon: "🌳",
    description: "POSIX /proc/children + ps --ppid / Windows taskkill /T /F，受保护 PID + 两阶段终止。",
    module: "@evoclaw/infrastructure",
    tags: ["安全", "清理"],
  },
  {
    id: "tool-result-persistence",
    name: "工具结果持久化",
    nameEn: "Tool Result Persistence",
    version: "v0.57",
    icon: "📦",
    description: "三层防御：per-tool cap → per-result persistence → per-turn aggregate budget，防止大输出撑爆上下文。",
    module: "@evoclaw/agent",
    tags: ["上下文管理", "持久化"],
  },
  {
    id: "schema-sanitizer",
    name: "JSON Schema 多后端清洗",
    nameEn: "Schema Sanitizer",
    version: "v0.57",
    icon: "🧹",
    description: "Anthropic / OpenAI Codex / Fireworks / xAI / llama.cpp 五类后端兼容性清洗，响应式策略选择。",
    module: "@evoclaw/agent",
    tags: ["兼容性", "多后端"],
  },
  {
    id: "tool-argument-coercer",
    name: "工具参数类型强制转换",
    nameEn: "Tool Argument Coercer",
    version: "v0.57",
    icon: "🔧",
    description: "运行时校正 LLM 返回的参数类型：string→int/number/boolean、JSON string→object/array、bare value→[value]。",
    module: "@evoclaw/agent",
    tags: ["可靠性", "类型安全"],
  },
  {
    id: "cross-session-rate-guard",
    name: "跨会话速率限制守卫",
    nameEn: "Cross-Session Rate Guard",
    version: "v0.57",
    icon: "⏱️",
    description: "CLI/gateway/cron/auxiliary 跨会话共享 429 状态，防止 retry amplification，区分配额耗尽与瞬时容量不足。",
    module: "@evoclaw/agent",
    tags: ["速率限制", "成本控制"],
  },
  {
    id: "streaming-recovery",
    name: "流式响应中断恢复",
    nameEn: "Streaming Recovery",
    version: "v0.57",
    icon: "🔄",
    description: "6 种恢复策略：partial_stream_recovery / truncated_tool_call_retries / length_continue / thinking_prefill / post_tool_empty / housekeeping。",
    module: "@evoclaw/agent",
    tags: ["流式传输", "容错"],
  },
  {
    id: "tool-result-middleware",
    name: "工具结果中间件",
    nameEn: "Tool Result Middleware",
    version: "v0.57",
    icon: "🎛️",
    description: "3 类中间件（修改参数 / 包装执行 / 后处理结果），内置脱敏、大小限制、JSON 格式化 Transform。",
    module: "@evoclaw/agent",
    tags: ["可扩展性", "安全"],
  },
];

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("enhancements")
    .description("Show recent capability enhancements (v0.56 / v0.57)")
    .option("--json", "Output as JSON")
    .option("--version <ver>", "Filter by version (v0.56 or v0.57)")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      let caps = CAPABILITIES;
      if (opts.version) {
        caps = caps.filter(c => c.version === opts.version);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          total: caps.length,
          versions: ["v0.56", "v0.57"],
          capabilities: caps,
        }, null, 2));
        return;
      }

      console.log(section("Enhancement Hub — 近期增强能力"));
      console.log(c("gray", `  本展示集中体现 EvoClaw v0.56/v0.57 从任务完成能力维度补齐的 ${CAPABILITIES.length} 大核心能力。`));
      console.log(c("gray", `  覆盖可靠性、上下文管理、多后端兼容、并发执行与成本控制等方面。`));
      console.log();

      // Summary
      const v56Count = CAPABILITIES.filter(c => c.version === "v0.56").length;
      const v57Count = CAPABILITIES.filter(c => c.version === "v0.57").length;
      console.log(`  ${ICONS.star()} ${c("bold", String(CAPABILITIES.length))} ${c("gray", "新增核心能力")}  |  ${c("bold", String(v56Count))} ${c("gray", "in v0.56")}  |  ${c("bold", String(v57Count))} ${c("gray", "in v0.57")}`);
      console.log();

      // List capabilities
      for (const cap of caps) {
        console.log(`  ${cap.icon}  ${c("bold", cap.name)} ${c("gray", `(${cap.nameEn})`)}  ${c("cyan", cap.version)}`);
        console.log(c("gray", `     ${cap.description}`));
        console.log(c("gray", `     module: ${cap.module}  tags: ${cap.tags.join(", ")}`));
        console.log();
      }

      console.log(divider());
      console.log(c("gray", `  Web UI: 打开 http://localhost:${DEFAULT_PORT} → 增强能力 查看可视化面板`));
      console.log();
    });
}
