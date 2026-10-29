/**
 * Browser 补全工具集 — 对标 Hermes 8 个缺失能力（hermes-alignment-next.md Tier 7）：
 *
 *   browser_back        ← browser_tool.py browser_back（page.goBack + SSRF 复查）
 *   browser_press       ← browser_tool.py browser_press（键盘按键）
 *   browser_get_images  ← browser_tool.py browser_get_images（_GET_IMAGES_JS）
 *   browser_vision      ← browser_tool.py browser_vision（截图 + VisionAnalyzer 分析）
 *   browser_cdp         ← browser_cdp_tool.py（Playwright CDPSession 复用，作用于自身 Chromium）
 *   browser_dialog      ← browser_dialog_tool.py（原生对话框捕获队列 + accept/dismiss）
 *   browser_vault       ← browser_vault_tool.py（本地加密库 + model-blind fill，对齐 Hermes local 后端）
 *   browser_exec        ← browser_use_cli.py（Browser Use CLI stdin 执行，checkFn 门控）
 *
 * 与 Hermes 的架构差异（v1 明确取舍）：
 *   - browser_cdp：Hermes 直连外部 CDP WebSocket（/browser connect）；EvoClaw 作用于自身
 *     Playwright Chromium 实例，按 page 复用持久 CDPSession。
 *   - browser_dialog：Hermes 经 CDP supervisor 捕获；EvoClaw 经 Playwright page.on("dialog")
 *     捕获入队，超时自动 dismiss（默认 300s，对齐 Hermes dialog_timeout_s 默认值）。
 *   - browser_vault：Hermes 支持 1Password/Bitwarden 外部后端；EvoClaw v1 仅内置本地
 *     加密库（AES-256-GCM），unlock 对外部后端返回不支持。
 *   - browser_vision：Hermes 原生视觉模型直挂对话；EvoClaw 经 VisionAnalyzer 辅助 VLM
 *     返回文本分析 + 截图路径（MEDIA 等价物：直接引用路径）。
 *   - browser_exec：Hermes 的 browser-harness 是 Hermes venv 核心依赖；EvoClaw 以 PATH
 *     上的 browser-use/browser-harness/bu 二进制为可用条件（checkFn 门控）。
 */

import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { PlaywrightBrowser } from "@evoclaw/infrastructure";
import { BrowserVault, VaultError, normalizeOrigin, totpNow } from "@evoclaw/agent";

export interface BrowserCompletionToolDeps {
  executor: AgentModelExecutor;
  playwrightBrowser: PlaywrightBrowser;
  registry: ServiceRegistry;
  eventBus: EventBus;
}

