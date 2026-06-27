/**
 * Image Generation Tools — 图片生成工具
 *
 * 支持多种生成方式：
 * 1. Pollinations.ai（免费，无需 API Key）
 * 2. Fal.ai API（需要 API Key）
 * 3. Replicate API（需要 API Key，异步轮询）
 *
 * 配置来源：data/config/image-gen-providers.json
 * 按优先级（order 字段升序）选择第一个 enabled 的提供商
 * 环境变量回退：FAL_KEY、REPLICATE_API_TOKEN（向后兼容）
 */

import * as path from "path";
import * as fs from "fs";
import type { AgentModelExecutor } from "@evoclaw/agent";

/** 图片生成提供商配置（与 protocol-adapter.ts 中结构一致） */
interface ImageGenProvider {
  id: string;
  name: string;
  apiKey: string; // 可能是 ${VAR} 引用或明文
  baseURL: string;
  model: string;
  enabled: boolean;
  order: number;
}

interface ImageGenOptions {
  width?: number;
  height?: number;
  model?: string;
  provider?: string;
}

interface ImageGenResult {
  success: boolean;
  imagePath?: string;
  downloadUrl?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  provider: string;
  model?: string;
  message: string;
}

/** 获取 workspace 路径 */
function getWorkspacePath(): string {
  return process.env.EvoClaw_WORKSPACE || path.resolve(process.cwd(), "data", "workspace");
}

/** 确保目录存在 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 生成唯一文件名 */
function generateFilename(prefix: string, ext: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}.${ext}`;
}

/** 解析 ${VAR} 引用，返回真实环境变量值 */
function resolveEnvVar(value: string): string {
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || "";
  }
  return value;
}

/** 从 data/config/image-gen-providers.json 读取提供商配置 */
function getImageGenProviders(): ImageGenProvider[] {
  const configPath = path.resolve(process.cwd(), "data", "config", "image-gen-providers.json");
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (data.providers && Array.isArray(data.providers)) {
        return data.providers as ImageGenProvider[];
      }
    }
  } catch { /* ignore */ }
  return [];
}

/** 按优先级选择第一个 enabled 且有可用凭证的提供商 */
function getEnabledImageProvider(): { provider: ImageGenProvider; apiKey: string } | null {
  const providers = getImageGenProviders()
    .filter(p => p.enabled)
    .sort((a, b) => a.order - b.order);

  for (const p of providers) {
    const apiKey = resolveEnvVar(p.apiKey || "");
    // pollinations 不需要 API Key
    if (p.id === "pollinations" || apiKey) {
      return { provider: p, apiKey };
    }
  }
  return null;
}

/** 检查是否有任意可用的图片生成方式（含环境变量回退） */
function hasImageGenConfigured(): boolean {
  if (getEnabledImageProvider()) return true;
  // 环境变量回退
  return !!(process.env.FAL_KEY || process.env.REPLICATE_API_TOKEN);
}

/** 保存图片到 workspace/images/ */
function saveImageToWorkspace(buffer: Buffer, prefix: string, ext: string): { filename: string; path: string; size: number } {
  const workspace = getWorkspacePath();
  const imageDir = path.join(workspace, "images");
  ensureDir(imageDir);

  const filename = generateFilename(prefix, ext);
  const outputPath = path.join(imageDir, filename);
  try {
    fs.writeFileSync(outputPath, buffer);
  } catch (err) {
    process.stderr.write('[image-tools] Failed to write file ' + outputPath + ': ' + err + '\n');
    throw new Error('Failed to write output file');
  }

  const stat = fs.statSync(outputPath);
  return { filename, path: outputPath, size: stat.size };
}

/**
 * 通过 Pollinations.ai API 生成图片（免费，无需 API Key）
 * 直接返回图片二进制流
 */
async function generateViaPollinations(
  prompt: string,
  options: ImageGenOptions
): Promise<ImageGenResult> {
  const width = options.width || 1024;
  const height = options.height || 1024;
  const model = options.model || "flux";

  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=${model}&nologo=true`;

  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Pollinations API error: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const saved = saveImageToWorkspace(buffer, "pollinations", "png");

  return {
    success: true,
    imagePath: saved.path,
    downloadUrl: `/api/files/download/images/${saved.filename}`,
    fileSize: saved.size,
    width,
    height,
    provider: "pollinations",
    model,
    message: `图片已生成（Pollinations.ai 免费模式）。下载链接：/api/files/download/images/${saved.filename}`,
  };
}

