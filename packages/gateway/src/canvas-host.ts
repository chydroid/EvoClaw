import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

export interface CanvasFile {
  filename: string;
  content: string;
  updatedAt: number;
}

export interface CanvasProject {
  id: string;
  name: string;
  files: CanvasFile[];
  createdAt: number;
  updatedAt: number;
}

export class CanvasHost extends EventEmitter {
  private rootDir: string;
  private projects: Map<string, CanvasProject> = new Map();
  private watchers: Map<string, fs.FSWatcher> = new Map();

  constructor(rootDir?: string) {
    super();
    this.rootDir = rootDir || path.join(os.homedir(), ".evoclaw", "canvas");
    this.ensureRootDir();
    this.loadProjects();
  }

  private ensureRootDir(): void {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
    } catch (err) {
      process.stderr.write("[CanvasHost] Failed to create root dir:" + " " + err + "\n");
    }
  }

  private loadProjects(): void {
    try {
      const dirs = fs.readdirSync(this.rootDir);
      for (const dir of dirs) {
        const projectPath = path.join(this.rootDir, dir);
        if (fs.statSync(projectPath).isDirectory()) {
          this.loadProject(dir, projectPath);
        }
      }
    } catch (err) {
      process.stderr.write("[CanvasHost] Failed to load projects:" + " " + err + "\n");
    }
  }

  private loadProject(id: string, projectPath: string): void {
    const files: CanvasFile[] = [];
    try {
      const entries = fs.readdirSync(projectPath);
      for (const entry of entries) {
        const filePath = path.join(projectPath, entry);
        if (fs.statSync(filePath).isFile()) {
          files.push({
            filename: entry,
            content: fs.readFileSync(filePath, "utf-8"),
            updatedAt: fs.statSync(filePath).mtimeMs,
          });
        }
      }
    } catch (err) {
      process.stderr.write(`[CanvasHost] Failed to load project ${id}:` + " " + err + "\n");
    }
    this.projects.set(id, {
      id,
      name: id,
      files,
      createdAt: files.reduce((min, f) => Math.min(min, f.updatedAt), Date.now()),
      updatedAt: files.reduce((max, f) => Math.max(max, f.updatedAt), 0),
    });
  }

  createProject(name: string, html?: string): CanvasProject {
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-" + Date.now().toString(36);
    const projectDir = path.join(this.rootDir, id);
    fs.mkdirSync(projectDir, { recursive: true });
    const defaultHtml = html || this.defaultIndexHtml(name);
    fs.writeFileSync(path.join(projectDir, "index.html"), defaultHtml, "utf-8");
    this.loadProject(id, projectDir);
    const project = this.projects.get(id)!;
    this.emit("project-created", project);
    return project;
  }

  getProject(id: string): CanvasProject | undefined {
    return this.projects.get(id);
  }

  listProjects(): CanvasProject[] {
    return Array.from(this.projects.values());
  }

  writeFile(projectId: string, filename: string, content: string): boolean {
    const project = this.projects.get(projectId);
    if (!project) return false;
    const projectDir = path.join(this.rootDir, projectId);
    const safeName = path.basename(filename);
    if (safeName !== filename || filename.includes("..")) return false;
    const filePath = path.join(projectDir, safeName);
    try {
      fs.writeFileSync(filePath, content, "utf-8");
      this.loadProject(projectId, projectDir);
      this.emit("file-changed", { projectId, filename });
      return true;
    } catch (err) {
      process.stderr.write(`[CanvasHost] Failed to write file ${filename}:` + " " + err + "\n");
      return false;
    }
  }

  readFile(projectId: string, filename: string): string | null {
    const projectDir = path.join(this.rootDir, projectId);
    const safeName = path.basename(filename);
    const filePath = path.join(projectDir, safeName);
    try {
      const resolved = fs.realpathSync(filePath);
      if (!resolved.startsWith(fs.realpathSync(projectDir))) return null;
      return fs.readFileSync(resolved, "utf-8");
    } catch {
      return null;
    }
  }

  deleteProject(id: string): boolean {
    const projectDir = path.join(this.rootDir, id);
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
      this.projects.delete(id);
      this.emit("project-deleted", id);
      return true;
    } catch {
      return false;
    }
  }

  evalScript(projectId: string, script: string): { success: boolean; error?: string } {
    this.emit("eval-request", { projectId, script });
    return { success: true };
  }

  snapshot(projectId: string): CanvasProject | null {
    return this.projects.get(projectId) || null;
  }

  private defaultIndexHtml(name: string): string {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; padding: 40px; }
    h1 { font-size: 28px; margin-bottom: 12px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { color: #94a3b8; font-size: 14px; }
    .badge { display: inline-block; margin-top: 16px; padding: 4px 12px; background: #1e293b; border-radius: 12px; font-size: 12px; color: #60a5fa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${name}</h1>
    <p>Agent 驱动的可视化工作区</p>
    <div class="badge">EvoClaw Canvas</div>
  </div>
</body>
</html>`;
  }

  close(): void {
    for (const [_, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.removeAllListeners();
  }
}
