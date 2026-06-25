import { describe, it, expect, vi, beforeEach } from "vitest";
import * as crypto from "crypto";
import { DevicePairingManager } from "./device-pairing-manager";

const mockEventBus = {
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
};

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

function signChallenge(challenge: string, privateKey: string): string {
  const sign = crypto.createSign("SHA256");
  sign.update(challenge);
  sign.end();
  return sign.sign(privateKey, "base64");
}

describe("DevicePairingManager", () => {
  let manager: DevicePairingManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new DevicePairingManager(mockEventBus as any, {
      pairingExpiryMinutes: 5,
      maxTrustedDevices: 10,
    });
  });

  describe("initiatePairing", () => {
    it("should create a pairing session with code and challenge", () => {
      const result = manager.initiatePairing("web", "Test Browser");

      expect(result.pairingCode).toBeDefined();
      expect(result.pairingCode.length).toBe(6);
      expect(result.challenge).toBeDefined();
      expect(result.challenge.length).toBe(64);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("should generate unique pairing codes", () => {
      const r1 = manager.initiatePairing("web", "Device 1");
      const r2 = manager.initiatePairing("mobile", "Device 2");

      expect(r1.pairingCode).not.toBe(r2.pairingCode);
      expect(r1.challenge).not.toBe(r2.challenge);
    });

    it("should list pending pairings", () => {
      manager.initiatePairing("web", "Browser");
      manager.initiatePairing("mobile", "Phone");

      const pending = manager.listPendingPairings();
      expect(pending.length).toBe(2);
    });
  });

  describe("completePairing", () => {
    it("should complete pairing with valid signature", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");

      const signature = signChallenge(session.challenge, privateKey);

      const device = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device).not.toBeNull();
      expect(device!.deviceId).toMatch(/^device-/);
      expect(device!.deviceType).toBe("web");
      expect(device!.deviceName).toBe("Test Browser");
      expect(device!.trusted).toBe(true);
      expect(device!.publicKey).toBe(publicKey);
    });

    it("should reject invalid signature", () => {
      const { publicKey } = generateKeyPair();
      const { privateKey: wrongKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");

      const wrongSignature = signChallenge(session.challenge, wrongKey);

      const device = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature: wrongSignature,
      });

      expect(device).toBeNull();
    });

    it("should reject unknown pairing code", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const challenge = "some-challenge";
      const signature = signChallenge(challenge, privateKey);

      const device = manager.completePairing({
        pairingCode: "000000",
        publicKey,
        signature,
      });

      expect(device).toBeNull();
    });

    it("should reject already completed pairing", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");

      const signature = signChallenge(session.challenge, privateKey);

      const device1 = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device1).not.toBeNull();

      const device2 = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device2).toBeNull();
    });

    it("should reject re-pairing of an already trusted device", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");
      const signature = signChallenge(session.challenge, privateKey);

      const device1 = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device1).not.toBeNull();

      const session2 = manager.initiatePairing("web", "Updated Browser");
      const signature2 = signChallenge(session2.challenge, privateKey);

      const device2 = manager.completePairing({
        pairingCode: session2.pairingCode,
        publicKey,
        signature: signature2,
        deviceName: "Updated Browser",
      });

      expect(device2).toBeNull();
    });

    it("should emit security event on pairing", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("mobile", "Phone");
      const signature = signChallenge(session.challenge, privateKey);

      manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        "security.alert",
        expect.objectContaining({
          type: "device_paired",
        }),
        "device-pairing-manager"
      );
    });
  });

  describe("verifyDeviceChallenge", () => {
    it("should verify a valid challenge signature from trusted device", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");
      const signature = signChallenge(session.challenge, privateKey);

      const device = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device).not.toBeNull();

      const newChallenge = manager.generateChallenge();
      const newSignature = signChallenge(newChallenge, privateKey);

      const verified = manager.verifyDeviceChallenge({
        deviceId: device!.deviceId,
        challenge: newChallenge,
        signature: newSignature,
      });

      expect(verified).toBe(true);
    });

    it("should reject challenge with wrong key", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const { privateKey: wrongKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");
      const signature = signChallenge(session.challenge, privateKey);

      const device = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device).not.toBeNull();

      const newChallenge = manager.generateChallenge();
      const wrongSignature = signChallenge(newChallenge, wrongKey);

      const verified = manager.verifyDeviceChallenge({
        deviceId: device!.deviceId,
        challenge: newChallenge,
        signature: wrongSignature,
      });

      expect(verified).toBe(false);
    });

    it("should reject unknown device", () => {
      const challenge = manager.generateChallenge();
      const { privateKey } = generateKeyPair();
      const signature = signChallenge(challenge, privateKey);

      const verified = manager.verifyDeviceChallenge({
        deviceId: "device-unknown",
        challenge,
        signature,
      });

      expect(verified).toBe(false);
    });
  });

  describe("device management", () => {
    it("should trust and revoke devices", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");
      const signature = signChallenge(session.challenge, privateKey);

      const device = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device!.trusted).toBe(true);

      manager.revokeDevice(device!.deviceId);
      expect(manager.getDevice(device!.deviceId)!.trusted).toBe(false);

      manager.trustDevice(device!.deviceId);
      expect(manager.getDevice(device!.deviceId)!.trusted).toBe(true);
    });

    it("should remove devices", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Test Browser");
      const signature = signChallenge(session.challenge, privateKey);

      const device = manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature,
      });

      expect(device).not.toBeNull();

      const removed = manager.removeDevice(device!.deviceId);
      expect(removed).toBe(true);
      expect(manager.getDevice(device!.deviceId)).toBeUndefined();
    });

    it("should list trusted devices", () => {
      const { publicKey: pk1, privateKey: sk1 } = generateKeyPair();
      const { publicKey: pk2, privateKey: sk2 } = generateKeyPair();

      const s1 = manager.initiatePairing("web", "Browser");
      manager.completePairing({
        pairingCode: s1.pairingCode,
        publicKey: pk1,
        signature: signChallenge(s1.challenge, sk1),
      });

      const s2 = manager.initiatePairing("mobile", "Phone");
      manager.completePairing({
        pairingCode: s2.pairingCode,
        publicKey: pk2,
        signature: signChallenge(s2.challenge, sk2),
      });

      const trusted = manager.listTrustedDevices();
      expect(trusted.length).toBe(2);
      expect(trusted.map((d) => d.deviceName).sort()).toEqual(["Browser", "Phone"]);
    });

    it("should enforce max trusted devices limit", () => {
      const limitedManager = new DevicePairingManager(mockEventBus as any, {
        maxTrustedDevices: 1,
      });

      const { publicKey: pk1, privateKey: sk1 } = generateKeyPair();
      const s1 = limitedManager.initiatePairing("web", "Browser 1");
      const d1 = limitedManager.completePairing({
        pairingCode: s1.pairingCode,
        publicKey: pk1,
        signature: signChallenge(s1.challenge, sk1),
      });
      expect(d1).not.toBeNull();

      const { publicKey: pk2, privateKey: sk2 } = generateKeyPair();
      const s2 = limitedManager.initiatePairing("web", "Browser 2");
      const d2 = limitedManager.completePairing({
        pairingCode: s2.pairingCode,
        publicKey: pk2,
        signature: signChallenge(s2.challenge, sk2),
      });
      expect(d2).toBeNull();

      limitedManager.dispose();
    });
  });

  describe("stats", () => {
    it("should return correct stats", () => {
      const stats = manager.getStats();
      expect(stats.totalDevices).toBe(0);
      expect(stats.trustedDevices).toBe(0);
      expect(stats.pendingPairings).toBe(0);

      manager.initiatePairing("web", "Browser");
      const stats2 = manager.getStats();
      expect(stats2.pendingPairings).toBe(1);

      const { publicKey, privateKey } = generateKeyPair();
      const session = manager.initiatePairing("web", "Paired Browser");
      manager.completePairing({
        pairingCode: session.pairingCode,
        publicKey,
        signature: signChallenge(session.challenge, privateKey),
      });

      const stats3 = manager.getStats();
      expect(stats3.totalDevices).toBe(1);
      expect(stats3.trustedDevices).toBe(1);
    });
  });

  describe("dispose", () => {
    it("should clear all state", () => {
      manager.initiatePairing("web", "Browser");
      manager.dispose();

      expect(manager.listPendingPairings()).toEqual([]);
      expect(manager.listAllDevices()).toEqual([]);
    });
  });
});
