/**
 * DocsPage — 项目文档阅读器（对标 hermes web/src/pages/DocsPage）。
 *
 * hermes 用 iframe 嵌入 Docusaurus 独立文档站；EvoClaw 没有独立文档站，
 * 因此后端新增只读路由 GET /api/docs（列表）与 GET /api/docs/:name（正文），
 * 本页把仓库 docs/*.md 读出来交给共享的 renderMarkdown 渲染。
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, DataTable, showToast,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";
import { renderMarkdown, sanitizeHtml } from "./markdown-renderer";

interface DocEntry {
  name: string;
  size: number;
  modifiedAt: number;
}

const s: Record<string, CSSProperties> = {
  container: { padding: 20, height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: { padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px" },
  docBody: { padding: "16px 20px", fontSize: "14px", lineHeight: "1.7", color: "var(--text-primary)", wordBreak: "break-word" },
};

export function DocsPage() {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await fetch("/api/docs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDocs(Array.isArray(data.docs) ? data.docs : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDoc = useCallback(async (name: string) => {
    setLoadingDoc(true);
    setError(null);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(name)}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setContent(typeof data.content === "string" ? data.content : "");
      setSelectedName(data.name || name);
    } catch (err) {
      setError(errorMessage(err));
      setContent(null);
    } finally {
      setLoadingDoc(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  return (
    <div style={s.container}>
      <PageHeader
        title={t("docs.title", "项目文档")}
        subtitle={t("docs.subtitle", "阅读仓库 docs/ 下的 markdown 文档")}
      />

      <div style={s.toolbar}>
        <SecondaryButton small onClick={loadList} disabled={loadingList}>{t("docs.refresh", "刷新")}</SecondaryButton>
        {selectedName && <SecondaryButton small onClick={() => { setSelectedName(null); setContent(null); }}>{t("docs.back", "返回列表")}</SecondaryButton>}
      </div>

      {error && <ErrorBanner message={error} />}

      <div style={{ display: "grid", gridTemplateColumns: selectedName ? "280px 1fr" : "1fr", gap: "16px" }}>
        <Section title={t("docs.list_header", "文档")}>
          {loadingList ? (
            <Loading />
          ) : docs.length === 0 ? (
            <EmptyState title={t("docs.empty", "暂无文档")} description={t("docs.empty_desc", "docs/ 目录下没有 .md 文件")} />
          ) : (
            <DataTable
              columns={[
                { key: "name", label: t("docs.col_name", "名称"), render: (d: DocEntry) => (
                  <button style={{ ...s.btn, background: "transparent", color: "var(--accent)", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }} onClick={() => loadDoc(d.name)}>
                    {d.name}
                  </button>
                ) },
                { key: "size", label: t("docs.col_size", "大小"), render: (d: DocEntry) => d.size ? `${(d.size / 1024).toFixed(1)} KB` : "-" },
              ]}
              data={docs}
              keyFn={(d) => d.name}
              emptyText={t("docs.empty", "暂无文档")}
            />
          )}
        </Section>

        {selectedName && (
          <Card title={selectedName}>
            {loadingDoc ? (
              <Loading />
            ) : content === null ? (
              <EmptyState title={t("docs.load_fail", "加载失败")} description={error || ""} />
            ) : (
              <div style={s.docBody} dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(content)) }} />
            )}
          </Card>
        )}
      </div>
    </div>
  );
}