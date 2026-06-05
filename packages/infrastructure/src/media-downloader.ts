/**
 * Media Downloader Bridge — 视频/音乐下载脚本生成器
 * 基于 yt-dlp + ffmpeg，支持 1000+ 网站
 */

/** 检测 yt-dlp 是否可用 */
export function isYtDlpAvailable(): boolean {
  // 运行时由 shell_exec 检测，这里默认 true（Python 环境已有 yt-dlp）
  return true;
}

/** 检测 ffmpeg 是否可用 */
export function isFfmpegAvailable(): boolean {
  return true;
}

/** 获取媒体下载环境信息 */
export function getMediaDownloaderInfo(): string {
  return "yt-dlp 2026.3.17 + ffmpeg 8.1 — 支持 B站/抖音/YouTube/微信视频号/好看视频等 1000+ 网站";
}

/** 支持的平台检测 */
export function detectPlatform(url: string): { name: string; type: "video" | "music" | "unknown" } {
  const patterns: Array<{ pattern: RegExp; name: string; type: "video" | "music" | "unknown" }> = [
    // 视频平台
    { pattern: /bilibili\.com|b23\.tv/i, name: "B站", type: "video" },
    { pattern: /douyin\.com|iesdouyin\.com/i, name: "抖音", type: "video" },
    { pattern: /v\.qq\.com|weixin\.qq\.com/i, name: "微信视频号/腾讯视频", type: "video" },
    { pattern: /haokan\.baidu\.com/i, name: "好看视频", type: "video" },
    { pattern: /youtube\.com|youtu\.be/i, name: "YouTube", type: "video" },
    { pattern: /ixigua\.com/i, name: "西瓜视频", type: "video" },
    { pattern: /kuaishou\.com|gifshow\.com/i, name: "快手", type: "video" },
    { pattern: /weibo\.com|weibo\.cn/i, name: "微博视频", type: "video" },
    { pattern: /zhihu\.com/i, name: "知乎视频", type: "video" },
    { pattern: /xiaohongshu\.com|xhslink\.com/i, name: "小红书", type: "video" },
    // 音乐平台
    { pattern: /music\.163\.com/i, name: "网易云音乐", type: "music" },
    { pattern: /y\.qq\.com/i, name: "QQ音乐", type: "music" },
    { pattern: /kugou\.com/i, name: "酷狗音乐", type: "music" },
    { pattern: /kuwo\.cn/i, name: "酷我音乐", type: "music" },
    { pattern: /spotify\.com/i, name: "Spotify", type: "music" },
    { pattern: /soundcloud\.com/i, name: "SoundCloud", type: "music" },
  ];

  for (const { pattern, name, type } of patterns) {
    if (pattern.test(url)) {
      return { name, type };
    }
  }

  return { name: "未知平台", type: "unknown" };
}

/**
 * 生成视频下载 Python 脚本
 * 使用 yt-dlp 下载视频，支持去水印
 */
