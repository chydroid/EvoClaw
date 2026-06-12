import { useState, useEffect } from "react";

const API = (window as any).__EVOCLAW_API__ || "";

export default function ObservabilityPage() {
  const [traces, setTraces] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/api/observability/traces`)
      .then(r => r.json())
      .then(data => { setTraces(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2>🔍 Observability</h2>
      <p style={{ color: "#888" }}>Full-chain tracing and metrics for agent execution</p>

      {loading ? <p>Loading...</p> : (
        <div>
          <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
            <StatCard label="Active Traces" value={traces.length} color="#3b82f6" />
            <StatCard label="Total Spans" value={traces.reduce((sum, t) => sum + (t.spans?.length || 0), 0)} color="#10b981" />
            <StatCard label="Errors" value={traces.filter(t => t.status === "error").length} color="#ef4444" />
          </div>

          {traces.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#888", background: "#1a1a2e", borderRadius: 8 }}>
              No active traces. Traces will appear when the agent processes requests.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {traces.map((trace: any) => (
                <div key={trace.traceId} style={{ background: "#1a1a2e", borderRadius: 8, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 13 }}>{trace.traceId}</span>
                    <span style={{
                      padding: "2px 8px", borderRadius: 4, fontSize: 12,
                      background: trace.status === "ok" ? "#064e3b" : trace.status === "error" ? "#7f1d1d" : "#44403c",
                      color: trace.status === "ok" ? "#6ee7b7" : trace.status === "error" ? "#fca5a5" : "#a8a29e"
                    }}>
                      {trace.status || "active"}
                    </span>
                  </div>
                  <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
                    Session: {trace.sessionId} · Spans: {trace.spans?.length || 0}
                    {trace.startTime && ` · Started: ${new Date(trace.startTime).toLocaleTimeString()}`}
                  </div>
                  {trace.spans?.length > 0 && (
                    <div style={{ marginTop: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {trace.spans.map((span: any) => (
                        <span key={span.spanId} style={{
                          padding: "2px 6px", borderRadius: 3, fontSize: 11,
                          background: span.kind === "tool" ? "#1e3a5f" : span.kind === "llm" ? "#3b1e5f" : "#2d3748",
                          color: "#cbd5e0"
                        }}>
                          {span.kind}: {span.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: "#1a1a2e", borderRadius: 8, padding: 16, minWidth: 140 }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{label}</div>
    </div>
  );
}
