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

/** 夹具目录提及（fixtures/ 或 fixture/） */
const FIXTURE_MENTION_RE = /(?:^|[\\/\s])fixtures?[\\/]/gi;

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
function clauseHasDeliveryIntent(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !CLAUSE_BOUNDARY_RE.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !CLAUSE_BOUNDARY_RE.test(text[end])) end++;
  return DELIVERY_TOKEN_RE.test(text.slice(start, end));
}

export interface DeliverableSpec {
  /** 任务文本中的原始 token（用于提示） */
  raw: string;
  /** 解析后的绝对路径 */
  path: string;
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

  // 目标目录：任务文本里第一个绝对目录；否则工作区根
  let targetDir = path.resolve(workspacePath || process.cwd());
  ABS_DIR_RE.lastIndex = 0;
  const dirMatch = ABS_DIR_RE.exec(text);
  if (dirMatch) {
    const candidate = dirMatch[1];
    // 避免把 "/" 或过短根路径当成任务目录
    if (candidate.replace(/[\\/]/g, "").length >= 2) {
      targetDir = path.resolve(candidate);
    }
  }

  // 先收集夹具 basename，供后续排除（如 `fixtures/new.txt` → `new.txt`）
  const fixtureBasenames = new Set<string>();
  const tokens: string[] = [];
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
    // 裸文件名（无路径分隔符）的两道防线：技术名黑名单 + 交付意图子句邻近。
    // 带路径的 token 直接信任（`fixtures/x.json` 另由夹具规则排除）。
    const isBare = !/[\\/]/.test(raw);
    // token 在原文中的起始位置：m[0] = 前置分隔符 + token（尾部是 lookahead）
    const tokenIndex = m.index + (m[0].length - raw.length);
    // 命令行占位目录（OUTDIR/backup.tar.gz）不是交付物。
    if (hasPlaceholderDir(raw)) continue;
    // 夹具目录提及之后的同子句 token 是输入（含子路径 sub/c.txt）。
    if (afterFixtureMention(text, tokenIndex)) {
      fixtureBasenames.add(path.basename(raw).toLowerCase());
      continue;
    }
    if (isBare) {
      if (NON_DELIVERABLE_BARE.has(raw.toLowerCase())) continue;
      if (!clauseHasDeliveryIntent(text, tokenIndex)) continue;
    }
    tokens.push(raw);
    if (FIXTURE_PATH_RE.test(raw)) fixtureBasenames.add(path.basename(raw).toLowerCase());
  }

  const seen = new Set<string>();
  const specs: DeliverableSpec[] = [];
  for (const raw of tokens) {
    if (FIXTURE_PATH_RE.test(raw)) continue;
    const base = path.basename(raw).toLowerCase();
    // 与夹具同名（任务里以裸名再次出现）也算输入，不是交付物
    if (fixtureBasenames.has(base)) continue;

    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(targetDir, raw);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push({ raw, path: abs });
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