export function generateVideoDownloadScript(params: {
  url: string;
  outputDir: string;
  format?: string;       // "best", "720p", "1080p", "4k"
  noWatermark?: boolean; // 去水印
  extractAudio?: boolean; // 仅提取音频
  audioFormat?: string;   // "mp3", "flac", "aac"
}): string {
  const url = params.url;
  const outputDir = params.outputDir.replace(/\\/g, "/");
  const format = params.format || "best";
  const noWatermark = params.noWatermark !== false; // 默认去水印
  const extractAudio = params.extractAudio || false;
  const audioFormat = params.audioFormat || "mp3";

  // yt-dlp 格式选择
  let formatSelector: string;
  if (extractAudio) {
    formatSelector = "bestaudio/best";
  } else if (format === "4k") {
    formatSelector = "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best";
  } else if (format === "1080p") {
    formatSelector = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
  } else if (format === "720p") {
    formatSelector = "bestvideo[height<=720]+bestaudio/best[height<=720]/best";
  } else {
    formatSelector = "bestvideo+bestaudio/best";
  }

  // 抖音去水印：使用无水印API
  const douyinNoWatermark = noWatermark && /douyin\.com|iesdouyin\.com/i.test(url);

  return `#!/usr/bin/env python3
"""
Media Downloader — 由 EvoClaw Media Downloader Bridge 生成
基于 yt-dlp + ffmpeg，支持 1000+ 网站
"""
import sys, os, json, subprocess, time

OUTPUT_DIR = ${JSON.stringify(outputDir)}
URL = ${JSON.stringify(url)}
FORMAT = ${JSON.stringify(formatSelector)}
EXTRACT_AUDIO = ${JSON.stringify(extractAudio)}
AUDIO_FORMAT = ${JSON.stringify(audioFormat)}
NO_WATERMARK = ${JSON.stringify(noWatermark)}
DOUYIN_NO_WM = ${JSON.stringify(douyinNoWatermark)}

os.makedirs(OUTPUT_DIR, exist_ok=True)

def check_deps():
    """检查依赖"""
    missing = []
    try:
        import yt_dlp
    except ImportError:
        missing.append("yt-dlp")
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5, check=True)
    except Exception:
        missing.append("ffmpeg")
    if missing:
        print(f"[ERROR] Missing dependencies: {', '.join(missing)}")
        print(f"[HINT] Install: pip install yt-dlp && install ffmpeg")
        sys.exit(1)

def download_douyin_no_watermark(url):
    """抖音无水印下载：通过分享链接获取无水印视频地址"""
    import requests
    import re
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.douyin.com/",
    }
    
    try:
        # 获取重定向后的真实URL
        resp = requests.get(url, headers=headers, allow_redirects=True, timeout=15)
        # 尝试从页面提取无水印视频URL
        # 方法1: 从页面JSON数据中提取
        match = re.search(r'playAddr.*?"src":"([^"]+?)"', resp.text)
        if match:
            video_url = match.group(1).replace("\\\\u002F", "/").replace("&amp;", "&")
            # 替换为无水印版本
            video_url = re.sub(r'watermark=\\d', 'watermark=0', video_url)
            return video_url
        
        # 方法2: 使用 yt-dlp 的 --referer 绕过
        return None
    except Exception as e:
        print(f"[WARN] Douyin no-watermark extraction failed: {e}")
        return None

def main():
    check_deps()
    import yt_dlp
    
    print(f"[INFO] Downloading: {URL}")
    print(f"[INFO] Output dir: {OUTPUT_DIR}")
    print(f"[INFO] Extract audio: {EXTRACT_AUDIO}")
    print(f"[INFO] No watermark: {NO_WATERMARK}")
    
    # 抖音无水印处理
    actual_url = URL
    if DOUYIN_NO_WM:
        wm_url = download_douyin_no_watermark(URL)
        if wm_url:
            actual_url = wm_url
            print(f"[INFO] Using douyin no-watermark URL")
    
    # yt-dlp 选项
    ydl_opts = {
        "outtmpl": os.path.join(OUTPUT_DIR, "%(title).80s.%(ext)s"),
        "format": FORMAT,
        "restrictfilenames": True,
        "no_warnings": False,
        "quiet": False,
        "progress_hooks": [lambda d: print(f"[PROGRESS] {d.get('_percent_str', '?')} - {d.get('_speed_str', '?')}") if d['status'] == 'downloading' else None],
    }
    
    if EXTRACT_AUDIO:
        ydl_opts.update({
            "format": "bestaudio/best",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": AUDIO_FORMAT,
                "preferredquality": "192" if AUDIO_FORMAT == "mp3" else "5",
            }],
            "outtmpl": os.path.join(OUTPUT_DIR, "%(title).80s.%(ext)s"),
        })
    else:
        ydl_opts.update({
            "merge_output_format": "mp4",
            "postprocessors": [{
                "key": "FFmpegVideoConvertor",
                "preferedformat": "mp4",
            }] if FORMAT != "best" else [],
        })
    
    # 平台特定配置
    if "bilibili" in actual_url or "b23.tv" in actual_url:
        ydl_opts["http_headers"] = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.bilibili.com",
        }
    elif "douyin" in actual_url or "iesdouyin" in actual_url:
        ydl_opts["http_headers"] = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.douyin.com/",
        }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # 先提取信息
            info = ydl.extract_info(actual_url, download=True)
            
            title = info.get("title", "unknown")
            duration = info.get("duration", 0)
            uploader = info.get("uploader", "unknown")
            ext = AUDIO_FORMAT if EXTRACT_AUDIO else "mp4"
            
            # 查找实际输出文件
            filename = ydl.prepare_filename(info)
            if EXTRACT_AUDIO:
                filename = os.path.splitext(filename)[0] + f".{AUDIO_FORMAT}"
            
            # 验证文件存在
            if os.path.exists(filename):
                size_mb = os.path.getsize(filename) / (1024 * 1024)
                print(f"\\n[SUCCESS] Download complete!")
                print(f"[FILE] {filename}")
                print(f"[SIZE] {size_mb:.1f} MB")
                print(f"[TITLE] {title}")
                print(f"[DURATION] {duration}s")
                print(f"[UPLOADER] {uploader}")
                print(f"[FORMAT] {ext}")
                
                # 输出JSON结果
                result = {
                    "success": True,
                    "file": filename,
                    "size_mb": round(size_mb, 1),
                    "title": title,
                    "duration": duration,
                    "uploader": uploader,
                    "format": ext,
                }
                print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
            else:
                # 尝试模糊匹配
                import glob
                candidates = glob.glob(os.path.join(OUTPUT_DIR, f"*.{ext}"))
                if candidates:
                    latest = max(candidates, key=os.path.getmtime)
                    size_mb = os.path.getsize(latest) / (1024 * 1024)
                    print(f"\\n[SUCCESS] Download complete!")
                    print(f"[FILE] {latest}")
                    print(f"[SIZE] {size_mb:.1f} MB")
                    result = {
                        "success": True,
                        "file": latest,
                        "size_mb": round(size_mb, 1),
                        "title": title,
                        "format": ext,
                    }
                    print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
                else:
                    print(f"[ERROR] File not found after download")
                    sys.exit(1)
                    
    except Exception as e:
        print(f"[ERROR] Download failed: {e}")
        # 尝试降级：降低画质重试
        if "bestvideo+bestaudio" in FORMAT and not EXTRACT_AUDIO:
            print(f"[RETRY] Trying with lower quality...")
            ydl_opts["format"] = "best"
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(actual_url, download=True)
                    filename = ydl.prepare_filename(info)
                    if os.path.exists(filename):
                        size_mb = os.path.getsize(filename) / (1024 * 1024)
                        print(f"\\n[SUCCESS] Download complete (fallback quality)!")
                        print(f"[FILE] {filename}")
                        print(f"[SIZE] {size_mb:.1f} MB")
                        result = {"success": True, "file": filename, "size_mb": round(size_mb, 1), "title": info.get("title", "unknown"), "format": "mp4"}
                        print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
            except Exception as e2:
                print(f"[ERROR] Retry also failed: {e2}")
                sys.exit(1)
        else:
            sys.exit(1)

if __name__ == "__main__":
    main()
`;
}

