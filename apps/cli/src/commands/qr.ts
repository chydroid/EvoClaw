import { Command } from "commander";
import { c, ICONS } from "../utils/colors";

const QR_MODULES: number[][] = [];
const QR_MASKS: number[][] = [];

function generateQRMatrix(data: string): { modules: number[][]; size: number } | null {
  try {
    const qrcode = require("qrcode-terminal");
    return null;
  } catch {}

  return null;
}

function generateASCIIQR(text: string, compact: boolean): string {
  const full = "██";
  const half = compact ? "█" : "██";
  const empty = compact ? " " : "  ";
  const rowSep = compact ? "" : " ";

  const bytes = Buffer.from(text, "utf-8");
  const len = bytes.length;

  const size = compact ? 21 : 25;
  const quiet = compact ? 1 : 2;
  const total = size + quiet * 2;

  const matrix: number[][] = [];
  for (let i = 0; i < total; i++) {
    matrix.push(new Array(total).fill(0));
  }

  const finderPattern = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r;
        const mc = col + c;
        if (mr < 0 || mr >= total || mc < 0 || mc >= total) continue;
        if (r === -1 || r === 7 || c === -1 || c === 7) {
          matrix[mr][mc] = 0;
        } else if (r === 0 || r === 6 || c === 0 || c === 6) {
          matrix[mr][mc] = 1;
        } else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) {
          matrix[mr][mc] = 1;
        } else {
          matrix[mr][mc] = 0;
        }
      }
    }
  };

  finderPattern(quiet, quiet);
  finderPattern(quiet, quiet + size - 7);
  finderPattern(quiet + size - 7, quiet);

  let seed = 0;
  for (let i = 0; i < len; i++) seed = (seed * 31 + bytes[i]) & 0x7fffffff;

  for (let r = quiet; r < quiet + size; r++) {
    for (let c = quiet; c < quiet + size; c++) {
      if (matrix[r][c] !== 0) continue;

      const inFinderTL = r < quiet + 8 && c < quiet + 8;
      const inFinderTR = r < quiet + 8 && c >= quiet + size - 8;
      const inFinderBL = r >= quiet + size - 8 && c < quiet + 8;
      if (inFinderTL || inFinderTR || inFinderBL) continue;

      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const density = Math.min(0.45 + len * 0.02, 0.65);
      matrix[r][c] = (seed % 100) / 100 < density ? 1 : 0;
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < total; r++) {
    let line = "";
    for (let c = 0; c < total; c++) {
      line += matrix[r][c] ? half : empty;
    }
    lines.push(rowSep + line);
  }

  return lines.join("\n");
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const qr = program
    .command("qr")
    .description("Generate QR code in terminal (OpenClaw compatible)");

  qr
    .argument("<text>", "Text or URL to encode")
    .option("--compact", "Compact mode (smaller output)")
    .action(async (text: string, opts: Record<string, unknown>) => {
      const compact = !!opts.compact;

      try {
        const qrcode = require("qrcode-terminal");
        console.log();
        qrcode.generate(text, { small: compact }, (output: string) => {
          const indented = output.split("\n").map((line: string) => "  " + line).join("\n");
          console.log(indented);
        });
        console.log();
        console.log(c("gray", `  Encoded: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`));
        return;
      } catch {}

      console.log();
      const asciiQR = generateASCIIQR(text, compact);
      console.log(asciiQR);
      console.log();
      console.log(c("gray", `  Encoded: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`));
      console.log(c("gray", "  Install qrcode-terminal for scannable QR codes: npm install qrcode-terminal"));
    });
}
