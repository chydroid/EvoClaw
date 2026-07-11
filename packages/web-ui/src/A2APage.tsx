/**
 * A2APage — A2A (Agent-to-Agent) 协议管理页
 *
 * 展示本机 Agent Card（name/description/url/version/capabilities），
 * 远程 Agent 列表，以及发起跨框架任务的表单。
 */

import { useState, useEffect, useCallback } from "react";
import {
  PageHeader, Card, Badge, Loading, EmptyState,
  PrimaryButton, SecondaryButton, Section,
  DataTable, showToast, TextInput,
} from "./shared";
import { useApiCall } from "./useApiCall";
import { useTranslation } from "./i18n";
import {
  a2aApi,
  type A2AAgentCard,
  type A2ARemoteAgent,
  type A2ATaskResult,
} from "./api-client";

export default function A2APage() {
  const { t } = useTranslation();
  const { call } = useApiCall();
  const [card, setCard] = useState<A2AAgentCard | null>(null);
  const [agents, setAgents] = useState<A2ARemoteAgent[]>([]);
  const [loadingState, setLoadingState] = useState(true);

  // Task form state
  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskAgentId, setTaskAgentId] = useState("");
  const [taskResult, setTaskResult] = useState<A2ATaskResult | null>(null);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    setLoadingState(true);
    const [c, a] = await Promise.all([
      a2aApi.card(),
      a2aApi.agents(),
    ]);
    setCard(c);
    setAgents(a.agents || []);
    setLoadingState(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSendTask() {
    if (!taskPrompt.trim()) return;
    setSending(true);
    const result = await call(
      () => a2aApi.sendTask({
        prompt: taskPrompt.trim(),
        ...(taskAgentId.trim() ? { agentId: taskAgentId.trim() } : {}),
      }),
      { errorMessage: t("a2a.task_failed", "A2A 任务发送失败") },
    );
    if (result) {
      setTaskResult(result);
      showToast(t("a2a.task_sent", "A2A 任务已发送"), "success");
    }
    setSending(false);
  }

  if (loadingState) {
    return <Loading text={t("a2a.loading", "加载 A2A 信息...")} />;
  }

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("a2a.title", "A2A 协议管理")}
        subtitle={t("a2a.subtitle", "Agent-to-Agent 跨框架协议：本机 Agent Card 与远程 Agent")}
        actions={
          <SecondaryButton onClick={refresh}>
            {t("a2a.refresh", "刷新")}
          </SecondaryButton>
        }
      />

      {/* Local Agent Card */}
      <Section title={t("a2a.local_card", "本机 Agent Card")}>
        {card ? (
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
                  {card.name}
                </span>
                <Badge variant="info">v{card.version}</Badge>
                {card.authentication && (
                  <Badge variant="default">auth: {card.authentication.type}</Badge>
                )}
              </div>
              {card.description && (
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  {card.description}
                </div>
              )}
              <div>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginRight: 6 }}>
                  {t("a2a.url", "URL")}:
                </span>
                <code style={{ fontSize: 12, color: "var(--accent)", background: "var(--bg-hover)", padding: "2px 6px", borderRadius: 4 }}>
                  {card.url}
                </code>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>
                  {t("a2a.capabilities", "能力清单")} ({card.capabilities?.length || 0})
                </div>
                {card.capabilities && card.capabilities.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {card.capabilities.map((cap, i) => (
                      <div key={i} style={{
                        padding: "8px 12px", background: "var(--bg-hover)", borderRadius: 6,
                        border: "1px solid var(--border)",
                      }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                          <Badge variant="success">{cap.id}</Badge>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                            {cap.name}
                          </span>
                        </div>
                        {cap.description && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {cap.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title={t("a2a.no_capabilities", "无能力声明")} />
                )}
              </div>
            </div>
          </Card>
        ) : (
          <EmptyState
            title={t("a2a.no_card", "A2A 服务未启用")}
            description={t("a2a.no_card_desc", "本机未运行 A2A Server，无法提供 Agent Card")}
          />
        )}
      </Section>

      {/* Remote Agents */}
      <Section title={t("a2a.remote_agents", "远程 Agent 列表")}>
        {agents.length === 0 ? (
          <EmptyState title={t("a2a.no_remote", "暂无已知远程 Agent")} />
        ) : (
          <DataTable
            columns={[
              { key: "id", label: t("a2a.col_id", "ID"), width: "120px" },
              { key: "name", label: t("a2a.col_name", "名称") },
              { key: "url", label: t("a2a.col_url", "URL") },
              { key: "version", label: t("a2a.col_version", "版本"), width: "80px" },
              { key: "lastSeen", label: t("a2a.col_last_seen", "最近发现"), width: "150px" },
            ]}
            data={agents}
            keyFn={(a, i) => a.id || `agent-${i}`}
            emptyText={t("a2a.no_remote", "暂无远程 Agent")}
            rowStyle={{ fontSize: 12 }}
          />
        )}
      </Section>

      {/* Send Task */}
      <Section title={t("a2a.send_task", "发起跨框架任务")}>
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("a2a.target_agent", "目标 Agent ID")} ({t("a2a.optional", "可选")})
              </label>
              <TextInput
                value={taskAgentId}
                onChange={setTaskAgentId}
                placeholder={t("a2a.target_agent_placeholder", "留空则由本机 Agent 处理")}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("a2a.task_prompt", "任务提示词")}
              </label>
              <textarea
                value={taskPrompt}
                onChange={(e) => setTaskPrompt(e.target.value)}
                placeholder={t("a2a.task_prompt_placeholder", "输入要发送给远程 Agent 的任务...")}
                rows={3}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--input-border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: 13, resize: "vertical", outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton onClick={handleSendTask} disabled={!taskPrompt.trim() || sending}>
                {sending ? t("a2a.sending", "发送中...") : t("a2a.send", "发送任务")}
              </PrimaryButton>
            </div>
          </div>
        </Card>
      </Section>

      {/* Task Result */}
      {taskResult && (
        <Section title={t("a2a.task_result", "任务结果")}>
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Badge variant="info">{t("a2a.task_id", "任务 ID")}: {taskResult.taskId}</Badge>
                <Badge variant={taskResult.status === "completed" || taskResult.status === "succeeded" ? "success" : taskResult.status === "failed" ? "error" : "warning"}>
                  {taskResult.status}
                </Badge>
              </div>
              {taskResult.error && (
                <div style={{ fontSize: 13, color: "var(--error)" }}>
                  {taskResult.error}
                </div>
              )}
              {taskResult.result !== undefined && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                    {t("a2a.result", "结果")}
                  </div>
                  <pre style={{
                    fontSize: 12, color: "var(--text-primary)", background: "var(--bg-hover)",
                    padding: 12, borderRadius: 8, overflow: "auto", maxHeight: 300,
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>
                    {typeof taskResult.result === "string"
                      ? taskResult.result
                      : JSON.stringify(taskResult.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </Card>
        </Section>
      )}
    </div>
  );
}
