/**
 * Grounded Research — claim extraction + cross-source verification.
 *
 * P2 grounded research（roadmap 对标 Hermes v0.20+）：
 * 1. 从多篇来源中抽取"可验证声明"（带来源引用）
 * 2. 跨独立来源核实每条声明（多源一致→verified；冲突→contradicted）
 * 3. 输出带 citation + confidence 的结构化证据包
 *
 * 设计原则（继承 AGENTS.md）：
 * - 纯函数，可单测（无 LLM/网络耦合）——上层 tool 负责搜索/抓取，
 *   本模块只消费已抓取的 evidence 文档
 * - 可插拔：`extractClaimsFromEvidence` 可被 LLM 驱动的抽取器替换
 *   （接口固定，实现可换），当前默认走确定性抽取（句级抽取 + 关键词去重）
 * - Never fail：证据不足时返回空声明列表，不抛错
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** 一篇已抓取来源的证据文档（上层 tool 抓取后传入） */
export interface EvidenceDoc {
  /** 唯一来源 ID（如 "src-1"） */
  id: string;
  /** 来源 URL（可验证引用指向） */
  url: string;
  /** 来源标题 */
  title: string;
  /** 正文纯文本（已截断） */
  content: string;
  /** 抓取时的 HTTP 状态（可选） */
  status?: number;
}

/** 单条可验证声明（一条证据指向一个可核实的事实陈述） */
export interface ResearchClaim {
  /** 声明文本（提取自来源正文的句级片段） */
  text: string;
  /** 支撑该声明的来源 ID 列表（≥2 个独立源才算 verified） */
  citations: string[];
  /** 支撑该声明的来源 URL 列表 */
  citationUrls: string[];
  /**
   * 核实状态：
   * - verified：≥2 个独立来源支撑，无冲突
   * - contradicted：存在来源间事实冲突
   * - unverified：仅单一来源（孤证不立）
   */
  status: "verified" | "contradicted" | "unverified";
  /** 该声明的置信度 0..1（综合多源一致度） */
  confidence: number;
  /** 冲突描述（仅 contradicted 时填充） */
  conflictNote?: string;
}

// ── 句级声明抽取（确定性，可被 LLM 抽取器替换） ─────────────────────────────

/**
 * 从一篇 evidence 文档中抽取"声明候选句"。
 * 启发式：按句号/问号切分，过滤过短/过长的句，去除导语句（"本文"、"据"、
 * "据报道"等弱信息句），保留含数字/实体/因果/数量的强信息句。
 */
export function extractClaimSentences(content: string, maxPerDoc = 12): string[] {
  const sentences = (content ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？.!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 300);

  // 过滤弱信息/导语句
  const weakPatterns = [
    /^本文/,
    /^据(?:报道|称|悉|统计|了解)/,
    /^(?:该|此)(?:公司|企业|机构|报告)/,
    /^欢迎/,
    /^版权所有/,
    /点击(?:这里|阅读)/,
    /^参考/,
  ];
  const strong = sentences.filter((s) => {
    if (weakPatterns.some((p) => p.test(s))) return false;
    // 强信息句：含数字或因果/比较词
    return /\d/.test(s) || /因为|由于|导致|使得|因此|所以|相比|超过|低于|达到|增长|下降|表示|认为|指出|估计|预测/.test(s);
  });

  return strong.slice(0, maxPerDoc);
}

/** 计算两个声明文本的相似性（0..1，字符 bigram Jaccard，避免引入 tokenizer 依赖） */
export function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const clean = s.toLowerCase().replace(/\s+/g, "");
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── 跨源核实 ──────────────────────────────────────────────────────────────────

/** 声明相似阈值：≥0.6 视为同一事实在不同来源的表述 */
const SIMILARITY_THRESHOLD = 0.6;
/** 矛盾检测：两条声明相似度高但含相反量化词（"增长" vs "下降"）视为冲突 */
const CONTRA_PAIRS: Array<[string, string]> = [
  ["增长", "下降"],
  ["上升", "下跌"],
  ["增加", "减少"],
  ["成功", "失败"],
];

/**
 * 对单条声明做跨独立来源核实。
 * - citations ≥ 2 个不同来源 且无冲突 → verified，confidence 随来源数提升
 * - 检测到相反表述 → contradicted
 * - 仅单来源 → unverified
 */
