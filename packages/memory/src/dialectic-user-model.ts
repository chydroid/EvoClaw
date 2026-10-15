/**
 * Honcho dialectic 用户建模（Hermes 对标 P2）。
 *
 * 跨会话把用户陈述抽取为 claim，按 topic 维护正题（affirm）/反题（deny）的
 * 辩证关系：新观点与旧观点冲突时把旧观点标记为 challenged（反题成立），
 * 再综合（synthesis）产出稳定的用户信念（SynthesizedBelief），注入系统提示
 * 尾部。叠加在既有分层记忆（L0-L3 / L3 PersonaProfile）之上，不替代 L1-L3。
 *
 * v1 为启发式抽取 + 规则综合：不依赖 LLM key，任何环境可降级运行；
 * 抽取模式支持中英文。持久化走 CrossProcessLock + atomicWriteFile（AGENTS.md 约束）。
 */
import { atomicWriteFile, CrossProcessLock } from "@evoclaw/infrastructure";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** claim 在辩证过程中的状态。 */
export type ClaimStatus =
  | "proposed"   // 新提出（正题）
  | "challenged" // 被更新的反方观点挑战（反题成立，保留不删除）
  | "synthesized"; // 已被综合进用户模型

/** claim 的立场：肯定（affirm）或否定（deny）。 */
export type ClaimStance = "affirm" | "deny";

/** 跨会话的用户主张（辩证的基本单元）。 */
export interface DialecticClaim {
  id: string;
  /** 归一化主题桶（如 "语言偏好"、"沟通风格"）。 */
  topic: string;
  /** 从用户原话截取的主张文本（截断到 200 字符）。 */
  content: string;
  stance: ClaimStance;
  status: ClaimStatus;
  confidence: number;
  /** 该主张出现过的会话。 */
  sessionIds: string[];
  firstSeen: string;
  lastSeen: string;
  /** 与之冲突并已被压倒的对立 claim id。 */
  challengeIds: string[];
}

/** 综合后的稳定用户信念（注入 prompt 的最终产物）。 */
export interface SynthesizedBelief {
  topic: string;
  belief: string;
  stance: ClaimStance;
  confidence: number;
  /** 支持该信念的同立场 claim 数。 */
  evidenceCount: number;
  /** 该主题是否经历过反方挑战（综合时置信度折减）。 */
  dialecticAdjusted: boolean;
  synthesizedAt: string;
}

/** 持久化文件结构。 */
export interface DialecticModelFile {
  version: 1;
  userId: string;
  claims: DialecticClaim[];
  beliefs: SynthesizedBelief[];
  updatedAt: string;
}

/** 抽取规则命中的一条候选主张（纯函数输出，便于测试）。 */
export interface ExtractedClaim {
  topic: string;
  content: string;
  stance: ClaimStance;
}

/** 主题桶：按关键词把主张归类；无命中归入 "一般偏好"。 */
const TOPIC_RULES: Array<{ topic: string; re: RegExp }> = [
  { topic: "语言偏好", re: /typescript|\bts\b|javascript|\bjs\b|python|golang|rust|\bjava\b|c\+\+|中文|英文|chinese|english/i },
  { topic: "工具偏好", re: /vscode|vim|emacs|docker|pnpm|npm|yarn|git|playwright|cursor|copilot|claude|gpt/i },
  { topic: "代码风格", re: /严格模式|strict|注释|comment|代码风格|code style|命名|naming|缩进|indent|函数式|面向对象/i },
  { topic: "沟通风格", re: /简洁|啰嗦|详细|直接|长话短说|别废话|concise|brief|verbose|detailed|straightforward/i },
  { topic: "环境事实", re: /windows|wsl|linux|mac\b|ubuntu|服务器|本机|本地环境|node\s*[\d.]+|端口|port/i },
  { topic: "流程偏好", re: /先.{0,12}再|不要直接|先问我|直接改|别问我|先跑|跑完|提交前|deploy|发布前/i },
];

/**
 * 立场判定按优先级三段式（2026-10-14 评测修复）：
 * 1. 强否定（第一人称拒绝："我不喜欢/我不要/don't use"）——必须先于肯定，
 *    否则 "我不喜欢" 会被 "喜欢" 误判成肯定；
 * 2. 肯定（自述偏好 + 指令式偏好："以后…要…"、"记住：…"、"from now on"）——
 *    指令式偏好是最典型的 Honcho 建模对象，且混合句（"以后要简洁，不要啰嗦"）
 *    语义主体是正面指令，应判肯定；
 * 3. 弱否定（行为禁令："别啰嗦/不要这么长"）——无肯定标记时才生效。
 */
