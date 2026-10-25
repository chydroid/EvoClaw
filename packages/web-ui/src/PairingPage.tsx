/**
 * PairingPage — 可信设备管理（对标 hermes web/src/pages/PairingPage 的「设备」语义）。
 *
 * EvoClaw 的 pairing 是**设备配对**（web/mobile/desktop/cli），不是 hermes 的频道配对
 * （后者在本项目归 ChannelConfig 的 wechat pair-request/pair-status）。
 *
 * 后端能力：GET /api/pairing/devices（listTrustedDevices）、
 * POST /api/pairing/init（initiatePairing → pairingCode/challenge/expiresAt）、
 * DELETE /api/pairing/devices/:id（revokeDevice + removeDevice）。
 * verify 走公钥/签名，需另一个设备端配合，WebUI 不代为构造签名，故不提供 verify 入口。
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, GhostButton, DataTable, Modal, showToast,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";

interface DeviceIdentity {
  deviceId: string;
  deviceType: "web" | "mobile" | "desktop" | "cli";
  deviceName: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  lastSeenAt: string;
  trusted: boolean;
}

interface PairingInitResult {
  pairingCode: string;
  challenge: string;
  expiresAt: string;
}

const s: Record<string, CSSProperties> = {
  container: { padding: 20, height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: { padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px" },
  codeBox: { background: "var(--bg-tertiary, #161b22)", color: "var(--text-primary)", borderRadius: "8px", padding: "16px", fontFamily: "Consolas, Monaco, monospace", fontSize: "18px", letterSpacing: "2px", textAlign: "center", marginTop: "8px" },
  meta: { color: "var(--text-muted)", fontSize: "11px", marginTop: "6px" },
};

const TYPE_LABEL: Record<DeviceIdentity["deviceType"], string> = {
  web: "Web", mobile: "Mobile", desktop: "Desktop", cli: "CLI",
};

export function PairingPage() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<DeviceIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [initDeviceType, setInitDeviceType] = useState<"web" | "mobile" | "desktop" | "cli">("mobile");
  const [initDeviceName, setInitDeviceName] = useState("");
  const [initResult, setInitResult] = useState<PairingInitResult | null>(null);
  const [initLoading, setInitLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pairing/devices");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDevices(Array.isArray(data.devices) ? data.devices : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const handleInit = useCallback(async () => {
    setInitLoading(true);
    setInitResult(null);
    try {
      const res = await fetch("/api/pairing/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceType: initDeviceType, deviceName: initDeviceName }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setInitResult(data);
    } catch (err) {
      showToast(errorMessage(err), "error");
    } finally {
      setInitLoading(false);
    }
  }, [initDeviceType, initDeviceName]);

  const handleRevoke = useCallback(async (deviceId: string) => {
    setRevokingId(deviceId);
    try {
      const res = await fetch(`/api/pairing/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => null);
      if (data && data.success === false) {
        showToast(t("pairing.revoke_fail", "撤销失败"), "error");
        return;
      }
      showToast(t("pairing.revoke_ok", "已撤销设备"), "success");
      loadDevices();
    } catch (err) {
      showToast(errorMessage(err), "error");
    } finally {
      setRevokingId(null);
    }
  }, [loadDevices, t]);

  const openInitModal = useCallback(() => {
    setInitDeviceType("mobile");
    setInitDeviceName("");
    setInitResult(null);
    setInitModalOpen(true);
  }, []);

  return (
    <div style={s.container}>
      <PageHeader
        title={t("pairing.title", "设备配对")}
        subtitle={t("pairing.subtitle", "管理已信任的设备，或为新设备发起配对")}
        actions={
          <PrimaryButton small onClick={openInitModal}>{t("pairing.init", "发起配对")}</PrimaryButton>
        }
      />

      {error && <ErrorBanner message={error} />}

      <Section title={t("pairing.devices_header", "已信任的设备")}>
        {loading ? (
          <Loading />
        ) : devices.length === 0 ? (
          <EmptyState title={t("pairing.empty", "暂无已信任设备")} description={t("pairing.empty_desc", "点击「发起配对」为新设备生成配对码")} />
        ) : (
          <DataTable
            columns={[
              { key: "deviceName", label: t("pairing.col_device", "设备"), render: (d: DeviceIdentity) => (
                <div>
                  <div style={{ color: "var(--text-primary)" }}>{d.deviceName || d.deviceId}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: "10px" }}>{TYPE_LABEL[d.deviceType] || d.deviceType} · {d.deviceId.slice(0, 8)}…</div>
                </div>
              ) },
              { key: "fingerprint", label: t("pairing.col_fingerprint", "指纹"), render: (d: DeviceIdentity) => <span style={{ fontFamily: "monospace", fontSize: "11px" }}>{d.fingerprint?.slice(0, 16) || "-"}</span> },
              { key: "createdAt", label: t("pairing.col_created", "配对时间"), render: (d: DeviceIdentity) => d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "-" },
              { key: "lastSeenAt", label: t("pairing.col_last_seen", "最近活跃"), render: (d: DeviceIdentity) => d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleDateString() : "-" },
              { key: "action", label: t("pairing.col_action", "操作"), render: (d: DeviceIdentity) => (
                <GhostButton small onClick={() => { if (revokingId !== d.deviceId) handleRevoke(d.deviceId); }}>
                  {revokingId === d.deviceId ? t("pairing.revoking", "撤销中…") : t("pairing.revoke", "撤销")}
                </GhostButton>
              ) },
            ]}
            data={devices}
            keyFn={(d) => d.deviceId}
            emptyText={t("pairing.empty", "暂无已信任设备")}
          />
        )}
      </Section>

      {initModalOpen && (
        <Modal title={t("pairing.init", "发起配对")} onClose={() => setInitModalOpen(false)}>
          <p style={s.meta}>{t("pairing.init_desc", "选择设备类型并命名，系统生成配对码；在新设备上输入该码完成配对。")}</p>
          <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
            {(["web", "mobile", "desktop", "cli"] as const).map((type) => (
              <button key={type} style={initDeviceType === type ? { ...s.btn, background: "var(--accent)", color: "#fff", border: "none" } : s.btn} onClick={() => setInitDeviceType(type)}>
                {TYPE_LABEL[type]}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder={t("pairing.device_name_placeholder", "设备名称（可选）")}
            value={initDeviceName}
            onChange={(e) => setInitDeviceName(e.target.value)}
            style={{ width: "100%", marginTop: "12px", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-light)", background: "var(--bg-card)", color: "var(--text-primary)" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <GhostButton small onClick={() => setInitModalOpen(false)}>{t("common.cancel", "取消")}</GhostButton>
            <PrimaryButton small onClick={handleInit} disabled={initLoading}>
              {initLoading ? t("pairing.initing", "生成中…") : t("pairing.generate", "生成配对码")}
            </PrimaryButton>
          </div>
          {initResult && (
            <div style={{ marginTop: "16px", padding: "12px", background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)" }}>
              <div style={{ color: "var(--text-muted)", fontSize: "11px" }}>{t("pairing.code_label", "配对码")}</div>
              <div style={s.codeBox}>{initResult.pairingCode}</div>
              <div style={s.meta}>{t("pairing.expires", "有效期至")}: {new Date(initResult.expiresAt).toLocaleTimeString()}</div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}