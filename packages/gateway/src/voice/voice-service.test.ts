import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VoiceService } from "./voice-service";

describe("VoiceService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("默认禁用且未验证", () => {
    const svc = new VoiceService(tmpDir);
    const config = svc.getConfig();
    const status = svc.getStatus();
    expect(config.enabled).toBe(false);
    expect(config.engine).toBe("browser");
    expect(status.enabled).toBe(false);
    expect(status.available).toBe(false);
    expect(status.supported).toBe(false);
  });

  it("browser 引擎在后端验证通过", async () => {
    const svc = new VoiceService(tmpDir);
    const result = await svc.verify();
    expect(result.success).toBe(true);
    expect(result.available).toBe(true);
    expect(result.supported).toBe(true);

    const status = svc.getStatus();
    expect(status.available).toBe(true);
    expect(status.supported).toBe(true);
    expect(status.lastVerifiedAt).toBeTruthy();
  });

  it("验证通过后才能启用", async () => {
    const svc = new VoiceService(tmpDir);
    await svc.verify();
    const status = await svc.toggle(true);
    expect(status.enabled).toBe(true);
    expect(svc.getConfig().enabled).toBe(true);
  });

  it("未验证时拒绝启用", async () => {
    const svc = new VoiceService(tmpDir);
    // 切换到 vosk 引擎，模型不存在，验证必然失败
    await svc.updateConfig({ engine: "vosk" });
    const status = await svc.toggle(true);
    expect(status.enabled).toBe(false);
    expect(status.available).toBe(false);
    expect(status.lastError).toBeTruthy();
  });

  it("vosk 引擎在缺少模型或未安装包时优雅降级", async () => {
    const svc = new VoiceService(tmpDir);
    const status = await svc.updateConfig({ engine: "vosk" });
    expect(status.available).toBe(false);
    expect(status.supported).toBe(false);

    const result = await svc.verify();
    expect(result.success).toBe(false);
    expect(result.available).toBe(false);
  });

  it("配置持久化与重新加载", async () => {
    let svc = new VoiceService(tmpDir);
    await svc.verify();
    await svc.toggle(true);
    expect(svc.getConfig().enabled).toBe(true);

    // 重新实例化，browser 引擎已启用时会自动标记为可用，避免前端按钮不显示
    svc = new VoiceService(tmpDir);
    expect(svc.getConfig().enabled).toBe(true);
    expect(svc.getStatus().enabled).toBe(true);
    expect(svc.getStatus().available).toBe(true);
  });

  it("reset 恢复默认值", async () => {
    const svc = new VoiceService(tmpDir);
    await svc.verify();
    await svc.toggle(true);
    await svc.updateConfig({ engine: "vosk", language: "en-US" });

    await svc.reset();
    const config = svc.getConfig();
    expect(config.enabled).toBe(false);
    expect(config.engine).toBe("browser");
    expect(config.language).toBe("zh-CN");
    expect(svc.getStatus().available).toBe(false);
  });
});
