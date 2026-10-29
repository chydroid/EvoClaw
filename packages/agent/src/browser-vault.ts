/**
 * BrowserVault — 浏览器凭据保险库（对标 Hermes agent/vault_store.py + vault_backends/local.py）。
 *
 * 设计契约（model-blind）：
 *   - 密码/卡号/CVC/TOTP 种子等机密只在服务端内存中解析（resolveSecret），
 *     绝不写入工具结果、日志或会话数据库。
 *   - list 只返回 handle + 元数据（login 的 identifier 是标识符不是机密，agent 可读）。
 *   - origin 绑定：fill 前当前页 origin 必须与条目 origin 完全一致（无通配/子域推断）。
 *   - 静态加密：AES-256-GCM，密钥文件 vault.key（0600，首次生成），库文件 vault.json（0600）。
 *
 * 与 Hermes 的差异：
 *   - Hermes 的 local 后端用 Fernet（AES-128-CBC）；此处用 AES-256-GCM（Node 原生支持，
 *     带完整性标签，无 padding oracle）。
 *   - Hermes 的 TOTP 默认 SHA1/6 位/30s；此处一致，并支持 otpauth:// URI 携带的
 *     algorithm/digits/period 参数。
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "@evoclaw/core";

// ── 类型 ────────────────────────────────────────────────────────────────────

export type VaultKind = "login" | "payment" | "address";
export type OtpAlgo = "SHA1" | "SHA256" | "SHA512";

export class VaultError extends Error {}

/** 条目元数据（公开视图，绝不含机密值）。 */
export interface VaultItemMeta {
  handle: string;
  kind: VaultKind;
  label: string;
  origin: string | null;
  createdAt: string;
  /** login：标识符（email/username/phone）——不是机密，agent 可读可自行输入。 */
  identifier?: string;
  identifierType?: string;
  /** 存有 TOTP 种子：2FA 验证码可自动生成，无需询问用户。 */
  hasOtp: boolean;
  allowedOrigins?: string[];
}

/** 库内存储条目（加密前明文形态）。 */
interface VaultStoreItem {
  id: string;
  kind: VaultKind;
  label: string;
  origin: string | null;
  allowedOrigins?: string[];
  identifier?: string;
  identifierType?: string;
  password?: string;
  otpSecret?: string;
  otpAlgo?: OtpAlgo;
  otpDigits?: number;
  otpPeriod?: number;
  fields?: Record<string, string>;
  createdAt: string;
}

interface VaultStoreFile {
  version: 1;
  items: VaultStoreItem[];
}

export interface AddItemInput {
  kind: VaultKind;
  label: string;
  origin?: string | null;
  identifier?: string;
  identifierType?: string;
  password?: string;
  otpSecret?: string;
  fields?: Record<string, string>;
}

export interface TotpOptions {
  algo?: OtpAlgo;
  digits?: number;
  period?: number;
  /** 时间戳（毫秒）；缺省 Date.now()。测试用。 */
  at?: number;
}