/**
 * 通过 Fal.ai API 生成图片
 * 返回 JSON { images: [{ url }] }
 */
async function generateViaFal(
  prompt: string,
  options: ImageGenOptions,
  apiKey: string
): Promise<ImageGenResult> {
  const model = options.model || "fal-ai/flux/schnell";
  // 校验 model 名防止 URL 注入：仅允许字母数字/连字符/下划线/斜线
  if (!/^[A-Za-z0-9_\-\/]+$/.test(model)) {
    return { success: false, provider: "fal", message: `Invalid model name: ${model}` };
  }
  const width = options.width || 1024;
  const height = options.height || 1024;

  const body: Record<string, unknown> = {
    prompt,
    image_size: { width, height },
  };

  const response = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const status = response.status;
    const body = await response.text();
    process.stderr.write('[image-tools] API error (status ' + status + '): ' + body + '\n');
    throw new Error('API request failed (status ' + status + ')');
  }

  const data = await response.json() as { images?: Array<{ url?: string }>; error?: string };
  if (data.error) {
    throw new Error(`Fal.ai error: ${data.error}`);
  }

  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("Fal.ai returned no image URL");
  }

  // 下载图片到本地
  const imgResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!imgResponse.ok) {
    throw new Error(`Failed to download image: ${imgResponse.status}`);
  }

  const buffer = Buffer.from(await imgResponse.arrayBuffer());
  const ext = imageUrl.match(/\.(png|jpg|jpeg|webp)(\?|$)/i)?.[1]?.toLowerCase() || "png";
  const saved = saveImageToWorkspace(buffer, "fal_image", ext);

  return {
    success: true,
    imagePath: saved.path,
    downloadUrl: `/api/files/download/images/${saved.filename}`,
    fileSize: saved.size,
    width,
    height,
    provider: "fal",
    model,
    message: `图片已生成（Fal.ai）。下载链接：/api/files/download/images/${saved.filename}`,
  };
}

/**
 * 通过 Replicate API 生成图片（异步轮询）
 */
async function generateViaReplicate(
  prompt: string,
  options: ImageGenOptions,
  apiKey: string
): Promise<ImageGenResult> {
  const model = options.model || "stability-ai/sdxl";
  const width = options.width || 1024;
  const height = options.height || 1024;

  // 创建预测
  const createResponse = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: model,
      input: {
        prompt,
        width,
        height,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!createResponse.ok) {
    const status = createResponse.status;
    const body = await createResponse.text();
    process.stderr.write('[image-tools] API error (status ' + status + '): ' + body + '\n');
    throw new Error('API request failed (status ' + status + ')');
  }

  const prediction = await createResponse.json() as {
    id: string;
    urls: { get: string };
  };

  // 轮询直到完成
  const maxPolls = 120; // 最多等待 10 分钟
  const pollInterval = 5000;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(prediction.urls.get, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60_000),
    });

    if (!statusResponse.ok) continue;

    const status = await statusResponse.json() as {
      status: string;
      output?: string | string[];
      error?: string;
    };

    if (status.status === "succeeded") {
      const outputUrl = Array.isArray(status.output) ? status.output[0] : status.output;
      if (!outputUrl) throw new Error("Replicate returned no output");
      // 下载图片到本地
      const imgResponse = await fetch(outputUrl, { signal: AbortSignal.timeout(60_000) });
      if (!imgResponse.ok) {
        throw new Error(`Failed to download image: ${imgResponse.status}`);
      }
      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      const ext = outputUrl.match(/\.(png|jpg|jpeg|webp)(\?|$)/i)?.[1]?.toLowerCase() || "png";
      const saved = saveImageToWorkspace(buffer, "replicate_image", ext);
      return {
        success: true,
        imagePath: saved.path,
        downloadUrl: `/api/files/download/images/${saved.filename}`,
        fileSize: saved.size,
        width,
        height,
        provider: "replicate",
        model,
        message: `图片已生成（Replicate）。下载链接：/api/files/download/images/${saved.filename}`,
      };
    }

    if (status.status === "failed") {
      throw new Error(`Replicate generation failed: ${status.error || "unknown error"}`);
    }
  }

  throw new Error("Replicate generation timed out (10 minutes)");
}

