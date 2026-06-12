import { useState, useEffect } from "react";

const API = (window as any).__EVOCLAW_API__ || "";

export default function SteerPage() {
  const [sessionId, setSessionId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [priority, setPriority] = useState("normal");
  const [result, setResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSteer = async () => {
    if (!sessionId || !instruction) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, instruction, priority }),
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ accepted: false, message: err instanceof Error ? err.message : String(err) });
    }
    setSubmitting(false);
  };

  return (
    <div style={{ padding: 24 }}>
      <h2>🎮 Steer Command</h2>
      <p style={{ color: "#888" }}>Inject real-time instructions into a running agent session</p>

      <div style={{ background: "#1a1a2e", borderRadius: 8, padding: 20, marginTop: 16, maxWidth: 600 }}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 12, color: "#888", marginBottom: 4 }}>Session ID</label>
          <input
            value={sessionId}
            onChange={e => setSessionId(e.target.value)}
            placeholder="Enter session ID"
            style={{ width: "100%", padding: 8, borderRadius: 6, background: "#2d3748", border: "1px solid #444", color: "#fff", fontSize: 13 }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 12, color: "#888", marginBottom: 4 }}>Instruction</label>
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            placeholder="Enter real-time instruction to inject..."
            rows={3}
            style={{ width: "100%", padding: 8, borderRadius: 6, background: "#2d3748", border: "1px solid #444", color: "#fff", fontSize: 13, resize: "vertical" }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 12, color: "#888", marginBottom: 4 }}>Priority</label>
          <select
            value={priority}
            onChange={e => setPriority(e.target.value)}
            style={{ padding: 8, borderRadius: 6, background: "#2d3748", border: "1px solid #444", color: "#fff", fontSize: 13 }}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        <button
          onClick={handleSteer}
          disabled={submitting || !sessionId || !instruction}
          style={{
            padding: "10px 20px", borderRadius: 6, background: submitting ? "#555" : "#3b82f6",
            color: "#fff", border: "none", cursor: submitting ? "not-allowed" : "pointer", fontSize: 14
          }}
        >
          {submitting ? "Injecting..." : "Inject Instruction"}
        </button>
      </div>

      {result && (
        <div style={{ marginTop: 16, background: result.accepted ? "#064e3b" : "#7f1d1d", borderRadius: 8, padding: 16, maxWidth: 600 }}>
          <div style={{ fontWeight: 600 }}>{result.accepted ? "✅ Instruction Injected" : "❌ Injection Failed"}</div>
          {result.message && <div style={{ fontSize: 13, marginTop: 4 }}>{result.message}</div>}
          {result.pendingCount !== undefined && <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>Pending instructions: {result.pendingCount}</div>}
        </div>
      )}

      <div style={{ marginTop: 24, background: "#1a1a2e", borderRadius: 8, padding: 16, maxWidth: 600 }}>
        <h3 style={{ margin: "0 0 8px 0" }}>Categories</h3>
        {[
          { cat: "redirect", desc: "Change the agent's focus or direction", icon: "🔄" },
          { cat: "constraint", desc: "Add constraints or limitations", icon: "⚠️" },
          { cat: "emphasis", desc: "Emphasize a particular aspect", icon: "🔵" },
          { cat: "cancel", desc: "Cancel current operation", icon: "⛔" },
          { cat: "info", desc: "Provide additional information", icon: "ℹ️" },
        ].map(item => (
          <div key={item.cat} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
            <span>{item.icon}</span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{item.cat}</span>
            <span style={{ fontSize: 12, color: "#888" }}>— {item.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