// ── origin 规范化（逐字移植 Hermes vault_store.normalize_origin 语义） ──────

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/** 规范化为 `scheme://host[:port]`：小写、去默认端口。无 scheme+host 抛 VaultError。 */
export function normalizeOrigin(urlOrOrigin: string): string {
  const value = (urlOrOrigin || "").trim();
  if (!value) throw new VaultError("origin is required");
  if (!value.includes("://")) throw new VaultError(`origin must include a scheme (got ${value})`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new VaultError(`could not parse origin from ${value}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (!scheme || !host) throw new VaultError(`could not parse origin from ${value}`);
  let port: number | null = null;
  try {
    port = parsed.port ? Number(parsed.port) : null;
  } catch {
    throw new VaultError(`invalid port in origin ${value}`);
  }
  if (port === null || port === DEFAULT_PORTS[scheme]) return `${scheme}://${host}`;
  return `${scheme}://${host}:${port}`;
}

// ── TOTP（RFC 6238，对标 Hermes vault_store.totp_now + normalize_otp_secret） ──

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 解码（容忍大小写与缺失 padding）。 */
function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new VaultError(`invalid base32 seed: contains non-base32 char ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 规范化 OTP 种子：接受裸 base32 或 otpauth://totp/... URI，返回规范存储形态。 */
export function normalizeOtpSecret(value: string): {
  seed: string;
  algo: OtpAlgo;
  digits: number;
  period: number;
} {
  const raw = (value || "").trim();
  if (!raw) throw new VaultError("otp secret is required");
  if (raw.startsWith("otpauth://")) {
    const parsed = new URL(raw);
    if (parsed.protocol !== "otpauth:") throw new VaultError("only otpauth://totp links are supported");
    if (parsed.hostname.toLowerCase() !== "totp") throw new VaultError("only otpauth://totp links are supported (counter-based HOTP is not)");
    const seed = parsed.searchParams.get("secret") || "";
    if (!seed) throw new VaultError("otpauth URI is missing the secret parameter");
    const algoParam = (parsed.searchParams.get("algorithm") || "SHA1").toUpperCase();
    if (algoParam !== "SHA1" && algoParam !== "SHA256" && algoParam !== "SHA512") {
      throw new VaultError(`unsupported otpauth algorithm: ${algoParam}`);
    }
    const digits = parseInt(parsed.searchParams.get("digits") || "6", 10) || 6;
    const period = parseInt(parsed.searchParams.get("period") || "30", 10) || 30;
    return { seed: seed.toUpperCase(), algo: algoParam as OtpAlgo, digits, period };
  }
  // 裸 base32：校验字符集后规范化为大写
  const upper = raw.toUpperCase();
  if (!/^[A-Z2-7]+=*$/.test(upper)) {
    throw new VaultError("authenticator key must be a base32 secret or an otpauth:// URI");
  }
  return { seed: upper, algo: "SHA1", digits: 6, period: 30 };
}

/** 当前 TOTP 验证码（RFC 6238 HMAC 动态截断）。 */
export function totpNow(seed: string, opts?: TotpOptions): string {
  const normalized = normalizeOtpSecret(seed);
  const algo = opts?.algo ?? normalized.algo;
  const digits = opts?.digits ?? normalized.digits;
  const period = opts?.period ?? normalized.period;
  const at = opts?.at ?? Date.now();
  const counter = Math.floor(at / 1000 / period);
  const key = base32Decode(normalized.seed);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algo, key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

// ── 库本体 ──────────────────────────────────────────────────────────────────

export class BrowserVault {
  private readonly baseDir: string;
  private readonly keyPath: string;
  private readonly storePath: string;
  private key: Buffer | null = null;
  private items: VaultStoreItem[] = [];
  private loaded = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.keyPath = path.join(baseDir, "vault.key");
    this.storePath = path.join(baseDir, "vault.json");
  }

  // -- 密钥 / 加解密 --

  private loadKey(): Buffer {
    if (this.key) return this.key;
    try {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    } catch { /* 目录已存在 */ }
    if (fs.existsSync(this.keyPath)) {
      const loaded = Buffer.from(fs.readFileSync(this.keyPath, "utf-8").trim(), "base64");
      if (loaded.length !== 32) throw new VaultError("vault.key is corrupted (expected 32 bytes)");
      this.key = loaded;
      return loaded;
    }
    const generated = crypto.randomBytes(32);
    // O_EXCL 语义：已存在则不覆盖（并发启动保护）
    try {
      const fd = fs.openSync(this.keyPath, "wx", 0o600);
      fs.writeSync(fd, generated.toString("base64"));
      fs.closeSync(fd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 并发启动：另一进程已生成，读回其密钥
      const loaded = Buffer.from(fs.readFileSync(this.keyPath, "utf-8").trim(), "base64");
      if (loaded.length !== 32) throw new VaultError("vault.key is corrupted (expected 32 bytes)");
      this.key = loaded;
      return loaded;
    }
    this.key = generated;
    return generated;
  }

  private encrypt(plaintext: string): string {
    const key = this.loadKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, enc, tag]).toString("base64");
  }

  private decrypt(blob: string): string {
    const key = this.loadKey();
    const data = Buffer.from(blob, "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const enc = data.subarray(12, data.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8");
  }

  // -- 持久化 --

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.storePath)) {
      this.items = [];
      return;
    }
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      const file = JSON.parse(this.decrypt(raw)) as VaultStoreFile;
      this.items = Array.isArray(file.items) ? file.items : [];
    } catch (err) {
      throw new VaultError(
        `vault file could not be decrypted (key mismatch or corruption): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private persist(): void {
    const file: VaultStoreFile = { version: 1, items: this.items };
    // 原子写 + 0600：凭据文件绝不可截断/越权读取
    atomicWriteFileSync(this.storePath, this.encrypt(JSON.stringify(file)), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  // -- 条目操作 --

  private toMeta(item: VaultStoreItem): VaultItemMeta {
    const meta: VaultItemMeta = {
      handle: item.id,
      kind: item.kind,
      label: item.label,
      origin: item.origin,
      createdAt: item.createdAt,
      hasOtp: Boolean(item.otpSecret),
    };
    if (item.identifier !== undefined) {
      meta.identifier = item.identifier;
      meta.identifierType = item.identifierType;
    }
    if (item.allowedOrigins && item.allowedOrigins.length > 1) {
      meta.allowedOrigins = item.allowedOrigins;
    }
    return meta;
  }

  listItems(): VaultItemMeta[] {
    this.ensureLoaded();
    return this.items.map((i) => this.toMeta(i));
  }

  hasItems(): boolean {
    this.ensureLoaded();
    return this.items.length > 0;
  }

  getMeta(handle: string): VaultItemMeta | null {
    this.ensureLoaded();
    const item = this.items.find((i) => i.id === handle);
    return item ? this.toMeta(item) : null;
  }

  /** 解析机密值（仅服务端内部使用；结果绝不写入工具结果/日志）。 */
  resolveSecret(handle: string): Record<string, unknown> {
    this.ensureLoaded();
    const item = this.items.find((i) => i.id === handle);
    if (!item) throw new VaultError(`unknown vault handle: ${handle}`);
    const out: Record<string, unknown> = { kind: item.kind, origin: item.origin };
    if (item.identifier !== undefined) out.identifier = item.identifier;
    if (item.password !== undefined) out.password = item.password;
    if (item.otpSecret !== undefined) {
      out.otpSecret = item.otpSecret;
      out.otpAlgo = item.otpAlgo ?? "SHA1";
      out.otpDigits = item.otpDigits ?? 6;
      out.otpPeriod = item.otpPeriod ?? 30;
    }
    if (item.fields) out.fields = item.fields;
    return out;
  }

  /** origin 精确匹配（无通配/子域推断）。条目未绑定 origin 或当前页无 origin 时拒绝。 */
  matchOrigin(handle: string, currentOrigin: string | null): boolean {
    const meta = this.getMeta(handle);
    if (!meta || !meta.origin || !currentOrigin) return false;
    try {
      return normalizeOrigin(currentOrigin) === meta.origin;
    } catch {
      return false;
    }
  }

  addItem(input: AddItemInput): VaultItemMeta {
    this.ensureLoaded();
    const kind = input.kind;
    if (kind === "login" && (!input.password || !input.password.trim())) {
      throw new VaultError("login items require a password");
    }
    const item: VaultStoreItem = {
      id: `vault_${crypto.randomBytes(6).toString("hex")}`,
      kind,
      label: input.label.trim() || "untitled",
      origin: input.origin ? normalizeOrigin(input.origin) : null,
      createdAt: new Date().toISOString(),
    };
    if (input.identifier !== undefined) {
      item.identifier = input.identifier;
      item.identifierType = input.identifierType ?? guessIdentifierType(input.identifier);
    }
    if (input.password !== undefined) item.password = input.password;
    if (input.otpSecret !== undefined) {
      const norm = normalizeOtpSecret(input.otpSecret);
      item.otpSecret = norm.seed;
      item.otpAlgo = norm.algo;
      item.otpDigits = norm.digits;
      item.otpPeriod = norm.period;
    }
    if (input.fields && Object.keys(input.fields).length > 0) item.fields = input.fields;
    this.items.push(item);
    this.persist();
    return this.toMeta(item);
  }

  removeItem(handle: string): boolean {
    this.ensureLoaded();
    const idx = this.items.findIndex((i) => i.id === handle);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.persist();
    return true;
  }
}

/** 从标识符值推断类型（email/username/phone）。 */
function guessIdentifierType(identifier: string): string {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier)) return "email";
  if (/^\+?[0-9][0-9\-\s()]{6,}$/.test(identifier)) return "phone";
  return "username";
}
