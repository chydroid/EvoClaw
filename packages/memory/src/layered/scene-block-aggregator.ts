/**
 * L2 SceneBlockAggregator — 情境块聚合器。
 *
 * 借鉴 TencentDB-Agent-Memory 的 L2 设计：把 L1 原子记忆按"情境"聚类成
 * Markdown 文件（人类可读、白箱可检视），形成中粒度的"场景块"。
 *
 * 情境识别策略（启发式，不依赖 LLM）：
 * - 按 sessionKey + 时间窗口（默认 30 分钟）切分
 * - 在窗口内按主题关键词聚类（共享名词 → 同一情境）
 * - 每个情境输出一个 Markdown 文件
 *
 * 文件布局：
 *   ${DATA_DIR}/memory/layered/scene_blocks/${sceneId}.md
 *
 * Markdown 结构：
 *   ---
 *   scene_id: scene_xxx
 *   scene_name: "在配置 TypeScript 项目"
 *   session_keys: [s1, s2]
 *   time_range: [start, end]
 *   memory_count: 5
 *   ---
 *   ## Persona
 *   - 用户偏好使用 TypeScript
 *   ## Episodic
 *   - 用户今天部署了 v0.66.9
 *   ## Instruction
 *   - 用户要求代码必须通过 typecheck
 */

import * as fs from "fs";
import * as path from "path";
import type { AtomicMemory } from "./atomic-memory-extractor";
import { atomicWriteFileSync } from "./atomic-write";

/** 场景数量三级预警级别（借鉴 TencentDB-Agent-Memory scene-extractor）。 */
export type SceneWarningLevel = "green" | "yellow" | "orange" | "red";

/** Persona Update Signal 标签（借鉴 TencentDB-Agent-Memory）。 */
export const PERSONA_UPDATE_SIGNAL = "[PERSONA_UPDATE_REQUEST]";

/** 默认最大场景数（三级预警用）。 */
const DEFAULT_MAX_SCENES = 50;

/** L2 情境块。 */
export interface SceneBlock {
  /** 全局唯一 ID。 */
  sceneId: string;
  /** 情境名称（"在做 XXX"格式）。 */
  sceneName: string;
  /** 来源会话键列表。 */
  sessionKeys: string[];
  /** 时间范围 [start, end] (epoch ms)。 */
  timeRange: [number, number];
  /** 包含的 L1 记忆 ID 列表。 */
  memoryIds: string[];
  /** 包含的 L1 记忆内容（用于写入 Markdown）。 */
  memories: AtomicMemory[];
  /** Markdown 文件路径。 */
  filePath?: string;
}

/** L2 聚合配置。 */
export interface SceneAggregationOptions {
  /** 时间窗口（毫秒），同一窗口内的 L1 记忆视为同一情境。默认 30 分钟。 */
  timeWindowMs?: number;
  /** 主题关键词阈值（共享至少 N 个名词才视为同一情境）。默认 1。 */
  topicOverlapThreshold?: number;
  /** 单个情境最多包含多少条 L1 记忆。默认 20。 */
  maxMemoriesPerScene?: number;
}

const DEFAULT_OPTIONS: Required<SceneAggregationOptions> = {
  timeWindowMs: 30 * 60 * 1000,
  topicOverlapThreshold: 1,
  maxMemoriesPerScene: 20,
};

/**
 * L2 情境块聚合器。
 *
 * 使用方式：
 *   const agg = new SceneBlockAggregator(dataDir);
 *   const scenes = agg.aggregate(l1Memories);
 *   agg.writeSceneFiles(scenes);
 */
export class SceneBlockAggregator {
  private readonly scenesDir: string;

  constructor(private dataDir: string) {
    this.scenesDir = path.join(dataDir, "memory", "layered", "scene_blocks");
    this.ensureDir(this.scenesDir);
  }

