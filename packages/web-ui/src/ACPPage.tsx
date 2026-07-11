/**
 * ACPPage — ACP (Agent Client Protocol) IDE 集成页
 *
 * 列出已连接的 ACP IDE 客户端，并展示每个客户端的能力清单。
 */

import { useState, useEffect, useCallback } from "react";
import {
  PageHeader, Card, Badge, Loading, EmptyState,
  SecondaryButton, Section, StatsGrid, StatusDot,
} from "./shared";
import { useApiCall } from "./useApiCall";
import { useTranslation } from "./i18n";
import { acpApi, type AcpAgentInfo } from "./api-client";

export default function ACPPage() {
  const { t } = useTranslation();
  const { call } = useApiCall();
  const [agents, setAgents] = useState<AcpAgentInfo[]>([]);
  const [loadingState, setLoadingState] = useState(true);

  const refresh = useCallback(async () => {
    setLoadingState(true);
    try {
      const result = await acpApi.agents();
      setAgents(result || []);
    } catch {
      setAgents([]);
    } finally {
      setLoadingState(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleCheck() {
    await call(
      () => acpApi.agents(),
      { errorMessage: t("acp.refresh_failed", "刷新失败"), silent: true },
    );
    refresh();
  }

  if (loadingState) {
    return <Loading text={t("acp.loading", "加载 ACP 客户端...")} />;
  }

  const connectedCount = agents.filter(a => a.connected !== false).length;
  const totalCapabilities = agents.reduce((sum, a) => sum + (a.capabilities?.length || 0), 0);

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("acp.title", "ACP IDE 集成")}
        subtitle={t("acp.subtitle", "Agent Client Protocol：已连接的 IDE 客户端及其能力清单")}
        actions={
          <SecondaryButton onClick={handleCheck}>
            {t("acp.refresh", "刷新")}
          </SecondaryButton>
        }
      />

      {/* Stats */}
      <Section>
        <StatsGrid items={[
          { label: t("acp.total_clients", "客户端总数"), value: agents.length, color: "var(--text-primary)" },
          { label: t("acp.connected", "已连接"), value: connectedCount, color: "var(--success)" },
          { label: t("acp.total_capabilities", "能力总数"), value: totalCapabilities, color: "var(--accent)" },
        ]} />
      </Section>

      {/* Client List */}
      <Section title={t("acp.clients_title", "已连接客户端")}>
        {agents.length === 0 ? (
          <EmptyState
            title={t("acp.no_clients", "暂无已连接的 ACP 客户端")}
            description={t("acp.no_clients_desc", "请在 IDE 中安装 ACP 插件并连接到本服务")}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {agents.map((agent, i) => (
              <AcpClientCard key={agent.id || i} agent={agent} t={t} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function AcpClientCard({ agent, t }: {
  agent: AcpAgentInfo;
  t: (key: string, fallback?: string) => string;
}) {
  const connected = agent.connected !== false;
  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusDot status={connected ? "connected" : "offline"} size={10} />
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
              {agent.name || agent.id}
            </span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 4 }}>
              {agent.id}
            </code>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge variant={connected ? "success" : "default"}>
              {connected ? t("acp.connected_badge", "已连接") : t("acp.disconnected", "已断开")}
            </Badge>
            {agent.type && <Badge variant="info">{agent.type}</Badge>}
            {agent.frontend && <Badge variant="default">{agent.frontend}</Badge>}
          </div>
        </div>

        {/* Description */}
        {agent.description && (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {agent.description}
          </div>
        )}

        {/* Connected time */}
        {agent.connectedAt && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("acp.connected_at", "连接时间")}: {new Date(agent.connectedAt).toLocaleString()}
          </div>
        )}

        {/* Capabilities */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}>
            {t("acp.capabilities", "能力清单")} ({agent.capabilities?.length || 0})
          </div>
          {agent.capabilities && agent.capabilities.length > 0 ? (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {agent.capabilities.map((cap, j) => (
                <Badge key={j} variant="info">{cap}</Badge>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {t("acp.no_capabilities", "未声明能力")}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
