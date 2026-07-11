/**
 * ComputerUsePage — Computer Use 桌面控制台
 *
 * 展示后端可用性（isAvailable）、屏幕尺寸，
 * 截图查看（base64 图片展示），
 * 鼠标/键盘操作表单（坐标输入、按键选择），
 * 以及操作历史日志。
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  PageHeader, Card, Badge, Loading, EmptyState,
  PrimaryButton, SecondaryButton, Section,
  StatusDot, showToast, TextInput,
} from "./shared";
import { useApiCall } from "./useApiCall";
import { useTranslation } from "./i18n";
import {
  computerUseApi,
  type ComputerUseStatus,
  type ScreenshotResult,
} from "./api-client";

interface OpLogEntry {
  timestamp: string;
  action: string;
  result: string;
}

type MouseButton = "left" | "right" | "middle";

export default function ComputerUsePage() {
  const { t } = useTranslation();
  const { call } = useApiCall();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [screenshot, setScreenshot] = useState<ScreenshotResult | null>(null);
  const [shotLoading, setShotLoading] = useState(false);

  // Mouse form
  const [mouseX, setMouseX] = useState("");
  const [mouseY, setMouseY] = useState("");
  const [mouseButton, setMouseButton] = useState<MouseButton>("left");
  const [doubleClick, setDoubleClick] = useState(false);

  // Key form
  const [keyText, setKeyText] = useState("");
  const [keyPressCombo, setKeyPressCombo] = useState("");

  // Operation log
  const [logs, setLogs] = useState<OpLogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoadingState(true);
    try {
      const s = await computerUseApi.status();
      setStatus(s);
    } catch {
      setStatus({ isAvailable: false });
    } finally {
      setLoadingState(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  function appendLog(action: string, result: string) {
    setLogs(prev => [...prev, { timestamp: new Date().toISOString(), action, result }].slice(-50));
  }

  async function handleScreenshot() {
    setShotLoading(true);
    const result = await call(
      () => computerUseApi.screenshot(),
      { errorMessage: t("cu.screenshot_failed", "截图失败") },
    );
    if (result) {
      setScreenshot(result);
      appendLog(t("cu.screenshot", "截图"), "✓");
    }
    setShotLoading(false);
  }

  async function handleMouseClick() {
    const x = Number(mouseX);
    const y = Number(mouseY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      showToast(t("cu.invalid_coords", "请输入有效坐标"), "error");
      return;
    }
    const result = await call(
      () => computerUseApi.mouseClick(x, y, mouseButton, doubleClick),
      { errorMessage: t("cu.mouse_failed", "鼠标操作失败") },
    );
    if (result) {
      const desc = `(${x}, ${y}) ${mouseButton}${doubleClick ? " x2" : ""}`;
      appendLog(t("cu.mouse_click", "鼠标点击"), `${desc} — ${result.success ? "✓" : "✗"}`);
      showToast(t("cu.mouse_done", "鼠标操作完成"), "success");
    }
  }

  async function handleKeyType() {
    if (!keyText) return;
    const result = await call(
      () => computerUseApi.keyType(keyText),
      { errorMessage: t("cu.key_type_failed", "键盘输入失败") },
    );
    if (result) {
      const preview = keyText.length > 20 ? keyText.slice(0, 20) + "..." : keyText;
      appendLog(t("cu.key_type", "输入文本"), `"${preview}" — ${result.success ? "✓" : "✗"}`);
      showToast(t("cu.key_type_done", "输入完成"), "success");
    }
  }

  async function handleKeyPress() {
    const keys = keyPressCombo.split("+").map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) return;
    const result = await call(
      () => computerUseApi.keyPress(keys),
      { errorMessage: t("cu.key_press_failed", "按键操作失败") },
    );
    if (result) {
      appendLog(t("cu.key_press", "按键"), `${keys.join("+")} — ${result.success ? "✓" : "✗"}`);
      showToast(t("cu.key_press_done", "按键完成"), "success");
    }
  }

  if (loadingState) {
    return <Loading text={t("cu.loading", "加载桌面控制状态...")} />;
  }

  const available = status?.isAvailable === true;
  const screen = status?.screenSize;

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("cu.title", "Computer Use 桌面控制")}
        subtitle={t("cu.subtitle", "远程桌面控制：截图 / 鼠标 / 键盘操作")}
        actions={
          <SecondaryButton onClick={refresh}>
            {t("cu.refresh", "刷新")}
          </SecondaryButton>
        }
      />

      {/* Status */}
      <Section title={t("cu.status_title", "后端状态")}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <StatusDot status={available ? "available" : "offline"} size={12} />
            <span style={{ fontSize: 14, fontWeight: 600, color: available ? "var(--success)" : "var(--error)" }}>
              {available ? t("cu.available", "可用") : t("cu.unavailable", "不可用")}
            </span>
            {status?.backend && (
              <Badge variant="info">{t("cu.backend", "后端")}: {status.backend}</Badge>
            )}
            {screen && (
              <Badge variant="default">
                {t("cu.screen_size", "屏幕尺寸")}: {screen.width} × {screen.height}
              </Badge>
            )}
          </div>
          {!available && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
              {t("cu.unavailable_desc", "桌面控制后端未启用。需注册 computerBackend 服务（robotjs / nut-js / native）。")}
            </div>
          )}
        </Card>
      </Section>

      {/* Screenshot */}
      <Section title={t("cu.screenshot_title", "屏幕截图")}>
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {screenshot
                  ? `${t("cu.taken_at", "截图时间")}: ${new Date(screenshot.takenAt).toLocaleString()} (${screenshot.width}×${screenshot.height})`
                  : t("cu.no_screenshot", "暂无截图")}
              </span>
              <PrimaryButton onClick={handleScreenshot} disabled={!available || shotLoading} small>
                {shotLoading ? t("cu.capturing", "截图中...") : t("cu.capture", "截图")}
              </PrimaryButton>
            </div>
            {screenshot && (
              <div style={{
                background: "var(--bg-hover)", borderRadius: 8, padding: 8,
                border: "1px solid var(--border)", textAlign: "center",
                maxHeight: 400, overflow: "auto",
              }}>
                <img
                  src={`data:image/png;base64,${screenshot.image}`}
                  alt="screenshot"
                  style={{
                    maxWidth: "100%", maxHeight: 380, borderRadius: 4,
                    border: "1px solid var(--border)",
                  }}
                />
              </div>
            )}
          </div>
        </Card>
      </Section>

      {/* Mouse & Keyboard */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginBottom: 24 }}>
        {/* Mouse */}
        <Section title={t("cu.mouse_title", "鼠标操作")}>
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
                    {t("cu.x_coord", "X 坐标")}
                  </label>
                  <TextInput
                    value={mouseX}
                    onChange={setMouseX}
                    placeholder="0"
                    type="number"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
                    {t("cu.y_coord", "Y 坐标")}
                  </label>
                  <TextInput
                    value={mouseY}
                    onChange={setMouseY}
                    placeholder="0"
                    type="number"
                  />
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
                  {t("cu.button", "按键")}
                </label>
                <select
                  value={mouseButton}
                  onChange={(e) => setMouseButton(e.target.value as MouseButton)}
                  style={{
                    width: "100%", padding: "8px 12px", borderRadius: 8,
                    border: "1px solid var(--input-border)", background: "var(--bg-input)",
                    color: "var(--text-primary)", fontSize: 13, outline: "none",
                  }}
                >
                  <option value="left">{t("cu.left", "左键")}</option>
                  <option value="right">{t("cu.right", "右键")}</option>
                  <option value="middle">{t("cu.middle", "中键")}</option>
                </select>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={doubleClick}
                  onChange={(e) => setDoubleClick(e.target.checked)}
                />
                {t("cu.double_click", "双击")}
              </label>
              <PrimaryButton onClick={handleMouseClick} disabled={!available || !mouseX || !mouseY} small>
                {t("cu.execute_click", "执行点击")}
              </PrimaryButton>
            </div>
          </Card>
        </Section>

        {/* Keyboard */}
        <Section title={t("cu.keyboard_title", "键盘操作")}>
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
                  {t("cu.type_text", "输入文本")}
                </label>
                <TextInput
                  value={keyText}
                  onChange={setKeyText}
                  placeholder={t("cu.type_placeholder", "要输入的文本...")}
                />
                <PrimaryButton onClick={handleKeyType} disabled={!available || !keyText} small style={{ marginTop: 8, width: "100%" }}>
                  {t("cu.type_btn", "输入")}
                </PrimaryButton>
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
                  {t("cu.press_keys", "按键组合")} (e.g. ctrl+c)
                </label>
                <TextInput
                  value={keyPressCombo}
                  onChange={setKeyPressCombo}
                  placeholder="ctrl+c"
                />
                <PrimaryButton onClick={handleKeyPress} disabled={!available || !keyPressCombo.trim()} small style={{ marginTop: 8, width: "100%" }}>
                  {t("cu.press_btn", "按键")}
                </PrimaryButton>
              </div>
            </div>
          </Card>
        </Section>
      </div>

      {/* Operation Log */}
      <Section title={t("cu.op_log", "操作历史")}>
        <Card style={{ padding: "12px 16px" }}>
          {logs.length === 0 ? (
            <EmptyState title={t("cu.no_logs", "暂无操作记录")} />
          ) : (
            <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {logs.map((log, i) => (
                <div key={i} style={{
                  display: "flex", gap: 8, padding: "6px 8px", borderRadius: 4,
                  background: i % 2 === 0 ? "transparent" : "var(--bg-hover)",
                  fontSize: 12,
                }}>
                  <span style={{ color: "var(--text-muted)", flexShrink: 0, fontFamily: "monospace" }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span style={{ color: "var(--accent)", fontWeight: 600, minWidth: 80 }}>
                    {log.action}
                  </span>
                  <span style={{ color: "var(--text-secondary)" }}>
                    {log.result}
                  </span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}
