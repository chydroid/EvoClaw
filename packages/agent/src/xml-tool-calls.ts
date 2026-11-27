/**
 * 非标准 provider 的 XML 工具调用解析。
 *
 * 部分 provider（Mimo / MiniMax 等）不填 `tool_calls` 字段，而是把调用嵌在
 * `content` 里：
 *
 *   <invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>
 *   <minimax:tool_call><function_name>x</function_name><parameters>{…}</parameters></minimax:tool_call>
 *
 * ★ id 必须**全局唯一**（v34 复盘）：OpenAI 协议要求 `tool_call_id` 唯一，
 *   且 `pruneUnpairedToolMessages` 等逻辑按 id 配对 assistant(tool_calls) 与
 *   tool 结果。旧实现每轮从 0 重新编号 → 同一回合内反复出现
 *   `parsed_invoke_0`（v34 T3 r5/7/8/9、T10 r5/9/11 实证），跨轮配对会错位。
 *   因此 id 生成器由调用方注入（回合级单调计数器），本函数不自己编号。
 */

export interface ParsedXmlToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 解析 `<parameter name="p">value</parameter>` 块；值能 JSON 解析就用解析结果。 */
function parseXmlParameters(block: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m: RegExpExecArray | null;
  while ((m = paramRegex.exec(block)) !== null) {
    const trimmed = m[2].trim();
    const parsed = tryJson(trimmed);
    params[m[1]] = parsed === undefined ? trimmed : parsed;
  }
  return params;
}

/**
 * 从 assistant content 里抽出 XML 形式的工具调用。
 * @param nextId 每次调用返回一个新 id；调用方保证跨轮单调。
 */
export function parseXmlToolCalls(
  content: string,
  nextId: (kind: "invoke" | "minimax") => string,
): ParsedXmlToolCall[] {
  if (!content) return [];
  const calls: ParsedXmlToolCall[] = [];

  const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeRegex.exec(content)) !== null) {
    calls.push({
      id: nextId("invoke"),
      type: "function",
      function: {
        name: invokeMatch[1],
        arguments: JSON.stringify(parseXmlParameters(invokeMatch[2])),
      },
    });
  }

  const minimaxRegex = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/g;
  let minimaxMatch: RegExpExecArray | null;
  while ((minimaxMatch = minimaxRegex.exec(content)) !== null) {
    const block = minimaxMatch[1];
    const fnRegex = /<function_name>([^<]+)<\/function_name>\s*<parameters>([\s\S]*?)<\/parameters>/g;
    let fnMatch: RegExpExecArray | null;
    while ((fnMatch = fnRegex.exec(block)) !== null) {
      const paramStr = fnMatch[2].trim();
      const parsed = tryJson(paramStr);
      calls.push({
        id: nextId("minimax"),
        type: "function",
        function: {
          name: fnMatch[1].trim(),
          // 顶层不是合法 JSON 时退回 XML 参数形态（与旧实现一致）
          arguments: JSON.stringify(parsed !== undefined ? parsed : parseXmlParameters(paramStr)),
        },
      });
    }
  }

  return calls;
}
