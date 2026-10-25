/**
 * FilesPage — 工作区文件浏览器（对标 hermes web/src/pages/FilesPage）。
 *
 * 后端只读能力：GET /api/files/list（目录列表，含 size/isDirectory/downloadUrl）、
 * GET /api/files/download/*（文件下载）。因此本页为**只读浏览器**：
 * 目录导航、文件大小、下载、文本文件内联预览。上传/新建目录暂无后端支持，不伪造按钮。
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable, showToast,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  downloadUrl?: string;
}

interface FilesListResponse {
  path: string;
  files: FileEntry[];
}

const s: Record<string, CSSProperties> = {
  container: { padding: 20, height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  breadcrumb: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginBottom: "16px", fontSize: "13px" },
  crumb: { color: "var(--text-secondary)", cursor: "pointer" },
  crumbCurrent: { color: "var(--text-primary)", fontWeight: "bold" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: { padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px" },
  preview: { background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)", padding: "12px", maxHeight: "60vh", overflow: "auto", fontFamily: "Consolas, Monaco, monospace", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  hint: { color: "var(--text-muted)", fontSize: "11px", marginTop: "8px" },
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/** 文本文件扩展名白名单，用于内联预览（避免把二进制当文本渲染）。 */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv", "ts", "tsx", "js", "jsx",
  "mjs", "cjs", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "sh", "bash",
  "zsh", "ps1", "html", "htm", "css", "scss", "less", "xml", "sql", "graphql", "gql",
  "ini", "env", "conf", "log", "diff", "patch", "dockerfile", "makefile",
]);

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTS.has(name.slice(dot + 1).toLowerCase());
}

export function FilesPage() {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadList = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/list?path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as FilesListResponse;
      setEntries(data.files || []);
      setCurrentPath(data.path || dirPath);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadList("."); }, [loadList]);

  const navigateTo = useCallback((entry: FileEntry) => {
    if (entry.isDirectory) {
      loadList(entry.path);
    } else {
      setPreviewFile(entry);
      setPreviewContent(null);
      setPreviewLoading(true);
      (async () => {
        try {
          const res = await fetch(entry.downloadUrl || "");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          setPreviewContent(text);
        } catch (err) {
          setPreviewContent(`预览失败: ${errorMessage(err)}`);
        } finally {
          setPreviewLoading(false);
        }
      })();
    }
  }, [loadList]);

  const goUp = useCallback(() => {
    const parts = currentPath.split("/").filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    loadList(parts.length === 0 ? "." : parts.join("/"));
  }, [currentPath, loadList]);

  const breadcrumbParts = currentPath === "." ? [] : currentPath.split("/").filter(Boolean);

  return (
    <div style={s.container}>
      <PageHeader
        title={t("files.title", "工作区文件")}
        subtitle={t("files.subtitle", "浏览与下载 EvoClaw 工作区中的文件（只读）")}
      />

      <div style={s.breadcrumb}>
        <span style={s.crumb} onClick={() => loadList(".")}>{t("files.root", "工作区")}</span>
        {breadcrumbParts.map((part, i) => {
          const href = breadcrumbParts.slice(0, i + 1).join("/");
          const isLast = i === breadcrumbParts.length - 1;
          return (
            <React.Fragment key={href}>
              <span style={{ color: "var(--text-muted)" }}>/</span>
              <span style={isLast ? s.crumbCurrent : s.crumb} onClick={() => loadList(href)}>{part}</span>
            </React.Fragment>
          );
        })}
      </div>

      <div style={s.toolbar}>
        <SecondaryButton small onClick={goUp} disabled={currentPath === "."}>{t("files.up", "上级目录")}</SecondaryButton>
        <SecondaryButton small onClick={() => loadList(currentPath)}>{t("files.refresh", "刷新")}</SecondaryButton>
        <span style={s.hint}>{t("files.hint", "点击文件名预览文本，点击目录进入；下载请右键另存为或使用下方链接")}</span>
      </div>

      {error && <ErrorBanner message={error} />}

      <Section title={t("files.list_header", "文件")}>
        {loading ? (
          <Loading />
        ) : entries.length === 0 ? (
          <EmptyState title={t("files.empty", "当前目录为空")} description={t("files.empty_desc", "没有文件或子目录")} />
        ) : (
          <DataTable
            columns={[
              { key: "name", label: t("files.col_name", "名称"), render: (e: FileEntry) => (
                <span style={{ color: e.isDirectory ? "var(--accent)" : "var(--text-primary)" }}>
                  {e.isDirectory ? "📁 " : "📄 "}{e.name}
                </span>
              ) },
              { key: "size", label: t("files.col_size", "大小"), render: (e: FileEntry) => formatSize(e.size) },
              { key: "type", label: t("files.col_type", "类型"), render: (e: FileEntry) => e.isDirectory ? t("files.dir", "目录") : t("files.file", "文件") },
              { key: "action", label: t("files.col_action", "操作"), render: (e: FileEntry) => (
                e.isDirectory
                  ? <SecondaryButton small onClick={() => navigateTo(e)}>{t("files.enter", "进入")}</SecondaryButton>
                  : <div style={{ display: "flex", gap: "6px" }}>
                      <SecondaryButton small onClick={() => navigateTo(e)}>{t("files.preview", "预览")}</SecondaryButton>
                      {e.downloadUrl && <a href={e.downloadUrl} download style={{ textDecoration: "none" }}>
                        <SecondaryButton small>{t("files.download", "下载")}</SecondaryButton>
                      </a>}
                    </div>
              ) },
            ]}
            data={entries}
            keyFn={(e) => e.path}
            emptyText={t("files.empty", "当前目录为空")}
          />
        )}
      </Section>

      {previewFile && (
        <Card title={t("files.preview_title", "文件预览") + " — " + previewFile.name}>
          {previewLoading ? (
            <Loading />
          ) : previewContent === null ? (
            <EmptyState title={t("files.preview_unavailable", "无法预览")} description={t("files.preview_unavailable_desc", "该文件类型不支持内联预览，请使用下载")} />
          ) : (
            <div style={s.preview}>{previewContent}</div>
          )}
          <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
            {previewFile.downloadUrl && <a href={previewFile.downloadUrl} download style={{ textDecoration: "none" }}>
              <SecondaryButton small>{t("files.download", "下载")}</SecondaryButton>
            </a>}
            <GhostButton small onClick={() => setPreviewFile(null)}>{t("common.close", "关闭")}</GhostButton>
          </div>
        </Card>
      )}
    </div>
  );
}