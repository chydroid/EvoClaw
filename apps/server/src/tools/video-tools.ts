/**
 * Video Generation Tools — 视频生成工具
 *
 * 支持多种生成方式：
 * 1. Fal.ai API（支持 Wan 2.2、Kling、LTX 等开源模型）
 * 2. Replicate API（支持多种视频生成模型）
 * 3. FFmpeg 本地生成（文本幻灯片视频，无需 API key）
 *
 * 环境变量配置：
 * - FAL_KEY: Fal.ai API 密钥
 * - REPLICATE_API_TOKEN: Replicate API 密钥
 * - VIDEO_DEFAULT_PROVIDER: 默认提供商（fal / replicate / local）
 * - VIDEO_DEFAULT_MODEL: 默认模型 ID
 */

import * as path from "path";
import * as fs from "fs";
import { execSync, spawn } from "child_process";
import type { AgentModelExecutor } from "@evoclaw/agent";

/** 检查 FFmpeg 是否可用 */
function isFfmpegAvailable(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 检查是否有可用的视频生成 API */
function hasVideoApiConfigured(): boolean {
  return !!(process.env.FAL_KEY || process.env.REPLICATE_API_TOKEN);
}

/** 检查视频生成工具是否可用 */
function isVideoGenerationAvailable(): boolean {
  return hasVideoApiConfigured() || isFfmpegAvailable();
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

/**
 * 通过 Fal.ai API 生成视频
 * 支持 Wan 2.2、Kling、LTX 等模型
 */
async function generateViaFal(
  prompt: string,
  options: VideoGenOptions
): Promise<VideoGenResult> {
  const apiKey = process.env.FAL_KEY!;
  const model = options.model || "fal-ai/wan/v2.2/text-to-video";

  const body: Record<string, unknown> = {
    prompt,
    duration: options.duration || 5,
    aspect_ratio: options.aspectRatio || "16:9",
  };

  if (options.imageUrl) {
    body.image_url = options.imageUrl;
  }

  const response = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Fal.ai API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as { video?: { url?: string }; error?: string };
  if (data.error) {
    throw new Error(`Fal.ai error: ${data.error}`);
  }

  const videoUrl = data.video?.url;
  if (!videoUrl) {
    throw new Error("Fal.ai returned no video URL");
  }

  // 下载视频到本地
  return downloadVideoToWorkspace(videoUrl, "fal_video");
}

/**
 * 通过 Replicate API 生成视频
 */
async function generateViaReplicate(
  prompt: string,
  options: VideoGenOptions
): Promise<VideoGenResult> {
  const apiKey = process.env.REPLICATE_API_TOKEN!;
  const model = options.model || "lightricks/ltx-video:13b9a58e6e6f6a5c92f5d6e7e1c5e5e5e5e5e5e5";

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
        duration: options.duration || 5,
        aspect_ratio: options.aspectRatio || "16:9",
        ...(options.imageUrl ? { image: options.imageUrl } : {}),
      },
    }),
  });

  if (!createResponse.ok) {
    const errText = await createResponse.text();
    throw new Error(`Replicate API error ${createResponse.status}: ${errText}`);
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
      return downloadVideoToWorkspace(outputUrl, "replicate_video");
    }

    if (status.status === "failed") {
      throw new Error(`Replicate generation failed: ${status.error || "unknown error"}`);
    }
  }

  throw new Error("Replicate generation timed out (10 minutes)");
}

/**
 * 使用 FFmpeg 本地生成文本幻灯片视频
 * 无需 API key，适合简单场景
 */
