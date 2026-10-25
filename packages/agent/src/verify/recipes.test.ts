/**
 * verify/recipes.test — 项目配方检测测试。
 *
 * 覆盖：Node.js（package.json + 各种框架）、Python（Django/FastAPI/Flask/通用）、
 * Go/Rust/Java/Makefile/docker-compose 检测，以及 manifest 序列化往返。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { detectRecipe, recipeToDict, recipeFromDict, getRecipe, saveManifest, loadManifest } from "../verify";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-verify-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("verify/recipes — detectRecipe", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("detects Node.js project with pnpm", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "test",
      scripts: { dev: "next dev", build: "next build", test: "jest" },
      dependencies: { next: "14.0.0" },
    }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("nextjs");
    expect(recipe!.name).toBe("Next.js");
    expect(recipe!.port).toBe(3000);
    expect(recipe!.bootstrap).toContain("pnpm install");
    expect(recipe!.build).toContain("pnpm build");
  });

  it("detects Node.js project with vite", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "test",
      scripts: { dev: "vite", build: "vite build", test: "vitest" },
      dependencies: { vite: "5.0.0" },
    }));
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("vite");
    expect(recipe!.port).toBe(5173);
  });

  it("detects Django project", () => {
    fs.writeFileSync(path.join(dir, "manage.py"), "# Django");
    fs.writeFileSync(path.join(dir, "requirements.txt"), "Django==4.2.0\n");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("django");
    expect(recipe!.start).toContain("runserver");
    expect(recipe!.port).toBe(8000);
  });

  it("detects FastAPI project", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\ndependencies = ['fastapi', 'uvicorn']\n");
    fs.writeFileSync(path.join(dir, "main.py"), "app = FastAPI()\n");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("fastapi");
    expect(recipe!.start).toContain("uvicorn");
    expect(recipe!.port).toBe(8000);
  });

  it("detects Flask project", () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "Flask==2.3.0\n");
    fs.writeFileSync(path.join(dir, "app.py"), "app = Flask(__name__)\n");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("flask");
    expect(recipe!.start).toContain("flask");
    expect(recipe!.port).toBe(5000);
  });

  it("detects Go project", () => {
    fs.writeFileSync(path.join(dir, "go.mod"), "module test\n");
    fs.writeFileSync(path.join(dir, "main.go"), "package main\nfunc main() {}\n");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("go");
    expect(recipe!.build).toContain("go build ./...");
    expect(recipe!.test).toContain("go test ./...");
  });

  it("detects Rust project", () => {
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"test\"\n");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/main.rs"), "fn main() {}");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("rust");
    expect(recipe!.build).toContain("cargo build");
  });

  it("detects Maven project", () => {
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project></project>");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("maven");
    expect(recipe!.build).toContain("mvn package");
  });

  it("detects docker-compose project", () => {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}");
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("compose");
    expect(recipe!.start).toContain("docker compose up");
  });

  it("returns null for unknown project", () => {
    fs.writeFileSync(path.join(dir, "random.txt"), "hello");
    const recipe = detectRecipe(dir);
    expect(recipe).toBeNull();
  });

  it("detects Makefile targets", () => {
    fs.writeFileSync(path.join(dir, "Makefile"), `
install:
	pip install -r requirements.txt
build:
	python setup.py build
test:
	pytest
run:
	python app.py
`);
    const recipe = detectRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("make");
    expect(recipe!.bootstrap).toContain("make install");
    expect(recipe!.build).toContain("make build");
    expect(recipe!.test).toContain("make test");
    expect(recipe!.start).toContain("make run");
  });
});

describe("verify/recipes — serialization", () => {
  it("recipeToDict / recipeFromDict round-trip", () => {
    const original = {
      name: "Test App",
      kind: "vite",
      bootstrap: ["npm install"],
      build: ["npm run build"],
      test: ["npm test"],
      start: "npm run dev",
      port: 5173,
      readinessPath: "/",
      evidence: ["Detected package.json"],
    };
    const dict = recipeToDict(original);
    const restored = recipeFromDict(dict);
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Test App");
    expect(restored!.kind).toBe("vite");
    expect(restored!.port).toBe(5173);
    expect(restored!.start).toBe("npm run dev");
  });

  it("recipeFromDict returns null for invalid input", () => {
    expect(recipeFromDict(null)).toBeNull();
    expect(recipeFromDict({})).toBeNull();
    expect(recipeFromDict({ name: "" })).toBeNull();
    expect(recipeFromDict("not an object")).toBeNull();
  });
});

describe("verify/environment — manifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("getRecipe falls back to detection when no manifest", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "test", scripts: { dev: "vite" }, dependencies: { vite: "5" },
    }));
    const recipe = getRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe!.kind).toBe("vite");
  });

  it("saveManifest / loadManifest round-trip", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "test", scripts: { dev: "vite" }, dependencies: { vite: "5" },
    }));
    const recipe = getRecipe(dir)!;
    saveManifest(dir, recipe);
    const loaded = loadManifest(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe(recipe.name);
    expect(loaded!.kind).toBe(recipe.kind);
  });

  it("loadManifest returns null for corrupt manifest", () => {
    fs.mkdirSync(path.join(dir, ".evoclaw"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".evoclaw/environment.json"), "not valid json");
    expect(loadManifest(dir)).toBeNull();
  });

  it("loadManifest returns null for missing manifest", () => {
    expect(loadManifest(dir)).toBeNull();
  });
});
