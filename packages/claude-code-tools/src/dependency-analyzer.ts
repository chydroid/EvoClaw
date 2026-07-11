/**
 * Dependency Analyzer — 项目依赖分析
 *
 * 借鉴 Claude Code 的文件分析能力：
 *   - 解析 package.json 构建依赖图
 *   - 检测循环依赖
 *   - 识别过时/不安全版本
 *   - 分析 workspace 依赖关系
 *
 * 参考: Claude Code 的 Glob + Read 工具组合进行代码分析的模式
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──

export interface DepNode {
  /** Package name */
  name: string;
  /** Version range */
  version: string;
  /** Type: production, dev, peer, optional, workspace */
  type: "prod" | "dev" | "peer" | "optional" | "workspace";
  /** Direct dependencies of this node */
  dependencies: string[];
  /** Whether this is a workspace-local package */
  isWorkspace: boolean;
  /** Package path (for workspace packages) */
  packagePath?: string;
}

export interface DepGraph {
  nodes: Map<string, DepNode>;
  /** Circular dependency chains detected */
  circularDeps: string[][];
  /** Orphan packages (no references) */
  orphans: string[];
  /** Total number of packages */
  totalPackages: number;
}

export interface VulnerabilityCheck {
  packageName: string;
  currentVersion: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  recommendation: string;
}

// ── Analyzer ──