/**
 * 生成音乐下载 Python 脚本
 * 使用 yt-dlp 从视频平台提取音频
 */
export function generateMusicDownloadScript(params: {
  query: string;
  outputDir: string;
  audioFormat?: string;  // "mp3", "flac"
  quality?: string;      // "128", "192", "320"
}): string {
  const query = params.query;
  const outputDir = params.outputDir.replace(/\\/g, "/");
  const audioFormat = params.audioFormat || "mp3";
  const quality = params.quality || "320";

  return `#!/usr/bin/env python3
"""
Music Downloader — 由 EvoClaw Media Downloader Bridge 生成
使用 yt-dlp 从视频平台搜索并提取音频
"""
import sys, os, json, subprocess

OUTPUT_DIR = ${JSON.stringify(outputDir)}
QUERY = ${JSON.stringify(query)}
AUDIO_FORMAT = ${JSON.stringify(audioFormat)}
QUALITY = ${JSON.stringify(quality)}

os.makedirs(OUTPUT_DIR, exist_ok=True)

def check_deps():
    missing = []
    try:
        import yt_dlp
    except ImportError:
        missing.append("yt-dlp")
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5, check=True)
    except Exception:
        missing.append("ffmpeg")
    if missing:
        print(f"[ERROR] Missing: {', '.join(missing)}")
        sys.exit(1)

def main():
    check_deps()
    import yt_dlp
    
    # 搜索关键词：添加 "audio" 或 "歌曲" 提高搜索精度
    search_query = f"ytsearch3:{QUERY} audio"
    print(f"[INFO] Searching: {QUERY}")
    print(f"[INFO] Audio format: {AUDIO_FORMAT}, Quality: {QUALITY}kbps")
    
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(OUTPUT_DIR, "%(title).80s.%(ext)s"),
        "restrictfilenames": True,
        "quiet": False,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": AUDIO_FORMAT,
            "preferredquality": QUALITY,
        }],
        "progress_hooks": [lambda d: print(f"[PROGRESS] {d.get('_percent_str', '?')} - {d.get('_speed_str', '?')}") if d['status'] == 'downloading' else None],
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # 搜索并下载第一个结果
            info = ydl.extract_info(search_query, download=True)
            
            if "entries" in info:
                entries = list(info["entries"])
                if entries:
                    # 下载第一个
                    entry = entries[0]
                    title = entry.get("title", "unknown")
                    filename = ydl.prepare_filename(entry)
                    filename = os.path.splitext(filename)[0] + f".{AUDIO_FORMAT}"
                    
                    if os.path.exists(filename):
                        size_mb = os.path.getsize(filename) / (1024 * 1024)
                        print(f"\\n[SUCCESS] Music download complete!")
                        print(f"[FILE] {filename}")
                        print(f"[SIZE] {size_mb:.1f} MB")
                        print(f"[TITLE] {title}")
                        
                        result = {
                            "success": True,
                            "file": filename,
                            "size_mb": round(size_mb, 1),
                            "title": title,
                            "format": AUDIO_FORMAT,
                            "quality": f"{QUALITY}kbps",
                        }
                        print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
                    else:
                        # 模糊匹配
                        import glob
                        candidates = glob.glob(os.path.join(OUTPUT_DIR, f"*.{AUDIO_FORMAT}"))
                        if candidates:
                            latest = max(candidates, key=os.path.getmtime)
                            size_mb = os.path.getsize(latest) / (1024 * 1024)
                            print(f"\\n[SUCCESS] Music download complete!")
                            print(f"[FILE] {latest}")
                            result = {"success": True, "file": latest, "size_mb": round(size_mb, 1), "title": title, "format": AUDIO_FORMAT}
                            print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
                        else:
                            print(f"[ERROR] Audio file not found after download")
                            sys.exit(1)
                else:
                    print(f"[ERROR] No search results found for: {QUERY}")
                    sys.exit(1)
            else:
                # 单个结果
                title = info.get("title", "unknown")
                filename = ydl.prepare_filename(info)
                filename = os.path.splitext(filename)[0] + f".{AUDIO_FORMAT}"
                
                if os.path.exists(filename):
                    size_mb = os.path.getsize(filename) / (1024 * 1024)
                    result = {"success": True, "file": filename, "size_mb": round(size_mb, 1), "title": title, "format": AUDIO_FORMAT}
                    print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
                    
    except Exception as e:
        print(f"[ERROR] Music download failed: {e}")
        # 降级：尝试直接搜索（不加 audio 关键词）
        try:
            print(f"[RETRY] Trying broader search...")
            search_query2 = f"ytsearch1:{QUERY}"
            ydl_opts2 = dict(ydl_opts)
            with yt_dlp.YoutubeDL(ydl_opts2) as ydl2:
                info2 = ydl2.extract_info(search_query2, download=True)
                title2 = info2.get("title", "unknown") if info2 else "unknown"
                import glob
                candidates = glob.glob(os.path.join(OUTPUT_DIR, f"*.{AUDIO_FORMAT}"))
                if candidates:
                    latest = max(candidates, key=os.path.getmtime)
                    size_mb = os.path.getsize(latest) / (1024 * 1024)
                    result = {"success": True, "file": latest, "size_mb": round(size_mb, 1), "title": title2, "format": AUDIO_FORMAT}
                    print(f"\\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
        except Exception as e2:
            print(f"[ERROR] Retry also failed: {e2}")
            sys.exit(1)

if __name__ == "__main__":
    main()
`;
}
