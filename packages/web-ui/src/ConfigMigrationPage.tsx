/**
 * ConfigMigrationPage — Config migration management.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable,
  StatsGrid, showToast,
} from "./shared";
import { migrationApi, type MigrationRecord } from "./api-client";
import { useTranslation } from "./i18n";

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  expandedRow: {
    padding: "12px 16px",
    background: "var(--bg-input)",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  changeItem: {
    padding: "6px 0",
    fontSize: "12px",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  changePath: {
    fontFamily: "monospace",
    color: "var(--accent)",
    fontWeight: 600,
  } as React.CSSProperties,
  changeValue: {
    color: "var(--text-secondary)",
    marginTop: "2px",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "6px",
  } as React.CSSProperties,
  monoText: {
    fontFamily: "monospace",
    fontSize: "12px",
    color: "var(--text-primary)",
  } as React.CSSProperties,
  emptyExpanded: {
    padding: "12px 16px",
    color: "var(--text-muted)",
    fontSize: "12px",
    fontStyle: "italic",
    background: "var(--bg-input)",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
};

function statusVariant(status: string): "success" | "error" | "warning" | "info" | "default" {
  switch (status) {
    case "completed": return "success";
    case "failed": return "error";
    case "running": return "warning";
    case "pending": return "info";
    default: return "default";
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleString("zh-CN");
}

export default function ConfigMigrationPage() {
  const { t } = useTranslation();
  const [migrations, setMigrations] = useState<MigrationRecord[]>([]);
  const [currentVersion, setCurrentVersion] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [lastMigration, setLastMigration] = useState<MigrationRecord | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [actionIds, setActionIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const [listRes, statusRes] = await Promise.all([
        migrationApi.list(),
        migrationApi.status(),
      ]);
      setMigrations(listRes.migrations);
      setCurrentVersion(statusRes.currentVersion);
      setPendingCount(statusRes.pendingCount);
      setLastMigration(statusRes.lastMigration);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载迁移记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRun = useCallback(async (migrationId: string) => {
    setActionIds((prev) => new Set(prev).add(migrationId));
    try {
      await migrationApi.run(migrationId);
      showToast("迁移已开始", "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "执行迁移失败", "error");
    } finally {
      setActionIds((prev) => {
        const next = new Set(prev);
        next.delete(migrationId);
        return next;
      });
    }
  }, [fetchData]);

  const handleRollback = useCallback(async (migrationId: string) => {
    setActionIds((prev) => new Set(prev).add(migrationId));
    try {
      await migrationApi.rollback(migrationId);
      showToast("回滚已启动", "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "回滚迁移失败", "error");
    } finally {
      setActionIds((prev) => {
        const next = new Set(prev);
        next.delete(migrationId);
        return next;
      });
    }
  }, [fetchData]);

  if (loading) return <Loading text={t("app.loading")} />;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("config_migration.title")}
        subtitle={t("config_migration.subtitle")}
        actions={<SecondaryButton onClick={fetchData} small>刷新</SecondaryButton>}
      />

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      <StatsGrid
        items={[
          { label: t("config_migration.current_version"), value: currentVersion || "未知", color: "var(--accent)" },
          { label: t("config_migration.pending"), value: pendingCount, color: pendingCount > 0 ? "var(--warning)" : "var(--text-muted)" },
          { label: "上次迁移", value: lastMigration?.id?.slice(0, 12) ?? "无", sub: lastMigration ? formatDate(lastMigration.completedAt) : undefined },
          { label: "迁移总数", value: migrations.length },
        ]}
      />

      <Section title="迁移列表" style={{ marginTop: "20px" }}>
        <Card>
          {migrations.length === 0 ? (
            <EmptyState icon="" title={t("config_migration.no_migrations")} description="尚未记录任何配置迁移" />
          ) : (
            <DataTable
              columns={[
                {
                  key: "id",
                  label: "ID",
                  width: "15%",
                  render: (item) => (
                    <span style={s.monoText}>{item.id.slice(0, 12)}...</span>
                  ),
                },
                {
                  key: "fromVersion",
                  label: t("config_migration.from_version"),
                  width: "12%",
                  render: (item) => (
                    <span style={s.monoText}>{item.fromVersion}</span>
                  ),
                },
                {
                  key: "toVersion",
                  label: t("config_migration.to_version"),
                  width: "12%",
                  render: (item) => (
                    <span style={s.monoText}>{item.toVersion}</span>
                  ),
                },
                {
                  key: "status",
                  label: t("config_migration.status"),
                  width: "12%",
                  render: (item) => (
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                  ),
                },
                {
                  key: "startedAt",
                  label: t("config_migration.started_at"),
                  width: "15%",
                  render: (item) => formatDate(item.startedAt),
                },
                {
                  key: "completedAt",
                  label: t("config_migration.completed_at"),
                  width: "15%",
                  render: (item) => formatDate(item.completedAt),
                },
                {
                  key: "actions",
                  label: "操作",
                  width: "19%",
                  render: (item) => (
                    <div style={s.actions}>
                      {item.status === "pending" && (
                        <PrimaryButton
                          small
                          onClick={() => handleRun(item.id)}
                          disabled={actionIds.has(item.id)}
                        >
                          {actionIds.has(item.id) ? "..." : t("config_migration.run")}
                        </PrimaryButton>
                      )}
                      {item.status === "completed" && (
                        <SecondaryButton
                          small
                          onClick={() => handleRollback(item.id)}
                          disabled={actionIds.has(item.id)}
                        >
                          {actionIds.has(item.id) ? "..." : t("config_migration.rollback")}
                        </SecondaryButton>
                      )}
                      <GhostButton small onClick={() => toggleExpand(item.id)}>
                        {expandedIds.has(item.id) ? "收起" : "详情"}
                      </GhostButton>
                    </div>
                  ),
                },
              ]}
              data={migrations}
              keyFn={(item) => item.id}
              emptyText={t("config_migration.no_migrations")}
            />
          )}
          {migrations.map((m) =>
            expandedIds.has(m.id) ? (
              <div key={`exp-${m.id}`} style={s.expandedRow}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: "8px" }}>
                  {m.id.slice(0, 12)}... 的变更
                </div>
                {m.changes.length === 0 ? (
                  <div style={s.emptyExpanded}>无变更记录</div>
                ) : (
                  m.changes.map((change, ci) => (
                    <div key={ci} style={s.changeItem}>
                      <div style={s.changePath}>{change.path}</div>
                      <div style={s.changeValue}>
                        从: <code style={{ fontSize: "11px", color: "var(--error)" }}>{JSON.stringify(change.from)}</code>
                        {" "}&rarr;{" "}
                        到: <code style={{ fontSize: "11px", color: "var(--success)" }}>{JSON.stringify(change.to)}</code>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null,
          )}
        </Card>
      </Section>
    </div>
  );
}