  /**
   * 把 L1 记忆按情境聚合成 L2 块。
   * 输入应按时间顺序排好（早→晚）。
   */
  aggregate(memories: AtomicMemory[], options?: SceneAggregationOptions): SceneBlock[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    if (memories.length === 0) return [];

    // 按 sessionKey + 时间窗口初步分组
    const getMemTime = (m: AtomicMemory): number => {
      const t = m.metadata?.sourceTimestamp;
      return typeof t === "number" ? t : m.extractedAt;
    };
    const sorted = [...memories].sort((a, b) => getMemTime(a) - getMemTime(b));

    const scenes: SceneBlock[] = [];
    let current: SceneBlock | null = null;

    for (const mem of sorted) {
      const memTime = getMemTime(mem);

      if (current) {
        const sameSession = current.sessionKeys.includes(mem.sessionKey);
        const withinWindow = memTime - current.timeRange[1] <= opts.timeWindowMs;
        const topicOverlap = this.topicOverlap(current, mem) >= opts.topicOverlapThreshold;
        const notFull = current.memories.length < opts.maxMemoriesPerScene;

        if ((sameSession && withinWindow && notFull) || (topicOverlap && notFull)) {
          // 加入当前情境
          current.memories.push(mem);
          current.memoryIds.push(mem.id);
          current.timeRange[1] = memTime;
          if (!current.sessionKeys.includes(mem.sessionKey)) {
            current.sessionKeys.push(mem.sessionKey);
          }
          continue;
        }
      }

      // 开新情境
      if (current) scenes.push(current);
      current = this.newScene(mem);
    }
    if (current) scenes.push(current);

    // 给每个情境命名
    for (const scene of scenes) {
      scene.sceneName = this.nameScene(scene);
    }

    return scenes;
  }

  /** 把情境块写入 Markdown 文件。使用 atomicWriteFileSync 保证原子性。 */
  writeSceneFiles(scenes: SceneBlock[]): string[] {
    const paths: string[] = [];
    for (const scene of scenes) {
      const md = this.renderMarkdown(scene);
      const file = path.join(this.scenesDir, `${scene.sceneId}.md`);
      atomicWriteFileSync(file, md);
      scene.filePath = file;
      paths.push(file);
    }
    return paths;
  }

  /**
   * 检查场景数量三级预警（借鉴 TencentDB-Agent-Memory scene-extractor）。
   *
   * - red：场景数 >= maxScenes，必须先 MERGE
   * - orange：场景数 = maxScenes - 1，只能 UPDATE
   * - yellow：场景数 >= maxScenes * 0.8，优先 UPDATE 或 MERGE
   * - green：场景数 < maxScenes * 0.8，可自由 CREATE
   */
  checkSceneWarning(maxScenes: number = DEFAULT_MAX_SCENES): {
    level: SceneWarningLevel;
    currentCount: number;
    maxScenes: number;
    recommendation: string;
  } {
    const current = this.listScenes().length;
    if (current >= maxScenes) {
      return {
        level: "red",
        currentCount: current,
        maxScenes,
        recommendation: "场景数已达上限，必须先 MERGE 已有场景，不允许 CREATE",
      };
    }
    if (current >= maxScenes - 1) {
      return {
        level: "orange",
        currentCount: current,
        maxScenes,
        recommendation: "场景数接近上限，只能 UPDATE 已有场景",
      };
    }
    if (current >= maxScenes * 0.8) {
      return {
        level: "yellow",
        currentCount: current,
        maxScenes,
        recommendation: "场景数偏多，优先 UPDATE 或 MERGE",
      };
    }
    return {
      level: "green",
      currentCount: current,
      maxScenes,
      recommendation: "场景数正常，可自由 CREATE",
    };
  }

