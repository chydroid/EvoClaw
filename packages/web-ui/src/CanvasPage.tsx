import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "./i18n";

interface CompactionSummary {
  id: string;
  parentSessionId: string;
  successorSessionId: string;
  summary: string;
  keyFacts: string[];
  decisions: string[];
  pendingItems: string[];
  compactedTurnCount: number;
  timestamp: string;
}

interface EvolutionStats {
  totalCycles: number;
  successRate: number;
  totalCandidates: number;
}

function canvasProgressFillStyle(pct: number, color: string): React.CSSProperties {
  return {
    height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, borderRadius: "3px",
    background: color, transition: "width 0.5s",
  };
}

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { marginBottom: "24px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px", marginBottom: "24px" },
  card: { background: "var(--bg-card)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-light)" },
  cardTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" },
  cardIcon: { fontSize: "20px" },
  metricRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" },
  metricLabel: { color: "var(--text-muted)", fontSize: "12px" },
  metricValue: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold" },
  metricLarge: { color: "var(--accent)", fontSize: "32px", fontWeight: "bold" },
  metricUnit: { color: "var(--text-muted)", fontSize: "12px", marginLeft: "4px" },
  timeline: { position: "relative" as const, paddingLeft: "24px", marginTop: "8px" },
  timelineItem: { position: "relative" as const, paddingBottom: "16px", borderLeft: "2px solid var(--border-light)", paddingLeft: "16px" },
  timelineDot: {
    position: "absolute" as const, left: "-7px", top: "2px", width: "12px", height: "12px", borderRadius: "50%",
    background: "var(--accent)", border: "2px solid var(--bg-card)",
  },
  timelineTitle: { color: "var(--text-primary)", fontSize: "13px", fontWeight: "bold" },
  timelineDesc: { color: "var(--text-secondary)", fontSize: "11px", marginTop: "2px" },
  timelineTime: { color: "var(--text-muted)", fontSize: "10px", marginTop: "2px" },
  factTag: {
    display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
    background: "var(--accent-bg)", color: "var(--accent)", margin: "2px 4px 2px 0",
  },
  pendingTag: {
    display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
    background: "var(--warning-bg)", color: "var(--warning)", margin: "2px 4px 2px 0",
  },
  decisionTag: {
    display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
    background: "var(--success-bg)", color: "var(--success)", margin: "2px 4px 2px 0",
  },
  progressBar: { height: "6px", borderRadius: "3px", background: "var(--bg-hover)", marginTop: "8px", overflow: "hidden" },
  empty: { color: "var(--text-muted)", fontSize: "13px", padding: "20px", textAlign: "center" as const },
  link: { color: "var(--accent)", fontSize: "12px", cursor: "pointer", textDecoration: "underline" },
};

