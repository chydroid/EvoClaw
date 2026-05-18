import React, { useState, useEffect, useRef } from "react";
import EvolutionDashboard from "./EvolutionDashboard";
import LLMConfig from "./LLMConfig";
import ChannelConfigPage from "./ChannelConfig";
import SkillsConfig from "./SkillsConfig";
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

interface ChatMessage {
  role: "user" | "bot";
  content: string;
  time: string;
}

interface AvatarInfo {
  user: string;
  bot: string;
  userNickname: string;
  botNickname: string;
}

const DEFAULT_AVATARS: AvatarInfo = {
  user: "/assets/images/user.png",
  bot: "/assets/images/favicon-32x32.png",
  userNickname: "Me",
  botNickname: "EcoClaw小助手",
};

export default function App() {
  const [activeTab, setActiveTab] = useState<"chat" | "skills" | "services" | "evolution" | "llm" | "channels" | "cli">("chat");
  const [message, setMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [authenticated, setAuthenticated] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [avatars, setAvatars] = useState<AvatarInfo>(DEFAULT_AVATARS);
  const [showAvatarEditor, setShowAvatarEditor] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (authenticated) {
      loadSkills();
      loadServices();
      loadAvatars();
    }
  }, [authenticated]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  async function checkAuth() {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        setStatus("online");
        setAuthenticated(true);
      } else {
        setAuthenticated(false);
      }
    } catch {
      setStatus("offline");
      setAuthenticated(false);
    }
    setAuthChecked(true);
  }

  async function submitToken() {
    if (!tokenInput.trim()) return;
    try {
      const res = await fetch("/api/health", {
        headers: { Cookie: `web_ui_token=${tokenInput.trim()}` },
      });
      if (res.ok) {
        document.cookie = `web_ui_token=${tokenInput.trim()}; path=/; max-age=86400; SameSite=Lax`;
        setAuthenticated(true);
        setStatus("online");
        setTokenInput("");
      } else {
        setStatus("offline");
      }
    } catch {
      setStatus("offline");
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
      console.debug("[App] Skills API not available");
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
      console.debug("[App] Services API not available");
    }
  }

  async function loadAvatars() {
    try {
      const res = await fetch("/api/config/avatars");
      if (res.ok) {
        const data = await res.json();
        if (data.avatars) {
          setAvatars({ ...DEFAULT_AVATARS, ...data.avatars });
        }
      }
    } catch {
      // use defaults
    }
  }

  async function saveAvatars(updated: AvatarInfo) {
    try {
      await fetch("/api/config/avatars", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatars: updated }),
      });
    } catch {
      // save locally
    }
    setAvatars(updated);
  }

  function handleAvatarUpload(target: "user" | "bot") {
    fileInputRef.current?.click();
    fileInputRef.current?.setAttribute("data-target", target);
  }

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setShowAvatarEditor(true);
  }

  function applyAvatar() {
    if (!avatarFile) return;
    const url = URL.createObjectURL(avatarFile);
    const target = fileInputRef.current?.getAttribute("data-target") as "user" | "bot" || "user";
    const updated = { ...avatars, [target]: url };
    saveAvatars(updated);
    setShowAvatarEditor(false);
    setAvatarFile(null);
  }

  function formatReply(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        if (line.startsWith("## ")) return `<h3>${line.slice(3)}</h3>`;
        if (line.startsWith("# ")) return `<h2>${line.slice(2)}</h2>`;
        if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
        if (/^\d+\.\s/.test(line)) return `<li>${line.replace(/^\d+\.\s/, "")}</li>`;
        if (line.startsWith("> ")) return `<blockquote>${line.slice(2)}</blockquote>`;
        if (line.startsWith("```")) return "";
        if (line.match(/^\*\*.*\*\*$/)) return `<b>${line.slice(2, -2)}</b>`;
        if (line.trim() === "") return "<br/>";
        return line;
      })
      .join("\n");
  }

  async function sendMessage() {
    if (!message.trim()) return;

    const trimmed = message.trim();
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChatHistory((prev) => [...prev, { role: "user", content: trimmed, time: now }]);

    if (trimmed.startsWith("/")) {
      const slashResult = await handleSlashCommand(trimmed);
      if (slashResult !== null) {
        const botNow = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setChatHistory((prev) => [...prev, { role: "bot", content: slashResult, time: botNow }]);
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
        const reply = data.reply || "No response";
        const botNow = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setChatHistory((prev) => [
          ...prev,
          { role: "bot", content: reply, time: botNow },
        ]);
      } else {
        setChatHistory((prev) => [...prev, { role: "bot", content: "Server returned an error", time: now }]);
      }
    } catch {
      setChatHistory((prev) => [...prev, { role: "bot", content: "Unable to connect to server", time: now }]);
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
          "**📋 斜杠命令**",
          "",
          "| 命令 | 说明 |",
          "|---|---|",
          "| /help | 显示帮助 |",
          "| /clear | 清空会话 |",
          "| /status | 系统状态 |",
          "| /health | 健康检查 |",
          "| /skills | 列出技能 |",
          "| /model | 模型信息 |",
          "| /whoami | 会话信息 |",
        ].join("\n");

      case "clear":
        setChatHistory([]);
        return "✅ 会话已清空";

      case "new":
        setChatHistory([]);
        return arg ? `✅ 新会话已开始，模型: ${arg}` : "✅ 新会话已开始";

      case "status":
        try {
          const statusRes = await fetch("/api/system/services");
          if (statusRes.ok) {
            const svcs = await statusRes.json() as Array<Record<string, unknown>>;
            return `📊 系统在线，${svcs.length} 个服务运行中`;
          }
        } catch {}
        return "⚠️ 无法获取系统状态";

      case "health":
        try {
          const healthRes = await fetch("/api/health");
          if (healthRes.ok) {
            const h = await healthRes.json() as Record<string, unknown>;
            return `✅ 健康 | v${h.version || "?"} | 运行 ${Math.round((h.uptime as number) || 0)}s`;
          }
        } catch {}
        return "❌ 健康检查失败";

      case "whoami":
      case "id":
        return "🆔 当前会话: web-ui";

      case "model":
        return "📋 模型配置请前往 **LLM** 标签页。支持 OpenAI / Anthropic / DeepSeek / 本地模型";

      case "skills":
        try {
          const skillsRes = await fetch("/api/skills");
          if (skillsRes.ok) {
            const sk = await skillsRes.json() as Array<Record<string, unknown>>;
            if (sk.length === 0) return "📦 暂无已安装的技能";
            return sk.map((s) => `- ${s.name} v${s.version}`).join("\n");
          }
        } catch {}
        return "⚠️ 无法获取技能列表";

      default:
        return null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (!authChecked) {
    return (
      <div style={s.container}>
        <div style={s.loadingScreen}>
          <h2 style={{ color: "#a78bfa" }}>EcoClaw</h2>
          <p style={{ color: "#888" }}>Connecting...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div style={s.container}>
        <header style={s.header}>
          <div style={s.headerLeft}>
            <img src="/android-chrome-192x192.png" alt="EcoClaw" style={s.logo} />
            <h1 style={s.title}>EcoClaw</h1>
          </div>
        </header>
        <div style={s.authScreen}>
          <div style={s.authCard}>
            <h2 style={{ color: "#a78bfa", marginTop: 0 }}>🔐 Authentication</h2>
            <p style={{ color: "#888", fontSize: "14px", marginBottom: "16px" }}>
              Enter the Web UI access token to continue
            </p>
            <input
              type="password"
              style={s.authInput}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitToken(); }}
              placeholder="Enter token..."
            />
            <button style={s.authBtn} onClick={submitToken}>
              Access
            </button>
            {status === "offline" && (
              <p style={{ color: "#f87171", fontSize: "12px", marginTop: "12px" }}>
                Server not reachable or invalid token
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <header style={s.header}>
        <div style={s.headerLeft}>
          <img src="/android-chrome-192x192.png" alt="EcoClaw" style={s.logo} />
          <h1 style={s.title}>EcoClaw</h1>
        </div>
        <div style={s.headerRight}>
          <div style={statusBadgeStyle(status)}>
            {status === "online" ? "● Online" : status === "connecting" ? "◌ Connecting" : "○ Offline"}
          </div>
          <button style={s.avatarEditBtn} onClick={() => setShowAvatarEditor(!showAvatarEditor)} title="Edit profile">
            ⚙
          </button>
        </div>
      </header>

      {showAvatarEditor && (
        <div style={s.avatarEditor}>
          <div style={s.avatarEditorRow}>
            <span style={s.avatarEditorLabel}>Your Avatar:</span>
            <img src={avatars.user} style={s.avatarPreview} alt="user" />
            <button style={s.avatarChangeBtn} onClick={() => handleAvatarUpload("user")}>Change</button>
            <input
              style={s.nicknameInput}
              value={avatars.userNickname}
              onChange={(e) => { const u = { ...avatars, userNickname: e.target.value }; saveAvatars(u); }}
              placeholder="Your nickname"
            />
          </div>
          <div style={s.avatarEditorRow}>
            <span style={s.avatarEditorLabel}>Bot Avatar:</span>
            <img src={avatars.bot} style={s.avatarPreview} alt="bot" />
            <button style={s.avatarChangeBtn} onClick={() => handleAvatarUpload("bot")}>Change</button>
            <input
              style={s.nicknameInput}
              value={avatars.botNickname}
              onChange={(e) => { const u = { ...avatars, botNickname: e.target.value }; saveAvatars(u); }}
              placeholder="Bot nickname"
            />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={onFileSelected}
          />
          {avatarFile && (
            <div style={{ marginTop: "8px" }}>
              <span style={{ fontSize: "12px", color: "#888", marginRight: "8px" }}>
                Selected: {avatarFile.name}
              </span>
              <button style={s.avatarChangeBtn} onClick={applyAvatar}>Apply</button>
            </div>
          )}
          <button style={{ ...s.avatarChangeBtn, marginTop: "8px" }} onClick={() => setShowAvatarEditor(false)}>
            Close
          </button>
        </div>
      )}

      <nav style={s.tabs}>
        <button style={tabStyle(activeTab === "chat")} onClick={() => setActiveTab("chat")}>Chat</button>
        <button style={tabStyle(activeTab === "skills")} onClick={() => setActiveTab("skills")}>Skills ({skills.length})</button>
        <button style={tabStyle(activeTab === "services")} onClick={() => setActiveTab("services")}>Services ({services.length})</button>
        <button style={tabStyle(activeTab === "evolution")} onClick={() => setActiveTab("evolution")}>Evolution</button>
        <button style={tabStyle(activeTab === "llm")} onClick={() => setActiveTab("llm")}>LLM</button>
        <button style={tabStyle(activeTab === "channels")} onClick={() => setActiveTab("channels")}>Channels</button>
        <button style={tabStyle(activeTab === "cli")} onClick={() => setActiveTab("cli")}>🖥 CLI</button>
      </nav>

      <main style={s.main}>
        {activeTab === "chat" && (
          <div style={s.chatContainer}>
            <div style={s.chatMessages}>
              {chatHistory.length === 0 ? (
                <div style={s.welcomeScreen}>
                  <div style={s.welcomeCard}>
                    <img src={avatars.bot} style={s.welcomeAvatar} alt="bot" />
                    <h2 style={{ color: "#a78bfa", marginTop: "12px", marginBottom: "4px" }}>EcoClaw</h2>
                    <p style={{ color: "#888", fontSize: "14px", marginBottom: "16px" }}>
                      Self-Evolving Agent OS
                    </p>
                    <p style={{ color: "#aaa", fontSize: "13px", lineHeight: "1.6", maxWidth: "400px" }}>
                      Send a message to start chatting. EcoClaw can help with tasks, run skills, and evolve through learning.
                    </p>
                    <p style={{ color: "#666", fontSize: "11px", marginTop: "12px" }}>
                      Type <b>/help</b> for commands
                    </p>
                  </div>
                </div>
              ) : (
                chatHistory.map((msg, i) => (
                  <div key={i} style={msg.role === "user" ? s.msgRowUser : s.msgRowBot}>
                    <img
                      src={msg.role === "user" ? avatars.user : avatars.bot}
                      style={s.msgAvatar}
                      alt={msg.role}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={s.msgHeader}>
                        <span style={s.msgName}>
                          {msg.role === "user" ? avatars.userNickname : avatars.botNickname}
                        </span>
                        <span style={s.msgTime}>{msg.time}</span>
                      </div>
                      <div
                        style={msg.role === "user" ? s.userBubble : s.botBubble}
                        dangerouslySetInnerHTML={{ __html: formatReply(msg.content) }}
                      />
                    </div>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={s.chatInput}>
              <textarea
                style={s.input}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message... (/help for commands)"
                rows={2}
              />
              <div style={s.slashHint}>
                💡 Type <b>/help</b> for commands · <b>/clear</b> to reset
              </div>
              <button style={s.sendButton} onClick={sendMessage}>Send</button>
            </div>
          </div>
        )}

        {activeTab === "skills" && <SkillsConfig />}

        {activeTab === "services" && (
          <div style={s.panel}>
            {services.length === 0 ? (
              <div style={s.placeholder}>No services data available</div>
            ) : (
              <table style={s.table}>
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

const s: Record<string, React.CSSProperties> = {
  container: {
    display: "flex", flexDirection: "column", height: "100vh",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#0f0f1a", color: "#e0e0e0",
  },
  loadingScreen: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh" },
  authScreen: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1 },
  authCard: {
    background: "#1a1a2e", borderRadius: "12px", padding: "32px 40px",
    border: "1px solid #2a2a3a", textAlign: "center", maxWidth: "380px", width: "100%",
  },
  authInput: {
    width: "100%", padding: "10px 14px", borderRadius: "8px", border: "1px solid #3a3a4a",
    background: "#0f0f1a", color: "#e0e0e0", fontSize: "14px", marginBottom: "12px",
    boxSizing: "border-box" as const,
  },
  authBtn: {
    width: "100%", padding: "10px", borderRadius: "8px", border: "none",
    background: "#7c3aed", color: "#fff", cursor: "pointer", fontWeight: "bold", fontSize: "14px",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 20px", borderBottom: "1px solid #2a2a3a", background: "#16162a",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: "12px" },
  headerRight: { display: "flex", alignItems: "center", gap: "10px" },
  logo: { width: "32px", height: "32px" },
  title: { margin: 0, fontSize: "20px", color: "#a78bfa" },
  avatarEditBtn: {
    padding: "4px 8px", borderRadius: "4px", border: "1px solid #3a3a4a",
    background: "transparent", color: "#888", cursor: "pointer", fontSize: "14px",
  },
  avatarEditor: {
    padding: "12px 20px", background: "#1a1a2e", borderBottom: "1px solid #2a2a3a",
    display: "flex", flexDirection: "column", gap: "8px",
  },
  avatarEditorRow: { display: "flex", alignItems: "center", gap: "10px" },
  avatarEditorLabel: { fontSize: "12px", color: "#888", minWidth: "80px" },
  avatarPreview: { width: "32px", height: "32px", borderRadius: "50%" },
  avatarChangeBtn: {
    padding: "4px 10px", borderRadius: "4px", border: "1px solid #7c3aed",
    background: "transparent", color: "#7c3aed", cursor: "pointer", fontSize: "11px",
  },
  nicknameInput: {
    padding: "4px 8px", borderRadius: "4px", border: "1px solid #3a3a4a",
    background: "#0f0f1a", color: "#e0e0e0", fontSize: "12px", width: "150px",
  },
  tabs: {
    display: "flex", gap: "4px", padding: "8px 20px",
    borderBottom: "1px solid #2a2a3a", background: "#1a1a2e",
  },
  main: { flex: 1, overflow: "hidden", display: "flex" },
  chatContainer: { display: "flex", flexDirection: "column", flex: 1 },
  chatMessages: { flex: 1, overflow: "auto", padding: "16px 20px" },
  welcomeScreen: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%" },
  welcomeCard: {
    textAlign: "center", padding: "40px", background: "#1a1a2e",
    borderRadius: "12px", border: "1px solid #2a2a3a",
    display: "flex", flexDirection: "column", alignItems: "center",
  },
  welcomeAvatar: { width: "64px", height: "64px", borderRadius: "50%" },
  msgRowUser: { display: "flex", gap: "10px", marginBottom: "16px", justifyContent: "flex-end" },
  msgRowBot: { display: "flex", gap: "10px", marginBottom: "16px" },
  msgAvatar: { width: "36px", height: "36px", borderRadius: "50%", flexShrink: 0, marginTop: "4px" },
  msgHeader: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" },
  msgName: { fontSize: "12px", fontWeight: "bold", color: "#a78bfa" },
  msgTime: { fontSize: "11px", color: "#666" },
  userBubble: {
    padding: "10px 14px", borderRadius: "12px 12px 4px 12px",
    background: "#1e1e3a", maxWidth: "70%", display: "inline-block",
    fontSize: "14px", lineHeight: "1.6", whiteSpace: "pre-wrap", wordBreak: "break-word",
  },
  botBubble: {
    padding: "10px 14px", borderRadius: "12px 12px 12px 4px",
    background: "#2d1b4e", maxWidth: "85%", display: "inline-block",
    fontSize: "14px", lineHeight: "1.7", whiteSpace: "pre-wrap", wordBreak: "break-word",
  },
  chatInput: { display: "flex", flexDirection: "column", gap: "4px", padding: "12px 20px", borderTop: "1px solid #2a2a3a" },
  inputRow: { display: "flex", gap: "8px" },
  input: {
    flex: 1, padding: "10px 14px", borderRadius: "8px", border: "1px solid #3a3a4a",
    background: "#1a1a2e", color: "#e0e0e0", fontSize: "14px", resize: "none",
  },
  sendButton: {
    padding: "10px 24px", borderRadius: "8px", border: "none",
    background: "#7c3aed", color: "#fff", cursor: "pointer", fontWeight: "bold", fontSize: "14px",
  },
  slashHint: { fontSize: "11px", color: "#666" },
  placeholder: { padding: "40px", textAlign: "center", color: "#666" },
  panel: { flex: 1, padding: "20px", overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
};

function statusBadgeStyle(status: string): React.CSSProperties {
  return {
    padding: "4px 12px", borderRadius: "12px", fontSize: "12px",
    background: status === "online" ? "#064e3b" : status === "connecting" ? "#3b3b0a" : "#4a1515",
    color: status === "online" ? "#34d399" : status === "connecting" ? "#fbbf24" : "#f87171",
  };
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 16px", borderRadius: "6px", border: "none", cursor: "pointer",
    background: active ? "#7c3aed" : "transparent",
    color: active ? "#fff" : "#888", fontSize: "14px",
    fontWeight: active ? "bold" : "normal",
  };
}