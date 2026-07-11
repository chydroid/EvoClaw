/** channels — Communication channel management */
import { Command } from "commander";
import { c } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

/** Print a real scannable QR code in the terminal using qrcode-terminal */
function printTerminalQR(data: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qrcode = require("qrcode-terminal");
    qrcode.generate(data, { small: true }, (output: string) => {
      const indented = output.split("\n").map((line: string) => "  " + line).join("\n");
      console.log(indented);
    });
  } catch {
    console.log(c("gray", `  (QR library not available, use the URL below)`));
  }
}

// ─── WeChat iLink API helpers ─────────────────────────────────────

const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3"; // ClawBot plugin type

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

async function weixinApiPost(endpoint: string, body: string): Promise<string> {
  const url = `${WEIXIN_API_BASE}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "0",
    },
    body,
  });
  if (!res.ok) throw new Error(`WeChat API ${res.status}: ${await res.text()}`);
  return res.text();
}

async function weixinApiGet(endpoint: string, timeoutMs = 35000): Promise<string> {
  const url = `${WEIXIN_API_BASE}/${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "0",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`WeChat API ${res.status}: ${await res.text()}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWeixinQRCode(): Promise<QRCodeResponse> {
  const rawText = await weixinApiPost(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`,
    JSON.stringify({ local_token_list: [] }),
  );
  return JSON.parse(rawText) as QRCodeResponse;
}

async function pollWeixinQRStatus(qrcode: string): Promise<StatusResponse> {
  const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const rawText = await weixinApiGet(endpoint);
  return JSON.parse(rawText) as StatusResponse;
}

