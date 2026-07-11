import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "./i18n";

declare const __APP_VERSION__: string;

interface CliEntry {
  id: number;
  type: "input" | "output" | "error" | "info";
  text: string;
  duration?: number;
}

interface CliResponse {
  success: boolean;
  output: string;
  error: string | null;
  exitCode: number;
  duration: number;
  timedOut: boolean;
}

const MAX_HISTORY = 50;
const HISTORY_KEY = "evoclaw_cli_history";

const COMMAND_COMPLETIONS: Record<string, string[]> = {
  EvoClaw: [
    "setup", "onboard", "configure", "config", "doctor", "dashboard", "completion",
    "health", "status", "sessions",
    "agent", "agents", "message", "acp",
    "skills", "memory", "models",
    "gateway", "logs", "system",
    "channels", "security", "secrets", "approvals", "pairing",
    "sandbox", "tasks", "hooks",
    "cron", "webhooks", "plugins", "mcp",
    "directory", "docs",
    "update", "backup", "uninstall", "reset",
  ],
  config: ["get", "set", "unset", "path", "file", "schema", "validate"],
  gateway: ["start", "stop", "restart", "run", "install", "uninstall", "status", "health", "probe", "discover", "call", "usage-cost"],
  channels: ["list", "status", "logs", "add", "remove", "login", "logout", "capabilities", "resolve"],
  skills: ["search", "install", "update", "list", "info", "check"],
  memory: ["status", "index", "search"],
  models: ["list", "status", "set", "set-image", "scan", "auth", "aliases", "fallbacks", "image-fallbacks"],
  hooks: ["list", "info", "check", "enable", "disable", "install", "update"],
  sandbox: ["list", "recreate", "explain"],
  cron: ["status", "list", "add", "edit", "rm", "enable", "disable", "runs", "run"],
  plugins: ["list", "info", "install", "enable", "disable", "doctor", "marketplace"],
  mcp: ["list", "show", "set", "unset", "serve"],
  directory: ["self", "peers", "groups"],
  security: ["audit"],
  system: ["events", "heartbeat", "presence"],
  message: ["send"],
  agents: ["list"],
  pairing: ["list", "approve"],
  approvals: ["get", "set", "allowlist"],
  secrets: ["list", "set"],
  update: ["status", "wizard"],
  sessions: ["cleanup"],
};

const FLAG_COMPLETIONS: Record<string, string[]> = {
  "--help": [],
  "--version": [],
  "--json": [],
  "--no-color": [],
  "--dev": [],
  "--log-level": ["silent", "fatal", "error", "warn", "info", "debug", "trace"],
  "--profile": [],
  "--fix": [],
  "--deep": [],
  "--force": [],
  "--yes": [],
  "--verbose": [],
  "--dry-run": [],
  "--all": [],
  "--follow": [],
};

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch {
    // storage full or unavailable
  }
}

const GLOBAL_FLAGS = ["--help", "--version", "--json", "--no-color", "--dev", "--log-level", "--profile", "--fix", "--deep", "--force", "--yes", "--verbose", "--dry-run", "--all", "--follow"];

function getCompletions(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed || !trimmed.startsWith("EvoClaw")) return [];

  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) return [];

  const lastPart = parts[parts.length - 1];
  if (lastPart === "") return [];

  if (lastPart.startsWith("-")) {
    return GLOBAL_FLAGS.filter((f) => f.startsWith(lastPart));
  }

  if (parts.length === 2) {
    return (COMMAND_COMPLETIONS.EvoClaw || []).filter((c) => c.startsWith(lastPart));
  }

  if (parts.length === 3 || parts.length >= 3) {
    const prevCmd = parts[1];
    const subCommands = COMMAND_COMPLETIONS[prevCmd];
    if (subCommands) {
      const candidates: string[] = [];
      if (!subCommands.includes(lastPart)) {
        candidates.push(...subCommands.filter((s) => s.startsWith(lastPart)));
      }
      const flagCandidates: string[] = [];
      for (const k of Object.keys(FLAG_COMPLETIONS)) {
        if (k.startsWith(lastPart)) flagCandidates.push(k);
      }
      return [...candidates, ...flagCandidates];
    }
    const flagCandidates: string[] = [];
    for (const k of Object.keys(FLAG_COMPLETIONS)) {
      if (k.startsWith(lastPart)) flagCandidates.push(k);
    }
    return flagCandidates;
  }

  return [];
}