export function verifyClaim(
  claim: ResearchClaim,
  allClaims: ResearchClaim[],
): ResearchClaim {
  const citationCount = new Set(claim.citations).size;

  // 矛盾检测：在其它声明中找高相似但含相反量化词的
  let contradiction: { withText: string; pair: [string, string] } | null = null;
  for (const other of allClaims) {
    if (other === claim) continue;
    const sim = textSimilarity(claim.text, other.text);
    if (sim < SIMILARITY_THRESHOLD) continue;
    for (const [a, b] of CONTRA_PAIRS) {
      const claimHasA = claim.text.includes(a);
      const claimHasB = claim.text.includes(b);
      const otherHasA = other.text.includes(a);
      const otherHasB = other.text.includes(b);
      if ((claimHasA && (otherHasB || (!otherHasA && sim > 0.8))) ||
          (claimHasB && otherHasA)) {
        contradiction = { withText: other.text, pair: [a, b] };
        break;
      }
    }
    if (contradiction) break;
  }

  if (contradiction) {
    claim.status = "contradicted";
    claim.confidence = Math.max(0, 1 - citationCount * 0.2);
    claim.conflictNote = `与来源表述冲突（"${contradiction.pair[0]}" vs "${contradiction.pair[1]}" 反向）：${contradiction.withText.slice(0, 80)}`;
    return claim;
  }

  if (citationCount >= 2) {
    claim.status = "verified";
    // 来源越多置信度越高，上限 0.95（保留人工复核余地）
    claim.confidence = Math.min(0.95, 0.5 + 0.15 * citationCount);
  } else {
    claim.status = "unverified";
    claim.confidence = 0.3;
  }
  return claim;
}

/** 全部声明批量核实 */
export function crossVerifyClaims(claims: ResearchClaim[]): ResearchClaim[] {
  for (const c of claims) verifyClaim(c, claims);
  return claims;
}

// ── 主入口：evidence 文档 → 结构化声明 ───────────────────────────────────────

/**
 * 从多篇 evidence 文档抽取声明并做跨源核实（P2 grounded research 核心）。
 *
 * 流程：
 * 1. 每篇文档抽取声明候选句（extractClaimSentences）
 * 2. 跨文档去重（textSimilarity ≥ 阈值 → 合并为同一声明，citations 累积）
 * 3. crossVerifyClaims 按来源数 + 矛盾检测定 status/confidence
 */
export function extractClaimsFromEvidence(
  docs: EvidenceDoc[],
  opts?: { similarityThreshold?: number; maxClaims?: number },
): { claims: ResearchClaim[]; docs: EvidenceDoc[] } {
  const threshold = opts?.similarityThreshold ?? SIMILARITY_THRESHOLD;
  const maxClaims = opts?.maxClaims ?? 30;

  // 1. 每文档抽声明
  const perDoc: Array<{ doc: EvidenceDoc; text: string }> = [];
  for (const doc of docs) {
    for (const text of extractClaimSentences(doc.content)) {
      perDoc.push({ doc, text });
    }
  }

  // 2. 跨文档去重 + 累积 citations
  const clusters: Array<{ texts: string[]; docIds: string[]; docUrls: Map<string, string> }> = [];
  for (const item of perDoc) {
    let target = clusters.find(
      (c) => c.texts.some((t) => textSimilarity(t, item.text) >= threshold),
    );
    if (!target) {
      target = { texts: [], docIds: [], docUrls: new Map() };
      clusters.push(target);
    }
    target.texts.push(item.text);
    if (!target.docIds.includes(item.doc.id)) target.docIds.push(item.doc.id);
    target.docUrls.set(item.doc.id, item.doc.url);
  }

  // 3. 构声明 + 核实
  const claims: ResearchClaim[] = clusters.slice(0, maxClaims).map((c) => {
    const sorted = [...c.texts].sort((a, b) => b.length - a.length);
    const text = sorted[0] ?? "";
    const citations = c.docIds;
    return {
      text,
      citations,
      citationUrls: citations.map((id) => c.docUrls.get(id) ?? ""),
      status: "unverified",
      confidence: 0,
    };
  });

  const verified = crossVerifyClaims(claims);
  // 按 confidence 降序（verified 在前，便于上层直接取 Top-N 引用）
  verified.sort((a, b) => b.confidence - a.confidence);
  return { claims: verified, docs };
}
