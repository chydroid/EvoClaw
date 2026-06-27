/**
 * Media Processor — OpenClaw compatibility layer.
 *
 * Media type detection, processing, and transcoding utilities:
 *
 *   - File type detection from bytes/buffers (magic bytes)
 *   - MIME type lookup by extension
 *   - Base64 data URI encoding/decoding
 *   - Size/format validation
 *   - Document text extraction (markdown, plain text)
 *   - Audio/video tag parsing
 *
 * OpenClaw uses this for handling media attachments across channels.
 */
import * as path from "path";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type MediaType =
  | "image"
  | "audio"
  | "video"
  | "document"
  | "archive"
  | "code"
  | "data"
  | "font"
  | "unknown";

export interface MediaInfo {
  extension: string;
  mimeType: string;
  mediaType: MediaType;
  isTextual: boolean;
  /** Estimated size category */
  sizeCategory?: "tiny" | "small" | "medium" | "large";
}

export interface DataURI {
  mimeType: string;
  isBase64: boolean;
  data: string;
  rawBytes?: Buffer;
}

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}

// ──────────────────────────────────────────────────────────────
// Magic bytes for file type detection
// ──────────────────────────────────────────────────────────────

const MAGIC_BYTES: Array<{ bytes: number[]; offset?: number; mimeType: string; mediaType: MediaType }> = [
  { bytes: [0xFF, 0xD8, 0xFF], mimeType: "image/jpeg", mediaType: "image" },
  { bytes: [0x89, 0x50, 0x4E, 0x47], mimeType: "image/png", mediaType: "image" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: "image/gif", mediaType: "image" },
  { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, mimeType: "image/webp", mediaType: "image" }, // RIFF...WEBP
  { bytes: [0x25, 0x50, 0x44, 0x46], mimeType: "application/pdf", mediaType: "document" },
  { bytes: [0x50, 0x4B, 0x03, 0x04], mimeType: "application/zip", mediaType: "archive" },
  { bytes: [0x1F, 0x8B, 0x08], mimeType: "application/gzip", mediaType: "archive" },
  { bytes: [0xFF, 0xFB], mimeType: "audio/mpeg", mediaType: "audio" },
  { bytes: [0x49, 0x44, 0x33], mimeType: "audio/mpeg", mediaType: "audio" }, // ID3
  { bytes: [0x4F, 0x67, 0x67, 0x53], mimeType: "audio/ogg", mediaType: "audio" },
  { bytes: [0x57, 0x41, 0x56, 0x45], offset: 8, mimeType: "audio/wav", mediaType: "audio" }, // RIFF...WAVE
  { bytes: [0x00, 0x00, 0x00, 0x14, 0x66, 0x74], mimeType: "video/mp4", mediaType: "video" },
  { bytes: [0x1A, 0x45, 0xDF, 0xA3], mimeType: "video/webm", mediaType: "video" },
  { bytes: [0x00, 0x00, 0x01, 0xBA], mimeType: "video/mpeg", mediaType: "video" },
  { bytes: [0x00, 0x00, 0x01, 0xB3], mimeType: "video/mpeg", mediaType: "video" },
];

// ──────────────────────────────────────────────────────────────
// MIME type mapping
// ──────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".csv": "text/csv",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".sh": "text/x-shellscript",
  ".bat": "text/x-batch",
  ".ps1": "text/x-powershell",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
  ".sql": "text/x-sql",
};

const MEDIA_TYPE_MAP: Record<string, MediaType> = {
  "image/": "image",
  "audio/": "audio",
  "video/": "video",
  "text/": "code",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.": "document",
  "application/zip": "archive",
  "application/gzip": "archive",
  "application/x-tar": "archive",
  "application/x-7z": "archive",
  "application/vnd.rar": "archive",
  "font/": "font",
  "application/json": "data",
  "application/xml": "data",
  "application/javascript": "code",
  "application/typescript": "code",
};

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Detect file type from the first bytes of a buffer.
 */
export function detectFromBytes(buffer: Buffer): MediaInfo | null {
  for (const magic of MAGIC_BYTES) {
    if (matchesMagic(buffer, magic.bytes, magic.offset ?? 0)) {
      return {
        extension: "",
        mimeType: magic.mimeType,
        mediaType: magic.mediaType,
        isTextual: magic.mediaType === "code" || magic.mediaType === "data",
      };
    }
  }
  return null;
}

/**
 * Get media info from a filename or extension.
 */
export function infoFromFilename(filename: string): MediaInfo {
  const ext = path.extname(filename).toLowerCase();
  const mimeType = MIME_MAP[ext] || "application/octet-stream";
  const mediaType = classifyMimeType(mimeType);
  const isTextual = mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript";

  return { extension: ext, mimeType, mediaType, isTextual };
}

/**
 * Get MIME type from file extension.
 */
export function mimeFromExtension(ext: string): string {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_MAP[normalized] || "application/octet-stream";
}

/**
 * Get media type category from MIME type.
 */
export function classifyMimeType(mimeType: string): MediaType {
  for (const [prefix, mediaType] of Object.entries(MEDIA_TYPE_MAP)) {
    if (mimeType.startsWith(prefix)) return mediaType;
  }
  return "unknown";
}

/**
 * Check if a buffer appears to be valid image data.
 */
