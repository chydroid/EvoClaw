/**
 * Onboarding Wizard — interactive step-by-step setup guide
 * for first-time EvoClaw configuration.
 *
 * Guides new users through:
 *  1. Identity & persona setup
 *  2. Authentication (JWT secret, admin credentials)
 *  3. Gateway & channel selection
 *  4. LLM provider & model selection
 *  5. Data directories & persistence
 *  6. Summary & confirmation
 *
 * Features:
 *  - Step-by-step wizard with validation
 *  - Default suggestions for every parameter
 *  - Secret generation for JWT
 *  - Skip/accept-defaults mode for non-interactive env
 *  - Configuration export to file
 *  - Resume from checkpoint
 */

import { randomBytes, randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────

export type OnboardingStep =
  | "identity"
  | "auth"
  | "gateway"
  | "llm"
  | "data"
  | "summary";

export type InputHandler = (prompt: string, defaultValue?: string) => Promise<string>;
export type SelectHandler = (prompt: string, options: string[], defaultIndex?: number) => Promise<string>;
export type ConfirmHandler = (prompt: string) => Promise<boolean>;

export interface IdentityConfig {
  assistantName: string;
  assistantTitle: string;
  masterTerm: string;
  tone: "warm" | "professional" | "casual" | "humorous";
  introduction: string;
}

export interface AuthConfig {
  jwtSecret: string;
  adminUsername: string;
  adminPassword: string;
  tokenExpiryHours: number;
}

export interface GatewayConfig {
  port: number;
  host: string;
  enableREST: boolean;
  enableMCP: boolean;
  corsOrigins: string[];
}

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

export interface DataConfig {
  dataDir: string;
  sessionsDir: string;
  logsDir: string;
  skillsDir: string;
}

export interface OnboardingConfig {
  identity: IdentityConfig;
  auth: AuthConfig;
  gateway: GatewayConfig;
  llm: LLMConfig;
  data: DataConfig;
}

export interface OnboardingProgress {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  config: Partial<OnboardingConfig>;
  startedAt: number;
}

export interface OnboardingWizardConfig {
  /** Whether to run in interactive mode */
  interactive: boolean;
  /** Accept all defaults without prompting */
  acceptDefaults: boolean;
  /** Whether to auto-generate secrets */
  generateSecrets: boolean;
  /** Path to save the generated config */
  outputPath: string;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_WIZARD_CONFIG: OnboardingWizardConfig = {
  interactive: true,
  acceptDefaults: false,
  generateSecrets: true,
  outputPath: "",
};

const DEFAULT_IDENTITY: IdentityConfig = {
  assistantName: "EvoClaw",
  assistantTitle: "Personal AI Assistant",
  masterTerm: "Administrator",
  tone: "professional",
  introduction: "Hello! I am EvoClaw, your evolving AI companion.",
};

const DEFAULT_AUTH: AuthConfig = {
  jwtSecret: "",
  adminUsername: "admin",
  adminPassword: "",
  tokenExpiryHours: 168, // 7 days
};

const DEFAULT_GATEWAY: GatewayConfig = {
  port: 3000,
  host: "0.0.0.0",
  enableREST: true,
  enableMCP: true,
  corsOrigins: ["http://localhost:5173"],
};

const DEFAULT_LLM: LLMConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "",
  temperature: 0.7,
  maxTokens: 4096,
};

const DEFAULT_DATA: DataConfig = {
  dataDir: "./data",
  sessionsDir: "./data/sessions",
  logsDir: "./data/logs",
  skillsDir: "./data/skills",
};

const ALL_STEPS: OnboardingStep[] = ["identity", "auth", "gateway", "llm", "data", "summary"];

// ── Wizard ────────────────────────────────────────────────

export class OnboardingWizard {
  private wizConfig: OnboardingWizardConfig;
  private progress: OnboardingProgress;
  private inputFn: InputHandler;
  private selectFn: SelectHandler;
  private confirmFn: ConfirmHandler;

  constructor(
    config?: Partial<OnboardingWizardConfig>,
    io?: {
      input?: InputHandler;
      select?: SelectHandler;
      confirm?: ConfirmHandler;
    },
  ) {
    this.wizConfig = { ...DEFAULT_WIZARD_CONFIG, ...config };
    this.inputFn = io?.input ?? (async (_, d) => d ?? "");
    this.selectFn = io?.select ?? (async (_, __, i) => __[i ?? 0] ?? "");
    // 默认 confirm 匹配 "(Y/n)" 提示：空输入（未提供 handler）视为 yes。
    this.confirmFn = io?.confirm ?? (async () => true);

    this.progress = {
      currentStep: "identity",
      completedSteps: [],
      config: {},
      startedAt: Date.now(),
    };
  }

  /**
   * Run the full onboarding flow. Returns the complete config.
   */
  async run(): Promise<OnboardingConfig> {
    for (const step of ALL_STEPS) {
      this.progress.currentStep = step;
      await this.executeStep(step);
      this.progress.completedSteps.push(step);
    }

    return this.progress.config as OnboardingConfig;
  }

  /**
   * Run a single step by name.
   */
  async runStep(step: OnboardingStep): Promise<Partial<OnboardingConfig>> {
    await this.executeStep(step);
    return this.progress.config;
  }

  /**
   * Get the current progress.
   */
  getProgress(): OnboardingProgress {
    return { ...this.progress, completedSteps: [...this.progress.completedSteps] };
  }

  /**
   * Resume from a previous progress state.
   */
  resumeFrom(progress: OnboardingProgress): void {
    this.progress = {
      ...progress,
      completedSteps: [...progress.completedSteps],
    };
  }

  /**
   * Accept all defaults without interaction. Returns the complete config.
   */
  async acceptAllDefaults(): Promise<OnboardingConfig> {
    const secrets = this.generateSecrets();

    return {
      identity: { ...DEFAULT_IDENTITY },
      auth: { ...DEFAULT_AUTH, ...secrets },
      gateway: { ...DEFAULT_GATEWAY },
      llm: { ...DEFAULT_LLM },
      data: { ...DEFAULT_DATA },
    };
  }

  /**
   * Generate the complete config from current progress.
   */
  generateConfig(): OnboardingConfig {
    const secrets = this.generateSecrets();

    return {
      identity: this.progress.config.identity ?? { ...DEFAULT_IDENTITY },
      auth: { ...DEFAULT_AUTH, ...secrets, ...this.progress.config.auth },
      gateway: this.progress.config.gateway ?? { ...DEFAULT_GATEWAY },
      llm: this.progress.config.llm ?? { ...DEFAULT_LLM },
      data: this.progress.config.data ?? { ...DEFAULT_DATA },
    };
  }

  /**
   * Export config to JSON string.
   */
  exportConfig(): string {
    return JSON.stringify(this.generateConfig(), null, 2);
  }

  configure(updates: Partial<OnboardingWizardConfig>): void {
    this.wizConfig = { ...this.wizConfig, ...updates };
  }

  // ── Private: Step executors ─────────────────────────────

  private async executeStep(step: OnboardingStep): Promise<void> {
    if (this.wizConfig.acceptDefaults) {
      this.applyDefaultStep(step);
      return;
    }

    switch (step) {
      case "identity": await this.configureIdentity(); break;
      case "auth": await this.configureAuth(); break;
      case "gateway": await this.configureGateway(); break;
      case "llm": await this.configureLLM(); break;
      case "data": await this.configureData(); break;
      case "summary": await this.showSummary(); break;
    }
  }

  private applyDefaultStep(step: OnboardingStep): void {
    switch (step) {
      case "identity": this.progress.config.identity = { ...DEFAULT_IDENTITY }; break;
      case "auth": {
        const secrets = this.generateSecrets();
        this.progress.config.auth = { ...DEFAULT_AUTH, ...secrets };
        break;
      }
      case "gateway": this.progress.config.gateway = { ...DEFAULT_GATEWAY }; break;
      case "llm": this.progress.config.llm = { ...DEFAULT_LLM }; break;
      case "data": this.progress.config.data = { ...DEFAULT_DATA }; break;
      case "summary": break;
    }
  }

  private async configureIdentity(): Promise<void> {
    const name = await this.inputFn("Assistant name", DEFAULT_IDENTITY.assistantName);
    const title = await this.inputFn("Assistant title", DEFAULT_IDENTITY.assistantTitle);
    const master = await this.inputFn("How should the assistant address you?", DEFAULT_IDENTITY.masterTerm);
    const tone = await this.selectFn("Assistant tone", ["warm", "professional", "casual", "humorous"], 1);
    const intro = await this.inputFn("Introduction message", DEFAULT_IDENTITY.introduction);

    this.progress.config.identity = {
      assistantName: name || DEFAULT_IDENTITY.assistantName,
      assistantTitle: title || DEFAULT_IDENTITY.assistantTitle,
      masterTerm: master || DEFAULT_IDENTITY.masterTerm,
      tone: (tone as IdentityConfig["tone"]) || DEFAULT_IDENTITY.tone,
      introduction: intro || DEFAULT_IDENTITY.introduction,
    };
  }

  private async configureAuth(): Promise<void> {
    const secrets = this.generateSecrets();

    const jwtSecret = this.wizConfig.generateSecrets
      ? secrets.jwtSecret
      : await this.inputFn("JWT secret (leave empty for auto-generate)", "");

    const username = await this.inputFn("Admin username", DEFAULT_AUTH.adminUsername);
    const password = this.wizConfig.generateSecrets
      ? secrets.adminPassword
      : await this.inputFn("Admin password (leave empty for auto-generate)", "");

    const expiry = parseInt(
      await this.inputFn("Token expiry in hours", String(DEFAULT_AUTH.tokenExpiryHours)),
      10,
    );

    this.progress.config.auth = {
      jwtSecret: jwtSecret || secrets.jwtSecret,
      adminUsername: username || DEFAULT_AUTH.adminUsername,
      adminPassword: password || secrets.adminPassword,
      tokenExpiryHours: isNaN(expiry) ? DEFAULT_AUTH.tokenExpiryHours : expiry,
    };
  }

  private async configureGateway(): Promise<void> {
    const port = parseInt(
      await this.inputFn("Gateway port", String(DEFAULT_GATEWAY.port)),
      10,
    );

    const host = await this.inputFn("Host address", DEFAULT_GATEWAY.host);
    const enableREST = await this.confirmFn("Enable REST API? (Y/n)");
    const enableMCP = await this.confirmFn("Enable MCP protocol? (Y/n)");
    const cors = await this.inputFn("CORS origins (comma-separated)", DEFAULT_GATEWAY.corsOrigins.join(","));

    this.progress.config.gateway = {
      port: isNaN(port) ? DEFAULT_GATEWAY.port : port,
      host: host || DEFAULT_GATEWAY.host,
      enableREST,
      enableMCP,
      corsOrigins: cors ? cors.split(",").map((s) => s.trim()) : DEFAULT_GATEWAY.corsOrigins,
    };
  }

  private async configureLLM(): Promise<void> {
    const provider = await this.selectFn(
      "LLM provider",
      ["openai", "anthropic", "google", "azure", "local", "custom"],
      0,
    );

    const model = await this.inputFn(
      "Model ID",
      provider === "anthropic" ? "claude-sonnet-4-20250514" :
      provider === "google" ? "gemini-2.5-pro" : "gpt-4o",
    );

    const apiKey = await this.inputFn("API key (leave empty to set later)", "");
    const tempVal = parseFloat(await this.inputFn("Temperature (0.0-2.0)", "0.7"));
    const maxTokensVal = parseInt(await this.inputFn("Max tokens", "4096"), 10);

    this.progress.config.llm = {
      provider: provider || DEFAULT_LLM.provider,
      model: model || DEFAULT_LLM.model,
      apiKey: apiKey,
      temperature: isNaN(tempVal) ? DEFAULT_LLM.temperature : Math.max(0, Math.min(2, tempVal)),
      maxTokens: isNaN(maxTokensVal) ? DEFAULT_LLM.maxTokens : maxTokensVal,
    };
  }

  private async configureData(): Promise<void> {
    const dataDir = await this.inputFn("Data directory", DEFAULT_DATA.dataDir);
    const sessionsDir = await this.inputFn("Sessions directory", DEFAULT_DATA.sessionsDir);
    const logsDir = await this.inputFn("Logs directory", DEFAULT_DATA.logsDir);
    const skillsDir = await this.inputFn("Skills directory", DEFAULT_DATA.skillsDir);

    this.progress.config.data = {
      dataDir: dataDir || DEFAULT_DATA.dataDir,
      sessionsDir: sessionsDir || DEFAULT_DATA.sessionsDir,
      logsDir: logsDir || DEFAULT_DATA.logsDir,
      skillsDir: skillsDir || DEFAULT_DATA.skillsDir,
    };
  }

  private async showSummary(): Promise<void> {
    // No-op: summary is informational
  }

  // ── Private: Helpers ────────────────────────────────────

  private generateSecrets(): { jwtSecret: string; adminPassword: string } {
    return {
      jwtSecret: randomBytes(32).toString("hex"),
      adminPassword: randomUUID().split("-").join("").slice(0, 16),
    };
  }
}