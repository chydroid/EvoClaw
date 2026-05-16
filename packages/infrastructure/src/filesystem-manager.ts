import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { readFile, writeFile, unlink, access, mkdir, readdir } from "fs/promises";
import { constants } from "fs";

interface FileInfo {
  path: string;
  size: number;
  modifiedAt: Date;
  createdAt: Date;
}

export class FileSystemManager {
  private basePath = ".";

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("fileSystemManager", this);
  }

  setBasePath(path: string): void {
    this.basePath = path;
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolvePath(relativePath);
    return readFile(fullPath, "utf-8");
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await this.ensureDir(relativePath);
    await writeFile(fullPath, content, "utf-8");
  }

  async deleteFile(relativePath: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await unlink(fullPath);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await access(this.resolvePath(relativePath), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(relativePath: string): Promise<void> {
    const parts = relativePath.split("/");
    const dirs = parts.slice(0, -1).join("/");

    if (dirs) {
      await mkdir(this.resolvePath(dirs), { recursive: true });
    }
  }

  async listDir(relativePath: string): Promise<FileInfo[]> {
    const fullPath = this.resolvePath(relativePath);
    const entries = await readdir(fullPath, { withFileTypes: true });

    return entries.map((entry) => ({
      path: `${relativePath}/${entry.name}`,
      size: 0,
      modifiedAt: new Date(),
      createdAt: new Date(),
    }));
  }

  async listAll(
    relativePath: string
  ): Promise<{ files: FileInfo[]; dirs: string[] }> {
    const fullPath = this.resolvePath(relativePath);
    const entries = await readdir(fullPath, { withFileTypes: true });

    const files: FileInfo[] = [];
    const dirs: string[] = [];

    for (const entry of entries) {
      const relPath = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(relPath);
      } else {
        files.push({
          path: relPath,
          size: 0,
          modifiedAt: new Date(),
          createdAt: new Date(),
        });
      }
    }

    return { files, dirs };
  }

  private resolvePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/");
    return `${this.basePath}/${normalized}`.replace(/\/+/g, "/");
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}