export function isImage(buffer: Buffer): boolean {
  const info = detectFromBytes(buffer);
  return info?.mediaType === "image";
}

/**
 * Check if a buffer appears to be text content.
 */
export function isText(buffer: Buffer): boolean {
  // Check if buffer is valid UTF-8 and contains mostly printable chars
  try {
    const str = buffer.toString("utf-8", 0, Math.min(buffer.length, 4096));
    const printable = str.replace(/[\x09\x0A\x0D\x20-\x7E\x80-\xFF]/g, "");
    return printable.length < str.length * 0.1;
  } catch {
    return false;
  }
}

// ── Base64 / Data URI ──

/**
 * Parse a data URI (data:[<mediatype>][;base64],<data>) into its components.
 */
export function parseDataURI(uri: string): DataURI | null {
  const match = uri.match(/^data:([^;,]+)?(;base64)?,(.+)$/);
  if (!match) return null;

  const mimeType = match[1] || "text/plain";
  const isBase64 = match[2] === ";base64";
  const data = match[3];

  let rawBytes: Buffer | undefined;
  if (isBase64) {
    try {
      rawBytes = Buffer.from(data, "base64");
    } catch {
      return null;
    }
  }

  return { mimeType, isBase64, data, rawBytes };
}

/**
 * Create a data URI from a buffer.
 */
export function toDataURI(buffer: Buffer, mimeType: string): string {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Convert a Buffer to a base64-encoded string.
 */
export function toBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

/**
 * Convert a base64 string back to a Buffer.
 */
export function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

// ── Size helpers ──

/**
 * Categorize a file size in bytes.
 */
export function classifySize(bytes: number): "tiny" | "small" | "medium" | "large" {
  if (bytes < 10_000) return "tiny";
  if (bytes < 1_000_000) return "small";
  if (bytes < 50_000_000) return "medium";
  return "large";
}

/**
 * Human-readable file size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/**
 * Check if a file exceeds a configured maximum size.
 */
export function isTooLarge(bytes: number, maxBytes: number): boolean {
  return bytes > maxBytes;
}

// ── Document text extraction ──

/**
 * Extract plain text from common document formats.
 * Currently supports: .txt, .md, .json, .csv, .html (basic strip)
 */
export function extractText(buffer: Buffer, filename: string): string {
  const info = infoFromFilename(filename);

  if (!info.isTextual) {
    return `[Binary file: ${info.mimeType}, ${formatBytes(buffer.length)}]`;
  }

  const text = buffer.toString("utf-8");

  if (info.mimeType === "text/html") {
    // Basic HTML tag stripping
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return text;
}

// ── Audio tag parsing ──

/**
 * Parse ID3v1 / ID3v2 tags from an MP3 buffer header.
 * Basic implementation — does not parse full ID3 structure.
 */
export function parseAudioTags(buffer: Buffer): AudioTags {
  const tags: AudioTags = {};

  // Check ID3v2 header (first 3 bytes = "ID3")
  if (buffer.length > 10 && buffer.slice(0, 3).toString() === "ID3") {
    // ID3v2 is complex — this is a minimal extraction
    const headerSize = 10;
    const scanLimit = Math.min(buffer.length, headerSize + 512);
    for (let i = headerSize; i + headerSize <= scanLimit;) {
      const frameId = buffer.slice(i, i + 4).toString();
      if (frameId === "\0\0\0\0" || frameId[0] === "\0") break;

      const frameSize = buffer.readUInt32BE(i + 4);
      if (frameSize <= 0 || frameSize > 1024) break;
      if (i + 10 + frameSize > buffer.length) break;

      const frameData = buffer.slice(i + 10, i + 10 + frameSize).toString("utf-8").replace(/\0/g, "");

      switch (frameId) {
        case "TIT2": tags.title = frameData; break;
        case "TPE1": tags.artist = frameData; break;
        case "TALB": tags.album = frameData; break;
      }

      i += 10 + frameSize;
    }
  }

  // WAV header parsing
  if (buffer.length > 44 && buffer.slice(0, 4).toString() === "RIFF") {
    const sampleRate = buffer.readUInt32LE(24);
    const channels = buffer.readUInt16LE(22);
    const bitsPerSample = buffer.readUInt16LE(34);
    const dataSize = buffer.readUInt32LE(40);

    if (sampleRate > 0) {
      tags.sampleRate = sampleRate;
      tags.channels = channels;
      tags.bitrate = sampleRate * channels * bitsPerSample;
      tags.duration = dataSize > 0
        ? dataSize / (sampleRate * channels * (bitsPerSample / 8))
        : undefined;
    }
  }

  return tags;
}

/**
 * Format audio tag information as a readable string.
 */
export function formatAudioTags(tags: AudioTags): string {
  const parts: string[] = [];
  if (tags.title) parts.push(tags.title);
  if (tags.artist) parts.push(`by ${tags.artist}`);
  if (tags.album) parts.push(`(album: ${tags.album})`);
  if (tags.duration) parts.push(`[${formatDuration(tags.duration)}]`);
  if (tags.channels && tags.sampleRate) {
    parts.push(`${tags.channels}ch ${tags.sampleRate}Hz`);
  }
  return parts.join(" ") || "Unknown audio";
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function matchesMagic(buffer: Buffer, magic: number[], offset = 0): boolean {
  if (buffer.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buffer[offset + i] !== magic[i]) return false;
  }
  return true;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}