import React, { useState, useEffect, useCallback, useRef } from "react";

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
    healthCheck: { healthy: boolean; lastCheck: string; errors: string[]; missingDependencies: string[] } | null;
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

function msgBannerStyle(type: "success" | "error"): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: "4px",
    marginBottom: "12px",
    fontSize: "12px",
    background: type === "success" ? "var(--success-bg)" : "var(--error-bg)",
    color: type === "success" ? "var(--success)" : "var(--error)",
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
    display: "flex",
    alignItems: "center",
    marginBottom: "8px",
    gap: "10px",
  },
  configLabel: {
    color: "var(--text-secondary)",
    fontSize: "12px",
    minWidth: "120px",
  },
  configInput: {
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border-light)",
    color: "var(--text-primary)",
    padding: "6px 10px",
    borderRadius: "4px",
    fontSize: "12px",
    width: "300px",
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
};

export default function SkillsConfig() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [refreshing, setRefreshing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

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
    try {
      const res = await fetch(`/api/skills/${id}`);
      if (res.ok) {
        const skill = await res.json();
        setSelectedSkill(skill);
        const cfg: Record<string, string> = {};
        if (skill.config && typeof skill.config === "object") {
          for (const [k, v] of Object.entries(skill.config as Record<string, unknown>)) {
            cfg[k] = String(v);
          }
        }
        setConfigValues(cfg);
      }
    } catch {
      console.debug("[SkillsConfig] Skill detail not available");
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (selectedId) {
      loadSkillDetail(selectedId);
    } else {
      setSelectedSkill(null);
    }
  }, [selectedId, loadSkillDetail]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/skills/refresh", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setMessage({ type: "success", text: `扫描完成: ${data.installed} 个新安装, ${data.skipped} 已跳过` });
      }
    } catch {
      setMessage({ type: "error", text: "刷新失败" });
    }
    await loadSkills();
    setRefreshing(false);
  }, [loadSkills]);

  const handleSaveConfig = useCallback(async () => {
    if (!selectedId) return;
    try {
      // Filter out internal metadata keys before saving
      const cleanConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(configValues)) {
        if (k !== "_requiredBins" && k !== "_primaryEnv" && k !== "_") {
          cleanConfig[k] = v;
        }
      }
      const res = await fetch(`/api/skills/${selectedId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cleanConfig }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: "配置已保存" });
        await loadSkillDetail(selectedId);
      } else {
        setMessage({ type: "error", text: "保存失败" });
      }
    } catch {
      setMessage({ type: "error", text: "保存失败" });
    }
  }, [selectedId, configValues, loadSkillDetail]);

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
  // Extract config keys, filtering out internal metadata
  const skillConfig = selectedSkill?.config && typeof selectedSkill.config === "object"
    ? selectedSkill.config as Record<string, unknown>
    : {};
  const configKeys = Object.keys(skillConfig).filter(
    (k) => k !== "_requiredBins" && k !== "_primaryEnv" && k !== "_"
  );
  const primaryEnv = skillConfig._primaryEnv as string | undefined;
  const requiredBinsRaw = skillConfig._requiredBins;
  const requiredBins: string[] = Array.isArray(requiredBinsRaw) ? requiredBinsRaw as string[] : (typeof requiredBinsRaw === "string" ? [requiredBinsRaw] : []);
  const hasEnvConfig = configKeys.some(k => /^[A-Z_]+$/.test(k) && k !== "_");

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
            {refreshing ? "Scanning..." : "Scan"}
          </button>
        </div>
        <div style={styles.sidebarList}>
          {skills.length === 0 ? (
            <div style={{ padding: "20px 14px", color: "var(--text-muted)", fontSize: "12px" }}>
              暂无已注册技能。点击 Scan 扫描 skills/ 文件夹。
            </div>
          ) : (
            skills.map((skill) => (
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
                <div style={styles.skillItemName}>{skill.emoji ? `${skill.emoji} ` : ""}{skill.name}</div>
                <div style={styles.skillItemDesc}>{skill.description ? skill.description.slice(0, 60) : "无描述"}</div>
                <div style={{ display: "flex", gap: "4px", alignItems: "center", marginTop: "4px" }}>
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
            ))
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

      {selected && selectedSkill ? (
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

          <div style={styles.detailHeader}>
            <div>
              <span style={styles.detailName}>{selectedSkill.emoji ? `${selectedSkill.emoji} ` : ""}{selectedSkill.name}</span>
              <span style={styles.detailVersion}>v{selectedSkill.version}</span>
            </div>
            <div style={styles.detailDesc}>{selectedSkill.description || "无描述"}</div>
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
            </div>
          </div>

          <div style={styles.banner}>
            <div>Skill 文件位置: <code style={{ color: "var(--section-title-color)" }}>{selectedSkill.installPath}</code></div>
            <div style={styles.bannerTip}>
              ZIP 文件请放入 skills/ 文件夹，系统每 30 秒自动扫描检测
            </div>
          </div>

          <div style={styles.sectionTitle}>基本信息</div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>作者</span>
            <span style={styles.infoValue}>{selectedSkill.author || "未知"}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>分类</span>
            <span style={styles.infoValue}>{selectedSkill.category}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>版本</span>
            <span style={styles.infoValue}>{selectedSkill.version}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>主页</span>
            <span style={styles.infoValue}>{selectedSkill.homepage ? (
              <a href={selectedSkill.homepage} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)" }}>{selectedSkill.homepage}</a>
            ) : "-"}</span>
          </div>
          {selectedSkill.license && (
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>许可证</span>
              <span style={styles.infoValue}>{selectedSkill.license}</span>
            </div>
          )}
          {selectedSkill.keywords.length > 0 && (
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>关键词</span>
              <span style={styles.infoValue}>
                {selectedSkill.keywords.map((k, i) => (
                  <span key={i} style={styles.triggerChip}>{k}</span>
                ))}
              </span>
            </div>
          )}

          <div style={styles.sectionTitle}>触发条件</div>
          {selectedSkill.triggers.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>无特定触发条件</div>
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

          <div style={styles.sectionTitle}>可用性状态</div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>健康检查</span>
            <span style={{
              ...styles.infoValue,
              color: selectedSkill.lifecycle.healthCheck?.healthy ? "var(--success)" : "var(--error)",
            }}>
              {selectedSkill.lifecycle.healthCheck?.healthy ? "健康" : "异常"}
            </span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>上次检查</span>
            <span style={styles.infoValue}>
              {selectedSkill.lifecycle.healthCheck?.lastCheck || "未检查"}
            </span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>调用次数</span>
            <span style={styles.infoValue}>{selectedSkill.stats.invocationCount}</span>
          </div>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>成功率</span>
            <span style={styles.infoValue}>
              {selectedSkill.stats.invocationCount > 0
                ? `${Math.round((selectedSkill.stats.successCount / selectedSkill.stats.invocationCount) * 100)}%`
                : "N/A"}
            </span>
          </div>

          {(selectedSkill.lifecycle.healthCheck?.errors?.length ?? 0) > 0 && (
            <>
              <div style={{ color: "var(--error)", fontSize: "12px", marginTop: "8px", fontWeight: "bold" }}>
                错误详情
              </div>
              {selectedSkill.lifecycle.healthCheck?.errors.map((e, i) => (
                <div key={i} style={{ color: "var(--error)", fontSize: "11px", marginTop: "2px" }}>
                  {e}
                </div>
              ))}
            </>
          )}

          <div style={styles.sectionTitle}>依赖项</div>
          {selectedSkill.requires.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>无依赖</div>
          ) : (
            selectedSkill.requires.map((d, i) => (
              <div key={i} style={styles.infoRow}>
                <span style={styles.infoLabel}>{d.name}</span>
                <span style={styles.infoValue}>
                  {d.version} {d.optional ? "(可选)" : "(必需)"}
                </span>
              </div>
            ))
          )}

          <div style={styles.sectionTitle}>使用方法</div>
          {selectedSkill.body.instructions ? (
            <div style={styles.instructionsBlock}>
              {selectedSkill.body.instructions}
            </div>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" }}>
              该技能未提供详细使用说明。
            </div>
          )}

          {selectedSkill.body.examples.length > 0 && (
            <>
              <div style={styles.sectionTitle}>使用示例</div>
              <div style={styles.examplesBlock}>
                {selectedSkill.body.examples.map((ex, i) => (
                  <div key={i} style={styles.exampleItem}>{ex}</div>
                ))}
              </div>
            </>
          )}

          {configKeys.length > 0 && (
            <>
              <div style={styles.sectionTitle}>
                技能配置
                {hasEnvConfig && <span style={{ fontSize: "10px", color: "var(--warning)", marginLeft: "8px" }}>需要设置</span>}
              </div>
              {primaryEnv && (
                <div style={{ ...styles.configNoConfig, color: "var(--warning)", marginBottom: "8px", textAlign: "left" }}>
                  <span style={{ fontWeight: "bold" }}>{primaryEnv}</span> 为必需配置项。请填入你的 API 密钥。
                </div>
              )}
              {requiredBins.length > 0 && (
                <div style={{ ...styles.configNoConfig, color: "var(--success)", marginBottom: "8px", textAlign: "left" }}>
                  需要系统工具: {requiredBins.join(", ")}
                </div>
              )}
              <div style={styles.configForm}>
                {configKeys.map((key) => (
                  <div key={key} style={styles.configRow}>
                    <span style={styles.configLabel}>
                      {key}
                      {key === primaryEnv ? <span style={{ color: "var(--warning)", marginLeft: "4px" }}>*</span> : null}
                    </span>
                    <input
                      style={{
                        ...styles.configInput,
                        ...(key === primaryEnv && !configValues[key] ? { borderColor: "var(--warning)" } : {}),
                      }}
                      type={key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token") ? "password" : "text"}
                      value={configValues[key] || ""}
                      onChange={(e) =>
                        setConfigValues((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder={`设置 ${key}...`}
                    />
                  </div>
                ))}
                <button style={styles.saveButton} onClick={handleSaveConfig}>
                  {hasEnvConfig ? "保存并激活技能" : "保存配置"}
                </button>
              </div>
            </>
          )}

          {configKeys.length === 0 && (
            <>
              <div style={styles.sectionTitle}>技能配置</div>
              <div style={styles.configNoConfig}>
                该技能无需额外配置。
              </div>
            </>
          )}
        </div>
      ) : (
        <div style={styles.placeholder}>
          {skills.length === 0
            ? "暂无已注册技能。将 .SKILL.md 文件放入 skills/ 文件夹即可自动发现。"
            : "请从左侧选择一个技能查看详情。"}
        </div>
      )}
    </div>
  );
}