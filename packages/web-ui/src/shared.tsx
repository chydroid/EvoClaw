/**
 * EvoClaw WebUI — Shared Components
 *
 * Reusable UI primitives with consistent theming and inline styles.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties, ReactNode } from "react";

// ═══════════════════════════════════════════════
// Spinner
// ═══════════════════════════════════════════════

export function Spinner({ size = 24, color }: { size?: number; color?: string }) {
  return (
    <div style={{
      width: size, height: size, border: `3px solid var(--border)`,
      borderTopColor: color || "var(--accent)", borderRadius: "50%",
      animation: "spin 0.6s linear infinite",
      display: "inline-block",
    }} />
  );
}

// ═══════════════════════════════════════════════
// Loading
// ═══════════════════════════════════════════════

export function Loading({ text = "Loading..." }: { text?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 0", gap: "12px" }}>
      <Spinner size={32} />
      <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>{text}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════
// Card
// ═══════════════════════════════════════════════

export function Card({ title, children, style, actions }: {
  title?: ReactNode; children: ReactNode; style?: CSSProperties;
  actions?: ReactNode;
}) {
  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: "10px", padding: "20px",
      transition: "border-color 0.2s",
      ...style,
    }}>
      {title && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h3>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Badge
// ═══════════════════════════════════════════════

export type BadgeVariant = "success" | "error" | "warning" | "info" | "default";

const badgeColors: Record<BadgeVariant, { bg: string; fg: string }> = {
  success: { bg: "var(--success-bg)", fg: "var(--success)" },
  error: { bg: "var(--error-bg)", fg: "var(--error)" },
  warning: { bg: "var(--warning-bg)", fg: "var(--warning)" },
  info: { bg: "var(--accent-bg)", fg: "var(--accent)" },
  default: { bg: "var(--bg-hover)", fg: "var(--text-secondary)" },
};

export function Badge({ variant = "default", children, style }: {
  variant?: BadgeVariant; children: ReactNode; style?: CSSProperties;
}) {
  const c = badgeColors[variant];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "4px",
      padding: "3px 10px", borderRadius: "12px", fontSize: "11px",
      fontWeight: 600, background: c.bg, color: c.fg,
      border: `1px solid ${c.fg}30`,
      ...style,
    }}>
      {children}
    </span>
  );
}

// ═══════════════════════════════════════════════
// StatusDot
// ═══════════════════════════════════════════════

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const color =
    status === "healthy" || status === "active" || status === "running" || status === "online" || status === "completed" ? "var(--success)" :
    status === "degraded" || status === "warning" || status === "retrying" ? "var(--warning)" :
    status === "unhealthy" || status === "error" || status === "failed" || status === "offline" || status === "dead" ? "var(--error)" :
    "var(--text-muted)";
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: color, flexShrink: 0,
    }} />
  );
}

// ═══════════════════════════════════════════════
// Toast / Notification
// ═══════════════════════════════════════════════

interface ToastData { id: number; message: string; type: "success" | "error" | "info"; }

let toastId = 0;
const listeners = new Set<(toasts: ToastData[]) => void>();
let toastState: ToastData[] = [];

function emit() { listeners.forEach((fn) => fn([...toastState])); }

export function showToast(message: string, type: "success" | "error" | "info" = "info", duration = 3000) {
  const id = ++toastId;
  toastState = [...toastState, { id, message, type }];
  emit();
  setTimeout(() => {
    toastState = toastState.filter((t) => t.id !== id);
    emit();
  }, duration);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  useEffect(() => {
    const fn = (t: ToastData[]) => setToasts(t);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  return (
    <div style={{ position: "fixed", top: "16px", right: "16px", zIndex: 10000, display: "flex", flexDirection: "column", gap: "8px" }}>
      {toasts.map((t) => (
        <div key={t.id} style={{
          padding: "10px 18px", borderRadius: "8px", fontSize: "13px",
          fontWeight: 500, boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          animation: "EvoClaw-slide-in 0.25s ease-out",
          background: t.type === "success" ? "var(--success-bg)" : t.type === "error" ? "var(--error-bg)" : "var(--accent-bg)",
          color: t.type === "success" ? "var(--success)" : t.type === "error" ? "var(--error)" : "var(--accent)",
          border: `1px solid ${t.type === "success" ? "var(--success)" : t.type === "error" ? "var(--error)" : "var(--accent)"}40`,
          maxWidth: "360px",
        }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════════

export function Modal({ title, children, onClose, footer, width }: {
  title?: string; children: ReactNode; onClose: () => void;
  footer?: ReactNode; width?: number;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  return (
    <div ref={overlayRef} onClick={handleClick} style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 10000, backdropFilter: "blur(4px)",
      animation: "EvoClaw-fade-in 0.2s ease-out",
    }}>
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: "12px", width: width || 520, maxWidth: "94vw",
        maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.4)", animation: "EvoClaw-scale-in 0.2s ease-out",
      }}>
        {title && (
          <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h3>
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: "6px", border: "none",
              background: "transparent", color: "var(--text-muted)", cursor: "pointer",
              fontSize: "18px", display: "flex", alignItems: "center", justifyContent: "center",
            }}>x</button>
          </div>
        )}
        <div style={{ padding: "20px 22px", overflow: "auto", flex: 1 }}>
          {children}
        </div>
        {footer && (
          <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// Button variants
// ═══════════════════════════════════════════════

export function PrimaryButton({ children, onClick, disabled, small, danger, style }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  small?: boolean; danger?: boolean; style?: CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? "6px 14px" : "9px 20px", borderRadius: "8px", border: "none",
      background: danger ? "var(--error)" : "var(--accent)", color: "#fff",
      cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600,
      fontSize: small ? "12px" : "13px",
      opacity: disabled ? 0.5 : 1, transition: "opacity 0.15s, filter 0.15s",
      ...style,
    }}>
      {children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, disabled, small, style }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  small?: boolean; style?: CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? "6px 14px" : "9px 20px", borderRadius: "8px",
      border: "1px solid var(--border)", background: "var(--bg-hover)",
      color: "var(--text-primary)", cursor: disabled ? "not-allowed" : "pointer",
      fontWeight: 500, fontSize: small ? "12px" : "13px",
      transition: "background 0.15s", opacity: disabled ? 0.5 : 1,
      ...style,
    }}>
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, small, style }: {
  children: ReactNode; onClick?: () => void; small?: boolean; style?: CSSProperties;
}) {
  return (
    <button onClick={onClick} style={{
      padding: small ? "4px 10px" : "6px 14px", borderRadius: "6px", border: "none",
      background: "transparent", color: "var(--text-secondary)", cursor: "pointer",
      fontSize: small ? "11px" : "12px", transition: "background 0.15s, color 0.15s",
      ...style,
    }}>
      {children}
    </button>
  );
}

// ═══════════════════════════════════════════════
// Table
// ═══════════════════════════════════════════════

export function DataTable<T>({ columns, data, keyFn, emptyText, rowStyle }: {
  columns: Array<{ key: string; label: string; render?: (item: T) => ReactNode; width?: string }>;
  data: T[]; keyFn: (item: T, i: number) => string;
  emptyText?: string; rowStyle?: CSSProperties;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} style={{
              textAlign: "left", padding: "10px 12px", color: "var(--text-muted)",
              fontWeight: 600, fontSize: "11px", textTransform: "uppercase",
              letterSpacing: "0.3px", borderBottom: "1px solid var(--border)",
              width: col.width,
            }}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.length === 0 ? (
          <tr>
            <td colSpan={columns.length} style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
              {emptyText || "No data"}
            </td>
          </tr>
        ) : (
          data.map((item, i) => (
            <tr key={keyFn(item, i)} style={{
              borderBottom: "1px solid var(--border-light)",
              ...rowStyle,
            }}>
              {columns.map((col) => (
                <td key={col.key} style={{ padding: "10px 12px", color: "var(--text-primary)", verticalAlign: "middle" }}>
                  {col.render ? col.render(item) : String((item as Record<string, unknown>)[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// ═══════════════════════════════════════════════
// Page Header
// ═══════════════════════════════════════════════

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: string; actions?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "8px" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--text-muted)" }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Toggle Switch
// ═══════════════════════════════════════════════

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void;
  disabled?: boolean; label?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}>
      <div onClick={() => !disabled && onChange(!checked)} style={{
        width: "40px", height: "22px", borderRadius: "11px",
        background: checked ? "var(--accent)" : "var(--toggle-track-bg)",
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}>
        <div style={{
          width: "18px", height: "18px", borderRadius: "50%",
          background: "#fff", position: "absolute", top: "2px",
          left: checked ? "20px" : "2px", transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }} />
      </div>
      {label && <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>{label}</span>}
    </label>
  );
}

// ═══════════════════════════════════════════════
// Input
// ═══════════════════════════════════════════════

export function TextInput({ value, onChange, placeholder, type, style }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  type?: string; style?: CSSProperties;
}) {
  return (
    <input
      type={type || "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: "8px 12px", borderRadius: "8px",
        border: "1px solid var(--input-border)", background: "var(--bg-input)",
        color: "var(--text-primary)", fontSize: "13px",
        outline: "none", width: "100%", boxSizing: "border-box",
        transition: "border-color 0.15s",
        ...style,
      }}
    />
  );
}

// ═══════════════════════════════════════════════
// Stats Grid
// ═══════════════════════════════════════════════

export function StatsGrid({ items }: { items: Array<{ label: string; value: string | number; color?: string; sub?: string }> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
      {items.map((item, i) => (
        <div key={i} style={{
          background: "var(--bg-card)", border: "1px solid var(--border-light)",
          borderRadius: "8px", padding: "14px 16px",
        }}>
          <div style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.5px", marginBottom: "4px" }}>{item.label}</div>
          <div style={{ fontSize: "22px", fontWeight: 700, color: item.color || "var(--text-primary)" }}>{item.value}</div>
          {item.sub && <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>{item.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════
// EmptyState
// ═══════════════════════════════════════════════

export function EmptyState({ icon, title, description }: { icon?: string; title: string; description?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-muted)" }}>
      {icon && <div style={{ fontSize: "40px", marginBottom: "12px" }}>{icon}</div>}
      <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "4px", color: "var(--text-secondary)" }}>{title}</div>
      {description && <div style={{ fontSize: "13px" }}>{description}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ErrorBanner
// ═══════════════════════════════════════════════

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{ padding: "12px 16px", borderRadius: "8px", background: "var(--error-bg)", border: "1px solid var(--error)", color: "var(--error)", fontSize: "13px", display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && <button onClick={onRetry} style={{ padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--error)", background: "transparent", color: "var(--error)", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>Retry</button>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Section
// ═══════════════════════════════════════════════

export function Section({ title, children, style }: { title?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ marginBottom: "24px", ...style }}>
      {title && <h3 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600, color: "var(--section-title-color)" }}>{title}</h3>}
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ConfirmModal
// ═══════════════════════════════════════════════

export function ConfirmModal({ title, message, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel?: string;
  danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} footer={
      <>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton danger={danger} onClick={onConfirm}>{confirmLabel || "Confirm"}</PrimaryButton>
      </>
    }>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>{message}</p>
    </Modal>
  );
}