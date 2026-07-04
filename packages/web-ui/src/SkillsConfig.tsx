import React, { useState, useEffect, useCallback, useRef } from "react";
import { renderMarkdown } from "./markdown-renderer";
import { useTranslation } from "./i18n";

interface EnvMeta {
  required?: boolean;
  description?: string;
  currentSource?: "env" | "config" | "none";
  envValue?: string;
}

// 技能市场搜索结果项：包含从 ClawHub metaContent 透传的完整字段，供详情面板展示
interface MarketplaceSearchResult {
  name: string;
  slug?: string;
  displayName?: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
  owner?: string;
  license?: string;
  keywords?: string[];
  files?: string[];
  skillMd?: string;
  displayDescription?: string;
}

interface SkillInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  keywords: string[];
  license?: string;
  homepage?: string;
  emoji?: string;
  entryPoint: string;
  installPath: string;
  requires: { name: string; version: string; optional: boolean }[];
  triggers: { type: string; pattern: string; description: string }[];
  lifecycle: {
    status: string;
    version: string;
    installDate: string;
    lastUpdated: string;
    healthCheck: { healthy: boolean; lastCheck: string; errors: string[]; warnings?: string[]; missingDependencies: string[] } | null;
  };
  config: Record<string, unknown>;
  stats: {
    invocationCount: number;
    successCount: number;
    failureCount: number;
    averageDuration: number;
    lastInvocation: string | null;
    userRating: number;
  };
  body: {
    instructions: string;
    scripts: Record<string, string>;
    examples: string[];
    hooks: Record<string, string>;
  };
  i18n?: {
    description_zh?: string;
    instructions_zh?: string;
    examples_zh?: string[];
    translatedAt?: string;
  };
  openclawMeta?: {
    emoji?: string;
    requires?: { env?: string[]; bins?: string[]; anyBins?: string[] };
    primaryEnv?: string;
    homepage?: string;
    os?: string[];
  };
  configStatus?: "configured" | "partial" | "unconfigured" | "none";
  latestVersion?: string;
  updateAvailable?: boolean;
  /** 缺失的系统 binary（requires.bins 中检测到不在 PATH 上的），供 WebUI 展示一键安装按钮 */
  missingBins?: string[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const validateConfig = async (skillId: string) => {
  const res = await fetch(`/api/skills/${skillId}/validate-config`, { method: "POST" });
  return res.json();
};

const healthCheck = async (skillId: string) => {
  const res = await fetch(`/api/skills/${skillId}/health-check`, { method: "POST" });
  return res.json();
};

const checkUpdates = async () => {
  const res = await fetch("/api/skills/check-updates");
  return res.json();
};

const upgradeSkill = async (skillId: string) => {
  const res = await fetch(`/api/skills/${skillId}/upgrade`, { method: "POST" });
  return res.json();
};

const batchUpgrade = async (skillIds: string[]) => {
  const res = await fetch("/api/skills/batch-upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillIds }),
  });
  return res.json();
};

function getConfigStatus(skill: SkillInfo): "configured" | "partial" | "unconfigured" | "none" {
  if (skill.configStatus) return skill.configStatus;
  const skillConfig = skill.config && typeof skill.config === "object" ? skill.config as Record<string, unknown> : {};
  const configKeys = Object.keys(skillConfig).filter(
    (k) => k !== "_requiredBins" && k !== "_primaryEnv" && k !== "_" && k !== "_envMeta"
  );
  const envKeys = configKeys.filter(k => /^[A-Z_]+$/.test(k));
  if (envKeys.length === 0) return "none";
  const envMeta = (skillConfig._envMeta || {}) as Record<string, EnvMeta>;
  const primaryEnv = skillConfig._primaryEnv as string | undefined;
  let configured = 0;
  for (const key of envKeys) {
    const val = skillConfig[key];
    const meta = envMeta[key];
    const hasValue = val !== undefined && val !== null && String(val).trim() !== "";
    const isEnvSet = meta?.currentSource === "env";
    if (hasValue || isEnvSet) {
      configured++;
    }
  }
  const requiredKeys = envKeys.filter(k => {
    const meta = envMeta[k];
    return meta?.required || k === primaryEnv;
  });
  const requiredConfigured = requiredKeys.filter(k => {
    const val = skillConfig[k];
    const meta = envMeta[k];
    const hasValue = val !== undefined && val !== null && String(val).trim() !== "";
    const isEnvSet = meta?.currentSource === "env";
    return hasValue || isEnvSet;
  });
  if (requiredKeys.length > 0 && requiredConfigured.length === requiredKeys.length) return "configured";
  if (configured > 0) return "partial";
  return "unconfigured";
}

function configStatusColor(status: "configured" | "partial" | "unconfigured" | "none"): string {
  switch (status) {
    case "configured": return "var(--success)";
    case "partial": return "var(--warning)";
    case "unconfigured": return "var(--error)";
    case "none": return "var(--text-muted)";
  }
}

function configStatusText(status: "configured" | "partial" | "unconfigured" | "none", t: (key: string, fallback?: string) => string): string {
  switch (status) {
    case "configured": return t("skills.configured", "已配置");
    case "partial": return t("skills.partial_config", "部分配置");
    case "unconfigured": return t("skills.unconfigured", "未配置");
    case "none": return t("skills.no_config_needed", "无需配置");
  }
}

function healthStatusColor(healthy: boolean, warnings?: string[]): string {
  if (!healthy) return "var(--error)";
  if (warnings && warnings.length > 0) return "var(--warning)";
  return "var(--success)";
}

function healthStatusText(healthy: boolean, warnings: string[] | undefined, t: (key: string, fallback?: string) => string): string {
  if (!healthy) return t("skills.error_status", "错误");
  if (warnings && warnings.length > 0) return t("skills.warning_status", "警告");
  return t("skills.normal_status", "正常");
}

function healthStatusIcon(healthy: boolean, warnings?: string[]): string {
  if (!healthy) return "🔴";
  if (warnings && warnings.length > 0) return "🟡";
  return "🟢";
}

function statusBadgeStyle(status: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: "3px",
    fontSize: "10px",
    fontWeight: "bold",
    marginTop: "4px",
    color: status === "active" ? "var(--success)" : status === "error" ? "var(--error)" : "var(--warning)",
    background: status === "active" ? "var(--success-bg)" : status === "error" ? "var(--error-bg)" : "var(--warning-bg)",
  };
}

function msgBannerStyle(type: "success" | "error" | "warning"): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: "4px",
    marginBottom: "12px",
    fontSize: "12px",
    background: type === "success" ? "var(--success-bg)" : type === "error" ? "var(--error-bg)" : "var(--warning-bg)",
    color: type === "success" ? "var(--success)" : type === "error" ? "var(--error)" : "var(--warning)",
  };
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    height: "100%",
    gap: 0,
    background: "var(--bg-secondary)",
    borderRadius: "8px",
    overflow: "hidden",
  },
  sidebar: {
    width: "260px",
    minWidth: "180px",
    maxWidth: "500px",
    background: "var(--bg-sidebar)",
    borderRight: "1px solid var(--border-light)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    position: "relative",
  },
  sidebarHeader: {
    padding: "12px 14px",
    borderBottom: "1px solid var(--border-light)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sidebarTitle: {
    color: "var(--section-title-color)",
    fontWeight: "bold",
    fontSize: "14px",
  },
  refreshButton: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    padding: "6px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
  },
  sidebarList: {
    overflow: "auto",
    flex: 1,
  },
  sidebarItem: {
    padding: "10px 14px",
    cursor: "pointer",
    borderBottom: "1px solid var(--bg-hover)",
    transition: "background 0.15s",
  },
  sidebarItemActive: {
    padding: "10px 14px",
    cursor: "pointer",
    borderBottom: "1px solid var(--bg-hover)",
    background: "var(--border-light)",
    borderLeft: "3px solid var(--accent)",
    transition: "background 0.15s",
  },
  skillItemName: {
    color: "var(--text-primary)",
    fontSize: "13px",
    fontWeight: "bold",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skillItemDesc: {
    color: "var(--text-muted)",
    fontSize: "11px",
    marginTop: "2px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  contentPanel: {
    flex: 1,
    minWidth: 0,
    overflow: "auto",
    padding: "20px 24px",
    background: "var(--bg-secondary)",
  },
  placeholder: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-muted)",
    fontSize: "14px",
    background: "var(--bg-secondary)",
    padding: "20px",
  },
  detailHeader: {
    marginBottom: "16px",
  },
  detailName: {
    color: "var(--section-title-color)",
    fontSize: "20px",
    fontWeight: "bold",
  },
  detailVersion: {
    color: "var(--text-muted)",
    fontSize: "12px",
    marginLeft: "8px",
  },
  detailDesc: {
    color: "var(--text-secondary)",
    fontSize: "13px",
    marginTop: "6px",
    lineHeight: "1.5",
  },
  sectionTitle: {
    color: "var(--section-title-color)",
    fontSize: "14px",
    fontWeight: "bold",
    marginTop: "20px",
    marginBottom: "8px",
    paddingBottom: "4px",
    borderBottom: "1px solid var(--border-light)",
  },
  infoRow: {
    display: "flex",
    padding: "4px 0",
    fontSize: "12px",
  },
  infoLabel: {
    color: "var(--text-muted)",
    minWidth: "100px",
  },
  infoValue: {
    color: "var(--text-primary)",
    wordBreak: "break-all",
  },
  instructionsBlock: {
    background: "var(--bg-sidebar)",
    borderRadius: "6px",
    padding: "12px 16px",
    color: "var(--text-secondary)",
    fontSize: "12px",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    marginTop: "8px",
    maxHeight: "200px",
    overflow: "auto",
    border: "1px solid var(--border-light)",
  },
  examplesBlock: {
    marginTop: "8px",
  },
  exampleItem: {
    background: "var(--bg-sidebar)",
    borderRadius: "6px",
    padding: "10px 14px",
    color: "var(--text-secondary)",
    fontSize: "12px",
    marginBottom: "6px",
    border: "1px solid var(--border-light)",
    lineHeight: "1.5",
  },
  configForm: {
    marginTop: "8px",
  },
  configRow: {
    marginBottom: "12px",
  },
  configLabel: {
    color: "var(--text-secondary)",
    fontSize: "12px",
    marginBottom: "6px",
    display: "block",
  },
  configInput: {
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border-light)",
    color: "var(--text-primary)",
    padding: "6px 10px",
    borderRadius: "4px",
    fontSize: "12px",
    width: "100%",
    maxWidth: "400px",
    boxSizing: "border-box",
  },
  configNoConfig: {
    color: "var(--text-muted)",
    fontSize: "12px",
    fontStyle: "italic",
  },
  saveButton: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    padding: "8px 16px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "bold",
    marginTop: "12px",
  },
  banner: {
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border-light)",
    padding: "12px 16px",
    borderRadius: "6px",
    marginBottom: "16px",
    fontSize: "12px",
    color: "var(--text-secondary)",
  },
  dragHandle: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: "4px",
    cursor: "col-resize",
    background: "transparent",
    zIndex: 10,
  },
  bannerTip: {
    color: "var(--text-muted)",
    fontSize: "11px",
    marginTop: "4px",
  },
  triggerChip: {
    display: "inline-block",
    background: "var(--bg-hover)",
    color: "var(--text-secondary)",
    padding: "2px 8px",
    borderRadius: "3px",
    fontSize: "11px",
    marginRight: "6px",
    marginTop: "4px",
  },
  tabContainer: {
    display: "flex",
    gap: "0",
    marginBottom: "6px",
  },
  tab: {
    padding: "4px 12px",
    fontSize: "11px",
    cursor: "pointer",
    border: "1px solid var(--border-light)",
    background: "var(--bg-sidebar)",
    color: "var(--text-muted)",
    transition: "all 0.15s",
  },
  tabActive: {
    padding: "4px 12px",
    fontSize: "11px",
    cursor: "pointer",
    border: "1px solid var(--accent)",
    background: "var(--accent)",
    color: "#fff",
    transition: "all 0.15s",
  },
  envStatusRow: {
    padding: "8px 12px",
    borderRadius: "4px",
    fontSize: "12px",
    marginBottom: "4px",
  },
  batchBar: {
    padding: "8px 14px",
    borderBottom: "1px solid var(--border-light)",
    display: "flex",
    gap: "6px",
    alignItems: "center",
    flexWrap: "wrap",
    background: "var(--bg-sidebar)",
  },
  batchButton: {
    background: "var(--bg-hover)",
    color: "var(--text-secondary)",
    border: "1px solid var(--border-light)",
    padding: "4px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "11px",
  },
  batchButtonAccent: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    padding: "4px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "11px",
  },
  versionBox: {
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border-light)",
    borderRadius: "6px",
    padding: "12px 16px",
    marginTop: "8px",
  },
  validationSuccess: {
    padding: "8px 12px",
    borderRadius: "4px",
    fontSize: "12px",
    background: "var(--success-bg)",
    color: "var(--success)",
    marginTop: "8px",
  },
  validationError: {
    padding: "8px 12px",
    borderRadius: "4px",
    fontSize: "12px",
    background: "var(--error-bg)",
    color: "var(--error)",
    marginTop: "8px",
  },
  validationWarning: {
    padding: "8px 12px",
    borderRadius: "4px",
    fontSize: "12px",
    background: "var(--warning-bg)",
    color: "var(--warning)",
    marginTop: "8px",
  },
  fixButton: {
    background: "none",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
    padding: "2px 8px",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "10px",
    marginLeft: "6px",
  },
  checkbox: {
    marginRight: "6px",
    cursor: "pointer",
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  techDetailBox: {
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border-light)",
    borderRadius: "6px",
    padding: "12px 16px",
    marginTop: "8px",
  },
  depItem: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 0",
    fontSize: "12px",
  },
  sandboxChip: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "3px",
    fontSize: "11px",
    marginRight: "6px",
    marginTop: "4px",
    background: "var(--success-bg)",
    color: "var(--success)",
  },
  sandboxChipOff: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "3px",
    fontSize: "11px",
    marginRight: "6px",
    marginTop: "4px",
    background: "var(--bg-hover)",
    color: "var(--text-muted)",
  },
};

