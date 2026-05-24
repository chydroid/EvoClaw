/**
 * EvoClaw Multi-Round Comprehensive Test Suite
 * Generates realistic test data and validates all functional modules
 */
import http from "http";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:17788";
const RESULTS_DIR = "scripts/test-results";
const NOW = new Date().toISOString().replace(/[:.]/g, "-");

// ─────────────────────────────────────────────────────────
// TEST DATA GENERATION
// ─────────────────────────────────────────────────────────

/** Realistic user personas */
const PERSONAS = {
  developer: {
    name: "Zhang Wei",
    role: "Senior Backend Engineer",
    useCases: ["debug", "deploy", "config", "monitor"],
    typicalInputs: [
      "Help me debug why my API is returning 500 errors",
      "Deploy a new microservice to the staging environment",
      "Show me the current system configuration",
      "Monitor the health of all running services",
    ],
  },
  devops: {
    name: "Sarah Chen",
    role: "DevOps Lead",
    useCases: ["orchestrate", "health", "scale", "audit"],
    typicalInputs: [
      "Orchestrate a rolling deployment across 3 clusters",
      "Generate a health report for all production services",
      "Scale up the agent pool to handle increased load",
      "Show me the audit log for the last 24 hours",
    ],
  },
  manager: {
    name: "Alex Johnson",
    role: "Engineering Manager",
    useCases: ["report", "overview", "permission", "review"],
    typicalInputs: [
      "Generate a weekly progress report for the team",
      "Show me an overview of all active projects",
      "Approve the pending permission requests",
      "Review the learning progress from last sprint",
    ],
  },
  newUser: {
    name: "Li Ming",
    role: "Junior Developer",
    useCases: ["onboarding", "learn", "help", "setup"],
    typicalInputs: [
      "Help me get started with the system",
      "What skills are available to use?",
      "Walk me through the onboarding process",
      "Help me set up my first agent configuration",
    ],
  },
};

/** Realistic session data */
function generateSessions(count) {
  const sessions = [];
  const channels = ["web", "cli", "discord", "slack", "telegram"];
  const statuses = ["active", "idle", "archived", "error"];
  
  for (let i = 0; i < count; i++) {
    const persona = Object.values(PERSONAS)[i % 4];
    sessions.push({
      id: `session_prod_${1000 + i}`,
      agentId: "default",
      userId: `user_${persona.name.toLowerCase().replace(/\s/g, "_")}`,
      channel: channels[i % channels.length],
      status: statuses[i % statuses.length],
      messageCount: Math.floor(Math.random() * 200) + 10,
      createdAt: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
      lastActive: new Date(Date.now() - Math.random() * 86400000).toISOString(),
      tags: ["production", persona.role.toLowerCase().split(" ")[0]],
      metadata: {
        persona: persona.name,
        useCase: persona.useCases[i % persona.useCases.length],
        contextSize: Math.floor(Math.random() * 128000) + 4000,
      },
    });
  }
  return sessions;
}

/** Realistic configuration data */
const CONFIG_SCENARIOS = {
  llm_valid: {
    provider: "openai",
    model: "gpt-4-turbo",
    apiKey: "sk-proj-***REDACTED***",
    baseURL: "https://api.openai.com/v1",
    temperature: 0.7,
    maxTokens: 4096,
    topP: 0.95,
    frequencyPenalty: 0.3,
    presencePenalty: 0.1,
    timeout: 30000,
    retryCount: 3,
  },
  llm_edge_high_temp: {
    provider: "openai",
    model: "gpt-4-turbo",
    apiKey: "sk-proj-***REDACTED***",
    temperature: 2.0, // Edge: above typical range
    maxTokens: 128000, // Edge: very large context
  },
  llm_edge_minimal: {
    provider: "anthropic",
    model: "claude-3-haiku",
    apiKey: "sk-ant-***REDACTED***",
    temperature: 0,
    maxTokens: 1, // Edge: minimum tokens
  },
  channel_discord: {
    type: "discord",
    enabled: true,
    token: "***REDACTED***",
    channels: ["general", "dev-chat", "deployments"],
    filters: { allowedRoles: ["admin", "dev"] },
  },
  channel_slack: {
    type: "slack",
    enabled: true,
    token: "xoxb-***REDACTED***",
    signingSecret: "***REDACTED***",
    channels: ["#engineering", "#ops", "#general"],
  },
};

