import type { AgentModelExecutor } from "@evoclaw/agent";
import { clarifyTool, getClarifyGateway, type ClarifyCallback } from "@evoclaw/agent";

/**
 * Clarify Tools — 交互式澄清问题复合工具
 *
 * 对标 Hermes `tools/clarify_tool.py` + `clarify_gateway.py`：
 *   - 让 Agent 在需要用户澄清、反馈或决策时提出结构化问题
 *   - 支持多选（最多 4 项）和开放式问答两种模式
 *
 * 此前 clarify-tool.ts 的 schema/dispatcher/gateway 均已实现但零活调用点
 * （死代码），现接入工具面 + channel 消息处理器。
 */

/**
 * 格式化澄清问题为可发送给用户的文本（choices 渲染为编号列表）。
 */
function formatClarifyPrompt(question: string, choices: string[] | null): string {
  if (!choices || choices.length === 0) {
    return question;
  }
  let text = question + "\n";
  choices.forEach((c, i) => {
    text += `${i + 1}. ${c}\n`;
  });
  text += `\n（回复序号或直接输入答案）`;
  return text;
}

/**
 * 通过 channel manager 发送消息到用户。
 */
async function sendToChannel(
  executor: AgentModelExecutor,
  channel: string,
  to: string,
  text: string,
): Promise<void> {
  try {
    const registry = (executor as any).registry;
    if (!registry) return;
    const channelManager = registry.resolveService("channelManager");
    if (!channelManager?.sendMessage) return;
    await channelManager.sendMessage(channel, to, text);
  } catch {
    // best-effort — send failure should not break the clarify flow
  }
}

/**
 * 从 session key 解析 channel 和 peer ID。
 * session key 格式: `${channel}-${from}`（如 `feishu-user123`）。
 */
function parseSessionKey(sessionKey: string): { channel: string; peerId: string } | null {
  const idx = sessionKey.indexOf("-");
  if (idx <= 0) return null;
  return { channel: sessionKey.slice(0, idx), peerId: sessionKey.slice(idx + 1) };
}

/**
 * 注册 clarify 工具。
 *
 * 回调通过 ClarifyGateway 阻塞等待用户响应：
 *   1. register 创建 pending entry + response promise
 *   2. notify callback 通过 channel manager 发送问题到用户
 *   3. channel 消息处理器在收到回复时调用 resolveGatewayClarify
 *   4. response promise 解析，工具返回用户答案
 */
export function registerClarifyTools(executor: AgentModelExecutor): void {
  const gateway = getClarifyGateway();

  // 注册 notify callback：新 clarify entry 注册时发送问题到用户
  const sessionKey = executor.currentSessionId ?? "default";
  const sessionParts = parseSessionKey(sessionKey);

  if (sessionParts) {
    gateway.registerNotify(sessionKey, (entry) => {
      const prompt = formatClarifyPrompt(entry.question, entry.choices);
      void sendToChannel(executor, sessionParts.channel, sessionParts.peerId, prompt);
    });
  }

  // 构造 ClarifyCallback：通过 gateway 阻塞等待用户响应
  const callback: ClarifyCallback = async (question, choices) => {
    const sk = executor.currentSessionId ?? sessionKey;
    const { entry, response } = gateway.register({
      sessionKey: sk,
      question,
      choices,
    });

    // notify callback 会发送问题到用户（如果已注册）
    const notifyCb = gateway.getNotify(sk);
    if (notifyCb) {
      notifyCb(entry);
    }

    const userResponse = await response;
    if (userResponse === null) {
      return "(用户未响应，已超时)";
    }
    return userResponse;
  };

  executor.registerTool(
    "clarify",
    {
      name: "clarify",
      description:
        "Ask the user a question when you need clarification, feedback, or a " +
        "decision before proceeding. Supports two modes:\n\n" +
        "1. **Multiple choice** — provide up to 4 choices. The user picks one " +
        "or types their own answer via a 5th 'Other' option.\n" +
        "2. **Open-ended** — omit choices entirely. The user types a free-form " +
        "response.\n\n" +
        "CRITICAL: when you are offering options, put each option ONLY in the " +
        "`choices` array — NEVER enumerate the options inside the `question` " +
        "text. The UI renders `choices` as selectable rows; options written " +
        "into the question string render as dead prose the user can't pick.",
      parameters: {
        question: {
          type: "string",
          description:
            "The question itself, and ONLY the question (e.g. 'Which " +
            "deployment target?'). Do NOT embed the answer options here " +
            "— pass them as separate elements in `choices`.",
          required: true,
        },
        choices: {
          type: "string",
          description:
            "Comma-separated choices (up to 4). Omit for open-ended questions. " +
            "The user picks by number or types their own answer.",
          required: false,
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const question = String(params.question || "").trim();
      if (!question) {
        return JSON.stringify({ error: "Question text is required." });
      }

      // 解析 choices（逗号分隔的字符串 → 数组）
      let choices: string[] | null = null;
      const rawChoices = params.choices;
      if (rawChoices !== undefined && rawChoices !== null && String(rawChoices).trim() !== "") {
        choices = String(rawChoices)
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
          .slice(0, 4);
        if (choices.length === 0) choices = null;
      }

      const result = await clarifyTool({ question, choices, callback });
      return JSON.stringify(result);
    },
  );
}
