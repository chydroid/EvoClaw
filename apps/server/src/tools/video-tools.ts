/**
 * Video Generation Tools — 视频生成工具
 *
 * 支持多种生成方式：
 * 1. Fal.ai API（支持 Wan 2.2、Kling、LTX 等开源模型）
 * 2. Replicate API（支持多种视频生成模型）
 * 3. FFmpeg 本地生成（文本幻灯片视频，无需 API key）
 *
 * 配置来源（优先级）：
 * 1. data/config/video-gen-providers.json — 后端配置文件（推荐）
 * 2. 环境变量回退（向后兼容）：
 *    - FAL_KEY: Fal.ai API 密钥
 *    - REPLICATE_API_TOKEN: Replicate API 密钥
 *    - VIDEO_DEFAULT_PROVIDER: 默认提供商（fal / replicate / local）
 *    - VIDEO_DEFAULT_MODEL: 默认模型 ID
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { execFileSync, spawn } from "child_process";
import { atomicWriteFileSync } from "@evoclaw/core";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry } from "@evoclaw/core";
import { generateVideoDownloadScript } from "@evoclaw/infrastructure";
import { validateDownloadUrl } from "./image-tools";
// video_download 合并进本文件的 video 复合工具；其脚本执行辅助函数复用 shell-media-tools 的实现
import { findPythonPaths, runPythonScriptAsync } from "./shell-media-tools";

/** 视频生成提供商配置（与 protocol-adapter.ts 中结构一致） */
interface VideoGenProvider {
  id: string;
  name: string;
  apiKey: string; // 可能是 ${VAR} 引用或明文
  baseURL: string;
  model: string;
  enabled: boolean;
  order: number;
}

/** 解析 ${VAR} 引用，返回真实环境变量值 */
function resolveEnvVar(value: string): string {
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || "";
  }
  return value;
}

/** 从 data/config/video-gen-providers.json 读取提供商配置 */
function getVideoGenProviders(): VideoGenProvider[] {
  const configPath = path.resolve(process.cwd(), "data", "config", "video-gen-providers.json");
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (data.providers && Array.isArray(data.providers)) {
        return data.providers as VideoGenProvider[];
      }
    }
  } catch { /* ignore */ }
  return [];
}

/** 按优先级选择第一个 enabled 且有可用凭证的提供商 */
function getEnabledVideoProvider(): { provider: VideoGenProvider; apiKey: string } | null {
  const providers = getVideoGenProviders()
    .filter(p => p.enabled)
    .sort((a, b) => a.order - b.order);

  for (const p of providers) {
    const apiKey = resolveEnvVar(p.apiKey || "");
    // local 提供商不需要 API Key
    if (p.id === "local" || apiKey) {
      return { provider: p, apiKey };
    }
  }
  return null;
}

/** FFmpeg 可用性缓存：首次调用后缓存结果，避免每次调用都 execFileSync 阻塞事件循环 */
let ffmpegAvailable: boolean | null = null;