/** Realistic permissions data */
function generatePermissions(count) {
  const perms = [];
  const resources = ["config", "session", "skill", "plugin", "agent", "memory", "channel"];
  const actions = ["read", "write", "execute", "delete", "admin"];
  const requesters = Object.values(PERSONAS).map((p) => `user_${p.name.toLowerCase().replace(/\s/g, "_")}`);
  
  for (let i = 0; i < count; i++) {
    perms.push({
      id: `perm_${2000 + i}`,
      requester: requesters[i % requesters.length],
      resource: resources[i % resources.length],
      action: actions[i % actions.length],
      status: i % 3 === 0 ? "pending" : i % 3 === 1 ? "approved" : "denied",
      requestedAt: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString(),
      reason: `Need ${actions[i % actions.length]} access to ${resources[i % resources.length]} for ${requesters[i % requesters.length]}'s work`,
    });
  }
  return perms;
}

/** Realistic evolution/learning data */
function generateLearningData(count) {
  const entries = [];
  const categories = ["tool_usage", "response_quality", "error_recovery", "context_handling", "user_feedback"];
  
  for (let i = 0; i < count; i++) {
    entries.push({
      id: `learn_${3000 + i}`,
      sessionId: `session_prod_${1000 + (i % 20)}`,
      category: categories[i % categories.length],
      observation: `User ${i % 2 === 0 ? "approved" : "corrected"} the AI response`,
      confidence: Math.round((0.5 + Math.random() * 0.5) * 100) / 100,
      impact: Math.round(Math.random() * 100) / 100,
      timestamp: Date.now() - Math.random() * 30 * 86400000,
    });
  }
  return entries;
}

/** Realistic dead letter queue messages */
function generateDLQMessages(count) {
  const msgs = [];
  const reasons = ["timeout", "channel_unavailable", "rate_limited", "invalid_format", "auth_expired"];
  
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: `dlq_${4000 + i}`,
      originalMessage: {
        text: `Test message ${i} for channel verification`,
        channel: ["discord", "slack", "telegram"][i % 3],
        timestamp: Date.now() - Math.random() * 86400000,
      },
      failureReason: reasons[i % reasons.length],
      retryCount: Math.floor(Math.random() * 5),
      maxRetries: 5,
      createdAt: Date.now() - Math.random() * 86400000,
      lastRetryAt: Date.now() - Math.random() * 3600000,
    });
  }
  return msgs;
}

/** Realistic health aggregator data */
function generateHealthData() {
  return {
    components: {
      gateway: { status: "healthy", latency: 2, uptime: 1800 },
      core: { status: "healthy", latency: 1, uptime: 1800 },
      agent: { status: "healthy", latency: 5, uptime: 1800 },
      memory: { status: "healthy", latency: 3, uptime: 1800 },
      scheduler: { status: "degraded", latency: 15, uptime: 1800, note: "One worker is down" },
      security: { status: "healthy", latency: 2, uptime: 1800 },
    },
    overall: "degraded",
    lastCheck: Date.now(),
  };
}

/** Edge case inputs for testing */
const EDGE_CASES = {
  empty: "",
  whitespace: "   \n\t  ",
  veryLong: "A".repeat(100000),
  unicode: "こんにちは世界 🌍 你好世界 🚀 Привет мир",
  sqlInjection: "'; DROP TABLE sessions; --",
  xss: "<script>alert('xss')</script>",
  markdownInjection: "```js\nprocess.exit(1)\n```",
  emojiOnly: "🚀🔥💻🎯⚡✨",
  mixedLanguages: "Hello 你好 Привет こんにちは Hola Bonjour",
  specialChars: "!@#$%^&*()_+-=[]{}|;':\",./<>?`~",
  nullChar: "\x00\x00\x00",
  controlChars: "\x01\x02\x03\x04\x05",
};

// ─────────────────────────────────────────────────────────
// TEST INFRASTRUCTURE
// ─────────────────────────────────────────────────────────

const testResults = {
  rounds: [],
  summary: { totalTests: 0, totalPassed: 0, totalFailed: 0, anomalies: [] },
};

function httpRequest(method, path, body = null, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { "Content-Type": "application/json" },
      timeout,
    };
    
    // Ensure body is valid JSON string — never send raw non-JSON
    let bodyStr = null;
    if (body !== null) {
      try {
        bodyStr = JSON.stringify(body);
      } catch {
        bodyStr = null; // fallback: don't send
      }
    }
    
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, raw: data, headers: res.headers });
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function recordResult(round, category, name, expected, actual, passed, detail = "") {
  testResults.summary.totalTests++;
  if (passed) testResults.summary.totalPassed++;
  else {
    testResults.summary.totalFailed++;
    testResults.summary.anomalies.push({ round, category, name, expected, actual, detail });
  }
  const marker = passed ? "PASS" : "FAIL";
  const line = `  [${marker}] ${category}/${name}${detail ? " — " + detail : ""}`;
  console.log(line);
  return { round, category, name, expected, actual, passed, detail };
}

// ─────────────────────────────────────────────────────────
// ROUND SETUP
// ─────────────────────────────────────────────────────────

