/**
 * verify/recipes — 项目验证配方静态检测。
 *
 * 对标 hermes-agent agent/verify/recipes.py（ported from grok-cli src/verify/recipes.ts）：
 *   静态检测项目的框架、bootstrap/build/test 命令、start 命令、端口、readiness 路径，
 *   让验证运行器能 boot 项目并检查 readiness。
 *
 * 检测顺序（与 hermes 一致）：
 *   package.json → Python → Go/Rust → Java → Makefile → docker-compose
 */

import * as path from "node:path";
import * as fs from "node:fs";

// ── 类型 ──────────────────────────────────────────────

/** 可运行的验证配方：name 是人类标签，kind 是检测器 ID */
export interface Recipe {
  name: string;
  kind: string;
  bootstrap: string[];
  build: string[];
  test: string[];
  start: string | null;
  port: number | null;
  readinessPath: string;
  evidence: string[];
}

// ── 辅助函数 ─────────────────────────────────────────

function asStrings(value: unknown): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function readText(root: string, name: string): string | null {
  try {
    // Node 运行时支持 utf-8-sig（去 BOM），但 TS 类型未覆盖；用 utf8 读取后手动去 BOM
    const text = fs.readFileSync(path.join(root, name), "utf8");
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  } catch {
    return null;
  }
}

function readPackageJson(root: string): Record<string, unknown> | null {
  const text = readText(root, "package.json");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function firstExisting(root: string, names: string[]): string | null {
  for (const n of names) {
    if (fs.existsSync(path.join(root, n))) return n;
  }
  return null;
}

// ── 包管理器检测 ─────────────────────────────────────

const LOCKFILE_MANAGERS: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
];

function detectPackageManager(root: string): string | null {
  for (const [file, manager] of LOCKFILE_MANAGERS) {
    if (fs.existsSync(path.join(root, file))) return manager;
  }
  return null;
}

// ── 端口推断 ──────────────────────────────────────────

function inferPortFromCommand(command: string | null): number | null {
  if (!command) return null;
  const m1 = command.match(/(?:--port|-p)\s+(\d{2,5})/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = command.match(/\bPORT=(\d{2,5})\b/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function dedupe(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())));
}

// ── Node 框架检测 ────────────────────────────────────

const SCRIPT_RUNNERS: Record<string, string> = { pnpm: "pnpm {}", bun: "bun run {}", yarn: "yarn {}" };
const NODE_INSTALL: Record<string, string> = { pnpm: "pnpm install", bun: "bun install", yarn: "yarn install" };

// 有序：第一个存在的依赖决定框架（kind, label, 默认端口）
const NODE_FRAMEWORKS: Array<[string[], string, string, number | null]> = [
  [["next"], "nextjs", "Next.js", 3000],
  [["@sveltejs/kit"], "sveltekit", "SvelteKit", 5173],
  [["astro"], "astro", "Astro", 4321],
  [["@remix-run/dev", "@remix-run/react"], "remix", "Remix", 3000],
  [["react-scripts"], "cra", "Create React App", 3000],
  [["vite"], "vite", "Vite", 5173],
];

function scriptRunner(pm: string | null, entry: string): string {
  const template = SCRIPT_RUNNERS[pm ?? ""] ?? "npm run {}";
  return template.replace("{}", entry);
}

function detectNodeRecipe(root: string, pkg: Record<string, unknown>): Recipe {
  const rawScripts = pkg.scripts;
  const scripts = typeof rawScripts === "object" && rawScripts !== null ? rawScripts as Record<string, string> : {};
  const deps: Record<string, unknown> = {};
  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    if (typeof section === "object" && section !== null) Object.assign(deps, section);
  }

  const pm = detectPackageManager(root);
  const matched = NODE_FRAMEWORKS.find(([names]) => names.some((n) => n in deps));
  const kind = matched ? matched[1] : "node";
  const label = matched ? matched[2] : "Node.js app";
  const defaultPort = matched ? matched[3] : null;

  const runners = (...names: string[]): string[] =>
    dedupe(names.filter((s) => scripts[s]).map((s) => scriptRunner(pm, s)));

  const startScript = (["dev", "start"] as const).find((s) => scripts[s]) ?? null;
  return {
    name: label,
    kind,
    start: startScript ? runners(startScript)[0] ?? null : null,
    port: startScript ? (inferPortFromCommand(scripts[startScript] ?? null) ?? defaultPort) : null,
    bootstrap: [NODE_INSTALL[pm ?? ""] ?? "npm install"],
    build: runners("build", "typecheck"),
    test: runners("test", "check", "lint"),
    readinessPath: "/",
    evidence: dedupe([
      "Detected package.json",
      pm ? `Package manager: ${pm}` : null,
      `Scripts: ${Object.keys(scripts).join(", ") || "(none)"}`,
    ]),
  };
}

