/**
 * 交付物契约（Deliverable Contract）
 *
 * 问题：完成声明对账只校验「模型在回复里声称创建的文件」，但任务要求本身
 * 可能列了若干**必交产物**，模型只字未提就宣称「全部完成」——这类漏交不
 * 会被任何现有对账捕获（v14 diff 任务实测：`patch.diff` / `applied.txt` 从未
 * 生成，回复却写「全部完成」）。
 *
 * 本模块从**用户原始任务文本**中抽取显式要求的交付文件，供回合结束前做
 * 确定性的存在性核验。对标 Hermes kanban 的 `artifacts=[...]` + 验收标准：
 * 完成状态由产物是否存在决定，而不是由模型的措辞决定。
 *
 * 设计取舍（保守优先，避免误报导致无谓续跑）：
 *   - 只有任务文本里出现明确交付动词/「交付物」段落时才启用；
 *   - 排除 URL、版本号、`fixtures/` 输入夹具及其同名文件（任务提供、禁止修改）；
 *   - 只取带已知扩展名的文件 token，不做模糊匹配；
 *   - 相对路径解析到任务文本中出现的第一个绝对目录（否则工作区根）。
 */

import * as path from "path";
import { createHash } from "crypto";
import { stripWorkspaceDirPrefix } from "./workspace-path";

/** 视为「交付文件」的扩展名（代码/数据/文档/压缩产物） */
const DELIVERABLE_EXTENSIONS = [
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "sh", "bash", "go", "rs",
  "java", "kt", "sql", "json", "jsonl", "md", "txt", "csv", "tsv", "yaml", "yml",
  "toml", "xml", "html", "htm", "css", "scss", "diff", "patch", "docx", "xlsx",
  "pptx", "pdf", "zip", "tar", "gz", "png", "svg", "prom",
];

const EXT_ALT = DELIVERABLE_EXTENSIONS.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/** 文件 token：允许相对/绝对路径与子目录，前后必须是分隔符（避免吃掉 URL/占位符）。
 *  尾部分隔容忍全角开括号 `（`——真实任务文本里「fixtures/config.json（禁止修改）」的
 *  `（` 紧跟在路径后，若不接受它，`fixtures/config.json` 无法整体成 token，会退化成
 *  只匹配裸 `config.json`，导致夹具 basename 漏登记。 */
const FILE_TOKEN_RE = new RegExp(
  // 前置分隔符含全角右括号 `）`：中文任务常用「1）foo.js」列举交付物，
  // 若不接受 `）`，这类 token 整体匹配不到，契约会漏掉真实产物。
  `(?:^|[\\s\`"'（(、,，:：；;|）])([A-Za-z0-9_./\\\\-]+\\.(?:${EXT_ALT}))(?=$|[\\s\`"'（()）、,，:：；;。.!?|])`,
  "gi",
);

/** 任务包含交付意图（否则不启用契约检查） */
const DELIVERY_SIGNAL_RE =
  /交付|产出|交付物|必交|生成|创建|写入|导出|输出文件|落盘|deliverables?|artifacts?|create|generate|write|produce|export/i;

