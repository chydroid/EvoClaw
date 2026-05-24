/**
 * ConfigRPCPage — Read and write configuration values via dot-path notation.
 *
 * Supports get/set operations and browsing all config entries with prefix filtering.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable,
  TextInput, showToast,
} from "./shared";
import { configRpcApi } from "./api-client";

interface ConfigEntry {
  path: string;
  value: unknown;
  source: string;
}

export default function ConfigRPCPage() {
  const [dotPath, setDotPath] = useState("");
  const [currentValue, setCurrentValue] = useState<unknown>(undefined);
  const [valueLoading, setValueLoading] = useState(false);
  const [valueError, setValueError] = useState("");

  const [setValue, setSetValue] = useState("");
  const [setMode, setSetMode] = useState(false);

  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [browsePrefix, setBrowsePrefix] = useState("");
  const [browseLoading, setBrowseLoading] = useState(false);

  const handleGet = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setValueLoading(true);
    setValueError("");
    setCurrentValue(undefined);
    setSetMode(false);
    try {
      const res = await configRpcApi.get(path);
      setCurrentValue(res.value);
    } catch (err: unknown) {
      setValueError(err instanceof Error ? err.message : "Failed to get value");
    } finally {
      setValueLoading(false);
    }
  }, []);

  const handleSet = async () => {
    if (!dotPath.trim()) return;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(setValue);
      } catch {
        parsed = setValue;
      }
      const res = await configRpcApi.set(dotPath, parsed);
      setCurrentValue(res.value);
      setSetMode(false);
      showToast(`"${dotPath}" updated`, "success");
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Failed to set value", "error");
    }
  };

  const loadBrowse = useCallback(async () => {
    setBrowseLoading(true);
    try {
      const res = await configRpcApi.list(browsePrefix || undefined);
      setEntries(res.entries);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Failed to browse config", "error");
    } finally {
      setBrowseLoading(false);
    }
  }, [browsePrefix]);

  useEffect(() => { loadBrowse(); }, []);

  const formatValue = (v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "object") return JSON.stringify(v, null, 2);
    return String(v);
  };

  const displayValue = formatValue(currentValue);
  const isObject = currentValue !== null && currentValue !== undefined && typeof currentValue === "object";

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title="Config RPC"
        subtitle="Read and write configuration values via dot-path notation"
      />

      {/* Get / Set Section */}
      <Section title="Read / Write">
        <Card>
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "16px" }}>
            <div style={{ flex: 1, minWidth: "240px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>Dot Path</label>
              <TextInput
                value={dotPath}
                onChange={setDotPath}
                placeholder='e.g. "agent.default.model"'
              />
            </div>
            <PrimaryButton onClick={() => handleGet(dotPath)} disabled={!dotPath.trim()}>Get</PrimaryButton>
            {currentValue !== undefined && (
              <SecondaryButton onClick={() => { setSetMode(true); setSetValue(formatValue(currentValue)); }}>Set</SecondaryButton>
            )}
          </div>

          {valueLoading && <Loading text="Fetching value..." />}
          {valueError && <ErrorBanner message={valueError} />}

          {currentValue !== undefined && !valueLoading && !setMode && (
            <div style={{
              padding: "14px 16px", borderRadius: "8px",
              background: "var(--bg-hover)", border: "1px solid var(--border)",
            }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "8px" }}>
                Current Value
              </div>
              {isObject ? (
                <pre style={{
                  margin: 0, fontSize: "12px", color: "var(--text-primary)",
                  whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: "1.6",
                  fontFamily: "Consolas, Monaco, monospace",
                }}>
                  {displayValue}
                </pre>
              ) : (
                <code style={{
                  fontSize: "15px", fontWeight: 600, color: "var(--accent)",
                  fontFamily: "Consolas, Monaco, monospace",
                }}>
                  {displayValue}
                </code>
              )}
            </div>
          )}

          {setMode && (
            <div style={{
              padding: "14px 16px", borderRadius: "8px",
              background: "var(--bg-hover)", border: "1px solid var(--accent)",
              marginTop: "8px",
            }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--accent)", textTransform: "uppercase", marginBottom: "8px" }}>
                New Value (JSON or plain text)
              </div>
              <textarea
                value={setValue}
                onChange={(e) => setSetValue(e.target.value)}
                rows={6}
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: "8px",
                  border: "1px solid var(--input-border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: "13px", fontFamily: "Consolas, Monaco, monospace",
                  resize: "vertical", boxSizing: "border-box", outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                <PrimaryButton onClick={handleSet}>Save</PrimaryButton>
                <SecondaryButton onClick={() => setSetMode(false)}>Cancel</SecondaryButton>
              </div>
            </div>
          )}
        </Card>
      </Section>

      {/* Browse Section */}
      <div style={{ marginTop: "24px" }} />
      <Section title="Browse">
        <Card>
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", marginBottom: "16px" }}>
            <div style={{ flex: 1, maxWidth: "400px" }}>
              <TextInput
                value={browsePrefix}
                onChange={setBrowsePrefix}
                placeholder='Filter by prefix, e.g. "agent."'
              />
            </div>
            <SecondaryButton small onClick={loadBrowse}>Refresh</SecondaryButton>
          </div>

          {browseLoading ? (
            <Loading text="Loading entries..." />
          ) : entries.length === 0 ? (
            <EmptyState title="No config entries" description="No configuration entries found." />
          ) : (
            <DataTable
              columns={[
                {
                  key: "path", label: "Path",
                  render: (e: ConfigEntry) => (
                    <code style={{ fontSize: "12px", color: "var(--accent)", fontFamily: "Consolas, Monaco, monospace" }}>
                      {e.path}
                    </code>
                  ),
                },
                {
                  key: "value", label: "Value",
                  render: (e: ConfigEntry) => {
                    const s = typeof e.value === "object" ? JSON.stringify(e.value) : String(e.value ?? "—");
                    return (
                      <span style={{ fontSize: "12px", color: "var(--text-primary)", maxWidth: "300px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s}
                      </span>
                    );
                  },
                },
                {
                  key: "source", label: "Source",
                  render: (e: ConfigEntry) => <Badge variant="info">{e.source}</Badge>,
                },
              ]}
              data={entries}
              keyFn={(e) => e.path}
              emptyText="No entries"
            />
          )}
        </Card>
      </Section>
    </div>
  );
}