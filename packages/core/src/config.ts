export interface PersonaConfig {
  name: string;
  title: string;
  masterTerm: string;
  tone: "warm" | "professional" | "casual" | "humorous";
  introduction: string;
}

export interface AppConfig {
  server: {
    port: number;
    host: string;
    corsOrigins: string[];
  };
  auth: {
    jwtSecret: string;
    tokenExpiry: string;
    refreshExpiry: string;
  };
  gateway: {
    enableMCP: boolean;
    enableREST: boolean;
    rateLimitWindow: number;
    rateLimitMax: number;
  };
  persona: PersonaConfig;
  agent: {
    minAgents: number;
    maxAgents: number;
    maxRetries: number;
    defaultTimeout: number;
    scaleThreshold: number;
    pollDelayMs: number;
  };
  sandbox: {
    defaultMaxExecutionTime: number;
    defaultMaxMemoryMB: number;
    allowNetwork: boolean;
    allowFileSystem: boolean;
    allowSubprocess: boolean;
  };
  memory: {
    shortTermDefaultTTL: number;
    vectorDimension: number;
    similarityThreshold: number;
    maxHistoryEntries: number;
  };
  security: {
    auditRetention: number;
    rateLimitDefault: number;
    rateLimitWindow: number;
    anomalyCheckInterval: number;
  };
  evolution: {
    enabled: boolean;
    autoEvolution: boolean;
    minConfidence: number;
    maxCandidatesPerCycle: number;
    learningJournal: {
      path: string;
      enabled: boolean;
      autoPersist: boolean;
      persistIntervalMs: number;
      maxEntries: number;
    };
  };
}

export const defaultConfig: AppConfig = {
  server: {
    port: 3000,
    host: "0.0.0.0",
    corsOrigins: ["http://localhost:5173"],
  },
  auth: {
    jwtSecret: "evoclaw-dev-secret-change-in-production",
    tokenExpiry: "24h",
    refreshExpiry: "7d",
  },
  gateway: {
    enableMCP: true,
    enableREST: true,
    rateLimitWindow: 60000,
    rateLimitMax: 100,
  },
  persona: {
    name: "EvoClaw小助手",
    title: "您的专属EvoClaw智能助理",
    masterTerm: "主人",
    tone: "warm",
    introduction: `您好主人！我是 EvoClaw小助手，您的专属EvoClaw智能助理 🦞

很高兴为您服务！以下是我能帮您做的事情：

✨ 日常对话与问答
  - 回答知识类问题，提供建议和建议
  - 辅助您进行学习、写作和思考

🛠️ 技能执行
  - 运行已安装的 Skills（技能），自动化处理各类任务
  - 支持从 ClawHub 安装新的 Skills

🚀 任务编排
  - 将复杂任务自动拆解为 DAG 执行计划
  - 动态匹配最优 Skills 组合完成目标

🔬 自我进化
  - 根据执行反馈不断优化策略
  - 学习您的偏好，越来越"懂"你

📡 多平台对接
  - 飞书、企业微信、个人微信等 Channel
  - MCP 协议标准化接口

🌐 技能市场
  - 访问 clawhub.ai 发现海量 Skills
  - 国内用户可使用 cn.clawhub-mirror.com 加速

有什么需要，随时吩咐我！`,
  },
  agent: {
    minAgents: 2,
    maxAgents: 10,
    maxRetries: 3,
    defaultTimeout: 300000,
    scaleThreshold: 0.7,
    pollDelayMs: 100,
  },
  sandbox: {
    defaultMaxExecutionTime: 30000,
    defaultMaxMemoryMB: 128,
    allowNetwork: false,
    allowFileSystem: true,
    allowSubprocess: false,
  },
  memory: {
    shortTermDefaultTTL: 3600000,
    vectorDimension: 1536,
    similarityThreshold: 0.75,
    maxHistoryEntries: 1000,
  },
  security: {
    auditRetention: 10000,
    rateLimitDefault: 100,
    rateLimitWindow: 60000,
    anomalyCheckInterval: 30000,
  },
  evolution: {
    enabled: true,
    autoEvolution: false,
    minConfidence: 0.5,
    maxCandidatesPerCycle: 5,
    learningJournal: {
      path: "LEARNINGS.md",
      enabled: true,
      autoPersist: true,
      persistIntervalMs: 5000,
      maxEntries: 10000,
    },
  },
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Record<string, unknown> ? DeepPartial<T[P]> : T[P];
};

export class ConfigManager {
  private config: AppConfig;

  constructor(initial?: DeepPartial<AppConfig>) {
    this.config = this.deepMerge(
      defaultConfig as unknown as Record<string, unknown>,
      (initial || {}) as Record<string, unknown>
    ) as unknown as AppConfig;
  }

  get<K extends keyof AppConfig>(section: K): AppConfig[K] {
    return this.config[section];
  }

  getAll(): AppConfig {
    return this.config;
  }

  update(partial: DeepPartial<AppConfig>): void {
    this.config = this.deepMerge(this.config as unknown as Record<string, unknown>, partial as Record<string, unknown>) as unknown as AppConfig;
  }

  loadFromEnv(): void {
    const port = parseInt(process.env.EvoClaw_PORT || "", 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      this.config.server.port = port;
    }
    const host = process.env.EvoClaw_HOST;
    if (host && host.length > 0) {
      this.config.server.host = host;
    }
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length >= 16) {
      this.config.auth.jwtSecret = jwtSecret;
    }
    this.config.evolution.enabled = process.env.EvoClaw_EVOLUTION_ENABLED !== "false";
    this.config.gateway.enableMCP = process.env.EvoClaw_MCP_ENABLED !== "false";
    this.config.gateway.enableREST = process.env.EvoClaw_REST_ENABLED !== "false";
  }

  private deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      const ov = override[key];
      const bv = base[key];
      if (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object" && !Array.isArray(bv)) {
        result[key] = this.deepMerge(
          bv as Record<string, unknown>,
          ov as Record<string, unknown>
        );
      } else if (ov !== undefined) {
        result[key] = ov;
      }
    }
    return result;
  }
}