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
  return "0.9.5";
}
export const VERSION = loadVersion();
/** OpenClaw-compatible version for WeChat plugin compatibility */
export const OPENCLAW_COMPAT_VERSION = "2026.3.22";

/** Auto-detect port: try .env file, then probe common ports */
export function detectPort(): number {
  // 1. From environment variable
  const envPort = process.env.EvoClaw_PORT;
  if (envPort) return parseInt(envPort, 10);

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

/** Check if the EvoClaw Gateway server is reachable. */
export async function checkServer(): Promise<boolean> {
  try {
    const r = await apiRequest("GET", "/health");
    return r.status === 200;
  } catch {
    // Try probing common ports if default fails
    const portsToTry = [27788, 3000, 8080];
    const currentPort = port;
    for (const p of portsToTry) {
      if (p === currentPort) continue;
      try {
        port = p;
        const r = await apiRequest("GET", "/health");
        if (r.status === 200) return true;
      } catch { /* ignore */ }
    }
    port = currentPort;
    return false;
  }
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