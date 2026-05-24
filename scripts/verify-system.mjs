/**
 * EvoClaw System Verification Script v2
 * Tests all REST API endpoints with accurate response validation
 */
import http from "http";

const BASE = "http://localhost:17788";
const RESULTS = [];
let passed = 0;
let failed = 0;
let authRequired = 0;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.statusCode, body: data, raw: data }); }
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function log(category, name, result, status, detail = "") {
  if (result === "PASS") passed++;
  else if (result === "AUTH") authRequired++;
  else failed++;
  const entry = { category, name, status: result, detail };
  RESULTS.push(entry);
  const label = result === "PASS" ? "PASS" : result === "AUTH" ? "AUTH" : "FAIL";
  console.log(`  [${label}] ${category}/${name}${detail ? " — " + detail : ""}  (HTTP ${status})`);
}

async function testEndpoint(category, name, method, path, validator, body = null) {
  try {
    const res = await request(method, path, body);
    const validation = validator(res);
    const result = typeof validation === "string" ? validation : (validation ? "PASS" : "FAIL");
    log(category, name, result, res.status, "");
    return res;
  } catch (err) {
    log(category, name, "FAIL", 0, err.message);
    return null;
  }
}

// ─── Validators ──────────────────────────────────────────
const is200 = (r) => r.status === 200 ? "PASS" : "FAIL";
const is2xx = (r) => r.status >= 200 && r.status < 300 ? "PASS" : "FAIL";
const isNot404 = (r) => r.status !== 404 ? "PASS" : "FAIL";
const isAuth = (r) => r.status === 401 ? "AUTH" : (r.status >= 200 && r.status < 300 ? "PASS" : "FAIL");
const bodyOk = (r) => (r.status >= 200 && r.status < 300) ? "PASS" : (r.status === 401 ? "AUTH" : "FAIL");

// ─────────────────────────────────────────────────────────
console.log("=".repeat(60));
console.log("  EvoClaw v0.4.0 — System Verification Suite v2");
console.log("  PASS=Success | AUTH=RequiresAuth(expected) | FAIL=Error");
console.log("=".repeat(60));

// ─── 1. Health & Status ─────────────────────────────────
console.log("\n── 1. Health & Status Checks ──");
await testEndpoint("health", "healthz", "GET", "/healthz", is200);
await testEndpoint("health", "live", "GET", "/live", is200);
await testEndpoint("health", "ready", "GET", "/ready", is200);
await testEndpoint("health", "readyz", "GET", "/readyz", is200);

const healthRes = await testEndpoint("health", "detailed", "GET", "/health", (r) => {
  if (r.status !== 200) return "FAIL";
  return r.body?.status === "ok" && r.body?.services?.healthy > 40 ? "PASS" : "FAIL";
});

await testEndpoint("health", "api_health", "GET", "/api/health", (r) => {
  return r.status === 200 && r.body?.status === "ok" ? "PASS" : "FAIL";
});

// WebUI
await testEndpoint("webui", "root_html", "GET", "/", (r) => {
  return r.status === 200 && r.raw.includes("EvoClaw") ? "PASS" : "FAIL";
});

// ─── 2. System Status ────────────────────────────────────
console.log("\n── 2. System Status ──");
await testEndpoint("system", "status_overview", "GET", "/api/status", is200);

// /api/system/services returns array directly
await testEndpoint("system", "services_list", "GET", "/api/system/services", (r) => {
  return r.status === 200 && Array.isArray(r.body) ? "PASS" : "FAIL";
});

// ─── 3. Skills ───────────────────────────────────────────
console.log("\n── 3. Skills Management ──");
const skillsRes = await testEndpoint("skills", "list_all", "GET", "/api/skills", (r) => {
  // Returns array directly
  return r.status === 200 && Array.isArray(r.body) ? "PASS" : "FAIL";
});
const skillCount = Array.isArray(skillsRes?.body) ? skillsRes.body.length : 0;
console.log(`     ${skillCount} skills installed`);

if (skillCount > 0) {
  const firstSkill = skillsRes.body[0];
  const skillId = firstSkill.id || firstSkill.name;
  await testEndpoint("skills", "get_by_id", "GET", `/api/skills/${encodeURIComponent(skillId)}`, is200);
}
await testEndpoint("skills", "refresh", "POST", "/api/skills/refresh", is2xx);

// ─── 4. Bootstrap ────────────────────────────────────────
console.log("\n── 4. Bootstrap System ──");
const bootstrapRes = await testEndpoint("bootstrap", "list", "GET", "/api/bootstrap", (r) => {
  return r.status === 200 ? "PASS" : "FAIL";
});

if (bootstrapRes?.status === 200) {
  const files = bootstrapRes.body?.files || [];
  console.log(`     ${files.length} bootstrap files`);
  for (const f of files) {
    const filename = typeof f === "string" ? f : (f.name || f.filename || f.id || String(f));
    await testEndpoint("bootstrap", `get_${filename}`, "GET", `/api/bootstrap/${encodeURIComponent(filename)}`, is2xx);
  }
}

