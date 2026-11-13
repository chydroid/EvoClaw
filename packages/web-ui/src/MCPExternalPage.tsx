/**
 * MCPExternalPage — 外部 MCP Server 管理页面。
 *
 * 功能：
 * - 查看已连接的外部 MCP server 及其工具
 * - 添加/移除/重连 server
 * - 查看 server 工具列表
 * - 对 HTTP 传输的 server 查看 OAuth 状态 / 发起认证 / 注销（P5）
 *
 * 后端 API：
 * - GET  /api/mcp-external/list
 * - POST /api/mcp-external/add
 * - DELETE /api/mcp-external/:name
 * - POST /api/mcp-external/:name/reconnect
 * - GET  /api/mcp-oauth/:server/status
 * - POST /api/mcp-oauth/:server/authenticate
 * - POST /api/mcp-oauth/:server/logout
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  Section, PrimaryButton, SecondaryButton,
  showToast, Modal, TextInput,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";

const API = window.__EVOCLAW_API__ || "";

interface ServerInfo {
  name: string;
  type: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
  connectedAt?: number;
}

interface ListResponse {
  servers: ServerInfo[];
  configPath: string | null;
}

/** P5：OAuth 状态（后端不返回 token 值，只有布尔量） */
interface OAuthState {
  server: string;
  enabled: boolean;
  status: string;
  hasToken: boolean;
  hasRefreshToken: boolean;
  needsRefresh: boolean;
  lastError?: string;
}

