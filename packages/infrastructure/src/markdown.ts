/**
 * Markdown Processing Engine — OpenClaw compatibility layer.
 *
 * Processes AI-generated markdown content:
 *   - Code-block fenced extraction & syntax detection
 *   - Frontmatter parsing (YAML-style)
 *   - Table rendering helpers
 *   - Inline formatting (bold, italic, code, links)
 *   - Smart text chunking for context windows
 *
 * This is a lightweight server-side markdown utility used for
 * pre-processing LLM output before channel delivery and for
 * extracting structured data from markdown documents.
 */

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface CodeBlock {
  language: string;
  code: string;
  startLine: number;
  endLine: number;
}

export interface Frontmatter {
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface ParsedMarkdown {
  frontmatter: Frontmatter | null;
  body: string;
  codeBlocks: CodeBlock[];
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  preserveBlocks?: boolean;
}

// ──────────────────────────────────────────────────────────────
// Core API
// ──────────────────────────────────────────────────────────────

/**
 * Parse a markdown document, extracting frontmatter and code blocks.
 */
export function parseMarkdown(raw: string): ParsedMarkdown {
  const lines = raw.split("\n");
  let frontmatter: Frontmatter | null = null;
  let bodyStart = 0;
  const codeBlocks: CodeBlock[] = [];

  // Detect YAML frontmatter (--- ... ---)
  if (lines[0]?.trim() === "---") {
    const endIdx = lines.indexOf("---", 1);
    if (endIdx !== -1) {
      frontmatter = parseFrontmatter(lines.slice(1, endIdx));
      bodyStart = endIdx + 1;
    }
  }

  const body = lines.slice(bodyStart).join("\n");

  // Extract fenced code blocks
  let inBlock = false;
  let blockLang = "";
  let blockLines: string[] = [];
  let blockStart = 0;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,}|~{3,})\s*(\S*)/);
    if (fenceMatch && !inBlock) {
      inBlock = true;
      blockLang = fenceMatch[2] || "";
      blockLines = [];
      blockStart = i;
    } else if (fenceMatch && inBlock) {
      codeBlocks.push({
        language: blockLang,
        code: blockLines.join("\n"),
        startLine: blockStart,
        endLine: i,
      });
      inBlock = false;
    } else if (inBlock) {
      blockLines.push(line);
    }
  }

  // Handle unclosed block
  if (inBlock) {
    codeBlocks.push({
      language: blockLang,
      code: blockLines.join("\n"),
      startLine: blockStart,
      endLine: lines.length - 1,
    });
  }

  return { frontmatter, body, codeBlocks };
}

/**
 * Render bold (**text**) and italic (*text*) markers to ANSI or plain text.
 */
export function stripFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/`(.+?)`/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // links → text only
}

/**
 * Extract all links from a markdown string.
 */
export function extractLinks(text: string): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    links.push({ text: match[1], url: match[2] });
  }
  return links;
}

/**
 * Extract all URLs from a string (both markdown links and bare URLs).
 */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];

  // Markdown links
  for (const link of extractLinks(text)) {
    urls.push(link.url);
  }

  // Bare URLs
  const bareRegex = /https?:\/\/[^\s<>"')\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = bareRegex.exec(text)) !== null) {
    if (!urls.includes(match[0])) {
      urls.push(match[0]);
    }
  }

  return urls;
}

/**
 * Render a simple Markdown table from a 2D array.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
): string {
  const colWidths = headers.map((h, i) => {
    const maxData = Math.max(...rows.map((r) => (r[i] || "").length));
    return Math.max(h.length, maxData);
  });

  const pad = (s: string, w: number) => s.padEnd(w, " ");

  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join(" | ");
  const sep = colWidths.map((w) => "-".repeat(w)).join("-|-");
  const dataLines = rows.map((row) =>
    row.map((cell, i) => pad(cell || "", colWidths[i])).join(" | "),
  );

  return [headerLine, sep, ...dataLines].join("\n");
}

/**
 * Smart chunk: split markdown into semantically coherent chunks
 * suitable for embedding or context-limited processing.
 */
export function chunkMarkdown(
  text: string,
  opts: ChunkOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? 2000;
  const overlapChars = opts.overlapChars ?? 100;
  const preserveBlocks = opts.preserveBlocks ?? true;

  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);

  let current = "";
  let inCodeBlock = false;

  for (const para of paragraphs) {
    // Track fenced blocks to avoid splitting inside them
    const fenceCount = (para.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) inCodeBlock = !inCodeBlock;

    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      if (preserveBlocks && inCodeBlock) {
        // Don't split inside a code block — keep accumulating
        current += para + "\n\n";
      } else {
        chunks.push(current.trimEnd());
        // Overlap: keep last N chars of previous chunk
        current = current.slice(-overlapChars) + para + "\n\n";
      }
    } else {
      current += para + "\n\n";
    }
  }

  if (current.trim()) {
    chunks.push(current.trimEnd());
  }

  return chunks;
}

/**
 * Detect the primary language in a code block.
 */
export function detectLanguage(code: string): string {
  const trimmed = code.trim();
  if (/^\s*(import|export|const|let|function|=>|async|await)\b/.test(trimmed)) return "typescript";
  if (/^\s*(def |class |import |from |print\()/.test(trimmed)) return "python";
  if (/^\s*(package |import |func |go )/.test(trimmed)) return "go";
  if (/^\s*(#include|int main|printf)/.test(trimmed)) return "c";
  if (/^\s*(<[a-z]+|<template|export default)/.test(trimmed)) return "html";
  if (/^\s*(SELECT|INSERT|CREATE TABLE|ALTER TABLE)/i.test(trimmed)) return "sql";
  if (/^\s*(\{|\[).*[\]:].*(,|\})\s*$/.test(trimmed)) return "json";
  return "text";
}

// ──────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────

function parseFrontmatter(lines: string[]): Frontmatter {
  const fm: Frontmatter = {};
  let currentKey = "";

  for (const line of lines) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      // Remove surrounding quotes
      const cleaned = value.replace(/^["']|["']$/g, "");
      // Detect array
      if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
        fm[key] = cleaned
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      } else {
        fm[key] = cleaned;
      }
      currentKey = key;
    } else if (currentKey && line.trim()) {
      // Multiline array continuation
      const trimmed = line.trim();
      const existing = fm[currentKey];
      if (Array.isArray(existing)) {
        existing.push(trimmed.replace(/^-\s*/, "").replace(/^["']|["']$/g, ""));
      }
    }
  }

  return fm;
}