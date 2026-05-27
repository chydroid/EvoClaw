/** Color formatting for CLI output. Respects NO_COLOR / --no-color. */
let useColor = true;

export type CliColor = "red" | "green" | "yellow" | "blue" | "cyan" | "gray" | "bold" | "magenta" | "dim";

const codes: Record<CliColor, string> = {
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m", bold: "\x1b[1m",
  magenta: "\x1b[35m", dim: "\x1b[2m",
};

export function c(color: CliColor, text: string): string {
  if (!useColor) return text;
  return `${codes[color]}${text}\x1b[0m`;
}

export function setColorEnabled(enabled: boolean): void { useColor = enabled; }
export function isColorEnabled(): boolean { return useColor; }

export const ICONS = {
  ok: () => c("green", "✓"),
  error: () => c("red", "✗"),
  warn: () => c("yellow", "⚠"),
  info: () => c("blue", "ℹ"),
  bullet: () => c("cyan", "●"),
  arrow: () => c("gray", "→"),
  tip: () => c("yellow", "💡"),
  star: () => c("yellow", "★"),
  dash: () => c("gray", "—"),
  rock: "🦞",
};

export function divider(): string {
  return useColor ? `\x1b[36m${"\u2500".repeat(50)}\x1b[0m` : "\u2500".repeat(50);
}

export function section(title: string): string {
  if (!useColor) return `\n=== ${title} ===\n`;
  return `\n\x1b[1m\x1b[36m${"=".repeat(50)}\x1b[0m\n\x1b[1m  ${title}\x1b[0m\n\x1b[1m\x1b[36m${"=".repeat(50)}\x1b[0m\n`;
}