export function CanvasPage() {
  const { t, lang } = useTranslation();
  const [compactions, setCompactions] = useState<CompactionSummary[]>([]);
  const [evolution, setEvolution] = useState<EvolutionStats | null>(null);
  const [learning, setLearning] = useState<{ totalEntries: number; resolvedEntries: number; unresolvedEntries: number; resolutionRate: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [compRes, evoRes, learnRes] = await Promise.all([
        fetch("/api/compactions/web-ui"),
        fetch("/api/evolution/dashboard"),
        fetch("/api/evolution/learning/stats"),
      ]);

      if (compRes.ok) {
        const c = await compRes.json();
        setCompactions(c.compactions || []);
      }
      if (evoRes.ok) {
        const e = await evoRes.json();
        setEvolution(e.summary || null);
      }
      if (learnRes.ok) {
        setLearning(await learnRes.json());
      }
    } catch {
      // APIs may not be available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <div style={s.container}><div style={{ color: "var(--text-muted)" }}>{t("canvas.loading")}</div></div>;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div style={s.title}>{t("canvas.global_overview")}</div>
        <div style={s.subtitle}>{t("canvas.global_desc")}</div>
      </div>

      <div style={s.grid}>
        {/* Evolution Stats */}
        <div style={s.card}>
          <div style={s.cardTitle}>
            <span style={s.cardIcon}>📈</span> {t("canvas.evo_stats")}
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>{t("canvas.evo_cycles")}</span>
            <span>
              <span style={s.metricLarge}>{evolution?.totalCycles || 0}</span>
              <span style={s.metricUnit}>{lang === "zh" ? t("canvas.cycles_unit") : ""}</span>
            </span>
          </div>
          <div style={s.progressBar}>
            <div style={canvasProgressFillStyle((evolution?.successRate || 0) * 100, "var(--success)")} />
          </div>
          <div style={{ ...s.metricRow, marginTop: "8px" }}>
            <span style={s.metricLabel}>{t("canvas.success_rate")}</span>
            <span style={s.metricValue}>{evolution ? `${Math.round(evolution.successRate * 100)}%` : "N/A"}</span>
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>{t("canvas.total_candidates")}</span>
            <span style={s.metricValue}>{evolution?.totalCandidates || 0}</span>
          </div>
        </div>

        {/* Learning Stats */}
        <div style={s.card}>
          <div style={s.cardTitle}>
            <span style={s.cardIcon}>📚</span> {t("canvas.learning_stats")}
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>{t("canvas.learning_entries")}</span>
            <span>
              <span style={s.metricLarge}>{learning?.totalEntries || 0}</span>
              <span style={s.metricUnit}>{lang === "zh" ? t("canvas.entries_unit") : ""}</span>
            </span>
          </div>
          <div style={s.progressBar}>
            <div style={canvasProgressFillStyle((learning?.resolutionRate || 0) * 100, "var(--accent)")} />
          </div>
          <div style={{ ...s.metricRow, marginTop: "8px" }}>
            <span style={s.metricLabel}>{t("canvas.resolution_rate")}</span>
            <span style={s.metricValue}>{learning ? `${Math.round(learning.resolutionRate * 100)}%` : "N/A"}</span>
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>{t("canvas.resolved_unresolved")}</span>
            <span style={s.metricValue}>
              <span style={{ color: "var(--success)" }}>{learning?.resolvedEntries || 0}</span>
              {" / "}
              <span style={{ color: "var(--warning)" }}>{learning?.unresolvedEntries || 0}</span>
            </span>
          </div>
        </div>

        {/* Compaction chain */}
        <div style={{ ...s.card, gridColumn: compactions.length > 0 ? "1 / -1" : undefined }}>
          <div style={s.cardTitle}>
            <span style={s.cardIcon}>🔄</span> {t("canvas.compaction_chain")}
          </div>
          {compactions.length === 0 ? (
            <div style={s.empty}>{t("canvas.no_compactions")}</div>
          ) : (
            <div style={s.timeline}>
              {compactions.map((comp, i) => (
                <div key={comp.id} style={s.timelineItem}>
                  <div style={s.timelineDot} />
                  <div style={s.timelineTitle}>
                    {t("canvas.compression_num")}{i + 1}: {comp.parentSessionId} → {comp.successorSessionId}
                  </div>
                  <div style={s.timelineDesc}>{comp.summary.slice(0, 200)}</div>
                  <div style={s.timelineTime}>
                    {new Date(comp.timestamp).toLocaleString()} · {t("canvas.compressed_turns").replace("{0}", String(comp.compactedTurnCount))}
                  </div>
                  {comp.keyFacts.length > 0 && (
                    <div style={{ marginTop: "6px" }}>
                      {comp.keyFacts.slice(0, 5).map((fact, fi) => (
                        <span key={fi} style={s.factTag}>{fact.slice(0, 40)}</span>
                      ))}
                    </div>
                  )}
                  {comp.decisions.length > 0 && (
                    <div style={{ marginTop: "4px" }}>
                      {comp.decisions.slice(0, 3).map((d, di) => (
                        <span key={di} style={s.decisionTag}>{d.slice(0, 40)}</span>
                      ))}
                    </div>
                  )}
                  {comp.pendingItems.length > 0 && (
                    <div style={{ marginTop: "4px" }}>
                      {comp.pendingItems.slice(0, 3).map((p, pi) => (
                        <span key={pi} style={s.pendingTag}>{p.slice(0, 40)}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ color: "var(--text-muted)", fontSize: "10px", textAlign: "center" as const, marginTop: "24px" }}>
        {t("canvas.footer")}
      </div>
    </div>
  );
}