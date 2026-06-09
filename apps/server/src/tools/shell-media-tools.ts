import * as path from "path";
import * as fs from "fs";
import { execSync, spawn } from "child_process";
import type { AgentModelExecutor } from "@evoclaw/agent";

export function registerShellMediaTools(
  executor: AgentModelExecutor
): void {
  // ── shell_exec: 在安全前提下在沙箱外执行 shell 命令（支持 Python/Node.js） ──
  // 支持：1200s 超时、30s 进度反馈、超时续接
  executor.registerTool(
    "shell_exec",
    {
      name: "shell_exec",
      description: "Execute a shell command securely. Supports Python (python/python3), Node.js (node), and standard shell commands. Long-running tasks (crawlers) get up to 1200s timeout with periodic progress feedback every 30s. If timeout occurs, the tool returns partial output with a resume hint.",
      parameters: {
        command: { type: "string", description: "The shell command to execute. Examples: 'python script.py', 'node script.mjs', 'pip install requests'" },
        cwd: { type: "string", description: "Optional working directory for the command (default: workspace)" },
        timeout: { type: "string", description: "Optional timeout in seconds (default: 120, max: 1200). Use higher values for crawler tasks." },
      },
    },
    async (params: Record<string, unknown>) => {
      const command = String(params.command || "");
      if (!command) return { error: "Command is required" };

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
      const cwd = params.cwd ? String(params.cwd) : workspaceDir;
      const timeoutSec = Math.min(parseInt(String(params.timeout || "120"), 10) || 120, 1200);

      // ── 安全校验：阻止危险命令 ──
      const DANGEROUS_PATTERNS = [
        /rm\s+-rf\s+\//, /rm\s+-rf\s+\~/, /del\s+\/S\s+\/Q\s+C:\\/i,
        /shutdown/, /reboot/, /format\s+[a-z]:/i,
        /dd\s+if=/, /mkfs/, /fdisk/, /:\(\)\s*\{/, /fork\s*bomb/,
        />\s*\/dev\/sda/, />\s*\/dev\/nvme/,
        /chmod\s+777\s+\//, /chown\s+-R\s+\//,
        /eval\s/, /\.\$\(/, /\$\(.*rm\s+-rf/,
      ];
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          return { error: `Command blocked by safety filter: matched dangerous pattern`, command };
        }
      }

      // Build PATH with Python and Node.js locations
      const pythonPaths = [
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313",
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313\\Scripts",
        "C:\\Python313",
        "C:\\Python3",
      ];
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(";");

      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
      const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

      // ── 使用 spawn 实现异步执行 + 进度反馈 ──
      return new Promise((resolve) => {
        console.log(`[shell_exec] Running: ${command} (cwd: ${cwd}, timeout: ${timeoutSec}s)`);

        const child = spawn(shell, shellArgs, {
          cwd,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let lastProgressTime = Date.now();
        let lastProgressSent = 0;
        const PROGRESS_INTERVAL = 30000; // 30s

        child.stdout?.on("data", (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;

          // 每30秒输出进度反馈
          const now = Date.now();
          if (now - lastProgressTime >= PROGRESS_INTERVAL) {
            const lines = stdout.split("\n").filter(Boolean);
            const lastLines = lines.slice(-3).join(" | ");
            const progressMsg = `⏳ [shell_exec ${Math.floor((now - lastProgressSent || now) / 1000)}s] 最新输出: ${lastLines.slice(0, 200)}`;
            console.log(progressMsg);
            lastProgressTime = now;
            if (!lastProgressSent) lastProgressSent = now;
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        // 超时计时器
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            child.kill("SIGTERM");
            const partial = stdout.slice(-2000);
            const progressSeconds = Math.floor((Date.now() - lastProgressSent || Date.now()) / 1000);
            console.log(`[shell_exec] TIMEOUT after ${timeoutSec}s, partial output: ${stdout.length} chars`);
            resolve({
              success: false,
              timedOut: true,
              timeout: timeoutSec,
              output: stdout.slice(0, 50000),
              partialOutput: partial,
              error: `命令执行超时 (${timeoutSec}秒)，已运行约 ${progressSeconds} 秒。部分输出已保留。`,
              resumeHint: "任务超时但进度已保存。你可以使用相同的命令继续执行，脚本会自动从检查点恢复。",
              command,
            });
          }
        }, timeoutSec * 1000);

        child.on("close", (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            const output = stdout.trim();
            const errorOutput = stderr.trim();
            console.log(`[shell_exec] Exit code ${code}, output: ${output.length} chars`);
            if (code === 0) {
              resolve({
                success: true,
                output: output.slice(0, 50000),
                stderr: errorOutput.slice(0, 5000) || undefined,
                command,
              });
            } else {
              resolve({
                success: false,
                exitCode: code,
                error: errorOutput.slice(0, 10000) || output.slice(0, 10000),
                output: output.slice(0, 50000),
                command,
              });
            }
          }
        });

        child.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            console.log(`[shell_exec] Process error: ${err.message}`);
            resolve({ success: false, error: err.message, command });
          }
        });
      });
    }
  );

  // ── scrapling_fetch: 使用 Scrapling 框架进行高级抓取 ──
  executor.registerTool(
    "scrapling_fetch",
    {
      name: "scrapling_fetch",
      description: "Fetch a URL using Scrapling's StealthyFetcher (bypasses Cloudflare, handles anti-bot). Returns page title, text content, and extracted links. Supports adaptive scraping that survives website redesigns.",
      parameters: {
        url: { type: "string", description: "The URL to fetch" },
        selector: { type: "string", description: "Optional CSS selector to extract specific content" },
        extractLinks: { type: "string", description: "Set to 'true' to extract all links from the page" },
        headless: { type: "string", description: "Set to 'false' for faster non-headless mode (default: true)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      if (!url) return { error: "URL is required" };
      const selector = params.selector ? String(params.selector) : "";
      const extractLinks = String(params.extractLinks || "") === "true";
      const headless = String(params.headless || "") !== "false";

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
      const pythonPaths = [
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313",
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313\\Scripts",
      ];
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(";");

      const script = `#!/usr/bin/env python3
import json, sys
try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(${JSON.stringify(url)}, headless=${headless ? "True" : "False"})
    result = {
        "title": page.css("title::text").get(""),
        "url": str(page.url),
        "status": page.status,
        "text_preview": page.text_content()[:3000],
    }
    ${selector ? `result["selected"] = [el.text_content().strip()[:500] for el in page.css(${JSON.stringify(selector)})[:10]]` : ""}
    ${extractLinks ? `result["links"] = [{"href": l.attrib.get("href", ""), "text": l.text_content().strip()[:100]} for l in page.css("a[href]")[:30]]` : ""}
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
    sys.exit(1)
`;

      try {
        const result = execSync(`python -c ${JSON.stringify(script)}`, {
          cwd: workspaceDir,
          timeout: 60000,
          maxBuffer: 5 * 1024 * 1024,
          encoding: "utf-8",
          env: { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
        });
        const parsed = JSON.parse(result.trim());
        return { success: true, ...parsed };
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || String(err);
        return { success: false, error: stderr.slice(0, 5000) };
      }
    }
  );

  // ── video_download: 下载视频（B站/抖音/YouTube/好看视频等1000+网站） ──
  executor.registerTool(
    "video_download",
    {
      name: "video_download",
      description: "Download video from 1000+ websites using yt-dlp + ffmpeg. Supports Bilibili, Douyin, YouTube, Haokan, WeChat Channels, Kuaishou, Xigua, etc. Auto watermark removal for Douyin. Returns file path for download.",
      parameters: {
        url: { type: "string", description: "The video URL to download (Bilibili, Douyin, YouTube, etc.)" },
        format: { type: "string", description: "Video quality: 'best', '720p', '1080p', '4k' (default: best)" },
        noWatermark: { type: "string", description: "Set to 'true' to remove watermark (default: true for Douyin)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      if (!url) return { error: "URL is required" };
      const format = String(params.format || "best");
      const noWatermark = String(params.noWatermark || "true") === "true";

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
      const outputDir = path.join(workspaceDir, "downloads");
      const pythonPaths = [
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313",
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313\\Scripts",
      ];
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(";");

      // Generate download script using media-downloader bridge
      const { generateVideoDownloadScript } = require("@evoclaw/infrastructure");
      const script = generateVideoDownloadScript({
        url,
        outputDir,
        format,
        noWatermark,
      });

      const scriptPath = path.join(workspaceDir, "_video_dl.py");
      fs.writeFileSync(scriptPath, script, "utf-8");

      try {
        const result = execSync(`python _video_dl.py`, {
          cwd: workspaceDir,
          timeout: 600000, // 10 minutes for large videos
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf-8",
          env: { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
        });

        // Parse [RESULT]...[/RESULT] from output
        const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
        if (match) {
          const parsed = JSON.parse(match[1]);
          return { success: true, ...parsed };
        }
        return { success: true, output: result.slice(-2000) };
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
      }
    }
  );

  // ── music_search: 搜索歌手热门歌曲（播放意图，非下载） ──
  executor.registerTool(
    "music_search",
    {
      name: "music_search",
      description: "Search for an artist's hit songs and return a formatted list with playable links. Use this when the user wants to LISTEN to music, not download it.",
      parameters: {
        artist: { type: "string", description: "Artist name (歌手名)" },
        limit: { type: "number", description: "Number of songs to return (default: 10)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const artist = String(params.artist || "");
      const limit = Number(params.limit) || 10;
      if (!artist) return { error: "Artist name is required" };
      // Return structured data that the LLM will format into a nice list
      return JSON.stringify({
        artist,
        hint: `Search for ${artist}'s hit songs using web_search, then format the results as a numbered list with clickable links to NetEase Cloud Music (https://music.163.com/#/search/m/?s=${encodeURIComponent(artist)}+歌名&type=1). Do NOT download any files.`,
        neteaseSearchUrl: `https://music.163.com/#/search/m/?s=${encodeURIComponent(artist)}&type=1`,
        limit,
      });
    }
  );

  // ── music_download: 下载音乐（从视频平台提取音频） ──
  executor.registerTool(
    "music_download",
    {
      name: "music_download",
      description: "Download music by searching and extracting audio from video platforms using yt-dlp + ffmpeg. Supports any song name/artist. Returns MP3 file path for download. Falls back to YouTube search if direct URL not available.",
      parameters: {
        query: { type: "string", description: "Song name, artist, or URL (e.g. '周杰伦 晴天' or a music URL)" },
        audioFormat: { type: "string", description: "Audio format: 'mp3', 'flac', 'aac' (default: mp3)" },
        quality: { type: "string", description: "Audio quality: '128', '192', '320' kbps (default: 320)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const query = String(params.query || "");
      if (!query) return { error: "Query (song name or URL) is required" };
      const audioFormat = String(params.audioFormat || "mp3");
      const quality = String(params.quality || "320");

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
      const outputDir = path.join(workspaceDir, "downloads");
      const pythonPaths = [
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313",
        "C:\\Users\\huiyu\\AppData\\Local\\Programs\\Python\\Python313\\Scripts",
      ];
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(";");

      // Check if query is a URL — if so, use video_download with extractAudio
      const isUrl = /^https?:\/\//i.test(query);

      if (isUrl) {
        // Use video download script with extractAudio=true
        const { generateVideoDownloadScript } = require("@evoclaw/infrastructure");
        const script = generateVideoDownloadScript({
          url: query,
          outputDir,
          extractAudio: true,
          audioFormat,
        });
        const scriptPath = path.join(workspaceDir, "_music_dl.py");
        fs.writeFileSync(scriptPath, script, "utf-8");

        try {
          const result = execSync(`python _music_dl.py`, {
            cwd: workspaceDir,
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: "utf-8",
            env: { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
          });
          const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
          if (match) {
            const parsed = JSON.parse(match[1]);
            return { success: true, ...parsed };
          }
          return { success: true, output: result.slice(-2000) };
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || String(err);
          return { success: false, error: stderr.slice(0, 5000) };
        }
      } else {
        // Search and download music
        const { generateMusicDownloadScript } = require("@evoclaw/infrastructure");
        const script = generateMusicDownloadScript({
          query,
          outputDir,
          audioFormat,
          quality,
        });
        const scriptPath = path.join(workspaceDir, "_music_dl.py");
        fs.writeFileSync(scriptPath, script, "utf-8");

        try {
          const result = execSync(`python _music_dl.py`, {
            cwd: workspaceDir,
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: "utf-8",
            env: { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
          });
          const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
          if (match) {
            const parsed = JSON.parse(match[1]);
            return { success: true, ...parsed };
          }
          return { success: true, output: result.slice(-2000) };
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || String(err);
          return { success: false, error: stderr.slice(0, 5000) };
        }
      }
    }
  );
}