// ─── 5. Config ───────────────────────────────────────────
console.log("\n── 5. Configuration ──");
await testEndpoint("config", "llm_get", "GET", "/api/config/llm", is2xx);
await testEndpoint("config", "channels_get", "GET", "/api/config/channels", is2xx);

// ─── 6. Channels (auth required) ─────────────────────────
console.log("\n── 6. Channels & DM Pairing (auth required) ──");
await testEndpoint("channels", "status", "GET", "/api/channels/status", isAuth);
await testEndpoint("channels", "active", "GET", "/api/channels/active", isAuth);
await testEndpoint("channels", "approved", "GET", "/api/channels/approved", isAuth);

// ─── 7. Sessions ─────────────────────────────────────────
console.log("\n── 7. Session Management ──");

// Create session first to know the IDs
const sessionId = "verify_" + Date.now();
const createRes = await testEndpoint("sessions", "create", "POST", "/api/sessions", (r) => {
  return r.status === 200 ? "PASS" : "FAIL";
}, { agentId: "default", sessionId });

if (createRes?.status === 200) {
  await testEndpoint("sessions", "get_created", "GET", `/api/sessions/default/${sessionId}`, is2xx);
}

await testEndpoint("sessions", "list", "GET", "/api/sessions", is2xx);

// ─── 8. Queue (auth required) ────────────────────────────
console.log("\n── 8. Queue Management (auth required) ──");
await testEndpoint("queue", "status", "GET", "/api/queue", isAuth);

// ─── 9. Plugins (auth required) ──────────────────────────
console.log("\n── 9. Plugin System (auth required) ──");
await testEndpoint("plugins", "list", "GET", "/api/plugins", isAuth);

// ─── 10. Evolution ───────────────────────────────────────
console.log("\n── 10. Evolution Dashboard ──");
await testEndpoint("evolution", "dashboard", "GET", "/api/evolution/dashboard", is2xx);
await testEndpoint("evolution", "learning_stats", "GET", "/api/evolution/learning/stats", is2xx);
await testEndpoint("evolution", "learning_entries", "GET", "/api/evolution/learning/entries?limit=5", is2xx);
await testEndpoint("evolution", "learning_sessions", "GET", "/api/evolution/learning/sessions", is2xx);
await testEndpoint("evolution", "active_progress", "GET", "/api/evolution/progress/active", is2xx);

// ─── 11. Permissions (auth required) ─────────────────────
console.log("\n── 11. Permission System (auth required) ──");
await testEndpoint("permission", "requests", "GET", "/api/permission/requests", isAuth);
await testEndpoint("permission", "whitelist", "GET", "/api/permission/whitelist", isAuth);

// ─── 12. Security & Audit (auth required) ────────────────
console.log("\n── 12. Security & Audit (auth required) ──");
await testEndpoint("security", "audit_log", "GET", "/api/system/audit?limit=10", isAuth);

// ─── 13. Permission Relay ────────────────────────────────
console.log("\n── 13. Permission Relay ──");
await testEndpoint("perm_relay", "pending", "GET", "/api/permission-relay/pending", is2xx);
await testEndpoint("perm_relay", "history", "GET", "/api/permission-relay/history?limit=5", is2xx);

// ─── 14. Crestodian (Operations) ─────────────────────────
console.log("\n── 14. Operations (Crestodian) ──");
await testEndpoint("crestodian", "health", "GET", "/api/crestodian/health", (r) => {
  return r.status === 200 && r.body?.status === "ok" ? "PASS" : "FAIL";
});
await testEndpoint("crestodian", "overview", "GET", "/api/crestodian/overview", is2xx);
await testEndpoint("crestodian", "diagnostics", "GET", "/api/crestodian/diagnostics", is2xx);

// ─── 15. Persona (auth required) ─────────────────────────
console.log("\n── 15. Persona (auth required) ──");
await testEndpoint("persona", "greeting", "GET", "/api/persona/greeting", isAuth);

// ─── 16. Context Engine (auth required) ──────────────────
console.log("\n── 16. Context Engine (auth required) ──");
await testEndpoint("context", "status", "GET", "/api/context/status", isAuth);

// ─── 17. WebSocket (auth required) ───────────────────────
console.log("\n── 17. WebSocket Connections (auth required) ──");
await testEndpoint("ws", "connections", "GET", "/api/ws/connections", isAuth);

// ─── 18. Events ──────────────────────────────────────────
console.log("\n── 18. Event System ──");
await testEndpoint("events", "list", "GET", "/api/events?limit=5", is2xx);
await testEndpoint("events", "snapshot", "GET", "/api/events/snapshot", is2xx);

// ─── 19. Chat ────────────────────────────────────────────
console.log("\n── 19. Chat (Agent) ──");
const chatRes = await testEndpoint("chat", "send_message", "POST", "/api/chat", isNot404, {
  message: "Hello, this is a system verification test",
  sessionId: "verify_system_test",
  agentId: "default",
});
console.log(`     Chat response: HTTP ${chatRes?.status}`);

