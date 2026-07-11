/**
 * VoiceService — 语音输入/识别配置与状态管理
 *
 * 负责：
 * 1. 维护 TTS/ASR 开关与配置
 * 2. 验证本地引擎可用性（Web Speech API 浏览器支持 / Vosk 本地模型）
 * 3. 记录操作日志与错误
 * 4. 提供 REST API 给 Web UI
 *
 * 默认禁用，验证成功后才能在 UI 中开启。
 */
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "../atomic-write";

export type VoiceEngine = "browser" | "vosk" | "none";

export interface VoiceConfig {
  /** 是否启用后台语音识别 */
  enabled: boolean;
  /** 使用的引擎 */
  engine: VoiceEngine;
  /** 识别语言，例如 zh-CN、en-US */
  language: string;
  /** 是否连续识别 */
  continuous: boolean;
  /** 识别中间结果是否实时显示 */
  interimResults: boolean;
  /** Vosk 模型目录路径（仅 engine=vosk 时有效） */
  voskModelPath?: string;
  /** 是否自动发送识别结果 */
  autoSubmit: boolean;
  /** 识别超时（毫秒） */
  timeoutMs: number;
}

export interface VoiceStatus {
  enabled: boolean;
  engine: VoiceEngine;
  available: boolean;
  supported: boolean;
  lastError?: string;
  lastVerifiedAt?: string;
}

export interface VoiceVerificationResult {
  success: boolean;
  available: boolean;
  supported: boolean;
  message: string;
  details?: Record<string, unknown>;
}

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: false,
  engine: "browser",
  language: "zh-CN",
  continuous: true,
  interimResults: true,
  autoSubmit: false,
  timeoutMs: 10000,
};

export class VoiceService {
  private config: VoiceConfig = { ...DEFAULT_CONFIG };
  private status: VoiceStatus = {
    enabled: false,
    engine: "browser",
    available: false,
    supported: false,
  };
  private readonly dataDir: string;
  private readonly configPath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), "data", "voice");
    this.configPath = path.join(this.dataDir, "voice-config.json");
    this.loadConfig();
    // 初始时不自动验证，等待显式 verify 调用
    this.status = {
      enabled: this.config.enabled,
      engine: this.config.engine,
      available: false,
      supported: false,
    };
    // browser 引擎无需额外依赖，若配置已启用则自动标记为可用，避免重启后状态丢失导致前端按钮不显示
    if (this.config.enabled && this.config.engine === "browser") {
      this.markBrowserAvailable();
    }
  }

  private markBrowserAvailable(): void {
    this.status.available = true;
    this.status.supported = true;
    this.status.lastVerifiedAt = new Date().toISOString();
    this.status.lastError = undefined;
  }

  /**
   * 获取当前配置
   */
  getConfig(): VoiceConfig {
    return { ...this.config };
  }

  /**
   * 获取当前状态
   */
  getStatus(): VoiceStatus {
    return { ...this.status };
  }

  /**
   * 更新配置。如果启用，必须先通过 verify()。
   */
  async updateConfig(partial: Partial<VoiceConfig>): Promise<VoiceStatus> {
    const next: VoiceConfig = { ...this.config, ...partial };

    // 如果要启用，必须已经验证通过
    if (next.enabled && !this.status.available) {
      const verifyResult = await this.verify();
      if (!verifyResult.success) {
        this.log("error", "Attempted to enable voice input without successful verification");
        this.status.lastError = verifyResult.message;
        return this.getStatus();
      }
    }

    this.config = next;
    this.status.enabled = next.enabled;
    this.status.engine = next.engine;
    this.persistConfig();
    this.log("info", `Voice config updated: enabled=${next.enabled}, engine=${next.engine}, lang=${next.language}`);
    return this.getStatus();
  }

  /**
   * 验证本地语音引擎是否可用
   */
  async verify(): Promise<VoiceVerificationResult> {
    if (this.config.engine === "browser") {
      // browser 引擎由前端验证，后端只标记配置合法
      this.markBrowserAvailable();
      this.log("info", "Browser Web Speech API verification passed (backend-side)");
      return {
        success: true,
        available: true,
        supported: true,
        message: "Browser-side Web Speech API is available when the browser supports it",
      };
    }

    if (this.config.engine === "vosk") {
      return this.verifyVosk();
    }

    return {
      success: false,
      available: false,
      supported: false,
      message: "No voice engine selected",
    };
  }

  /**
   * 使用 Vosk 进行验证。尝试动态加载 vosk 并检查模型目录。
   */
  private async verifyVosk(): Promise<VoiceVerificationResult> {
    try {
      // 动态加载 vosk，避免未安装时项目无法启动。如果未安装则视为可选依赖不可用。
      let vosk: any;
      try {
        vosk = await import("vosk");
      } catch {
        const msg = "vosk package not installed; install it with `pnpm add vosk` to use local Vosk engine";
        this.status.available = false;
        this.status.supported = false;
        this.status.lastError = msg;
        this.log("error", msg);
        return { success: false, available: false, supported: false, message: msg };
      }
      const modelPath = this.config.voskModelPath || path.join(this.dataDir, "model");

      if (!fs.existsSync(modelPath)) {
        const msg = `Vosk model directory not found: ${modelPath}`;
        this.status.available = false;
        this.status.supported = false;
        this.status.lastError = msg;
        this.log("error", msg);
        return { success: false, available: false, supported: false, message: msg };
      }

      // 尝试实例化模型，验证目录结构是否合法
      const model = new vosk.Model(modelPath);
      this.status.available = true;
      this.status.supported = true;
      this.status.lastVerifiedAt = new Date().toISOString();
      this.status.lastError = undefined;
      this.log("info", `Vosk model loaded successfully from ${modelPath}`);
      return {
        success: true,
        available: true,
        supported: true,
        message: `Vosk model loaded from ${modelPath}`,
        details: { modelPath },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status.available = false;
      this.status.supported = false;
      this.status.lastError = msg;
      this.log("error", `Vosk verification failed: ${msg}`);
      return {
        success: false,
        available: false,
        supported: false,
        message: `Vosk verification failed: ${msg}`,
      };
    }
  }

  /**
   * 切换启用状态。开启前会自动验证。
   */
  async toggle(enabled: boolean): Promise<VoiceStatus> {
    return this.updateConfig({ enabled });
  }

  /**
   * 重置为默认配置
   */
  async reset(): Promise<VoiceStatus> {
    this.config = { ...DEFAULT_CONFIG };
    this.status = {
      enabled: false,
      engine: "browser",
      available: false,
      supported: false,
      lastError: undefined,
      lastVerifiedAt: undefined,
    };
    this.persistConfig();
    this.log("info", "Voice config reset to defaults");
    return this.getStatus();
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        this.log("info", "Voice config loaded from disk");
      }
    } catch (err) {
      this.log("error", `Failed to load voice config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persistConfig(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      atomicWriteFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (err) {
      this.log("error", `Failed to persist voice config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(level: "info" | "error" | "warn", message: string): void {
    const prefix = "[VoiceService]";
    const ts = new Date().toISOString();
    const line = `${ts} ${level.toUpperCase()} ${prefix} ${message}`;
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
