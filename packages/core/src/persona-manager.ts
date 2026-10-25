/**
 * PersonaManager — 多角色（Persona）管理（对标 hermes 的 Profile 系统的「身份」子集）。
 *
 * 背景：EvoClaw 已有单一 PersonaConfig（name/title/masterTerm/tone/introduction），
 * 但只能有一个，且没有切换能力。hermes 的 Profile 系统完整（模型/MCP/技能/灵魂逐配置），
 * 而 EvoClaw 的配置是全局的，强行对齐需重构整个配置层。
 *
 * 因此本模块只做 **hermes Profile 的「身份」子集**：多个命名角色 + 切换，
复用现有 PersonaConfig 字段，存储于 data/personas.json（原子写）。
 * 这是 EvoClaw 能力范围内最贴近 hermes 语义的对齐。
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "./atomic-write";
import type { PersonaConfig } from "./config";

export interface Persona extends PersonaConfig {
  /** 角色 id（与 name 一致，用于路由与存储） */
  id: string;
  /** 是否为当前激活角色 */
  isActive: boolean;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 最后修改时间 ISO 字符串 */
  updatedAt: string;
}

const DEFAULT_PERSONA: PersonaConfig = {
  name: "EvoClaw小助手",
  title: "您的专属EvoClaw智能助理",
  masterTerm: "主人",
  tone: "warm",
  introduction: `您好主人！我是 EvoClaw小助手，您的专属EvoClaw智能助理 🧬

很高兴为您服务！以下是我能帮您做的事情：

✨ 日常对话与问答
  - 回答知识类问题，提供建议和建议
  - 辅助您进行学习、写作和思考

🛠 技能执行
  - 运行已安装的 Skills（技能），自动化处理各类任务
  - 支持从 ClawHub 安装新的 Skills

🚀 任务编排
  - 将复杂任务自动拆解为 DAG 执行计划
  - 动态匹配最优 Skills 组合完成目标

🔬 自我进化
  - 持续学习与自我改进，越用越聪明`,
};

function defaultPersonas(): Persona[] {
  const now = new Date().toISOString();
  return [{ ...DEFAULT_PERSONA, id: DEFAULT_PERSONA.name, isActive: true, createdAt: now, updatedAt: now }];
}

export interface PersonaStore {
  personas: Persona[];
  activeName: string | null;
}

export class PersonaManager {
  private storePath: string;
  private store: PersonaStore;

  constructor(storePath: string) {
    this.storePath = storePath;
    this.store = this.load();
  }

  private load(): PersonaStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PersonaStore>;
        if (Array.isArray(parsed.personas) && parsed.personas.length > 0) {
          const activeName = parsed.activeName || parsed.personas.find((p) => p.isActive)?.name || parsed.personas[0].name;
          return {
            personas: parsed.personas.map((p) => ({ ...p, isActive: p.name === activeName })),
            activeName,
          };
        }
      }
    } catch {
      // 损坏的存储文件：回落默认值，不阻塞启动
    }
    const personas = defaultPersonas();
    return { personas, activeName: personas[0].name };
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(this.storePath, JSON.stringify(this.store, null, 2));
    } catch {
      // 持久化失败不阻塞内存操作（与 config 的容错口径一致）
    }
  }

  listPersonas(): Persona[] {
    return this.store.personas.map((p) => ({ ...p }));
  }

  getActivePersona(): Persona | null {
    const active = this.store.personas.find((p) => p.name === this.store.activeName);
    if (active) return { ...active };
    if (this.store.personas.length > 0) {
      const first = { ...this.store.personas[0] };
      first.isActive = true;
      return first;
    }
    return null;
  }

  getPersona(name: string): Persona | null {
    const p = this.store.personas.find((x) => x.name === name);
    return p ? { ...p } : null;
  }

  createPersona(data: PersonaConfig): Persona {
    const name = (data.name || "").trim();
    if (!name) throw new Error("Persona name is required");
    if (this.store.personas.some((p) => p.name === name)) {
      throw new Error(`Persona "${name}" already exists`);
    }
    const now = new Date().toISOString();
    const persona: Persona = {
      id: name,
      name,
      title: data.title || name,
      masterTerm: data.masterTerm || "主人",
      tone: data.tone || "warm",
      introduction: data.introduction || "",
      isActive: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.personas.push(persona);
    this.persist();
    return { ...persona };
  }

  updatePersona(name: string, data: Partial<PersonaConfig>): Persona {
    const existing = this.store.personas.find((p) => p.name === name);
    if (!existing) throw new Error(`Persona "${name}" not found`);
    const now = new Date().toISOString();
    if (data.name && data.name !== name) {
      if (this.store.personas.some((p) => p.name === data.name)) {
        throw new Error(`Persona "${data.name}" already exists`);
      }
      existing.id = data.name;
      existing.name = data.name;
      this.store.activeName = this.store.activeName === name ? data.name : this.store.activeName;
      name = data.name;
    }
    if (data.title !== undefined) existing.title = data.title;
    if (data.masterTerm !== undefined) existing.masterTerm = data.masterTerm;
    if (data.tone !== undefined) existing.tone = data.tone;
    if (data.introduction !== undefined) existing.introduction = data.introduction;
    existing.updatedAt = now;
    this.persist();
    return { ...existing };
  }

  deletePersona(name: string): boolean {
    const idx = this.store.personas.findIndex((p) => p.name === name);
    if (idx === -1) return false;
    if (this.store.personas.length <= 1) throw new Error("Cannot delete the last persona");
    const [removed] = this.store.personas.splice(idx, 1);
    if (this.store.activeName === name) {
      this.store.activeName = this.store.personas[0].name;
      this.store.personas[0].isActive = true;
    }
    this.persist();
    return true;
  }

  setActivePersona(name: string): Persona {
    const target = this.store.personas.find((p) => p.name === name);
    if (!target) throw new Error(`Persona "${name}" not found`);
    for (const p of this.store.personas) p.isActive = p.name === name;
    this.store.activeName = name;
    this.persist();
    return { ...target };
  }

  /** 供 ConfigManager 读取当前激活角色（不修改存储）。 */
  getActivePersonaConfig(): PersonaConfig {
    const active = this.getActivePersona();
    if (!active) return DEFAULT_PERSONA;
    return {
      name: active.name,
      title: active.title,
      masterTerm: active.masterTerm,
      tone: active.tone,
      introduction: active.introduction,
    };
  }
}