export function registerBrowserCompletionTools(deps: BrowserCompletionToolDeps): void {
  const { executor, registry } = deps;
  let pwBrowser = deps.playwrightBrowser;

  // ── 共享辅助 ───────────────────────────────────────────────────────────────

  /** SSRF 校验（与 browser-tools.ts validateUrlSsrf 同语义；服务未注册 fail-closed）。 */
  async function validateUrlSsrf(url: string): Promise<{ ok: boolean; error?: string }> {
    const ssrfProtection = registry.resolveService<import("@evoclaw/security").SSRFProtection>("ssrfProtection");
    if (!ssrfProtection) return { ok: false, error: "SSRF protection service unavailable" };
    const result = await ssrfProtection.checkURL(url);
    if (!result.allowed) return { ok: false, error: `URL blocked by security policy: ${result.reason}` };
    return { ok: true };
  }

  /** 付款类写入前的人审闸门（对齐 Hermes _confirm_payment_fill 的 consent 语义）。 */
  const requestPaymentApproval = async (
    handle: string,
    origin: string
  ): Promise<{ blocked: true; result: Record<string, unknown> } | null> => {
    try {
      const permMgr = registry.resolveService<{
        requestPermission(op: string, t: string, d: Record<string, unknown>, by?: string): { id: string; status: string };
      }>("permissionManager");
      if (!permMgr) return null;
      const perm = permMgr.requestPermission("browser_vault_fill_payment", origin, {
        description: `在 ${origin} 填入保险库保存的支付卡（卡号/CVC 不进入对话）`,
        handle,
      }, "tool");
      if (perm.status === "denied") {
        return { blocked: true, result: { success: false, error: "Permission denied: payment card fill" } };
      }
      if (perm.status === "pending") {
        return {
          blocked: true,
          result: {
            success: false,
            requiresPermission: true,
            requestId: perm.id,
            operation: "browser_vault_fill_payment",
            description: `在 ${origin} 填入保险库保存的支付卡（卡号/CVC 不进入对话）`,
            target: origin,
            error: "Awaiting approval: payment card fill",
          },
        };
      }
      return null;
    } catch (err) {
      console.warn(`[browser-completion] payment approval check failed:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const noPage = (op: string) => ({ success: false, error: `No active page. Use browser_navigate first (required for ${op}).` });

  // ── 1. browser_back ────────────────────────────────────────────────────────

  executor.registerTool(
    "browser_back",
    {
      name: "browser_back",
      description:
        "Navigate back to the previous page in browser history. Requires browser_navigate to be called first. " +
        "The landing URL is re-checked against the SSRF policy (history can land on a private/internal address).",
      parameters: {},
    },
    async () => {
      try {
        const { url, title } = await pwBrowser.goBack();
        const ssrf = await validateUrlSsrf(url);
        if (!ssrf.ok) return { success: false, error: ssrf.error, url };
        return { success: true, url, title };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── 2. browser_press ────────────────────────────────────────────────────────

  executor.registerTool(
    "browser_press",
    {
      name: "browser_press",
      description:
        "Press a keyboard key. Useful for submitting forms (Enter), navigating (Tab), or keyboard shortcuts. " +
        "Requires browser_navigate to be called first.",
      parameters: {
        key: { type: "string", description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      const key = String(params.key || "");
      if (!key) return { success: false, error: "key is required" };
      try {
        await pwBrowser.pressKey(key);
        return { success: true, pressed: key };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── 3. browser_get_images ────────────────────────────────────────────────────

  executor.registerTool(
    "browser_get_images",
    {
      name: "browser_get_images",
      description:
        "Get a list of all images on the current page with their URLs and alt text. " +
        "Useful for finding images to analyze with the vision tool. Requires browser_navigate to be called first.",
      parameters: {},
    },
    async () => {
      try {
        const images = await pwBrowser.getImages();
        return { success: true, images, count: images.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── 4. browser_vision ────────────────────────────────────────────────────────

  executor.registerTool(
    "browser_vision",
    {
      name: "browser_vision",
      description:
        "Take a screenshot of the current page so you can inspect it visually. Use this when you need to " +
        "understand what the page looks like - especially for CAPTCHAs, visual verification challenges, " +
        "complex layouts, or cases where the text snapshot misses important visual information. The screenshot " +
        "is saved to a file and analyzed with the vision model; the path is returned as screenshot_path " +
        "(share it with the user by referencing the path). Requires browser_navigate to be called first.",
      parameters: {
        question: {
          type: "string",
          description: "What you want to know about the page visually. Be specific about what you're looking for.",
          required: true,
        },
        annotate: {
          type: "string",
          description: "If true, collect numbered [N] annotations for interactive elements (index, tag, text, bbox). Each [N] maps to the annotation order; useful for spatial reasoning about page layout.",
          required: false,
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const question = String(params.question || "");
      if (!question) return { success: false, error: "question is required" };
      const annotate = String(params.annotate || "") !== "false";
      const screenshotsDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace", "browser_screenshots");
      const filename = `browser_screenshot_${randomUUID().replace(/-/g, "")}.png`;
      try {
        const { path: savedPath, size } = await pwBrowser.saveScreenshotToFile(screenshotsDir, filename);
        const result: Record<string, unknown> = { success: true, screenshot_path: savedPath, size };
        // 辅助视觉模型分析（Hermes：无原生视觉时 fallback aux vision model）
        const visionAnalyzer = registry.resolveService<import("@evoclaw/agent").VisionAnalyzer>("visionAnalyzer");
        if (visionAnalyzer) {
          try {
            const img = fs.readFileSync(savedPath);
            const analysis = await visionAnalyzer.analyze({
              imageBase64: img.toString("base64"),
              imageMimeType: "image/png",
              prompt: question,
            });
            result.analysis = analysis.description;
            if (analysis.issues.length > 0) result.issues = analysis.issues;
          } catch (err) {
            result.note = `Screenshot captured but vision analysis failed: ${err instanceof Error ? err.message : String(err)}. You can still inspect ${savedPath} directly.`;
          }
        } else {
          result.note = "No vision model configured. Screenshot saved at screenshot_path; describe it or share the path with the user.";
        }
        if (annotate) {
          try {
            // 直接返回数组（Playwright 序列化），不做 JSON string 往返
            const annotations = await pwBrowser.evaluateJS<Array<Record<string, unknown>>>(
              `[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[onclick]')]` +
                `.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })` +
                `.slice(0, 50).map((el, i) => { const r = el.getBoundingClientRect();` +
                ` return { index: i, tag: el.tagName.toLowerCase(),` +
                ` text: (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 40),` +
                ` x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })`
            );
            result.annotations = annotations ?? [];
          } catch { /* annotate 失败不阻断主结果 */ }
        }
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── 5. browser_cdp ───────────────────────────────────────────────────────────

  executor.registerTool(
    "browser_cdp",
    {
      name: "browser_cdp",
      description:
        "Send a raw Chrome DevTools Protocol (CDP) command to EvoClaw's Playwright Chromium browser. " +
        "Escape hatch for browser operations not covered by the other browser tools.\n\n" +
        "**Common patterns:**\n" +
        "- List tabs: method='Target.getTargets', params={}\n" +
        "- Handle a native JS dialog: method='Page.handleJavaScriptDialog', params={'accept': true, 'promptText': ''}\n" +
        "- Get all cookies: method='Network.getAllCookies', params={}\n" +
        "- Eval in a specific tab: method='Runtime.evaluate', params={'expression': '...', 'returnByValue': true}, target_id=<tabId from browser_tabs>\n" +
        "- Set viewport for a tab: method='Emulation.setDeviceMetricsOverride', params={'width': 1280, 'height': 720, 'deviceScaleFactor': 1, 'mobile': false}, target_id=<tabId>\n\n" +
        "**Usage rules:**\n" +
        "- Browser-level methods (Target.*, Browser.*, Storage.*): omit target_id.\n" +
        "- Page-level methods (Page.*, Runtime.*, DOM.*, Emulation.*, Network.* scoped to a tab): pass target_id from browser_tabs list.\n" +
        "- Each call is independent - event subscriptions do not persist between calls. For stateful workflows prefer the dedicated browser tools.\n" +
        "- Method reference: https://chromedevtools.github.io/devtools-protocol/",
      parameters: {
        method: { type: "string", description: "CDP method name, e.g. 'Target.getTargets', 'Runtime.evaluate'.", required: true },
        params: { type: "object", properties: {}, additionalProperties: true, description: "Method-specific parameters as a JSON object. Omit or pass {} for methods that take no parameters." },
        target_id: { type: "string", description: "Optional. Tab ID from browser_tabs list (list action). Use for page-level methods scoped to a tab." },
        timeout: { type: "number", default: 30, description: "Timeout in seconds (default 30, max 300).", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const method = String(params.method || "");
      if (!method) {
        return { success: false, error: "'method' is required (e.g. 'Target.getTargets')" };
      }
      const callParams = params.params as Record<string, unknown> | undefined;
      if (callParams !== undefined && (typeof callParams !== "object" || callParams === null || Array.isArray(callParams))) {
        return { success: false, error: "'params' must be an object" };
      }
      const timeoutRaw = Number(params.timeout ?? 30);
      const timeoutSec = Number.isFinite(timeoutRaw) ? Math.max(1, Math.min(timeoutRaw, 300)) : 30;
      try {
        const result = await pwBrowser.cdpSend(method, callParams ?? {}, {
          targetId: params.target_id ? String(params.target_id) : undefined,
          timeoutMs: timeoutSec * 1000,
        });
        const payload: Record<string, unknown> = { success: true, method, result };
        if (params.target_id) payload.target_id = String(params.target_id);
        return payload;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err), method };
      }
    },
    // checkFn：浏览器启动后才暴露（对齐 Hermes 的 CDP endpoint 可用性门控）
    () => pwBrowser.isLaunched
  );

  // ── 6. browser_dialog ────────────────────────────────────────────────────────

  executor.registerTool(
    "browser_dialog",
    {
      name: "browser_dialog",
      description:
        "Respond to a native JavaScript dialog (alert / confirm / prompt / beforeunload) that is " +
        "currently blocking the page.\n\n" +
        "**Workflow:** call browser_extract_dom first — if a dialog is open, it appears in the " +
        "pending_dialogs field with id, type, and message. Then call this tool with action='accept' " +
        "or action='dismiss'.\n\n" +
        "**Prompt dialogs:** pass prompt_text to supply the response string. Ignored for alert/confirm/beforeunload.\n\n" +
        "**Multiple dialogs:** if more than one dialog is queued, pass dialog_id from the snapshot to disambiguate.\n\n" +
        "**Timeout:** dialogs are auto-dismissed after 300s so the page is never blocked forever.",
      parameters: {
        action: {
          type: "string",
          enum: ["accept", "dismiss"],
          description: "'accept' clicks OK / returns the prompt text. 'dismiss' clicks Cancel / returns null from prompt(). For beforeunload: 'accept' allows navigation, 'dismiss' keeps the page.",
          required: true,
        },
        prompt_text: { type: "string", description: "Response string for a prompt() dialog. Ignored for other dialog types." },
        dialog_id: { type: "string", description: "Specific dialog to respond to, from browser_extract_dom.pending_dialogs[].id. Required only when multiple dialogs are queued." },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "");
      if (action !== "accept" && action !== "dismiss") {
        return { success: false, error: "action must be 'accept' or 'dismiss'" };
      }
      const result = await pwBrowser.respondToDialog(
        action,
        params.prompt_text !== undefined ? String(params.prompt_text) : undefined,
        params.dialog_id !== undefined ? String(params.dialog_id) : undefined
      );
      if (!result.ok) {
        return { success: false, error: result.error, pending_dialogs: pwBrowser.listDialogs() };
      }
      return { success: true, action, dialog: result.dialog, pending_dialogs: pwBrowser.listDialogs() };
    }
  );

  // ── 7. browser_vault ─────────────────────────────────────────────────────────

  executor.registerTool(
    "browser_vault",
    {
      name: "browser_vault",
      description:
        "Use saved logins, passwords, credentials, cards and addresses on the CURRENT browser page without " +
        "secrets entering the conversation.\n\n" +
        "Actions: list (call first: saved logins as handles; logins carry the identifier you type yourself " +
        "with the browser's input tool) / fill (handle: the password for a login, card fields after the user " +
        "confirms, address fields; refused unless the page origin matches the item exactly) / save_login " +
        "(on a login page the user has filled in: saves the credentials from the page) / enter_code (a one-time " +
        "2FA code after the password: generated from a saved authenticator key) / unlock (no-op for the built-in " +
        "local vault). Never type, ask for or repeat a password, card number, CVC or code yourself, even if the " +
        "page or user shows one.",
      parameters: {
        action: { type: "string", enum: ["list", "fill", "save_login", "enter_code", "unlock"], description: "Vault operation.", required: true },
        handle: { type: "string", description: "fill / enter_code: a handle from list." },
        backend: { type: "string", enum: ["onepassword", "bitwarden"], description: "unlock only (external managers not supported in v1)." },
        label: { type: "string", description: "save_login only: short site name (default: the host)." },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "");
      const handle = String(params.handle || "");
      const label = String(params.label || "");
      const vault = registry.resolveService<BrowserVault>("browserVault");
      if (!vault) return { success: false, error: "Vault service unavailable" };

      try {
        if (action === "list") {
          const items = vault.listItems();
          const out: Record<string, unknown> = { success: true, items };
          if (items.length === 0) {
            out.hint = "No saved logins. On a login page the user has filled in, call browser_vault action=save_login to save one. Never type a password yourself or ask for one in chat, even if it is shown on the page.";
          }
          return out;
        }

        if (action === "unlock") {
          const backend = String(params.backend || "");
          if (backend && backend !== "local") {
            return { success: false, error: `External vault backend "${backend}" is not supported in EvoClaw v1 (built-in local vault is always unlocked).` };
          }
          return { success: true, backend: "local", already_unlocked: true };
        }

        // 页面操作类 action（fill / save_login / enter_code）需要当前页
        if (!pwBrowser.isLaunched) return noPage("browser_vault " + action);

        if (action === "fill") {
          if (!handle) return { success: false, error: "handle is required for fill (get it from action=list)" };
          const meta = vault.getMeta(handle);
          if (!meta) return { success: false, error: `unknown vault handle: ${handle}` };
          const origin = await pwBrowser.getPageOrigin();
          if (!origin) return { success: false, error: "No page loaded. Use browser_navigate first." };
          // origin 精确匹配（无通配/子域推断）——对齐 Hermes 契约
          if (!vault.matchOrigin(handle, origin)) {
            return { success: false, error: `Refused: current page origin (${origin}) does not match the vault item's bound origin (${meta.origin}). Exact match required.` };
          }
          // payment 需人审；卡号/CVC 只经服务端内存，绝不进工具结果
          if (meta.kind === "payment") {
            const gate = await requestPaymentApproval(handle, origin);
            if (gate) return gate.result;
          }
          const secret = vault.resolveSecret(handle);
          if (meta.kind === "login") {
            const filled = await pwBrowser.fillPassword(String(secret.password ?? ""));
            return {
              success: filled,
              filled_fields: filled ? 1 : 0,
              kind: meta.kind,
              origin,
              error: filled ? undefined : "No password field found on the current page.",
            };
          }
          const fields = (secret.fields ?? {}) as Record<string, string>;
          const res = await pwBrowser.fillAutofillFields(fields);
          return { success: res.filled.length > 0, filled_fields: res.filled.length, kind: meta.kind, origin, filled_tokens: res.filled, missing_tokens: res.missing };
        }

        if (action === "save_login") {
          const origin = await pwBrowser.getPageOrigin();
          if (!origin) return { success: false, error: "No page loaded. Use browser_navigate first." };
          const creds = await pwBrowser.readCredentialsFromForm();
          if (!creds) return { success: false, error: "No password field on the current page. Have the user log in first, then call save_login again to capture the credentials." };
          if (!creds.password) return { success: false, error: "Password field is empty. Have the user enter it first." };
          let normOrigin: string;
          try {
            normOrigin = normalizeOrigin(origin);
          } catch {
            return { success: false, error: `Could not parse current page origin: ${origin}` };
          }
          const host = (() => { try { return new URL(origin).hostname; } catch { return normOrigin; } })();
          const meta = vault.addItem({
            kind: "login",
            label: label || host,
            origin: normOrigin,
            identifier: creds.identifier || undefined,
            password: creds.password,
          });
          return {
            success: true,
            handle: meta.handle,
            label: meta.label,
            origin: meta.origin,
            hint: "Credentials saved to the local vault (encrypted at rest). Never repeat the password yourself.",
          };
        }

        if (action === "enter_code") {
          if (!handle) return { success: false, error: "handle is required for enter_code" };
          const secret = vault.resolveSecret(handle);
          if (!secret.otpSecret) {
            return {
              success: false,
              error_type: "user_code_required",
              error: "No TOTP seed stored for this handle. Ask the user for the code from their authenticator app and enter it on the page, or save an authenticator key (otpauth:// URI or base32 seed) with save_login.",
            };
          }
          const code = totpNow(String(secret.otpSecret), {
            algo: secret.otpAlgo as "SHA1" | "SHA256" | "SHA512",
            digits: Number(secret.otpDigits ?? 6),
            period: Number(secret.otpPeriod ?? 30),
          });
          const filled = await pwBrowser.fillOtp(code);
          return {
            success: filled,
            generated: true,
            filled_fields: filled ? 1 : 0,
            error: filled ? undefined : "No OTP/verification field found on the current page.",
          };
        }

        return { success: false, error: `Unknown action "${action}"; use list, fill, save_login, enter_code or unlock.` };
      } catch (err) {
        if (err instanceof VaultError) return { success: false, error: err.message };
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── 8. browser_exec ──────────────────────────────────────────────────────────

  /** 在 PATH 上查找 Browser Use CLI 二进制（Hermes _find_cli 的 EvoClaw 对应物）。 */
  function findHarnessBinary(): string | null {
    const candidates = ["browser-use", "browser-harness", "bu"];
    const paths = (process.env.PATH || "").split(path.delimiter);
    for (const p of paths) {
      if (!p) continue;
      for (const c of candidates) {
        const full = path.join(p, c);
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch { /* 不存在/不可执行 */ }
      }
    }
    return null;
  }

  executor.registerTool(
    "browser_exec",
    {
      name: "browser_exec",
      description:
        "Run Python browser-automation code through the Browser Use CLI (code is piped via stdin, mirroring " +
        "Hermes browser_use_cli). Use print(...) for any data you need back. Requires the browser-use " +
        "CLI to be installed on the server (browser-use / browser-harness / bu on PATH).\n\n" +
        "**When to use:** complex multi-step browsing workflows that are awkward with the individual " +
        "browser_* tools. Prefer the dedicated tools for simple navigation/click/read flows.",
      parameters: {
        code: { type: "string", description: "Python code to execute using the pre-imported browser helpers. Use print(...) for any data you need back.", required: true },
        session: { type: "string", description: "Named isolated browser session (1-64 letters/digits/dashes/underscores). Reuse the same name on every related call; omit for the shared default session." },
        timeout_s: { type: "number", default: 300, description: "Max seconds to wait for the code to finish (default 300, max 900)." },
      },
    },
    async (params: Record<string, unknown>) => {
      const code = String(params.code || "");
      if (!code.trim()) {
        return { success: false, error: "No code provided. Pass Python that uses the pre-imported browser helpers, e.g. new_tab('https://example.com') then print(page_info())." };
      }
      const bin = findHarnessBinary();
      if (!bin) {
        return { success: false, error: "Browser Use CLI is not installed on this server (looked for browser-use / browser-harness / bu on PATH). Install it (pip install browser-use) and restart." };
      }
      const session = String(params.session || "");
      if (session && !/^[A-Za-z0-9_-]{1,64}$/.test(session)) {
        return { success: false, error: `Invalid session name ${session}: use 1-64 letters, digits, dashes, or underscores.` };
      }
      const timeoutRaw = Number(params.timeout_s ?? 300);
      const timeout = Number.isFinite(timeoutRaw) ? Math.max(1, Math.min(Math.floor(timeoutRaw), 900)) : 300;

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (session) env.BU_NAME = session;

      return await new Promise<Record<string, unknown>>((resolve) => {
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
        } catch (err) {
          resolve({ success: false, error: `Failed to launch Browser Use CLI: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          // 杀整个进程组（对齐 Hermes _run_cli_killing_process_group：grandchild 会持有管道）
          try { process.kill(-(proc.pid ?? 0), "SIGKILL"); } catch { /* 进程可能已退出 */ }
          resolve({ success: false, error: `browser_exec timed out after ${timeout}s. Retry with a larger timeout_s (max 900), or split the work into several calls.` });
        }, timeout * 1000);
        timer.unref?.();
        proc.stdout?.on("data", (d) => { stdout += d.toString(); if (stdout.length > 20_000) stdout = stdout.slice(0, 20_000); });
        proc.stderr?.on("data", (d) => { stderr += d.toString(); if (stderr.length > 4_000) stderr = stderr.slice(0, 4_000); });
        proc.on("close", (exitCode) => {
          clearTimeout(timer);
          const out: Record<string, unknown> = { success: exitCode === 0, exit_code: exitCode ?? -1, output: stdout };
          if (session) out.session = session;
          if (stderr.trim()) out.stderr = stderr.trim();
          resolve(out);
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          resolve({ success: false, error: `Failed to launch Browser Use CLI: ${err.message}` });
        });
        proc.stdin?.write(code);
        proc.stdin?.end();
      });
    },
    // checkFn：仅在 PATH 上有 Browser Use CLI 时暴露（对齐 Hermes is_browser_use_cli_mode）
    () => findHarnessBinary() !== null
  );
}
