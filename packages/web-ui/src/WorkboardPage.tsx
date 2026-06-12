import { useState, useEffect } from "react";

const API = (window as any).__EVOCLAW_API__ || "";

const COLUMNS = [
  { id: "backlog", name: "Backlog", color: "#6b7280" },
  { id: "todo", name: "To Do", color: "#3b82f6" },
  { id: "in_progress", name: "In Progress", color: "#f59e0b" },
  { id: "review", name: "Review", color: "#8b5cf6" },
  { id: "done", name: "Done", color: "#10b981" },
];

export default function WorkboardPage() {
  const [boardData, setBoardData] = useState<any>({ tasks: {}, stats: null });
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    fetch(`${API}/api/workboard`)
      .then(r => r.json())
      .then(data => { setBoardData(data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const createTask = async () => {
    const title = prompt("Task title:");
    if (!title) return;
    const description = prompt("Description:") || "";
    await fetch(`${API}/api/workboard/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, priority: "normal", tags: [], status: "todo" }),
    });
    refresh();
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>📋 Workboard</h2>
          <p style={{ color: "#888", margin: "4px 0 0 0" }}>Multi-agent task board for coordinated orchestration</p>
        </div>
        <button onClick={createTask} style={{ padding: "8px 16px", borderRadius: 6, background: "#3b82f6", color: "#fff", border: "none", cursor: "pointer" }}>
          + New Task
        </button>
      </div>

      {loading ? <p>Loading...</p> : (
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 16 }}>
          {COLUMNS.map(col => {
            const tasks = boardData.tasks?.[col.id] || [];
            return (
              <div key={col.id} style={{ minWidth: 240, flex: "0 0 240px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: col.color }} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{col.name}</span>
                  <span style={{ fontSize: 11, color: "#888", background: "#2d3748", padding: "1px 6px", borderRadius: 8 }}>{tasks.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {tasks.length === 0 ? (
                    <div style={{ padding: 16, textAlign: "center", color: "#555", background: "#1a1a2e", borderRadius: 6, fontSize: 12 }}>
                      No tasks
                    </div>
                  ) : tasks.map((task: any) => (
                    <div key={task.id} style={{ background: "#1a1a2e", borderRadius: 6, padding: 12 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{task.title}</div>
                      {task.description && <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{task.description.slice(0, 80)}</div>}
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {task.assignee && <span style={{ fontSize: 10, background: "#2d3748", padding: "1px 6px", borderRadius: 4 }}>👤 {task.assignee}</span>}
                        {task.priority === "high" && <span style={{ fontSize: 10, background: "#7f1d1d", padding: "1px 6px", borderRadius: 4, color: "#fca5a5" }}>high</span>}
                        {task.priority === "critical" && <span style={{ fontSize: 10, background: "#7f1d1d", padding: "1px 6px", borderRadius: 4, color: "#fca5a5" }}>critical</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {boardData.stats && (
        <div style={{ marginTop: 16, display: "flex", gap: 16 }}>
          <StatCard label="Total Tasks" value={boardData.stats.totalTasks} />
          <StatCard label="Active Runs" value={boardData.stats.activeRuns} />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: "#1a1a2e", borderRadius: 8, padding: 12, minWidth: 120 }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#888" }}>{label}</div>
    </div>
  );
}
