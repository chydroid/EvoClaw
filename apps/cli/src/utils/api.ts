/** Shared HTTP client for CLI-to-Gateway API calls. */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

function loadVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return "0.0.0-unknown";
}
export const VERSION = loadVersion();
/** OpenClaw-compatible version for WeChat plugin compatibility */
export const OPENCLAW_COMPAT_VERSION = "2026.3.22";

/** Auto-detect port: try .env file, then probe common ports */
export function detectPort(): number {
  // 1. From environment variable
  const envPort = process.env.EvoClaw_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
  }

  // 2. From .env file in CWD or project root
  const envPaths = [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", "..", "..", "..", ".env"),
  ];
  for (const p of envPaths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf-8");
        const match = content.match(/^EvoClaw_PORT\s*=\s*(\d+)/m);
        if (match) return parseInt(match[1], 10);
      }
    } catch { /* ignore */ }
  }

  // 3. Default
  return 27788;
}

export const DEFAULT_PORT = detectPort();
export const DEV_PORT = 19001;

let port = DEFAULT_PORT;

export function setPort(p: number): void { port = p; }
export function getPort(): number { return port; }

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

export function apiRequest<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `http://localhost:${port}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      url.toString(),
      {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) as T });
          } catch {
            resolve({ status: res.statusCode || 0, data: { raw: data } as unknown as T });
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 向指定端口发送 /health 探测，不修改全局 port */
function probeHealth(targetPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      `http://localhost:${targetPort}/health`,
      { method: "GET", timeout: 5000 },
      (res) => { resolve(res.statusCode === 200); }
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Check if the EvoClaw Gateway server is reachable. */
export async function checkServer(): Promise<boolean> {
  try {
    const r = await apiRequest("GET", "/health");
    return r.status === 200;
  } catch {
    // 当前端口不可达，探测其他常用端口（使用独立请求，不修改全局 port）
  }

  const portsToTry = [27788, 3000, 8080].filter((p) => p !== port);
  for (const p of portsToTry) {
    if (await probeHealth(p)) {
      // 已知限制：找到可用端口后仍会更新全局 port，因为后续 apiRequest 调用依赖正确的端口。
      // 理想方案应通过返回值告知调用方由其决定，但现有调用方均依赖此副作用。
      setPort(p);
      return true;
    }
  }
  return false;
}

/** Print server offline message. */
export function serverRequired(): void {
  const { c } = require("./colors");
  process.stdout.write(
    c("red", "❌ Server not running. Start with:\n") +
    c("gray", "  node apps/server/dist/index.js\n") +
    c("gray", "  EvoClaw gateway start\n")
  );
}