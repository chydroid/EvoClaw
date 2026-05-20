import React, { useState, useEffect, useCallback, useRef } from "react";

interface SkillInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  keywords: string[];
  homepage?: string;
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
    color: status === "active" ? "#22c55e" : status === "error" ? "#ef4444" : "#f59e0b",
    background: status === "active" ? "#0a2a1a" : status === "error" ? "#2a0a0a" : "#2a1a0a",
  };
}

function msgBannerStyle(type: "success" | "error"): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: "4px",
    marginBottom: "12px",
    fontSize: "12px",
    background: type === "success" ? "#0a2a1a" : "#2a0a0a",
    color: type === "success" ? "#22c55e" : "#ef4444",
  };
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    height: "100%",
    gap: 0,
    background: "#1e1e2e",
    borderRadius: "8px",
    overflow: "hidden",
  },
  sidebar: {
    width: "260px",
    minWidth: "180px",
    maxWidth: "500px",
    background: "#191929",
    borderRight: "1px solid #2d2d4a",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    position: "relative",
  },
  sidebarHeader: {
    padding: "12px 14px",
    borderBottom: "1px solid #2d2d4a",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sidebarTitle: {
    color: "#c4b5fd",
    fontWeight: "bold",
    fontSize: "14px",
  },
  refreshButton: {
    background: "#7c3aed",
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
    borderBottom: "1px solid #25253a",
    transition: "background 0.15s",
  },
  sidebarItemActive: {
    padding: "10px 14px",
    cursor: "pointer",
    borderBottom: "1px solid #25253a",
    background: "#2d2d4a",
    borderLeft: "3px solid #7c3aed",
    transition: "background 0.15s",
  },
  skillItemName: {
    color: "#e0e0f0",
    fontSize: "13px",
    fontWeight: "bold",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skillItemDesc: {
    color: "#8888aa",
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
    background: "#1e1e2e",
  },
  placeholder: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#666",
    fontSize: "14px",
    background: "#1e1e2e",
    padding: "20px",
  },
  detailHeader: {
    marginBottom: "16px",
  },
  detailName: {
    color: "#c4b5fd",
    fontSize: "20px",
    fontWeight: "bold",
  },
  detailVersion: {
    color: "#8888aa",
    fontSize: "12px",
    marginLeft: "8px",
  },
  detailDesc: {
    color: "#a0a0c0",
    fontSize: "13px",
    marginTop: "6px",
    lineHeight: "1.5",
  },
  sectionTitle: {
    color: "#c4b5fd",
    fontSize: "14px",
    fontWeight: "bold",
    marginTop: "20px",
    marginBottom: "8px",
    paddingBottom: "4px",
    borderBottom: "1px solid #2d2d4a",
  },
  infoRow: {
    display: "flex",
    padding: "4px 0",
    fontSize: "12px",
  },
  infoLabel: {
    color: "#8888aa",
    minWidth: "100px",
  },
  infoValue: {
    color: "#d0d0e0",
    wordBreak: "break-all",
  },
  instructionsBlock: {
    background: "#191929",
    borderRadius: "6px",
    padding: "12px 16px",
    color: "#c0c0d0",
    fontSize: "12px",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    marginTop: "8px",
    maxHeight: "200px",
    overflow: "auto",
    border: "1px solid #2d2d4a",
  },
  examplesBlock: {
    marginTop: "8px",
  },
  exampleItem: {
    background: "#191929",
    borderRadius: "6px",
    padding: "10px 14px",
    color: "#b0b0c0",
    fontSize: "12px",
    marginBottom: "6px",
    border: "1px solid #2d2d4a",
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
    color: "#a0a0c0",
    fontSize: "12px",
    minWidth: "120px",
  },
  configInput: {
    background: "#191929",
    border: "1px solid #3d3d5a",
    color: "#e0e0f0",
    padding: "6px 10px",
    borderRadius: "4px",
    fontSize: "12px",
    width: "300px",
  },
  configNoConfig: {
    color: "#666",
    fontSize: "12px",
    fontStyle: "italic",
  },
  saveButton: {
    background: "#7c3aed",
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
    background: "#202040",
    border: "1px solid #3d3d5a",
    padding: "12px 16px",
    borderRadius: "6px",
    marginBottom: "16px",
    fontSize: "12px",
    color: "#a0a0c0",
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
    color: "#8888aa",
    fontSize: "11px",
    marginTop: "4px",
  },
  triggerChip: {
    display: "inline-block",
    background: "#252545",
    color: "#a0a0d0",
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
      const res = await fetch(`/api/skills/${selectedId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: configValues }),
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
  const requiredBins = skillConfig._requiredBins as string[] | undefined;
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
            <div style={{ padding: "20px 14px", color: "#666", fontSize: "12px" }}>
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
                    (e.currentTarget as HTMLElement).style.background = "#25253a";
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedId !== skill.id) {
                    (e.currentTarget as HTMLElement).style.background = "";
                  }
                }}
              >
                <div style={styles.skillItemName}>{skill.name}</div>
                <div style={styles.skillItemDesc}>{skill.description.slice(0, 60)}</div>
                <span style={statusBadgeStyle(skill.lifecycle.status)}>
                  {skill.lifecycle.status}
                </span>
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
              <span style={styles.detailName}>{selectedSkill.name}</span>
              <span style={styles.detailVersion}>v{selectedSkill.version}</span>
            </div>
            <div style={styles.detailDesc}>{selectedSkill.description || "无描述"}</div>
            <div style={{ marginTop: "8px" }}>
              <span style={statusBadgeStyle(selectedSkill.lifecycle.status)}>
                {selectedSkill.lifecycle.status}
              </span>
            </div>
          </div>

          <div style={styles.banner}>
            <div>Skill 文件位置: <code style={{ color: "#c4b5fd" }}>{selectedSkill.installPath}</code></div>
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
            <span style={styles.infoValue}>{selectedSkill.homepage || "-"}</span>
          </div>
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
            <div style={{ color: "#666", fontSize: "12px" }}>无特定触发条件</div>
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
              color: selectedSkill.lifecycle.healthCheck?.healthy ? "#22c55e" : "#ef4444",
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
              <div style={{ color: "#ef4444", fontSize: "12px", marginTop: "8px", fontWeight: "bold" }}>
                健康检查错误:
              </div>
              {selectedSkill.lifecycle.healthCheck?.errors.map((e, i) => (
                <div key={i} style={{ color: "#f87171", fontSize: "11px", marginTop: "2px" }}>
                  {e}
                </div>
              ))}
            </>
          )}

          <div style={styles.sectionTitle}>依赖项</div>
          {selectedSkill.requires.length === 0 ? (
            <div style={{ color: "#666", fontSize: "12px" }}>无依赖</div>
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
            <div style={{ color: "#666", fontSize: "12px", marginTop: "4px" }}>
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
                {hasEnvConfig && <span style={{ fontSize: "10px", color: "#f59e0b", marginLeft: "8px" }}>需要设置</span>}
              </div>
              {primaryEnv && (
                <div style={{ ...styles.configNoConfig, color: "#f59e0b", marginBottom: "8px", textAlign: "left" }}>
                  <span style={{ fontWeight: "bold" }}>{primaryEnv}</span> 为必需配置项。请填入你的 API 密钥。
                </div>
              )}
              {requiredBins && requiredBins.length > 0 && (
                <div style={{ ...styles.configNoConfig, color: "#6ee7b7", marginBottom: "8px", textAlign: "left" }}>
                  需要系统工具: {requiredBins.join(", ")}
                </div>
              )}
              <div style={styles.configForm}>
                {configKeys.map((key) => (
                  <div key={key} style={styles.configRow}>
                    <span style={styles.configLabel}>
                      {key}
                      {key === primaryEnv ? <span style={{ color: "#f59e0b", marginLeft: "4px" }}>*</span> : null}
                    </span>
                    <input
                      style={{
                        ...styles.configInput,
                        borderColor: key === primaryEnv && !configValues[key] ? "#f59e0b" : styles.configInput.borderColor,
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