  /**
   * 解析场景 Markdown 中的 Persona Update Signal。
   *
   * 借鉴 TencentDB-Agent-Memory 的 parsePersonaUpdateSignal：
   * - 检测场景内容中的 [PERSONA_UPDATE_REQUEST] 标签
   * - 提取标签后的指令文本
   * - 用于触发 L3 画像刷新
   *
   * @returns 提取到的指令数组（若无返回空数组）
   */
  parsePersonaUpdateSignal(sceneMarkdown: string): string[] {
    const signals: string[] = [];
    const re = new RegExp(
      PERSONA_UPDATE_SIGNAL.replace(/[[\]]/g, "\\$&") + "\\s*([^\\n\\[\\]]+)",
      "g"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(sceneMarkdown)) !== null) {
      const instruction = m[1].trim();
      if (instruction) signals.push(instruction);
    }
    return signals;
  }

  /**
   * 扫描所有场景文件，提取所有 Persona Update Signal。
   *
   * @returns 所有场景中检测到的画像更新指令
   */
  collectPersonaUpdateSignals(): string[] {
    const allSignals: string[] = [];
    for (const sceneId of this.listScenes()) {
      const scene = this.loadScene(sceneId);
      if (!scene) continue;
      const md = this.renderMarkdown(scene);
      const signals = this.parsePersonaUpdateSignal(md);
      allSignals.push(...signals);
    }
    return allSignals;
  }

  /** 加载已存在的情境块（用于召回/查询）。 */
  loadScene(sceneId: string): SceneBlock | null {
    const file = path.join(this.scenesDir, `${sceneId}.md`);
    if (!fs.existsSync(file)) return null;
    try {
      const md = fs.readFileSync(file, "utf-8");
      return this.parseMarkdown(md);
    } catch {
      return null;
    }
  }

  /** 列出所有情境 ID。 */
  listScenes(): string[] {
    if (!fs.existsSync(this.scenesDir)) return [];
    return fs.readdirSync(this.scenesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  /** 搜索包含关键词的情境块（线性扫描）。 */
  search(keyword: string, limit = 10): SceneBlock[] {
    if (!keyword.trim()) return [];
    const lower = keyword.toLowerCase();
    const results: SceneBlock[] = [];
    for (const sceneId of this.listScenes()) {
      const scene = this.loadScene(sceneId);
      if (!scene) continue;
      const inName = scene.sceneName.toLowerCase().includes(lower);
      const inContent = scene.memories.some((m) => m.content.toLowerCase().includes(lower));
      if (inName || inContent) {
        results.push(scene);
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  /** 清空所有 L2 情境块。 */
  clear(): void {
    if (!fs.existsSync(this.scenesDir)) return;
    for (const f of fs.readdirSync(this.scenesDir)) {
      if (f.endsWith(".md")) {
        try { fs.unlinkSync(path.join(this.scenesDir, f)); } catch { /* ignore */ }
      }
    }
  }

  // ── 私有辅助 ──

  private newScene(mem: AtomicMemory): SceneBlock {
    const t = mem.metadata?.sourceTimestamp;
    const ts = typeof t === "number" ? t : mem.extractedAt;
    return {
      sceneId: this.genSceneId(),
      sceneName: "",
      sessionKeys: [mem.sessionKey],
      timeRange: [ts, ts],
      memoryIds: [mem.id],
      memories: [mem],
    };
  }

  private topicOverlap(scene: SceneBlock, mem: AtomicMemory): number {
    // 提取 scene 中所有记忆的名词关键词
    const sceneKeywords = this.extractKeywords(scene.memories.map((m) => m.content).join(" "));
    const memKeywords = this.extractKeywords(mem.content);
    let overlap = 0;
    for (const k of memKeywords) {
      if (sceneKeywords.has(k)) overlap++;
    }
    return overlap;
  }

  private extractKeywords(text: string): Set<string> {
    // 简单关键词提取：英文单词（>=4 字符）+ 中文连续 2-4 字片段
    const keywords = new Set<string>();
    // 英文
    const enMatches = text.match(/\b[a-zA-Z][a-zA-Z0-9_-]{3,}\b/g);
    if (enMatches) {
      for (const w of enMatches) {
        // 跳过停用词
        if (!/^(?:that|this|with|from|have|they|will|your|their|what|when|which|where|while)$/.test(w)) {
          keywords.add(w.toLowerCase());
        }
      }
    }
    // 中文（连续 2-4 字片段，简单切分）
    const cnMatches = text.match(/[\u4e00-\u9fff]{2,4}/g);
    if (cnMatches) {
      for (const w of cnMatches) keywords.add(w);
    }
    return keywords;
  }

  private nameScene(scene: SceneBlock): string {
    // 用最高优先级的记忆 + 关键词生成情境名
    const top = scene.memories[0];
    if (!top) return "未命名情境";

    // 提取关键词作为情境名
    const keywords = [...this.extractKeywords(scene.memories.map((m) => m.content).join(" "))];
    if (keywords.length === 0) return `会话 ${scene.sessionKeys[0] ?? "未知"}`;

    // 取前 3 个关键词
    const top3 = keywords.slice(0, 3).join("、");
    return `在做 ${top3}`;
  }

  private renderMarkdown(scene: SceneBlock): string {
    const lines: string[] = [];
    // YAML frontmatter
    lines.push("---");
    lines.push(`scene_id: ${scene.sceneId}`);
    lines.push(`scene_name: "${scene.sceneName.replace(/"/g, '\\"')}"`);
    lines.push(`session_keys: [${scene.sessionKeys.map((s) => `"${s}"`).join(", ")}]`);
    lines.push(`time_range: [${scene.timeRange[0]}, ${scene.timeRange[1]}]`);
    lines.push(`memory_count: ${scene.memories.length}`);
    lines.push("---");
    lines.push("");

    // 按类型分组
    const byType = {
      persona: scene.memories.filter((m) => m.type === "persona"),
      episodic: scene.memories.filter((m) => m.type === "episodic"),
      instruction: scene.memories.filter((m) => m.type === "instruction"),
    };

    if (byType.persona.length > 0) {
      lines.push("## Persona");
      for (const m of byType.persona) {
        lines.push(`- ${m.content} _(priority: ${m.priority})_`);
      }
      lines.push("");
    }
    if (byType.episodic.length > 0) {
      lines.push("## Episodic");
      for (const m of byType.episodic) {
        const time = m.metadata?.sourceTimestamp
          ? new Date(m.metadata.sourceTimestamp as number).toISOString().slice(0, 16)
          : "unknown";
        lines.push(`- [${time}] ${m.content} _(priority: ${m.priority})_`);
      }
      lines.push("");
    }
    if (byType.instruction.length > 0) {
      lines.push("## Instruction");
      for (const m of byType.instruction) {
        lines.push(`- ${m.content} _(priority: ${m.priority})_`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private parseMarkdown(md: string): SceneBlock | null {
    // 简单解析：从 YAML frontmatter 提取元信息
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const sceneId = fm.match(/scene_id:\s*(\S+)/)?.[1] ?? "";
    const sceneName = fm.match(/scene_name:\s*"([^"]*)"/)?.[1] ?? "";
    const sessionKeysRaw = fm.match(/session_keys:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const sessionKeys = sessionKeysRaw.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    const timeRangeRaw = fm.match(/time_range:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const timeParts = timeRangeRaw.split(",").map((s) => parseInt(s.trim(), 10));
    const timeRange: [number, number] = [timeParts[0] ?? 0, timeParts[1] ?? 0];

    // 从 markdown 列表项粗略恢复 memories（信息不全，主要用于召回查看）
    const memories: AtomicMemory[] = [];
    const memRegex = /^- (?:\[[^\]]*\]\s*)?(.+?)\s*_\(priority:\s*(\d+)\)_\s*$/gm;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = memRegex.exec(md)) !== null) {
      const content = m[1];
      const priority = parseInt(m[2], 10);
      // 推断类型：看上一个 ## 标题
      const before = md.slice(0, m.index);
      const lastHeader = before.match(/## (Persona|Episodic|Instruction)$/m)?.[1]?.toLowerCase() ?? "persona";
      memories.push({
        id: `${sceneId}_m${idx++}`,
        type: lastHeader as AtomicMemory["type"],
        content,
        priority,
        sourceMessageIds: [],
        sessionKey: sessionKeys[0] ?? "",
        extractedAt: timeRange[1],
      });
    }

    return {
      sceneId,
      sceneName,
      sessionKeys,
      timeRange,
      memoryIds: memories.map((m) => m.id),
      memories,
    };
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private genSceneId(): string {
    return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
}
