// ─── Document Chunker for RAG ────────────────────────────────────────────────

export interface ChunkOptions {
  /** Maximum chunk size in characters. Default: 512 */
  maxChunkSize?: number;
  /** Overlap between chunks in characters. Default: 64 */
  overlap?: number;
  /** Chunking strategy. Default: 'paragraph' */
  strategy?: "fixed" | "paragraph" | "sentence";
  /** Minimum chunk size. Chunks smaller than this are merged. Default: 50 */
  minChunkSize?: number;
}

export interface DocumentChunk {
  /** The chunk text content */
  text: string;
  /** 0-based index of this chunk in the document */
  index: number;
  /** Start offset in the original document */
  startOffset: number;
  /** End offset in the original document */
  endOffset: number;
  /** Optional metadata */
  metadata: Record<string, unknown>;
}

const DEFAULT_MAX_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 64;
const DEFAULT_STRATEGY: ChunkOptions["strategy"] = "paragraph";
const DEFAULT_MIN_CHUNK_SIZE = 50;

/**
 * Split a document into chunks based on the specified strategy.
 */
export function chunkDocument(
  text: string,
  options?: ChunkOptions
): DocumentChunk[] {
  const maxChunkSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;
  const strategy = options?.strategy ?? DEFAULT_STRATEGY;
  const minChunkSize = options?.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;

  let rawChunks: { text: string; startOffset: number; endOffset: number }[];

  switch (strategy) {
    case "fixed":
      rawChunks = chunkFixed(text, maxChunkSize, overlap);
      break;
    case "paragraph":
      rawChunks = chunkParagraph(text, maxChunkSize, overlap, minChunkSize);
      break;
    case "sentence":
      rawChunks = chunkSentence(text, maxChunkSize, overlap, minChunkSize);
      break;
    default:
      rawChunks = chunkParagraph(text, maxChunkSize, overlap, minChunkSize);
  }

  // Merge small chunks with the previous one
  const merged = mergeSmallChunks(rawChunks, minChunkSize);

  // Assign indices
  return merged.map((chunk, i) => ({
    text: chunk.text,
    index: i,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    metadata: {},
  }));
}

// ─── Fixed Strategy ──────────────────────────────────────────────────────────

function chunkFixed(
  text: string,
  maxChunkSize: number,
  overlap: number
): { text: string; startOffset: number; endOffset: number }[] {
  const chunks: { text: string; startOffset: number; endOffset: number }[] = [];
  const step = maxChunkSize - overlap;
  if (step <= 0) {
    // If overlap >= maxChunkSize, just use maxChunkSize as step
    return [{ text, startOffset: 0, endOffset: text.length }];
  }

  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxChunkSize, text.length);
    chunks.push({
      text: text.slice(pos, end),
      startOffset: pos,
      endOffset: end,
    });
    if (end >= text.length) break;
    pos += step;
  }

  return chunks;
}

// ─── Paragraph Strategy ──────────────────────────────────────────────────────

function chunkParagraph(
  text: string,
  maxChunkSize: number,
  overlap: number,
  minChunkSize: number
): { text: string; startOffset: number; endOffset: number }[] {
  // Split on double newlines
  const segments = splitPreservingOffsets(text, /\n\n+/);

  // Merge small paragraphs
  const merged = mergeSmallSegments(segments, minChunkSize);

  // Split oversized paragraphs using fixed strategy
  const result: { text: string; startOffset: number; endOffset: number }[] =
    [];
  for (const seg of merged) {
    if (seg.text.length <= maxChunkSize) {
      result.push(seg);
    } else {
      // Split oversized segment with fixed strategy, relative offsets
      const subChunks = chunkFixed(seg.text, maxChunkSize, overlap);
      for (const sub of subChunks) {
        result.push({
          text: sub.text,
          startOffset: seg.startOffset + sub.startOffset,
          endOffset: seg.startOffset + sub.endOffset,
        });
      }
    }
  }

  return result;
}

// ─── Sentence Strategy ───────────────────────────────────────────────────────

// Sentence boundary pattern: matches . ! ? 。！？ followed by space, end of string, or CJK character
const SENTENCE_BOUNDARY = /([.!?。！？；])(?:\s+|$|[\u4e00-\u9fff\u3400-\u4dbf])/;

