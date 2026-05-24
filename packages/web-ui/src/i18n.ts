/**
 * EvoClaw i18n — Lightweight translation system
 * Default language: Chinese (zh)
 * Stored in localStorage, instant switch, no framework needed.
 */

export type Lang = "zh" | "en";

const STORAGE_KEY = "EvoClaw_lang";

export function getStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch { /* SSR guard */ }
  return "zh"; // Default: Chinese
}

export function storeLang(lang: Lang): void {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* noop */ }
}

// ─── Translation Dictionary ──────────────────────────────────

const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    // App shell
    "app.title": "EvoClaw",
    "app.loading": "正在加载...",
    "app.auth.title": "EvoClaw",
    "app.auth.desc": "请输入 Web UI 访问令牌以继续",
    "app.auth.placeholder": "输入令牌...",
    "app.auth.btn": "登录",
    "app.auth.error": "服务器无法访问或令牌无效",
    "app.online": "在线",
    "app.offline": "离线",
    "app.connecting": "连接中",

    // Sidebar
    "sidebar.search": "搜索页面...",
    "sidebar.collapse": "收起侧边栏",
    "sidebar.expand": "展开侧边栏",
    "sidebar.toggle_menu": "切换菜单",

    // Nav Groups
    "nav.main": "主菜单",
    "nav.system": "系统",
    "nav.config": "配置",
    "nav.security": "安全",
    "nav.admin": "管理",
    "nav.health": "健康 & 工具",
    "nav.ops": "运维",

    // Nav Items
    "nav.chat": "对话",
    "nav.status": "状态",
    "nav.dashboard": "仪表盘",
    "nav.events": "事件",
    "nav.skills": "技能",
    "nav.bootstrap": "引导配置",
    "nav.canvas": "画布",
    "nav.monitoring": "监控",
    "nav.plugins": "插件",
    "nav.permissions": "权限",
    "nav.cron": "定时任务",
    "nav.llm": "LLM 配置",
    "nav.channels": "通道",
    "nav.evolution": "进化",
    "nav.secrets": "密钥管理",
    "nav.dlq": "死信队列",
    "nav.feature_flags": "功能开关",
    "nav.config_rpc": "配置 RPC",
    "nav.model_switcher": "模型切换",
    "nav.retention": "会话保留",
    "nav.config_migration": "配置迁移",
    "nav.config_doctor": "配置诊断",
    "nav.health_aggregator": "健康聚合",
    "nav.templates": "消息模板",
    "nav.reply_refs": "引用回复",
    "nav.ops_page": "运维面板",
    "nav.cli": "CLI 终端",
    "nav.new_chat": "新对话",

    // Session list
    "sessions.title": "会话",
    "sessions.load": "加载",
    "sessions.load_more": "加载更多 (+10)",
    "sessions.empty": "暂无会话",
    "sessions.loading": "加载中...",

    // Theme
    "theme.change": "切换主题",
    "theme.default": "默认",
    "theme.dark": "暗色",
    "theme.light": "亮色",
    "theme.forest": "森林",
    "theme.ocean": "海洋",
    "theme.sunset": "日落",

    // Profile
    "profile.edit": "编辑个人资料",
    "profile.your_avatar": "你的头像",
    "profile.bot_avatar": "机器人头像",
    "profile.change": "更换",
    "profile.nickname": "昵称",
    "profile.close": "关闭",
    "profile.apply": "应用",

    // Language
    "lang.switch": "English",
    "lang.label": "语言",
  },

  en: {
    // App shell
    "app.title": "EvoClaw",
    "app.loading": "Loading...",
    "app.auth.title": "EvoClaw",
    "app.auth.desc": "Enter the Web UI access token to continue",
    "app.auth.placeholder": "Enter token...",
    "app.auth.btn": "Access",
    "app.auth.error": "Server not reachable or invalid token",
    "app.online": "Online",
    "app.offline": "Offline",
    "app.connecting": "Connecting",

    // Sidebar
    "sidebar.search": "Search pages...",
    "sidebar.collapse": "Collapse sidebar",
    "sidebar.expand": "Expand sidebar",
    "sidebar.toggle_menu": "Toggle menu",

    // Nav Groups
    "nav.main": "Main",
    "nav.system": "System",
    "nav.config": "Configuration",
    "nav.security": "Security",
    "nav.admin": "Administration",
    "nav.health": "Health & Tools",
    "nav.ops": "Operations",

    // Nav Items
    "nav.chat": "Chat",
    "nav.status": "Status",
    "nav.dashboard": "Dashboard",
    "nav.events": "Events",
    "nav.skills": "Skills",
    "nav.bootstrap": "Bootstrap",
    "nav.canvas": "Canvas",
    "nav.monitoring": "Monitoring",
    "nav.plugins": "Plugins",
    "nav.permissions": "Permissions",
    "nav.cron": "Cron Jobs",
    "nav.llm": "LLM Config",
    "nav.channels": "Channels",
    "nav.evolution": "Evolution",
    "nav.secrets": "Secrets",
    "nav.dlq": "Dead Letter Q",
    "nav.feature_flags": "Feature Flags",
    "nav.config_rpc": "Config RPC",
    "nav.model_switcher": "Model Switcher",
    "nav.retention": "Retention",
    "nav.config_migration": "Migrations",
    "nav.config_doctor": "Config Doctor",
    "nav.health_aggregator": "Health",
    "nav.templates": "Templates",
    "nav.reply_refs": "Reply Refs",
    "nav.ops_page": "Ops",
    "nav.cli": "CLI Terminal",
    "nav.new_chat": "New Chat",

    // Session list
    "sessions.title": "Sessions",
    "sessions.load": "Load",
    "sessions.load_more": "Load More (+10)",
    "sessions.empty": "No sessions yet",
    "sessions.loading": "Loading...",

    // Theme
    "theme.change": "Change theme",
    "theme.default": "Default",
    "theme.dark": "Dark",
    "theme.light": "Light",
    "theme.forest": "Forest",
    "theme.ocean": "Ocean",
    "theme.sunset": "Sunset",

    // Profile
    "profile.edit": "Edit profile",
    "profile.your_avatar": "Your Avatar",
    "profile.bot_avatar": "Bot Avatar",
    "profile.change": "Change",
    "profile.nickname": "Nickname",
    "profile.close": "Close",
    "profile.apply": "Apply",

    // Language
    "lang.switch": "中文",
    "lang.label": "Language",
  },
};

// ─── Hook ─────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";

export function useTranslation() {
  const [lang, setLangState] = useState<Lang>(getStoredLang);

  // Sync across tabs
  useEffect(() => {
    const handler = () => setLangState(getStoredLang());
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setLang = useCallback((l: Lang) => {
    storeLang(l);
    setLangState(l);
    // Fire custom event for in-tab listeners
    window.dispatchEvent(new CustomEvent("EvoClaw_lang_change", { detail: l }));
  }, []);

  const t = useCallback(
    (key: string, fallback?: string): string => {
      return DICT[lang]?.[key] || DICT["en"]?.[key] || fallback || key;
    },
    [lang],
  );

  return { lang, setLang, t } as const;
}

/**
 * Standalone translation function (for use outside React components).
 * Uses stored language preference.
 */
export function translate(key: string, fallback?: string): string {
  const lang = getStoredLang();
  return DICT[lang]?.[key] || DICT["en"]?.[key] || fallback || key;
}