/**
 * 注册图片生成工具
 */
export function registerImageTools(executor: AgentModelExecutor): void {
  // 工具 1：image_generate — 文本生成图片
  executor.registerTool(
    "image_generate",
    {
      name: "image_generate",
      description:
        "Generate an image from a text description. Supports text-to-image generation. " +
        "Uses Pollinations.ai (free, no API key), Fal.ai (flux/schnell/dev/pro), or Replicate API based on backend config. " +
        "Generated image is saved to workspace and a download URL is returned. " +
        "默认使用 Pollinations.ai 免费模式，无需配置 API Key。",
      parameters: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate. Be specific about style, composition, colors, and mood. 例：'一只橘猫坐在窗台上，阳光洒落，水彩画风格'",
        },
        width: {
          type: "string",
          description: "Image width in pixels (default: 1024). Common: 512, 768, 1024, 1536.",
        },
        height: {
          type: "string",
          description: "Image height in pixels (default: 1024). Common: 512, 768, 1024, 1536.",
        },
        provider: {
          type: "string",
          description: "Image generation provider: 'pollinations' (free, default), 'fal' (Fal.ai), 'replicate'. If not specified, auto-selects based on config priority.",
        },
        model: {
          type: "string",
          description: "Specific model ID. Pollinations: flux, flux-realism, flux-anime, flux-3d, turbo. Fal.ai: fal-ai/flux/schnell, fal-ai/flux/dev, fal-ai/flux-pro. If not specified, uses provider's default.",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const prompt = String(params.prompt || "").trim();
      if (!prompt) {
        return { success: false, error: "prompt is required" };
      }

      const options: ImageGenOptions = {
        width: params.width ? (Number.isFinite(Number(params.width)) ? Number(params.width) : undefined) : undefined,
        height: params.height ? (Number.isFinite(Number(params.height)) ? Number(params.height) : undefined) : undefined,
        provider: String(params.provider || ""),
        model: params.model ? String(params.model) : undefined,
      };

      // 确定提供商：优先使用参数指定的，其次配置文件，最后环境变量回退
      let providerId = options.provider || "";
      let apiKey = "";

      if (!providerId) {
        const enabled = getEnabledImageProvider();
        if (enabled) {
          providerId = enabled.provider.id;
          apiKey = enabled.apiKey;
          // 如果配置中没有指定 model，使用配置中的默认 model
          if (!options.model && enabled.provider.model) {
            options.model = enabled.provider.model;
          }
        } else {
          // 环境变量回退（向后兼容）
          if (process.env.FAL_KEY) {
            providerId = "fal";
            apiKey = process.env.FAL_KEY;
          } else if (process.env.REPLICATE_API_TOKEN) {
            providerId = "replicate";
            apiKey = process.env.REPLICATE_API_TOKEN;
          } else {
            // 没有任何配置，默认使用 pollinations（免费）
            providerId = "pollinations";
          }
        }
      } else {
        // 用户指定了 provider，查找对应的 API Key
        const providers = getImageGenProviders();
        const matched = providers.find(p => p.id === providerId);
        if (matched) {
          apiKey = resolveEnvVar(matched.apiKey || "");
          if (!options.model && matched.model) {
            options.model = matched.model;
          }
        } else {
          // 环境变量回退
          if (providerId === "fal") apiKey = process.env.FAL_KEY || "";
          else if (providerId === "replicate") apiKey = process.env.REPLICATE_API_TOKEN || "";
        }
      }

      try {
        let result: ImageGenResult;

        switch (providerId) {
          case "pollinations":
            result = await generateViaPollinations(prompt, options);
            break;

          case "fal":
            if (!apiKey) {
              return {
                success: false,
                error: "Fal.ai provider selected but no API key is configured. Please configure Fal.ai API key in image-gen settings or use 'pollinations' provider.",
              };
            }
            result = await generateViaFal(prompt, options, apiKey);
            break;

          case "replicate":
            if (!apiKey) {
              return {
                success: false,
                error: "Replicate provider selected but no API key is configured. Please configure Replicate API key in image-gen settings or use 'pollinations' provider.",
              };
            }
            result = await generateViaReplicate(prompt, options, apiKey);
            break;

          default:
            return { success: false, error: `Unknown provider: ${providerId}. Use 'pollinations', 'fal', or 'replicate'.` };
        }

        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // 如果 API 生成失败，尝试回退到免费的 pollinations
        if (providerId !== "pollinations") {
          try {
            const fallback = await generateViaPollinations(prompt, options);
            return {
              ...fallback,
              message: `${fallback.message} (API 生成失败，已回退到 Pollinations 免费模式。错误: ${errorMsg})`,
            };
          } catch {
            // 回退也失败，返回原始错误
          }
        }

        return { success: false, error: errorMsg };
      }
    },
    // checkFn: 至少有一个可用的提供商（pollinations 始终可用）
    () => hasImageGenConfigured() || true
  );

  // 工具 2：image_info — 查询图片生成能力
  executor.registerTool(
    "image_info",
    {
      name: "image_info",
      description:
        "Check available image generation capabilities and providers. Returns configured providers, available models, and whether free Pollinations.ai is available.",
      parameters: {},
    },
    async () => {
      const providers: string[] = [];
      const models: Record<string, string[]> = {};
      const providerDetails: Array<{ id: string; name: string; enabled: boolean; hasApiKey: boolean; model: string }> = [];

      // 从配置文件读取
      const configProviders = getImageGenProviders();
      for (const p of configProviders) {
        const apiKey = resolveEnvVar(p.apiKey || "");
        const hasApiKey = !!(apiKey || p.id === "pollinations");
        providerDetails.push({
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          hasApiKey,
          model: p.model,
        });
        if (p.enabled && (hasApiKey || p.id === "pollinations")) {
          providers.push(p.id);
        }
      }

      // 环境变量回退
      if (process.env.FAL_KEY && !providers.includes("fal")) {
        providers.push("fal");
        providerDetails.push({
          id: "fal",
          name: "Fal.ai (env)",
          enabled: true,
          hasApiKey: true,
          model: "fal-ai/flux/schnell",
        });
      }
      if (process.env.REPLICATE_API_TOKEN && !providers.includes("replicate")) {
        providers.push("replicate");
        providerDetails.push({
          id: "replicate",
          name: "Replicate (env)",
          enabled: true,
          hasApiKey: true,
          model: "stability-ai/sdxl",
        });
      }

      // Pollinations 始终可用（免费）
      if (!providers.includes("pollinations")) {
        providers.push("pollinations");
        providerDetails.push({
          id: "pollinations",
          name: "Pollinations.ai (Free)",
          enabled: true,
          hasApiKey: true,
          model: "flux",
        });
      }

      // 模型列表
      models.pollinations = ["flux", "flux-realism", "flux-anime", "flux-3d", "turbo"];
      models.fal = ["fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro"];
      models.replicate = ["stability-ai/sdxl", "stability-ai/sdxl:latest", "black-forest-labs/flux-schnell"];

      const enabled = getEnabledImageProvider();

      return {
        available: providers.length > 0,
        providers,
        models,
        providerDetails,
        defaultProvider: enabled?.provider.id || providers[0] || "pollinations",
        hasFalKey: !!(process.env.FAL_KEY || configProviders.find(p => p.id === "fal" && resolveEnvVar(p.apiKey))),
        hasReplicateToken: !!(process.env.REPLICATE_API_TOKEN || configProviders.find(p => p.id === "replicate" && resolveEnvVar(p.apiKey))),
        freeProviderAvailable: true, // pollinations 始终可用
      };
    },
    () => true
  );
}
