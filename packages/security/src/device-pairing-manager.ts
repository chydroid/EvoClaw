import * as crypto from "crypto";
import { EventBus, SystemEvents } from "@evoclaw/core";

export interface DeviceIdentity {
  deviceId: string;
  deviceType: "web" | "mobile" | "desktop" | "cli";
  deviceName: string;
  publicKey: string;
  fingerprint: string;
  createdAt: Date;
  lastSeenAt: Date;
  trusted: boolean;
}

export interface PairingSession {
  pairingCode: string;
  challenge: string;
  deviceType: DeviceIdentity["deviceType"];
  deviceName: string;
  publicKey?: string;
  createdAt: Date;
  expiresAt: Date;
  completed: boolean;
}

export interface DevicePairingConfig {
  pairingCodeLength?: number;
  pairingExpiryMinutes?: number;
  challengeLength?: number;
  maxTrustedDevices?: number;
}

const DEFAULT_CONFIG: Required<DevicePairingConfig> = {
  pairingCodeLength: 6,
  pairingExpiryMinutes: 10,
  challengeLength: 32,
  maxTrustedDevices: 50,
};

export class DevicePairingManager {
  private config: Required<DevicePairingConfig>;
  private trustedDevices = new Map<string, DeviceIdentity>();
  private pendingSessions = new Map<string, PairingSession>();
  private eventBus: EventBus;
  /** HMAC 密钥：用于设备指纹的密钥哈希，防止彩虹表攻击 */
  private readonly hmacKey: Buffer = crypto.randomBytes(32);

  constructor(eventBus: EventBus, config?: DevicePairingConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = eventBus;
  }

  initiatePairing(deviceType: DeviceIdentity["deviceType"], deviceName: string): {
    pairingCode: string;
    challenge: string;
    expiresAt: Date;
  } {
    const pairingCode = this.generatePairingCode();
    const challenge = crypto.randomBytes(this.config.challengeLength).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.pairingExpiryMinutes * 60_000);

    const session: PairingSession = {
      pairingCode,
      challenge,
      deviceType,
      deviceName,
      createdAt: now,
      expiresAt,
      completed: false,
    };

    this.pendingSessions.set(pairingCode, session);

    this.cleanupExpiredSessions();

    return { pairingCode, challenge, expiresAt };
  }

  completePairing(params: {
    pairingCode: string;
    publicKey: string;
    signature: string;
    deviceName?: string;
  }): DeviceIdentity | null {
    const session = this.pendingSessions.get(params.pairingCode);
    if (!session) return null;

    if (session.completed) return null;

    if (new Date() > session.expiresAt) {
      this.pendingSessions.delete(params.pairingCode);
      return null;
    }

    const verified = this.verifySignature(
      session.challenge,
      params.signature,
      params.publicKey
    );

    if (!verified) {
      return null;
    }

    const fingerprint = this.computeFingerprint(params.publicKey);
    const deviceId = this.deriveDeviceId(fingerprint);

    const existing = this.trustedDevices.get(deviceId);
    if (existing) {
      // Device already trusted — reject re-pairing to prevent overwriting the
      // trusted publicKey/fingerprint/deviceName from untrusted input.
      this.pendingSessions.delete(params.pairingCode);
      return null;
    }

    if (this.trustedDevices.size >= this.config.maxTrustedDevices) {
      return null;
    }

    const device: DeviceIdentity = {
      deviceId,
      deviceType: session.deviceType,
      deviceName: params.deviceName ?? session.deviceName,
      publicKey: params.publicKey,
      fingerprint,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      trusted: true,
    };

    this.trustedDevices.set(deviceId, device);
    session.completed = true;
    this.pendingSessions.delete(params.pairingCode);

    this.eventBus.publish(SystemEvents.SECURITY_ALERT, {
      type: "device_paired",
      deviceId,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
    }, "device-pairing-manager").catch(() => {});

    return device;
  }

  verifyDeviceChallenge(params: {
    deviceId: string;
    challenge: string;
    signature: string;
  }): boolean {
    const device = this.trustedDevices.get(params.deviceId);
    if (!device || !device.trusted) return false;

    const verified = this.verifySignature(
      params.challenge,
      params.signature,
      device.publicKey
    );

    if (verified) {
      device.lastSeenAt = new Date();
    }

    return verified;
  }

  generateChallenge(): string {
    return crypto.randomBytes(this.config.challengeLength).toString("hex");
  }

  trustDevice(deviceId: string): boolean {
    const device = this.trustedDevices.get(deviceId);
    if (!device) return false;
    device.trusted = true;
    return true;
  }

  revokeDevice(deviceId: string): boolean {
    const device = this.trustedDevices.get(deviceId);
    if (!device) return false;
    device.trusted = false;

    this.eventBus.publish(SystemEvents.SECURITY_ALERT, {
      type: "device_revoked",
      deviceId,
    }, "device-pairing-manager").catch(() => {});

    return true;
  }

  removeDevice(deviceId: string): boolean {
    return this.trustedDevices.delete(deviceId);
  }

  getDevice(deviceId: string): DeviceIdentity | undefined {
    return this.trustedDevices.get(deviceId);
  }

  listTrustedDevices(): DeviceIdentity[] {
    return Array.from(this.trustedDevices.values()).filter((d) => d.trusted);
  }

  listAllDevices(): DeviceIdentity[] {
    return Array.from(this.trustedDevices.values());
  }

  listPendingPairings(): PairingSession[] {
    const now = new Date();
    return Array.from(this.pendingSessions.values())
      .filter((s) => !s.completed && now <= s.expiresAt);
  }

  getPairingSession(code: string): PairingSession | undefined {
    return this.pendingSessions.get(code);
  }

  getStats(): {
    totalDevices: number;
    trustedDevices: number;
    pendingPairings: number;
  } {
    return {
      totalDevices: this.trustedDevices.size,
      trustedDevices: Array.from(this.trustedDevices.values()).filter((d) => d.trusted).length,
      pendingPairings: this.listPendingPairings().length,
    };
  }

  private verifySignature(challenge: string, signature: string, publicKeyPem: string): boolean {
    try {
      const verify = crypto.createVerify("SHA256");
      verify.update(challenge);
      verify.end();
      return verify.verify(publicKeyPem, signature, "base64");
    } catch {
      return false;
    }
  }

  private computeFingerprint(publicKeyPem: string): string {
    return crypto
      .createHmac("sha256", this.hmacKey)
      .update(publicKeyPem)
      .digest("hex")
      .slice(0, 16);
  }

  private deriveDeviceId(fingerprint: string): string {
    return `device-${fingerprint}`;
  }

  private generatePairingCode(): string {
    // 使用 rejection sampling 消除模运算偏差
    const max = Math.pow(10, this.config.pairingCodeLength);
    const limit = Math.floor(0xFFFFFFFF / max) * max;
    let num: number;
    do {
      num = crypto.randomBytes(4).readUInt32BE(0);
    } while (num >= limit);
    return String(num % max).padStart(this.config.pairingCodeLength, "0");
  }

  private cleanupExpiredSessions(): void {
    const now = new Date();
    for (const [code, session] of this.pendingSessions) {
      if (now > session.expiresAt || session.completed) {
        this.pendingSessions.delete(code);
      }
    }
  }

  dispose(): void {
    this.pendingSessions.clear();
    this.trustedDevices.clear();
  }
}