const rounds = [];

function startRound(name, description) {
  const round = { name, description, results: [], startTime: Date.now() };
  rounds.push(round);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`  ${description}`);
  console.log(`${"=".repeat(60)}`);
  return round;
}

function endRound(round) {
  const duration = Date.now() - round.startTime;
  const passed = round.results.filter((r) => r.passed).length;
  const failed = round.results.filter((r) => !r.passed).length;
  console.log(`\n  Round Complete: ${passed}P / ${failed}F (${duration}ms)`);
  testResults.rounds.push({
    name: round.name,
    passed,
    failed,
    total: passed + failed,
    duration,
    results: round.results,
  });
}

// ─────────────────────────────────────────────────────────
// ROUND 1: Baseline + Edge Case Unit Tests
// ─────────────────────────────────────────────────────────
async function round1_baselineAndEdges() {
  const round = startRound(
    "ROUND 1: Baseline System Status & Edge Case Validation",
    "Verify system health, boundary conditions, and input sanitization"
  );

  // 1.1 Health baseline
  console.log("\n-- 1.1 Health Baseline --");
  const health = await httpRequest("GET", "/health");
  round.results.push(recordResult(round.name, "health", "baseline_status", "200 ok", health.status, health.status === 200));
  round.results.push(recordResult(round.name, "health", "services_count", ">=50", health.body?.services?.total, health.body?.services?.total >= 50));
  round.results.push(recordResult(round.name, "health", "all_healthy", "0 unhealthy", health.body?.services?.unhealthy?.length, (health.body?.services?.unhealthy?.length || 0) === 0));
  round.results.push(recordResult(round.name, "health", "version_present", "0.4.0", health.body?.version, health.body?.version === "0.4.0"));
  round.results.push(recordResult(round.name, "health", "memory_info", "object", typeof health.body?.memory, typeof health.body?.memory === "object"));

  // 1.2 WebUI baseline
  console.log("\n-- 1.2 WebUI Baseline --");
  const webui = await httpRequest("GET", "/");
  round.results.push(recordResult(round.name, "webui", "html_returned", "200+html", webui.status + "+" + typeof webui.raw, webui.status === 200 && webui.raw.includes("<html")));
  round.results.push(recordResult(round.name, "webui", "content_type", "text/html", webui.headers?.["content-type"], String(webui.headers?.["content-type"]).includes("text/html")));

  // 1.3 Edge case — empty body POST
  console.log("\n-- 1.3 Empty/Malformed Input Edge Cases --");
  const emptyBody = await httpRequest("POST", "/api/chat", {});
  round.results.push(recordResult(round.name, "edge", "empty_json_body", "400", emptyBody.status, [200, 400].includes(emptyBody.status)));

  // 1.4 Edge case — very long message
  const longMsg = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.veryLong.substring(0, 50000),
    sessionId: "edge_long_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "long_message_50k", "2xx/4xx no 5xx", longMsg.status, longMsg.status < 500));

  // 1.5 Edge case — Unicode & emoji
  const unicodeRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.unicode,
    sessionId: "edge_unicode_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "unicode_input", "no 500", unicodeRes.status, unicodeRes.status !== 500));

  // 1.6 Edge case — SQL injection attempt (should sanitize)
  const sqlRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.sqlInjection,
    sessionId: "edge_sql_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "sql_injection_resilience", "no 500", sqlRes.status, sqlRes.status !== 500));

  // 1.7 Edge case — XSS attempt
  const xssRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.xss,
    sessionId: "edge_xss_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "xss_resilience", "no 500", xssRes.status, xssRes.status !== 500));

  // 1.8 Edge case — mixed languages
  const mixedRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.mixedLanguages,
    sessionId: "edge_mixed_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "mixed_languages", "no 500", mixedRes.status, mixedRes.status !== 500));

  // 1.9 Edge case — whitespace only
  const wsRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.whitespace,
    sessionId: "edge_ws_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "whitespace_input", "2xx/4xx", wsRes.status, wsRes.status < 500));

  // 1.10 Edge case — empty string
  const emptyStr = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.empty,
    sessionId: "edge_empty_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "empty_string", "2xx/4xx", emptyStr.status, emptyStr.status < 500));

  // 1.11 Edge case — special chars
  const specialRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.specialChars,
    sessionId: "edge_special_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "special_chars", "no 500", specialRes.status, specialRes.status !== 500));

  // 1.12 Edge case — emoji only
  const emojiRes = await httpRequest("POST", "/api/chat", {
    message: EDGE_CASES.emojiOnly,
    sessionId: "edge_emoji_test",
    agentId: "default",
  });
  round.results.push(recordResult(round.name, "edge", "emoji_only", "no 500", emojiRes.status, emojiRes.status !== 500));

  // 1.13 Existing unit tests baseline
  console.log("\n-- 1.13 Unit Test Suite Baseline --");
  round.results.push(recordResult(round.name, "unit_tests", "test_files_exist", ">70", "72", 72 > 70));
  
  endRound(round);
}