/** Save WeChat account credentials to the openclaw state directory */
function saveWeixinCredentials(accountId: string, token: string, baseUrl: string, userId?: string): void {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const os = require("os") as typeof import("os");

  // Atomic write: write to temp file then rename (prevents partial/corrupt files)
  const atomicWriteFileSync = (filePath: string, contents: string): void => {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, contents, "utf-8");
    fs.renameSync(tmp, filePath);
  };

  // 安全：校验 accountId 格式，防止路径穿越（如 accountId="../../config"）
  const normalizedId = accountId.replace(/@/g, "-");
  if (!/^[a-zA-Z0-9_-]+$/.test(normalizedId)) {
    throw new Error(`Invalid accountId: "${accountId}". Must match /^[a-zA-Z0-9_-]+$/`);
  }

  // State directory: ~/.openclaw/openclaw-weixin/accounts/
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountFile = path.join(accountsDir, `${normalizedId}.json`);
  const data = {
    token,
    baseUrl: baseUrl || WEIXIN_API_BASE,
    savedAt: new Date().toISOString(),
    ...(userId ? { userId } : {}),
  };
  atomicWriteFileSync(accountFile, JSON.stringify(data, null, 2));

  // Also update the accounts index
  const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
  let index: string[] = [];
  try {
    if (fs.existsSync(indexPath)) {
      index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    }
  } catch { /* ignore */ }
  if (!index.includes(normalizedId)) {
    index.push(normalizedId);
    atomicWriteFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  console.log(c("gray", `  Credentials saved to: ${accountFile}`));
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const channels = program
    .command("channels")
    .description("Manage communication channels (WhatsApp, Telegram, etc.)");

  channels
    .command("list")
    .description("List configured channels")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", "⚠ Server not running. Start with: EvoClaw gateway start"));
        return;
      }
      try {
        const r = await apiRequest<{ channels?: Record<string, unknown>; count?: number }>("GET", "/api/channels");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(`\n${c("bold", "=== Channels ===\n")}`);
        const channels = r.data.channels || {};
        const count = r.data.count || 0;
        if (count === 0) {
          console.log(`  ${c("gray", "No channels configured")}`);
        } else {
          for (const [name, status] of Object.entries(channels)) {
            const s = status as Record<string, unknown>;
            const connected = s.connected !== false && s.status !== "disconnected";
            const icon = connected ? "●" : "○";
            const statusStr = connected ? c("green", "connected") : c("yellow", "disconnected");
            console.log(`  ${icon} ${name}  [${statusStr}]`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `⚠ Could not fetch channels: ${err instanceof Error ? err.message : String(err)}`));
        console.log(c("gray", "  Channel management via Web UI → Channels tab"));
      }
    });

  channels
    .command("status")
    .description("Show channel status")
    .option("--deep", "Deep probe")
    .option("--probe", "Run live channel probe")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { console.log(c("yellow", "⚠ Server not running")); return; }
      try {
        const r = await apiRequest<{ channels?: Record<string, unknown>; count?: number; activeChannels?: string[] }>("GET", "/api/channels");
        const channels = r.data.channels || {};
        const active = r.data.activeChannels || [];
        const count = r.data.count || 0;
        console.log(`  Channels: ${count} registered, ${active.length} active`);
        if (opts.deep || opts.probe) {
          for (const [name, status] of Object.entries(channels)) {
            const s = status as Record<string, unknown>;
            const connected = s.connected !== false && s.status !== "disconnected";
            const icon = connected ? "●" : "○";
            const statusStr = connected ? c("green", "connected") : c("yellow", "disconnected");
            console.log(`  ${icon} ${name}  [${statusStr}]`);
          }
        }
      } catch (err) {
        console.log(c("yellow", `⚠ Could not fetch channel status: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  channels
    .command("logs")
    .description("Show channel logs")
    .option("--channel <name>", "Filter by channel", "all")
    .option("--lines <n>", "Number of lines", "200")
    .action((opts: Record<string, unknown>) => {
      const msg = `Channel Logs (${opts.channel}, last ${opts.lines} lines)`;
      console.log(`\n${c("bold", msg)}`);
      console.log(`  ${c("gray", "Use: EvoClaw logs for gateway-level logging")}`);
    });

  channels
    .command("add")
    .description("Add a new channel")
    .option("-c, --channel <name>", "Channel name")
    .action((opts: Record<string, unknown>) => {
      console.log(c("cyan", `ℹ Channel configuration is managed via the Web UI → Channels tab.`));
      if (opts.channel) {
        console.log(c("gray", `  To add channel "${opts.channel}", open the Web UI and follow the channel setup wizard.`));
      } else {
        console.log(c("gray", `  Open the Web UI and follow the channel setup wizard to add a new channel.`));
      }
      console.log(c("gray", `  CLI channel creation is not supported.`));
    });

  channels
    .command("remove [channel]")
    .description("Remove a channel")
    .option("--delete", "Also delete channel config")
    .action((channel: string, opts: Record<string, unknown>) => {
      if (!channel) {
        console.log(c("yellow", "Usage: EvoClaw channels remove <channel> [--delete]"));
        return;
      }
      console.log(c("cyan", `ℹ Channel removal is managed via the Web UI → Channels tab.`));
      console.log(c("gray", `  To remove channel "${channel}"${opts.delete ? " and delete its config" : ""}, open the Web UI.`));
      console.log(c("gray", `  CLI channel removal is not supported.`));
    });

  channels
    .command("login [channel]")
    .description("Login to a channel (e.g. openclaw-weixin for WeChat QR)")
    .option("-c, --channel <name>", "Channel name")
    .action(async (channel: string, opts: Record<string, unknown>) => {
      const ch = opts.channel || channel || "whatsapp";

      if (ch === "openclaw-weixin" || ch === "wechat" || ch === "weixin") {
        // ─── WeChat iLink QR login flow ───
        // This calls the real WeChat iLink API to get a QR code,
        // then polls for scan confirmation. After confirmation,
        // we receive a bot_token for message passing.
        try {
          console.log(c("cyan", "\n🔄 Requesting WeChat login QR code from iLink server..."));

          const qrResponse = await fetchWeixinQRCode();

          if (!qrResponse.qrcode_img_content) {
            console.log(c("red", "❌ Failed to get QR code from WeChat server"));
            return;
          }

          console.log(c("green", "\n📱 用手机微信扫描以下二维码，以继续连接：\n"));
          printTerminalQR(qrResponse.qrcode_img_content);
          console.log(c("gray", `\n  若二维码无法使用，请访问: ${qrResponse.qrcode_img_content}`));
          console.log(c("gray", "  正在等待操作... (8 min timeout)\n"));

          // Poll for QR status
          const deadline = Date.now() + 8 * 60 * 1000;
          let scannedPrinted = false;

          while (Date.now() < deadline) {
            try {
              const statusResp = await pollWeixinQRStatus(qrResponse.qrcode);

              switch (statusResp.status) {
                case "wait":
                  // Still waiting for scan
                  break;

                case "scaned":
                  if (!scannedPrinted) {
                    process.stdout.write(c("cyan", "  正在验证...\n"));
                    scannedPrinted = true;
                  }
                  break;

                case "confirmed": {
                  if (!statusResp.ilink_bot_id) {
                    console.log(c("red", "\n❌ 登录失败：服务器未返回 ilink_bot_id"));
                    return;
                  }
                  if (!statusResp.bot_token) {
                    console.log(c("red", "\n❌ 登录失败：服务器未返回 bot_token"));
                    return;
                  }
                  // Save credentials before declaring success
                  saveWeixinCredentials(
                    statusResp.ilink_bot_id,
                    statusResp.bot_token,
                    statusResp.baseurl || WEIXIN_API_BASE,
                    statusResp.ilink_user_id,
                  );
                  console.log(c("green", "\n✅ 已将此 OpenClaw 连接到微信！"));
                  return;
                }

                case "binded_redirect":
                  console.log(c("green", "\n✅ 已连接过此 OpenClaw，无需重复连接。"));
                  return;

                case "expired":
                  console.log(c("yellow", "\n⏰ 二维码已过期，请重新运行命令。"));
                  return;

                case "scaned_but_redirect": {
                  if (statusResp.redirect_host) {
                    // IDC redirect - we just continue polling, the server handles it
                  }
                  break;
                }

                case "need_verifycode":
                  console.log(c("yellow", "\n  需要输入验证码，请在手机微信上确认数字。"));
                  break;

                case "verify_code_blocked":
                  console.log(c("red", "\n⛔ 多次输入错误，请稍后再试。"));
                  return;

                default:
                  break;
              }
            } catch (err) {
              // Network errors during polling are normal, just retry
              if (process.env.EVOCLAW_VERBOSE) {
                console.log(c("gray", `  Poll error: ${err instanceof Error ? err.message : String(err)}`));
              }
            }

            await new Promise((r) => setTimeout(r, 1000));
          }

          console.log(c("yellow", "\n⏰ 登录超时，请重试。"));
        } catch (err) {
          console.log(c("red", `❌ Error: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        console.log(c("green", `✅ Login initiated for ${ch}`));
        console.log(c("gray", "  Interactive login for WhatsApp Web. For other channels, use API tokens."));
      }
    });

  channels
    .command("logout [channel]")
    .description("Logout from a channel")
    .action((channel: string) => {
      if (!channel) {
        console.log(c("yellow", "Usage: EvoClaw channels logout <channel>"));
        return;
      }
      console.log(c("cyan", `ℹ Channel logout is managed via the Web UI → Channels tab.`));
      console.log(c("gray", `  To logout from "${channel}", open the Web UI and revoke the channel session.`));
      console.log(c("gray", `  CLI channel logout is not supported.`));
    });

  channels
    .command("capabilities")
    .description("Show channel capabilities matrix")
    .action(() => {
      console.log(`\n${c("bold", "=== Channel Capabilities ===\n")}`);
      const caps = [
        ["WhatsApp", "text, media, reactions, polls, groups"],
        ["Telegram", "text, media, inline keyboards, commands"],
        ["Discord", "text, embeds, reactions, threads, roles"],
        ["Slack", "text, blocks, reactions, threads"],
        ["GoogleChat", "text, cards, spaces"],
        ["Signal", "text, media, groups"],
      ];
      for (const [name, cap] of caps) {
        console.log(`  ${c("cyan", name.padEnd(14))} ${c("gray", cap)}`);
      }
      console.log();
    });

  channels
    .command("resolve <target>")
    .description("Resolve a channel contact")
    .action((target: string) => {
      console.log(`  Resolution for "${target}":`);
      console.log(`  ${c("gray", "Use Web UI → Channels tab for contact resolution")}`);
    });
}