/** 检查 FFmpeg 是否可用 */
function isFfmpegAvailable(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/** 检查是否有可用的视频生成 API（配置文件或环境变量） */
function hasVideoApiConfigured(): boolean {
  if (getEnabledVideoProvider()) return true;
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
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}_${ts}_${rand}.${ext}`;
}

/**
 * 通过 Fal.ai API 生成视频
 * 支持 Wan 2.2、Kling、LTX 等模型
 */
async function generateViaFal(
  prompt: string,
  options: VideoGenOptions,
  apiKey: string
): Promise<VideoGenResult> {
  const model = options.model || "fal-ai/wan/v2.2/text-to-video";
  // 校验 model 名防止 URL 注入：仅允许字母数字/连字符/下划线/斜线
  if (!/^[A-Za-z0-9_\-\/]+$/.test(model)) {
    return { success: false, provider: "fal", videoPath: "", downloadUrl: "", fileSize: 0, message: `Invalid model name: ${model}` };
  }

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
    signal: AbortSignal.timeout(120_000),
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
  options: VideoGenOptions,
  apiKey: string
): Promise<VideoGenResult> {
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
    signal: AbortSignal.timeout(60_000),
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
  // 跨平台字体选择：避免在非 Windows 上硬编码 Windows 字体路径导致 FFmpeg drawtext 失败
  const fontPath = process.platform === "win32"
    ? "C\\:/Windows/Fonts/arial.ttf"
    : process.platform === "darwin"
    ? "/Library/Fonts/Arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const textLines = lines.map((line, i) => {
    const escaped = line.replace(/[':,\\;%'\\]/g, (m) => `\\${m}`);
    const y = 360 + i * 40 - (lines.length * 20);
    return `drawtext=text='${escaped}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=${y}:fontfile='${fontPath}'`;
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

    // stdout 设为 ignore 避免管道缓冲区填满导致背压死锁；仅采集 stderr
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // 60s 超时：先 SIGTERM，2s 后仍未退出则 SIGKILL
    let killed = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const killTimer = setTimeout(() => {
      killed = true;
      try { ffmpeg.kill("SIGTERM"); } catch { /* ignore */ }
      forceTimer = setTimeout(() => {
        try { ffmpeg.kill("SIGKILL"); } catch { /* ignore */ }
      }, 2000);
      forceTimer.unref?.();
    }, 60_000);
    killTimer.unref?.();

    ffmpeg.on("close", (code) => {
      clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (killed) {
        reject(new Error("FFmpeg timed out after 60s"));
        return;
      }
      if (code === 0) {
        try {
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
        } catch (statErr) {
          reject(new Error(`FFmpeg succeeded but output file missing: ${statErr instanceof Error ? statErr.message : String(statErr)}`));
        }
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
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

  // SSRF 防护：下载前校验 URL，拒绝内网/回环/链路本地地址
  validateDownloadUrl(url);

  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  atomicWriteFileSync(outputPath, buffer);

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
export function registerVideoTools(
  executor: AgentModelExecutor,
  registry?: ServiceRegistry
): void {
  // ── video：复合视频工具（action 判别）──
  // 合并自原 video_generate（生成视频）、video_info（查询生成能力）与 video_download
  // （下载视频，实现原样从 shell-media-tools.ts 搬来）：一个工具 + action 字段，
  // 保持 schema 紧凑、降低每轮 token 成本。

  // SSRF 防护：与原 shell-media-tools 的 checkSsrf 同名同语义（阻止访问内网/元数据端点）。
  // 区别：本文件可能拿不到 registry（registerVideoTools 的 registry 为可选参数），
  // 服务未注入时退化为 image-tools 的本地 URL 校验（仍拦截内网/回环/链路本地），
  // 避免 video action=download 因未传 registry 而完全不可用。
  const checkSsrf = async (url: string): Promise<string | null> => {
    const ssrfProtection = registry?.resolveService<{ checkURL(url: string): Promise<{ allowed: boolean; reason?: string }> }>("ssrfProtection");
    if (!ssrfProtection) {
      try {
        validateDownloadUrl(url);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    try {
      const result = await ssrfProtection.checkURL(url);
      if (!result.allowed) return result.reason ?? "blocked by SSRF policy";
      return null;
    } catch {
      return "SSRF check failed";
    }
  };

  /** 原 video_generate */
  const handleVideoGenerate = async (params: Record<string, unknown>) => {
    const prompt = String(params.prompt || "").trim();
    if (!prompt) {
      return { success: false, error: "prompt is required" };
    }

    const options: VideoGenOptions = {
      duration: params.duration ? (Number.isFinite(Number(params.duration)) ? Number(params.duration) : undefined) : undefined,
      aspectRatio: String(params.aspect_ratio || "16:9"),
      provider: String(params.provider || ""),
      model: params.model ? String(params.model) : undefined,
      imageUrl: params.image_url ? String(params.image_url) : undefined,
    };

    // 确定提供商：优先使用参数指定的，其次配置文件，最后环境变量回退
    let provider = options.provider || "";
    let apiKey = "";

    if (!provider) {
      // 1. 尝试从配置文件读取
      const enabled = getEnabledVideoProvider();
      if (enabled) {
        provider = enabled.provider.id;
        apiKey = enabled.apiKey;
        // 如果配置中有默认 model 且用户未指定，使用配置中的 model
        if (!options.model && enabled.provider.model && enabled.provider.id !== "local") {
          options.model = enabled.provider.model;
        }
      } else {
        // 2. 环境变量回退（向后兼容）
        if (process.env.VIDEO_DEFAULT_PROVIDER) {
          provider = process.env.VIDEO_DEFAULT_PROVIDER;
        } else if (process.env.FAL_KEY) {
          provider = "fal";
        } else if (process.env.REPLICATE_API_TOKEN) {
          provider = "replicate";
        } else {
          provider = "local";
        }
      }
    } else {
      // 用户指定了 provider，查找对应的 API Key
      const providers = getVideoGenProviders();
      const matched = providers.find(p => p.id === provider);
      if (matched) {
        apiKey = resolveEnvVar(matched.apiKey || "");
        if (!options.model && matched.model && matched.id !== "local") {
          options.model = matched.model;
        }
      }
      // 环境变量回退
      if (!apiKey) {
        if (provider === "fal") apiKey = process.env.FAL_KEY || "";
        else if (provider === "replicate") apiKey = process.env.REPLICATE_API_TOKEN || "";
      }
    }

    try {
      let result: VideoGenResult;

      switch (provider) {
        case "fal":
          if (!apiKey) {
            return {
              success: false,
              error: "Fal.ai provider selected but no API key is configured. Please configure Fal.ai API key in video-gen settings or set FAL_KEY environment variable, or use 'local' provider.",
            };
          }
          result = await generateViaFal(prompt, options, apiKey);
          break;

        case "replicate":
          if (!apiKey) {
            return {
              success: false,
              error: "Replicate provider selected but no API key is configured. Please configure Replicate API key in video-gen settings or set REPLICATE_API_TOKEN environment variable, or use 'local' provider.",
            };
          }
          result = await generateViaReplicate(prompt, options, apiKey);
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
  };

  /** 原 video_info */
  const handleVideoInfo = async () => {
    const providers: string[] = [];
    const models: Record<string, string[]> = {};
    const providerDetails: Array<{ id: string; name: string; enabled: boolean; hasApiKey: boolean; model: string }> = [];

    // 从配置文件读取
    const configProviders = getVideoGenProviders();
    for (const p of configProviders) {
      const apiKey = resolveEnvVar(p.apiKey || "");
      const hasApiKey = !!(apiKey || p.id === "local");
      providerDetails.push({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        hasApiKey,
        model: p.model,
      });
      if (p.enabled && (hasApiKey || p.id === "local")) {
        if (!providers.includes(p.id)) providers.push(p.id);
      }
    }

    // 环境变量回退（向后兼容）
    if (process.env.FAL_KEY && !providers.includes("fal")) {
      providers.push("fal");
      providerDetails.push({
        id: "fal",
        name: "Fal.ai (env)",
        enabled: true,
        hasApiKey: true,
        model: "fal-ai/wan/v2.2/text-to-video",
      });
    }

    if (process.env.REPLICATE_API_TOKEN && !providers.includes("replicate")) {
      providers.push("replicate");
      providerDetails.push({
        id: "replicate",
        name: "Replicate (env)",
        enabled: true,
        hasApiKey: true,
        model: "lightricks/ltx-video",
      });
    }

    if (isFfmpegAvailable() && !providers.includes("local")) {
      providers.push("local");
      providerDetails.push({
        id: "local",
        name: "Local FFmpeg",
        enabled: true,
        hasApiKey: true,
        model: "ffmpeg-slideshow",
      });
    }

    // 模型列表
    models.fal = [
      "fal-ai/wan/v2.2/text-to-video",
      "fal-ai/wan/v2.2/image-to-video",
      "fal-ai/kling/v1.6/standard/text-to-video",
      "fal-ai/kling/v1.6/standard/image-to-video",
      "fal-ai/ltx-video",
    ];
    models.replicate = [
      "lightricks/ltx-video",
      "cuuupid/cogvideox-5b",
      "minimax/video-01",
    ];
    models.local = ["ffmpeg-slideshow (text overlay on solid background)"];

    const enabled = getEnabledVideoProvider();

    return {
      available: providers.length > 0,
      providers,
      models,
      providerDetails,
      defaultProvider: enabled?.provider.id || process.env.VIDEO_DEFAULT_PROVIDER || providers[0] || "none",
      ffmpegAvailable: isFfmpegAvailable(),
      hasFalKey: !!(process.env.FAL_KEY || configProviders.find(p => p.id === "fal" && resolveEnvVar(p.apiKey))),
      hasReplicateToken: !!(process.env.REPLICATE_API_TOKEN || configProviders.find(p => p.id === "replicate" && resolveEnvVar(p.apiKey))),
      configSource: configProviders.length > 0 ? "data/config/video-gen-providers.json" : "environment variables",
    };
  };

  /** 原 video_download（实现从 shell-media-tools.ts 原样搬来，依赖的 checkSsrf /
   *  findPythonPaths / runPythonScriptAsync / generateVideoDownloadScript 一并注入） */
  const handleVideoDownload = async (params: Record<string, unknown>) => {
    const url = String(params.url || "");
    if (!url) return { success: false, error: "URL is required" };
    const format = String(params.format || "best");
    const noWatermark = String(params.noWatermark || "true") === "true";

    // SSRF 防护：阻止访问内网/元数据端点
    const ssrfReason = await checkSsrf(url);
    if (ssrfReason) {
      return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
    }

    const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
    const outputDir = path.join(workspaceDir, "downloads");
    const pythonPaths = findPythonPaths();
    const existingPath = process.env.PATH || process.env.Path || "";
    const extendedPath = [...pythonPaths, existingPath].join(path.delimiter);

    // Generate download script using media-downloader bridge
    const script = generateVideoDownloadScript({
      url,
      outputDir,
      format,
      noWatermark,
    });

    const scriptPath = path.join(workspaceDir, `_video_dl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.py`);
    fs.writeFileSync(scriptPath, script, "utf-8");

    try {
      const result = await runPythonScriptAsync(
        path.basename(scriptPath),
        workspaceDir,
        { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
        600000, // 10 minutes for large videos
      );

      // Parse [RESULT]...[/RESULT] from output
      const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          return { success: true, ...parsed };
        } catch (jsonErr) {
          // 关键修复：原先 JSON.parse 抛错会冒泡到外层 catch，
          // 且没有 [RESULT] 标记时仍返回 success:true —— 脚本报错也会
          // 被当成"下载完成"，与此前邮箱伪造完成态同型。
          return {
            success: false,
            error: `下载脚本输出的 [RESULT] 标记不是合法 JSON：${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
            output: result.slice(-2000),
          };
        }
      }
      // 无 [RESULT] 标记 = 脚本未产出结果（可能中途报错/被 kill），
      // 必须如实报告失败，绝不能返回 success:true。
      return {
        success: false,
        error: "下载脚本未产出 [RESULT] 结果标记，可能执行失败或超时；以下为原始输出尾部：",
        output: result.slice(-2000),
      };
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || String(err);
      // Check if partial download exists
      const resultMatch = stderr.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
      if (resultMatch) {
        try {
          const parsed = JSON.parse(resultMatch[1]);
          return { success: true, ...parsed, warning: "Download completed with warnings" };
        } catch (jsonErr) {
          console.warn(`[VideoDownload] Failed to parse yt-dlp JSON output: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
        }
      }
      return { success: false, error: stderr.slice(0, 5000) };
    } finally {
      try { fs.unlinkSync(scriptPath); } catch { /* non-critical */ }
    }
  };

  executor.registerTool(
    "video",
    {
      name: "video",
      description:
        "复合视频工具（composite video tool），通过 action 参数选择具体操作。" +
        "actions: " +
        "generate（默认，从文本描述生成短视频，支持文生视频与图生视频；后端为 Fal.ai（Wan 2.2、Kling、LTX）或 Replicate，" +
        "未配置时回退到本地 FFmpeg 幻灯片；生成的视频保存到 workspace 并返回下载链接） / " +
        "info（查询可用的视频生成能力：已配置的提供商、可用模型、本地 FFmpeg 是否可用） / " +
        "download（用 yt-dlp + ffmpeg 从 1000+ 网站下载视频，支持 B站/抖音/YouTube 等，抖音自动去水印；返回文件路径）。",
      parameters: {
        action: {
          type: "string",
          description: "视频操作类型：generate（默认，生成视频）/ info（查询生成能力）/ download（下载视频）",
          required: true,
          enum: ["generate", "info", "download"],
        },
        prompt: {
          type: "string",
          description: "Detailed description of the video to generate. Be specific about scenes, camera movements, style, and mood. 例：'一只猫在阳光下打盹，镜头缓慢推进，温暖色调'（action=generate 使用）",
        },
        duration: {
          type: "string",
          description: "Video duration in seconds (default: 5, range: 3-15)（action=generate 使用）",
        },
        aspect_ratio: {
          type: "string",
          description: "Aspect ratio: '16:9' (landscape, default), '9:16' (portrait), '1:1' (square)（action=generate 使用）",
        },
        provider: {
          type: "string",
          description: "Video generation provider: 'fal' (Fal.ai), 'replicate', 'local' (FFmpeg slideshow). If not specified, auto-selects based on available API keys.（action=generate 使用）",
        },
        model: {
          type: "string",
          description: "Specific model ID (e.g., 'fal-ai/wan/v2.2/text-to-video'). If not specified, uses provider's default.（action=generate 使用）",
        },
        image_url: {
          type: "string",
          description: "Optional image URL for image-to-video generation. If provided, the video will animate from this image.（action=generate 使用）",
        },
        url: {
          type: "string",
          description: "The video URL to download (Bilibili, Douyin, YouTube, etc.)（action=download 使用）",
        },
        format: {
          type: "string",
          description: "Video quality: 'best', '720p', '1080p', '4k' (default: best)（action=download 使用）",
        },
        noWatermark: {
          type: "string",
          description: "Set to 'true' to remove watermark (default: true for Douyin)（action=download 使用）",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "generate");
      if (action === "generate") return await handleVideoGenerate(params);
      if (action === "info") return await handleVideoInfo();
      if (action === "download") return await handleVideoDownload(params);
      return { success: false, error: `未知 video action: ${action}（仅支持 generate / info / download）` };
    },
    // checkFn: 至少有一种生成方式可用
    () => isVideoGenerationAvailable()
  );
}
