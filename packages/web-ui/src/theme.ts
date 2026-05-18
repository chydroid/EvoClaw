export interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgCard: string;
  bgInput: string;
  bgSidebar: string;
  bgHover: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderLight: string;
  accent: string;
  accentHover: string;
  accentBg: string;
  success: string;
  successBg: string;
  error: string;
  errorBg: string;
  warning: string;
  warningBg: string;
  headerBg: string;
  tabBg: string;
  userBubbleBg: string;
  botBubbleBg: string;
  userBubbleBorder: string;
  botBubbleBorder: string;
  msgNameColor: string;
  sectionTitleColor: string;
  inputBorder: string;
  toggleTrackBg: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  type: "dark" | "light";
  colors: ThemeColors;
}

export const THEME_DARK_PURPLE: ThemeColors = {
  bgPrimary: "#0f0f1a",
  bgSecondary: "#1a1a2e",
  bgCard: "#1a1a2e",
  bgInput: "#1a1a2e",
  bgSidebar: "#191929",
  bgHover: "#25253a",
  textPrimary: "#e0e0e0",
  textSecondary: "#a0a0c0",
  textMuted: "#666",
  border: "#2a2a3a",
  borderLight: "#3d3d5a",
  accent: "#7c3aed",
  accentHover: "#6d28d9",
  accentBg: "#2d1b4e",
  success: "#22c55e",
  successBg: "#0a2a1a",
  error: "#ef4444",
  errorBg: "#2a0a0a",
  warning: "#f59e0b",
  warningBg: "#2a1a0a",
  headerBg: "#16162a",
  tabBg: "#1a1a2e",
  userBubbleBg: "rgba(30, 30, 58, 0.7)",
  botBubbleBg: "rgba(45, 27, 78, 0.7)",
  userBubbleBorder: "rgba(124, 58, 237, 0.3)",
  botBubbleBorder: "rgba(124, 58, 237, 0.3)",
  msgNameColor: "#a78bfa",
  sectionTitleColor: "#c4b5fd",
  inputBorder: "#3a3a4a",
  toggleTrackBg: "#444",
};

export const THEME_DARK_OCEAN: ThemeColors = {
  bgPrimary: "#0a1628",
  bgSecondary: "#112240",
  bgCard: "#112240",
  bgInput: "#112240",
  bgSidebar: "#0d1a30",
  bgHover: "#1a3350",
  textPrimary: "#ccd6f6",
  textSecondary: "#8892b0",
  textMuted: "#495670",
  border: "#1e3a5f",
  borderLight: "#2d4a6f",
  accent: "#06d6a0",
  accentHover: "#05b88a",
  accentBg: "#0a2a1a",
  success: "#06d6a0",
  successBg: "#0a2a1a",
  error: "#ef476f",
  errorBg: "#2a0a0a",
  warning: "#ffd166",
  warningBg: "#2a1a0a",
  headerBg: "#0d1a30",
  tabBg: "#112240",
  userBubbleBg: "rgba(17, 34, 64, 0.7)",
  botBubbleBg: "rgba(10, 42, 26, 0.7)",
  userBubbleBorder: "rgba(6, 214, 160, 0.3)",
  botBubbleBorder: "rgba(6, 214, 160, 0.3)",
  msgNameColor: "#06d6a0",
  sectionTitleColor: "#7ce0c0",
  inputBorder: "#1e3a5f",
  toggleTrackBg: "#2a4a6f",
};

export const THEME_LIGHT_WARM: ThemeColors = {
  bgPrimary: "#fdf6e3",
  bgSecondary: "#f5ecd7",
  bgCard: "#faf3e0",
  bgInput: "#faf3e0",
  bgSidebar: "#f0e6cc",
  bgHover: "#e8dbb8",
  textPrimary: "#4a3728",
  textSecondary: "#6b5d4f",
  textMuted: "#9e8d7a",
  border: "#d4c5a0",
  borderLight: "#e0d3b0",
  accent: "#d97706",
  accentHover: "#b45309",
  accentBg: "#fef3c7",
  success: "#15803d",
  successBg: "#dcfce7",
  error: "#dc2626",
  errorBg: "#fee2e2",
  warning: "#d97706",
  warningBg: "#fef3c7",
  headerBg: "#f5ecd7",
  tabBg: "#faf3e0",
  userBubbleBg: "rgba(253, 246, 227, 0.7)",
  botBubbleBg: "rgba(254, 243, 199, 0.7)",
  userBubbleBorder: "rgba(217, 119, 6, 0.3)",
  botBubbleBorder: "rgba(217, 119, 6, 0.3)",
  msgNameColor: "#d97706",
  sectionTitleColor: "#92400e",
  inputBorder: "#d4c5a0",
  toggleTrackBg: "#d4c5a0",
};

