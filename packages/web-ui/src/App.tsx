import React, { useState, useEffect, useCallback } from "react";
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
import { ICON_MAP, IconNewChat, IconChevronDown, IconChevronRight, IconChevronLeft, IconMenu, IconSearch, IconTranslate, IconPlus } from "./icons";
import { useTranslation, type Lang } from "./i18n";

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
  i18nKey: string;
  iconId: string;
  items: NavItem[];
}

interface NavItem {
  id: TabId;
  i18nKey: string;
  iconId?: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: "main",
    i18nKey: "nav.main",
    iconId: "dashboard",
    items: [
      { id: "chat", i18nKey: "nav.chat", iconId: "chat" },
      { id: "status", i18nKey: "nav.status", iconId: "status" },
      { id: "dashboard", i18nKey: "nav.dashboard", iconId: "dashboard" },
    ],
  },
  {
    id: "system",
    i18nKey: "nav.system",
    iconId: "system",
    items: [
      { id: "events", i18nKey: "nav.events", iconId: "events" },
      { id: "skills", i18nKey: "nav.skills", iconId: "skills" },
      { id: "bootstrap", i18nKey: "nav.bootstrap", iconId: "bootstrap" },
      { id: "canvas", i18nKey: "nav.canvas", iconId: "canvas" },
      { id: "monitoring", i18nKey: "nav.monitoring", iconId: "monitoring" },
    ],
  },
  {
    id: "config",
    i18nKey: "nav.config",
    iconId: "settings",
    items: [
      { id: "plugins", i18nKey: "nav.plugins", iconId: "plugins" },
      { id: "permissions", i18nKey: "nav.permissions", iconId: "permissions" },
      { id: "cron", i18nKey: "nav.cron", iconId: "cron" },
      { id: "llm", i18nKey: "nav.llm", iconId: "llm" },
      { id: "channels", i18nKey: "nav.channels", iconId: "channels" },
      { id: "evolution", i18nKey: "nav.evolution", iconId: "evolution" },
    ],
  },
  {
    id: "security",
    i18nKey: "nav.security",
    iconId: "security",
    items: [
      { id: "secrets", i18nKey: "nav.secrets", iconId: "secrets" },
      { id: "dlq", i18nKey: "nav.dlq", iconId: "dlq" },
      { id: "feature-flags", i18nKey: "nav.feature_flags", iconId: "feature-flags" },
    ],
  },
  {
    id: "admin",
    i18nKey: "nav.admin",
    iconId: "admin",
    items: [
      { id: "config-rpc", i18nKey: "nav.config_rpc", iconId: "config-rpc" },
      { id: "model-switcher", i18nKey: "nav.model_switcher", iconId: "model-switcher" },
      { id: "retention", i18nKey: "nav.retention", iconId: "retention" },
      { id: "config-migration", i18nKey: "nav.config_migration", iconId: "config-migration" },
      { id: "config-doctor", i18nKey: "nav.config_doctor", iconId: "config-doctor" },
    ],
  },
  {
    id: "health",
    i18nKey: "nav.health",
    iconId: "health",
    items: [
      { id: "health-aggregator", i18nKey: "nav.health_aggregator", iconId: "health-aggregator" },
      { id: "reply-refs", i18nKey: "nav.reply_refs", iconId: "reply-refs" },
      { id: "message-templates", i18nKey: "nav.templates", iconId: "message-templates" },
    ],
  },
  {
    id: "ops-group",
    i18nKey: "nav.ops",
    iconId: "ops",
    items: [
      { id: "ops", i18nKey: "nav.ops_page", iconId: "ops" },
      { id: "cli", i18nKey: "nav.cli", iconId: "cli" },
    ],
  },
];

// ─── Session types ────────────────────────────────────────────

interface SessionSummary {
  sessionId: string;
  agentId?: string;
  updatedAt?: number;
  createdAt?: string;
  messageCount?: number;
  status?: string;
  preview?: string;
}

const SESSIONS_PAGE_SIZE = 10;
const SESSIONS_DEFAULT_SHOW = 3;

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─── Avatar types ─────────────────────────────────────────────

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