// ── Python 框架检测 ───────────────────────────────────

const PYTHON_INSTALL: Record<string, string> = { uv: "uv sync", poetry: "poetry install", pipenv: "pipenv install" };

function detectPythonRecipe(root: string): Recipe | null {
  const pyproject = readText(root, "pyproject.toml");
  const requirements = readText(root, "requirements.txt");
  const hasManagePy = fs.existsSync(path.join(root, "manage.py"));
  const hasSetupPy = fs.existsSync(path.join(root, "setup.py"));
  if (!pyproject && !requirements && !hasManagePy && !hasSetupPy) return null;

  const lower = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  const pm = detectPackageManager(root);
  const install = PYTHON_INSTALL[pm ?? ""] ?? (pyproject && !requirements ? "pip install -e ." : "pip install -r requirements.txt");
  const pytestOrEmpty = fs.existsSync(path.join(root, "tests")) ? ["pytest"] : [];

  // 优先级：Django → FastAPI/uvicorn → Flask → 通用
  if (hasManagePy || lower.includes("django")) {
    return {
      name: "Django app",
      kind: "django",
      bootstrap: [install],
      build: [],
      test: ["python manage.py test"],
      start: "python manage.py runserver 0.0.0.0:8000",
      port: 8000,
      readinessPath: "/",
      evidence: dedupe([
        hasManagePy ? "Detected manage.py" : "Detected Django dependency",
        pyproject ? "Detected pyproject.toml" : null,
      ]),
    };
  }
  if (lower.includes("fastapi") || lower.includes("uvicorn")) {
    const appModule = (firstExisting(root, ["main.py", "app.py"]) ?? "main.py").replace(/\.py$/, "") + ":app";
    return {
      name: "FastAPI app",
      kind: "fastapi",
      bootstrap: [install],
      build: [],
      test: pytestOrEmpty,
      start: `uvicorn ${appModule} --host 0.0.0.0 --port 8000`,
      port: 8000,
      readinessPath: "/",
      evidence: ["Detected Python project", "Detected FastAPI/Uvicorn dependency"],
    };
  }
  if (lower.includes("flask")) {
    const appModule = firstExisting(root, ["app.py", "main.py"]) ?? "app.py";
    return {
      name: "Flask app",
      kind: "flask",
      bootstrap: [install],
      build: [],
      test: pytestOrEmpty,
      start: `flask --app ${appModule} run --host 0.0.0.0 --port 5000`,
      port: 5000,
      readinessPath: "/",
      evidence: ["Detected Python project", "Detected Flask dependency"],
    };
  }
  return {
    name: "Python project",
    kind: "python",
    bootstrap: [install],
    build: [],
    test: pytestOrEmpty.length > 0 ? pytestOrEmpty : ["python -m unittest discover"],
    start: null,
    port: null,
    readinessPath: "/",
    evidence: ["Detected Python project"],
  };
}

// ── 简单工具链检测 ───────────────────────────────────

const SIMPLE_TOOLCHAINS: Array<[string, string, string, string, string, string, string]> = [
  ["go.mod", "Go project", "go", "go build ./...", "go test ./...", "go run .", "main.go"],
  ["Cargo.toml", "Rust project", "rust", "cargo build", "cargo test", "cargo run", "src/main.rs"],
];

function detectSimpleRecipe(root: string): Recipe | null {
  for (const [manifest, label, kind, build, test, start, entry] of SIMPLE_TOOLCHAINS) {
    if (fs.existsSync(path.join(root, manifest))) {
      return {
        name: label,
        kind,
        build: [build],
        test: [test],
        start: fs.existsSync(path.join(root, entry)) ? start : null,
        port: null,
        readinessPath: "/",
        bootstrap: [],
        evidence: [`Detected ${manifest}`],
      };
    }
  }
  return null;
}

// ── Java 检测 ────────────────────────────────────────

