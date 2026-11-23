/**
 * 工作区路径契约归一化（收尾核验侧）。
 *
 * 工具侧的契约（apps/server/src/tools/file-tools.ts 的 stripWorkspacePrefix）：
 * 相对路径以 workspace 根为基准；模型常把仓库根相对写法 `data/workspace/x`
 * 直接当相对路径传，工具会先剥掉 workspace 前缀再解析。
 *
 * 收尾核验（交付物契约 / 文案声称路径）必须用同一套解析，否则会把
 * `<ws>/data/workspace/x` 当成落点，误报「文件不存在」并触发无谓续跑。
 * v26 smoke 实证：用户原文写 `data/workspace/v26-smoke2/a.txt`，模型照抄
 * （工具正确落到 `<ws>/v26-smoke2/a.txt`），契约核验却拼出双前缀路径，
 * 连续 3 次自动续跑、8 次工具调用才收尾。
 */

import * as path from "node:path";

export interface StrippedWorkspacePath {
  /** 归一化后的路径（已剥掉重复的 data/workspace/ 前缀） */
  value: string;
  /** 是否真的发生了前缀剥离（决定相对路径应以 workspace 根还是任务目录为基准） */
  stripped: boolean;
}

export function stripWorkspaceDirPrefix(p: string): StrippedWorkspacePath {
  let candidate = p.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const prefix = "data/workspace/";
  let stripped = false;
  for (;;) {
    if (!candidate.toLowerCase().startsWith(prefix)) break;
    candidate = candidate.slice(prefix.length);
    stripped = true;
  }
  return { value: candidate, stripped };
}

/**
 * 回执/落点路径归一化（★ 2026-11-23 v29b T3 实证）。
 *
 * 工具回执（createdFiles）存的是**工具侧原始 path**——模型传什么记什么，
 * 常是带 `data/workspace/` 前缀的相对路径；而声称路径
 * （extractClaimedFilePaths）按 workspace 根解析成绝对路径。两侧坐标系
 * 不一致时，回执对账的「同名落点」比较永远失配 → 真实落点对的交付物被
 * 误报为落点漂移（v29b T3：3 次 file_landed_wrong_path 无谓续跑，
 * T3 总 token 408k）。归一到同一坐标系：剥 data/workspace/ 前缀、
 * 相对路径按 baseDir（workspace 根）resolve；绝对路径原样直通。
 */
export function resolveWsReceiptPath(baseDir: string, p: string): string {
  const s = stripWorkspaceDirPrefix(p);
  return path.isAbsolute(s.value) ? s.value : path.resolve(baseDir, s.value);
}