function chunkSentence(
  text: string,
  maxChunkSize: number,
  overlap: number,
  minChunkSize: number
): { text: string; startOffset: number; endOffset: number }[] {
  const segments = splitSentences(text);

  // Merge small sentences
  const merged = mergeSmallSegments(segments, minChunkSize);

  // Split oversized segments using fixed strategy
  const result: { text: string; startOffset: number; endOffset: number }[] =
    [];
  for (const seg of merged) {
    if (seg.text.length <= maxChunkSize) {
      result.push(seg);
    } else {
      const subChunks = chunkFixed(seg.text, maxChunkSize, overlap);
      for (const sub of subChunks) {
        result.push({
          text: sub.text,
          startOffset: seg.startOffset + sub.startOffset,
          endOffset: seg.startOffset + sub.endOffset,
        });
      }
    }
  }

  return result;
}

/**
 * Split text into sentences, preserving offsets.
 * Keeps the trailing punctuation and whitespace with the sentence.
 */
function splitSentences(
  text: string
): { text: string; startOffset: number; endOffset: number }[] {
  const segments: { text: string; startOffset: number; endOffset: number }[] =
    [];
  let lastEnd = 0;

  let match: RegExpExecArray | null;
  // We need to iterate over all matches to find split points
  const regex = new RegExp(SENTENCE_BOUNDARY.source, "g");
  while ((match = regex.exec(text)) !== null) {
    // The sentence ends after the punctuation + following whitespace
    const boundaryEnd = match.index + match[0].length;
    if (boundaryEnd > lastEnd) {
      segments.push({
        text: text.slice(lastEnd, boundaryEnd),
        startOffset: lastEnd,
        endOffset: boundaryEnd,
      });
    }
    lastEnd = boundaryEnd;
  }

  // Remaining text after last boundary
  if (lastEnd < text.length) {
    const remaining = text.slice(lastEnd).trim();
    if (remaining.length > 0) {
      segments.push({
        text: text.slice(lastEnd),
        startOffset: lastEnd,
        endOffset: text.length,
      });
    }
  }

  // If no sentences found, return the whole text as one segment
  if (segments.length === 0 && text.length > 0) {
    segments.push({ text, startOffset: 0, endOffset: text.length });
  }

  return segments;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split text by a regex pattern, preserving character offsets.
 */
function splitPreservingOffsets(
  text: string,
  pattern: RegExp
): { text: string; startOffset: number; endOffset: number }[] {
  const segments: { text: string; startOffset: number; endOffset: number }[] =
    [];
  let lastEnd = 0;

  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastEnd) {
      segments.push({
        text: text.slice(lastEnd, match.index),
        startOffset: lastEnd,
        endOffset: match.index,
      });
    }
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < text.length) {
    segments.push({
      text: text.slice(lastEnd),
      startOffset: lastEnd,
      endOffset: text.length,
    });
  }

  return segments;
}

/**
 * Merge consecutive small segments into larger ones.
 */
function mergeSmallSegments(
  segments: { text: string; startOffset: number; endOffset: number }[],
  minChunkSize: number
): { text: string; startOffset: number; endOffset: number }[] {
  if (segments.length === 0) return [];

  const result: { text: string; startOffset: number; endOffset: number }[] =
    [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    if (current.text.length < minChunkSize) {
      // Merge with next segment
      current.text += segments[i].text;
      current.endOffset = segments[i].endOffset;
    } else {
      result.push(current);
      current = { ...segments[i] };
    }
  }

  // Push the last accumulated segment
  result.push(current);

  return result;
}

/**
 * Merge small chunks (post-split) with the previous chunk.
 */
function mergeSmallChunks(
  chunks: { text: string; startOffset: number; endOffset: number }[],
  minChunkSize: number
): { text: string; startOffset: number; endOffset: number }[] {
  if (chunks.length === 0) return [];

  const result: { text: string; startOffset: number; endOffset: number }[] =
    [];

  for (const chunk of chunks) {
    if (
      result.length > 0 &&
      chunk.text.length < minChunkSize
    ) {
      // Merge with previous chunk
      const prev = result[result.length - 1];
      prev.text += chunk.text;
      prev.endOffset = chunk.endOffset;
    } else {
      result.push({ ...chunk });
    }
  }

  return result;
}
