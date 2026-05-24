import React, { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import EvolutionDashboard from "./EvolutionDashboard";
import LLMConfig from "./LLMConfig";
import ChannelConfigPage from "./ChannelConfig";
import SkillsConfig from "./SkillsConfig";
import { CLITerminal } from "./CLITerminal";
import Dashboard from "./Dashboard";
import { BootstrapConfig } from "./BootstrapConfig";
import { StatusPage } from "./StatusPage";
import { LogsPage } from "./LogsPage";
import { CronPage } from "./CronPage";
import { CanvasPage } from "./CanvasPage";
import { WebChatPage } from "./WebChatPage";
import { PluginsPage } from "./PluginsPage";
import { EventsPage } from "./EventsPage";
import { PermissionsPage } from "./PermissionsPage";
import { OpsPage } from "./OpsPage";
import { THEMES, getStoredThemeId, storeThemeId, getThemeById, applyThemeToDocument, type ThemeDefinition } from "./theme";
import { ToastContainer } from "./shared";

// New pages
import SecretsManagerPage from "./SecretsManagerPage";
import DeadLetterQueuePage from "./DeadLetterQueuePage";
import ConfigRPCPage from "./ConfigRPCPage";
import ModelSwitcherPage from "./ModelSwitcherPage";
import SessionRetentionPage from "./SessionRetentionPage";
import FeatureFlagsPage from "./FeatureFlagsPage";
import ConfigMigrationPage from "./ConfigMigrationPage";
import ConfigDoctorPage from "./ConfigDoctorPage";
import HealthAggregatorPage from "./HealthAggregatorPage";
import MessageTemplatesPage from "./MessageTemplatesPage";
import ReplyReferencePage from "./ReplyReferencePage";

type TabId =
  | "chat" | "status" | "dashboard"
  | "events" | "skills" | "bootstrap" | "canvas" | "monitoring"
  | "plugins" | "permissions" | "cron" | "llm" | "channels" | "evolution"
  | "ops" | "cli"
  | "secrets" | "dlq" | "config-rpc" | "model-switcher" | "retention"
  | "feature-flags" | "config-migration" | "config-doctor"
  | "health-aggregator" | "message-templates" | "reply-refs";

interface NavGroup {
  id: string;
  label: string;
  icon: string;
  items: NavItem[];
}

interface NavItem {
  id: TabId;
  label: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: "main", label: "Main", icon: "&#9679;",
    items: [
      { id: "chat", label: "Chat" },
      { id: "status", label: "Status" },
      { id: "dashboard", label: "Dashboard" },
    ],
  },
  {
    id: "system", label: "System", icon: "&#9632;",
    items: [
      { id: "events", label: "Events" },
      { id: "skills", label: "Skills" },
      { id: "bootstrap", label: "Bootstrap" },
      { id: "canvas", label: "Canvas" },
      { id: "monitoring", label: "Monitoring" },
    ],
  },
  {
    id: "config", label: "Configuration", icon: "&#9881;",
    items: [
      { id: "plugins", label: "Plugins" },
      { id: "permissions", label: "Permissions" },
      { id: "cron", label: "Cron Jobs" },
      { id: "llm", label: "LLM Config" },
      { id: "channels", label: "Channels" },
      { id: "evolution", label: "Evolution" },
    ],
  },
  {
    id: "security", label: "Security", icon: "&#128274;",
    items: [
      { id: "secrets", label: "Secrets" },
      { id: "dlq", label: "Dead Letter Q" },
      { id: "feature-flags", label: "Feature Flags" },
      { id: "permissions", label: "Permissions" },
    ],
  },
  {
    id: "admin", label: "Administration", icon: "&#128295;",
    items: [
      { id: "config-rpc", label: "Config RPC" },
      { id: "model-switcher", label: "Model Switcher" },
      { id: "retention", label: "Retention" },
      { id: "config-migration", label: "Migrations" },
      { id: "config-doctor", label: "Config Doctor" },
    ],
  },
  {
    id: "health", label: "Health & Tools", icon: "&#9829;",
    items: [
      { id: "health-aggregator", label: "Health" },
      { id: "reply-refs", label: "Reply Refs" },
      { id: "message-templates", label: "Templates" },
    ],
  },
  {
    id: "ops-group", label: "Operations", icon: "&#9654;",
    items: [
      { id: "ops", label: "Ops" },
      { id: "cli", label: "CLI Terminal" },
    ],
  },
];