async function generateLocalSlideshow(
  prompt: string,
  options: VideoGenOptions
): Promise<VideoGenResult> {
  const workspace = getWorkspacePath();
  const videoDir = path.join(workspace, "videos");
  ensureDir(videoDir);

  const filename = generateFilename("local_video", "mp4");
  const outputPath = path.join(videoDir, filename);
  const duration = options.duration || 5;
  const width = 1280;
  const height = options.aspectRatio === "9:16" ? 1280 : 720;
  const actualWidth = options.aspectRatio === "9:16" ? 720 : 1280;

  // 将 prompt 分割为多行（每 30 字符一行）
  const lines: string[] = [];
  const words = prompt.split("");
  let currentLine = "";
  for (const char of words) {
    currentLine += char;
    if (currentLine.length >= 30) {
      lines.push(currentLine);
      currentLine = "";
    }
  }
  if (currentLine) lines.push(currentLine);

  // 生成 FFmpeg 滤镜
  const escapedPrompt = prompt.replace(/'/g, "\\'").replace(/:/g, "\\:");
  const textLines = lines.map((line, i) => {
    const escaped = line.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const y = 360 + i * 40 - (lines.length * 20);
    return `drawtext=text='${escaped}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=${y}:fontfile='C\\:/Windows/Fonts/arial.ttf'`;
  }).join(",");

  const filter = `${textLines},format=yuv420p`;

  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-f", "lavfi",
      "-i", `color=c=0x1a1a2e:s=${actualWidth}x${height}:d=${duration}:r=24`,
      "-vf", filter,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y",
      outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: "pipe" });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        const stat = fs.statSync(outputPath);
        resolve({
          success: true,
          videoPath: outputPath,
          downloadUrl: `/api/files/download/videos/${filename}`,
          fileSize: stat.size,
          duration,
          provider: "local",
          message: `视频已生成（本地 FFmpeg 幻灯片模式）。下载链接：/api/files/download/videos/${filename}`,
        });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/** 下载视频到 workspace */