/** 第一个绝对目录（POSIX 或 Windows 盘符） */
const ABS_DIR_RE = /(?:^|[\s`"'（(])((?:\/|[A-Za-z]:[\\/])[\w.\\/-]*[\\/])/g;

/**
 * 相对任务目录（`data/workspace/<段>/`）。压测任务原文常写「在 data/workspace/v29-t3/ 实现……」——
 * 与工具侧 stripWorkspacePrefix 同源的契约是：`data/workspace/` 前缀会被剥掉、按
 * 工作区根解析（v26 smoke 已修过 token 级双前缀，但**目录级识别**一直没跟上）。
 * ABS_DIR_RE 只认绝对目录，相对任务目录漏识别 → targetDir 回退工作区根 →
 * 后续所有相对交付 token 解析到工作区根（v29 T3 实证：fixtures/leak.txt 被
 * 误当任务提供的输入、scanner.js 解析到根 → 验收误报「任务未完成」+
 * 3 次无谓续跑，产物实际全落在 v29-t3/ 且盘上核验全通过）。
 * 负向后顾排除词中误匹配（mydata/workspace/）与**绝对路径中段**
 * （/home/…/data/workspace/… ——那是绝对目录，走 ABS_DIR_RE 兜底，
 * 不得误当「仓库相对任务目录」劫持 targetDir）。取首个命中即停。
 */
const DATA_WORKSPACE_TASK_DIR_RE = /(?<![\w./-])(?:data\/workspace\/)([\w.-]+)\/?/;

/** 夹具目录标记：这些路径由任务提供、通常禁止修改，不计入交付物 */
const FIXTURE_PATH_RE = /(^|[\\/])fixtures?[\\/]|^fixtures?[\\/]/i;

/** 交付意图（子句级）：裸文件名只有在含该词的子句里才算交付物 */
const DELIVERY_TOKEN_RE =
  /交付|产出|必交|生成|创建|写入|导出|输出|落盘|构建|deliver|create|generate|write|produce|export|artifact/i;

/**
 * 占位符目录段（OUTDIR / BACKUP_DIR / DEST …）。
 * 任务描述里的命令行用法常出现 `OUTDIR/manifest.json` 这类**参数占位**，
 * 它们不是交付物；若误当必交文件，回合结束会反复提示「契约未满足」。
 * 仅对含路径分隔符的 token 生效，裸文件名（README.md）不受影响。
 */
const PLACEHOLDER_DIR_SEGMENT_RE = /^[A-Z][A-Z0-9_]{1,}$/;
function hasPlaceholderDir(raw: string): boolean {
  const segments = raw.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) return false;
  return segments.slice(0, -1).some((s) => PLACEHOLDER_DIR_SEGMENT_RE.test(s));
}

/**
 * 夹具目录提及（fixtures/ 或 fixture/）。
 * 边界集含 CJK `。`——v29 T3 实证：「…（解码后再匹配）。fixtures/ 下生成 3 个
 * 样例文件」的 fixtures/ 前驱是 `。`，旧边界 [\\/\\s] 不认 → 提及漏登记。
 */
const FIXTURE_MENTION_RE = /(?:^|[\\/\s。])fixtures?[\\/]/gi;

/**
 * token 是否出现在同一子句内、某个 `fixtures/...` 提及之后。
 * 例：「夹具 fixtures/data/（a.txt、sub/c.txt）由我提供」——sub/c.txt 是
 * 夹具子路径，不是交付物；但它带路径分隔符，旧逻辑会直接信任并误报缺失。
 */
function afterFixtureMention(text: string, index: number): boolean {
  FIXTURE_MENTION_RE.lastIndex = 0;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = FIXTURE_MENTION_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end > index) break;
    lastEnd = end;
  }
  if (lastEnd < 0) return false;
  return !CLAUSE_BOUNDARY_RE.test(text.slice(lastEnd, index));
}

/**
 * 广为人知的技术/库名——它们长得像文件名，但几乎从不作为交付物。
 * 仅对**裸文件名**（不含路径分隔符）生效；`vendor/node.js` 这类带路径的仍按
 * 文件处理。没有这层过滤，「交付 index.js，使用 node.js 实现」会把 node.js
 * 当成必交产物，导致每轮都误报缺失、白白续跑。
 */
const NON_DELIVERABLE_BARE = new Set([
  "node.js", "deno.js", "bun.js", "vue.js", "react.js", "next.js", "nuxt.js",
  "three.js", "d3.js", "express.js", "socket.io", "jquery.js", "angular.js",
  "ember.js", "svelte.js", "preact.js", "solid.js", "alpine.js", "chart.js",
  "p5.js", "ml5.js", "vite.js", "webpack.js", "rollup.js", "lodash.js",
  "moment.js", "axios.js", "jest.js", "vitest.js", "mocha.js", "chai.js",
  "playwright.js", "puppeteer.js", "tensorflow.js", "backbone.js", "knockout.js",
]);

/** 判断 index 所在的子句（以句读分隔）是否包含交付意图词 */
const CLAUSE_BOUNDARY_RE = /[。；;，,\n]/;

/**
 * 逐字符判定句子边界（`。`/`；`/`;`/换行/`!`/英文句点+空白）。
 * 不能用正则 `test(单字符)`——英文句点规则带 `(?=\s)` 前瞻，只测一个字符
 * 时永远不成立。这里显式看后一个字符。
 */
function isSentenceBoundaryAt(text: string, i: number): boolean {
  if (i < 0 || i >= text.length) return false;
  const ch = text[i];
  if (ch === "。" || ch === "；" || ch === ";" || ch === "!" || ch === "\n") return true;
  if (ch === ".") return i + 1 >= text.length || /\s/.test(text[i + 1]);
  return false;
}

/** [from, to) 区间内是否含句子边界 */
function hasSentenceBoundary(text: string, from: number, to: number): boolean {
  for (let i = Math.max(0, from); i < to; i++) {
    if (isSentenceBoundaryAt(text, i)) return true;
  }
  return false;
}
function clauseHasDeliveryIntent(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !CLAUSE_BOUNDARY_RE.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !CLAUSE_BOUNDARY_RE.test(text[end])) end++;
  return DELIVERY_TOKEN_RE.test(text.slice(start, end));
}

/**
 * 裸文件名 token 落在哪个夹具目录提及之内：取 token 前最近一次夹具目录
 * 提及，若其间**没有句子边界**且 token 所在句含交付意图（「生成/创建/写入…」），
 * 说明这是「任务要求我产出的夹具文件」（v29 T3 实证：`fixtures/ 下生成 3 个样例
 * 文件：leak.txt、clean.txt、encoded.txt`——夹具目录是**交付目标**而非任务输入，
 * 误当输入会漏登记 + 误报缺失）。返回夹具目录名（`fixtures`/`fixture`，归一为
 * 复数 `fixtures`）；否则 undefined。
 */
function fixtureDirNameBefore(text: string, index: number): string | undefined {
  FIXTURE_MENTION_RE.lastIndex = 0;
  let lastEnd = -1;
  let lastMention = "";
  let m: RegExpExecArray | null;
  while ((m = FIXTURE_MENTION_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end > index) break;
    lastEnd = end;
    lastMention = m[0];
  }
  if (lastEnd < 0) return undefined;
  if (hasSentenceBoundary(text, lastEnd, index)) return undefined;
  if (!sentenceHasDeliveryIntent(text, index)) return undefined;
  // 沿用提及里的实际目录名（fixture/ 或 fixtures/）——提及含边界前驱字符
  // （如「。fixtures/」），须用正则取目录段本身，不能整段剥分隔符。
  const dirSeg = (lastMention.match(/(fixture|fixtures)\//i) ?? [])[1];
  return (dirSeg ?? "fixtures").toLowerCase();
}

/** token 所在句（句子边界 `。；;!\n`/英文句点+空白切分）是否含交付意图词 */
function sentenceHasDeliveryIntent(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !isSentenceBoundaryAt(text, start - 1)) start--;
  let end = index;
  while (end < text.length && !isSentenceBoundaryAt(text, end)) end++;
  return DELIVERY_TOKEN_RE.test(text.slice(start, end));
}

/** 显式大小下限：`≥300 字节` / `至少 300 bytes` / `300 字节以上` */
const MIN_BYTES_RE =
  /(?:[≥>=]+\s*(\d+)\s*(?:字节|bytes?\b|b\b)|(?:至少|不少于|不低于|不小于|大于)\s*(\d+)\s*(?:字节|bytes?\b)|(\d+)\s*(?:字节|bytes?\b)\s*(?:以上|或以上))/i;

/** 显式断言数下限：`至少 8 个断言` / `≥8 assertions` / `断言数 ≥ 8` */
const MIN_ASSERTIONS_RE =
  /(?:(?:至少|不少于|不小于|[≥>=]+)\s*(\d+)\s*(?:个)?\s*(?:断\s*言|assertions?\b|asserts?\b)|(?:断\s*言|assertions?)\s*(?:数|数量)?\s*(?:至少|不少于|不小于|[≥>=]+)\s*(\d+))/i;

/** 任务文本中的阈值归属于「同一句内最近的、位于其前的文件 token」 */
const THRESHOLD_LOOKBACK_CHARS = 240;

/** 取首个非空捕获组 */
function firstInt(m: RegExpExecArray | null): number | undefined {
  if (!m) return undefined;
  for (let i = 1; i < m.length; i++) {
    if (m[i] != null && m[i] !== "") {
      const n = Number(m[i]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

interface TokenOccurrence {
  raw: string;
  /** token 在全文中的起始下标 */
  index: number;
  /** token 在全文中的结束下标（不含） */
  end: number;
  /** 解析后的绝对路径（保留原始大小写，用于落盘/读盘） */
  path: string;
  /** 小写聚合键（用于按文件归并阈值与去重） */
  key: string;
}

/**
 * 阈值归属：找**同一句内、最近的前置**文件 token。
 *
 * 不用「固定窗口」——真实任务文本里阈值出现在文件被再次提及之后
 * （`3）test_x.py：\`python3 test_x.py\` 退出码 0，至少 8 个断言`），
 * 窗口法会把阈值绑到后一个文件或漏掉。句读边界（。；;!换行）阻断归属，
 * 保证「另一些断言」不会跨句误绑。
 *
 * 无前置 token 时允许向后找 60 字符内的 token（`≥300 字节的 README.md` 形态）。
 */
function attributeThresholds(
  text: string,
  occurrences: TokenOccurrence[],
  re: RegExp,
): Map<string, number> {
  const byKey = new Map<string, number>();
  const sorted = [...occurrences].sort((a, b) => a.index - b.index);
  // 调用方传入的是无 g 的匹配规则（单次 exec 语义）；这里复制成全局版本
  // 才能遍历所有阈值出现位置——直接在无 g 正则上循环会永久停在首匹配。
  const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    const at = m.index;
    let owner: TokenOccurrence | undefined;
    // 向前找：同句、距离不超过回看上限
    for (let i = sorted.length - 1; i >= 0; i--) {
      const occ = sorted[i];
      if (occ.end > at) continue;
      if (at - occ.end > THRESHOLD_LOOKBACK_CHARS) break;
      if (hasSentenceBoundary(text, occ.end, at)) break; // 跨句，停止
      owner = occ;
      break;
    }
    // 向后找：同句、60 字符内（阈值写在文件名之前）
    if (!owner) {
      for (const occ of sorted) {
        if (occ.index < at) continue;
        if (occ.index - at > 60) break;
        if (hasSentenceBoundary(text, at, occ.index)) break;
        owner = occ;
        break;
      }
    }
    if (!owner) continue;
    const value = firstInt(m);
    if (value == null) continue;
    byKey.set(owner.key, Math.max(byKey.get(owner.key) ?? 0, value));
  }
  return byKey;
}

export interface DeliverableSpec {
  /** 任务文本中的原始 token（用于提示） */
  raw: string;
  /** 解析后的绝对路径 */
  path: string;
  /** 任务显式要求的最小字节数（如 `README.md（≥300 字节）`） */
  minBytes?: number;
  /** 任务显式要求的最小断言数（如测试文件「至少 8 个断言」） */
  minAssertions?: number;
}

/**
 * 从用户任务文本抽取必需交付物。
 *
 * @param userMessage 用户原始消息（不要传搜索/上下文增强后的消息）
 * @param workspacePath 工作区根（无绝对目录线索时用于解析相对路径）
 */
export function extractRequiredDeliverables(
  userMessage: string,
  workspacePath: string,
): DeliverableSpec[] {
  const text = userMessage || "";
  if (!text || !DELIVERY_SIGNAL_RE.test(text)) return [];

  // 目标目录：任务文本里第一个绝对目录；否则工作区根。
  // ★ 2026-11-23 v29 实证（T3）：任务写「在 data/workspace/v29-t3/ 实现…」——
  //   仓库相对写法与工具侧 stripWorkspacePrefix 同源的契约是「剥前缀、按工作区根
  //   解析」，但目录级识别一直没跟上：ABS_DIR_RE 只认绝对目录，相对任务目录漏
  //   识别 → targetDir 回退工作区根 → 任务后段出现的绝对目录回显（工具日志里的
  //   /home/.../data/workspace/fixtures/、模型自述路径等）被误当「任务目标目录」，
  //   scanner.js、leak.txt 等必交产物解析到工作区根 → 验收误报「任务未完成」+
  //   3 次无谓续跑（产物实际全落在 v29-t3/，盘上核验全通过）。治本：相对任务
  //   目录先于绝对目录回显识别（它是任务原文里的**权威**目标，位于任务开头；
  //   后段的路径回显是运行时产物，优先级更低）。与 extractFrozenInputs 同口径：
  //   命中相对任务目录时，绝对目录回显不再兜底覆盖。
  let targetDir = path.resolve(workspacePath || process.cwd());
  let hasRelTaskDir = false;
  {
    const m = DATA_WORKSPACE_TASK_DIR_RE.exec(text);
    if (m) {
      targetDir = path.resolve(targetDir, m[1]);
      hasRelTaskDir = true;
    }
  }
  if (!hasRelTaskDir) {
    ABS_DIR_RE.lastIndex = 0;
    const dirMatch = ABS_DIR_RE.exec(text);
    if (dirMatch) {
      const candidate = dirMatch[1];
      // 避免把 "/" 或过短根路径当成任务目录
      if (candidate.replace(/[\\/]/g, "").length >= 2) {
        targetDir = path.resolve(candidate);
      }
    }
  }

  // 先收集夹具 basename，供后续排除（如 `fixtures/new.txt` → `new.txt`）
  const fixtureBasenames = new Set<string>();
  // 任务明写「冻结夹具/禁止修改」的输入同样是**输入**：它们常以裸名在
  // 命令行用法里再次出现（`tomlparse.py run config.toml`），同子句又有
  // 「写入 report.json」等交付词 → 会被误当必交产物。冻结声明是更强的
  // 输入信号，优先排除（v28 T1 实证：config.toml 被误登记为交付物）。
  try {
    for (const frozen of extractFrozenInputs(text, workspacePath)) {
      fixtureBasenames.add(path.basename(frozen.path).toLowerCase());
    }
  } catch { /* 冻结输入解析失败不影响交付物抽取 */ }
  /** 通过全部交付物过滤的 token（决定 spec 集合） */
  const occurrences: TokenOccurrence[] = [];
  /** 所有合法文件 token（含未通过交付意图过滤的裸名）——阈值归属用。
   *  真实任务文本的阈值常写在细则行：`3）test_x.py：…至少 8 个断言`，
   *  该行的裸文件名本身不含交付意图词、不进 spec 集合，但阈值必须归到它。 */
  const allOccurrences: TokenOccurrence[] = [];
  FILE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN_RE.exec(text)) !== null) {
    const raw = m[1];
    // URL 判定：整条 token 若携带 URL 特征（被 `://`、主机名段或末尾无路径余量
    // 的嵌套路径前缀），不是交付物。`https://x/y/z.json` 的 `//x/y/z.json` 不含
    // `://`（`https:` 在 token 前置字符里），但 token 本身以 `//` 开头即 URL 子串。
    if (!raw || raw.includes("://")) continue;
    if (/^\/\//.test(raw)) continue; // `//host/path` → 落在 URL 主机名之后
    // 版本号形态（v1.2.3 / 3.1.4）不当作文件
    if (/^v?\d+(?:\.\d+)+$/.test(raw)) continue;
    // token 在原文中的起始位置：m[0] = 前置分隔符 + token（尾部是 lookahead）
    const tokenIndex = m.index + (m[0].length - raw.length);
    // 命令行占位目录（OUTDIR/backup.tar.gz）不是交付物。
    if (hasPlaceholderDir(raw)) continue;
    // ★ 2026-11-23 v29 T3 实证：裸名 + 同句「夹具目录提及 + 交付意图」
    //   （`fixtures/ 下生成 3 个样例文件：leak.txt、clean.txt、encoded.txt`）
    //   ——夹具目录此时是**交付目标**而非任务输入。旧逻辑 afterFixtureMention
    //   一律排除 → 误报缺失 + 无谓续跑。治本：按最近提及重定向到该夹具目录。
    const isBare = !/[\\/]/.test(raw);
    const fixtureRedirectDir = isBare ? fixtureDirNameBefore(text, tokenIndex) : undefined;
    // 夹具目录提及之后的同子句 token 是输入（含子路径 sub/c.txt）。
    if (!fixtureRedirectDir && afterFixtureMention(text, tokenIndex)) {
      fixtureBasenames.add(path.basename(raw).toLowerCase());
      continue;
    }
    // 解析落点（存在性核验与阈值归属共用同一口径）
    const effRaw = fixtureRedirectDir && isBare ? `${fixtureRedirectDir}/${raw}` : raw;
    const normalized = stripWorkspaceDirPrefix(effRaw);
    const resolveBase = normalized.stripped
      ? path.resolve(workspacePath || process.cwd())
      : targetDir;
    const abs = path.isAbsolute(effRaw)
      ? path.normalize(effRaw)
      : path.resolve(resolveBase, normalized.value);
    const occurrence: TokenOccurrence = {
      raw,
      index: tokenIndex,
      end: tokenIndex + raw.length,
      path: abs,
      key: abs.toLowerCase(),
    };
    allOccurrences.push(occurrence);
    if (isBare) {
      if (NON_DELIVERABLE_BARE.has(raw.toLowerCase())) continue;
      if (!clauseHasDeliveryIntent(text, tokenIndex)) continue;
    }
    occurrences.push(occurrence);
    if (FIXTURE_PATH_RE.test(raw)) fixtureBasenames.add(path.basename(raw).toLowerCase());
  }

  // 阈值归属：同一句内最近的前置文件 token（见 attributeThresholds 注释）
  const minBytesByKey = attributeThresholds(text, allOccurrences, MIN_BYTES_RE);
  const minAssertionsByKey = attributeThresholds(text, allOccurrences, MIN_ASSERTIONS_RE);

  const seen = new Set<string>();
  const specs: DeliverableSpec[] = [];
  for (const occ of occurrences) {
    const raw = occ.raw;
    if (FIXTURE_PATH_RE.test(raw)) continue;
    const base = path.basename(raw).toLowerCase();
    // 与夹具同名（任务里以裸名再次出现）也算输入，不是交付物
    if (fixtureBasenames.has(base)) continue;
    const key = occ.key;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec: DeliverableSpec = { raw, path: occ.path };
    const minBytes = minBytesByKey.get(key);
    const minAssertions = minAssertionsByKey.get(key);
    if (minBytes != null) spec.minBytes = minBytes;
    if (minAssertions != null) spec.minAssertions = minAssertions;
    specs.push(spec);
  }

  return specs;
}