function detectJavaRecipe(root: string): Recipe | null {
  if (fs.existsSync(path.join(root, "pom.xml"))) {
    return {
      name: "Maven project",
      kind: "maven",
      bootstrap: [],
      build: ["mvn package"],
      test: ["mvn test"],
      start: null,
      port: null,
      readinessPath: "/",
      evidence: ["Detected pom.xml"],
    };
  }
  const gradleFile = firstExisting(root, ["build.gradle", "build.gradle.kts"]);
  if (gradleFile) {
    const gradle = fs.existsSync(path.join(root, "gradlew")) ? "./gradlew" : "gradle";
    return {
      name: "Gradle project",
      kind: "gradle",
      bootstrap: [],
      build: [`${gradle} build`],
      test: [`${gradle} test`],
      start: null,
      port: null,
      readinessPath: "/",
      evidence: ["Detected Gradle build file"],
    };
  }
  return null;
}

// ── Makefile 检测 ────────────────────────────────────

const MAKE_TARGET_RE = /^([A-Za-z0-9_.-]+):(?:\s|$)/;

const MAKE_PHASE_TARGETS: Record<string, string[]> = {
  bootstrap: ["install", "setup", "bootstrap"],
  build: ["build", "compile"],
  test: ["test", "check"],
  start: ["run", "start", "serve", "dev"],
};

function detectMakeRecipe(root: string): Recipe | null {
  const makefile = readText(root, "Makefile");
  if (!makefile) return null;
  const targets = makefile.split("\n").map((line) => MAKE_TARGET_RE.exec(line)?.[1]).filter((m): m is string => !!m);
  const picked: Record<string, string[]> = {};
  for (const [phase, names] of Object.entries(MAKE_PHASE_TARGETS)) {
    picked[phase] = names.filter((n) => targets.includes(n)).map((n) => `make ${n}`).slice(0, 1);
  }
  return {
    name: "Makefile-driven project",
    kind: "make",
    start: picked.start?.[0] ?? null,
    bootstrap: picked.bootstrap,
    build: picked.build,
    test: picked.test,
    port: null,
    readinessPath: "/",
    evidence: ["Detected Makefile", `Targets: ${targets.join(", ") || "(none)"}`],
  };
}

// ── docker-compose 检测 ───────────────────────────────

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

function detectComposeRecipe(root: string): Recipe | null {
  const composeFile = firstExisting(root, COMPOSE_FILES);
  if (!composeFile) return null;
  return {
    name: "docker-compose project",
    kind: "compose",
    build: ["docker compose build"],
    start: "docker compose up",
    bootstrap: [],
    test: [],
    port: null,
    readinessPath: "/",
    evidence: [`Detected ${composeFile}`],
  };
}

// ── 主入口 ────────────────────────────────────────────

/**
 * 检测项目的验证配方。
 * 检测顺序：package.json → Python → Go/Rust → Java → Makefile → docker-compose
 */
export function detectRecipe(root: string): Recipe | null {
  const pkg = readPackageJson(root);
  if (pkg) return detectNodeRecipe(root, pkg);
  return (
    detectPythonRecipe(root) ??
    detectSimpleRecipe(root) ??
    detectJavaRecipe(root) ??
    detectMakeRecipe(root) ??
    detectComposeRecipe(root)
  );
}

// ── 序列化 ────────────────────────────────────────────

export function recipeToDict(r: Recipe): Record<string, unknown> {
  return {
    name: r.name,
    kind: r.kind,
    bootstrap: [...r.bootstrap],
    build: [...r.build],
    test: [...r.test],
    start: r.start,
    port: r.port,
    readinessPath: r.readinessPath,
    evidence: [...r.evidence],
  };
}

export function recipeFromDict(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  const kind = typeof obj.kind === "string" && obj.kind.trim() ? obj.kind.trim() : "unknown";
  const start = typeof obj.start === "string" && obj.start.trim() ? obj.start.trim() : null;
  const portRaw = obj.port;
  const port = typeof portRaw === "number" && portRaw > 0 && portRaw < 65536 ? portRaw : null;
  const readiness = typeof obj.readinessPath === "string" && obj.readinessPath.startsWith("/") ? obj.readinessPath : "/";
  return {
    name,
    kind,
    start,
    port,
    readinessPath: readiness,
    bootstrap: asStrings(obj.bootstrap),
    build: asStrings(obj.build),
    test: asStrings(obj.test),
    evidence: asStrings(obj.evidence),
  };
}
