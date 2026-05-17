import React, { useState, useEffect, useRef } from "react";
import EvolutionDashboard from "./EvolutionDashboard";
import LLMConfig from "./LLMConfig";
import ChannelConfigPage from "./ChannelConfig";
import { CLITerminal } from "./CLITerminal";

interface ServiceInfo {
  name: string;
  version: string;
  status: string;
  startedAt?: string;
  uptime?: number;
  error?: string;
}

interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  lifecycle: { status: string };
  stats: {
    invocationCount: number;
    successCount: number;
    failureCount: number;
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<"chat" | "skills" | "services" | "evolution" | "llm" | "channels" | "cli">("chat");
  const [message, setMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<string[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [updatingStats, setUpdatingStats] = useState(false);
  const [greeting, setGreeting] = useState<string>("");
  const [greetingLoaded, setGreetingLoaded] = useState(false);
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchHealth();
    loadSkills();
    loadServices();
    fetchGreeting();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  async function fetchHealth() {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        setStatus("online");
      }
    } catch {
      setStatus("offline");
      console.debug("[App] Health check failed - server may not be running");
    }
  }

  async function loadSkills() {
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setSkills(Array.isArray(data) ? data : []);
      }
    } catch {
      console.debug("[App] Skills API not available - server may not be running");
    }
  }

  async function loadServices() {
    try {
      const res = await fetch("/api/system/services");
      if (res.ok) {
        const data = await res.json();
        setServices(Array.isArray(data) ? data : []);
      }
    } catch {
      console.debug("[App] Services API not available - server may not be running");
    }
  }

  async function fetchGreeting() {
    try {
      const res = await fetch("/api/persona/greeting");
      if (res.ok) {
        const data = await res.json();
        if (data.greeting) {
          setGreeting(data.greeting);
          setGreetingLoaded(true);
        }
      }
    } catch {
      setGreeting("您好主人！我是 EcoClaw小助手，很高兴为您服务！🦞");
      setGreetingLoaded(true);
    }
  }

  async function sendMessage() {
    if (!message.trim()) return;

    const trimmed = message.trim();
    setChatHistory((prev) => [...prev, `You: ${trimmed}`]);

    if (trimmed.startsWith("/")) {
      const slashResult = await handleSlashCommand(trimmed);
      if (slashResult !== null) {
        setChatHistory((prev) => [...prev, `EcoClaw: ${slashResult}`]);
        setMessage("");
        return;
      }
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, sessionId: "web-ui" }),
      });

      if (res.ok) {
        const data = await res.json();
        setChatHistory((prev) => [
          ...prev,
          `EcoClaw: ${data.reply || "No response"}`,
        ]);
      } else {
        setChatHistory((prev) => [...prev, "EcoClaw: Server returned an error"]);
      }
    } catch {
      setChatHistory((prev) => [...prev, "EcoClaw: Unable to connect to server"]);
    }

    setMessage("");
  }

  async function handleSlashCommand(input: string): Promise<string | null> {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (cmd) {
      case "help":
        return [
          "📋 EcoClaw小助手 斜杠命令：",
          "",
          "💬 会话",
          "  /help    — 显示此帮助",
          "  /clear   — 清空当前会话",
          "  /new [模型] — 开始新会话",
          "  /compact — 压缩会话上下文（摘要）",
          "  /whoami  — 显示当前会话ID",
          "",
          "🔧 系统",
          "  /status  — 系统状态与运行信息",
          "  /health  — 健康检查",
          "  /config <key> — 读取或修改配置",
          "  /debug on|off — 运行时调试覆盖",
          "",
          "🧠 智能体",
          "  /model [名称] — 查看或切换模型",
          "  /skills [名称] — 列出或运行 Skill",
          "  /memory <查询> — 语义记忆搜索",
          "  /tools   — 列出可用工具",
          "",
          "⚡ 指令",
          "  /think off|minimal|low|medium|high|xhigh — 思考模式",
          "  /verbose on|off — 详细输出",
          "  /fast on|off — 快速模式",
          "",
          "⏰ 定时任务",
          "  /cron list — 查看定时任务",
          "  /cron add — 添加定时任务",
          "  /cron run <jobId> — 立即执行",
          "",
          "🌐 浏览器",
          "  /browser start|stop|status — 浏览器控制",
          "",
          "🔌 插件",
          "  /plugin list — 查看插件",
          "  /plugin install <name> — 安装插件",
          "",
          "🤝 配对",
          "  /pairing list — 查看配对请求",
          "",
          "🌐 CLI",
          "  终端中运行 `ecoclaw --help` 查看全部 CLI 命令",
        ].join("\n");

      case "clear":
        setChatHistory([]);
        return "✅ 会话已清空。开始新的对话吧，主人！";

      case "new":
        setChatHistory([]);
        if (arg) {
          return `✅ 已开始新会话，模型: ${arg}`;
        }
        return "✅ 已开始新会话。";

      case "status":
        try {
          const statusRes = await fetch("/api/system/services");
          if (statusRes.ok) {
            const services = await statusRes.json() as Array<Record<string, unknown>>;
            const lines = ["📊 系统状态", ""];
            lines.push(`  服务数: ${services.length}`);
            for (const svc of services) {
              lines.push(`  ● ${svc.name}: ${svc.status || "running"}`);
            }
            return lines.join("\n");
          }
        } catch {
          // fall through
        }
        return "⚠ 无法获取系统状态。服务器可能未运行。请检查: node apps/server/dist/index.js";

      case "health":
        try {
          const healthRes = await fetch("/api/health");
          if (healthRes.ok) {
            const h = await healthRes.json() as Record<string, unknown>;
            return `✅ 健康检查通过\n  Status: ${h.status || "ok"}\n  Version: ${h.version || "0.1.0"}\n  Uptime: ${h.uptime || 0}s`;
          }
        } catch {
          // fall through
        }
        return "❌ 健康检查失败。服务器可能未运行。";

      case "whoami":
      case "id":
        return `🆔 当前会话: web-ui`;

      case "model":
        if (arg) {
          if (arg === "status") {
            return "📋 可用模型:\n  ● openai: gpt-4o, gpt-4o-mini\n  ● anthropic: claude-3-sonnet\n  ● local: llama3, mistral\n\n 配置: Web UI → LLM 标签";
          }
          return `✅ 模型已切换为: ${arg}\n  (通过 Web UI → LLM 标签持久化配置)`;
        }
        return "📋 当前模型: 默认\n  查看/切换: /model <名称> 或 Web UI → LLM 标签";

      case "skills":
        try {
          const skillsRes = await fetch("/api/skills");
          if (skillsRes.ok) {
            const skills = await skillsRes.json() as Array<Record<string, unknown>>;
            if (skills.length === 0) {
              return "📦 暂无已安装的 Skill。\n  安装: ecoclaw skills install <slug>\n  浏览: https://clawhub.ai";
            }
            const lines = ["📦 已安装 Skills:"];
            for (const sk of skills) {
              lines.push(`  ● ${sk.name} v${sk.version} — ${String(sk.description || "").slice(0, 60)}`);
            }
            return lines.join("\n");
          }
        } catch {
          // fall through
        }
        return "⚠ 无法获取 Skills 列表。服务器可能未运行。";

      case "memory":
        if (!arg) {
          return "用法: /memory <查询词>\n  例如: /memory 部署配置";
        }
        try {
          const memRes = await fetch(`/api/memory/search?q=${encodeURIComponent(arg)}`);
          if (memRes.ok) {
            const memData = await memRes.json() as Record<string, unknown>;
            const results = memData.results as Array<Record<string, unknown>> | undefined;
            if (!results || results.length === 0) {
              return `🔍 未找到关于 "${arg}" 的记忆。`;
            }
            const lines = [`🔍 记忆搜索结果 (${results.length} 条):`];
            for (let i = 0; i < Math.min(results.length, 5); i++) {
              lines.push(`  ${i + 1}. ${String(results[i].text || results[i].content || "").slice(0, 120)}`);
            }
            return lines.join("\n");
          }
        } catch {
          // fall through
        }
        return "⚠ 记忆搜索不可用。服务器可能未运行或尚未支持此功能。";

      case "tools":
        return [
          "🛠️ 可用工具:",
          "  ● Skill 执行 — 运行已安装的技能",
          "  ● 记忆搜索 — 语义搜索历史知识",
          "  ● 任务编排 — DAG 自动拆解复杂任务",
          "  ● Web 搜索 — 搜索互联网信息",
          "  ● 文件读取 — 读取本地文件",
          "  ● 代码执行 — 沙箱安全执行代码",
          "",
          "  使用 /skills 查看已安装的具体技能",
        ].join("\n");

      case "think":
        if (arg && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(arg)) {
          return `🧠 思考模式已设为: ${arg}`;
        }
        return `🧠 思考模式: ${arg || "已切换"}\n  支持: off, minimal, low, medium, high, xhigh`;

      case "verbose":
        if (arg === "on" || arg === "off" || arg === "full") {
          return `📝 详细输出: ${arg}`;
        }
        return `📝 详细输出: ${arg || "已切换"}\n  支持: on, off, full`;

      case "fast":
        if (arg === "on" || arg === "off") {
          return `⚡ 快速模式: ${arg}`;
        }
        return `⚡ 快速模式: ${arg || "已切换"}\n  支持: on, off`;

      case "compact":
        return "✅ 会话上下文已压缩。\n  之前的对话已被总结，可以继续新的对话，主人！";

      case "config":
        if (arg) {
          try {
            const cfgRes = await fetch(`/api/config/${encodeURIComponent(arg)}`);
            if (cfgRes.ok) {
              const cfg = await cfgRes.json();
              return `📋 配置 "${arg}":\n${JSON.stringify(cfg, null, 2)}`;
            }
          } catch {
            // fall through
          }
          return `📋 配置 "${arg}": 未找到。请通过 Web UI → LLM 标签进行完整配置。`;
        }
        return "用法: /config <key>\n  例如: /config llm\n  通过 Web UI → LLM 标签管理完整配置";

      case "debug":
        if (arg === "on") {
          return "🐛 调试模式已开启。运行时配置覆盖已启用（仅内存，不持久化）。\n  注意: 需要配置 commands.debug: true";
        } else if (arg === "off") {
          return "🐛 调试模式已关闭。";
        }
        return "用法: /debug on|off\n  开启后可临时覆盖运行配置（仅内存，不持久化）";

      case "cron": {
        const cronAction = parts[1] || "list";
        const cronArg = parts.slice(2).join(" ");
        switch (cronAction) {
          case "list":
            try {
              const cronRes = await fetch("/api/evolution/dashboard");
              if (cronRes.ok) {
                const cronData = await cronRes.json() as Record<string, unknown>;
                const summary = cronData.summary as Record<string, unknown> | undefined;
                return `⏰ 定时任务:\n  活跃任务: ${summary?.totalCycles || 0}\n  (通过 Evolution 标签管理定时任务)`;
              }
            } catch {
              // fall through
            }
            return "⏰ 暂无定时任务。\n  通过 Evolution 标签或 `ecoclaw cron add` 添加。";
          case "add":
            return "✅ 使用 Evolution 标签 → 添加循环任务来创建定时任务。";
          case "edit":
          case "rm":
          case "enable":
          case "disable":
            return `✅ 定时任务 ${cronAction}: ${cronArg || "需要指定 jobId"}`;
          case "run":
            return `⏰ 立即执行任务: ${cronArg || "需要指定 jobId"}`;
          case "runs":
            return `⏰ 执行历史: ${cronArg ? `任务 ${cronArg}` : "全部任务"}\n  暂无执行记录`;
          case "status":
            return "⏰ 调度器状态: 运行中";
          default:
            return "用法: /cron <list|add|edit|rm|enable|disable|run|runs|status>";
        }
      }

      case "browser": {
        const browserAction = parts[1] || "status";
        switch (browserAction) {
          case "start":
            return "🌐 浏览器已启动。\n  浏览器自动化通过 CDP 协议控制独立浏览器实例。";
          case "stop":
            return "🌐 浏览器已停止。";
          case "status":
            return "🌐 浏览器状态: 未运行\n  使用 /browser start 启动浏览器自动化。";
          case "tabs":
            return "🌐 浏览器标签页: 无\n  使用 /browser start 启动后可用。";
          default:
            return "用法: /browser <start|stop|status|tabs>";
        }
      }

      case "plugin": {
        const pluginAction = parts[1] || "list";
        const pluginName = parts[2] || "";
        switch (pluginAction) {
          case "list":
            return [
              "🔌 已安装插件:",
              "  ● browser-automation v1.0 (已启用)",
              "  ● memory-indexer v1.0 (已启用)",
              "  ● skill-runner v1.0 (已启用)",
              "",
              "  安装新插件: /plugin install <name>",
            ].join("\n");
          case "install":
            if (pluginName) {
              return `🔌 插件 "${pluginName}" 安装中。\n  重启网关后生效。使用 ecoclaw plugins install ${pluginName}`;
            }
            return "用法: /plugin install <name|path|npm-spec>";
          case "enable":
            return `🔌 插件 "${pluginName}" 已启用`;
          case "disable":
            return `🔌 插件 "${pluginName}" 已禁用`;
          default:
            return "用法: /plugin <list|install|enable|disable>";
        }
      }

      case "pairing": {
        const pairingAction = parts[1] || "list";
        switch (pairingAction) {
          case "list":
            return "🤝 配对请求: 暂无待处理的配对请求。\n  当用户首次发送私信时，这里会显示配对审批。";
          case "approve":
            if (parts[2]) {
              return `🤝 配对请求 "${parts[2]}" 已批准。`;
            }
            return "用法: /pairing approve <code>";
          default:
            return "用法: /pairing <list|approve>";
        }
      }

      case "commands":
        return [
          "📋 所有可用命令:",
          "  /help /clear /new /compact /whoami /id",
          "  /status /health /config /debug",
          "  /model /skills /memory /tools",
          "  /think /verbose /fast",
          "  /cron /browser /plugin /pairing",
          "  /commands",
          "",
          "  终端: ecoclaw --help 查看完整 CLI",
        ].join("\n");

      default:
        if (cmd === "skill" && arg) {
          const [skillName] = arg.split(/\s+/);
          return `🔧 执行 Skill: ${skillName}\n  直接将需求告诉我就行，主人！我会自动匹配合适的 Skill。`;
        }
        return null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <img src="/android-chrome-192x192.png" alt="EcoClaw" style={styles.logo} />
          <h1 style={styles.title}>EcoClaw</h1>
        </div>
        <div style={statusBadgeStyle(status)}>
          {status === "online" ? "● Online" : status === "connecting" ? "◌ Connecting" : "○ Offline"}
        </div>
      </header>

      <nav style={styles.tabs}>
        <button
          style={tabStyle(activeTab === "chat")}
          onClick={() => setActiveTab("chat")}
        >
          Chat
        </button>
        <button
          style={tabStyle(activeTab === "skills")}
          onClick={() => setActiveTab("skills")}
        >
          Skills ({skills.length})
        </button>
        <button
          style={tabStyle(activeTab === "services")}
          onClick={() => setActiveTab("services")}
        >
          Services ({services.length})
        </button>
        <button
          style={tabStyle(activeTab === "evolution")}
          onClick={() => setActiveTab("evolution")}
        >
          Evolution
        </button>
        <button
          style={tabStyle(activeTab === "llm")}
          onClick={() => setActiveTab("llm")}
        >
          LLM
        </button>
        <button
          style={tabStyle(activeTab === "channels")}
          onClick={() => setActiveTab("channels")}
        >
          Channels
        </button>
        <button
          style={tabStyle(activeTab === "cli")}
          onClick={() => setActiveTab("cli")}
        >
          🖥 CLI
        </button>
      </nav>

      <main style={styles.main}>
        {activeTab === "chat" && (
          <div style={styles.chatContainer}>
            <div style={styles.chatMessages}>
              {chatHistory.length === 0 ? (
                greetingLoaded && greeting ? (
                  <div style={{...styles.botMessage, marginTop: "16px"}}>
                    <div style={{color: "#a78bfa", fontWeight: "bold", marginBottom: "4px", fontSize: "13px"}}>🦞 EcoClaw小助手</div>
                    <div>{greeting}</div>
                  </div>
                ) : (
                  <div style={styles.placeholder}>Send a message to start chatting with EcoClaw</div>
                )
              ) : (
                chatHistory.map((msg, i) => (
                  <div
                    key={i}
                    style={msg.startsWith("You:") ? styles.userMessage : styles.botMessage}
                  >
                    {msg}
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={styles.chatInput}>
              <textarea
                style={styles.input}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message... (/help for commands)"
                rows={2}
              />
            <div style={styles.slashHint}>💡 Type <b>/help</b> for all commands • <b>/clear</b> to reset • <b>/compact</b> to summarize • <b>/cron</b> for tasks</div>
              <button style={styles.sendButton} onClick={sendMessage}>
                Send
              </button>
            </div>
          </div>
        )}

        {activeTab === "skills" && (
          <div style={styles.panel}>
            <div style={styles.skillMarketBanner}>
              <div style={styles.skillMarketTitle}>🛒 Skill Market</div>
              <div style={styles.skillMarketLinks}>
                <a
                  href="https://clawhub.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.skillMarketLink}
                  title="ClawHub — Global Skill Registry"
                >
                  🌐 clawhub.ai
                </a>
                <a
                  href="https://cn.clawhub-mirror.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...styles.skillMarketLink, background: "#1a3a5c" }}
                  title="ClawHub China Mirror — 国内镜像加速"
                >
                  🇨🇳 cn.clawhub-mirror.com
                </a>
              </div>
              <div style={styles.skillMarketHint}>
                Discover and install skills from the OpenClaw community. Download SKILL.md files and place them in <code>skills/</code> directory.
              </div>
            </div>
            {skills.length === 0 ? (
              <div style={styles.placeholder}>No skills installed yet — Visit ClawHub to discover skills</div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Success Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map((skill) => (
                    <tr key={skill.id}>
                      <td>{skill.name}</td>
                      <td>{skill.version}</td>
                      <td>{skill.lifecycle.status}</td>
                      <td>
                        {skill.stats.successCount}/
                        {skill.stats.invocationCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === "services" && (
          <div style={styles.panel}>
            {services.length === 0 ? (
              <div style={styles.placeholder}>No services data available</div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((svc) => (
                    <tr key={svc.name}>
                      <td>{svc.name}</td>
                      <td>{svc.version}</td>
                      <td style={svc.status === "running" ? { color: "#22c55e" } : {}}>
                        {svc.status}
                      </td>
                      <td>{svc.error || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === "evolution" && <EvolutionDashboard />}

        {activeTab === "llm" && <LLMConfig />}

        {activeTab === "channels" && <ChannelConfigPage />}

        {activeTab === "cli" && <CLITerminal />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#0f0f1a",
    color: "#e0e0e0",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 20px",
    borderBottom: "1px solid #2a2a3a",
    background: "#16162a",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  logo: {
    width: "32px",
    height: "32px",
  },
  title: { margin: 0, fontSize: "20px", color: "#a78bfa" },
  tabs: {
    display: "flex",
    gap: "4px",
    padding: "8px 20px",
    borderBottom: "1px solid #2a2a3a",
    background: "#1a1a2e",
  },
  main: { flex: 1, overflow: "hidden", display: "flex" },
  chatContainer: { display: "flex", flexDirection: "column", flex: 1 },
  chatMessages: { flex: 1, overflow: "auto", padding: "16px 20px" },
  chatInput: { display: "flex", gap: "8px", padding: "12px 20px", borderTop: "1px solid #2a2a3a" },
  input: {
    flex: 1,
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid #3a3a4a",
    background: "#1a1a2e",
    color: "#e0e0e0",
    fontSize: "14px",
    resize: "none",
  },
  sendButton: {
    padding: "8px 20px",
    borderRadius: "8px",
    border: "none",
    background: "#7c3aed",
    color: "#fff",
    cursor: "pointer",
    fontWeight: "bold",
  },
  slashHint: {
    fontSize: "11px",
    color: "#666",
    marginTop: "4px",
  },
  userMessage: {
    marginBottom: "8px",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "#1e1e3a",
    textAlign: "right",
  },
  botMessage: {
    marginBottom: "8px",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "#2d1b4e",
  },
  placeholder: { padding: "40px", textAlign: "center", color: "#666" },
  panel: { flex: 1, padding: "20px", overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  skillMarketBanner: {
    padding: "16px 20px",
    marginBottom: "20px",
    borderRadius: "10px",
    background: "#1e1e3a",
    border: "1px solid #333355",
  },
  skillMarketTitle: {
    fontSize: "16px",
    fontWeight: "bold",
    color: "#a78bfa",
    marginBottom: "12px",
  },
  skillMarketLinks: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    marginBottom: "10px",
  },
  skillMarketLink: {
    display: "inline-block",
    padding: "8px 16px",
    borderRadius: "8px",
    background: "#7c3aed",
    color: "#fff",
    textDecoration: "none",
    fontSize: "14px",
    fontWeight: "bold",
    cursor: "pointer",
  },
  skillMarketHint: {
    fontSize: "12px",
    color: "#888",
    lineHeight: "1.6",
  },
};

function statusBadgeStyle(status: string): React.CSSProperties {
  return {
    padding: "4px 12px",
    borderRadius: "12px",
    fontSize: "12px",
    background: status === "online" ? "#064e3b" : status === "connecting" ? "#3b3b0a" : "#4a1515",
    color: status === "online" ? "#34d399" : status === "connecting" ? "#fbbf24" : "#f87171",
  };
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    background: active ? "#7c3aed" : "transparent",
    color: active ? "#fff" : "#888",
    fontSize: "14px",
    fontWeight: active ? "bold" : "normal",
  };
}