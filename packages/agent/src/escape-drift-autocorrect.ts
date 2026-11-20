/**
 * EscapeDriftAutocorrect — 匹配前对转义漂移做保守纠正。
 *
 * 对标 hermes `tools/escape_drift_autocorrect.py`（GAP-7/R11-1 接线）。
 * LLM 工具调用经 JSON 序列化后，old_string/new_string 里的引号/反斜杠
 * 常被多转义一层（`\'`、`\"`、`\\` 加倍），精确匹配必然失败。
 *
 * 两级纠正（都必须先对照文件内容证实，证不实就拒绝）：
 * 1. quote 级：`\'`/`\"` 同时出现在 old+new 是 wire artifact 签名。
 *    去 EscapeDrift 后 old_string 必须逐字命中文件才证实；new_string 的
 *    新增代码不在文件里，只在「每种引号要么全转义要么全裸」时同剥；
 *    new_string 转义了 old_string 没有的引号种类 → AmbiguousEscapeDriftError
 *    （无法证明那个转义不是模型故意的）。
 * 2. backslash 级：old_string 全部反斜杠 run 偶数且减半后命中文件、
 *    new_string 无反斜杠 → 剥 old；new_string 含反斜杠 → AmbiguousEscapeDriftError
 *    （故意的双反斜杠与序列化伪影无法区分）。
 *
 * 纠正成功返回 note，调用方必须把它附到工具结果上，让模型知道参数被纠正过。
 */

/** 替换文本的反斜杠意图无法与漂移区分时抛出；调用方必须原样报错、不得再送模糊匹配。 */
export class AmbiguousEscapeDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousEscapeDriftError";
  }
}

/** 反斜杠 run：把每个连续反斜杠段长度减半 */
function halveBackslashRuns(s: string): string {
  return s.replace(/\\+/g, (m) => "\\".repeat(Math.floor(m.length / 2)));
}

/** 所有反斜杠 run 长度均为偶数 */
function allBackslashRunsEven(s: string): boolean {
  const runs = s.match(/\\+/g);
  return !runs || runs.every((r) => r.length % 2 === 0);
}

/**
 * backslash 级：仅当 old_string 全部 run 偶数且减半后命中文件、且 new_string
 * 无反斜杠时，减半 old_string 返回。new_string 含反斜杠 → AmbiguousEscapeDriftError。
 */
function maybeCorrectBackslashDoubling(
  oldString: string,
  newString: string,
  content: string,
): { old: string; new: string } {
  if (!oldString.includes("\\") || content.includes(oldString)) {
    return { old: oldString, new: newString };
  }
  if (!allBackslashRunsEven(oldString)) {
    return { old: oldString, new: newString };
  }
  const halved = halveBackslashRuns(oldString);
  if (!content.includes(halved)) {
    return { old: oldString, new: newString };
  }
  if (newString.includes("\\")) {
    throw new AmbiguousEscapeDriftError(
      "Escape-drift detected: halving old_string's backslashes matches the file, " +
      "but correcting new_string could remove intentional backslashes. " +
      "Re-read the file and resend old_string/new_string with their intended escaping.",
    );
  }
  return { old: halved, new: newString };
}

/** 去掉引号前单个伪影反斜杠：\\' → ' 、\\" → " */
function stripSpuriousQuoteEscapes(s: string): string {
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

/**
 * True 当 strings 里每个被转义的引号都恰好是「单反斜杠 + 引号」形态。
 * wire artifact 机械化转义：被它碰过的引号种类在全部字符串里**每一处**出现
 * 都恰好带一个反斜杠。裸引号挨着 \\q（该种类没漂移，\\q 是真的）或更长的
 * run（故意的转义）都无法与伪影区分 → 拒绝纠正。
 */
function quoteEscapesAllSpurious(...strings: string[]): boolean {
  for (const q of ["'", '"'] as const) {
    const esc = "\\" + q;
    if (!strings.some((s) => s.includes(esc))) continue;
    // 每一处引号出现（含裸引号）的前缀反斜杠 run 必须恰好为 1；
    // 裸引号（run=0）或更长 run 都说明该种类未被漂移污染 → 拒绝纠正
    const pattern = q === "'" ? /(\\*)'/g : /(\\*)"/g;
    for (const s of strings) {
      for (const m of s.matchAll(pattern)) {
        if (m[1].length !== 1) return false;
      }
    }
  }
  return true;
}

/**
 * quote 级：`\\'` 或 `\\"` 同时出现在 old+new 是漂移签名。strip 后 old_string
 * 必须逐字命中文件；new_string 仅在 quoteEscapesAllSpurious 成立时同剥；
 * new_string 转义了 old_string 没有的引号种类 → AmbiguousEscapeDriftError。
 */
function maybeCorrectQuoteEscaping(
  oldString: string,
  newString: string,
  content: string,
): { old: string; new: string } {
  const hasQuoteSuspect =
    (oldString.includes("\\'") && newString.includes("\\'")) ||
    (oldString.includes('\\"') && newString.includes('\\"'));
  if (!hasQuoteSuspect || content.includes(oldString)) {
    return { old: oldString, new: newString };
  }
  if (!quoteEscapesAllSpurious(oldString, newString)) {
    return { old: oldString, new: newString };
  }
  const strippedOld = stripSpuriousQuoteEscapes(oldString);
  if (!content.includes(strippedOld)) {
    return { old: oldString, new: newString };
  }
  // 只有 old_string 对照过文件，只有它转义的引号种类被证实为漂移。
  // 仅 new_string 转义的种类可能是模型故意的 → 明确报错而非猜。
  const unproven = (["'", '"'] as const).filter(
    (q) => newString.includes("\\" + q) && !oldString.includes("\\" + q),
  );
  if (unproven.length > 0) {
    const shown = unproven.map((q) => "\\" + q).join(" and ");
    throw new AmbiguousEscapeDriftError(
      "Escape-drift detected: removing the spurious quote escapes in old_string matches " +
      `the file, but new_string also contains ${shown}, which old_string gives no evidence ` +
      "for. Re-read the file and resend old_string/new_string with their intended escaping.",
    );
  }
  return { old: strippedOld, new: stripSpuriousQuoteEscapes(newString) };
}

export interface EscapeDriftCorrection {
  /** 纠正后的 old_string（未纠正时与输入相同） */
  old: string;
  /** 纠正后的 new_string（未纠正时与输入相同） */
  new: string;
  /** 纠正说明；未纠正时为 null。调用方须附到成功结果上 */
  note: string | null;
}

/**
 * 主入口：依次尝试 quote 级、backslash 级纠正，命中即返回 note。
 * AmbiguousEscapeDriftError 直接向上抛，调用方必须报错、不得送模糊匹配。
 */
export function maybeCorrectEscapeDrift(
  oldString: string,
  newString: string,
  content: string,
): EscapeDriftCorrection {
  const quote = maybeCorrectQuoteEscaping(oldString, newString, content);
  if (quote.old !== oldString) {
    return {
      old: quote.old,
      new: quote.new,
      note:
        "escape-drift auto-corrected: stripped a spurious backslash before a quote/apostrophe " +
        "in old_string/new_string (a JSON-double-escaping wire artifact) before matching.",
    };
  }
  const backslash = maybeCorrectBackslashDoubling(oldString, newString, content);
  if (backslash.old !== oldString) {
    return {
      old: backslash.old,
      new: backslash.new,
      note:
        "escape-drift auto-corrected: halved doubled backslash runs in old_string " +
        "before matching; new_string has no backslashes and was left unchanged.",
    };
  }
  return { old: oldString, new: newString, note: null };
}
