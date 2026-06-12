import { useState, useEffect } from "react";

const API = (window as any).__EVOCLAW_API__ || "";

export default function GuardrailsPage() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/api/guardrails/stats`)
      .then(r => r.json())
      .then(data => { setStats(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2>🛡️ Guardrails</h2>
      <p style={{ color: "#888" }}>Three-layer security gate: Input / Output / Tool validation</p>

      {loading ? <p>Loading...</p> : (
        <div>
          {!stats?.enabled ? (
            <div style={{ padding: 40, textAlign: "center", color: "#888", background: "#1a1a2e", borderRadius: 8 }}>
              Guardrails not enabled
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
                <StatCard label="Passed" value={stats.stats?.pass || 0} color="#10b981" />
                <StatCard label="Warnings" value={stats.stats?.warn || 0} color="#f59e0b" />
                <StatCard label="Blocked" value={stats.stats?.block || 0} color="#ef4444" />
              </div>

              <div style={{ background: "#1a1a2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <h3 style={{ margin: "0 0 12px 0" }}>Security Layers</h3>
                {[
                  { name: "Input Guardrail", desc: "Prompt injection, PII leakage, harmful content detection", icon: "📥" },
                  { name: "Output Guardrail", desc: "Hallucinated URLs, system prompt leak, PII in output", icon: "📤" },
                  { name: "Tool Guardrail", desc: "Dangerous args, data exfiltration, privilege escalation", icon: "🔧" },
                ].map(layer => (
                  <div key={layer.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #2d3748" }}>
                    <span style={{ fontSize: 20 }}>{layer.icon}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{layer.name}</div>
                      <div style={{ fontSize: 12, color: "#888" }}>{layer.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
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