/**
 * 返回契约中当前不存在的文件（只做存在性检查，不要求本回合新建）。
 * 传入 exists 以便测试注入；默认用 fs.existsSync。
 */
export function findMissingDeliverables(
  specs: DeliverableSpec[],
  exists: (p: string) => boolean,
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec?.path || seen.has(spec.path)) continue;
    seen.add(spec.path);
    try {
      if (!exists(spec.path)) missing.push(spec.path);
    } catch {
      missing.push(spec.path);
    }
  }
  return missing;
}

// ═══════════════════════════════════════════════════════════
// 验收契约：存在性之外的确定性检查
// ═══════════════════════════════════════════════════════════

/** 验收检查依赖（注入以便单测，不碰真实 fs） */
export interface AcceptanceDeps {
  /** 返回文件字节；不可读返回 null */
  readFile: (p: string) => Buffer | null;
}

export type AcceptanceIssue =
  | { kind: "missing"; raw: string; path: string }
  | { kind: "undersized"; raw: string; path: string; actualBytes: number; minBytes: number }
  | { kind: "under_asserted"; raw: string; path: string; actualAssertions: number; minAssertions: number };

/**
 * 断言行计数：与压测 harness 完全同口径。
 * 只数「断言样式的代码行」，跳过 import/require 行——任务给的「至少 N 个断言」
 * 是验收硬指标，自写测试里注释掉/挪进辅助函数的断言不算数。
 */
