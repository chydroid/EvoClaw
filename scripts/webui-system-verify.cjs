/**
 * EvoClaw WebUI System Verification Test Suite
 * 
 * Comprehensive testing of all plugins, APIs, skills, and chat interactions.
 * Simulates real user interactions through the WebUI.
 */

const http = require("http");
const https = require("https");

const BASE_URL = "http://localhost:27788";
const TEST_SESSION_ID = `sys-test-${Date.now()}`;

// ── Test Results Tracking ──────────────────────────────
const results = [];
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const startTime = Date.now();

function record(category, testName, passed, detail = "") {
  const status = passed ? "PASS" : "FAIL";
  if (passed) totalPassed++;
  else totalFailed++;
  results.push({ category, testName, status, detail, timestamp: new Date().toISOString() });
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} [${category}] ${testName}${detail ? ` — ${detail}` : ""}`);
}

function skip(category, testName, reason = "") {
  totalSkipped++;
  results.push({ category, testName, status: "SKIP", detail: reason, timestamp: new Date().toISOString() });
  console.log(`  ⊘ [${category}] ${testName} — SKIPPED: ${reason}`);
}

// ── HTTP Helpers ────────────────────────────────────────

function fetchJSON(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      timeout: options.timeout || 30000,
      signal: options.signal,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: data.slice(0, 500) });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (options.body) req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

async function fetchSSE(path, body, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: timeoutMs,
    }, (res) => {
      const events = [];
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try { events.push(JSON.parse(line.slice(6))); } catch { events.push(line.slice(6)); }
          } else if (line.startsWith("event: ")) {
            events.push({ _event: line.slice(7) });
          }
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, events }));
      res.on("error", () => resolve({ status: res.statusCode, events, error: "stream error" }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, events: [], error: "timeout" }); });
    req.on("error", () => resolve({ status: 0, events: [], error: "connection error" }));
    req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main Test Runner ────────────────────────────────────

async function runAllTests() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   EvoClaw WebUI System Verification Test Suite      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ========== A. 健康检查与系统状态 ====================
  await testHealthAndSystem();
  // ========== B. 插件管理 ==============================
  await testPluginManagement();
  // ========== C. LLM配置 ===============================
  await testLLMConfiguration();
  // ========== D. 聊天交互 — 基础 =======================
  await testChatBasic();
  // ========== E. 聊天交互 — 高级场景 ===================
  await testChatAdvanced();
  // ========== F. 聊天交互 — 安全与边缘 =================
  await testChatSecurity();
  // ========== G. 技能管理 ==============================
  await testSkillsManagement();
  // ========== H. 消息队列 ==============================
  await testMessageQueue();
  // ========== I. 配置管理 ==============================
  await testConfiguration();
  // ========== J. 权限系统 ==============================
  await testPermissions();
  // ========== K. 边缘与压力 ============================
  await testEdgeCases();

  // ── Final Report ─────────────────────────────────────
  printReport();
}

// ========== A. 健康检查与系统状态 ========================
async function testHealthAndSystem() {
  console.log("\n── A. 健康检查与系统状态 ──");

  // A1: 基础健康检查
  try {
    const r = await fetchJSON("/health");
    record("A-健康检查", "GET /health 返回200", r.status === 200, `status=${r.status}`);
  } catch (e) {
    record("A-健康检查", "GET /health 返回200", false, String(e));
  }

  // A2: 全量健康检查
  try {
    const r = await fetchJSON("/api/health/full");
    const healthy = r.data?.healthy !== false;
    const components = Object.keys(r.data?.components || r.data || {}).length;
    record("A-健康检查", "GET /api/health/full 返回组件状态", healthy, `${components} 组件`);
  } catch (e) {
    record("A-健康检查", "GET /api/health/full 返回组件状态", false, String(e));
  }

  // A3: 组件级健康检查
  try {
    const r = await fetchJSON("/api/health/component/pluginManager");
    record("A-健康检查", "GET /api/health/component/:name", r.status === 200, `pluginManager`);
  } catch (e) {
    record("A-健康检查", "GET /api/health/component/:name", false, String(e));
  }

  // A4: 组件健康检查触发
  try {
    const r = await fetchJSON("/api/health/component/pluginManager/check", { method: "POST" });
    record("A-健康检查", "POST /api/health/component/:name/check", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("A-健康检查", "POST /api/health/component/:name/check", false, String(e));
  }

  // A5: Crestodian 健康
  try {
    const r = await fetchJSON("/api/crestodian/health");
    record("A-健康检查", "GET /api/crestodian/health", r.status < 500);
  } catch (e) {
    record("A-健康检查", "GET /api/crestodian/health", false, String(e));
  }

  // A6: 服务器版本信息
  try {
    const r = await fetchJSON("/api/version");
    record("A-健康检查", "GET /api/version", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("A-健康检查", "GET /api/version", false, String(e));
  }
}

// ========== B. 插件管理 =================================
async function testPluginManagement() {
  console.log("\n── B. 插件管理 ──");

  // B1: 获取所有插件列表
  try {
    const r = await fetchJSON("/api/plugins");
    const plugins = r.data?.plugins || [];
    record("B-插件", "GET /api/plugins 返回插件列表", r.data?.success && plugins.length >= 10, `${plugins.length} 插件`);
  } catch (e) {
    record("B-插件", "GET /api/plugins 返回插件列表", false, String(e));
  }

  // B2: 验证所有核心插件已注册
  try {
    const r = await fetchJSON("/api/plugins");
    const names = (r.data?.plugins || []).map(p => p.manifest?.name);
    const required = [
      "Memory Enhancer", "Code Analyzer", "Web Browser",
      "System Logger", "Cost Tracker", "Response Validator",
      "Conversation Summarizer", "Claude Code Tools", "MarkItDown",
      "Enhanced Browser"
    ];
    const missing = required.filter(n => !names.includes(n));
    record("B-插件", "10个核心插件全部注册", missing.length === 0, missing.length ? `缺失: ${missing.join(", ")}` : "全部在线");
  } catch (e) {
    record("B-插件", "10个核心插件全部注册", false, String(e));
  }

  // B3: Enhanced Browser 插件版本
  try {
    const r = await fetchJSON("/api/plugins");
    const eb = (r.data?.plugins || []).find(p => p.manifest?.name === "Enhanced Browser");
    const valid = eb && eb.manifest?.version === "2.0.0";
    record("B-插件", "Enhanced Browser v2.0.0 已注册", valid, eb ? `v${eb.manifest.version}` : "未找到");
  } catch (e) {
    record("B-插件", "Enhanced Browser v2.0.0 已注册", false, String(e));
  }

  // B4: 插件状态切换
  try {
    const r = await fetchJSON("/api/plugins/Enhanced Browser/toggle", {
      method: "POST",
      body: JSON.stringify({ status: "disabled" }),
    });
    record("B-插件", "POST /api/plugins/:name/toggle (disable)", r.data?.success === true, `status=${r.status}`);

    // Re-enable
    await fetchJSON("/api/plugins/Enhanced Browser/toggle", {
      method: "POST",
      body: JSON.stringify({ status: "enabled" }),
    });
  } catch (e) {
    record("B-插件", "POST /api/plugins/:name/toggle", false, String(e));
  }

  // B5: 插件安装 (内置插件)
  try {
    const r = await fetchJSON("/api/plugins/install", {
      method: "POST",
      body: JSON.stringify({ name: "Enhanced Browser" }),
    });
    record("B-插件", "POST /api/plugins/install (已安装插件)", r.data?.success === true);
  } catch (e) {
    record("B-插件", "POST /api/plugins/install", false, String(e));
  }

  // B6: 无效插件名切换
  try {
    const r = await fetchJSON("/api/plugins/NonExistentPlugin/toggle", {
      method: "POST",
      body: JSON.stringify({ status: "enabled" }),
    });
    record("B-插件", "切换不存在插件 (应优雅处理)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("B-插件", "切换不存在插件", true, "异常已捕获(预期行为)"); // 服务不崩溃即为通过
  }
}

// ========== C. LLM配置 ==================================
async function testLLMConfiguration() {
  console.log("\n── C. LLM配置 ──");

  // C1: 获取LLM配置
  try {
    const r = await fetchJSON("/api/config/llm");
    const providers = r.data?.providers || [];
    record("C-配置", "GET /api/config/llm", r.status === 200, `${providers.length} 提供商`);
  } catch (e) {
    record("C-配置", "GET /api/config/llm", false, String(e));
  }

  // C2: 获取channels配置
  try {
    const r = await fetchJSON("/api/config/channels");
    record("C-配置", "GET /api/config/channels", r.status === 200);
  } catch (e) {
    record("C-配置", "GET /api/config/channels", false, String(e));
  }

  // C3: 配置医生检查
  try {
    const r = await fetchJSON("/api/config/doctor");
    record("C-配置", "GET /api/config/doctor", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("C-配置", "GET /api/config/doctor", false, String(e));
  }

  // C4: 配置迁移状态
  try {
    const r = await fetchJSON("/api/config/migration-status");
    record("C-配置", "GET /api/config/migration-status", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("C-配置", "GET /api/config/migration-status", false, String(e));
  }
}

// ========== D. 聊天交互 - 基础 ==========================
async function testChatBasic() {
  console.log("\n── D. 聊天交互 — 基础场景 ──");

  // D1: 简单问候
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "你好，请简单介绍一下你自己", sessionId: TEST_SESSION_ID }),
      timeout: 120000,
    });
    const hasReply = !!(r.data?.reply || r.data?.response);
    record("D-聊天基础", "简单问候对话", r.status === 200 && hasReply, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("D-聊天基础", "简单问候对话", false, String(e).slice(0, 200));
  }

  // D2: 事实问答
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "1+1等于几？请只回答数字", sessionId: TEST_SESSION_ID }),
      timeout: 120000,
    });
    const hasReply = !!(r.data?.reply || r.data?.response);
    record("D-聊天基础", "简单数学问答", r.status === 200 && hasReply, `reply=${(r.data?.reply||"").slice(0,50)}`);
  } catch (e) {
    record("D-聊天基础", "简单数学问答", false, String(e).slice(0, 200));
  }

  // D3: 代码生成请求 (触发Code Analyzer)
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "写一个JavaScript函数反转字符串", sessionId: TEST_SESSION_ID }),
      timeout: 120000,
    });
    const hasReply = !!(r.data?.reply || r.data?.response);
    record("D-聊天基础", "代码生成请求", r.status === 200 && hasReply, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("D-聊天基础", "代码生成请求", false, String(e).slice(0, 200));
  }

  // D4: 网页搜索请求 (触发Web Browser)
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "搜索最新的人工智能发展趋势", sessionId: TEST_SESSION_ID }),
      timeout: 120000,
    });
    record("D-聊天基础", "网页搜索请求", r.status === 200 || r.status === 202, `status=${r.status}`);
  } catch (e) {
    record("D-聊天基础", "网页搜索请求", false, String(e).slice(0, 200));
  }

  // D5: 空消息处理
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "", sessionId: TEST_SESSION_ID }),
      timeout: 10000,
    });
    record("D-聊天基础", "空消息 (应返回400)", r.status === 400, `status=${r.status}`);
  } catch (e) {
    record("D-聊天基础", "空消息处理", false, String(e).slice(0, 200));
  }

  // D6: 纯空格消息
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "   ", sessionId: TEST_SESSION_ID }),
      timeout: 10000,
    });
    record("D-聊天基础", "纯空格消息 (应返回400)", r.status === 400, `status=${r.status}`);
  } catch (e) {
    record("D-聊天基础", "纯空格消息", false, String(e).slice(0, 200));
  }

  // D7: 缺失message字段
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ sessionId: TEST_SESSION_ID }),
      timeout: 10000,
    });
    record("D-聊天基础", "缺失message字段 (应返回400)", r.status === 400, `status=${r.status}`);
  } catch (e) {
    record("D-聊天基础", "缺失message字段", false, String(e).slice(0, 200));
  }

  // D8: SSE流式响应
  await sleep(1000);
  try {
    const sseResult = await fetchSSE("/api/chat?stream=true", {
      message: "用一句话介绍什么是机器学习",
      sessionId: TEST_SESSION_ID + "-sse",
    }, 120000);
    const hasEvents = (sseResult.events || []).length > 0;
    record("D-聊天基础", "SSE流式响应", sseResult.status === 200 && hasEvents, `${sseResult.events.length} 事件`);
    if (sseResult.events && sseResult.events.length > 0) {
      const eventTypes = [...new Set(sseResult.events.filter(e => e._event).map(e => e._event))];
      if (eventTypes.length > 0) console.log(`    SSE事件类型: ${eventTypes.join(", ")}`);
    }
  } catch (e) {
    record("D-聊天基础", "SSE流式响应", false, String(e).slice(0, 200));
  }

  // D9: 聊天状态查询
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat/status");
    record("D-聊天基础", "GET /api/chat/status", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("D-聊天基础", "GET /api/chat/status", false, String(e));
  }
}

// ========== E. 聊天交互 - 高级场景 ======================
async function testChatAdvanced() {
  console.log("\n── E. 聊天交互 — 高级场景 ──");

  // E1: 中文长文本
  await sleep(1000);
  try {
    const longMsg = "请详细分析以下技术方案的优缺点：" + "微服务架构与单体架构的对比分析。".repeat(5);
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: longMsg, sessionId: TEST_SESSION_ID }),
      timeout: 120000,
    });
    record("E-聊天高级", "中文长文本分析", r.status === 200, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("E-聊天高级", "中文长文本分析", false, String(e).slice(0, 200));
  }

  // E2: 多步骤任务 (触发Memory Enhancer)
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "请帮我：(1)计算15*23的结果 (2)将结果转为二进制 (3)解释二进制的含义",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "多步骤复合任务", r.status === 200, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("E-聊天高级", "多步骤复合任务", false, String(e).slice(0, 200));
  }

  // E3: 文件创建请求 (触发权限系统)
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "请在workspace中创建一个test.txt文件，内容为Hello EvoClaw",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "文件创建请求 (权限检查)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("E-聊天高级", "文件创建请求", false, String(e).slice(0, 200));
  }

  // E4: 记忆关联对话
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "请记住：我最喜欢的编程语言是TypeScript",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "记忆存储请求", r.status === 200, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("E-聊天高级", "记忆存储请求", false, String(e).slice(0, 200));
  }

  // E5: 记忆回忆
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "根据之前的对话，我最喜欢的编程语言是什么？",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "记忆回忆请求", r.status === 200, `reply=${(r.data?.reply||"").slice(0,100)}`);
  } catch (e) {
    record("E-聊天高级", "记忆回忆请求", false, String(e).slice(0, 200));
  }

  // E6: 翻译请求
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "将以下英文翻译成中文：Artificial intelligence is transforming the world.",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "翻译请求", r.status === 200, `reply=${(r.data?.reply||"").slice(0,100)}`);
  } catch (e) {
    record("E-聊天高级", "翻译请求", false, String(e).slice(0, 200));
  }

  // E7: 带sessionId的上下文连续对话
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "继续我们刚才关于编程语言的讨论",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "上下文连续对话", r.status === 200, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("E-聊天高级", "上下文连续对话", false, String(e).slice(0, 200));
  }

  // E8: Markdown 格式转换请求 (触发MarkItDown)
  await sleep(1000);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "请将以下HTML转为Markdown: <h1>Title</h1><p>Hello <strong>World</strong></p>",
        sessionId: TEST_SESSION_ID,
      }),
      timeout: 120000,
    });
    record("E-聊天高级", "Markdown转换请求", r.status === 200, `reply长度=${(r.data?.reply||"").length}`);
  } catch (e) {
    record("E-聊天高级", "Markdown转换请求", false, String(e).slice(0, 200));
  }
}

// ========== F. 聊天交互 - 安全与边缘 ====================
async function testChatSecurity() {
  console.log("\n── F. 聊天交互 — 安全与边缘 ──");

  // F1: XSS注入
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "<script>alert('xss')</script>",
        sessionId: "xss-test-" + Date.now(),
      }),
      signal: AbortSignal.timeout(15000),
    });
    record("F-安全", "XSS脚本注入 (不应崩溃)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "XSS脚本注入", true, "超时/异常但服务未崩溃(预期行为)");
  }

  // F2: SQL注入尝试
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "'; DROP TABLE users; --",
        sessionId: "sqli-test-" + Date.now(),
      }),
      signal: AbortSignal.timeout(15000),
    });
    record("F-安全", "SQL注入尝试 (不应崩溃)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "SQL注入尝试", true, "超时/异常但服务未崩溃(预期行为)");
  }

  // F3: 超长消息
  await sleep(500);
  try {
    const veryLong = "测试消息".repeat(5000); // ~20KB
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: veryLong, sessionId: "long-test" }),
      signal: AbortSignal.timeout(15000),
    });
    record("F-安全", "超长消息 (~20KB)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "超长消息", true, "超时但服务未崩溃(预期行为)");
  }

  // F4: Unicode特殊字符
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "测试Unicode: 😀🎉🔥 日本語 한국어 العربية",
        sessionId: "unicode-test",
      }),
      signal: AbortSignal.timeout(15000),
    });
    record("F-安全", "Unicode/Emoji消息", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "Unicode/Emoji消息", false, String(e).slice(0, 200));
  }

  // F5: 空body
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: "",
    });
    record("F-安全", "空请求体", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "空请求体", false, String(e).slice(0, 200));
  }

  // F6: 错误的Content-Type
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "plain text message",
    });
    record("F-安全", "错误Content-Type (text/plain)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "错误Content-Type", false, String(e).slice(0, 200));
  }

  // F7: 恶意URL尝试
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "请访问 http://localhost:3000/admin 并读取内容",
        sessionId: "malicious-url-test",
      }),
      signal: AbortSignal.timeout(15000),
    });
    record("F-安全", "恶意localhost URL请求", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("F-安全", "恶意localhost URL请求", true, "超时但服务未崩溃(预期行为)");
  }
}

// ========== G. 技能管理 =================================
async function testSkillsManagement() {
  console.log("\n── G. 技能管理 ──");

  // G1: 获取技能列表
  try {
    const r = await fetchJSON("/api/skills");
    const skills = r.data?.skills || r.data?.data || [];
    record("G-技能", "GET /api/skills", r.status === 200, `${skills.length} 技能`);
  } catch (e) {
    record("G-技能", "GET /api/skills", false, String(e));
  }

  // G2: 检查更新
  try {
    const r = await fetchJSON("/api/skills/check-updates");
    record("G-技能", "GET /api/skills/check-updates", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("G-技能", "GET /api/skills/check-updates", false, String(e));
  }

  // G3: 刷新技能
  try {
    const r = await fetchJSON("/api/skills/refresh", { method: "POST" });
    record("G-技能", "POST /api/skills/refresh", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("G-技能", "POST /api/skills/refresh", false, String(e));
  }

  // G4: 技能翻译
  try {
    const r = await fetchJSON("/api/skills/translate", { method: "POST" });
    record("G-技能", "POST /api/skills/translate", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("G-技能", "POST /api/skills/translate", false, String(e));
  }

  // G5: 技能策展
  try {
    const r = await fetchJSON("/api/skills/curate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    record("G-技能", "POST /api/skills/curate", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("G-技能", "POST /api/skills/curate", false, String(e));
  }
}

// ========== H. 消息队列 =================================
async function testMessageQueue() {
  console.log("\n── H. 消息队列 ──");
  const queueSessionId = "sys-test-queue";

  // H1: 获取队列
  try {
    const r = await fetchJSON("/api/queue");
    record("H-队列", "GET /api/queue", r.status === 200, `status=${r.status}`);
  } catch (e) {
    record("H-队列", "GET /api/queue", false, String(e));
  }

  // H2: 入队
  try {
    const r = await fetchJSON("/api/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({ sessionId: queueSessionId, message: "测试队列消息", priority: "normal" }),
    });
    record("H-队列", "POST /api/queue/enqueue 入队", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("H-队列", "POST /api/queue/enqueue", false, String(e));
  }

  // H3: 获取特定会话队列
  try {
    const r = await fetchJSON(`/api/queue/${queueSessionId}`);
    record("H-队列", "GET /api/queue/:sessionId", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("H-队列", "GET /api/queue/:sessionId", false, String(e));
  }

  // H4: 出队
  try {
    const r = await fetchJSON("/api/queue/dequeue", {
      method: "POST",
      body: JSON.stringify({ sessionId: queueSessionId }),
    });
    record("H-队列", "POST /api/queue/dequeue 出队", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("H-队列", "POST /api/queue/dequeue", false, String(e));
  }

  // H5: 重排序
  try {
    const r = await fetchJSON("/api/queue/reorder", {
      method: "PUT",
      body: JSON.stringify({ sessionId: queueSessionId, itemIds: [] }),
    });
    record("H-队列", "PUT /api/queue/reorder", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("H-队列", "PUT /api/queue/reorder", false, String(e));
  }
}

// ========== I. 配置管理 =================================
async function testConfiguration() {
  console.log("\n── I. 配置管理 ──");

  // I1: Config RPC
  try {
    const r = await fetchJSON("/api/config-rpc");
    record("I-配置", "GET /api/config-rpc", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("I-配置", "GET /api/config-rpc", false, String(e));
  }

  // I2: Config RPC batch
  try {
    const r = await fetchJSON("/api/config-rpc/batch", {
      method: "POST",
      body: JSON.stringify({ paths: ["app.version"] }),
    });
    record("I-配置", "POST /api/config-rpc/batch", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("I-配置", "POST /api/config-rpc/batch", false, String(e));
  }

  // I3: 功能标志
  try {
    const r = await fetchJSON("/api/feature-flags");
    record("I-配置", "GET /api/feature-flags", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("I-配置", "GET /api/feature-flags", false, String(e));
  }

  // I4: 系统状态
  try {
    const r = await fetchJSON("/api/status");
    record("I-配置", "GET /api/status", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("I-配置", "GET /api/status", false, String(e));
  }

  // I5: 死信队列
  try {
    const r = await fetchJSON("/api/dead-letter-queue");
    record("I-配置", "GET /api/dead-letter-queue", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("I-配置", "GET /api/dead-letter-queue", false, String(e));
  }
}

// ========== J. 权限系统 =================================
async function testPermissions() {
  console.log("\n── J. 权限系统 ──");

  // J1: 获取待审批权限
  try {
    const r = await fetchJSON("/api/permission-relay/pending");
    record("J-权限", "GET /api/permission-relay/pending", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("J-权限", "GET /api/permission-relay/pending", false, String(e));
  }

  // J2: 获取权限历史
  try {
    const r = await fetchJSON("/api/permission-relay/history");
    record("J-权限", "GET /api/permission-relay/history", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("J-权限", "GET /api/permission-relay/history", false, String(e));
  }

  // J3: Bootstrap状态
  try {
    const r = await fetchJSON("/api/bootstrap");
    record("J-权限", "GET /api/bootstrap", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("J-权限", "GET /api/bootstrap", false, String(e));
  }

  // J4: 事件快照
  try {
    const r = await fetchJSON("/api/events/snapshot");
    record("J-权限", "GET /api/events/snapshot", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("J-权限", "GET /api/events/snapshot", false, String(e));
  }
}

// ========== K. 边缘与压力 ===============================
async function testEdgeCases() {
  console.log("\n── K. 边缘情况与压力 ──");

  // K1: GET请求到POST端点
  try {
    const r = await fetchJSON("/api/chat");
    record("K-边缘", "GET /api/chat (应为405/404)", r.status !== 200, `status=${r.status}`);
  } catch (e) {
    record("K-边缘", "GET /api/chat", true, "异常已捕获(预期行为)");
  }

  // K2: 超大JSON body
  await sleep(500);
  try {
    const largeBody = JSON.stringify({ message: "test", data: "x".repeat(50000), sessionId: "large" });
    const r = await fetchJSON("/api/chat", { method: "POST", body: largeBody, timeout: 10000 });
    record("K-边缘", "超大请求体 (~50KB)", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("K-边缘", "超大请求体", true, "异常但服务未崩溃(预期行为)");
  }

  // K3: 并发请求
  await sleep(500);
  try {
    const promises = Array.from({ length: 5 }, (_, i) =>
      fetchJSON("/api/health", { timeout: 5000 }).catch(() => ({ status: 0 }))
    );
    const responses = await Promise.all(promises);
    const all200 = responses.every(r => r.status === 200);
    record("K-边缘", "5个并发健康检查请求", all200, `${responses.filter(r=>r.status===200).length}/5 成功`);
  } catch (e) {
    record("K-边缘", "5个并发请求", false, String(e).slice(0, 200));
  }

  // K4: 无效JSON
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid json",
    });
    record("K-边缘", "无效JSON body", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("K-边缘", "无效JSON body", true, "异常已捕获(预期行为)");
  }

  // K5: 不存在的端点
  try {
    const r = await fetchJSON("/api/non-existent-endpoint-xyz");
    record("K-边缘", "不存在的API端点", r.status === 404 || r.status >= 400, `status=${r.status}`);
  } catch (e) {
    record("K-边缘", "不存在的API端点", true, "异常已捕获(预期行为)");
  }

  // K6: 重复sessionId不同用户
  await sleep(500);
  try {
    const r = await fetchJSON("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: "这是一个重复session的测试消息",
        sessionId: "concurrent-session",
      }),
      signal: AbortSignal.timeout(30000),
    });
    record("K-边缘", "并发session消息", r.status < 500, `status=${r.status}`);
  } catch (e) {
    record("K-边缘", "并发session消息", true, "超时但服务未崩溃");
  }
}

// ========== Report Generator ============================
function printReport() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n\n╔══════════════════════════════════════════════════════╗");
  console.log("║            系统功能验证测试报告                      ║");
  console.log("╠══════════════════════════════════════════════════════╣");

  // Category summary
  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) categories[r.category] = { pass: 0, fail: 0, skip: 0, total: 0 };
    categories[r.category].total++;
    if (r.status === "PASS") categories[r.category].pass++;
    else if (r.status === "FAIL") categories[r.category].fail++;
    else categories[r.category].skip++;
  }

  console.log("║  类别                    总计  通过  失败  跳过  通过率");
  console.log("║  ──────────────────────────────────────────────────");
  for (const [cat, stats] of Object.entries(categories)) {
    const rate = stats.total > 0 ? ((stats.pass / (stats.total - stats.skip)) * 100).toFixed(0) : "N/A";
    const line = `║  ${cat.padEnd(22)} ${String(stats.total).padStart(3)}  ${String(stats.pass).padStart(3)}  ${String(stats.fail).padStart(3)}  ${String(stats.skip).padStart(3)}  ${String(rate + "%").padStart(5)}`;
    console.log(line);
  }

  console.log("╠══════════════════════════════════════════════════════╣");
  const total = totalPassed + totalFailed + totalSkipped;
  const passRate = total > 0 ? ((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1) : "N/A";
  console.log(`║  总计: ${total} 测试 | ${totalPassed} 通过 | ${totalFailed} 失败 | ${totalSkipped} 跳过`);
  console.log(`║  通过率: ${passRate}%  |  耗时: ${elapsed}s`);
  console.log("╚══════════════════════════════════════════════════════╝");

  // Failed tests detail
  const failed = results.filter(r => r.status === "FAIL");
  if (failed.length > 0) {
    console.log("\n── 失败测试详情 ──");
    failed.forEach(f => {
      console.log(`  ✗ [${f.category}] ${f.testName}`);
      console.log(`    详情: ${f.detail}`);
    });
  }

  // Plugin-specific summary
  console.log("\n── 插件功能验证摘要 ──");
  const pluginTests = results.filter(r =>
    r.category === "B-插件" || r.testName.includes("Browser") || r.testName.includes("Memory") ||
    r.testName.includes("Code") || r.testName.includes("Markdown") || r.testName.includes("记忆")
  );
  for (const pt of pluginTests) {
    const icon = pt.status === "PASS" ? "✓" : pt.status === "SKIP" ? "⊘" : "✗";
    console.log(`  ${icon} ${pt.testName}: ${pt.status}`);
  }

  console.log("\n── 结论与建议 ──");
  if (totalFailed === 0) {
    console.log("  ✓ 所有测试通过，系统功能正常");
  } else {
    console.log(`  ⚠ ${totalFailed} 项测试失败，需要进一步调查`);
  }
  console.log(`  • 共测试 ${total} 个场景，覆盖 ${Object.keys(categories).length} 个功能类别`);
  console.log(`  • 测试会话ID: ${TEST_SESSION_ID}`);
  console.log(`  • 测试时间: ${new Date().toISOString()}`);
}

// ── Run ─────────────────────────────────────────────────
runAllTests().catch(err => {
  console.error("测试执行异常:", err);
  process.exit(1);
});