export class DependencyAnalyzer {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.cwd();
  }

  /**
   * Build a complete dependency graph from the monorepo.
   * Parses all workspace packages and their dependencies.
   */
  async buildGraph(): Promise<DepGraph> {
    const nodes = new Map<string, DepNode>();
    const rootPkg = await this.readPackageJson(this.baseDir);

    if (!rootPkg) {
      return { nodes, circularDeps: [], orphans: [], totalPackages: 0 };
    }

    // Parse workspace packages
    const workspacePaths = await this.discoverWorkspaces();
    for (const wsPath of workspacePaths) {
      const pkg = await this.readPackageJson(wsPath);
      if (!pkg) continue;

      const deps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ];

      const prodDeps = Object.keys(pkg.dependencies ?? {});
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      const peerDeps = Object.keys(pkg.peerDependencies ?? {});
      const optionalDeps = Object.keys(pkg.optionalDependencies ?? {});

      nodes.set(pkg.name, {
        name: pkg.name,
        version: pkg.version ?? "0.0.0",
        type: "workspace",
        dependencies: deps,
        isWorkspace: true,
        packagePath: path.relative(this.baseDir, wsPath),
      });

      // Add virtual nodes for external deps
      for (const dep of deps) {
        if (!nodes.has(dep)) {
          const depType = prodDeps.includes(dep) ? "prod"
            : devDeps.includes(dep) ? "dev"
              : peerDeps.includes(dep) ? "peer"
                : optionalDeps.includes(dep) ? "optional"
                  : "prod";

          nodes.set(dep, {
            name: dep,
            version: pkg.dependencies?.[dep]
              ?? pkg.devDependencies?.[dep]
              ?? pkg.peerDependencies?.[dep]
              ?? pkg.optionalDependencies?.[dep]
              ?? "unknown",
            type: depType,
            dependencies: [],
            isWorkspace: false,
          });
        }
      }
    }

    // Detect circular dependencies
    const circularDeps = this.detectCircularDeps(nodes);

    // Find orphan packages
    const allWorkspaceNames = new Set(
      Array.from(nodes.values()).filter((n) => n.isWorkspace).map((n) => n.name),
    );
    const referenced = new Set<string>();
    for (const node of nodes.values()) {
      for (const dep of node.dependencies) {
        referenced.add(dep);
      }
    }
    const orphans = Array.from(allWorkspaceNames).filter((n) => !referenced.has(n));

    return {
      nodes,
      circularDeps,
      orphans,
      totalPackages: nodes.size,
    };
  }

  /**
   * Detect circular dependencies using DFS.
   */
  private detectCircularDeps(nodes: Map<string, DepNode>): string[][] {
    const circular: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function dfs(current: string, path: string[]): void {
      visited.add(current);
      recursionStack.add(current);
      path.push(current);

      const node = nodes.get(current);
      if (node) {
        for (const dep of node.dependencies) {
          if (!visited.has(dep)) {
            dfs(dep, [...path]);
          } else if (recursionStack.has(dep)) {
            // Found a cycle
            const cycleStart = path.indexOf(dep);
            if (cycleStart >= 0) {
              circular.push([...path.slice(cycleStart), dep]);
            }
          }
        }
      }

      recursionStack.delete(current);
    }

    // Only check workspace-local packages
    const workspaceNodes = Array.from(nodes.values()).filter((n) => n.isWorkspace);
    for (const node of workspaceNodes) {
      if (!visited.has(node.name)) {
        dfs(node.name, []);
      }
    }

    return circular;
  }

  /**
   * Discover all workspace package paths.
   */
  async discoverWorkspaces(): Promise<string[]> {
    const paths: string[] = [];

    // Check packages/ and apps/ directories
    const searchDirs = [
      path.join(this.baseDir, "packages"),
      path.join(this.baseDir, "apps"),
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(dir, entry.name);
        const pkgJsonPath = path.join(pkgPath, "package.json");
        if (fs.existsSync(pkgJsonPath)) {
          paths.push(pkgPath);
        }

        // Check nested (scoped packages e.g. packages/@scope/name)
        const nested = fs.readdirSync(pkgPath, { withFileTypes: true });
        for (const n of nested) {
          if (n.isDirectory()) {
            const nestedPkgPath = path.join(pkgPath, n.name, "package.json");
            if (fs.existsSync(nestedPkgPath)) {
              paths.push(path.join(pkgPath, n.name));
            }
          }
        }
      }
    }

    return paths;
  }

  /**
   * Generate a Mermaid-compatible dependency graph.
   */
  async generateMermaidGraph(): Promise<string> {
    const graph = await this.buildGraph();
    const lines: string[] = ["```mermaid", "graph TD"];

    for (const [, node] of graph.nodes) {
      for (const dep of node.dependencies) {
        const style = node.isWorkspace && graph.nodes.get(dep)?.isWorkspace
          ? "-->|workspace|"
          : "-->";
        const sourceName = this.sanitizeName(node.name);
        const targetName = this.sanitizeName(dep);
        lines.push(`  ${sourceName}${style}${targetName}`);
      }
    }

    lines.push("```");

    if (graph.circularDeps.length > 0) {
      lines.push("");
      lines.push(`⚠ Circular dependencies detected:`);
      for (const cycle of graph.circularDeps) {
        lines.push(`  ${cycle.join(" → ")}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Check for known vulnerabilities (basic heuristic).
   * Production use should integrate with npm audit or Snyk API.
   */
  async checkVulnerabilities(): Promise<VulnerabilityCheck[]> {
    const results: VulnerabilityCheck[] = [];

    // Basic heuristics for well-known vulnerable patterns
    const pkgPath = path.join(this.baseDir, "package.json");
    if (!fs.existsSync(pkgPath)) return results;

    const rootPkg = await this.readPackageJson(this.baseDir);
    if (!rootPkg) return results;

    const allDeps = {
      ...rootPkg.dependencies,
      ...rootPkg.devDependencies,
    };

    for (const [name, version] of Object.entries(allDeps)) {
      if (!version) continue;

      // Check for known bad version patterns
      if (typeof version === "string" && version.startsWith("0.0.")) {
        results.push({
          packageName: name,
          currentVersion: version,
          severity: "low",
          description: "Pre-release version — may contain unstable APIs.",
          recommendation: "Upgrade to a stable release (>=1.0.0) if available.",
        });
      }
    }

    return results;
  }

  // ── Helpers ──

  private async readPackageJson(pkgDir: string): Promise<Record<string, any> | null> {
    try {
      const pkgPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pkgPath)) return null;
      return JSON.parse(await fs.promises.readFile(pkgPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private sanitizeName(name: string): string {
    return name.replace(/[@/.-]/g, "_");
  }
}