// ─── App Component ────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [newChatCounter, setNewChatCounter] = useState(0);
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

  // Session list state
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsVisible, setSessionsVisible] = useState(SESSIONS_DEFAULT_SHOW);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { lang, setLang, t } = useTranslation();

  useEffect(() => { checkAuth(); }, []);
  useEffect(() => { applyThemeToDocument(currentTheme); }, [currentTheme]);

  // Global styles — injected once
  useEffect(() => {
    const styleId = "EvoClaw-global-styles";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = GLOBAL_CSS;
    document.head.appendChild(style);
  }, []);

  // Load sessions
  useEffect(() => {
    if (!authenticated) return;
    fetchSessions();
  }, [authenticated]);

  async function fetchSessions() {
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        const raw: any[] = Array.isArray(data) ? data : data?.sessions || [];
        const list: SessionSummary[] = raw.map((s: any) => ({
          sessionId: s.sessionId || "",
          agentId: s.agentId,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
          messageCount: s.turnCount || s.messageCount || 0,
          status: s.status,
          preview: s.preview || "",
        }));
        list.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
        setSessions(list);
      }
    } catch { /* ignore */ }
    setSessionsLoaded(true);
  }

  async function createSession() {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "default" }),
      });
      if (res.ok) {
        const data = await res.json();
        const s = data.session as any;
        const entry: SessionSummary = {
          sessionId: s?.sessionId || "",
          preview: "",
          messageCount: 0,
          status: "active",
          createdAt: new Date().toISOString(),
        };
        setSessions(prev => [entry, ...prev]);
        setActiveSessionId(entry.sessionId);
        setNewChatCounter(prev => prev + 1);
        setActiveTab("chat");
        setMobileMenuOpen(false);
      }
    } catch { /* ignore */ }
  }

  async function deleteSession(sessionId: string) {
    try {
      const res = await fetch(`/api/sessions/default/${sessionId}`, { method: "DELETE" });
      if (res.ok) {
        const remaining = sessions.filter(s => s.sessionId !== sessionId);
        setSessions(remaining);
        if (activeSessionId === sessionId) {
          if (remaining.length > 0) {
            setActiveSessionId(remaining[0].sessionId);
          } else {
            setActiveSessionId(null);
            setNewChatCounter(prev => prev + 1);
          }
        }
      }
    } catch { /* ignore */ }
    setDeleteTarget(null);
  }

  function handleLoadMoreSessions() {
    setSessionsVisible(prev => Math.min(prev + SESSIONS_PAGE_SIZE, sessions.length));
  }

  function handleNewSession() {
    createSession();
  }

  function handleSessionClick(sessionId: string) {
    setActiveSessionId(sessionId);
    setActiveTab("chat");
    setMobileMenuOpen(false);
  }

  function switchTheme(themeId: string) {
    const theme = getThemeById(themeId);
    setCurrentTheme(theme);
    storeThemeId(themeId);
    setShowThemePicker(false);
  }

  function switchLang(l: Lang) {
    setLang(l);
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
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }

  const filteredGroups = NAV_GROUPS.map(group => ({
    ...group,
    items: sidebarSearch
      ? group.items.filter(item => t(item.i18nKey).toLowerCase().includes(sidebarSearch.toLowerCase()))
      : group.items,
  })).filter(group => group.items.length > 0);

  // ─── Auth screens ────────────────────────────

  if (!authChecked) {
    return (
      <div style={css.loadingScreen}>
        <div style={{ fontSize: "32px", fontWeight: 700, color: "var(--accent)", marginBottom: "12px" }}>EvoClaw</div>
        <SpinnerPulse />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div style={css.authScreen}>
        <div style={css.authCard}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--accent)", marginBottom: "8px" }}>EvoClaw</div>
          <p style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "20px" }}>
            {t("app.auth.desc")}
          </p>
          <input
            type="password"
            style={css.authInput}
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submitToken(); }}
            placeholder={t("app.auth.placeholder")}
            autoFocus
          />
          <button style={css.authBtn} onClick={submitToken}>{t("app.auth.btn")}</button>
          {status === "offline" && (
            <p style={{ color: "var(--error)", fontSize: "12px", marginTop: "14px" }}>
              {t("app.auth.error")}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─── Main layout ─────────────────────────────

  const sidebarW = sidebarCollapsed ? 56 : 240;
  const showMobileSidebar = mobileMenuOpen && !sidebarCollapsed;

  function renderPage() {
    // Pass sessionId to WebChatPage with unique key for remount
    if (activeTab === "chat") {
      const chatKey = activeSessionId || `_new_${newChatCounter}`;
      return React.createElement(WebChatPage as any, { key: chatKey, sessionId: activeSessionId, avatars });
    }
    switch (activeTab) {
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
    if (id === "chat" && activeTab === "chat") return; // stay
    setActiveTab(id);
    if (id !== "chat") setActiveSessionId(null);
    setMobileMenuOpen(false);
  }

  // resolve icon for nav item
  function navIcon(iconId: string) {
    const C = ICON_MAP[iconId];
    return C ? <C size={16} /> : <span style={css.navItemDot} />;
  }

  return (
    <div style={css.layoutContainer}>
      <ToastContainer />

      {/* Delete session confirmation modal */}
      {deleteTarget && (
        <div style={modalOverlayStyle} onClick={() => setDeleteTarget(null)}>
          <div style={modalCardStyle} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10, color: "var(--text-primary)" }}>
              {lang === "zh" ? "确认删除" : "Confirm Deletion"}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
              {lang === "zh" ? "确定要删除此会话吗？此操作不可撤销。" : "Are you sure you want to delete this session? This action cannot be undone."}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={modalCancelBtn} onClick={() => setDeleteTarget(null)}>
                {lang === "zh" ? "取消" : "Cancel"}
              </button>
              <button style={modalDeleteBtn} onClick={() => deleteSession(deleteTarget)}>
                {lang === "zh" ? "删除" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile overlay */}
      {showMobileSidebar && (
        <div style={css.mobileOverlay} onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Header */}
      <header style={css.header}>
        <div style={css.headerLeft}>
          <button style={css.menuBtn} onClick={() => { if (sidebarCollapsed) setSidebarCollapsed(false); setMobileMenuOpen(!mobileMenuOpen); }} title={t("sidebar.toggle_menu")}>
            <IconMenu size={18} />
          </button>
          <img src="/android-chrome-192x192.png" alt="EvoClaw" style={css.headerLogo} />
          <span style={css.headerTitle}>EvoClaw</span>
        </div>
        <div style={css.headerRight}>
          {/* Language switcher */}
          <button
            style={{ ...css.headerBtn, display: "flex", alignItems: "center", gap: 4 }}
            onClick={() => switchLang(lang === "zh" ? "en" : "zh")}
            title={t("lang.label")}
          >
            <IconTranslate size={14} />
            <span className="nav-label-text">{t("lang.switch")}</span>
          </button>

          {/* Theme picker */}
          <div style={{ position: "relative" }}>
            <button style={css.headerBtn} onClick={() => setShowThemePicker(!showThemePicker)} title={t("theme.change")}>
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: currentTheme.colors.accent, marginRight: 5 }} />
              <span className="nav-label-text">{currentTheme.name}</span>
            </button>
            {showThemePicker && (
              <div style={css.themeDropdown}>
                {THEMES.map(tt => (
                  <button
                    key={tt.id}
                    style={{
                      ...css.themeOption,
                      background: currentTheme.id === tt.id ? "var(--accent-bg)" : "transparent",
                      color: currentTheme.id === tt.id ? "var(--accent)" : "var(--text-secondary)",
                    }}
                    onClick={() => switchTheme(tt.id)}
                  >
                    <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: tt.colors.accent, marginRight: 6 }} />
                    {t("theme." + tt.id as any)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Status badge */}
          <div style={statusBadge(status)}>
            {status === "online" ? t("app.online") : status === "connecting" ? t("app.connecting") : t("app.offline")}
          </div>

          {/* Profile */}
          <button style={css.headerBtn} onClick={() => setShowAvatarEditor(!showAvatarEditor)} title={t("profile.edit")}>
            <span style={{ fontSize: 14 }}>&#9881;</span>
          </button>
        </div>
      </header>

      {/* Avatar Editor */}
      {showAvatarEditor && (
        <div style={css.avatarEditor}>
          <div style={css.avatarRow}>
            <span style={css.avatarLabel}>{t("profile.your_avatar")}:</span>
            <img src={avatars.user} style={css.avatarPreview} alt="user" />
            <button style={css.avatarActionBtn} onClick={() => handleAvatarUpload("user")}>{t("profile.change")}</button>
            <input style={css.nickInput} value={avatars.userNickname} onChange={e => saveAvatars({ ...avatars, userNickname: e.target.value })} placeholder={t("profile.nickname")} />
          </div>
          <div style={css.avatarRow}>
            <span style={css.avatarLabel}>{t("profile.bot_avatar")}:</span>
            <img src={avatars.bot} style={css.avatarPreview} alt="bot" />
            <button style={css.avatarActionBtn} onClick={() => handleAvatarUpload("bot")}>{t("profile.change")}</button>
            <input style={css.nickInput} value={avatars.botNickname} onChange={e => saveAvatars({ ...avatars, botNickname: e.target.value })} placeholder={t("profile.nickname")} />
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileSelected} />
          {avatarFile && (
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Selected: {avatarFile.name}</span>
              <button style={css.avatarActionBtn} onClick={applyAvatar}>{t("profile.apply")}</button>
            </div>
          )}
          <button style={{ ...css.avatarActionBtn, marginTop: 4 }} onClick={() => setShowAvatarEditor(false)}>{t("profile.close")}</button>
        </div>
      )}

      {/* Body: Sidebar + Content */}
      <div style={css.body}>
        <aside
          style={{
            ...css.sidebar,
            width: sidebarCollapsed ? 56 : 240,
            minWidth: sidebarCollapsed ? 56 : 240,
          }}
          className={`EvoClaw-sidebar${showMobileSidebar ? " sidebar-mobile-open" : ""}`}
        >
          {!sidebarCollapsed && (
            <div style={css.sidebarInner}>
              {/* Search */}
              <div style={css.sidebarSearchWrap}>
                <IconSearch size={14} style={{ position: "absolute", left: 20, top: 16, color: "var(--text-muted)", pointerEvents: "none" as const }} />
                <input
                  style={css.sidebarSearch}
                  value={sidebarSearch}
                  onChange={e => setSidebarSearch(e.target.value)}
                  placeholder={t("sidebar.search")}
                />
              </div>

              <nav className="sidebar-scroll" style={css.sidebarNav}>
                {/* ── Sessions above MAIN ── */}
                {sessionsLoaded && sessions.length > 0 && (
                  <div style={css.sessionSection}>
                    <div style={css.sessionSectionHeader} onClick={() => toggleGroup("sessions")}>
                      {(() => { const ChatIcon = ICON_MAP["chat"]; return ChatIcon ? <ChatIcon size={14} style={{ opacity: 0.8 }} /> : null; })()}
                      <span style={css.navGroupLabel}>{t("sessions.title")}</span>
                      <span style={{ ...css.navChevron, marginLeft: "auto" }} dangerouslySetInnerHTML={{ __html: collapsedGroups.has("sessions") ? "&#9660;" : "&#9654;" }} />
                    </div>

                    {!collapsedGroups.has("sessions") && (
                      <>
                        {/* New Chat button inside sessions */}
                        <button
                          style={{ ...navItemStyle(false), color: "var(--accent)", fontWeight: 600 }}
                          onClick={createSession}
                        >
                          <IconNewChat size={15} />
                          {t("nav.new_chat")}
                        </button>

                        {sessions.slice(0, sessionsVisible).map(sess => (
                          <div
                            key={sess.sessionId}
                            style={sessionItemContainerStyle(activeSessionId === sess.sessionId && activeTab === "chat")}
                            onMouseEnter={() => setHoveredSessionId(sess.sessionId)}
                            onMouseLeave={() => setHoveredSessionId(null)}
                          >
                            <span
                              style={sessionItemClickStyle}
                              onClick={() => handleSessionClick(sess.sessionId)}
                              title={sess.preview || sess.sessionId}
                            >
                              {(() => { const ChatIcon = ICON_MAP["chat"]; return ChatIcon ? <ChatIcon size={13} style={{ opacity: activeSessionId === sess.sessionId && activeTab === "chat" ? 1 : 0.5, flexShrink: 0 }} /> : null; })()}
                              <span style={sessionLabelStyle}>
                                {sess.preview ? (() => {
                                  const cleaned = normalizeSpaces(sess.preview);
                                  return cleaned.length > 23 ? cleaned.slice(0, 23) + "..." : cleaned;
                                })() : `Session ${sess.sessionId.slice(-8)}`}
                              </span>
                            </span>
                            <button
                              style={sessionDeleteBtnStyle(hoveredSessionId === sess.sessionId)}
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget(sess.sessionId); }}
                              title={lang === "zh" ? "删除会话" : "Delete session"}
                            >
                              &#10005;
                            </button>
                          </div>
                        ))}
                        {sessionsVisible < sessions.length ? (
                          <button style={css.loadMoreBtn} onClick={handleLoadMoreSessions}>
                            <IconPlus size={12} />
                            {t("sessions.load_more")} ({sessions.length - sessionsVisible} {lang === "zh" ? "条剩余" : "left"})
                          </button>
                        ) : sessionsVisible > SESSIONS_DEFAULT_SHOW ? (
                          <button style={css.loadMoreBtn} onClick={() => setSessionsVisible(SESSIONS_DEFAULT_SHOW)}>
                            &#9650; {lang === "zh" ? "折叠 (显示3条)" : "Collapse (show 3)"}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                )}

                {/* New Chat when no sessions */}
                {sessionsLoaded && sessions.length === 0 && (
                  <button
                    style={{ ...navItemStyle(false), color: "var(--accent)", fontWeight: 600, margin: "4px 0" }}
                    onClick={createSession}
                  >
                    <IconNewChat size={15} />
                    {t("nav.new_chat")}
                  </button>
                )}

                {/* ── MAIN group ── */}
                <div style={css.navGroup}>
                  <div style={css.navGroupHeaderStatic} onClick={() => toggleGroup("main")}>
                    {navIcon("dashboard")}
                    <span style={css.navGroupLabel}>{t("nav.main")}</span>
                    <span style={{ ...css.navChevron, marginLeft: "auto" }} dangerouslySetInnerHTML={{ __html: collapsedGroups.has("main") ? "&#9660;" : "&#9654;" }} />
                  </div>

                  {!collapsedGroups.has("main") && (
                    <>
                      {filteredGroups.find(g => g.id === "main")?.items
                        .filter(item => item.id !== "chat")
                        .map(item => (
                          <button
                            key={item.id}
                            style={navItemStyle(item.id === activeTab)}
                            onClick={() => handleNavClick(item.id)}
                          >
                            {navIcon(item.id)}
                            <span className="nav-label-text">{t(item.i18nKey)}</span>
                          </button>
                        ))}
                    </>
                  )}
                </div>

                {/* ── Other nav groups ── */}
                {filteredGroups.filter(g => g.id !== "main").map(group => {
                  const isCollapsed = collapsedGroups.has(group.id);
                  return (
                    <div key={group.id} style={css.navGroup}>
                      <button
                        style={css.navGroupHeader}
                        onClick={() => toggleGroup(group.id)}
                        title={t(group.i18nKey)}
                      >
                        {navIcon(group.iconId)}
                        <span style={css.navGroupLabel}>{t(group.i18nKey)}</span>
                        <span style={{ ...css.navChevron, marginLeft: "auto" }} dangerouslySetInnerHTML={{ __html: isCollapsed ? "&#9660;" : "&#9654;" }} />
                      </button>
                      {!isCollapsed && group.items.map(item => {
                        const ItemIcon = item.iconId ? ICON_MAP[item.iconId] : null;
                        return (
                          <button
                            key={item.id}
                            style={navItemStyle(item.id === activeTab)}
                            onClick={() => handleNavClick(item.id)}
                          >
                            {ItemIcon ? <ItemIcon size={15} style={{ opacity: item.id === activeTab ? 1 : 0.6 }} /> : <span style={navDotStyle(item.id === activeTab)} />}
                            <span className="nav-label-text">{t(item.i18nKey)}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </nav>
            </div>
          )}

          {/* Collapse toggle at bottom */}
          <button
            style={css.sidebarToggle}
            onClick={() => { setSidebarCollapsed(!sidebarCollapsed); setCollapsedGroups(new Set()); }}
            title={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          >
            <span style={{ fontSize: 14, transform: sidebarCollapsed ? "rotate(180deg)" : "none", display: "inline-block", transition: "transform 0.2s" }}>
              &#9654;&#9654;
            </span>
          </button>
        </aside>

        {/* Main Content */}
        <main style={css.mainContent}>
          {renderPage()}
        </main>
      </div>
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────

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

// ─── Styles ───────────────────────────────────────────────

const css: Record<string, CSSProperties> = {
  layoutContainer: { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", background: "var(--bg-primary)", color: "var(--text-primary)" },
  loadingScreen: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)", gap: 12 },
  authScreen: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)" },
  authCard: { background: "var(--bg-card)", borderRadius: 12, padding: "36px 40px", border: "1px solid var(--border)", textAlign: "center", maxWidth: 380, width: "90%" },
  authInput: { width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid var(--input-border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 14, marginBottom: 12, boxSizing: "border-box", outline: "none" },
  authBtn: { width: "100%", padding: "11px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 14 },

  // Header
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--border)", background: "var(--header-bg)", zIndex: 50, flexShrink: 0 },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  headerRight: { display: "flex", alignItems: "center", gap: 6 },
  headerLogo: { width: 26, height: 26 },
  headerTitle: { fontSize: 18, fontWeight: 700, color: "var(--accent)", letterSpacing: "-0.3px" },
  menuBtn: { width: 32, height: 32, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
  headerBtn: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-primary)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", display: "flex", alignItems: "center" },
  themeDropdown: { position: "absolute", top: "100%", right: 0, marginTop: 4, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 4, zIndex: 100, minWidth: 140, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" },
  themeOption: { display: "block", width: "100%", padding: "6px 10px", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, textAlign: "left", background: "transparent" },

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
  sidebarSearchWrap: { padding: "10px 12px", position: "relative" as const },
  sidebarSearch: { width: "100%", padding: "6px 10px 6px 28px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" },
  sidebarNav: { flex: 1, overflowY: "auto" as const, overflowX: "hidden", padding: "0 8px 8px" },
  sidebarToggle: { padding: "10px", border: "none", borderTop: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, display: "flex", justifyContent: "center", alignItems: "center", flexShrink: 0, transition: "color 0.15s" },

  // Nav groups
  navGroup: { marginBottom: 2 },
  navGroupHeader: { display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 8px", border: "none", background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: 14, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px" },
  navGroupHeaderStatic: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", cursor: "pointer", fontSize: 14, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px", color: "var(--text-primary)" },
  navChevron: { fontSize: 8, width: 12, display: "inline-flex", justifyContent: "center" },
  navGroupLabel: { flex: 1, textAlign: "left" as const },
  navItemDot: { display: "inline-block", width: 16, height: 16, flexShrink: 0 },

  // Session list
  sessionSection: { marginBottom: 4 },
  sessionSectionHeader: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", cursor: "pointer", fontSize: 14, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px", color: "var(--text-primary)" },
  sessionListHeader: { fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.5px", color: "var(--text-muted)", padding: "6px 30px 4px" },
  sessionEmpty: { fontSize: 11, color: "var(--text-muted)", padding: "4px 30px 8px", fontStyle: "italic" },
  loadMoreBtn: {
    display: "flex", alignItems: "center", gap: 4,
    width: "100%", padding: "5px 30px",
    border: "none", borderRadius: 6,
    background: "transparent", color: "var(--text-muted)",
    cursor: "pointer", fontSize: 11,
    transition: "color 0.15s",
  },

  // Main content
  mainContent: { flex: 1, minWidth: 0, overflow: "auto", display: "flex", flexDirection: "column", background: "var(--bg-secondary)" },

  // Mobile
  mobileOverlay: { display: "none" },
};

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 8,
    width: "100%", padding: "6px 10px 6px 30px",
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

// Session item styles
function sessionItemContainerStyle(active: boolean): CSSProperties {
  return {
    display: "flex", alignItems: "center",
    padding: "4px 10px 4px 30px",
    borderRadius: 6,
    marginBottom: 1,
    background: active ? "var(--accent-bg)" : "transparent",
    border: active ? "1px solid var(--accent)" : "1px solid transparent",
    cursor: "pointer",
    transition: "all 0.12s",
  };
}

const sessionItemClickStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  flex: 1, minWidth: 0,
  overflow: "hidden",
};

const sessionLabelStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: "1.4",
};

function sessionDeleteBtnStyle(visible: boolean): CSSProperties {
  return {
    width: 20, height: 20, borderRadius: 4,
    border: "none", background: "transparent",
    color: "var(--text-muted)", cursor: "pointer",
    fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
    opacity: visible ? 1 : 0,
    transition: "opacity 0.15s, color 0.15s",
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

// Modal styles
const modalOverlayStyle: CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 9999,
  animation: "EvoClaw-fade-in 0.15s ease",
};

const modalCardStyle: CSSProperties = {
  background: "var(--bg-card)",
  borderRadius: 12,
  padding: "24px",
  border: "1px solid var(--border)",
  maxWidth: 400,
  width: "90%",
  boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
  animation: "EvoClaw-scale-in 0.15s ease",
};

const modalCancelBtn: CSSProperties = {
  padding: "8px 16px", borderRadius: 6,
  border: "1px solid var(--border)", background: "transparent",
  color: "var(--text-secondary)", cursor: "pointer", fontSize: 13,
};

const modalDeleteBtn: CSSProperties = {
  padding: "8px 16px", borderRadius: 6,
  border: "none", background: "var(--error, #da3633)",
  color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600,
};

// ─── Global CSS (injected once) ────────────────────────────

const GLOBAL_CSS = `
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

  /* ── Custom sidebar scrollbar ── */
  .sidebar-scroll::-webkit-scrollbar { width: 4px; }
  .sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
  .sidebar-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 2px; transition: background 0.3s; }
  .sidebar-scroll:hover::-webkit-scrollbar-thumb { background: var(--border); }
  .sidebar-scroll::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
  /* Firefox */
  .sidebar-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .sidebar-scroll:hover { scrollbar-color: var(--border) transparent; }

  /* ── Global scrollbar (minimal) ── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
  /* Firefox */
  html { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

  .sidebar-item:hover .sidebar-item-actions { opacity: 1; }

  /* ── Code block styles ── */
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

  /* ── Load more button hover ── */
  .sidebar-scroll button:hover { background: var(--bg-hover) !important; }

  /* ── RESPONSIVE DESIGN ─────────────────────────────────── */

  /* Tablet (768px - 1024px) */
  @media (max-width: 1024px) {
    .EvoClaw-sidebar { width: 200px !important; min-width: 200px !important; }
    .nav-label-text { display: none; }
  }

  /* Mobile (< 768px) */
  @media (max-width: 768px) {
    .EvoClaw-sidebar {
      position: fixed !important;
      left: 0; top: 50px; bottom: 0;
      z-index: 200;
      transform: translateX(-100%);
      transition: transform 0.25s ease;
      width: 260px !important; min-width: 260px !important;
    }
    .sidebar-mobile-open {
      transform: translateX(0) !important;
      box-shadow: 4px 0 24px rgba(0,0,0,0.4);
    }
    /* show mobile overlay */
    [style*="mobileOverlay"] {
      display: block !important;
    }
    .nav-label-text { display: inline; }
  }

  /* Small mobile (< 480px) */
  @media (max-width: 480px) {
    .EvoClaw-sidebar { width: 100% !important; min-width: 100% !important; }
    .nav-label-text { display: inline; }
  }
`;