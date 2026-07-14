import type { A2AAgentCard, A2ATask, A2ATaskResult, A2AClientConfig } from "./types";
import * as crypto from "crypto";

// ── SSRF 防护 ───────────────────────────────────────────────

/** 判断 IPv4 字符串是否属于私网/回环/链路本地等黑名单段 */
function isBlockedIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  return (
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    a === 0 // 0.0.0.0/8 "this network"
  );
}

/** 校验 agent URL，拒绝非法协议与私网/回环地址（SSRF 防护） */
function assertSafeAgentUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid agent URL: ${url}`);
  }

  // 协议白名单：仅允许 http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // localhost
  if (hostname === "localhost" || isBlockedIpv4(hostname)) {
    throw new Error(`Blocked host (SSRF protection): ${hostname}`);
  }

  // IPv6 黑名单
  if (hostname.includes(":")) {
    // ::1 loopback
    if (hostname === "::1") {
      throw new Error(`Blocked host (SSRF protection): ${hostname}`);
    }
    // fc00::/7 ULA（含 fd00::/8）
    if (/^f[cd]/i.test(hostname)) {
      throw new Error(`Blocked host (SSRF protection): ${hostname}`);
    }
    // IPv4-mapped IPv6，如 ::ffff:127.0.0.1
    const v4Mapped = hostname.match(/:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4Mapped && isBlockedIpv4(v4Mapped[1])) {
      throw new Error(`Blocked host (SSRF protection): ${hostname}`);
    }
  }
}

export class A2AClient {
  private config: A2AClientConfig;
  private knownAgents = new Map<string, A2AAgentCard>();

  constructor(config?: Partial<A2AClientConfig>) {
    this.config = {
      timeout: config?.timeout ?? 30000,
      maxRetries: config?.maxRetries ?? 2,
      apiKeys: config?.apiKeys ?? {},
    };
  }

  /** Register a known agent */
  registerAgent(card: A2AAgentCard): void {
    this.knownAgents.set(card.name, card);
  }

  /** Discover an agent's capabilities by fetching its agent card */
  async discoverAgent(url: string): Promise<A2AAgentCard> {
    // SSRF 防护：校验协议白名单与私网/回环 IP 黑名单
    assertSafeAgentUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/a2a/card`, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Failed to discover agent at ${url}: ${response.statusText}`);
      const card = await response.json() as A2AAgentCard;
      this.knownAgents.set(card.name, card);
      return card;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send a task to a remote agent */
  async sendTask(agentName: string, task: Omit<A2ATask, "id">): Promise<A2ATaskResult> {
    const agent = this.knownAgents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);

    const fullTask: A2ATask = { ...task, id: `task-${Date.now()}-${crypto.randomBytes(3).toString("hex")}` };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = this.config.apiKeys[agentName];
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${agent.url.replace(/\/+$/, "")}/a2a/task`, {
        method: "POST",
        headers,
        body: JSON.stringify(fullTask),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return { taskId: fullTask.id, status: "failed", error: `HTTP ${response.status}: ${response.statusText}` };
      }
      return await response.json() as A2ATaskResult;
    } catch (err) {
      clearTimeout(timeoutId);
      return { taskId: fullTask.id, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get a known agent's card */
  getAgentCard(name: string): A2AAgentCard | undefined {
    return this.knownAgents.get(name);
  }

  /** List all known agents */
  listAgents(): A2AAgentCard[] {
    return Array.from(this.knownAgents.values());
  }

  /** Remove a known agent */
  unregisterAgent(name: string): boolean {
    return this.knownAgents.delete(name);
  }
}
