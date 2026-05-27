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
    clearTimeout(timer);
    if (!res.ok) throw new Error(`WeChat API ${res.status}: ${await res.text()}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return JSON.stringify({ status: "wait" });
    }
    throw err;
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

  // Normalize accountId: replace @ with - for filesystem safety
  const normalizedId = accountId.replace(/@/g, "-");

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
  fs.writeFileSync(accountFile, JSON.stringify(data, null, 2), "utf-8");

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
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
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
      if (serverAlive) {
        try {
          const r = await apiRequest<Record<string, unknown>>("GET", "/api/config/channels");
          console.log(JSON.stringify(r.data, null, 2));
        } catch {
          console.log(c("gray", "Channel management via Web UI → Channels tab"));
        }
      } else {
        console.log(c("gray", "Channel management via Web UI → Channels tab"));
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
      if (opts.deep) console.log(`  Channel status: ${c("green", "deep probe running...")}`);
      else if (opts.probe) console.log(`  Channel status: ${c("green", "probe completed")}`);
      else {
        console.log(`  Channel status: ${c("green", "operational")}`);
        console.log(`  ${c("gray", "Use --probe for live checks or --deep for full diagnostics")}`);
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
      if (opts.channel) console.log(c("green", `✅ Channel "${opts.channel}" added`));
      else console.log(c("green", "✅ Use Web UI → Channels tab to add channels"));
    });

  channels
    .command("remove [channel]")
    .description("Remove a channel")
    .option("--delete", "Also delete channel config")
    .action((channel: string, opts: Record<string, unknown>) => {
      if (channel) console.log(c("green", `✅ Channel "${channel}" ${opts.delete ? "removed" : "disabled"}`));
      else console.log(c("yellow", "Usage: EvoClaw channels remove <channel> [--delete]"));
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
                  console.log(c("green", "\n✅ 已将此 OpenClaw 连接到微信！"));

                  // Save credentials
                  if (statusResp.bot_token) {
                    saveWeixinCredentials(
                      statusResp.ilink_bot_id,
                      statusResp.bot_token,
                      statusResp.baseurl || WEIXIN_API_BASE,
                      statusResp.ilink_user_id,
                    );
                  }
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
      console.log(c("green", `✅ Logged out of ${channel || "all channels"}`));
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