async function downloadVideoToWorkspace(url: string, prefix: string): Promise<VideoGenResult> {
  const workspace = getWorkspacePath();
  const videoDir = path.join(workspace, "videos");
  ensureDir(videoDir);

  const filename = generateFilename(prefix, "mp4");
  const outputPath = path.join(videoDir, filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  const stat = fs.statSync(outputPath);
  return {
    success: true,
    videoPath: outputPath,
    downloadUrl: `/api/files/download/videos/${filename}`,
    fileSize: stat.size,
    provider: prefix.includes("fal") ? "fal" : "replicate",
    message: `视频已生成。下载链接：/api/files/download/videos/${filename}`,
  };
}

interface VideoGenOptions {
  duration?: number;
  aspectRatio?: string;
  provider?: string;
  model?: string;
  imageUrl?: string;
}

interface VideoGenResult {
  success: boolean;
  videoPath: string;
  downloadUrl: string;
  fileSize: number;
  duration?: number;
  provider: string;
  message: string;
}

/**
 * 注册视频生成工具
 */
export function registerVideoTools(executor: AgentModelExecutor): void {
  // 工具 1：video_generate — 文本生成视频
  executor.registerTool(
    "video_generate",
    {
      name: "video_generate",
      description:
        "Generate a short video from a text description. Supports text-to-video and image-to-video. " +
        "Uses Fal.ai (Wan 2.2, Kling, LTX) or Replicate API if configured, otherwise falls back to local FFmpeg slideshow. " +
        "Generated video is saved to workspace and a download URL is returned. " +
        "环境变量 FAL_KEY 或 REPLICATE_API_TOKEN 配置后可使用高质量 AI 生成。",
      parameters: {
        prompt: {
          type: "string",
          description: "Detailed description of the video to generate. Be specific about scenes, camera movements, style, and mood. 例：'一只猫在阳光下打盹，镜头缓慢推进，温暖色调'",
        },
        duration: {
          type: "string",
          description: "Video duration in seconds (default: 5, range: 3-15)",
        },
        aspect_ratio: {
          type: "string",
          description: "Aspect ratio: '16:9' (landscape, default), '9:16' (portrait), '1:1' (square)",
        },
        provider: {
          type: "string",
          description: "Video generation provider: 'fal' (Fal.ai), 'replicate', 'local' (FFmpeg slideshow). If not specified, auto-selects based on available API keys.",
        },
        model: {
          type: "string",
          description: "Specific model ID (e.g., 'fal-ai/wan/v2.2/text-to-video'). If not specified, uses provider's default.",
        },
        image_url: {
          type: "string",
          description: "Optional image URL for image-to-video generation. If provided, the video will animate from this image.",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const prompt = String(params.prompt || "").trim();
      if (!prompt) {
        return { success: false, error: "prompt is required" };
      }

      const options: VideoGenOptions = {
        duration: params.duration ? Number(params.duration) : undefined,
        aspectRatio: String(params.aspect_ratio || "16:9"),
        provider: String(params.provider || ""),
        model: params.model ? String(params.model) : undefined,
        imageUrl: params.image_url ? String(params.image_url) : undefined,
      };

      // 确定提供商
      let provider = options.provider || process.env.VIDEO_DEFAULT_PROVIDER || "";
      if (!provider) {
        if (process.env.FAL_KEY) {
          provider = "fal";
        } else if (process.env.REPLICATE_API_TOKEN) {
          provider = "replicate";
        } else {
          provider = "local";
        }
      }

      try {
        let result: VideoGenResult;

        switch (provider) {
          case "fal":
            if (!process.env.FAL_KEY) {
              return {
                success: false,
                error: "Fal.ai provider selected but FAL_KEY is not set. Please configure FAL_KEY environment variable or use 'local' provider.",
              };
            }
            result = await generateViaFal(prompt, options);
            break;

          case "replicate":
            if (!process.env.REPLICATE_API_TOKEN) {
              return {
                success: false,
                error: "Replicate provider selected but REPLICATE_API_TOKEN is not set. Please configure REPLICATE_API_TOKEN environment variable or use 'local' provider.",
              };
            }
            result = await generateViaReplicate(prompt, options);
            break;

          case "local":
            if (!isFfmpegAvailable()) {
              return {
                success: false,
                error: "Local provider requires FFmpeg. Please install FFmpeg or configure FAL_KEY/REPLICATE_API_TOKEN for AI-powered generation.",
              };
            }
            result = await generateLocalSlideshow(prompt, options);
            break;

          default:
            return { success: false, error: `Unknown provider: ${provider}. Use 'fal', 'replicate', or 'local'.` };
        }

        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // 如果 API 生成失败，尝试回退到本地
        if (provider !== "local" && isFfmpegAvailable()) {
          try {
            const fallback = await generateLocalSlideshow(prompt, options);
            return {
              ...fallback,
              message: `${fallback.message} (API 生成失败，已回退到本地模式。错误: ${errorMsg})`,
            };
          } catch {
            // 本地也失败，返回原始错误
          }
        }

        return { success: false, error: errorMsg };
      }
    },
    // checkFn: 至少有一种生成方式可用
    () => isVideoGenerationAvailable()
  );

  // 工具 2：video_info — 查询视频生成能力
  executor.registerTool(
    "video_info",
    {
      name: "video_info",
      description:
        "Check available video generation capabilities and providers. Returns configured providers, available models, and whether local FFmpeg generation is available.",
      parameters: {},
    },
    async () => {
      const providers: string[] = [];
      const models: Record<string, string[]> = {};

      if (process.env.FAL_KEY) {
        providers.push("fal");
        models.fal = [
          "fal-ai/wan/v2.2/text-to-video",
          "fal-ai/wan/v2.2/image-to-video",
          "fal-ai/kling/v1.6/standard/text-to-video",
          "fal-ai/kling/v1.6/standard/image-to-video",
          "fal-ai/ltx-video",
        ];
      }

      if (process.env.REPLICATE_API_TOKEN) {
        providers.push("replicate");
        models.replicate = [
          "lightricks/ltx-video",
          "cuuupid/cogvideox-5b",
          "minimax/video-01",
        ];
      }

      if (isFfmpegAvailable()) {
        providers.push("local");
        models.local = ["ffmpeg-slideshow (text overlay on solid background)"];
      }

      return {
        available: providers.length > 0,
        providers,
        models,
        defaultProvider: process.env.VIDEO_DEFAULT_PROVIDER || providers[0] || "none",
        ffmpegAvailable: isFfmpegAvailable(),
        hasFalKey: !!process.env.FAL_KEY,
        hasReplicateToken: !!process.env.REPLICATE_API_TOKEN,
      };
    },
    () => true
  );
}