function getCommonInfix(completions: string[], prefix: string): string {
  if (completions.length === 0) return prefix;
  let i = prefix.length;
  while (true) {
    const chars = completions.map((c) => c[i]);
    if (chars.every((ch) => ch !== undefined && ch === chars[0])) {
      i++;
    } else {
      break;
    }
  }
  return completions[0].slice(0, i);
}

function ansiToHtml(text: string): string {
  if (!text) return "";
  // 先对原始文本做完整 HTML 转义，再做 ANSI 颜色码转换，防止注入
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\x1b\[0m/g, "</span>")
    .replace(/\x1b\[1m/g, '<span style="font-weight:bold">')
    .replace(/\x1b\[4m/g, '<span style="text-decoration:underline">')
    .replace(/\x1b\[31m/g, '<span style="color:#E23D2D">')
    .replace(/\x1b\[32m/g, '<span style="color:#2FBF71">')
    .replace(/\x1b\[33m/g, '<span style="color:#FFB020">')
    .replace(/\x1b\[34m/g, '<span style="color:#4A90D9">')
    .replace(/\x1b\[35m/g, '<span style="color:#C77DFF">')
    .replace(/\x1b\[36m/g, '<span style="color:#00BCD4">')
    .replace(/\x1b\[37m/g, '<span style="color:#E0E0E0">')
    .replace(/\x1b\[90m/g, '<span style="color:#808080">')
    .replace(/\x1b\[91m/g, '<span style="color:#FF5252">')
    .replace(/\x1b\[92m/g, '<span style="color:#69F0AE">')
    .replace(/\x1b\[93m/g, '<span style="color:#FFD740">')
    .replace(/\x1b\[94m/g, '<span style="color:#448AFF">')
    .replace(/\x1b\[95m/g, '<span style="color:#E040FB">')
    .replace(/\x1b\[96m/g, '<span style="color:#18FFFF">')
    .replace(/\x1b\[97m/g, '<span style="color:#FFFFFF">')
    .replace(/\x1b\[[34]\d+m/g, "")
    .replace(/\x1b\[\d+(;\d+)?m/g, "");
}

function detectOS(): "windows" | "macos" | "linux" {
  const ua = navigator.userAgent || "";
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac")) return "macos";
  return "linux";
}

const OS_HINTS: Record<string, string> = {
  windows: "Windows: cmd.exe / PowerShell",
  macos: "macOS: Terminal.app / iTerm2",
  linux: "Linux: bash / zsh",
};

export const CLITerminal: React.FC = () => {
  const [entries, setEntries] = useState<CliEntry[]>(() => [
    { id: 0, type: "info", text: `EvoClaw CLI Terminal v${__APP_VERSION__}` },
    { id: 1, type: "info", text: `${OS_HINTS[detectOS()] || ""}` },
    { id: 2, type: "info", text: 'Type "EvoClaw --help" to get started. Up/Down for history, Tab for autocomplete.' },
    { id: 3, type: "info", text: "" },
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCompletions, setShowCompletions] = useState<{ list: string[]; selected: number } | null>(null);
  const { t } = useTranslation();

  const entryIdRef = useRef(4);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<string[]>(loadHistory());
  const historyNavRef = useRef(-1);
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  const osPlatform = useMemo(() => detectOS(), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [entries]);

  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("mousedown", handleGlobalClick);
    return () => document.removeEventListener("mousedown", handleGlobalClick);
  }, []);

  const addEntry = useCallback((entry: Omit<CliEntry, "id">) => {
    const id = entryIdRef.current++;
    setEntries((prev) => [...prev, { ...entry, id }]);
  }, []);

  const executeCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || running) return;
    const fullCmd = cmd.trim();
    if (!fullCmd.toLowerCase().startsWith("evoclaw ")) {
      addEntry({ type: "error", text: t("cli.error_must_start", 'Error: Commands must start with "EvoClaw". Try "EvoClaw --help"') });
      return;
    }

    addEntry({ type: "input", text: `$ ${fullCmd}` });
    setInput("");
    setRunning(true);

    try {
      const res = await fetch("/api/cli/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: fullCmd }),
      });

      const data: CliResponse = await res.json();

      if (data.output) {
        addEntry({ type: "output", text: data.output, duration: data.duration });
      }

      if (data.timedOut) {
        addEntry({ type: "error", text: t("cli.timeout", "Command timed out after 30 seconds") });
      } else if (data.error && !data.success) {
        addEntry({ type: "error", text: data.error, duration: data.duration });
      } else if (data.success && data.duration !== undefined) {
        addEntry({ type: "info", text: t("cli.completed", `Completed in ${data.duration}ms, exit code: ${data.exitCode}`) });
      }
    } catch (err) {
      addEntry({ type: "error", text: t("cli.connection_error", `Connection error: ${err instanceof Error ? err.message : "Unknown"}`) });
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }, [running, addEntry]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCompletions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setShowCompletions((prev) =>
          prev ? { ...prev, selected: Math.min(prev.selected + 1, prev.list.length - 1) } : prev
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setShowCompletions((prev) =>
          prev ? { ...prev, selected: Math.max(prev.selected - 1, 0) } : prev
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (showCompletions && showCompletions.list.length > 0) {
          const completion = showCompletions.list[showCompletions.selected];
          const parts = input.trim().split(/\s+/);
          parts[parts.length - 1] = completion;
          const prefix = input.trimEnd().split(/\s+/).slice(0, -1).join(" ") + " ";
          const newInput = parts.length > 1 ? prefix + completion : "EvoClaw " + completion;
          setInput(newInput);
          setShowCompletions(null);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowCompletions(null);
        return;
      }
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input.trim();
      if (!cmd) return;
      const history = historyRef.current.filter((h) => h !== cmd);
      history.unshift(cmd);
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
      historyRef.current = history;
      saveHistory(history);
      historyNavRef.current = -1;
      executeCommand(cmd);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const history = historyRef.current;
      if (history.length > 0) {
        const nextNav = Math.min(historyNavRef.current + 1, history.length - 1);
        historyNavRef.current = nextNav;
        setInput(history[nextNav]);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyNavRef.current > 0) {
        historyNavRef.current--;
        setInput(historyRef.current[historyNavRef.current]);
      } else if (historyNavRef.current === 0) {
        historyNavRef.current = -1;
        setInput("");
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const completions = getCompletions(input.trim());
      if (completions.length === 0) return;

      if (completions.length === 1) {
        const parts = input.trim().split(/\s+/);
        parts[parts.length - 1] = completions[0];
        const prefix = input.trimEnd().split(/\s+/).slice(0, -1).join(" ") + " ";
        const newInput = parts.length > 1 ? prefix + parts.slice(1).join(" ") : "EvoClaw " + completions[0];
        setInput(newInput);
        setShowCompletions(null);
      } else {
        const prefix = input.trimEnd().split(/\s+/).pop() || "";
        const common = getCommonInfix(completions, prefix);
        if (common !== prefix) {
          const parts = input.trim().split(/\s+/);
          parts[parts.length - 1] = common;
          const commonPrefix = input.trimEnd().split(/\s+/).slice(0, -1).join(" ") + " ";
          setInput(commonPrefix + parts.slice(1).join(" ") || "EvoClaw " + common);
        }
        setShowCompletions({ list: completions, selected: 0 });
      }
      return;
    }

    setShowCompletions(null);
  }, [input, showCompletions, executeCommand]);

  const handleCtrlC = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === "c") {
      if (running) {
        addEntry({ type: "info", text: "^C" });
        setRunning(false);
        inputRef.current?.focus();
      } else if (input.trim()) {
        setInput("");
        setShowCompletions(null);
      }
    }
  }, [running, input, addEntry]);

  useEffect(() => {
    window.addEventListener("keydown", handleCtrlC);
    return () => window.removeEventListener("keydown", handleCtrlC);
  }, [handleCtrlC]);

  const selectHistoryItem = (index: number) => {
    setInput(historyRef.current[index]);
    setShowHistory(false);
    historyNavRef.current = index;
    inputRef.current?.focus();
  };

  const clearHistory = () => {
    historyRef.current = [];
    saveHistory([]);
    setShowHistory(false);
  };

  const clearTerminal = () => {
    setEntries([
      { id: entryIdRef.current++, type: "info", text: t("cli.terminal_cleared", "Terminal cleared") },
      { id: entryIdRef.current++, type: "info", text: t("cli.type_help", 'Type "EvoClaw --help" to start') },
    ]);
  };

  const styles: Record<string, React.CSSProperties> = {
    container: {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      backgroundColor: "var(--bg-primary)",
      color: "var(--text-primary)",
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', 'Courier New', monospace",
      fontSize: "13px",
      lineHeight: "1.5",
    },
    header: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "6px 12px",
      backgroundColor: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border)",
      flexShrink: 0,
    },
    headerTitle: {
      fontWeight: 600,
      color: "var(--text-primary)",
      fontSize: "12px",
    },
    headerActions: {
      display: "flex",
      gap: "6px",
      alignItems: "center",
    },
    headerBtn: {
      background: "none",
      border: "1px solid var(--border)",
      color: "var(--text-secondary)",
      padding: "2px 8px",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "11px",
      fontFamily: "inherit",
    },
    output: {
      flex: 1,
      overflowY: "auto",
      padding: "8px 12px",
      backgroundColor: "var(--bg-primary)",
    },
    entry: {
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      marginBottom: "1px",
    },
    infoEntry: {
      color: "var(--text-secondary)",
    },
    errorEntry: {
      color: "var(--error)",
    },
    inputEntry: {
      color: "#FF7A3D",
    },
    outputEntry: {
      color: "var(--text-primary)",
    },
    inputArea: {
      display: "flex",
      alignItems: "flex-start",
      padding: "8px 12px",
      backgroundColor: "var(--bg-secondary)",
      borderTop: "1px solid var(--border)",
      flexShrink: 0,
      position: "relative" as const,
    },
    prompt: {
      color: "var(--success)",
      fontWeight: 600,
      marginRight: "6px",
      whiteSpace: "nowrap" as const,
      fontSize: "14px",
      userSelect: "none" as const,
      paddingTop: "2px",
      lineHeight: "1.5",
    },
    inputField: {
      flex: 1,
      background: "transparent",
      border: "none",
      color: "var(--text-primary)",
      fontFamily: "inherit",
      fontSize: "14px",
      outline: "none",
      caretColor: "#FF5A2D",
      resize: "none" as const,
      minHeight: "48px",
      lineHeight: "1.5",
    },
    runningDot: {
      display: "inline-block",
      width: "8px",
      height: "8px",
      borderRadius: "50%",
      backgroundColor: "var(--warning)",
      marginLeft: "8px",
      animation: "evoclaw-pulse 1s ease-in-out infinite",
    },
    historyDropdown: {
      position: "absolute" as const,
      bottom: "100%",
      left: "12px",
      right: "12px",
      maxHeight: "200px",
      overflowY: "auto",
      backgroundColor: "var(--bg-secondary)",
      border: "1px solid var(--border)",
      borderRadius: "6px 6px 0 0",
      boxShadow: "0 -4px 12px rgba(0,0,0,0.5)",
      zIndex: 100,
    },
    historyItem: {
      padding: "4px 12px",
      cursor: "pointer",
      color: "var(--text-primary)",
      fontSize: "12px",
      borderBottom: "1px solid var(--border)",
    },
    historyItemHover: {
      backgroundColor: "var(--bg-hover)",
    },
    completionsDropdown: {
      position: "absolute" as const,
      bottom: "100%",
      left: "12px",
      right: "12px",
      maxHeight: "180px",
      overflowY: "auto",
      backgroundColor: "var(--bg-secondary)",
      border: "1px solid var(--border)",
      borderRadius: "6px 6px 0 0",
      boxShadow: "0 -4px 12px rgba(0,0,0,0.5)",
      zIndex: 99,
    },
    completionItem: {
      padding: "2px 12px",
      color: "var(--text-primary)",
      fontSize: "12px",
      cursor: "pointer",
    },
    completionSelected: {
      backgroundColor: "#1F6FEB",
      color: "#fff",
    },
    durationText: {
      color: "var(--text-secondary)",
      fontSize: "11px",
      marginTop: "2px",
    },
  };

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes evoclaw-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .cli-scroll::-webkit-scrollbar { width: 6px; }
        .cli-scroll::-webkit-scrollbar-track { background: var(--bg-primary); }
        .cli-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        .cli-scroll::-webkit-scrollbar-thumb:hover { background: #484F58; }
      `}</style>

      <div style={styles.header}>
        <span style={styles.headerTitle}>
          🧬 {t("cli.title", "EvoClaw CLI Terminal")}
          <span style={{ color: "var(--text-secondary)", marginLeft: "8px", fontWeight: 400 }}>
            v{__APP_VERSION__} — {osPlatform}
          </span>
        </span>
        <div style={styles.headerActions}>
          <button
            style={styles.headerBtn}
            onClick={() => setShowHistory((v) => !v)}
            title={t("cli.command_history", "Command History")}
          >
            📜 {t("cli.history", "History")} ({historyRef.current.length})
          </button>
          <button style={styles.headerBtn} onClick={clearTerminal} title={t("cli.clear_terminal", "Clear Terminal")}>
            🗑 {t("cli.clear", "Clear")}
          </button>
          {running && <span style={styles.runningDot} title={t("cli.command_running", "Command running...")} />}
        </div>
      </div>

      <div
        ref={outputRef}
        className="cli-scroll"
        style={styles.output}
        onClick={() => inputRef.current?.focus()}
      >
        {entries.map((entry) => (
          <div key={entry.id} style={styles.entry}>
            {entry.type === "input" && (
              <span style={styles.inputEntry}>
                <span dangerouslySetInnerHTML={{ __html: ansiToHtml(entry.text) }} />
              </span>
            )}
            {entry.type === "output" && (
              <span style={styles.outputEntry}>
                <span dangerouslySetInnerHTML={{ __html: ansiToHtml(entry.text) }} />
                {entry.duration !== undefined && (
                  <div style={styles.durationText}>{entry.duration}ms</div>
                )}
              </span>
            )}
            {entry.type === "error" && (
              <span style={styles.errorEntry}>
                <span dangerouslySetInnerHTML={{ __html: ansiToHtml(entry.text) }} />
              </span>
            )}
            {entry.type === "info" && (
              <div style={styles.infoEntry}>
                <span dangerouslySetInnerHTML={{ __html: ansiToHtml(entry.text) }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {showCompletions && showCompletions.list.length > 0 && (
        <div style={styles.completionsDropdown}>
          {showCompletions.list.map((item, idx) => (
            <div
              key={idx}
              style={{
                ...styles.completionItem,
                ...(idx === showCompletions.selected ? styles.completionSelected : {}),
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const parts = input.trim().split(/\s+/);
                parts[parts.length - 1] = item;
                setInput(parts.join(" ") || "EvoClaw " + item);
                setShowCompletions(null);
                inputRef.current?.focus();
              }}
            >
              <span style={{ color: "var(--text-secondary)", marginRight: "8px" }}>{idx + 1}</span>
              {item}
            </div>
          ))}
        </div>
      )}

      {showHistory && historyRef.current.length > 0 && (
        <div ref={historyDropdownRef} style={styles.historyDropdown}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>{t("cli.command_history", "Command History")}</span>
            <button
              onClick={(e) => { e.stopPropagation(); clearHistory(); }}
              style={{ ...styles.headerBtn, fontSize: "10px" }}
            >
              {t("cli.clear_all", "Clear All")}
            </button>
          </div>
          {historyRef.current.map((cmd, idx) => (
            <div
              key={idx}
              style={{
                ...styles.historyItem,
                ...(idx % 2 === 0 ? styles.historyItemHover : {}),
              }}
              onClick={() => selectHistoryItem(idx)}
            >
              <span style={{ color: "var(--text-secondary)", marginRight: "8px", fontSize: "11px" }}>{idx + 1}.</span>
              {cmd}
            </div>
          ))}
        </div>
      )}

      <div style={styles.inputArea}>
        <span style={styles.prompt}>EvoClaw $</span>
        <textarea
          ref={inputRef}
          style={styles.inputField}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? t("cli.running", "Running...") : 'EvoClaw --help'}
          disabled={running}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          rows={2}
        />
      </div>
    </div>
  );
};