export const THEME_LIGHT_CLEAN: ThemeColors = {
  bgPrimary: "#f8fafc",
  bgSecondary: "#ffffff",
  bgCard: "#ffffff",
  bgInput: "#f1f5f9",
  bgSidebar: "#f1f5f9",
  bgHover: "#e2e8f0",
  textPrimary: "#1e293b",
  textSecondary: "#475569",
  textMuted: "#94a3b8",
  border: "#e2e8f0",
  borderLight: "#f1f5f9",
  accent: "#3b82f6",
  accentHover: "#2563eb",
  accentBg: "#eff6ff",
  success: "#16a34a",
  successBg: "#dcfce7",
  error: "#dc2626",
  errorBg: "#fee2e2",
  warning: "#f59e0b",
  warningBg: "#fef3c7",
  headerBg: "#ffffff",
  tabBg: "#f8fafc",
  userBubbleBg: "rgba(239, 246, 255, 0.7)",
  botBubbleBg: "rgba(241, 245, 249, 0.7)",
  userBubbleBorder: "rgba(59, 130, 246, 0.3)",
  botBubbleBorder: "rgba(59, 130, 246, 0.3)",
  msgNameColor: "#3b82f6",
  sectionTitleColor: "#1d4ed8",
  inputBorder: "#cbd5e1",
  toggleTrackBg: "#cbd5e1",
};

export const THEMES: ThemeDefinition[] = [
  { id: "dark-purple", name: "Dark Purple", type: "dark", colors: THEME_DARK_PURPLE },
  { id: "dark-ocean", name: "Dark Ocean", type: "dark", colors: THEME_DARK_OCEAN },
  { id: "light-warm", name: "Light Warm", type: "light", colors: THEME_LIGHT_WARM },
  { id: "light-clean", name: "Light Clean", type: "light", colors: THEME_LIGHT_CLEAN },
];

const THEME_STORAGE_KEY = "ecoclaw-theme";

export function getStoredThemeId(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || "dark-purple";
  } catch {
    return "dark-purple";
  }
}

export function storeThemeId(id: string): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

export function getThemeById(id: string): ThemeDefinition {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function applyThemeToDocument(theme: ThemeDefinition): void {
  const root = document.documentElement;
  const { colors } = theme;
  root.style.setProperty("--bg-primary", colors.bgPrimary);
  root.style.setProperty("--bg-secondary", colors.bgSecondary);
  root.style.setProperty("--bg-card", colors.bgCard);
  root.style.setProperty("--bg-input", colors.bgInput);
  root.style.setProperty("--bg-sidebar", colors.bgSidebar);
  root.style.setProperty("--bg-hover", colors.bgHover);
  root.style.setProperty("--text-primary", colors.textPrimary);
  root.style.setProperty("--text-secondary", colors.textSecondary);
  root.style.setProperty("--text-muted", colors.textMuted);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--border-light", colors.borderLight);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-hover", colors.accentHover);
  root.style.setProperty("--accent-bg", colors.accentBg);
  root.style.setProperty("--success", colors.success);
  root.style.setProperty("--success-bg", colors.successBg);
  root.style.setProperty("--error", colors.error);
  root.style.setProperty("--error-bg", colors.errorBg);
  root.style.setProperty("--warning", colors.warning);
  root.style.setProperty("--warning-bg", colors.warningBg);
  root.style.setProperty("--header-bg", colors.headerBg);
  root.style.setProperty("--tab-bg", colors.tabBg);
  root.style.setProperty("--user-bubble-bg", colors.userBubbleBg);
  root.style.setProperty("--bot-bubble-bg", colors.botBubbleBg);
  root.style.setProperty("--user-bubble-border", colors.userBubbleBorder);
  root.style.setProperty("--bot-bubble-border", colors.botBubbleBorder);
  root.style.setProperty("--msg-name-color", colors.msgNameColor);
  root.style.setProperty("--section-title-color", colors.sectionTitleColor);
  root.style.setProperty("--input-border", colors.inputBorder);
  root.style.setProperty("--toggle-track-bg", colors.toggleTrackBg);
}