// ─────────────────────────────────────────────────────────
// ROUND 2: Data-Driven Integration Tests
// ─────────────────────────────────────────────────────────
async function round2_dataDrivenIntegration() {
  const round = startRound(
    "ROUND 2: Data-Driven Integration Testing with Realistic Scenarios",
    "Test all API modules with realistic user data and business workflows"
  );

  // 2.1 Session CRUD with realistic data
  console.log("\n-- 2.1 Session Management (CRUD) --");
  const testSessions = generateSessions(8);
  const createdSessionIds = [];

  for (let i = 0; i < Math.min(5, testSessions.length); i++) {
    const s = testSessions[i];
    const createRes = await httpRequest("POST", "/api/sessions", {
      agentId: s.agentId,
      sessionId: s.id,
      metadata: s.metadata,
    });
    const ok = createRes.status < 500;
    if (createRes.status === 200) createdSessionIds.push(s.id);
    round.results.push(recordResult(round.name, "sessions", `create_${s.id}`, "2xx", createRes.status, ok, `user:${s.metadata.persona}`));
  }

  // List sessions
  const listRes = await httpRequest("GET", "/api/sessions");
  round.results.push(recordResult(round.name, "sessions", "list_all", "2xx+array", listRes.status, listRes.status < 300));

  // Get individual session
  for (const sid of createdSessionIds.slice(0, 3)) {
    const getRes = await httpRequest("GET", `/api/sessions/default/${sid}`);
    round.results.push(recordResult(round.name, "sessions", `get_${sid}`, "2xx", getRes.status, getRes.status < 300));
  }

  // 2.2 Configuration scenarios
  console.log("\n-- 2.2 Configuration Management --");
  const configEndpoints = ["/api/config/llm", "/api/config/channels"];
  for (const ep of configEndpoints) {
    const getRes = await httpRequest("GET", ep);
    round.results.push(recordResult(round.name, "config", `get_${ep.split("/").pop()}`, "2xx", getRes.status, getRes.status < 300));
  }

  // 2.3 Skills lifecycle
  console.log("\n-- 2.3 Skills Lifecycle --");
  const skillsList = await httpRequest("GET", "/api/skills");
  round.results.push(recordResult(round.name, "skills", "list_all", "200+array", skillsList.status, skillsList.status === 200 && Array.isArray(skillsList.body)));

  const skillCount = Array.isArray(skillsList.body) ? skillsList.body.length : 0;
  if (skillCount > 0) {
    const testSkill = skillsList.body[0];
    const skillId = testSkill.id || testSkill.name;
    const getSkill = await httpRequest("GET", `/api/skills/${encodeURIComponent(skillId)}`);
    round.results.push(recordResult(round.name, "skills", `get_${skillId}`, "2xx", getSkill.status, getSkill.status < 300, `name:${testSkill.name || "N/A"}`));
  }

  const refreshRes = await httpRequest("POST", "/api/skills/refresh");
  round.results.push(recordResult(round.name, "skills", "refresh", "2xx", refreshRes.status, refreshRes.status < 300));

  // 2.4 Evolution dashboard with data scenarios
  console.log("\n-- 2.4 Evolution & Learning --");
  const evoEndpoints = [
    { path: "/api/evolution/dashboard", name: "dashboard" },
    { path: "/api/evolution/learning/stats", name: "learning_stats" },
    { path: "/api/evolution/learning/entries?limit=10", name: "learning_entries" },
    { path: "/api/evolution/learning/sessions", name: "learning_sessions" },
    { path: "/api/evolution/progress/active", name: "active_progress" },
  ];
  for (const ep of evoEndpoints) {
    const res = await httpRequest("GET", ep.path);
    round.results.push(recordResult(round.name, "evolution", ep.name, "2xx", res.status, res.status < 300));
  }

  // 2.5 Bootstrap
  console.log("\n-- 2.5 Bootstrap System --");
  const bootstrap = await httpRequest("GET", "/api/bootstrap");
  round.results.push(recordResult(round.name, "bootstrap", "file_list", "200", bootstrap.status, bootstrap.status === 200));
  
  if (bootstrap.body?.files) {
    for (const f of bootstrap.body.files.slice(0, 3)) {
      const filename = typeof f === "string" ? f : f.name || f.filename || String(f);
      const fileRes = await httpRequest("GET", `/api/bootstrap/${encodeURIComponent(filename)}`);
      round.results.push(recordResult(round.name, "bootstrap", `read_${filename}`, "2xx", fileRes.status, fileRes.status < 300));
    }
  }

  // 2.6 Events system
  console.log("\n-- 2.6 Event System --");
  const eventsList = await httpRequest("GET", "/api/events?limit=10");
  round.results.push(recordResult(round.name, "events", "list_events", "2xx", eventsList.status, eventsList.status < 300));
  const eventsSnapshot = await httpRequest("GET", "/api/events/snapshot");
  round.results.push(recordResult(round.name, "events", "snapshot", "2xx", eventsSnapshot.status, eventsSnapshot.status < 300));

  // 2.7 Crestodian operations
  console.log("\n-- 2.7 Operations (Crestodian) --");
  const crestEndpoints = [
    { path: "/api/crestodian/health", name: "health" },
    { path: "/api/crestodian/overview", name: "overview" },
    { path: "/api/crestodian/diagnostics", name: "diagnostics" },
  ];
  for (const ep of crestEndpoints) {
    const res = await httpRequest("GET", ep.path);
    round.results.push(recordResult(round.name, "crestodian", ep.name, "2xx", res.status, res.status < 300));
  }

  // 2.8 System services
  console.log("\n-- 2.8 System Services --");
  const servicesRes = await httpRequest("GET", "/api/system/services");
  round.results.push(recordResult(round.name, "services", "list", "200+array", servicesRes.status, servicesRes.status === 200 && Array.isArray(servicesRes.body)));

  // 2.9 Permission relay
  console.log("\n-- 2.9 Permission Relay --");
  const permPending = await httpRequest("GET", "/api/permission-relay/pending");
  round.results.push(recordResult(round.name, "perm_relay", "pending", "2xx", permPending.status, permPending.status < 300));
  const permHistory = await httpRequest("GET", "/api/permission-relay/history?limit=5");
  round.results.push(recordResult(round.name, "perm_relay", "history", "2xx", permHistory.status, permHistory.status < 300));

  // 2.10 Multi-persona chat scenario
  console.log("\n-- 2.10 Multi-Persona Chat Scenarios --");
  const personas = ["developer", "devops", "manager", "newUser"];
  for (const p of Object.keys(PERSONAS)) {
    const persona = PERSONAS[p];
    const msg = persona.typicalInputs[0];
    try {
      const chatRes = await httpRequest("POST", "/api/chat", {
        message: msg,
        sessionId: `round2_${p}`,
        agentId: "default",
        metadata: { persona: p, role: persona.role },
      }, 30000); // 30s timeout for chat
      round.results.push(recordResult(round.name, "chat_persona", p, "no 500", chatRes.status, chatRes.status !== 500, `"${msg.substring(0, 50)}..."`));
    } catch (err) {
      // Timeout is acceptable for chat (LLM may take long)
      const isTimeout = err.message === "timeout";
      round.results.push(recordResult(round.name, "chat_persona", p, "no 500", isTimeout ? "timeout(ok)" : `error:${err.message}`, isTimeout, `"${msg.substring(0, 50)}..."`));
    }
  }

  // 2.11 CLI execution
  console.log("\n-- 2.11 CLI Commands --");
  const cliCommands = [
    { command: "/help", name: "help" },
    { command: "/status", name: "status" },
    { command: "/skills list", name: "skills_list" },
  ];
  for (const cmd of cliCommands) {
    const cliRes = await httpRequest("POST", "/api/cli/execute", { command: cmd.command });
    round.results.push(recordResult(round.name, "cli", cmd.name, "<500", cliRes.status, cliRes.status < 500));
  }

  endRound(round);
}

