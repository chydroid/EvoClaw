import type { PersonaConfig } from "@evoclaw/core";
import type { ProviderConfig } from "./types";
import { nativeFetch } from "./llm-caller";

export interface BriefUnderstandingDeps {
  providers: ProviderConfig[];
  persona: PersonaConfig;
  recordProviderSuccess: (id: string) => void;
  recordProviderFailure: (id: string, error: string, errorType?: string) => void;
}

export async function generateBriefUnderstanding(deps: BriefUnderstandingDeps, userMessage: string): Promise<string> {
  const enabledProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
  if (enabledProviders.length === 0) return "";

  const provider = enabledProviders[0];
  const personaName = deps.persona.name || "助手";
  const masterTerm = deps.persona.masterTerm || "用户";

  const systemPrompt = `你是${personaName}，一个智能助手。用户（${masterTerm}）发来了一条消息，请你：
1. 用一句话简短确认你理解了用户的需求
2. 用1-2句话说明你接下来打算怎么完成这个任务

要求：
- 语气亲切自然，像在跟${masterTerm}对话
- 不要使用引号或代码块
- 总字数控制在60字以内
- 格式：理解确认 + 换行 + 执行计划
- 示例：收到，我来帮您了解小米MiMo模型的情况。\n我将搜索MiMo的最新信息，包括模型能力、评测结果和发布动态。`;

  const baseURL = provider.baseURL || "";
  let apiURL = baseURL;
  if (!apiURL.endsWith("/chat/completions") && !apiURL.endsWith("/v1/chat/completions")) {
    apiURL = apiURL.replace(/\/+$/, "");
    if (!apiURL.endsWith("/v1")) {
      apiURL = `${apiURL}/v1`;
    }
    apiURL = `${apiURL}/chat/completions`;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      if (provider.provider === "anthropic") {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }
    }

    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await nativeFetch(apiURL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 200,
        temperature: 0.5,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      deps.recordProviderFailure(provider.id, `HTTP ${response.status}`, "http_error");
      return "";
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (content) {
      deps.recordProviderSuccess(provider.id);
    }
    return content || "";
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.recordProviderFailure(provider.id, errMsg, "network_error");
    return "";
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
