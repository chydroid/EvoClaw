/**
 * BrowserVault 单元测试 — 对标 Hermes vault_store.py 契约：
 * - normalizeOrigin 规范化语义（小写/去默认端口/VaultError）
 * - normalizeOtpSecret（裸 base32 + otpauth:// URI）
 * - totpNow RFC 6238 官方向量（SHA1，种子 base32 编码）
 * - 条目 CRUD + model-blind 元数据（密码绝不出现在 list 结果）
 * - AES-256-GCM 静态加密（库文件无明文）、密钥/库文件 0600
 * - origin 精确匹配（无子域/端口推断）
 * - 跨实例持久化、损坏文件 VaultError
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrowserVault, VaultError, normalizeOrigin, normalizeOtpSecret, totpNow } from "./browser-vault";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeOrigin", () => {
  it("小写 scheme+host，去默认端口", () => {
    expect(normalizeOrigin("https://Example.COM")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:443/path?q=1")).toBe("https://example.com");
    expect(normalizeOrigin("http://example.com:80")).toBe("http://example.com");
    expect(normalizeOrigin("  https://example.com  ")).toBe("https://example.com");
  });

  it("保留非默认端口", () => {
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("缺 scheme/host/空值抛 VaultError", () => {
    expect(() => normalizeOrigin("example.com")).toThrow(VaultError);
    expect(() => normalizeOrigin("")).toThrow(VaultError);
    expect(() => normalizeOrigin("not a url ???")).toThrow(VaultError);
  });
});

describe("normalizeOtpSecret", () => {
  it("裸 base32 规范化为大写，默认 SHA1/6 位/30s", () => {
    const r = normalizeOtpSecret("jbswy3dpehpK3pxp");
    expect(r).toEqual({ seed: "JBSWY3DPEHPK3PXP", algo: "SHA1", digits: 6, period: 30 });
  });

  it("解析 otpauth://totp URI 参数", () => {
    const r = normalizeOtpSecret(
      "otpauth://totp/MyApp?secret=jbswy3dpehpK3pxp&algorithm=SHA256&digits=8&period=60"
    );
    expect(r).toEqual({ seed: "JBSWY3DPEHPK3PXP", algo: "SHA256", digits: 8, period: 60 });
  });

  it("拒绝 counter-based HOTP URI 与非法 base32", () => {
    expect(() => normalizeOtpSecret("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP")).toThrow(VaultError);
    expect(() => normalizeOtpSecret("not-base32!")).toThrow(VaultError);
    expect(() => normalizeOtpSecret("otpauth://totp/x")).toThrow(VaultError); // 缺 secret
  });
});

describe("totpNow（RFC 6238 官方向量）", () => {
  // RFC 6238 测试种子为 ASCII "12345678901234567890"（20 字节），其 base32 编码即下值。
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("SHA1/6 位截断与 RFC 向量一致", () => {
    expect(totpNow(seed, { at: 59_000 })).toBe("287082"); // counter=1
    expect(totpNow(seed, { at: 1_111_111_109_000 })).toBe("081804"); // counter=37037036
    expect(totpNow(seed, { at: 1_111_111_111_000 })).toBe("050471"); // counter=37037037
    expect(totpNow(seed, { at: 1_234_567_890_000 })).toBe("005924"); // counter=41152263
    expect(totpNow(seed, { at: 2_000_000_000_000 })).toBe("279037"); // counter=66666666
    expect(totpNow(seed, { at: 20_000_000_000_000 })).toBe("353130"); // counter=666666666
  });

  it("otpauth URI 参数生效（SHA256/8 位/60s）", () => {
    const uri = "otpauth://totp/MyApp?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60";
    const code = totpNow(uri, { at: 59_000 });
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^\d{8}$/);
  });
});

describe("BrowserVault 条目操作", () => {
  it("add/list/resolve 往返；list 元数据不含密码", () => {
    const vault = new BrowserVault(dir);
    const meta = vault.addItem({
      kind: "login",
      label: "Example",
      origin: "https://Example.com:443",
      identifier: "user@example.com",
      password: "hunter2",
    });
    expect(meta.handle).toMatch(/^vault_[0-9a-f]{12}$/);
    expect(meta.origin).toBe("https://example.com"); // 规范化
    expect(meta.hasOtp).toBe(false);
    expect(meta.identifier).toBe("user@example.com");

    const items = vault.listItems();
    expect(items).toHaveLength(1);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("hunter2"); // model-blind 契约

    const secret = vault.resolveSecret(meta.handle);
    expect(secret.password).toBe("hunter2");
  });

  it("静态加密：库文件无明文，密钥/库文件 0600", () => {
    const vault = new BrowserVault(dir);
    vault.addItem({ kind: "login", label: "X", origin: "https://x.example.com", password: "s3cret!" });
    const raw = fs.readFileSync(path.join(dir, "vault.json"), "utf-8");
    expect(raw).not.toContain("s3cret!");
    expect(raw).not.toContain("https://x.example.com");
    const keyMode = fs.statSync(path.join(dir, "vault.key")).mode & 0o777;
    const storeMode = fs.statSync(path.join(dir, "vault.json")).mode & 0o777;
    expect(keyMode).toBe(0o600);
    expect(storeMode).toBe(0o600);
  });

  it("login 必须带密码；origin 非法抛 VaultError", () => {
    const vault = new BrowserVault(dir);
    expect(() => vault.addItem({ kind: "login", label: "X" })).toThrow(VaultError);
    expect(() =>
      vault.addItem({ kind: "login", label: "X", origin: "no-scheme", password: "p" })
    ).toThrow(VaultError);
  });

  it("removeItem 后 list 为空", () => {
    const vault = new BrowserVault(dir);
    const meta = vault.addItem({ kind: "login", label: "X", origin: "https://x.example.com", password: "p" });
    expect(vault.removeItem(meta.handle)).toBe(true);
    expect(vault.removeItem("vault_000000000000")).toBe(false);
    expect(vault.listItems()).toHaveLength(0);
  });

  it("OTP 条目：hasOtp 标记 + resolveSecret 返回算法参数", () => {
    const vault = new BrowserVault(dir);
    const meta = vault.addItem({
      kind: "login",
      label: "OTP",
      origin: "https://otp.example.com",
      password: "p",
      otpSecret: "otpauth://totp/App?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60",
    });
    expect(meta.hasOtp).toBe(true);
    const secret = vault.resolveSecret(meta.handle);
    expect(secret.otpSecret).toBe("JBSWY3DPEHPK3PXP");
    expect(secret.otpAlgo).toBe("SHA256");
    expect(secret.otpDigits).toBe(8);
    expect(secret.otpPeriod).toBe(60);
  });
});

describe("matchOrigin（精确匹配）", () => {
  it("仅精确匹配；子域/端口/空值一律拒绝", () => {
    const vault = new BrowserVault(dir);
    const meta = vault.addItem({ kind: "login", label: "X", origin: "https://shop.example.com", password: "p" });
    expect(vault.matchOrigin(meta.handle, "https://shop.example.com")).toBe(true);
    expect(vault.matchOrigin(meta.handle, "https://shop.example.com:443")).toBe(true); // 默认端口规范化
    expect(vault.matchOrigin(meta.handle, "https://www.shop.example.com")).toBe(false); // 子域
    expect(vault.matchOrigin(meta.handle, "https://shop.example.com:8443")).toBe(false); // 端口
    expect(vault.matchOrigin(meta.handle, "https://evil.example.com")).toBe(false);
    expect(vault.matchOrigin(meta.handle, null)).toBe(false);
    expect(vault.matchOrigin("vault_000000000000", "https://shop.example.com")).toBe(false);
  });

  it("未绑定 origin 的条目拒绝 fill", () => {
    const vault = new BrowserVault(dir);
    const meta = vault.addItem({ kind: "login", label: "X", password: "p" });
    expect(vault.matchOrigin(meta.handle, "https://anything.example.com")).toBe(false);
  });
});

describe("持久化与损坏恢复", () => {
  it("新实例读取已有条目（密钥文件复用）", () => {
    const v1 = new BrowserVault(dir);
    v1.addItem({ kind: "login", label: "Persist", origin: "https://p.example.com", password: "pw" });
    const v2 = new BrowserVault(dir);
    const items = v2.listItems();
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Persist");
    expect(v2.resolveSecret(items[0].handle).password).toBe("pw");
  });

  it("库文件损坏（非密文）抛 VaultError", () => {
    const v1 = new BrowserVault(dir);
    v1.addItem({ kind: "login", label: "X", origin: "https://x.example.com", password: "p" });
    fs.writeFileSync(path.join(dir, "vault.json"), "not-encrypted-plaintext");
    const v2 = new BrowserVault(dir);
    expect(() => v2.listItems()).toThrow(VaultError);
  });
});