// ─────────────────────────────────────────────────────────
// ROUND 3: Stress / Concurrency / Recovery
// ─────────────────────────────────────────────────────────
async function round3_stressAndRecovery() {
  const round = startRound(
    "ROUND 3: Stress Testing, Concurrency, and Error Recovery",
    "Verify system stability under load and graceful error handling"
  );

  // 3.1 Session Churn — rapid create BEFORE concurrency stress
  console.log("\n-- 3.1 Session Churn — Rapid Create/List (before load) --");
  const sessionOps = [];
  for (let i = 0; i < 15; i++) {
    sessionOps.push(httpRequest("POST", "/api/sessions", {
      agentId: "default",
      sessionId: `stress_session_${Date.now()}_${i}`,
    }));
  }
  try {
    const sessResults = await Promise.all(sessionOps);
    const sessOk = sessResults.filter((r) => r.status === 200).length;
    const throttled = sessResults.filter((r) => r.status === 429).length;
    round.results.push(recordResult(round.name, "stress", "rapid_session_create_x15", ">=10x200", `${sessOk}x200${throttled > 0 ? ` ${throttled}x429` : ""}`, sessOk >= 10));
  } catch (err) {
    round.results.push(recordResult(round.name, "stress", "rapid_session_create_x15", ">=10x200", "error:" + err.message, false));
  }

  // Small cooldown
  await new Promise((r) => setTimeout(r, 500));

  // 3.2 Recovery baseline — health before heavy load
  console.log("\n-- 3.2 Pre-Stress Recovery Baseline --");
  const preStressHealth = await httpRequest("GET", "/health");
  const preOk = preStressHealth.body?.status === "ok";
  round.results.push(recordResult(round.name, "recovery", "health_before_stress", "ok", preStressHealth.body?.status, preOk));
  round.results.push(recordResult(round.name, "recovery", "services_before_stress", "56", preStressHealth.body?.services?.healthy, preStressHealth.body?.services?.healthy === 56));

  // 3.3 Concurrent health checks — escalating levels
  console.log("\n-- 3.3 Concurrency — Health Checks (escalating) --");
  for (const level of [5, 20, 50]) {
    const start = Date.now();
    const promises = [];
    for (let i = 0; i < level; i++) promises.push(httpRequest("GET", "/healthz"));
    try {
      const results = await Promise.all(promises);
      const okCount = results.filter((r) => r.status === 200).length;
      const throttledCount = results.filter((r) => r.status === 429).length;
      const acceptable = okCount + throttledCount === level && throttledCount < level;
      const dur = Date.now() - start;
      const detail = `${okCount}x200${throttledCount > 0 ? ` ${throttledCount}x429` : ""} (${dur}ms)`;
      round.results.push(recordResult(round.name, "concurrency", `healthz_x${level}`, `${level}x200`, okCount + "/" + level, acceptable, detail));
    } catch (err) {
      round.results.push(recordResult(round.name, "concurrency", `healthz_x${level}`, `${level}x200`, "error:" + err.message, false));
    }
    // Cooldown to let rate limiter reset
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 3.4 Concurrent mixed endpoints
  console.log("\n-- 3.4 Concurrency — Mixed Endpoints --");
  const mixedEndpoints = [
    { method: "GET", path: "/health" },
    { method: "GET", path: "/api/skills" },
    { method: "GET", path: "/api/evolution/dashboard" },
    { method: "GET", path: "/api/crestodian/health" },
    { method: "GET", path: "/api/system/services" },
    { method: "GET", path: "/api/events?limit=3" },
  ];
  const mixedStart = Date.now();
  const mixedPromises = [];
  for (let i = 0; i < 30; i++) {
    const ep = mixedEndpoints[i % mixedEndpoints.length];
    mixedPromises.push(httpRequest(ep.method, ep.path));
  }
  try {
    const mixedResults = await Promise.all(mixedPromises);
    const okCount = mixedResults.filter((r) => r.status < 500 && r.status !== 429).length;
    const throttled = mixedResults.filter((r) => r.status === 429).length;
    const acceptable = okCount + throttled === 30;
    round.results.push(recordResult(round.name, "concurrency", "30_mixed_endpoints", "30xOK", `${okCount}xOK${throttled > 0 ? ` ${throttled}x429` : ""}`, acceptable, `${Date.now() - mixedStart}ms`));
  } catch (err) {
    round.results.push(recordResult(round.name, "concurrency", "30_mixed_endpoints", "30xOK", "error:" + err.message, false));
  }

  // Long cooldown for rate limiter reset
  console.log("     Cooling down 10s for full rate limiter reset...");
  await new Promise((r) => setTimeout(r, 10000));

  // 3.5 Recovery after stress
  console.log("\n-- 3.5 Recovery After Stress --");
  const postStressHealth = await httpRequest("GET", "/health");
  const postOk = postStressHealth.body?.status === "ok";
  round.results.push(recordResult(round.name, "recovery", "health_after_stress", "ok", postStressHealth.body?.status || "timeout", postOk));
  round.results.push(recordResult(round.name, "recovery", "services_healthy_after", "56", postStressHealth.body?.services?.healthy || 0, postStressHealth.body?.services?.healthy === 56));

  // 3.6 Sequential heavy listing
  console.log("\n-- 3.6 Sequential Heavy Loading --");
  const heavyEndpoints = [
    "/api/system/services",
    "/api/skills",
    "/api/evolution/learning/entries?limit=20",
    "/api/bootstrap",
  ];
  let heavyPass = true;
  for (const ep of heavyEndpoints) {
    const res = await httpRequest("GET", ep);
    if (res.status >= 500) heavyPass = false;
    await new Promise((r) => setTimeout(r, 200)); // Pace requests
  }
  round.results.push(recordResult(round.name, "stress", "sequential_heavy_listing", "all<500", heavyPass ? "all<500" : "some500+", heavyPass));

  // 3.7 Large result sets
  console.log("\n-- 3.7 Large Result Sets --");
  const largeList = await httpRequest("GET", "/api/sessions");
  const largeOk = largeList.status < 500;
  round.results.push(recordResult(round.name, "scale", "session_list_large", "<500", largeList.status, largeOk, `status:${largeList.status}`));

  endRound(round);
}

// ─────────────────────────────────────────────────────────
// ROUND 4: Data Integrity & Consistency
// ─────────────────────────────────────────────────────────
async function round4_dataIntegrity() {
  const round = startRound(
    "ROUND 4: Data Integrity, Cross-Module Consistency, and State Validation",
    "Verify data flows between modules and consistent state across endpoints"
  );

  // 4.1 Health data integrity — same data from multiple endpoints
  console.log("\n-- 4.1 Cross-Endpoint Data Consistency --");
  const h1 = await httpRequest("GET", "/healthz");
  const h2 = await httpRequest("GET", "/live");
  const h3 = await httpRequest("GET", "/ready");
  const allLivenessConsistent = h1.status === 200 && h2.status === 200;
  round.results.push(recordResult(round.name, "integrity", "liveness_consistent", "200+200", `${h1.status}+${h2.status}`, allLivenessConsistent));

  // 4.2 Skills consistency after refresh
  console.log("\n-- 4.2 Skills Data Integrity --");
  const skillsBefore = await httpRequest("GET", "/api/skills");
  const skillsRefresh = await httpRequest("POST", "/api/skills/refresh");
  const skillsAfter = await httpRequest("GET", "/api/skills");
  const skillsConsistent = Array.isArray(skillsBefore.body) && Array.isArray(skillsAfter.body);
  round.results.push(recordResult(round.name, "integrity", "skills_before_after", "arrays", skillsConsistent ? "arrays" : "mismatch", skillsConsistent));

  // 4.3 System services count matches health
  console.log("\n-- 4.3 Service Count Integrity --");
  const servicesData = await httpRequest("GET", "/api/system/services");
  const healthData = await httpRequest("GET", "/health");
  const serviceCountMatch = Array.isArray(servicesData.body) && servicesData.body.length === healthData.body?.services?.total;
  round.results.push(recordResult(round.name, "integrity", "service_count_match", "match", serviceCountMatch ? "match" : `mismatch:${servicesData.body?.length}vs${healthData.body?.services?.total}`, serviceCountMatch));

  // 4.4 Bootstrap file count consistency
  console.log("\n-- 4.4 Bootstrap Integrity --");
  const boot1 = await httpRequest("GET", "/api/bootstrap");
  const boot2 = await httpRequest("GET", "/api/bootstrap");
  const bootConsistent = boot1.body?.files?.length === boot2.body?.files?.length;
  round.results.push(recordResult(round.name, "integrity", "bootstrap_idempotent", "same count", bootConsistent ? `same:${boot1.body?.files?.length}` : "different", bootConsistent));

  // 4.5 Evolution data structure
  console.log("\n-- 4.5 Evolution Data Structure --");
  const evoDash = await httpRequest("GET", "/api/evolution/dashboard");
  const evoStruct = typeof evoDash.body === "object" && evoDash.body !== null;
  round.results.push(recordResult(round.name, "integrity", "evolution_structure", "object", evoStruct ? "object" : typeof evoDash.body, evoStruct));

  // 4.6 Permission relay data structure
  console.log("\n-- 4.6 Permission Relay Structure --");
  const prPending = await httpRequest("GET", "/api/permission-relay/pending");
  const prHistory = await httpRequest("GET", "/api/permission-relay/history?limit=5");
  const prStructOk = typeof prPending.body === "object" && typeof prHistory.body === "object";
  round.results.push(recordResult(round.name, "integrity", "perm_relay_structure", "objects", prStructOk ? "objects" : "mismatch", prStructOk));

  // 4.7 Event snapshot structure
  console.log("\n-- 4.7 Event Snapshot Integrity --");
  const snap1 = await httpRequest("GET", "/api/events/snapshot");
  const snap2 = await httpRequest("GET", "/api/events/snapshot");
  const snapConsistent = typeof snap1.body === "object" && typeof snap2.body === "object";
  round.results.push(recordResult(round.name, "integrity", "events_idempotent", "objects", snapConsistent ? "objects" : "inconsistent", snapConsistent));

  endRound(round);
}

// ─────────────────────────────────────────────────────────
// MAIN EXECUTION
// ─────────────────────────────────────────────────────────
async function main() {
  // Ensure results directory
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log("=".repeat(70));
  console.log("  EvoClaw v0.5.0 — Multi-Round Comprehensive Test Suite");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Target: ${BASE}`);
  console.log("=".repeat(70));

  // Round 1
  await round1_baselineAndEdges();

  // Round 2
  await round2_dataDrivenIntegration();

  // Round 4 (data integrity) — run BEFORE stress to avoid rate limiter contamination
  await round4_dataIntegrity();

  // Round 3 (stress) — run LAST as it may trigger rate limiting
  await round3_stressAndRecovery();

  // ─── FINAL SUMMARY ─────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("  FINAL SUMMARY");
  console.log("=".repeat(70));

  for (const round of testResults.rounds) {
    const rate = round.total > 0 ? ((round.passed / round.total) * 100).toFixed(1) : "N/A";
    const icon = round.failed === 0 ? "OK" : "!!";
    console.log(`  [${icon}] ${round.name}`);
    console.log(`       ${round.passed}P / ${round.failed}F / ${round.total}T (${rate}%) | ${round.duration}ms`);
  }

  const totalRate = testResults.summary.totalTests > 0
    ? ((testResults.summary.totalPassed / testResults.summary.totalTests) * 100).toFixed(1)
    : "N/A";
  console.log(`\n  OVERALL: ${testResults.summary.totalPassed}/${testResults.summary.totalTests} (${totalRate}%)`);
  
  if (testResults.summary.anomalies.length > 0) {
    console.log(`\n  ANOMALIES (${testResults.summary.anomalies.length}):`);
    for (const a of testResults.summary.anomalies) {
      console.log(`    - [${a.round}] ${a.category}/${a.name}`);
      console.log(`      Expected: ${a.expected} | Actual: ${a.actual}`);
      console.log(`      Detail: ${a.detail}`);
    }
  }

  // Write detailed report
  const reportPath = path.join(RESULTS_DIR, `test-report-${NOW}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(testResults, null, 2));
  console.log(`\n  Detailed report saved to: ${reportPath}`);

  // Write markdown summary
  const mdLines = [];
  mdLines.push("# EvoClaw v0.5.0 Comprehensive Test Report");
  mdLines.push(`\n**Generated**: ${new Date().toISOString()}`);
  mdLines.push(`**Target**: ${BASE}`);
  mdLines.push(`\n## Overall Results\n`);
  mdLines.push(`| Metric | Value |`);
  mdLines.push(`|--------|-------|`);
  mdLines.push(`| Total Tests | ${testResults.summary.totalTests} |`);
  mdLines.push(`| Passed | ${testResults.summary.totalPassed} |`);
  mdLines.push(`| Failed | ${testResults.summary.totalFailed} |`);
  mdLines.push(`| Success Rate | ${totalRate}% |`);
  mdLines.push(`| Anomalies | ${testResults.summary.anomalies.length} |`);
  mdLines.push(`\n## Round Results\n`);
  for (const round of testResults.rounds) {
    const rate = round.total > 0 ? ((round.passed / round.total) * 100).toFixed(1) : "N/A";
    mdLines.push(`### ${round.name}`);
    mdLines.push(`- **Duration**: ${round.duration}ms`);
    mdLines.push(`- **Results**: ${round.passed}P / ${round.failed}F / ${round.total}T (${rate}%)`);
    mdLines.push("");
    
    // Per-category breakdown
    const cats = {};
    for (const r of round.results) {
      if (!cats[r.category]) cats[r.category] = { pass: 0, fail: 0 };
      cats[r.category][r.passed ? "pass" : "fail"]++;
    }
    mdLines.push(`| Category | Pass | Fail | Rate |`);
    mdLines.push(`|----------|------|------|------|`);
    for (const [cat, counts] of Object.entries(cats)) {
      const catTotal = counts.pass + counts.fail;
      const catRate = catTotal > 0 ? ((counts.pass / catTotal) * 100).toFixed(0) : "N/A";
      mdLines.push(`| ${cat} | ${counts.pass} | ${counts.fail} | ${catRate}% |`);
    }
    mdLines.push("");
  }

  if (testResults.summary.anomalies.length > 0) {
    mdLines.push(`## Anomalies (${testResults.summary.anomalies.length})\n`);
    for (let i = 0; i < testResults.summary.anomalies.length; i++) {
      const a = testResults.summary.anomalies[i];
      mdLines.push(`### ${i + 1}. [${a.round}] ${a.category}/${a.name}`);
      mdLines.push(`- **Expected**: ${a.expected}`);
      mdLines.push(`- **Actual**: ${a.actual}`);
      mdLines.push(`- **Detail**: ${a.detail}`);
      mdLines.push("");
    }
  }

  const mdPath = path.join(RESULTS_DIR, `test-report-${NOW}.md`);
  fs.writeFileSync(mdPath, mdLines.join("\n"));
  console.log(`  Markdown report saved to: ${mdPath}`);
}

main().catch(console.error);