const ASSERT_LINE_RE = /\bassert\b|\b(?:expect|check|verify|should|ensure|confirm)\w*\s*\(|\bok\s*\(/;
const ASSERT_SKIP_LINE_RE = /^\s*(?:import\b|(?:const|let|var)\b.*\brequire\s*\()/;

export function countAssertionLines(content: string): number {
  if (!content) return 0;
  let n = 0;
  for (const line of content.split(/\r?\n/)) {
    if (ASSERT_SKIP_LINE_RE.test(line)) continue;
    if (ASSERT_LINE_RE.test(line)) n++;
  }
  return n;
}

/**
 * 对交付物契约做确定性验收。
 *
 * 存在性由 `findMissingDeliverables` 覆盖；这里补两类压测反复出现的漏验：
 *   - **大小下限**（README.md（≥300 字节）写成空壳/一句话）；
 *   - **断言数下限**（任务要求「至少 8 个断言」，自测只写了 2 个）。
 * 不可读文件按缺失处理（fail-closed）。
 */
export function evaluateDeliverables(
  specs: DeliverableSpec[],
  deps: AcceptanceDeps,
): AcceptanceIssue[] {
  const issues: AcceptanceIssue[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec?.path || seen.has(spec.path)) continue;
    seen.add(spec.path);
    let buf: Buffer | null = null;
    try {
      buf = deps.readFile(spec.path);
    } catch {
      buf = null;
    }
    if (buf == null) {
      issues.push({ kind: "missing", raw: spec.raw, path: spec.path });
      continue;
    }
    if (spec.minBytes != null && buf.length < spec.minBytes) {
      issues.push({
        kind: "undersized",
        raw: spec.raw,
        path: spec.path,
        actualBytes: buf.length,
        minBytes: spec.minBytes,
      });
    }
    if (spec.minAssertions != null) {
      const actual = countAssertionLines(buf.toString("utf8"));
      if (actual < spec.minAssertions) {
        issues.push({
          kind: "under_asserted",
          raw: spec.raw,
          path: spec.path,
          actualAssertions: actual,
          minAssertions: spec.minAssertions,
        });
      }
    }
  }
  return issues;
}

// ── 冻结输入保护 ───────────────────────────────────────────────
// 压测里反复出现「任务明写『冻结夹具/禁止修改』，模型仍改夹具让测试变绿」。
// 存在的契约只校验交付物，夹具被改动是完全静默的：测试可能因此假绿。
// 语义对标 hermes kanban 的 artifact preservation：输入在回合开始快照，
// 回合结束比对；被改动则先归档改动版本，再还原原始内容（任务本身已明令禁止修改）。

/** 冻结信号：与文件 token 同句出现时，这些 token 是只读输入 */
const FREEZE_SIGNAL_RE = /冻结夹具|冻结文件|冻结输入|禁止修改|不得修改|不要修改|只读夹具|只读输入|frozen\s+(?:fixture|input|file)|read[- ]only|do\s+not\s+modify/i;

export interface FrozenInputSpec {
  raw: string;
  path: string;
}

/** [parent, child] 包含关系（同一路径或子路径） */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 抽取任务显式「冻结/禁止修改」的输入文件。
 * 只在**冻结信号所在句子**内收集文件 token：任务后半段的交付物清单不会被误登记。
 *
 * ★ 安全边界：只收集落在「工作区」或「任务目标目录」内的文件。
 *   还原逻辑会写回快照内容——若任务里出现「禁止修改 /etc/passwd」这类
 *   系统路径，把它纳入保护会在回合末**写入工作区之外**。单用户本地域
 *   也不该让任务文本决定写盘目标。
 */
export function extractFrozenInputs(
  userMessage: string,
  workspacePath: string,
): FrozenInputSpec[] {
  const text = userMessage || "";
  if (!text || !FREEZE_SIGNAL_RE.test(text)) return [];

  const workspaceRoot = path.resolve(workspacePath || process.cwd());
  let targetDir = workspaceRoot;
  // ★ 2026-11-23 v29 同源修复：与 extractRequiredDeliverables 一致——
  //   仓库相对任务目录 `data/workspace/<段>/` 先识别（权威目标），
  //   绝对目录回显只在无相对任务目录时兜底。
  {
    const relTaskDir = DATA_WORKSPACE_TASK_DIR_RE.exec(text);
    if (relTaskDir) targetDir = path.resolve(workspaceRoot, relTaskDir[1]);
  }
  if (!DATA_WORKSPACE_TASK_DIR_RE.test(text)) {
    ABS_DIR_RE.lastIndex = 0;
    const dirMatch = ABS_DIR_RE.exec(text);
    if (dirMatch) {
      const candidate = dirMatch[1];
      if (candidate.replace(/[\\/]/g, "").length >= 2) targetDir = path.resolve(candidate);
    }
  }
  const withinScope = (p: string) => isWithin(workspaceRoot, p) || isWithin(targetDir, p);

  const specs: FrozenInputSpec[] = [];
  const seen = new Set<string>();
  // 同上：FREEZE_SIGNAL_RE 无 g 标志，必须克隆成全局版本才能遍历全部信号
  const scanSignals = new RegExp(
    FREEZE_SIGNAL_RE.source,
    FREEZE_SIGNAL_RE.flags.includes("g") ? FREEZE_SIGNAL_RE.flags : FREEZE_SIGNAL_RE.flags + "g",
  );
  let sig: RegExpExecArray | null;
  while ((sig = scanSignals.exec(text)) !== null) {
    let start = sig.index;
    while (start > 0 && !isSentenceBoundaryAt(text, start - 1)) start--;
    let end = sig.index;
    while (end < text.length && !isSentenceBoundaryAt(text, end)) end++;
    const sentence = text.slice(start, end);

    const localTokens = new Map<string, FrozenInputSpec>();
    FILE_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FILE_TOKEN_RE.exec(sentence)) !== null) {
      const raw = m[1];
      if (!raw || raw.includes("://") || /^\/\//.test(raw)) continue;
      if (/^v?\d+(?:\.\d+)+$/.test(raw)) continue;
      if (hasPlaceholderDir(raw)) continue;
      if (NON_DELIVERABLE_BARE.has(raw.toLowerCase())) continue;
      const normalized = stripWorkspaceDirPrefix(raw);
      const resolveBase = normalized.stripped
        ? path.resolve(workspacePath || process.cwd())
        : targetDir;
      const abs = path.isAbsolute(raw)
        ? path.normalize(raw)
        : path.resolve(resolveBase, normalized.value);
      // 工作区/任务目录之外的文件不纳入保护（回合末会写回，越界即危险）
      if (!withinScope(abs)) continue;
      const key = abs.toLowerCase();
      if (!localTokens.has(key)) localTokens.set(key, { raw, path: abs });
    }
    for (const [key, spec] of localTokens) {
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push(spec);
    }
  }
  return specs;
}

/** 回合开始时的冻结输入快照 */
export interface FrozenSnapshot {
  raw: string;
  path: string;
  bytes: number;
  hash: string;
  /** 原始内容（仅小文件保留，供被改动后还原） */
  content?: Buffer;
}

/** 可还原上限：超过此大小的冻结文件只做哈希比对，不保留内容 */
const MAX_FROZEN_RESTORE_BYTES = 1_000_000;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 回合开始时快照冻结输入。此刻还不存在的文件不纳入快照（无法保护）；
 * 快照后新增的同名文件也不会被误判为「改动」。
 */
export function snapshotFrozenInputs(
  specs: FrozenInputSpec[],
  readFile: (p: string) => Buffer | null,
): FrozenSnapshot[] {
  const snapshots: FrozenSnapshot[] = [];
  for (const spec of specs) {
    let buf: Buffer | null = null;
    try {
      buf = readFile(spec.path);
    } catch {
      buf = null;
    }
    if (buf == null) continue;
    const snap: FrozenSnapshot = {
      raw: spec.raw,
      path: spec.path,
      bytes: buf.length,
      hash: sha256(buf),
    };
    if (buf.length <= MAX_FROZEN_RESTORE_BYTES) snap.content = buf;
    snapshots.push(snap);
  }
  return snapshots;
}

export interface FrozenMutation {
  raw: string;
  path: string;
  kind: "modified" | "missing";
  snapshot: FrozenSnapshot;
}

/** 回合结束时比对快照：被改动或删除都算违规 */
export function findFrozenMutations(
  snapshots: FrozenSnapshot[],
  readFile: (p: string) => Buffer | null,
): FrozenMutation[] {
  const mutations: FrozenMutation[] = [];
  for (const snap of snapshots) {
    let buf: Buffer | null = null;
    try {
      buf = readFile(snap.path);
    } catch {
      buf = null;
    }
    if (buf == null) {
      mutations.push({ raw: snap.raw, path: snap.path, kind: "missing", snapshot: snap });
      continue;
    }
    if (sha256(buf) !== snap.hash) {
      mutations.push({ raw: snap.raw, path: snap.path, kind: "modified", snapshot: snap });
    }
  }
  return mutations;
}