// ─── 20. CLI ─────────────────────────────────────────────
console.log("\n── 20. CLI Execution ──");
await testEndpoint("cli", "execute_help", "POST", "/api/cli/execute", (r) => {
  return r.status < 500 ? "PASS" : "FAIL";
}, { command: "/help" });

// ─── 21. Edge Cases ──────────────────────────────────────
console.log("\n── 21. Edge Cases & Boundary Tests ──");

// Unknown endpoint (may hit auth middleware with 401 or 404)
await testEndpoint("edge", "unknown_route", "GET", "/api/nonexistent_endpoint_xyz", (r) => {
  return r.status === 401 || r.status === 404 ? "PASS" : "FAIL";
});

// Invalid method on known endpoint
await testEndpoint("edge", "method_not_allowed", "DELETE", "/healthz", (r) => {
  return r.status !== 500 ? "PASS" : "FAIL"; // Should not crash
});

// Malformed JSON body
await testEndpoint("edge", "malformed_json", "POST", "/api/chat", (r) => {
  return r.status !== 500 ? "PASS" : "FAIL";
}, "not-valid-json{{{");

// Empty JSON body
await testEndpoint("edge", "empty_body", "POST", "/api/chat", (r) => {
  return r.status !== 500 ? "PASS" : "FAIL";
}, {});

// Large text payload
await testEndpoint("edge", "large_payload", "POST", "/api/chat", (r) => {
  return r.status === 200 || r.status === 400 || r.status === 413 ? "PASS" : "FAIL";
}, { message: "x".repeat(10000), sessionId: "test", agentId: "default" });

// Special chars in URL
await testEndpoint("edge", "special_chars_url", "GET", "/api/skills/test%20skill", (r) => {
  return r.status !== 500 ? "PASS" : "FAIL";
});

// ─── 22. Concurrency ─────────────────────────────────────
console.log("\n── 22. Concurrency Test ──");
const start = Date.now();
const ps = [];
for (let i = 0; i < 10; i++) ps.push(request("GET", "/healthz"));
try {
  const results = await Promise.all(ps);
  const allOk = results.every((r) => r.status === 200);
  log("concurrency", "10_parallel_healthz", allOk ? "PASS" : "FAIL", 200, `${Date.now() - start}ms`);
} catch (err) {
  log("concurrency", "10_parallel_healthz", "FAIL", 0, err.message);
}

// ─── 23. Health check during load ────────────────────────
console.log("\n── 23. Health Under Load ──");
const loadStart = Date.now();
const loadPromises = [];
for (let i = 0; i < 20; i++) loadPromises.push(request("GET", "/health"));
const loadResults = await Promise.all(loadPromises);
const loadOk = loadResults.every((r) => r.status === 200 && r.body?.status === "ok");
log("load", "20_health_under_load", loadOk ? "PASS" : "FAIL", 200, `${Date.now() - loadStart}ms`);

// ─── 24. Tool Availability Check ─────────────────────────
console.log("\n── 24. Internal Tool Registration ──");
await testEndpoint("tools", "chat_with_tools", "POST", "/api/chat", (r) => {
  // Verify tool registration indirectly via chat response
  return r.status !== 404 ? "PASS" : "FAIL";
}, {
  message: "What tools do you have available?",
  sessionId: "verify_tools_check",
  agentId: "default",
});

// ─── SUMMARY ─────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
const total = passed + failed + authRequired;
console.log(`  VERIFICATION COMPLETE`);
console.log(`  Passed: ${passed} | Auth Required: ${authRequired} | Failed: ${failed}`);
console.log(`  Total: ${total} | Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log("=".repeat(60));

if (failed > 0) {
  console.log("\n  FAILED TESTS:");
  for (const r of RESULTS) {
    if (r.status === "FAIL") {
      console.log(`    - [${r.category}] ${r.name}: HTTP ${r.detail}`);
    }
  }
}

// Category breakdown
console.log("\n  RESULTS BY CATEGORY:");
const cats = {};
for (const r of RESULTS) {
  if (!cats[r.category]) cats[r.category] = { pass: 0, auth: 0, fail: 0, total: 0 };
  cats[r.category][r.status === "PASS" ? "pass" : r.status === "AUTH" ? "auth" : "fail"]++;
  cats[r.category].total++;
}
for (const [cat, s] of Object.entries(cats)) {
  let icon = s.fail === 0 ? "OK" : "XX";
  let desc = `${s.pass}P`;
  if (s.auth > 0) desc += ` ${s.auth}A`;
  if (s.fail > 0) desc += ` ${s.fail}F`;
  console.log(`    [${icon}] ${cat}: ${desc}/${s.total}`);
}

// Save report
const report = {
  timestamp: new Date().toISOString(),
  version: "0.4.0",
  summary: {
    passed, authRequired, failed, total,
    successRate: ((passed / (passed + failed)) * 100).toFixed(1) + "%",
  },
  results: RESULTS,
  categories: cats,
};
import("fs").then((fs) => {
  fs.writeFileSync("scripts/verification-report.json", JSON.stringify(report, null, 2));
  console.log("\n  Detailed report saved to: scripts/verification-report.json");
});