// 技能市场详情面板：展示选中技能的完整信息（参考 ClawHub 详情页布局）
// 在右侧大面积 contentPanel 中渲染，不再受 sidebar 窄宽度限制
function MarketplaceSkillDetail({
  skill,
  t,
  onInstall,
  installing,
}: {
  skill: MarketplaceSearchResult;
  t: (key: string, fallback?: string) => string;
  onInstall: (slug: string) => void;
  installing: string | null;
}) {
  const slug = skill.slug || skill.name;
  const isInstalling = installing === slug;

  // skillMd 可能含 YAML front matter（--- ... ---），剥离后只保留正文用于展示
  const skillMdBody = (() => {
    const md = skill.skillMd || "";
    const fmMatch = md.match(/^---\n[\s\S]*?\n---\n/);
    return fmMatch ? md.slice(fmMatch[0].length) : md;
  })();

  // 从 SKILL.md front matter 提取 name/description 作为标题和描述兜底
  const frontMeta = (() => {
    const md = skill.skillMd || "";
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) return { name: "", description: "" };
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      description: descMatch ? descMatch[1].trim() : "",
    };
  })();

  const displayTitle = skill.displayName || frontMeta.name || skill.name;
  const displayDesc = skill.displayDescription || skill.summary || frontMeta.description;
  const updatedAtStr = skill.updatedAt
    ? new Date(typeof skill.updatedAt === "number" ? skill.updatedAt : Date.parse(String(skill.updatedAt))).toLocaleString()
    : "";
  // ClawHub 详情页 URL：优先用后端返回的 detailPageURL，否则前端拼接
  const registryURL = (import.meta as any).env?.VITE_MARKETPLACE_REGISTRY_URL || "https://cn.clawhub-mirror.com";
  const detailPageURL = (skill as any).detailPageURL || (skill.owner ? `${registryURL}/${skill.owner}/${slug}` : "");

  return (
    <div style={{ color: "var(--text-secondary)" }}>
      {/* 标题区 */}
      <div style={{ marginBottom: "12px" }}>
        <div style={{ fontSize: "20px", fontWeight: "bold", color: "var(--section-title-color)" }}>{displayTitle}</div>
        <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>{slug}</div>
      </div>

      {/* 描述 */}
      {displayDesc && (
        <div style={{
          background: "var(--bg-sidebar)", border: "1px solid var(--border-light)",
          borderRadius: "6px", padding: "10px 14px", marginBottom: "14px",
          fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6,
        }}>
          {displayDesc}
        </div>
      )}

      {/* 元数据表格 */}
      <div style={{ marginBottom: "14px", fontSize: "13px" }}>
        {skill.owner && (
          <div style={{ display: "flex", padding: "3px 0" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_owner", "作者")}</span>
            <span style={{ color: "var(--text-primary)" }}>@{skill.owner}</span>
          </div>
        )}
        {skill.version && (
          <div style={{ display: "flex", padding: "3px 0" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_version", "版本")}</span>
            <span style={{ color: "var(--text-primary)" }}>v{skill.version}</span>
          </div>
        )}
        {skill.license && (
          <div style={{ display: "flex", padding: "3px 0" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_license", "许可证")}</span>
            <span style={{ color: "var(--text-primary)", fontWeight: "bold" }}>{skill.license}</span>
          </div>
        )}
        {updatedAtStr && (
          <div style={{ display: "flex", padding: "3px 0" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_updated", "更新于")}</span>
            <span style={{ color: "var(--text-primary)" }}>{updatedAtStr}</span>
          </div>
        )}
        {detailPageURL && (
          <div style={{ display: "flex", padding: "3px 0" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_source", "来源")}</span>
            <a href={detailPageURL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
              {detailPageURL}
            </a>
          </div>
        )}
        {skill.keywords && skill.keywords.length > 0 && (
          <div style={{ display: "flex", padding: "3px 0", alignItems: "flex-start" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_keywords", "关键词")}</span>
            <div style={{ flex: 1 }}>
              {skill.keywords.map((kw, i) => (
                <span key={i} style={{
                  display: "inline-block", background: "var(--bg-hover)", color: "var(--text-secondary)",
                  padding: "2px 8px", borderRadius: "3px", fontSize: "11px", marginRight: "4px", marginBottom: "4px",
                }}>{kw}</span>
              ))}
            </div>
          </div>
        )}
        {skill.files && skill.files.length > 0 && (
          <div style={{ display: "flex", padding: "3px 0", alignItems: "flex-start" }}>
            <span style={{ color: "var(--text-muted)", minWidth: "80px" }}>{t("skills.detail_files", "文件")}</span>
            <div style={{ flex: 1, color: "var(--text-primary)", fontSize: "12px", wordBreak: "break-all" }}>
              {skill.files.map((f, i) => (
                <span key={i} style={{ display: "inline-block", marginRight: "6px", marginBottom: "2px" }}>
                  {f}{i < skill.files!.length - 1 ? "," : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 安装按钮 */}
      <button
        onClick={() => onInstall(slug)}
        disabled={isInstalling}
        style={{
          padding: "8px 24px", fontSize: "13px", fontWeight: "bold", borderRadius: "4px",
          border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff",
          cursor: isInstalling ? "wait" : "pointer", opacity: isInstalling ? 0.6 : 1,
          marginBottom: "16px",
        }}
      >
        {isInstalling ? t("skills.installing", "安装中...") : t("skills.install_btn", "安装")}
      </button>

      {/* SKILL.md 正文（Markdown 渲染） — 移除 maxHeight 限制，撑满 contentPanel */}
      {skillMdBody && (
        <div>
          <div style={{
            fontSize: "14px", fontWeight: "bold", color: "var(--section-title-color)",
            marginBottom: "8px", paddingBottom: "4px",
            borderBottom: "1px solid var(--border-light)",
          }}>
            {t("skills.detail_skill_md", "技能文档")}
          </div>
          <div
            className="markdown-body"
            style={{
              background: "var(--bg-sidebar)", border: "1px solid var(--border-light)",
              borderRadius: "6px", padding: "14px 18px", fontSize: "13px", lineHeight: 1.7,
            }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(skillMdBody) }}
          />
        </div>
      )}
    </div>
  );
}

export default function SkillsConfig() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [configModes, setConfigModes] = useState<Record<string, "direct" | "env">>({});
  const [message, setMessage] = useState<{ type: "success" | "error" | "warning"; text: string } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [validationResults, setValidationResults] = useState<Record<string, ValidationResult | null>>({});
  const [validating, setValidating] = useState<Record<string, boolean>>({});
  const [healthChecking, setHealthChecking] = useState<Record<string, boolean>>({});
  const [updateInfo, setUpdateInfo] = useState<Record<string, { latestVersion: string; updateAvailable: boolean }>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [upgrading, setUpgrading] = useState<Record<string, boolean>>({});
  const [batchUpgrading, setBatchUpgrading] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  // Search, sort, and marketplace state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "category" | "status" | "invocations" | "rating" | "updated">("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [marketplaceTab, setMarketplaceTab] = useState(false);
  const [marketplaceResults, setMarketplaceResults] = useState<MarketplaceSearchResult[]>([]);
  const [marketplaceSearching, setMarketplaceSearching] = useState(false);
  const [marketplaceInstalling, setMarketplaceInstalling] = useState<string | null>(null);
  const [trendingSkills, setTrendingSkills] = useState<MarketplaceSearchResult[]>([]);
  // 市场错误状态：仅用于真正的错误（网络/鉴权/registry 不可达），空搜索结果不算错误
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  // 追踪用户是否已提交过搜索，用于区分"未搜索"和"搜索无结果"两种空态
  const [marketplaceQueried, setMarketplaceQueried] = useState(false);
  const [marketplaceLastQuery, setMarketplaceLastQuery] = useState("");
  // 当前选中的市场技能 slug，用于右侧详情面板展示
  const [selectedMarketplaceSlug, setSelectedMarketplaceSlug] = useState<string | null>(null);
  // 市场技能详情懒加载：点击技能时从 /api/marketplace/skills/:slug/details 获取完整详情
  // 不依赖搜索结果中的 skillMd（trending 列表不返回 skillMd，搜索结果可能为空或截断）
  const [marketplaceDetail, setMarketplaceDetail] = useState<MarketplaceSearchResult | null>(null);
  const [marketplaceDetailLoading, setMarketplaceDetailLoading] = useState<string | null>(null);
  const [marketplaceDetailError, setMarketplaceDetailError] = useState<string | null>(null);
  // Round 8: 安全扫描结果缓存（skillId → scan result）
  const [securityScans, setSecurityScans] = useState<Record<string, {
    safe: boolean;
    riskLevel: "low" | "medium" | "high" | "critical";
    findings: Array<{
      type: string;
      severity: "low" | "medium" | "high" | "critical";
      description: string;
      location: string;
      recommendation: string;
    }>;
  }>>({});
  // 安全详情弹窗：当前展示的 skillId
  const [securityDialogSkillId, setSecurityDialogSkillId] = useState<string | null>(null);
  const [securityScanLoading, setSecurityScanLoading] = useState<string | null>(null);
  // Binary 安装状态：记录正在安装 binary 的 skillId
  const [installingBins, setInstallingBins] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  // Round 9: stale-aware 请求防护 — 取消过期请求，避免旧结果覆盖新结果
  const detailAbortRef = useRef<AbortController | null>(null);
  const marketplaceAbortRef = useRef<AbortController | null>(null);
  const securityAbortRef = useRef<AbortController | null>(null);

  // Round 8: 拉取技能安全扫描结果
  const fetchSecurityScan = useCallback(async (skillId: string, force = false) => {
    if (!force && securityScans[skillId]) return; // 已缓存则跳过
    // Round 9: 取消上一个安全扫描请求
    if (securityAbortRef.current) {
      securityAbortRef.current.abort();
    }
    const controller = new AbortController();
    securityAbortRef.current = controller;
    setSecurityScanLoading(skillId);
    try {
      const res = await fetch(`/api/skills/${skillId}/security-scan`, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        if (controller.signal.aborted) return;
        if (data.success && data.scan) {
          setSecurityScans((prev) => ({ ...prev, [skillId]: data.scan }));
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // 安全扫描 API 不可用，静默失败
    } finally {
      if (!controller.signal.aborted) {
        setSecurityScanLoading(null);
      }
    }
  }, [securityScans]);

  // 触发安装缺失 binary：调用后端 POST /api/skills/:id/install-binary
  // 成功后更新 selectedSkill.missingBins，并显示安装结果
  const handleInstallBins = useCallback(async (skillId: string) => {
    if (installingBins) return; // 防止并发触发
    setInstallingBins(skillId);
    try {
      const res = await fetch(`/api/skills/${skillId}/install-binary`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const failed = (data.results || []).filter((r: any) => !r.installed);
        const stillMissing = data.stillMissing || [];
        if (stillMissing.length > 0) {
          const detail = failed.map((r: any) => `${r.binary}: ${r.error || r.message}`).join("; ");
          setMessage({ type: "error", text: `${t("skills.binary_install_failed", "Binary 安装失败")}: ${stillMissing.join(", ")}${detail ? " — " + detail : ""}` });
        } else {
          setMessage({ type: "warning", text: t("skills.binary_install_partial", "部分 binary 安装完成，请查看详情") });
        }
      } else {
        const installed = (data.results || []).filter((r: any) => r.installed).map((r: any) => r.binary);
        setMessage({ type: "success", text: `${t("skills.binary_install_success", "Binary 已安装")}: ${installed.join(", ")}` });
      }
      // 更新 selectedSkill.missingBins（无论成功失败都按后端返回的最新状态）
      const stillMissing: string[] = data.stillMissing || [];
      setSelectedSkill(prev => prev && prev.id === skillId ? { ...prev, missingBins: stillMissing } : prev);
      // 同步更新左侧列表中的 skill 信息
      setSkills(prev => prev.map(s => s.id === skillId ? { ...s, missingBins: stillMissing } : s));
    } catch (err) {
      setMessage({ type: "error", text: `${t("skills.binary_install_failed", "Binary 安装失败")}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setInstallingBins(null);
    }
  }, [installingBins, t]);

  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setSkills(Array.isArray(data) ? data : []);
      }
    } catch {
      console.debug("[SkillsConfig] Skills API not available");
    }
  }, []);

  const loadSkillDetail = useCallback(async (id: string) => {
    // Round 9: 取消上一个 in-flight 请求，防止旧结果覆盖新选中技能
    if (detailAbortRef.current) {
      detailAbortRef.current.abort();
    }
    const controller = new AbortController();
    detailAbortRef.current = controller;
    try {
      const res = await fetch(`/api/skills/${id}`, { signal: controller.signal });
      if (res.ok) {
        const skill = await res.json();
        // 双重校验：如果已被后续请求取消，则丢弃结果
        if (controller.signal.aborted) return;
        setSelectedSkill(skill);
        const cfg: Record<string, string> = {};
        if (skill.config && typeof skill.config === "object") {
          for (const [k, v] of Object.entries(skill.config as Record<string, unknown>)) {
            cfg[k] = String(v);
          }
        }
        setConfigValues(cfg);
        const skillConfig = skill.config && typeof skill.config === "object" ? skill.config as Record<string, unknown> : {};
        const envMeta = (skillConfig._envMeta || {}) as Record<string, EnvMeta>;
        const configKeys = Object.keys(skillConfig).filter(
          (k) => k !== "_requiredBins" && k !== "_primaryEnv" && k !== "_" && k !== "_envMeta"
        );
        const modes: Record<string, "direct" | "env"> = {};
        for (const key of configKeys) {
          const meta = envMeta[key];
          if (meta?.currentSource === "env") {
            modes[key] = "env";
          } else if (meta?.currentSource === "config") {
            modes[key] = "direct";
          } else {
            modes[key] = "direct";
          }
        }
        setConfigModes(modes);
      }
    } catch (err) {
      // AbortError 是正常的过期请求取消，不应报错
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.debug("[SkillsConfig] Skill detail not available");
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (selectedId) {
      loadSkillDetail(selectedId);
      // Round 8: 选中技能时拉取安全扫描结果
      fetchSecurityScan(selectedId);
    } else {
      setSelectedSkill(null);
    }
  }, [selectedId, loadSkillDetail, fetchSecurityScan]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/skills/refresh", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setMessage({ type: "success", text: t("skills.scan_complete", "扫描完成: {0} 个新安装, {1} 已跳过").replace("{0}", String(data.installed)).replace("{1}", String(data.skipped)) });
      }
    } catch {
      setMessage({ type: "error", text: t("skills.refresh_fail", "刷新失败") });
    }
    await loadSkills();
    setRefreshing(false);
  }, [loadSkills]);

  // ── Search & Sort ──
  const filteredAndSortedSkills = useCallback(() => {
    let result = [...skills];
    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.category || "").toLowerCase().includes(q) ||
        (s.keywords || []).some(k => k.toLowerCase().includes(q)) ||
        (s.i18n?.description_zh || "").toLowerCase().includes(q)
      );
    }
    // Sort
    result.sort((a, b) => {
      let valA: any, valB: any;
      switch (sortBy) {
        case "name": valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); break;
        case "category": valA = a.category || "zzz"; valB = b.category || "zzz"; break;
        case "status": valA = a.lifecycle?.status || "zzz"; valB = b.lifecycle?.status || "zzz"; break;
        case "invocations": valA = a.stats?.invocationCount || 0; valB = b.stats?.invocationCount || 0; break;
        case "rating": valA = a.stats?.userRating || 0; valB = b.stats?.userRating || 0; break;
        case "updated": valA = a.lifecycle?.lastUpdated || ""; valB = b.lifecycle?.lastUpdated || ""; break;
        default: return 0;
      }
      const cmp = valA < valB ? -1 : valA > valB ? 1 : 0;
      return sortOrder === "desc" ? -cmp : cmp;
    });
    return result;
  }, [skills, searchQuery, sortBy, sortOrder]);

  // ── Marketplace search ──
  const handleMarketplaceSearch = useCallback(async (query: string) => {
    if (!query.trim()) { setMarketplaceResults([]); setMarketplaceQueried(false); return; }
    // Round 9: 取消上一个搜索请求，防止快速输入时旧结果覆盖新结果
    if (marketplaceAbortRef.current) {
      marketplaceAbortRef.current.abort();
    }
    const controller = new AbortController();
    marketplaceAbortRef.current = controller;
    setMarketplaceSearching(true);
    setMarketplaceError(null);
    setMarketplaceQueried(true);
    setMarketplaceLastQuery(query);
    // 新搜索时清除选中状态，避免旧选中项残留
    setSelectedMarketplaceSlug(null);
    try {
      const res = await fetch(`/api/marketplace/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        // 401/500 等错误明确反馈给用户，不再静默吞掉
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMarketplaceResults([]);
        setMarketplaceError(String(errBody.error || `HTTP ${res.status}`));
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      // 后端返回 { results: SkillPackage[], total, partial, refreshError }
      const packages = Array.isArray(data.results) ? data.results : [];
      setMarketplaceResults(packages);
      // 只有远程 registry 不可达（partial + refreshError）才视为错误
      // 空搜索结果是正常状态，不算错误，由 UI 渲染"未找到匹配"提示
      // 使用友好文案，不暴露原始 refreshError 技术细节给用户
      if (data.partial && data.refreshError) {
        setMarketplaceError(t("skills.marketplace_registry_unreachable", "远程技能市场暂不可达"));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setMarketplaceResults([]);
      setMarketplaceError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) {
        setMarketplaceSearching(false);
      }
    }
  }, [t]);

  // 懒加载市场技能详情：点击技能列表项时从后端 /api/marketplace/skills/:slug/details 获取
  // 后端再调用 ClawHub GET /api/v1/skills/{slug}，返回完整 metaContent（含 skillMd）
  const loadMarketplaceDetail = useCallback(async (slug: string) => {
    setMarketplaceDetailLoading(slug);
    setMarketplaceDetailError(null);
    try {
      const res = await fetch(`/api/marketplace/skills/${encodeURIComponent(slug)}/details`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(String(err.error || `HTTP ${res.status}`));
      }
      const data = await res.json();
      if (!data.success || !data.detail) {
        throw new Error("Invalid response format");
      }
      setMarketplaceDetail(data.detail as MarketplaceSearchResult);
    } catch (err) {
      setMarketplaceDetailError(err instanceof Error ? err.message : String(err));
      setMarketplaceDetail(null);
    } finally {
      setMarketplaceDetailLoading(null);
    }
  }, []);

  // 选中/取消选中市场技能时触发懒加载
  useEffect(() => {
    if (selectedMarketplaceSlug) {
      loadMarketplaceDetail(selectedMarketplaceSlug);
    } else {
      setMarketplaceDetail(null);
      setMarketplaceDetailError(null);
    }
  }, [selectedMarketplaceSlug, loadMarketplaceDetail]);

  const handleMarketplaceInstall = useCallback(async (skillName: string) => {
    setMarketplaceInstalling(skillName);
    try {
      const res = await fetch("/api/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skillName }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: "success", text: t("skills.install_success", "技能 {0} 安装成功").replace("{0}", skillName) });
        await loadSkills();
        // 安装成功后清除详情缓存，重新加载以反映已安装状态
        if (selectedMarketplaceSlug === skillName) {
          loadMarketplaceDetail(skillName);
        }
        void data;
      } else {
        const err = await res.json().catch(() => ({ error: `Install failed (HTTP ${res.status})` }));
        // 完整显示后端返回的错误信息（包含 ClawHub 解析失败、下载失败、解压失败等详细原因）
        const errMsg = String(err.error || `Install failed (HTTP ${res.status})`);
        setMessage({ type: "error", text: `${t("skills.install_fail", "安装失败")}: ${errMsg}` });
      }
    } catch (err) {
      // 网络错误或 JSON 解析错误，显示具体异常信息
      const msg = err instanceof Error ? err.message : String(err);
      setMessage({ type: "error", text: `${t("skills.install_fail", "安装失败")}: ${msg}` });
    }
    setMarketplaceInstalling(null);
  }, [loadSkills, selectedMarketplaceSlug, loadMarketplaceDetail]);

  // Load trending on marketplace tab open
  useEffect(() => {
    if (marketplaceTab && trendingSkills.length === 0) {
      fetch("/api/marketplace/trending?limit=20")
        .then(async r => {
          if (!r.ok) {
            // trending 拉取失败时静默降级为空列表，不阻塞渲染
            return { skills: [], partial: true, refreshError: `HTTP ${r.status}` };
          }
          return r.json();
        })
        .then(data => {
          setTrendingSkills(Array.isArray(data.skills) ? data.skills : []);
          // 仅在 trending 也拿到错误且 marketError 当前无值时显示一次提示
          // 使用友好文案而非原始错误，避免暴露技术细节给普通用户
          if (data.partial && data.refreshError && data.skills.length === 0) {
            setMarketplaceError(prev => prev ?? t("skills.marketplace_registry_unreachable", "远程技能市场暂不可达"));
          }
        })
        .catch(() => {
          /* 网络错误：保持 trendingSkills 为空，UI 显示空态即可 */
        });
    }
  }, [marketplaceTab, trendingSkills.length, t]);

  const handleSaveConfig = useCallback(async () => {
    if (!selectedId) return;
    try {
      const cleanConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(configValues)) {
        if (k !== "_requiredBins" && k !== "_primaryEnv" && k !== "_" && k !== "_envMeta") {
          if (configModes[k] === "env") {
            cleanConfig[k] = "";
          } else {
            cleanConfig[k] = v;
          }
        }
      }
      const res = await fetch(`/api/skills/${selectedId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cleanConfig }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: t("skills.config_saved", "配置已保存") });
        await loadSkillDetail(selectedId);
        setValidating((prev) => ({ ...prev, [selectedId]: true }));
        try {
          const result = await validateConfig(selectedId);
          setValidationResults((prev) => ({
            ...prev,
            [selectedId]: result.valid !== undefined ? result : { valid: result.ok ?? false, errors: result.errors || [], warnings: result.warnings || [] },
          }));
        } catch {
          setValidationResults((prev) => ({
            ...prev,
            [selectedId]: { valid: true, errors: [], warnings: [] },
          }));
        }
        setValidating((prev) => ({ ...prev, [selectedId]: false }));
      } else {
        setMessage({ type: "error", text: t("skills.save_fail", "保存失败") });
      }
    } catch {
      setMessage({ type: "error", text: t("skills.save_fail", "保存失败") });
    }
  }, [selectedId, configValues, configModes, loadSkillDetail]);

  const handleHealthCheck = useCallback(async (skillId: string) => {
    setHealthChecking((prev) => ({ ...prev, [skillId]: true }));
    try {
      await healthCheck(skillId);
      if (selectedId === skillId) {
        await loadSkillDetail(skillId);
      }
      await loadSkills();
      setMessage({ type: "success", text: t("skills.health_check_done", "健康检查完成") });
    } catch {
      setMessage({ type: "error", text: t("skills.health_check_fail", "健康检查失败") });
    }
    setHealthChecking((prev) => ({ ...prev, [skillId]: false }));
  }, [selectedId, loadSkillDetail, loadSkills]);

  const handleCheckUpdates = useCallback(async () => {
    setCheckingUpdates(true);
    try {
      const data = await checkUpdates();
      if (data.updates && typeof data.updates === "object") {
        setUpdateInfo(data.updates);
        const updateCount = Object.values(data.updates).filter((u: unknown) => (u as { updateAvailable: boolean }).updateAvailable).length;
        setMessage({ type: updateCount > 0 ? "warning" : "success", text: updateCount > 0 ? t("skills.updates_found", "发现 {0} 个技能有可用更新").replace("{0}", String(updateCount)) : t("skills.all_up_to_date", "所有技能均为最新版本") });
      }
      await loadSkills();
    } catch {
      setMessage({ type: "error", text: t("skills.check_updates_fail", "检查更新失败") });
    }
    setCheckingUpdates(false);
  }, [loadSkills]);

  const handleUpgradeSkill = useCallback(async (skillId: string) => {
    setUpgrading((prev) => ({ ...prev, [skillId]: true }));
    try {
      await upgradeSkill(skillId);
      setMessage({ type: "success", text: t("skills.upgrade_ok", "升级成功") });
      await loadSkillDetail(skillId);
      await loadSkills();
    } catch {
      setMessage({ type: "error", text: t("skills.upgrade_fail", "升级失败") });
    }
    setUpgrading((prev) => ({ ...prev, [skillId]: false }));
  }, [loadSkillDetail, loadSkills]);

  const handleBatchUpgrade = useCallback(async () => {
    if (selectedSkills.size === 0) return;
    setBatchUpgrading(true);
    try {
      await batchUpgrade(Array.from(selectedSkills));
      setMessage({ type: "success", text: t("skills.batch_upgrade_ok", "批量升级完成: {0} 个技能").replace("{0}", String(selectedSkills.size)) });
      setSelectedSkills(new Set());
      await loadSkills();
      if (selectedId) {
        await loadSkillDetail(selectedId);
      }
    } catch {
      setMessage({ type: "error", text: t("skills.batch_upgrade_fail", "批量升级失败") });
    }
    setBatchUpgrading(false);
  }, [selectedSkills, loadSkills, loadSkillDetail, selectedId]);

  const handleValidateConfig = useCallback(async (skillId: string) => {
    setValidating((prev) => ({ ...prev, [skillId]: true }));
    try {
      const result = await validateConfig(skillId);
      setValidationResults((prev) => ({
        ...prev,
        [skillId]: result.valid !== undefined ? result : { valid: result.ok ?? false, errors: result.errors || [], warnings: result.warnings || [] },
      }));
    } catch {
      setValidationResults((prev) => ({
        ...prev,
        [skillId]: { valid: false, errors: [t("skills.validate_request_fail", "验证请求失败")], warnings: [] },
      }));
    }
    setValidating((prev) => ({ ...prev, [skillId]: false }));
  }, []);

  const toggleSkillSelection = useCallback((skillId: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedSkills.size === skills.length) {
      setSelectedSkills(new Set());
    } else {
      setSelectedSkills(new Set(skills.map((s) => s.id)));
    }
  }, [selectedSkills, skills]);

  const handleDeleteSkill = useCallback(async (skillId: string) => {
    setDeleting((prev) => ({ ...prev, [skillId]: true }));
    try {
      const res = await fetch(`/api/skills/${skillId}`, { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        setMessage({ type: "success", text: t("skills.delete_ok", "已删除技能: {0}").replace("{0}", data.name || skillId) });
        if (selectedId === skillId) {
          setSelectedId(null);
          setSelectedSkill(null);
        }
        await loadSkills();
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: "error", text: t("skills.delete_fail", "删除失败: {0}").replace("{0}", data.error || "Unknown error") });
      }
    } catch {
      setMessage({ type: "error", text: t("skills.delete_fail", "删除失败") });
    }
    setDeleting((prev) => ({ ...prev, [skillId]: false }));
    setConfirmDeleteId(null);
  }, [selectedId, loadSkills]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedSkills.size === 0) return;
    setBatchDeleting(true);
    try {
      const res = await fetch("/api/skills/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillIds: Array.from(selectedSkills) }),
      });
      if (res.ok) {
        const data = await res.json();
        const successCount = data.success?.length || 0;
        const failCount = data.failed?.length || 0;
        if (failCount > 0) {
          setMessage({ type: "warning", text: t("skills.batch_delete_partial", "批量删除完成: {0} 成功, {1} 失败").replace("{0}", String(successCount)).replace("{1}", String(failCount)) });
        } else {
          setMessage({ type: "success", text: t("skills.batch_delete_ok", "已删除 {0} 个技能").replace("{0}", String(successCount)) });
        }
        setSelectedSkills(new Set());
        if (selectedId && data.success?.includes(selectedId)) {
          setSelectedId(null);
          setSelectedSkill(null);
        }
        await loadSkills();
      } else {
        setMessage({ type: "error", text: t("skills.batch_delete_fail", "批量删除失败") });
      }
    } catch {
      setMessage({ type: "error", text: t("skills.batch_delete_fail", "批量删除失败") });
    }
    setBatchDeleting(false);
    setConfirmBatchDelete(false);
  }, [selectedSkills, selectedId, loadSkills]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !sidebarRef.current) return;
      const rect = sidebarRef.current.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const newWidth = Math.max(180, Math.min(500, e.clientX - rect.left));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const selected = skills.find((s) => s.id === selectedId) || null;
  const skillConfig = selectedSkill?.config && typeof selectedSkill.config === "object"
    ? selectedSkill.config as Record<string, unknown>
    : {};
  const configKeys = Object.keys(skillConfig).filter(
    (k) => k !== "_requiredBins" && k !== "_primaryEnv" && k !== "_" && k !== "_envMeta"
  );
  const primaryEnv = skillConfig._primaryEnv as string | undefined;
  const requiredBinsRaw = skillConfig._requiredBins;
  const requiredBins: string[] = Array.isArray(requiredBinsRaw) ? requiredBinsRaw as string[] : (typeof requiredBinsRaw === "string" ? [requiredBinsRaw] : []);
  const hasEnvConfig = configKeys.some(k => /^[A-Z_]+$/.test(k) && k !== "_");
  const envMeta = (skillConfig._envMeta || {}) as Record<string, EnvMeta>;
  // 拆分缺失/已安装 binary：missingBins 由后端 registerSkillFromDir 检测并填充
  const missingBins: string[] = Array.isArray(selectedSkill?.missingBins) ? selectedSkill!.missingBins! : [];
  const installedBins: string[] = requiredBins.filter(b => !missingBins.includes(b));

  const updatableCount = skills.filter((s) => {
    if (s.updateAvailable) return true;
    const info = updateInfo[s.id];
    return info?.updateAvailable;
  }).length;

  const getScriptType = (scripts: Record<string, string>): string => {
    const exts = new Set<string>();
    for (const scriptPath of Object.keys(scripts)) {
      if (scriptPath.endsWith(".py")) exts.add("python");
      else if (scriptPath.endsWith(".sh") || scriptPath.endsWith(".bash")) exts.add("bash");
      else if (scriptPath.endsWith(".ts")) exts.add("typescript");
      else if (scriptPath.endsWith(".js")) exts.add("javascript");
    }
    return exts.size > 0 ? Array.from(exts).join(", ") : t("skills.unknown_type", "未知");
  };

  const getSandboxPolicy = (hooks: Record<string, string>): { allowNetwork: boolean; allowSubprocess: boolean; allowFileSystem: boolean } => {
    const allHooks = Object.values(hooks).join(" ").toLowerCase();
    return {
      allowNetwork: allHooks.includes("network") || allHooks.includes("fetch") || allHooks.includes("http"),
      allowSubprocess: allHooks.includes("subprocess") || allHooks.includes("exec") || allHooks.includes("spawn"),
      allowFileSystem: allHooks.includes("filesystem") || allHooks.includes("file") || allHooks.includes("read") || allHooks.includes("write"),
    };
  };

  return (
    <div style={styles.container}>
      <div ref={sidebarRef} style={{ ...styles.sidebar, width: `${sidebarWidth}px` }}>
        <div style={styles.sidebarHeader}>
          <span style={styles.sidebarTitle}>Skills ({skills.length})</span>
          <button
            style={{ ...styles.refreshButton, opacity: refreshing ? 0.6 : 1 }}
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? t("skills.checking") : t("skills.refresh")}
          </button>
        </div>
        {/* ── Search & Sort Bar ── */}
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
          <input
            type="text"
            placeholder={t("skills.search_placeholder", "搜索技能...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%", boxSizing: "border-box", padding: "5px 8px",
              fontSize: "12px", borderRadius: "4px", border: "1px solid var(--border)",
              background: "var(--bg-primary)", color: "var(--text-primary)",
            }}
          />
          <div style={{ display: "flex", gap: "4px", marginTop: "4px", alignItems: "center" }}>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              style={{ flex: 1, fontSize: "11px", padding: "2px 4px", borderRadius: "3px", border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
            >
              <option value="name">{t("skills.sort_name", "名称")}</option>
              <option value="category">{t("skills.sort_category", "分类")}</option>
              <option value="status">{t("skills.sort_status", "状态")}</option>
              <option value="invocations">{t("skills.sort_invocations", "调用次数")}</option>
              <option value="rating">{t("skills.sort_rating", "评分")}</option>
              <option value="updated">{t("skills.sort_updated", "更新时间")}</option>
            </select>
            <button
              onClick={() => setSortOrder(prev => prev === "asc" ? "desc" : "asc")}
              style={{ fontSize: "11px", padding: "2px 6px", borderRadius: "3px", border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", cursor: "pointer" }}
              title={sortOrder === "asc" ? "升序" : "降序"}
            >
              {sortOrder === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>
        {/* ── Tab: Installed / Marketplace ── */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          <button
            onClick={() => setMarketplaceTab(false)}
            style={{
              flex: 1, padding: "6px 0", fontSize: "11px", fontWeight: marketplaceTab ? "normal" : "bold",
              border: "none", borderBottom: marketplaceTab ? "none" : "2px solid var(--accent)",
              background: "transparent", color: marketplaceTab ? "var(--text-muted)" : "var(--text-primary)", cursor: "pointer",
            }}
          >
            {t("skills.tab_installed", "已安装")}
          </button>
          <button
            onClick={() => setMarketplaceTab(true)}
            style={{
              flex: 1, padding: "6px 0", fontSize: "11px", fontWeight: marketplaceTab ? "bold" : "normal",
              border: "none", borderBottom: marketplaceTab ? "2px solid var(--accent)" : "none",
              background: "transparent", color: marketplaceTab ? "var(--text-primary)" : "var(--text-muted)", cursor: "pointer",
            }}
          >
            {t("skills.tab_marketplace", "技能市场")}
          </button>
        </div>
        {/* ── Marketplace Tab: 搜索框（列表在 sidebarList 区域渲染，详情在 contentPanel） ── */}
        {marketplaceTab && (
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
            <input
              type="text"
              placeholder={t("skills.search_marketplace", "搜索技能市场...")}
              onKeyDown={(e) => { if (e.key === "Enter") handleMarketplaceSearch((e.target as HTMLInputElement).value); }}
              style={{
                width: "100%", boxSizing: "border-box", padding: "5px 8px",
                fontSize: "12px", borderRadius: "4px", border: "1px solid var(--border)",
                background: "var(--bg-primary)", color: "var(--text-primary)",
              }}
            />
            {marketplaceSearching && <div style={{ fontSize: "11px", color: "var(--text-muted)", padding: "4px 0" }}>搜索中...</div>}
            {marketplaceError && !marketplaceSearching && (
              <div style={{
                fontSize: "11px", color: "var(--warning)", padding: "6px 8px", margin: "4px 0",
                background: "var(--warning-bg)", borderRadius: "3px", wordBreak: "break-word",
              }}>
                {marketplaceError}
              </div>
            )}
            {/* 搜索无结果：仅当用户已提交搜索且无错误且无结果时显示，是信息提示而非错误 */}
            {!marketplaceSearching && marketplaceResults.length === 0 && marketplaceQueried && !marketplaceError && (
              <div style={{ fontSize: "11px", color: "var(--text-muted)", padding: "8px 4px" }}>
                {t("skills.marketplace_no_match", "未找到匹配「{0}」的技能").replace("{0}", marketplaceLastQuery)}
              </div>
            )}
            {/* 初始空态：未搜索、无 trending、无错误时显示友好引导 */}
            {!marketplaceSearching && marketplaceResults.length === 0 && trendingSkills.length === 0 && !marketplaceQueried && !marketplaceError && (
              <div style={{ fontSize: "11px", color: "var(--text-muted)", padding: "8px 4px" }}>
                {t("skills.marketplace_initial_hint", "在上方搜索框输入关键词，搜索可安装的技能")}
              </div>
            )}
          </div>
        )}
        <div style={styles.batchBar}>
          <label style={{ fontSize: "11px", color: "var(--text-secondary)", display: "flex", alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={skills.length > 0 && selectedSkills.size === skills.length}
              onChange={toggleSelectAll}
              style={styles.checkbox}
            />
            {t("skills.select_all", "全选")}
          </label>
          <button
            style={{
              ...styles.batchButtonAccent,
              opacity: selectedSkills.size > 0 && !batchUpgrading ? 1 : 0.5,
              cursor: selectedSkills.size > 0 && !batchUpgrading ? "pointer" : "not-allowed",
            }}
            onClick={handleBatchUpgrade}
            disabled={selectedSkills.size === 0 || batchUpgrading}
          >
            {batchUpgrading ? t("skills.upgrading", "升级中...") : t("skills.batch_upgrade", "批量升级 ({0})").replace("{0}", String(selectedSkills.size))}
          </button>
          <button
            style={{
              ...styles.batchButton,
              opacity: selectedSkills.size > 0 && !batchDeleting ? 1 : 0.5,
              cursor: selectedSkills.size > 0 && !batchDeleting ? "pointer" : "not-allowed",
              color: "var(--error)",
              borderColor: "var(--error)",
            }}
            onClick={() => setConfirmBatchDelete(true)}
            disabled={selectedSkills.size === 0 || batchDeleting}
          >
            {batchDeleting ? t("skills.deleting", "删除中...") : t("skills.batch_delete", "批量删除 ({0})").replace("{0}", String(selectedSkills.size))}
          </button>
          <button
            style={{ ...styles.batchButton, opacity: refreshing ? 0.5 : 1 }}
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {t("skills.refresh", "刷新")}
          </button>
          <button
            style={{ ...styles.batchButton, opacity: checkingUpdates ? 0.5 : 1 }}
            onClick={handleCheckUpdates}
            disabled={checkingUpdates}
          >
            {checkingUpdates ? t("skills.checking", "检查中...") : t("skills.check_all_updates", "检查所有更新")}
          </button>
        </div>
        <div style={styles.sidebarList}>
          {marketplaceTab ? (
            // ── Marketplace Tab: 搜索结果/热门技能列表（单栏，点击选中后在右侧 contentPanel 显示详情） ──
            (() => {
              const listItems = marketplaceResults.length > 0
                ? marketplaceResults
                : (!marketplaceQueried && trendingSkills.length > 0 ? trendingSkills : []);
              if (listItems.length === 0) return null;
              return (
                <>
                  {marketplaceResults.length === 0 && trendingSkills.length > 0 && (
                    <div style={{ fontSize: "11px", color: "var(--text-muted)", padding: "6px 10px 2px" }}>{t("skills.trending", "热门技能")}</div>
                  )}
                  {listItems.map((ms, idx) => {
                    const slug = ms.slug || ms.name;
                    const isSelected = slug === selectedMarketplaceSlug;
                    return (
                      <div
                        key={idx}
                        onClick={() => setSelectedMarketplaceSlug(isSelected ? null : slug)}
                        style={isSelected ? styles.sidebarItemActive : styles.sidebarItem}
                        onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = ""; }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "4px" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={styles.skillItemName}>
                              {ms.displayName || ms.name}
                            </div>
                            {ms.owner && <div style={{ fontSize: "10px", color: "var(--text-muted)" }}>@{ms.owner}</div>}
                            {ms.summary && <div style={styles.skillItemDesc}>{ms.summary}</div>}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleMarketplaceInstall(slug); }}
                            disabled={marketplaceInstalling === slug}
                            style={{
                              marginLeft: "2px", padding: "2px 6px", fontSize: "10px", borderRadius: "3px",
                              border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff",
                              cursor: marketplaceInstalling === slug ? "wait" : "pointer",
                              opacity: marketplaceInstalling === slug ? 0.6 : 1,
                              whiteSpace: "nowrap", flexShrink: 0,
                            }}
                          >
                            {marketplaceInstalling === slug ? "..." : t("skills.install_btn", "安装")}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })()
          ) : filteredAndSortedSkills().length === 0 ? (
            <div style={{ padding: "20px 14px", color: "var(--text-muted)", fontSize: "12px" }}>
              {searchQuery ? t("skills.no_search_results", "未找到匹配的技能") : t("skills.no_skills_registered", "暂无已注册技能。点击 Scan 扫描 skills/ 文件夹。")}
            </div>
          ) : (
            filteredAndSortedSkills().map((skill) => {
              const cStatus = getConfigStatus(skill);
              const dotColor = configStatusColor(cStatus);
              const hasUpdate = skill.updateAvailable || updateInfo[skill.id]?.updateAvailable;
              return (
                <div
                  key={skill.id}
                  style={selectedId === skill.id ? styles.sidebarItemActive : styles.sidebarItem}
                  onClick={() => setSelectedId(skill.id)}
                  onMouseEnter={(e) => {
                    if (selectedId !== skill.id) {
                      (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedId !== skill.id) {
                      (e.currentTarget as HTMLElement).style.background = "";
                    }
                  }}
                >
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={selectedSkills.has(skill.id)}
                      onChange={(e) => {
                        e.stopPropagation();
                        toggleSkillSelection(skill.id);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={styles.checkbox}
                    />
                    <span style={{ ...styles.statusDot, background: dotColor }} title={configStatusText(cStatus, t)} />
                    <span style={styles.skillItemName}>{skill.emoji ? `${skill.emoji} ` : ""}{skill.name}</span>
                    {hasUpdate && (
                      <span style={{ fontSize: "10px", color: "var(--accent)", fontWeight: "bold", marginLeft: "4px" }}>🆕</span>
                    )}
                  </div>
                  <div style={{ ...styles.skillItemDesc, marginLeft: "36px" }}>{skill.description ? skill.description.slice(0, 60) : t("skills.no_description", "无描述")}</div>
                  <div style={{ display: "flex", gap: "4px", alignItems: "center", marginTop: "4px", marginLeft: "36px" }}>
                    <span style={statusBadgeStyle(skill.lifecycle.status)}>
                      {skill.lifecycle.status}
                    </span>
                    <span style={{
                      display: "inline-block",
                      padding: "1px 4px",
                      borderRadius: "2px",
                      fontSize: "9px",
                      color: "var(--primary)",
                      background: "var(--primary-bg, rgba(0,123,255,0.1))",
                    }}>
                      {skill.category}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div
          style={styles.dragHandle}
          onMouseDown={(e) => {
            e.preventDefault();
            isDragging.current = true;
            document.body.style.cursor = "col-resize";
          }}
        />
      </div>

      {marketplaceTab ? (
        // ── Marketplace Tab: 右侧大面积区域显示选中技能的详情（懒加载完整详情） ──
        (() => {
          if (!selectedMarketplaceSlug) {
            return (
              <div style={styles.placeholder}>
                {t("skills.marketplace_select_hint", "点击左侧技能查看详情")}
              </div>
            );
          }
          // 加载中状态
          if (marketplaceDetailLoading === selectedMarketplaceSlug) {
            return (
              <div style={styles.placeholder}>
                {t("skills.loading_detail", "正在加载技能详情...")}
              </div>
            );
          }
          // 加载失败状态
          if (marketplaceDetailError) {
            return (
              <div style={styles.contentPanel}>
                <div style={msgBannerStyle("error")}>
                  {t("skills.detail_load_failed", "加载详情失败")}: {marketplaceDetailError}
                </div>
              </div>
            );
          }
          // 详情未加载完成（理论上不会到这里，但作为兜底）
          if (!marketplaceDetail) {
            return (
              <div style={styles.placeholder}>
                {t("skills.marketplace_select_hint", "点击左侧技能查看详情")}
              </div>
            );
          }
          return (
            <div style={styles.contentPanel}>
              {message && (
                <div style={msgBannerStyle(message.type)}>
                  {message.text}
                  <button
                    onClick={() => setMessage(null)}
                    style={{ marginLeft: "12px", background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: "12px" }}
                  >
                    ✕
                  </button>
                </div>
              )}
              <MarketplaceSkillDetail skill={marketplaceDetail} t={t} onInstall={handleMarketplaceInstall} installing={marketplaceInstalling} />
            </div>
          );
        })()
      ) : selected && selectedSkill ? (
        <div style={styles.contentPanel}>
          {message && (
            <div style={msgBannerStyle(message.type)}>
              {message.text}
              <button
                onClick={() => setMessage(null)}
                style={{ marginLeft: "12px", background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: "12px" }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Batch delete confirmation overlay */}
          {confirmBatchDelete && (
            <div style={{
              position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
              background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 1000,
            }}>
              <div style={{
                background: "var(--bg-secondary)", border: "1px solid var(--error)", borderRadius: "8px",
                padding: "20px 24px", maxWidth: "400px", width: "90%",
              }}>
                <div style={{ color: "var(--error)", fontSize: "14px", fontWeight: "bold", marginBottom: "12px" }}>
                  {t("skills.batch_delete_confirm_title", "确认批量删除")}
                </div>
                <div style={{ color: "var(--text-secondary)", fontSize: "13px", marginBottom: "16px" }}>
                  {t("skills.batch_delete_confirm", "确定要删除选中的 {0} 个技能吗？此操作不可撤销。").replace("{0}", String(selectedSkills.size))}
                </div>
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button
                    style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-light)", padding: "6px 16px", borderRadius: "4px", cursor: "pointer", fontSize: "13px" }}
                    onClick={() => setConfirmBatchDelete(false)}
                  >
                    {t("skills.cancel", "取消")}
                  </button>
                  <button
                    style={{ background: "var(--error)", color: "#fff", border: "none", padding: "6px 16px", borderRadius: "4px", cursor: "pointer", fontSize: "13px" }}
                    onClick={handleBatchDelete}
                    disabled={batchDeleting}
                  >
                    {batchDeleting ? t("skills.deleting", "删除中...") : t("skills.confirm", "确认删除")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Round 8: 安全详情弹窗 */}
          {securityDialogSkillId && selectedSkill && securityDialogSkillId === selectedSkill.id && securityScans[selectedSkill.id] && (
            <div style={{
              position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
              background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 1000,
            }} onClick={() => setSecurityDialogSkillId(null)}>
              <div
                style={{
                  background: "var(--bg-secondary)", border: "1px solid var(--border-light)", borderRadius: "8px",
                  padding: "20px 24px", maxWidth: "640px", width: "90%", maxHeight: "80vh",
                  overflow: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {(() => {
                  const scan = securityScans[selectedSkill.id];
                  const riskColor = scan.riskLevel === "critical" ? "#dc3545"
                    : scan.riskLevel === "high" ? "#fd7e14"
                    : scan.riskLevel === "medium" ? "#ffc107"
                    : "#28a745";
                  return (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                        <div style={{ fontSize: "15px", fontWeight: "bold", color: "var(--text-primary)" }}>
                          🛡️ {t("skills.security_scan_title", "安全扫描详情")} — {selectedSkill.name}
                        </div>
                        <button
                          onClick={() => setSecurityDialogSkillId(null)}
                          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "16px" }}
                        >
                          ✕
                        </button>
                      </div>
                      <div style={{
                        display: "inline-flex", alignItems: "center", gap: "6px",
                        padding: "4px 10px", borderRadius: "4px", fontSize: "12px",
                        fontWeight: "bold", color: riskColor,
                        background: scan.riskLevel === "critical" ? "rgba(220,53,69,0.15)"
                          : scan.riskLevel === "high" ? "rgba(253,126,20,0.15)"
                          : scan.riskLevel === "medium" ? "rgba(255,193,7,0.15)"
                          : "rgba(40,167,69,0.15)",
                        border: `1px solid ${riskColor}33`, marginBottom: "12px",
                      }}>
                        {scan.safe ? "✓ " : "✕ "}
                        {t("skills.risk_level", "风险等级")}: {
                          scan.riskLevel === "critical" ? t("skills.risk_critical", "危险")
                          : scan.riskLevel === "high" ? t("skills.risk_high", "高风险")
                          : scan.riskLevel === "medium" ? t("skills.risk_medium", "中风险")
                          : t("skills.risk_low", "低风险")
                        }
                        {" · "}
                        {scan.findings.length} {t("skills.findings", "项发现")}
                      </div>
                      {scan.findings.length === 0 ? (
                        <div style={{ color: "var(--text-secondary)", fontSize: "13px", padding: "16px 0", textAlign: "center" }}>
                          {t("skills.no_findings", "未发现安全问题 ✓")}
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {scan.findings.map((f, idx) => {
                            const sevColor = f.severity === "critical" ? "#dc3545"
                              : f.severity === "high" ? "#fd7e14"
                              : f.severity === "medium" ? "#ffc107"
                              : "#6c757d";
                            return (
                              <div key={idx} style={{
                                border: "1px solid var(--border-light)", borderRadius: "4px",
                                padding: "8px 10px", background: "var(--bg-primary)",
                              }}>
                                <div style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" }}>
                                  <span style={{
                                    padding: "1px 5px", borderRadius: "2px", fontSize: "9px",
                                    fontWeight: "bold", color: "#fff", background: sevColor,
                                    textTransform: "uppercase",
                                  }}>
                                    {f.severity}
                                  </span>
                                  <span style={{
                                    padding: "1px 5px", borderRadius: "2px", fontSize: "9px",
                                    color: "var(--text-muted)", background: "var(--bg-hover)",
                                  }}>
                                    {f.type}
                                  </span>
                                  <span style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "monospace" }}>
                                    {f.location}
                                  </span>
                                </div>
                                <div style={{ fontSize: "12px", color: "var(--text-primary)", marginBottom: "4px" }}>
                                  {f.description}
                                </div>
                                <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontStyle: "italic" }}>
                                  💡 {f.recommendation}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
                        <button
                          onClick={() => {
                            fetchSecurityScan(selectedSkill.id, true);
                            setSecurityDialogSkillId(null);
                          }}
                          style={{
                            background: "var(--bg-hover)", color: "var(--text-secondary)",
                            border: "1px solid var(--border-light)", padding: "6px 16px",
                            borderRadius: "4px", cursor: "pointer", fontSize: "12px", marginRight: "8px",
                          }}
                        >
                          {t("skills.rescan", "重新扫描")}
                        </button>
                        <button
                          onClick={() => setSecurityDialogSkillId(null)}
                          style={{
                            background: "var(--accent)", color: "#fff", border: "none",
                            padding: "6px 16px", borderRadius: "4px", cursor: "pointer", fontSize: "12px",
                          }}
                        >
                          {t("skills.close", "关闭")}
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          <div style={styles.detailHeader}>
            <div>
              <span style={styles.detailName}>{selectedSkill.emoji ? `${selectedSkill.emoji} ` : ""}{selectedSkill.name}</span>
              <span style={styles.detailVersion}>v{selectedSkill.version}</span>
              {(selectedSkill.updateAvailable || updateInfo[selectedSkill.id]?.updateAvailable) && (
                <span style={{
                  display: "inline-block",
                  padding: "2px 6px",
                  borderRadius: "3px",
                  fontSize: "10px",
                  fontWeight: "bold",
                  color: "var(--accent)",
                  background: "var(--primary-bg, rgba(0,123,255,0.1))",
                  marginLeft: "8px",
                }}>
                  🆕 {t("skills.has_update", "有更新")}
                </span>
              )}
            </div>
            <div style={styles.detailDesc}>{selectedSkill.description || t("skills.no_description", "无描述")}</div>
            {selectedSkill.i18n?.description_zh && selectedSkill.i18n.description_zh !== selectedSkill.description && (
              <div style={{ ...styles.detailDesc, color: "var(--primary)", marginTop: "4px", borderLeft: "3px solid var(--primary)", paddingLeft: "8px" }}>
                {selectedSkill.i18n.description_zh}
              </div>
            )}
            <div style={{ marginTop: "8px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={statusBadgeStyle(selectedSkill.lifecycle.status)}>
                {selectedSkill.lifecycle.status}
              </span>
              <span style={{
                display: "inline-block",
                padding: "2px 6px",
                borderRadius: "3px",
                fontSize: "10px",
                fontWeight: "bold",
                color: "var(--primary)",
                background: "var(--primary-bg, rgba(0,123,255,0.1))",
              }}>
                {selectedSkill.category}
              </span>
              {selectedSkill.license && (
                <span style={{
                  display: "inline-block",
                  padding: "2px 6px",
                  borderRadius: "3px",
                  fontSize: "10px",
                  color: "var(--text-muted)",
                  background: "var(--hover-bg)",
                }}>
                  {selectedSkill.license}
                </span>
              )}
              {(() => {
                const cStatus = getConfigStatus(selectedSkill);
                return (
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "2px 6px",
                    borderRadius: "3px",
                    fontSize: "10px",
                    fontWeight: "bold",
                    color: configStatusColor(cStatus),
                    background: cStatus === "configured" ? "var(--success-bg)" : cStatus === "partial" ? "var(--warning-bg)" : cStatus === "unconfigured" ? "var(--error-bg)" : "var(--bg-hover)",
                  }}>
                    <span style={{ ...styles.statusDot, background: configStatusColor(cStatus) }} />
                    {configStatusText(cStatus, t)}
                  </span>
                );
              })()}
              {(() => {
                // Round 8: 安全 verdict chip
                const scan = securityScans[selectedSkill.id];
                if (securityScanLoading === selectedSkill.id && !scan) {
                  return (
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: "4px",
                      padding: "2px 6px", borderRadius: "3px", fontSize: "10px",
                      color: "var(--text-muted)", background: "var(--bg-hover)", cursor: "wait",
                    }}>
                      扫描中...
                    </span>
                  );
                }
                if (!scan) {
                  return (
                    <span
                      onClick={() => fetchSecurityScan(selectedSkill.id, true)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: "4px",
                        padding: "2px 6px", borderRadius: "3px", fontSize: "10px",
                        color: "var(--text-muted)", background: "var(--bg-hover)", cursor: "pointer",
                      }}
                      title="点击重新扫描"
                    >
                      ⚠ 未扫描
                    </span>
                  );
                }
                const riskColor = scan.riskLevel === "critical" ? "#dc3545"
                  : scan.riskLevel === "high" ? "#fd7e14"
                  : scan.riskLevel === "medium" ? "#ffc107"
                  : "#28a745";
                const riskBg = scan.riskLevel === "critical" ? "rgba(220,53,69,0.15)"
                  : scan.riskLevel === "high" ? "rgba(253,126,20,0.15)"
                  : scan.riskLevel === "medium" ? "rgba(255,193,7,0.15)"
                  : "rgba(40,167,69,0.15)";
                const riskLabel = scan.safe
                  ? (scan.findings.length === 0 ? "✓ 安全" : `✓ ${scan.findings.length} 提示`)
                  : `✕ ${scan.riskLevel === "critical" ? "危险" : scan.riskLevel === "high" ? "高风险" : scan.riskLevel === "medium" ? "中风险" : "低风险"} (${scan.findings.length})`;
                return (
                  <span
                    onClick={() => setSecurityDialogSkillId(selectedSkill.id)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "4px",
                      padding: "2px 6px", borderRadius: "3px", fontSize: "10px",
                      fontWeight: "bold", color: riskColor, background: riskBg,
                      cursor: "pointer", border: `1px solid ${riskColor}33`,
                    }}
                    title="点击查看安全详情"
                  >
                    {riskLabel}
                  </span>
                );
              })()}
            </div>
          </div>

          <div style={styles.banner}>
            <div>{t("skills.file_location", "Skill 文件位置")}: <code style={{ color: "var(--section-title-color)" }}>{selectedSkill.installPath}</code></div>
          </div>

          <div style={styles.sectionTitle}>{t("skills.version_management", "版本管理")}</div>
          <div style={styles.versionBox}>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t("skills.current_version", "当前版本")}</span>
              <span style={styles.infoValue}>v{selectedSkill.version}</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t("skills.latest_version", "最新版本")}</span>
              <span style={styles.infoValue}>
                {updateInfo[selectedSkill.id]?.latestVersion || selectedSkill.latestVersion
                  ? `v${updateInfo[selectedSkill.id]?.latestVersion || selectedSkill.latestVersion}`
                  : t("skills.not_checked", "未检查")}
                {(selectedSkill.updateAvailable || updateInfo[selectedSkill.id]?.updateAvailable) && (
                  <span style={{ color: "var(--accent)", marginLeft: "8px", fontWeight: "bold" }}>🆕 {t("skills.has_update", "有更新")}</span>
                )}
              </span>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button
                style={{
                  ...styles.batchButton,
                  opacity: checkingUpdates ? 0.5 : 1,
                }}
                onClick={handleCheckUpdates}
                disabled={checkingUpdates}
              >
                {checkingUpdates ? t("skills.checking", "检查中...") : t("skills.check_update", "检查更新")}
              </button>
              {(selectedSkill.updateAvailable || updateInfo[selectedSkill.id]?.updateAvailable) && (
                <button
                  style={{
                    ...styles.batchButtonAccent,
                    opacity: upgrading[selectedSkill.id] ? 0.5 : 1,
                  }}
                  onClick={() => handleUpgradeSkill(selectedSkill.id)}
                  disabled={!!upgrading[selectedSkill.id]}
                >
                  {upgrading[selectedSkill.id] ? t("skills.upgrading", "升级中...") : t("skills.one_click_upgrade", "一键升级")}
                </button>
              )}
            </div>
          </div>

          <div style={styles.sectionTitle}>{t("skills.basic_info", "基本信息")}</div>
          {/* Single delete button + confirm dialog */}
          <div style={{ marginBottom: "16px" }}>
            {confirmDeleteId === selectedSkill.id ? (
              <div style={{ display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", background: "var(--error-bg)", borderRadius: "4px", border: "1px solid var(--error)" }}>
                <span style={{ fontSize: "12px", color: "var(--error)" }}>{t("skills.confirm_delete", "确定要删除技能 \"{0}\" 吗？此操作不可撤销。").replace("{0}", selectedSkill.name)}</span>
                <button
                  style={{ background: "var(--error)", color: "#fff", border: "none", padding: "4px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
                  onClick={() => handleDeleteSkill(selectedSkill.id)}
                  disabled={!!deleting[selectedSkill.id]}
                >
                  {deleting[selectedSkill.id] ? t("skills.deleting", "删除中...") : t("skills.confirm", "确认删除")}
                </button>
                <button
                  style={{ background: "var(--bg-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-light)", padding: "4px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  {t("skills.cancel", "取消")}
                </button>
              </div>
            ) : (
              <button
                style={{
                  ...styles.batchButton,
                  color: "var(--error)",
                  borderColor: "var(--error)",
                }}
                onClick={() => setConfirmDeleteId(selectedSkill.id)}
              >
                {t("skills.delete_skill", "删除此技能")}
              </button>
            )}
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.author", "作者")}</span>
            <span style={styles.infoValue}>{selectedSkill.author || t("skills.unknown_type", "未知")}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.category", "分类")}</span>
            <span style={styles.infoValue}>{selectedSkill.category}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.version", "版本")}</span>
            <span style={styles.infoValue}>{selectedSkill.version}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.homepage", "主页")}</span>
            <span style={styles.infoValue}>{selectedSkill.homepage ? (
              <a href={selectedSkill.homepage} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)" }}>{selectedSkill.homepage}</a>
            ) : "-"}</span>
          </div>
          {selectedSkill.license && (
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t("skills.license", "许可证")}</span>
              <span style={styles.infoValue}>{selectedSkill.license}</span>
            </div>
          )}
          {selectedSkill.keywords.length > 0 && (
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t("skills.keywords", "关键词")}</span>
              <span style={styles.infoValue}>
                {selectedSkill.keywords.map((k, i) => (
                  <span key={i} style={styles.triggerChip}>{k}</span>
                ))}
              </span>
            </div>
          )}

          <div style={styles.sectionTitle}>{t("skills.trigger_conditions", "触发条件")}</div>
          {selectedSkill.triggers.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{t("skills.no_triggers", "无特定触发词")}</div>
          ) : (
            selectedSkill.triggers.map((t, i) => (
              <div key={i} style={styles.infoRow}>
                <span style={styles.infoLabel}>
                  <span style={styles.triggerChip}>{t.type}</span>
                </span>
                <span style={styles.infoValue}>{t.pattern} - {t.description}</span>
              </div>
            ))
          )}

          <div style={styles.sectionTitle}>{t("skills.runtime_status", "运行状态")}</div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.health_check", "健康检查")}</span>
            <span style={{
              ...styles.infoValue,
              color: selectedSkill.lifecycle.healthCheck
                ? healthStatusColor(selectedSkill.lifecycle.healthCheck.healthy, selectedSkill.lifecycle.healthCheck.warnings)
                : "var(--text-muted)",
            }}>
              {selectedSkill.lifecycle.healthCheck
                ? `${healthStatusIcon(selectedSkill.lifecycle.healthCheck.healthy, selectedSkill.lifecycle.healthCheck.warnings)} ${healthStatusText(selectedSkill.lifecycle.healthCheck.healthy, selectedSkill.lifecycle.healthCheck.warnings, t)}`
                : t("skills.not_checked", "未检查")}
            </span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.last_check", "上次检查")}</span>
            <span style={styles.infoValue}>
              {selectedSkill.lifecycle.healthCheck?.lastCheck || t("skills.not_checked", "未检查")}
            </span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.invocation_count", "调用次数")}</span>
            <span style={styles.infoValue}>{selectedSkill.stats.invocationCount}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.success_rate", "成功率")}</span>
            <span style={styles.infoValue}>
              {selectedSkill.stats.invocationCount > 0
                ? `${Math.round((selectedSkill.stats.successCount / selectedSkill.stats.invocationCount) * 100)}%`
                : "N/A"}
            </span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.avg_response_time", "平均响应时间")}</span>
            <span style={styles.infoValue}>
              {selectedSkill.stats.averageDuration > 0
                ? `${selectedSkill.stats.averageDuration}ms`
                : "N/A"}
            </span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("skills.config_status", "配置状态")}</span>
            <span style={{
              ...styles.infoValue,
              color: configStatusColor(getConfigStatus(selectedSkill)),
            }}>
              <span style={{ ...styles.statusDot, background: configStatusColor(getConfigStatus(selectedSkill)), marginRight: "6px", verticalAlign: "middle" }} />
              {configStatusText(getConfigStatus(selectedSkill), t)}
            </span>
          </div>
          <div style={{ marginTop: "8px" }}>
            <button
              style={{
                ...styles.batchButton,
                opacity: healthChecking[selectedSkill.id] ? 0.5 : 1,
              }}
              onClick={() => handleHealthCheck(selectedSkill.id)}
              disabled={!!healthChecking[selectedSkill.id]}
            >
              {healthChecking[selectedSkill.id] ? t("skills.checking", "检查中...") : t("skills.run_health_check", "执行健康检查")}
            </button>
          </div>

          {(selectedSkill.lifecycle.healthCheck?.errors?.length ?? 0) > 0 && (
            <>
              <div style={{ color: "var(--error)", fontSize: "12px", marginTop: "12px", fontWeight: "bold" }}>
                {t("skills.error_details", "错误详情")}
              </div>
              {selectedSkill.lifecycle.healthCheck?.errors.map((e, i) => (
                <div key={i} style={{ color: "var(--error)", fontSize: "11px", marginTop: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
                  <span>✗ {e}</span>
                  <button
                    style={styles.fixButton}
                    onClick={() => {
                      if (e.toLowerCase().includes("api") || e.toLowerCase().includes("key") || e.toLowerCase().includes("config")) {
                        const configSection = document.getElementById("skill-config-section");
                        if (configSection) {
                          configSection.scrollIntoView({ behavior: "smooth" });
                        }
                      } else if (e.toLowerCase().includes("depend") || e.toLowerCase().includes("install")) {
                        setMessage({ type: "warning", text: t("skills.suggest_install_dep", "建议: 请先安装缺失的依赖项 - {0}").replace("{0}", e) });
                      } else {
                        setMessage({ type: "warning", text: t("skills.suggestion", "建议: {0}").replace("{0}", e) });
                      }
                    }}
                  >
                    {t("skills.fix_suggestion", "修复建议")}
                  </button>
                </div>
              ))}
            </>
          )}

          {(selectedSkill.lifecycle.healthCheck?.warnings?.length ?? 0) > 0 && (
            <>
              <div style={{ color: "var(--warning)", fontSize: "12px", marginTop: "12px", fontWeight: "bold" }}>
                {t("skills.warning_details", "警告详情")}
              </div>
              {selectedSkill.lifecycle.healthCheck?.warnings?.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)", fontSize: "11px", marginTop: "2px" }}>
                  ⚠ {w}
                </div>
              ))}
            </>
          )}

          <div style={styles.sectionTitle}>{t("skills.tech_details", "技术详情")}</div>
          <div style={styles.techDetailBox}>
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "8px", fontWeight: "bold" }}>{t("skills.dependencies", "依赖项")}</div>
            {selectedSkill.requires.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{t("skills.no_deps", "无依赖项")}</div>
            ) : (
              selectedSkill.requires.map((d, i) => {
                const isMissing = selectedSkill.lifecycle.healthCheck?.missingDependencies?.includes(d.name);
                return (
                  <div key={i} style={styles.depItem}>
                    <span style={{ color: isMissing ? "var(--error)" : "var(--success)", fontSize: "12px" }}>
                      {isMissing ? "✗" : "✓"}
                    </span>
                    <span style={{ color: isMissing ? "var(--error)" : "var(--text-primary)", fontSize: "12px" }}>
                      {d.name}
                    </span>
                    <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>
                      {d.version} {d.optional ? t("skills.optional", "(可选)") : t("skills.required", "(必需)")}
                    </span>
                  </div>
                );
              })
            )}

            {(() => {
              const sandbox = getSandboxPolicy(selectedSkill.body.hooks);
              return (
                <>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "12px", marginBottom: "8px", fontWeight: "bold" }}>{t("skills.sandbox_policy", "沙箱策略")}</div>
                  <div>
                    <span style={sandbox.allowNetwork ? styles.sandboxChip : styles.sandboxChipOff}>
                      {sandbox.allowNetwork ? "✓" : "✗"} allowNetwork
                    </span>
                    <span style={sandbox.allowSubprocess ? styles.sandboxChip : styles.sandboxChipOff}>
                      {sandbox.allowSubprocess ? "✓" : "✗"} allowSubprocess
                    </span>
                    <span style={sandbox.allowFileSystem ? styles.sandboxChip : styles.sandboxChipOff}>
                      {sandbox.allowFileSystem ? "✓" : "✗"} allowFileSystem
                    </span>
                  </div>
                </>
              );
            })()}

            <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "12px", marginBottom: "4px", fontWeight: "bold" }}>{t("skills.script_type", "脚本类型")}</div>
            <div style={{ color: "var(--text-primary)", fontSize: "12px" }}>
              {getScriptType(selectedSkill.body.scripts)}
            </div>
          </div>

          <div style={styles.sectionTitle}>{t("skills.usage", "使用方法")}</div>
          {selectedSkill.body.instructions ? (
            <div>
              <div style={styles.instructionsBlock} dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedSkill.body.instructions) }} />
              {selectedSkill.i18n?.instructions_zh && selectedSkill.i18n.instructions_zh !== selectedSkill.body.instructions && (
                <div style={{ ...styles.instructionsBlock, borderLeft: "3px solid var(--primary)", marginTop: "8px" }}>
                  <div style={{ fontSize: "10px", color: "var(--primary)", marginBottom: "6px", fontWeight: "bold" }}>{t("skills.zh_translation", "中文翻译")}</div>
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedSkill.i18n.instructions_zh) }} />
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" }}>
              {t("skills.no_instructions", "该技能未提供详细使用说明。")}
            </div>
          )}

          {selectedSkill.body.examples.length > 0 && (
            <>
              <div style={styles.sectionTitle}>{t("skills.examples", "使用示例")}</div>
              <div style={styles.examplesBlock}>
                {selectedSkill.body.examples.map((ex, i) => (
                  <div key={i} style={styles.exampleItem}>
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(ex) }} />
                    {selectedSkill.i18n?.examples_zh?.[i] && selectedSkill.i18n.examples_zh[i] !== ex && (
                      <div style={{ color: "var(--primary)", marginTop: "4px", fontSize: "11px", borderLeft: "2px solid var(--primary)", paddingLeft: "6px" }}>
                        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedSkill.i18n.examples_zh[i]) }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {configKeys.length > 0 && (
            <>
              <div id="skill-config-section" style={styles.sectionTitle}>
                {t("skills.config", "技能配置")}
                {hasEnvConfig && <span style={{ fontSize: "10px", color: "var(--warning)", marginLeft: "8px" }}>{t("skills.needs_setup", "需要设置")}</span>}
              </div>
              {primaryEnv && (
                <div style={{ ...styles.configNoConfig, color: "var(--warning)", marginBottom: "8px", textAlign: "left" }}>
                  <span style={{ fontWeight: "bold" }}>{primaryEnv}</span> {t("skills.primary_env_required", "为必需配置项。请填入你的 API 密钥。")}
                </div>
              )}
              {requiredBins.length > 0 && (
                <div style={{ marginBottom: "10px", textAlign: "left", fontSize: "12px", padding: "8px 10px", background: "var(--bg-sidebar)", borderRadius: "4px", border: "1px solid var(--border-light)" }}>
                  <div style={{ color: "var(--text-muted)", marginBottom: "4px" }}>
                    {t("skills.requires_system_tools", "需要系统工具")}:
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                    {installedBins.map(bin => (
                      <span key={bin} style={{ display: "inline-block", padding: "2px 8px", borderRadius: "3px", fontSize: "11px", background: "var(--success-bg)", color: "var(--success)", border: "1px solid var(--success)" }} title={t("skills.binary_installed", "已安装")}>
                        ✓ {bin}
                      </span>
                    ))}
                    {missingBins.map(bin => (
                      <span key={bin} style={{ display: "inline-block", padding: "2px 8px", borderRadius: "3px", fontSize: "11px", background: "var(--error-bg)", color: "var(--error)", border: "1px solid var(--error)" }} title={t("skills.binary_missing", "缺失")}>
                        ✗ {bin}
                      </span>
                    ))}
                    {missingBins.length > 0 && (
                      <button
                        onClick={() => selectedSkill && handleInstallBins(selectedSkill.id)}
                        disabled={!!installingBins}
                        style={{
                          marginLeft: "6px", padding: "3px 10px", fontSize: "11px", borderRadius: "3px",
                          border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff",
                          cursor: installingBins ? "not-allowed" : "pointer",
                          opacity: installingBins ? 0.6 : 1,
                        }}
                      >
                        {installingBins === selectedSkill?.id
                          ? t("skills.installing", "安装中...")
                          : t("skills.install_missing_bins", "一键安装缺失工具")}
                      </button>
                    )}
                  </div>
                  {missingBins.length > 0 && (
                    <div style={{ color: "var(--text-muted)", fontSize: "10px", marginTop: "6px" }}>
                      {t("skills.binary_install_hint", "将尝试用技能声明的安装步骤或系统包管理器（winget/brew/apt）安装")}
                    </div>
                  )}
                </div>
              )}
              <form autoComplete="off" onSubmit={e => e.preventDefault()} style={styles.configForm}>
                {configKeys.map((key) => {
                  const meta = envMeta[key];
                  const isEnvKey = /^[A-Z_]+$/.test(key);
                  const isSecret = key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token");
                  const mode = configModes[key] || "direct";
                  const isRequired = meta?.required || key === primaryEnv;

                  return (
                    <div key={key} style={styles.configRow}>
                      <label style={styles.configLabel}>
                        {key}
                        {isRequired && <span style={{ color: "var(--warning)", marginLeft: "4px" }}>*</span>}
                        {meta?.description && (
                          <span style={{ color: "var(--text-muted)", marginLeft: "8px", fontSize: "10px", fontWeight: "normal" }}>
                            {meta.description}
                          </span>
                        )}
                      </label>
                      {isEnvKey ? (
                        <>
                          <div style={styles.tabContainer}>
                            <button
                              type="button"
                              style={mode === "direct" ? styles.tabActive : styles.tab}
                              onClick={() => {
                                setConfigModes((prev) => ({ ...prev, [key]: "direct" }));
                                if (mode === "env") {
                                  setConfigValues((prev) => ({ ...prev, [key]: "" }));
                                }
                              }}
                            >
                              {t("skills.direct_input", "直接输入")}
                            </button>
                            <button
                              type="button"
                              style={mode === "env" ? styles.tabActive : styles.tab}
                              onClick={() => {
                                setConfigModes((prev) => ({ ...prev, [key]: "env" }));
                                if (mode === "direct") {
                                  setConfigValues((prev) => ({ ...prev, [key]: "" }));
                                }
                              }}
                            >
                              {t("skills.env_variable", "环境变量")}
                            </button>
                          </div>
                          {mode === "direct" ? (
                            <>
                              <input
                                style={{
                                  ...styles.configInput,
                                  ...(isRequired && !configValues[key] ? { borderColor: "var(--warning)" } : {}),
                                }}
                                type={isSecret ? "password" : "text"}
                                value={configValues[key] || ""}
                                onChange={(e) =>
                                  setConfigValues((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                placeholder={t("skills.set_key", "设置 {0}...").replace("{0}", key)}
                                autoComplete="new-password"
                              />
                              <div style={{
                                fontSize: "11px",
                                marginTop: "4px",
                                color: configValues[key] ? "var(--success)" : "var(--text-muted)",
                              }}>
                                {configValues[key] ? t("skills.configured_direct", "✓ 已配置 (通过直接输入)") : t("skills.not_configured", "✗ 未配置")}
                              </div>
                            </>
                          ) : (
                            <>
                              <div style={{
                                ...styles.envStatusRow,
                                background: meta?.currentSource === "env" ? "var(--success-bg)" : "var(--error-bg)",
                                color: meta?.currentSource === "env" ? "var(--success)" : "var(--error)",
                              }}>
                                {t("skills.system_env_var", "系统环境变量")}: {key}
                                <br />
                                {meta?.currentSource === "env"
                                  ? t("skills.configured_via_env", "✓ 已通过环境变量配置{0}").replace("{0}", meta.envValue ? ` (${meta.envValue.slice(0, 4)}****)` : "")
                                  : t("skills.env_not_set", "✗ 未设置 - 请在 .env 文件中添加")}
                              </div>
                              {meta?.currentSource !== "env" && (
                                <div style={{
                                  fontSize: "11px",
                                  color: "var(--text-muted)",
                                  marginTop: "4px",
                                  padding: "6px 8px",
                                  background: "var(--bg-sidebar)",
                                  borderRadius: "4px",
                                  border: "1px dashed var(--border-light)",
                                }}>
                                  {t("skills.env_hint", "提示: 在项目根目录的 .env 文件中添加")}:<br />
                                  <code style={{ color: "var(--text-primary)" }}>{key}=your_api_key</code>
                                </div>
                              )}
                            </>
                          )}
                        </>
                      ) : (
                        <input
                          style={{
                            ...styles.configInput,
                          }}
                          type="text"
                          value={configValues[key] || ""}
                          onChange={(e) =>
                            setConfigValues((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder={`设置 ${key}...`}
                        />
                      )}
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button style={styles.saveButton} onClick={handleSaveConfig}>
                    {hasEnvConfig ? t("skills.save_and_activate", "保存并激活技能") : t("skills.save_config", "保存配置")}
                  </button>
                  <button
                    style={{
                      ...styles.batchButton,
                      marginTop: "12px",
                    }}
                    onClick={() => handleValidateConfig(selectedSkill.id)}
                    disabled={!!validating[selectedSkill.id]}
                  >
                    {validating[selectedSkill.id] ? t("skills.validating", "验证中...") : t("skills.validate_config", "验证配置")}
                  </button>
                </div>
                {validationResults[selectedSkill.id] && (
                  <div>
                    {validationResults[selectedSkill.id]!.valid && validationResults[selectedSkill.id]!.errors.length === 0 && validationResults[selectedSkill.id]!.warnings.length === 0 && (
                      <div style={styles.validationSuccess}>
                        {t("skills.config_valid", "✓ 配置有效")}
                      </div>
                    )}
                    {!validationResults[selectedSkill.id]!.valid && (
                      <div style={styles.validationError}>
                        {t("skills.config_invalid", "✗ 配置无效")}:
                        <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                          {validationResults[selectedSkill.id]!.errors.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {validationResults[selectedSkill.id]!.warnings.length > 0 && (
                      <div style={styles.validationWarning}>
                        {t("skills.validation_warnings", "⚠ 警告")}:
                        <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                          {validationResults[selectedSkill.id]!.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </form>
            </>
          )}

          {configKeys.length === 0 && (
            <>
              <div style={styles.sectionTitle}>{t("skills.config", "技能配置")}</div>
              <div style={styles.configNoConfig}>
                {t("skills.no_config", "无可用配置项")}
              </div>
            </>
          )}
        </div>
      ) : (
        <div style={styles.placeholder}>
          {skills.length === 0
            ? t("skills.no_skills_discover", "暂无已注册技能。将 .SKILL.md 文件放入 skills/ 文件夹即可自动发现。")
            : t("skills.select_skill", "请从左侧选择一个技能查看详情。")}
        </div>
      )}
    </div>
  );
}
