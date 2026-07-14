import type { Plugin, PluginHookRegistration, AfterToolCallHook } from "@evoclaw/core";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { lookup } from "dns";
import { promisify as p } from "util";

const execFileAsync = promisify(execFile);
const lookupAsync = p(lookup);

const MANIFEST = {
  name: "MarkItDown",
  version: "1.0.0",
  description: "Convert documents and web pages to Markdown using microsoft/markitdown. Supports PDF, Word, Excel, PowerPoint, HTML, and more.",
  description_zh: "文档转换：使用 microsoft/markitdown 将文档和网页转为 Markdown，支持 PDF、Word、Excel、PPT、HTML 等格式",
  author: "evoclaw",
};

const CONVERTIBLE_TOOLS = ["web_fetch"];
const CONVERTIBLE_EXTENSIONS = [
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".html", ".htm", ".csv", ".json", ".xml", ".epub",
  ".txt", ".md", ".rst", ".log", ".yaml", ".yml", ".toml",
];
const SKIP_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico",
  ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".wma",
  ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
];

interface MarkItDownCommand {
  cmd: string;
  args: string[];
}

let markitdownCmd: MarkItDownCommand | null = null;
let convertCount = 0;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 169 && b === 254 ||
    a === 0
  );
}

async function checkSsrf(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "non-http protocol";
    const hostname = u.hostname;
    if (hostname === "localhost" || hostname === "[::1]" || hostname.endsWith(".local")) {
      return `loopback/link-local hostname "${hostname}"`;
    }
    const { address } = await lookupAsync(hostname);
    if (isPrivateIPv4(address)) return `resolves to private/loopback IP "${address}"`;
    if (address.includes(":") && (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd"))) {
      return `private/loopback IPv6 "${address}"`;
    }
    return null;
  } catch {
    return "DNS resolution failed";
  }
}

async function checkMarkItDownAvailable(): Promise<boolean> {
  if (markitdownCmd !== null) return markitdownCmd.cmd !== "";
  try {
    await execFileAsync("markitdown", ["--version"], { timeout: 5000 });
    markitdownCmd = { cmd: "markitdown", args: [] };
    console.log("[MarkItDown] markitdown CLI found and available");
  } catch {
    try {
      await execFileAsync("python", ["-m", "markitdown", "--version"], { timeout: 5000 });
      markitdownCmd = { cmd: "python", args: ["-m", "markitdown"] };
      console.log("[MarkItDown] markitdown available via python -m markitdown");
    } catch {
      try {
        await execFileAsync("python3", ["-m", "markitdown", "--version"], { timeout: 5000 });
        markitdownCmd = { cmd: "python3", args: ["-m", "markitdown"] };
        console.log("[MarkItDown] markitdown available via python3 -m markitdown");
      } catch {
        markitdownCmd = { cmd: "", args: [] };
        console.log("[MarkItDown] markitdown not found. Install with: pip install 'markitdown[all]'");
      }
    }
  }
  return markitdownCmd.cmd !== "";
}

async function convertWithMarkItDown(inputPath: string): Promise<string | null> {
  const available = await checkMarkItDownAvailable();
  if (!available || !markitdownCmd || !markitdownCmd.cmd) return null;

  try {
    const args = [...markitdownCmd.args, inputPath];
    const { stdout, stderr } = await execFileAsync(markitdownCmd.cmd, args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    if (stderr && stderr.includes("Error")) {
      console.warn(`[MarkItDown] Conversion warning: ${stderr.slice(0, 200)}`);
    }

    return stdout || null;
  } catch (err: any) {
    console.warn(`[MarkItDown] Conversion failed: ${err.message?.slice(0, 200)}`);
    return null;
  }
}

async function convertUrlToMarkdown(url: string): Promise<string | null> {
  const available = await checkMarkItDownAvailable();
  if (!available) return null;

  const ssrfReason = await checkSsrf(url);
  if (ssrfReason) {
    console.warn(`[MarkItDown] URL blocked by SSRF protection: ${ssrfReason}`);
    return null;
  }

  const tmpDir = os.tmpdir();
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname;
  } catch {
    return null;
  }
  const urlExt = path.extname(urlPath).toLowerCase();
  const ext = CONVERTIBLE_EXTENSIONS.includes(urlExt) ? urlExt : ".html";
  const tmpFile = path.join(tmpDir, `evoclaw-md-${Date.now()}${ext}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    let currentUrl = url;
    let response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0; +markitdown)",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      signal: controller.signal,
      redirect: "manual",
    });
    let redirectCount = 0;
    while ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      const redirectSsrfReason = await checkSsrf(currentUrl);
      if (redirectSsrfReason) {
        clearTimeout(timeout);
        console.warn(`[MarkItDown] Redirect blocked by SSRF: ${redirectSsrfReason}`);
        return null;
      }
      response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0; +markitdown)",
          "Accept": "text/html,application/xhtml+xml,*/*",
        },
        signal: controller.signal,
        redirect: "manual",
      });
      redirectCount++;
    }
    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("html") || contentType.includes("xml");
    const isDocument = contentType.includes("pdf") || contentType.includes("officedocument") ||
      contentType.includes("msword") || contentType.includes("spreadsheet") ||
      contentType.includes("presentation");

    if (!isHtml && !isDocument) return null;

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(buffer));

    const result = await convertWithMarkItDown(tmpFile);
    return result;
  } catch (err: any) {
    console.warn(`[MarkItDown] URL conversion failed: ${err.message?.slice(0, 200)}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function convertFileToMarkdown(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.includes(ext)) return null;
  if (!CONVERTIBLE_EXTENSIONS.includes(ext) && ext !== "") return null;

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    return null;
  }

  return convertWithMarkItDown(filePath);
}

function isConvertibleUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (SKIP_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;
  if (CONVERTIBLE_EXTENSIONS.some(ext => lower.endsWith(ext))) return true;
  if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
  return false;
}

export function createMarkItDownPlugin(): Plugin {
  const hooks: PluginHookRegistration[] = [
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        if (!CONVERTIBLE_TOOLS.includes(h.toolName) || h.errored) return {};

        try {
          const params = h.params || {};
          const url = String(params.url || "");
          if (!url || !isConvertibleUrl(url)) return {};

          const resultObj = typeof h.result === "string" ? null : h.result as Record<string, any>;
          if (!resultObj) return {};

          const format = String(params.format || "text");
          if (format === "json") return {};

          const markdown = await convertUrlToMarkdown(url);
          if (!markdown || markdown.length < 50) return {};

          convertCount++;
          console.log(`[MarkItDown] Auto-converted ${url} to Markdown (${markdown.length} chars)`);

          const merged = { ...resultObj };
          merged.markdown = markdown.slice(0, 30000);
          merged.convertedBy = "markitdown";

          return { result: merged };
        } catch (err: any) {
          console.warn(`[MarkItDown] Hook error: ${err.message?.slice(0, 200)}`);
          return {};
        }
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async init() {
      console.log("[MarkItDown] Plugin initialized — checking markitdown availability...");
      await checkMarkItDownAvailable();
    },
    async shutdown() {
      console.log(`[MarkItDown] Shutting down — ${convertCount} conversions performed`);
    },
    async healthCheck() {
      const available = await checkMarkItDownAvailable();
      return {
        healthy: available,
        message: available
          ? `Active (${convertCount} conversions, markitdown CLI available)`
          : "markitdown CLI not found — install with: pip install 'markitdown[all]'",
      };
    },
  };
}

export { convertWithMarkItDown, convertUrlToMarkdown, convertFileToMarkdown, checkMarkItDownAvailable };