const STRONG_DENY_RE =
  /我不喜欢|我讨厌|我不用|我不要|我拒绝|不想要|(?:i\s+)?(?:don'?t|do not)\s+(?:like|want|use)|i\s+hate|stop\s+using|don'?t\s+use/i;

const AFFIRM_RE =
  /我喜欢|我更喜欢|我偏好|我常用|我习惯(?:用|于)?|我一般(?:都)?|我通常|我用的是|我在用|我跑在|我的.{0,10}(?:是|在)|(?:以后|今后).{0,20}(?:要|请|得|记得)|(?:请|要)(?:一直|总是)?(?:保持|记住)|记住[：:]|(?:i\s+)?(?:really\s+)?like|i\s+prefer|i\s+(?:usually|always)\s+use|i\s+(?:am|'m)\s+using|i\s+(?:am|'m)\s+working\s+with|(?:from\s+now\s+on|please\s+(?:always|be|keep)|always\s+(?:be|keep|answer|reply))/i;

const WEAK_DENY_RE =
  /别(?:再)?用|不要再|以后别|别给我|别(?:再)?(?:啰嗦|废话|赘述|长篇)|(?:不要|不能)(?:太|这么|这样)?(?:啰嗦|冗长|长篇|啰唆)|don'?t\s+(?:be\s+)?(?:verbose|wordy)|no\s+(?:more\s+)?(?:verbosity|rambling)/i;

/** 每轮最多抽取的 claim 数（防单条长消息爆量）。 */
const MAX_CLAIMS_PER_TURN = 5;
/** content 最大长度。 */
const MAX_CONTENT = 200;
/** 渲染注入的最大字符数。 */
const MAX_RENDER_CHARS = 1200;
/** claim 总量上限（超出后淘汰最旧的非挑战方，遵循"只归档不删除"——落到 challenge 状态仍保留）。 */
const MAX_CLAIMS = 500;

function newId(): string {
  return `claim-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 纯函数：从一条用户消息抽取候选主张。
 * 按句子切分（中英文标点），立场按 强否定 → 肯定（含指令式）→ 弱否定 三段优先级判定。
 */
export function extractClaims(text: string): ExtractedClaim[] {
  if (!text) return [];
  const sentences = text
    .split(/[。！？!?\n;；]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 4 && s.length <= MAX_CONTENT * 2);
  const out: ExtractedClaim[] = [];
  for (const sentence of sentences) {
    if (out.length >= MAX_CLAIMS_PER_TURN) break;
    let stance: ClaimStance | null = null;
    if (STRONG_DENY_RE.test(sentence)) stance = "deny";
    else if (AFFIRM_RE.test(sentence)) stance = "affirm";
    else if (WEAK_DENY_RE.test(sentence)) stance = "deny";
    if (!stance) continue;
    const hit = TOPIC_RULES.find(r => r.re.test(sentence));
    out.push({
      topic: hit ? hit.topic : "一般偏好",
      content: sentence.slice(0, MAX_CONTENT),
      stance,
    });
  }
  return out;
}

/**
 * DialecticUserModeler：跨会话辩证用户建模器（单一用户的模型实例）。
 * MemoryHub 持有一个实例（默认 userId "default"）。
 */
export class DialecticUserModeler {
  private claims = new Map<string, DialecticClaim>();
  private beliefs: SynthesizedBelief[] = [];
  private readonly filePath: string;
  private readonly storeDir: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    dataDir?: string,
    private readonly userId: string = "default"
  ) {
    const base = dataDir ?? process.env.EVOCLAW_DATA_DIR ?? path.join(process.cwd(), "data");
    this.storeDir = path.join(base, "memory", "dialectic");
    this.filePath = path.join(this.storeDir, `${this.userId}.json`);
    this.load();
  }

  /**
   * 观察一轮用户消息：抽取 claims → 与既有 claims 辩证（冲突标记 challenged）
   * → 综合出稳定信念 → 持久化。
   * @returns 本次新增/刷新的 claims（诊断用）
   */
  async observeTurn(sessionId: string, userText: string): Promise<DialecticClaim[]> {
    const extracted = extractClaims(userText);
    const now = new Date().toISOString();
    const affected: DialecticClaim[] = [];

    for (const ex of extracted) {
      // 去重：同 topic + 同 content + 同立场 → 刷新证据，不新增
      const dup = Array.from(this.claims.values()).find(
        c => c.topic === ex.topic && c.content === ex.content && c.stance === ex.stance
      );
      if (dup) {
        dup.lastSeen = now;
        if (sessionId && !dup.sessionIds.includes(sessionId)) dup.sessionIds.push(sessionId);
        dup.confidence = Math.min(0.95, dup.confidence + 0.1);
        affected.push(dup);
        continue;
      }

      const claim: DialecticClaim = {
        id: newId(),
        topic: ex.topic,
        content: ex.content,
        stance: ex.stance,
        status: "proposed",
        confidence: 0.6,
        sessionIds: sessionId ? [sessionId] : [],
        firstSeen: now,
        lastSeen: now,
        challengeIds: [],
      };

      // 反题：同 topic 的对立立场既有 claim 被挑战（保留，不删除）
      for (const other of this.claims.values()) {
        if (other.topic !== claim.topic) continue;
        if (other.stance === claim.stance) continue;
        if (other.status === "challenged") continue;
        other.status = "challenged";
        other.challengeIds.push(claim.id);
        claim.challengeIds.push(other.id);
      }

      this.claims.set(claim.id, claim);
      affected.push(claim);
    }

    if (affected.length > 0) {
      this.trim();
      this.synthesize(now);
      await this.persist();
    }
    return affected;
  }

  /** 综合：每个 topic 取未被挑战的最新 claim 产出稳定信念。冲突主题置信度折减。 */
  private synthesize(now: string): void {
    const byTopic = new Map<string, DialecticClaim[]>();
    for (const c of this.claims.values()) {
      if (c.status === "challenged") continue;
      const list = byTopic.get(c.topic) ?? [];
      list.push(c);
      byTopic.set(c.topic, list);
    }

    const beliefs: SynthesizedBelief[] = [];
    for (const [topic, list] of byTopic) {
      list.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      const winner = list[0];
      const dialecticAdjusted = Array.from(this.claims.values()).some(
        c => c.topic === topic && c.status === "challenged"
      );
      const evidenceCount = list.filter(c => c.stance === winner.stance).length;
      // 综合规则：同立场证据加成，经历过的反方挑战折减（辩证修正）
      let confidence = winner.confidence + 0.05 * (evidenceCount - 1);
      if (dialecticAdjusted) confidence *= 0.85;
      winner.status = "synthesized";
      beliefs.push({
        topic,
        belief: winner.content,
        stance: winner.stance,
        confidence: Math.round(Math.min(0.95, confidence) * 100) / 100,
        evidenceCount,
        dialecticAdjusted,
        synthesizedAt: now,
      });
    }
    beliefs.sort((a, b) => b.confidence - a.confidence);
    this.beliefs = beliefs;
  }

  /** 渲染为可注入系统提示尾部的画像文本；空模型返回 ""。 */
  renderModel(maxChars: number = MAX_RENDER_CHARS): string {
    if (this.beliefs.length === 0) return "";
    const lines: string[] = [
      "[辩证用户模型] 跨会话综合的用户认知（启发式抽取，如与用户当前指令冲突以当前指令为准）",
    ];
    for (const b of this.beliefs) {
      const stance = b.stance === "deny" ? "不" : "";
      const note = [
        `置信 ${b.confidence.toFixed(2)}`,
        `证据 ${b.evidenceCount}`,
        b.dialecticAdjusted ? "曾有反方观点，已综合" : "",
      ].filter(Boolean).join("，");
      lines.push(`- [${b.topic}] 用户${stance}「${b.belief}」（${note}）`);
      if (lines.join("\n").length >= maxChars) break;
    }
    const rendered = lines.join("\n");
    return rendered.length > maxChars ? rendered.slice(0, maxChars) + "\n…" : rendered;
  }

  /** 读取全部 claims（状态快照）。 */
  getClaims(): DialecticClaim[] {
    return Array.from(this.claims.values());
  }

  /** 读取综合信念（注入产物）。 */
  getBeliefs(): SynthesizedBelief[] {
    return [...this.beliefs];
  }

  /** 模型导出（管理端点/测试用）。 */
  export(): DialecticModelFile {
    return {
      version: 1,
      userId: this.userId,
      claims: this.getClaims(),
      beliefs: this.getBeliefs(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** 等待挂起的持久化完成（测试/优雅退出用）。 */
  async flush(): Promise<void> {
    await this.saveChain;
  }

  /** claim 裁剪：超过上限时淘汰最旧的 challenged（反题历史价值最低），其余不动。 */
  private trim(): void {
    if (this.claims.size <= MAX_CLAIMS) return;
    const candidates = Array.from(this.claims.values())
      .filter(c => c.status === "challenged")
      .sort((a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen));
    let overflow = this.claims.size - MAX_CLAIMS;
    for (const c of candidates) {
      if (overflow <= 0) break;
      this.claims.delete(c.id);
      overflow--;
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as DialecticModelFile;
      if (Array.isArray(data.claims)) {
        for (const c of data.claims) {
          if (c && c.id) this.claims.set(c.id, c);
        }
      }
      if (Array.isArray(data.beliefs)) this.beliefs = data.beliefs;
    } catch (err) {
      process.stderr.write(`[dialectic] load failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** 持久化：串行化写链 + CrossProcessLock + atomicWriteFile。失败不抛错。 */
  private persist(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      try {
        if (!fs.existsSync(this.storeDir)) {
          fs.mkdirSync(this.storeDir, { recursive: true });
        }
        const data: DialecticModelFile = this.export();
        const lock = new CrossProcessLock(this.storeDir, `dialectic-${this.userId}`);
        await lock.withLock(() => atomicWriteFile(this.filePath, JSON.stringify(data, null, 2)));
      } catch (err) {
        process.stderr.write(`[dialectic] persist failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
    return this.saveChain;
  }
}
