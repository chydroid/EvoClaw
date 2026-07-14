import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, DEFAULT_PORT } from "../utils/api";

const DOC_TOPICS: Record<string, { file: string; label: string }> = {
  agents: { file: "AGENTS.md", label: "Agent Configuration" },
  soul: { file: "SOUL.md", label: "Soul / Persona" },
  tools: { file: "TOOLS.md", label: "Tool System" },
  identity: { file: "IDENTITY.md", label: "Identity" },
};

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".env"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..", "..", "..");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "win32") {
    cmd = "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    // 安全：使用 spawn(shell:false) 避免 URL 进入 shell 造成命令注入
    const child = child_process.spawn(cmd, args, { shell: false, detached: true, stdio: "ignore" });
    child.on("error", () => { /* ignore */ });
    child.unref();
  } catch { /* ignore */ }
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("docs [topic]")
    .description("Search and display documentation")
    .option("--list", "List available documentation topics")
    .option("--web", "Open online documentation in browser")
    .action(async (topic: string | undefined, opts: Record<string, unknown>) => {
      if (opts.web) {
        const url = topic
          ? `https://github.com/chydroid/EvoClaw/blob/main/docs/${encodeURIComponent(topic)}.md`
          : "https://github.com/chydroid/EvoClaw";
        console.log(c("cyan", `Opening: ${url}`));
        openBrowser(url);
        return;
      }

      if (opts.list) {
        console.log(section("Available Documentation Topics"));
        console.log();

        const rootDir = findProjectRoot();
        const serverAlive = await checkServer();

        if (serverAlive) {
          try {
            const bsRes = await apiRequest<Record<string, unknown>>("GET", "/api/bootstrap");
            const files = (bsRes.data as Record<string, unknown>)?.files as Array<Record<string, unknown>> || [];
            for (const f of files) {
              const exists = f.exists ? c("green", "✓") : c("gray", "○");
              console.log(`  ${exists} ${c("cyan", String(f.name).replace(".md", "").toLowerCase())}  ${c("gray", String(f.description || f.name))}`);
            }
          } catch {
            for (const [key, val] of Object.entries(DOC_TOPICS)) {
              console.log(`  ${ICONS.bullet()} ${c("cyan", key)}  ${c("gray", val.label)}`);
            }
          }
        } else {
          const workspaceDir = path.join(rootDir, "data", "workspace");
          for (const [key, val] of Object.entries(DOC_TOPICS)) {
            const filePath = path.join(workspaceDir, val.file);
            const exists = fs.existsSync(filePath);
            const icon = exists ? c("green", "✓") : c("gray", "○");
            console.log(`  ${icon} ${c("cyan", key)}  ${c("gray", val.label)} ${exists ? "" : c("gray", "(not found)")}`);
          }
        }

        console.log();
        console.log(c("gray", "  Usage: EvoClaw docs <topic>   — Show topic content"));
        console.log(c("gray", "  Usage: EvoClaw docs --web     — Open online docs"));
        return;
      }

      if (!topic) {
        console.log(section("EvoClaw Documentation"));
        console.log(c("gray", "  CLI Reference:     EvoClaw --help"));
        console.log(c("gray", "  GitHub:            https://github.com/chydroid/EvoClaw"));
        console.log(c("gray", "  Skill Hub:         https://clawhub.ai"));
        console.log();
        console.log(c("gray", "  EvoClaw docs --list   List available topics"));
        console.log(c("gray", "  EvoClaw docs agents   Show agent documentation"));
        console.log(c("gray", "  EvoClaw docs --web    Open online docs"));
        return;
      }

      const topicKey = topic.toLowerCase();
      const docInfo = DOC_TOPICS[topicKey];
      const rootDir = findProjectRoot();

      console.log(section(docInfo ? docInfo.label : topic));

      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const fileName = docInfo ? docInfo.file : `${topic}.md`;
          const bsRes = await apiRequest<Record<string, unknown>>("GET", `/api/bootstrap/${fileName}`);
          const content = bsRes.data?.content as string | undefined;
          if (content) {
            console.log(content);
            return;
          }
        } catch {
          // fall through to local file
        }
      }

      const workspaceDir = path.join(rootDir, "data", "workspace");
      const localPath = docInfo
        ? path.join(workspaceDir, docInfo.file)
        : path.join(workspaceDir, `${topic}.md`);

      if (fs.existsSync(localPath)) {
        try {
          const content = fs.readFileSync(localPath, "utf-8");
          console.log(content);
        } catch (err) {
          console.log(c("red", `${ICONS.error()} Could not read file: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        console.log(c("yellow", `${ICONS.warn()} Topic "${topic}" not found locally`));
        console.log(c("gray", "  Try: EvoClaw docs --list to see available topics"));
        console.log(c("gray", "  Try: EvoClaw docs --web to search online"));
      }
    });
}