export default function MCPExternalPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 添加 server 的 modal
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState(`{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", "package-name"],\n  "env": {}\n}`);
  const [adding, setAdding] = useState(false);

  // 重连中的 server
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  // 移除确认
  const [removeTarget, setRemoveTarget] = useState<ServerInfo | null>(null);

  // P5 OAuth：按 server 名缓存状态；仅 HTTP 传输（非 stdio）才展示
  const [oauthStates, setOauthStates] = useState<Record<string, OAuthState>>({});
  const [oauthBusy, setOauthBusy] = useState<Record<string, boolean>>({});
  const [oauthNotice, setOauthNotice] = useState<{ server: string; text: string } | null>(null);

  const loadOAuth = useCallback(async (server: ServerInfo) => {
    if (server.type === "stdio") return;
    try {
      const res = await fetch(`${API}/api/mcp-oauth/${encodeURIComponent(server.name)}/status`);
      if (!res.ok) return; // 无 OAuth 配置 / 未初始化：静默隐藏卡片
      const data: OAuthState = await res.json();
      if (!data.enabled) return;
      setOauthStates((prev) => ({ ...prev, [server.name]: data }));
    } catch { /* 状态查询失败不阻塞主列表 */ }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/mcp-external/list`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ListResponse = await res.json();
      const list = data.servers || [];
      setServers(list);
      setConfigPath(data.configPath);
      setOauthStates({});
      for (const server of list) void loadOAuth(server);
    } catch (err) {
      setError(errorMessage(err));
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [loadOAuth]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAdd = async () => {
    if (!newName.trim()) {
      showToast(t("mcp_external.name_required", "请输入 server 名称"), "error");
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(newConfig);
    } catch (err) {
      console.error("[MCPExternal] Failed to parse config JSON:", err);
      showToast(t("mcp_external.invalid_json", "配置 JSON 格式无效"), "error");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`${API}/api/mcp-external/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), config }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      showToast(t("mcp_external.added", "MCP server 添加成功") + `: ${data.name} (${data.toolCount} tools)`, "success");
      setShowAdd(false);
      setNewName("");
      setNewConfig(`{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", "package-name"],\n  "env": {}\n}`);
      loadData();
    } catch (err) {
      showToast(t("mcp_external.add_failed", "添加失败") + ": " + (errorMessage(err)), "error");
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (server: ServerInfo) => {
    try {
      const res = await fetch(`${API}/api/mcp-external/${encodeURIComponent(server.name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        showToast(t("mcp_external.removed", "已移除") + `: ${server.name}`, "success");
      }
      setRemoveTarget(null);
      loadData();
    } catch (err) {
      showToast(t("mcp_external.remove_failed", "移除失败") + ": " + (errorMessage(err)), "error");
    }
  };

  const handleReconnect = async (server: ServerInfo) => {
    setReconnecting(server.name);
    try {
      const res = await fetch(`${API}/api/mcp-external/${encodeURIComponent(server.name)}/reconnect`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      showToast(t("mcp_external.reconnected", "重连成功") + `: ${data.name} (${data.toolCount} tools)`, "success");
      loadData();
    } catch (err) {
      showToast(t("mcp_external.reconnect_failed", "重连失败") + ": " + (errorMessage(err)), "error");
    } finally {
      setReconnecting(null);
    }
  };

  const handleOAuthLogin = async (server: ServerInfo, deviceCode: boolean) => {
    setOauthBusy((prev) => ({ ...prev, [server.name]: true }));
    setOauthNotice(null);
    try {
      const res = await fetch(`${API}/api/mcp-oauth/${encodeURIComponent(server.name)}/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const url: string | undefined = data.authorizationUrl;
      const dc = data.deviceCode as { userCode?: string; verificationUri?: string } | undefined;
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
        setOauthNotice({ server: server.name, text: t("mcp_external.oauth_opened", "已在新窗口打开授权页面，请在浏览器完成授权后刷新状态。") });
      } else if (dc?.userCode) {
        setOauthNotice({
          server: server.name,
          text: `${t("mcp_external.oauth_device_code", "设备码")}: ${dc.userCode} — ${dc.verificationUri || ""}`,
        });
      }
      // 后台流程可能完成得很快，稍后刷新一次状态
      void loadOAuth(server);
    } catch (err) {
      showToast(t("mcp_external.oauth_login_failed", "发起认证失败") + ": " + errorMessage(err), "error");
    } finally {
      setOauthBusy((prev) => ({ ...prev, [server.name]: false }));
    }
  };

  const handleOAuthLogout = async (server: ServerInfo) => {
    setOauthBusy((prev) => ({ ...prev, [server.name]: true }));
    try {
      const res = await fetch(`${API}/api/mcp-oauth/${encodeURIComponent(server.name)}/logout`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast(t("mcp_external.oauth_logged_out", "已删除本地 OAuth token"), "success");
      setOauthStates((prev) => {
        const next = { ...prev };
        delete next[server.name];
        return next;
      });
      void loadOAuth(server);
    } catch (err) {
      showToast(t("mcp_external.oauth_logout_failed", "注销失败") + ": " + errorMessage(err), "error");
    } finally {
      setOauthBusy((prev) => ({ ...prev, [server.name]: false }));
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title={t("mcp_external.title", "外部 MCP Server 管理")} />
        <Loading text={t("common.loading", "加载中...")} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("mcp_external.title", "外部 MCP Server 管理")}
        subtitle={t("mcp_external.subtitle", "连接外部 MCP server，保留原版全部功能")}
        actions={
          <PrimaryButton onClick={() => setShowAdd(true)} disabled={adding}>
            + {t("mcp_external.add", "添加 Server")}
          </PrimaryButton>
        }
      />

      {error && (
        <Card style={{ marginBottom: 16, borderColor: "var(--color-error, #ef4444)" }}>
          <div style={{ padding: 12, color: "var(--color-error, #ef4444)" }}>
            {t("common.error", "错误")}: {error}
          </div>
        </Card>
      )}

      <Section title={t("mcp_external.servers", "已连接的 Server")}>
        {servers.length === 0 ? (
          <EmptyState
            title={t("mcp_external.no_servers", "暂无外部 MCP Server")}
            description={t("mcp_external.no_servers_desc", "点击「添加 Server」连接外部 MCP server，如 firecrawl、github 等。配置文件参考 config/mcp-servers.example.json")}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {servers.map((server) => (
              <Card key={server.name} style={{ padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <strong style={{ fontSize: 16 }}>{server.name}</strong>
                    <Badge variant={server.connected ? "success" : "error"} style={{ marginLeft: 8 }}>
                      {server.connected
                        ? t("mcp_external.connected", "已连接")
                        : t("mcp_external.disconnected", "未连接")}
                    </Badge>
                    <span style={{ marginLeft: 8, color: "var(--color-text-secondary, #888)", fontSize: 13 }}>
                      [{server.type}] · {server.toolCount} {t("mcp_external.tools", "个工具")}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <SecondaryButton
                      onClick={() => handleReconnect(server)}
                      disabled={reconnecting === server.name}
                    >
                      {reconnecting === server.name
                        ? t("common.reconnecting", "重连中...")
                        : t("common.reconnect", "重连")}
                    </SecondaryButton>
                    <PrimaryButton danger={true} onClick={() => setRemoveTarget(server)}>
                      {t("common.remove", "移除")}
                    </PrimaryButton>
                  </div>
                </div>
                {server.lastError && (
                  <div style={{ color: "var(--color-error, #ef4444)", fontSize: 13, marginBottom: 8 }}>
                    {t("common.error", "错误")}: {server.lastError}
                  </div>
                )}
                {server.tools.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {server.tools.map((tool) => (
                      <span
                        key={tool}
                        style={{
                          fontSize: 12,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: "var(--color-bg-secondary, #f0f0f0)",
                          color: "var(--color-text-secondary, #666)",
                        }}
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                )}
                {server.connectedAt && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-tertiary, #aaa)" }}>
                    {t("mcp_external.connected_at", "连接时间")}: {new Date(server.connectedAt).toLocaleString()}
                  </div>
                )}

                {/* P5：OAuth 状态卡片（只显示给启用 OAuth 的 HTTP server） */}
                {oauthStates[server.name] && (
                  <div style={{
                    marginTop: 12, padding: 10, borderRadius: 6,
                    background: "var(--color-bg-secondary, #f6f6f6)",
                    border: "1px solid var(--color-border, #e5e5e5)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13 }}>{t("mcp_external.oauth_title", "OAuth 认证")}</strong>
                      <Badge variant={oauthStates[server.name].hasToken ? "success" : "warning"}>
                        {oauthStates[server.name].hasToken
                          ? t("mcp_external.oauth_authenticated", "已认证")
                          : t("mcp_external.oauth_unauthenticated", "未认证")}
                      </Badge>
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary, #888)" }}>
                        {oauthStates[server.name].status}
                        {oauthStates[server.name].needsRefresh ? " · needsRefresh" : ""}
                      </span>
                      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                        <SecondaryButton
                          small
                          disabled={oauthBusy[server.name]}
                          onClick={() => void handleOAuthLogin(server, false)}
                        >
                          {t("mcp_external.oauth_login", "授权")}
                        </SecondaryButton>
                        <SecondaryButton
                          small
                          disabled={oauthBusy[server.name]}
                          onClick={() => void handleOAuthLogin(server, true)}
                        >
                          {t("mcp_external.oauth_device", "设备码")}
                        </SecondaryButton>
                        <SecondaryButton
                          small
                          disabled={oauthBusy[server.name]}
                          onClick={() => void loadOAuth(server)}
                        >
                          {t("mcp_external.oauth_refresh", "刷新状态")}
                        </SecondaryButton>
                        <PrimaryButton
                          small
                          danger
                          disabled={oauthBusy[server.name]}
                          onClick={() => void handleOAuthLogout(server)}
                        >
                          {t("mcp_external.oauth_logout", "注销")}
                        </PrimaryButton>
                      </div>
                    </div>
                    {oauthStates[server.name].lastError && (
                      <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-error, #ef4444)" }}>
                        {oauthStates[server.name].lastError}
                      </div>
                    )}
                    {oauthNotice?.server === server.name && (
                      <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-text-secondary, #888)" }}>
                        {oauthNotice.text}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      {configPath && (
        <Card style={{ marginTop: 16, padding: 12 }}>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary, #888)" }}>
            {t("mcp_external.config_path", "配置文件")}: <code>{configPath}</code>
          </div>
        </Card>
      )}

      {/* 添加 Server Modal */}
      {showAdd && (
        <Modal
          title={t("mcp_external.add_title", "添加外部 MCP Server")}
          onClose={() => setShowAdd(false)}
          footer={
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <SecondaryButton onClick={() => setShowAdd(false)}>
                {t("common.cancel", "取消")}
              </SecondaryButton>
              <PrimaryButton onClick={handleAdd} disabled={adding}>
                {adding ? t("common.adding", "添加中...") : t("common.add", "添加")}
              </PrimaryButton>
            </div>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 480 }}>
            <div>
              <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
                {t("mcp_external.server_name", "Server 名称")}
              </label>
              <TextInput
                value={newName}
                onChange={(e: string) => setNewName(e)}
                placeholder="firecrawl"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
                {t("mcp_external.server_config", "配置 JSON")}
              </label>
              <textarea
                value={newConfig}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewConfig(e.target.value)}
                rows={8}
                style={{ width: "100%", fontFamily: "monospace", fontSize: 13, padding: 8, borderRadius: 4, border: "1px solid var(--color-border, #ddd)", background: "var(--color-bg, #fff)", color: "var(--color-text, #333)" }}
              />
            </div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary, #888)" }}>
              {t("mcp_external.config_hint", "type 可选 stdio（本地进程）或 sse（远程端点）。stdio 需要 command + args，sse 需要 url。")}
            </div>
          </div>
        </Modal>
      )}

      {/* 移除确认 Modal */}
      {removeTarget && (
        <Modal
          title={t("mcp_external.remove_title", "确认移除")}
          onClose={() => setRemoveTarget(null)}
          footer={
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <SecondaryButton onClick={() => setRemoveTarget(null)}>
                {t("common.cancel", "取消")}
              </SecondaryButton>
              <PrimaryButton danger={true} onClick={() => handleRemove(removeTarget)}>
                {t("common.confirm_remove", "确认移除")}
              </PrimaryButton>
            </div>
          }
        >
          <div style={{ minWidth: 360 }}>
            <p>
              {t("mcp_external.remove_confirm", "确定要移除 MCP server")} <strong>{removeTarget.name}</strong>?
            </p>
            <p style={{ color: "var(--color-text-secondary, #888)", fontSize: 13 }}>
              {t("mcp_external.remove_hint", "将断开连接并从配置文件中删除。工具将不再可用。")}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
