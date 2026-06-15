/**
 * MCPScannerPage — MCP Tool Poisoning Scanner.
 *
 * Uses real backend APIs (no mock data).
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton,
  StatsGrid, showToast, DataTable, Modal,
} from "./shared";
import type { BadgeVariant } from "./shared";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

type RiskLevel = "none" | "low" | "medium" | "high" | "critical";
type Status = "clean" | "flagged" | "blacklisted";
type TabId = "overview" | "tools" | "blacklist" | "audit";

interface MCPTool {
  id: string;
  name: string;
  server: string;
  riskLevel: RiskLevel;
  descriptionHash: string;
  description: string;
  lastScanned: string;
  status: Status;
  detectedPatterns: string[];
}

interface BlacklistEntry {
  id: string;
  pattern: string;
  reason: string;
  addedAt: string;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  toolName: string;
  server: string;
  riskLevel: RiskLevel;
  detectedPatterns: string[];
  action: string;
}

interface ScanThreat {
  type: string;
  description: string;
  severity: RiskLevel;
}

const RISK_VARIANT: Record<RiskLevel, BadgeVariant> = {
  none: "success", low: "default", medium: "warning", high: "error", critical: "error",
};

const STATUS_VARIANT: Record<Status, BadgeVariant> = {
  clean: "success", flagged: "warning", blacklisted: "error",
};

export default function MCPScannerPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);

  const [tools, setTools] = useState<MCPTool[]>([]);
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const [scanInput, setScanInput] = useState("");
  const [scanResult, setScanResult] = useState<{ riskLevel: RiskLevel; threats: ScanThreat[]; redacted: string } | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [showAddBlacklist, setShowAddBlacklist] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newReason, setNewReason] = useState("");
  const [viewTool, setViewTool] = useState<MCPTool | null>(null);
  const [removeTarget, setRemoveTarget] = useState<BlacklistEntry | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [toolsRes, blacklistRes, auditRes] = await Promise.all([
        fetch(`${API}/api/mcp-scanner/tools`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/mcp-scanner/blacklist`).then(r => r.json()).catch(() => null),
        fetch(`${API}/api/mcp-scanner/audit?limit=50`).then(r => r.json()).catch(() => null),
      ]);

      const toolList: MCPTool[] = (toolsRes?.tools || toolsRes || []) as any[];
      setTools(toolList);

      const blList: BlacklistEntry[] = (blacklistRes?.entries || blacklistRes?.blacklist || blacklistRes || []) as any[];
      setBlacklist(blList);

      const auditList: AuditEntry[] = (auditRes?.entries || auditRes?.audit || auditRes || []) as any[];
      setAudit(auditList);
    } catch {
      // Keep empty state
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAddBlacklist = async () => {
    if (!newPattern.trim()) return;
    try {
      await fetch(`${API}/api/mcp-scanner/blacklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: newPattern.trim(), reason: newReason.trim() }),
      });
    } catch { /* ignore */ }
    setBlacklist(prev => [...prev, {
      id: `bl-${Date.now()}`, pattern: newPattern.trim(),
      reason: newReason.trim(), addedAt: new Date().toISOString(),
    }]);
    setShowAddBlacklist(false);
    setNewPattern("");
    setNewReason("");
    showToast(t("mcpScanner.addSuccess"), "success");
  };

  const handleRemoveBlacklist = async (entry: BlacklistEntry) => {
    try {
      await fetch(`${API}/api/mcp-scanner/blacklist/${entry.id}`, { method: "DELETE" });
    } catch { /* ignore */ }
    setBlacklist(prev => prev.filter(b => b.id !== entry.id));
    setRemoveTarget(null);
    showToast(t("mcpScanner.removeSuccess"), "success");
  };

  const handleScan = async () => {
    if (!scanInput.trim()) return;
    setScanLoading(true);
    setScanResult(null);
    try {
      const res = await fetch(`${API}/api/mcp-scanner/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: scanInput }),
      });
      const data = await res.json();
      setScanResult({
        riskLevel: data.riskLevel ?? data.risk ?? "none",
        threats: data.threats ?? data.detections ?? [],
        redacted: data.redacted ?? scanInput,
      });
    } catch {
      setScanResult({ riskLevel: "none", threats: [], redacted: scanInput });
    }
    setScanLoading(false);
  };

  if (loading) return <Loading />;

  const tabs: { id: TabId; key: string }[] = [
    { id: "overview", key: "mcpScanner.tabs.overview" },
    { id: "tools", key: "mcpScanner.tabs.tools" },
    { id: "blacklist", key: "mcpScanner.tabs.blacklist" },
    { id: "audit", key: "mcpScanner.tabs.audit" },
  ];

  // Compute stats
  const cleanCount = tools.filter(t => t.status === "clean").length;
  const flaggedCount = tools.filter(t => t.status === "flagged").length;
  const blacklistedCount = tools.filter(t => t.status === "blacklisted").length;
  const riskDist: Record<RiskLevel, number> = { none: 0, low: 0, medium: 0, high: 0, critical: 0 };
  tools.forEach(t => { riskDist[t.riskLevel] = (riskDist[t.riskLevel] || 0) + 1; });

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader
        title={t("mcpScanner.title")}
        subtitle={t("mcpScanner.subtitle")}
        actions={<SecondaryButton small onClick={loadData}>↻</SecondaryButton>}
      />

      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            style={{
              padding: "8px 16px", border: "none", borderRadius: 6, cursor: "pointer",
              background: tab === tb.id ? "var(--accent)" : "transparent",
              color: tab === tb.id ? "#fff" : "var(--text-muted)", fontWeight: 600, fontSize: 13,
            }}>
            {t(tb.key)}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === "overview" && (
        <div>
          <StatsGrid items={[
            { label: t("mcpScanner.stats.totalTools"), value: tools.length, color: "var(--accent)" },
            { label: t("mcpScanner.stats.clean"), value: cleanCount, color: "var(--success)" },
            { label: t("mcpScanner.stats.flagged"), value: flaggedCount, color: "var(--warning)" },
            { label: t("mcpScanner.stats.blacklisted"), value: blacklistedCount, color: "var(--error)" },
          ]} />

          {tools.length > 0 && (
            <Section title={t("mcpScanner.stats.riskDist")} style={{ marginTop: 24 }}>
              <Card>
                {(["critical", "high", "medium", "low", "none"] as RiskLevel[]).map(sev => {
                  const count = riskDist[sev] ?? 0;
                  const pct = tools.length > 0 ? (count / tools.length) * 100 : 0;
                  return (
                    <div key={sev} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <Badge variant={RISK_VARIANT[sev]}>{t(`mcpScanner.risk.${sev}`)}</Badge>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{count} ({pct.toFixed(1)}%)</span>
                      </div>
                      <div style={{ height: 6, background: "var(--bg-hover)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", borderRadius: 3 }} />
                      </div>
                    </div>
                  );
                })}
              </Card>
            </Section>
          )}

          <Section title={t("mcpScanner.scan.title")} style={{ marginTop: 20 }}>
            <Card>
              <textarea
                value={scanInput}
                onChange={e => setScanInput(e.target.value)}
                placeholder={t("mcpScanner.scan.placeholder")}
                rows={5}
                style={{
                  width: "100%", padding: "12px", borderRadius: 6,
                  background: "var(--bg-input)", border: "1px solid var(--border)",
                  color: "var(--text-primary)", fontSize: 13, fontFamily: "monospace",
                  resize: "vertical", outline: "none", boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryButton onClick={handleScan} disabled={scanLoading || !scanInput.trim()}>
                  {scanLoading ? "..." : t("mcpScanner.scan.button")}
                </PrimaryButton>
                <SecondaryButton onClick={() => { setScanInput(""); setScanResult(null); }}>×</SecondaryButton>
              </div>
            </Card>

            {scanResult && (
              <Card style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t("mcpScanner.scan.result")}</div>
                  <Badge variant={RISK_VARIANT[scanResult.riskLevel] || "default"}>{scanResult.riskLevel}</Badge>
                </div>
                {scanResult.threats.length === 0 ? (
                  <div style={{ color: "var(--success)", fontSize: 13 }}>✓ {t("mcpScanner.scan.noThreat")}</div>
                ) : (
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                      {t("mcpScanner.scan.threats").replace("{0}", String(scanResult.threats.length))}
                    </div>
                    {scanResult.threats.map((th, i) => (
                      <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--border-light)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Badge variant={RISK_VARIANT[th.severity] || "default"}>{th.severity}</Badge>
                          <code style={{ fontSize: 12, color: "var(--accent)" }}>{th.type}</code>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{th.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </Section>
        </div>
      )}

      {/* ── Tools Tab ── */}
      {tab === "tools" && (
        <Card>
          {tools.length === 0 ? (
            <EmptyState title={t("mcpScanner.empty.tools")} />
          ) : (
            <DataTable<MCPTool>
              columns={[
                { key: "name", label: t("mcpScanner.col.toolName"), render: t => (
                  <button onClick={() => setViewTool(t)}
                    style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, fontWeight: 500, padding: 0, textAlign: "left" }}>
                    {t.name}
                  </button>
                )},
                { key: "server", label: t("mcpScanner.col.server"), render: t => (
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.server}</code>
                )},
                { key: "riskLevel", label: t("mcpScanner.col.risk"), width: "90px", render: t => (
                  <Badge variant={RISK_VARIANT[t.riskLevel] || "default"}>{t.riskLevel}</Badge>
                )},
                { key: "descriptionHash", label: t("mcpScanner.col.hash"), render: t => (
                  <code style={{ fontSize: 10, color: "var(--text-muted)" }}>{t.descriptionHash?.slice(0, 12)}…</code>
                )},
                { key: "lastScanned", label: t("mcpScanner.col.scanned"), width: "150px", render: t => (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {t.lastScanned ? new Date(t.lastScanned).toLocaleString() : "—"}
                  </span>
                )},
                { key: "status", label: t("mcpScanner.col.status"), width: "100px", render: t => (
                  <Badge variant={STATUS_VARIANT[t.status] || "default"}>{t.status}</Badge>
                )},
              ]}
              data={tools}
              keyFn={t => t.id || t.name}
            />
          )}
        </Card>
      )}

      {/* ── Blacklist Tab ── */}
      {tab === "blacklist" && (
        <div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <PrimaryButton small onClick={() => setShowAddBlacklist(true)}>+ {t("mcpScanner.addPattern")}</PrimaryButton>
          </div>
          <Card>
            {blacklist.length === 0 ? (
              <EmptyState title={t("mcpScanner.empty.blacklist")} />
            ) : (
              <DataTable<BlacklistEntry>
                columns={[
                  { key: "pattern", label: t("mcpScanner.col.pattern"), render: b => (
                    <code style={{ fontSize: 12, color: "var(--accent)" }}>{b.pattern}</code>
                  )},
                  { key: "reason", label: t("mcpScanner.col.reason"), render: b => (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{b.reason}</span>
                  )},
                  { key: "addedAt", label: t("mcpScanner.col.addedAt"), width: "170px", render: b => (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {b.addedAt ? new Date(b.addedAt).toLocaleString() : "—"}
                    </span>
                  )},
                  { key: "actions", label: "", width: "60px", render: b => (
                    <button onClick={() => setRemoveTarget(b)}
                      style={{ background: "none", border: "none", color: "var(--error)", cursor: "pointer", fontSize: 14 }}>×</button>
                  )},
                ]}
                data={blacklist}
                keyFn={b => b.id}
              />
            )}
          </Card>
        </div>
      )}

      {/* ── Audit Tab ── */}
      {tab === "audit" && (
        <Card>
          {audit.length === 0 ? (
            <EmptyState title={t("mcpScanner.empty.audit")} />
          ) : (
            <DataTable<AuditEntry>
              columns={[
                { key: "timestamp", label: "Time", width: "170px", render: a => (
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {a.timestamp ? new Date(a.timestamp).toLocaleString() : ""}
                  </span>
                )},
                { key: "toolName", label: t("mcpScanner.col.toolName"), render: a => (
                  <span style={{ fontWeight: 500 }}>{a.toolName}</span>
                )},
                { key: "server", label: t("mcpScanner.col.server"), render: a => (
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{a.server}</code>
                )},
                { key: "riskLevel", label: t("mcpScanner.col.risk"), width: "90px", render: a => (
                  <Badge variant={RISK_VARIANT[a.riskLevel] || "default"}>{a.riskLevel}</Badge>
                )},
                { key: "detectedPatterns", label: t("mcpScanner.col.detected"), render: a => (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {(a.detectedPatterns || []).slice(0, 3).map((p, i) => (
                      <Badge key={i} variant="warning">{p}</Badge>
                    ))}
                  </div>
                )},
                { key: "action", label: t("mcpScanner.col.action"), render: a => a.action },
              ]}
              data={audit}
              keyFn={a => a.id}
            />
          )}
        </Card>
      )}

      {/* ── Add Blacklist Modal ── */}
      {showAddBlacklist && (
        <Modal
          title={t("mcpScanner.addPattern")}
          onClose={() => setShowAddBlacklist(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowAddBlacklist(false)}>{t("mcpScanner.cancel")}</SecondaryButton>
              <PrimaryButton onClick={handleAddBlacklist}>+</PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("mcpScanner.col.pattern")}</label>
              <input value={newPattern} onChange={e => setNewPattern(e.target.value)}
                placeholder="e.g. ignore previous instructions"
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>{t("mcpScanner.col.reason")}</label>
              <input value={newReason} onChange={e => setNewReason(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
        </Modal>
      )}

      {/* ── View Tool Modal ── */}
      {viewTool && (
        <Modal
          title={viewTool.name}
          onClose={() => setViewTool(null)}
          footer={
            <SecondaryButton onClick={() => setViewTool(null)}>×</SecondaryButton>
          }
        >
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            <div style={{ marginBottom: 8 }}><strong>{t("mcpScanner.col.server")}:</strong> <code>{viewTool.server}</code></div>
            <div style={{ marginBottom: 8 }}><strong>{t("mcpScanner.col.risk")}:</strong> <Badge variant={RISK_VARIANT[viewTool.riskLevel] || "default"}>{viewTool.riskLevel}</Badge></div>
            <div style={{ marginBottom: 8 }}><strong>{t("mcpScanner.col.status")}:</strong> <Badge variant={STATUS_VARIANT[viewTool.status] || "default"}>{viewTool.status}</Badge></div>
            <div style={{ marginBottom: 8 }}><strong>{t("mcpScanner.col.hash")}:</strong> <code>{viewTool.descriptionHash}</code></div>
            {viewTool.detectedPatterns && viewTool.detectedPatterns.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <strong>{t("mcpScanner.col.detected")}:</strong>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {viewTool.detectedPatterns.map((p, i) => <Badge key={i} variant="warning">{p}</Badge>)}
                </div>
              </div>
            )}
            <div>
              <strong>Description:</strong>
              <pre style={{ marginTop: 6, padding: 12, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {viewTool.description}
              </pre>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Remove Confirmation ── */}
      {removeTarget && (
        <Modal
          title={t("mcpScanner.removePattern")}
          onClose={() => setRemoveTarget(null)}
          footer={
            <>
              <SecondaryButton onClick={() => setRemoveTarget(null)}>{t("mcpScanner.cancel")}</SecondaryButton>
              <PrimaryButton onClick={() => handleRemoveBlacklist(removeTarget)}>✓</PrimaryButton>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
            {t("mcpScanner.confirmRemove")}
          </p>
          <code style={{ display: "block", marginTop: 8, padding: 8, background: "var(--bg-input)", borderRadius: 4, fontSize: 12 }}>
            {removeTarget.pattern}
          </code>
        </Modal>
      )}
    </div>
  );
}
