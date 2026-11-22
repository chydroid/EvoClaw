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
