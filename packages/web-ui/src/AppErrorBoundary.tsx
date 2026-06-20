/**
 * AppErrorBoundary — top-level React error boundary for the Web UI.
 *
 * Catches rendering errors anywhere in the component tree and presents a
 * friendly full-screen fallback with retry / reload options.
 */

import React, { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[AppErrorBoundary] Caught error:", error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.overlay}>
          <div style={styles.card}>
            <h2 style={styles.title}>应用遇到了问题</h2>
            <p style={styles.message}>
              抱歉，EvoClaw Web UI 在渲染时发生错误。请尝试刷新页面，或点击重试。
            </p>
            {this.state.error && (
              <pre style={styles.detail}>{this.state.error.message}</pre>
            )}
            <div style={styles.actions}>
              <button style={styles.primary} onClick={this.handleRetry}>
                重试
              </button>
              <button style={styles.secondary} onClick={this.handleReload}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--bg, #0d1117)",
    color: "var(--text-primary, #c9d1d9)",
    padding: 24,
    zIndex: 10000,
  },
  card: {
    maxWidth: 520,
    width: "100%",
    background: "var(--bg-card, #161b22)",
    border: "1px solid var(--border, #30363d)",
    borderRadius: 12,
    padding: "28px 32px",
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
  },
  title: { margin: "0 0 12px", fontSize: 20, fontWeight: 600 },
  message: { margin: "0 0 16px", fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary, #8b949e)" },
  detail: {
    margin: "0 0 20px",
    padding: 12,
    background: "rgba(248,81,73,0.1)",
    border: "1px solid rgba(248,81,73,0.3)",
    borderRadius: 6,
    color: "#f85149",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  actions: { display: "flex", gap: 12 },
  primary: {
    flex: 1,
    padding: "10px 16px",
    borderRadius: 6,
    border: "none",
    background: "var(--accent, #007bff)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  },
  secondary: {
    flex: 1,
    padding: "10px 16px",
    borderRadius: 6,
    border: "1px solid var(--border, #30363d)",
    background: "var(--bg-hover, #21262d)",
    color: "var(--text-primary, #c9d1d9)",
    cursor: "pointer",
    fontWeight: 600,
  },
};