interface AvatarInfo {
  user: string;
  bot: string;
  userNickname: string;
  botNickname: string;
}

const DEFAULT_AVATARS: AvatarInfo = {
  user: "assets/images/user.png",
  bot: "assets/images/favicon-32x32.png",
  userNickname: "Me",
  botNickname: "EvoClaw",
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [authenticated, setAuthenticated] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [avatars, setAvatars] = useState<AvatarInfo>(DEFAULT_AVATARS);
  const [showAvatarEditor, setShowAvatarEditor] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [currentTheme, setCurrentTheme] = useState<ThemeDefinition>(() => getThemeById(getStoredThemeId()));
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => { checkAuth(); }, []);
  useEffect(() => { applyThemeToDocument(currentTheme); }, [currentTheme]);

  useEffect(() => {
    const styleId = "EvoClaw-global-styles";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes EvoClaw-fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes EvoClaw-scale-in { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @keyframes EvoClaw-slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes EvoClaw-slide-up { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes EvoClaw-typing-bounce {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
        30% { transform: translateY(-6px); opacity: 1; }
      }
      @keyframes EvoClaw-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      * { box-sizing: border-box; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
      .sidebar-item:hover .sidebar-item-actions { opacity: 1; }
      .code-block-wrapper {
        margin: 12px 0; border-radius: 8px; overflow: hidden;
        border: 1px solid var(--border); background: #0d1117;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
      }
      .code-block-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 6px 14px; background: #161b22; border-bottom: 1px solid #30363d;
      }
      .code-lang-label { font-size: 11px; color: #8b949e; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
      .code-copy-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 11px; font-family: inherit; transition: all 0.15s; }
      .code-copy-btn:hover { background: #30363d; border-color: #8b949e; }
      .code-block-pre { margin: 0; padding: 14px; overflow-x: auto; background: #0d1117; font-size: 13px; line-height: 1.55; white-space: pre; word-wrap: normal; }
      .code-block-pre code { font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace; font-size: 13px; background: transparent; padding: 0; border: none; color: #c9d1d9; }
    `;
    document.head.appendChild(style);
  }, []);

  function switchTheme(themeId: string) {
    const theme = getThemeById(themeId);
    setCurrentTheme(theme);
    storeThemeId(themeId);
    setShowThemePicker(false);
  }

  async function checkAuth() {
    try {
      const res = await fetch("/api/health");
      if (res.ok) { setStatus("online"); setAuthenticated(true); }
      else setAuthenticated(false);
    } catch { setStatus("offline"); setAuthenticated(false); }
    setAuthChecked(true);
  }

  async function submitToken() {
    if (!tokenInput.trim()) return;
    try {
      const res = await fetch("/api/health", { headers: { Cookie: `web_ui_token=${tokenInput.trim()}` } });
      if (res.ok) {
        document.cookie = `web_ui_token=${tokenInput.trim()}; path=/; max-age=86400; SameSite=Lax`;
        setAuthenticated(true); setStatus("online"); setTokenInput("");
      } else setStatus("offline");
    } catch { setStatus("offline"); }
  }

  async function loadAvatars() {
    try {
      const res = await fetch("/api/config/avatars");
      if (res.ok) {
        const data = await res.json();
        if (data.avatars) setAvatars({ ...DEFAULT_AVATARS, ...data.avatars });
      }
    } catch { /* use defaults */ }
  }

  useEffect(() => { if (authenticated) loadAvatars(); }, [authenticated]);

  async function saveAvatars(updated: AvatarInfo) {
    try {
      await fetch("/api/config/avatars", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatars: updated }) });
    } catch { /* save locally */ }
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
    saveAvatars({ ...avatars, [target]: url });
    setShowAvatarEditor(false);
    setAvatarFile(null);
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }

  const filteredGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: sidebarSearch
      ? group.items.filter((item) => item.label.toLowerCase().includes(sidebarSearch.toLowerCase()))
      : group.items,
  })).filter((group) => group.items.length > 0);

  // ─── Auth screens ────────────────────────────────────────────

  if (!authChecked) {
    return (
      <div style={s.loadingScreen}>
        <div style={{ fontSize: "32px", fontWeight: 700, color: "var(--accent)", marginBottom: "12px" }}>EvoClaw</div>
        <SpinnerPulse />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div style={s.authScreen}>
        <div style={s.authCard}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--accent)", marginBottom: "8px" }}>EvoClaw</div>
          <p style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "20px" }}>
            Enter the Web UI access token to continue
          </p>
          <input
            type="password"
            style={s.authInput}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitToken(); }}
            placeholder="Enter token..."
            autoFocus
          />
          <button style={s.authBtn} onClick={submitToken}>Access</button>
          {status === "offline" && (
            <p style={{ color: "var(--error)", fontSize: "12px", marginTop: "14px" }}>
              Server not reachable or invalid token
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─── Main layout ─────────────────────────────────────────────

  const sidebarW = sidebarCollapsed ? 56 : 240;
  const showMobileSidebar = mobileMenuOpen && !sidebarCollapsed;

  function renderPage() {
    switch (activeTab) {
      case "chat": return <WebChatPage />;
      case "status": return <StatusPage />;
      case "dashboard": return <Dashboard />;
      case "events": return <EventsPage />;
      case "skills": return <SkillsConfig />;
      case "bootstrap": return <BootstrapConfig />;
      case "canvas": return <CanvasPage />;
      case "monitoring": return <LogsPage />;
      case "plugins": return <PluginsPage />;
      case "permissions": return <PermissionsPage />;
      case "cron": return <CronPage />;
      case "llm": return <LLMConfig />;
      case "channels": return <ChannelConfigPage />;
      case "evolution": return <EvolutionDashboard />;
      case "ops": return <OpsPage />;
      case "cli": return <CLITerminal />;
      case "secrets": return <SecretsManagerPage />;
      case "dlq": return <DeadLetterQueuePage />;
      case "config-rpc": return <ConfigRPCPage />;
      case "model-switcher": return <ModelSwitcherPage />;
      case "retention": return <SessionRetentionPage />;
      case "feature-flags": return <FeatureFlagsPage />;
      case "config-migration": return <ConfigMigrationPage />;
      case "config-doctor": return <ConfigDoctorPage />;
      case "health-aggregator": return <HealthAggregatorPage />;
      case "message-templates": return <MessageTemplatesPage />;
      case "reply-refs": return <ReplyReferencePage />;
      default: return <WebChatPage />;
    }
  }

  function handleNavClick(id: TabId) {
    setActiveTab(id);
    setMobileMenuOpen(false);
  }

  return (
    <div style={s.layoutContainer}>
      <ToastContainer />

      {/* Mobile overlay */}
      {showMobileSidebar && (
        <div style={s.mobileOverlay} onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Header */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <button style={s.menuBtn} onClick={() => { if (sidebarCollapsed) setSidebarCollapsed(false); setMobileMenuOpen(!mobileMenuOpen); }} title="Toggle menu">
            <span style={{ fontSize: "18px", lineHeight: 1 }}>&#9776;</span>
          </button>
          <img src="/android-chrome-192x192.png" alt="EvoClaw" style={s.headerLogo} />
          <span style={s.headerTitle}>EvoClaw</span>
        </div>
        <div style={s.headerRight}>
          <div style={{ position: "relative" }}>
            <button style={s.themeBtn} onClick={() => setShowThemePicker(!showThemePicker)} title="Change theme">
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: currentTheme.colors.accent, marginRight: 5 }} />
              {currentTheme.name}
            </button>
            {showThemePicker && (
              <div style={s.themeDropdown}>
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    style={{
                      ...s.themeOption,
                      background: currentTheme.id === t.id ? "var(--accent-bg)" : "transparent",
                      color: currentTheme.id === t.id ? "var(--accent)" : "var(--text-secondary)",
                    }}
                    onClick={() => switchTheme(t.id)}
                  >
                    <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: t.colors.accent, marginRight: 6 }} />
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={statusBadge(status)}>
            {status === "online" ? "Online" : status === "connecting" ? "..." : "Offline"}
          </div>
          <button style={s.iconBtn} onClick={() => setShowAvatarEditor(!showAvatarEditor)} title="Edit profile">
            &#9881;
          </button>
        </div>
      </header>

      {/* Avatar Editor */}
      {showAvatarEditor && (
        <div style={s.avatarEditor}>
          <div style={s.avatarRow}>
            <span style={s.avatarLabel}>Your Avatar:</span>
            <img src={avatars.user} style={s.avatarPreview} alt="user" />
            <button style={s.avatarActionBtn} onClick={() => handleAvatarUpload("user")}>Change</button>
            <input style={s.nickInput} value={avatars.userNickname} onChange={(e) => saveAvatars({ ...avatars, userNickname: e.target.value })} placeholder="Nickname" />
          </div>
          <div style={s.avatarRow}>
            <span style={s.avatarLabel}>Bot Avatar:</span>
            <img src={avatars.bot} style={s.avatarPreview} alt="bot" />
            <button style={s.avatarActionBtn} onClick={() => handleAvatarUpload("bot")}>Change</button>
            <input style={s.nickInput} value={avatars.botNickname} onChange={(e) => saveAvatars({ ...avatars, botNickname: e.target.value })} placeholder="Nickname" />
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileSelected} />
          {avatarFile && (
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Selected: {avatarFile.name}</span>
              <button style={s.avatarActionBtn} onClick={applyAvatar}>Apply</button>
            </div>
          )}
          <button style={{ ...s.avatarActionBtn, marginTop: 4 }} onClick={() => setShowAvatarEditor(false)}>Close</button>
        </div>
      )}

      {/* Body: Sidebar + Content */}
      <div style={s.body}>
        {/* Sidebar */}
        <aside style={{
          ...s.sidebar,
          width: sidebarCollapsed ? 56 : 240,
          minWidth: sidebarCollapsed ? 56 : 240,
        }}
          className={showMobileSidebar ? "sidebar-mobile-open" : ""}
        >
          {!sidebarCollapsed && (
            <div style={s.sidebarInner}>
              {/* Search */}
              <div style={s.sidebarSearchWrap}>
                <input
                  style={s.sidebarSearch}
                  value={sidebarSearch}
                  onChange={(e) => setSidebarSearch(e.target.value)}
                  placeholder="Search pages..."
                />
              </div>

              {/* Nav Groups */}
              <nav style={s.sidebarNav}>
                {filteredGroups.map((group) => {
                  const isCollapsed = collapsedGroups.has(group.id);
                  return (
                    <div key={group.id} style={s.navGroup}>
                      <button
                        style={s.navGroupHeader}
                        onClick={() => toggleGroup(group.id)}
                        title={group.label}
                      >
                        <span style={s.navChevron} dangerouslySetInnerHTML={{ __html: isCollapsed ? "&#9654;" : "&#9660;" }} />
                        <span style={s.navGroupLabel}>{group.label}</span>
                      </button>
                      {!isCollapsed && group.items.map((item) => (
                        <button
                          key={item.id}
                          style={navItemStyle(item.id === activeTab)}
                          onClick={() => handleNavClick(item.id)}
                        >
                          <span style={navDotStyle(item.id === activeTab)} />
                          {item.label}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </nav>
            </div>
          )}

          {/* Collapse toggle at bottom */}
          <button
            style={s.sidebarToggle}
            onClick={() => { setSidebarCollapsed(!sidebarCollapsed); setCollapsedGroups(new Set()); }}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span style={{ fontSize: 14, transform: sidebarCollapsed ? "rotate(180deg)" : "none", display: "inline-block", transition: "transform 0.2s" }}>
              &#9654;&#9654;
            </span>
          </button>
        </aside>

        {/* Main Content */}
        <main style={s.mainContent}>
          {renderPage()}
        </main>
      </div>
    </div>
  );
}

function SpinnerPulse() {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {[0, 0.15, 0.3].map((delay, i) => (
        <div key={i} style={{
          width: 8, height: 8, borderRadius: "50%",
          background: "var(--accent)", opacity: 0.5,
          animation: `EvoClaw-typing-bounce 1.2s ${delay}s infinite ease-in-out`,
        }} />
      ))}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────

const s: Record<string, CSSProperties> = {
  layoutContainer: { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", background: "var(--bg-primary)", color: "var(--text-primary)" },
  loadingScreen: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)", gap: 12 },
  authScreen: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)" },
  authCard: { background: "var(--bg-card)", borderRadius: 12, padding: "36px 40px", border: "1px solid var(--border)", textAlign: "center", maxWidth: 380, width: "90%" },
  authInput: { width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid var(--input-border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 14, marginBottom: 12, boxSizing: "border-box", outline: "none" },
  authBtn: { width: "100%", padding: "11px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 14 },

  // Header
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--header-bg)", zIndex: 50, flexShrink: 0 },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  headerLogo: { width: 28, height: 28 },
  headerTitle: { fontSize: 18, fontWeight: 700, color: "var(--accent)", letterSpacing: "-0.3px" },
  menuBtn: { width: 32, height: 32, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
  themeBtn: { padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-primary)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", display: "flex", alignItems: "center" },
  themeDropdown: { position: "absolute", top: "100%", right: 0, marginTop: 4, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 4, zIndex: 100, minWidth: 170, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" },
  themeOption: { display: "block", width: "100%", padding: "8px 12px", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, textAlign: "left", background: "transparent" },
  iconBtn: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1 },

  // Avatar editor
  avatarEditor: { padding: "10px 16px", background: "var(--bg-card)", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 },
  avatarRow: { display: "flex", alignItems: "center", gap: 8 },
  avatarLabel: { fontSize: 11, color: "var(--text-muted)", minWidth: 80 },
  avatarPreview: { width: 28, height: 28, borderRadius: "50%" },
  avatarActionBtn: { padding: "4px 10px", borderRadius: 4, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 11 },
  nickInput: { padding: "4px 8px", borderRadius: 4, border: "1px solid var(--input-border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 11, width: 140 },

  // Body
  body: { display: "flex", flex: 1, minHeight: 0, overflow: "hidden" },

  // Sidebar
  sidebar: { background: "var(--bg-sidebar)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", transition: "width 0.2s, min-width 0.2s", overflow: "hidden", flexShrink: 0 },
  sidebarInner: { display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" },
  sidebarSearchWrap: { padding: "10px 12px" },
  sidebarSearch: { width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" },
  sidebarNav: { flex: 1, overflow: "auto", padding: "0 8px 8px" },
  sidebarToggle: { padding: "10px", border: "none", borderTop: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, display: "flex", justifyContent: "center", alignItems: "center", flexShrink: 0, transition: "color 0.15s" },

  // Nav groups
  navGroup: { marginBottom: 4 },
  navGroupHeader: { display: "flex", alignItems: "center", gap: 4, width: "100%", padding: "7px 8px", border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px" },
  navChevron: { fontSize: 8, width: 12, display: "inline-flex", justifyContent: "center" },
  navGroupLabel: { flex: 1, textAlign: "left" as const },

  // Main content
  mainContent: { flex: 1, minWidth: 0, overflow: "auto", display: "flex", flexDirection: "column", background: "var(--bg-secondary)" },

  // Mobile
  mobileOverlay: { display: "none" },
};

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 8,
    width: "100%", padding: "7px 10px 7px 22px",
    border: "none", borderRadius: 6,
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    cursor: "pointer", fontSize: 13,
    fontWeight: active ? 600 : 400,
    textAlign: "left" as const,
    transition: "all 0.12s",
  };
}

function navDotStyle(active: boolean): CSSProperties {
  return {
    display: "inline-block", width: 6, height: 6, borderRadius: "50%",
    background: active ? "var(--accent)" : "transparent",
    flexShrink: 0, transition: "background 0.15s",
  };
}

function statusBadge(status: string): CSSProperties {
  const bg = status === "online" ? "var(--success-bg)" : status === "connecting" ? "var(--warning-bg)" : "var(--error-bg)";
  const fg = status === "online" ? "var(--success)" : status === "connecting" ? "var(--warning)" : "var(--error)";
  return {
    padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600,
    background: bg, color: fg,
  };
}