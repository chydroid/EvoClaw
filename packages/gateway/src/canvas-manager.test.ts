import { describe, it, expect, beforeEach, vi } from "vitest";

// Use vi.mock factory for ESM-compatible fs mocking
const mockStore = new Map<string, string>();
const mockExists = new Set<string>();

vi.mock("fs", () => {
  // fd → path 映射，支持 atomicWriteFileSync 通过 fd 写入
  const fdToPath = new Map<number, string>();
  let nextFd = 42;
  return {
    existsSync: vi.fn((p: string) => mockExists.has(p)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string | number, data: string) => {
      const key = typeof p === "number" ? fdToPath.get(p) ?? String(p) : p;
      mockStore.set(key, data);
      mockExists.add(key);
    }),
    readFileSync: vi.fn((p: string) => mockStore.get(p) ?? "[]"),
    unlinkSync: vi.fn((p: string) => {
      mockStore.delete(p);
      mockExists.delete(p);
    }),
    statSync: vi.fn((p: string) => ({
      size: (mockStore.get(p) ?? "").length,
      mtimeMs: Date.now(),
      mode: 0o644,
    })),
    // 支持 atomicWriteFileSync 所需的额外 fs 方法
    openSync: vi.fn((p: string) => {
      mockExists.add(p);
      const fd = nextFd++;
      fdToPath.set(fd, p);
      return fd;
    }),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync: vi.fn((src: string, dst: string) => {
      const data = mockStore.get(src);
      if (data !== undefined) {
        mockStore.set(dst, data);
        mockExists.add(dst);
        mockStore.delete(src);
        mockExists.delete(src);
      }
    }),
    chmodSync: vi.fn(),
  };
});

import * as fs from "fs";
import * as path from "path";
import { CanvasManager } from "./canvas-manager";

describe("CanvasManager", () => {
  let cm: CanvasManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
    mockExists.clear();

    const indexPath = path.join("test-canvas-dir", "_index.json");
    mockStore.set(indexPath, "[]");
    mockExists.add(indexPath);

    cm = new CanvasManager({
      storagePath: "test-canvas-dir",
      maxFiles: 10,
      maxFileSize: 1024 * 100,
    });
  });

  // ── Initialization ────────────────────────────────

  it("should initialize by creating storage directory", () => {
    cm.initialize();
    expect(fs.mkdirSync).toHaveBeenCalledWith("test-canvas-dir", { recursive: true });
  });

  it("should not create files when disabled", () => {
    const disabled = new CanvasManager({ enabled: false });
    disabled.initialize();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  // ── Canvas Creation ───────────────────────────────

  it("should create a canvas and return URL", () => {
    const result = cm.createCanvas("Test Canvas", "<html><body>Hello</body></html>");
    expect(result.canvas.title).toBe("Test Canvas");
    expect(result.canvas.createdBy).toBe("agent");
    expect(result.url).toContain("/__evoclaw__/canvas/");
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("should generate a unique ID from title", () => {
    const result = cm.createCanvas("My Awesome Dashboard", "<html></html>");
    expect(result.canvas.id).toBeTruthy();
    expect(result.canvas.id).toContain("my-awesome-dashboard");
  });

  it("should accept custom ID", () => {
    const result = cm.createCanvas("Test", "<html></html>", { id: "custom-canvas" });
    expect(result.canvas.id).toBe("custom-canvas");
  });

  it("should accept optional metadata", () => {
    const result = cm.createCanvas("Test", "<html></html>", {
      description: "A test canvas",
      tags: ["test", "demo"],
      createdBy: "user",
      public: true,
    });
    expect(result.canvas.description).toBe("A test canvas");
    expect(result.canvas.tags).toEqual(["test", "demo"]);
    expect(result.canvas.createdBy).toBe("user");
    expect(result.canvas.public).toBe(true);
  });

  it("should throw when max files reached", () => {
    const existingFiles = Array.from({ length: 10 }, (_, i) => ({
      id: `canvas-${i}`,
      title: `Canvas ${i}`,
      html: "<html></html>",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "agent" as const,
    }));
    const indexPath = path.join("test-canvas-dir", "_index.json");
    (fs.writeFileSync as any)(indexPath, JSON.stringify(existingFiles));

    expect(() => cm.createCanvas("Over Limit", "<html></html>")).toThrow(
      "Maximum canvas count reached"
    );
  });

  it("should throw when HTML exceeds max size", () => {
    const huge = "x".repeat(200 * 1024);
    expect(() => cm.createCanvas("Huge", huge)).toThrow("exceeds maximum size");
  });

  it("should throw when canvas system is disabled", () => {
    const disabled = new CanvasManager({ enabled: false });
    expect(() => disabled.createCanvas("Title", "<html></html>")).toThrow("disabled");
  });

  // ── Canvas Retrieval ──────────────────────────────

  it("should list canvases", () => {
    cm.createCanvas("Canvas 1", "<html></html>");
    cm.createCanvas("Canvas 2", "<html></html>");

    const list = cm.listCanvases();
    expect(list.total).toBe(2);
    expect(list.canvases).toHaveLength(2);
    expect(list.maxFiles).toBe(10);
  });

  it("should get canvas by ID", () => {
    const created = cm.createCanvas("Test", "<html></html>");
    const found = cm.getCanvas(created.canvas.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Test");
  });

  it("should return undefined for unknown canvas", () => {
    expect(cm.getCanvas("unknown")).toBeUndefined();
  });

  it("should get canvas HTML content", () => {
    const html = "<html><body>Content</body></html>";
    const created = cm.createCanvas("Content Canvas", html);

    const content = cm.getCanvasHTML(created.canvas.id);
    expect(content).toBeTruthy();
    expect(content).toContain("Content");
  });

  it("should return null for missing HTML file", () => {
    expect(cm.getCanvasHTML("nonexistent")).toBeNull();
  });

  // ── Canvas Update ─────────────────────────────────

  it("should update canvas HTML", () => {
    const created = cm.createCanvas("Original", "<html><body>Old</body></html>");
    const updated = cm.updateCanvas(created.canvas.id, {
      html: "<html><body>New</body></html>",
    });
    expect(updated).not.toBeNull();
    expect(updated!.html).toContain("New");
  });

  it("should append HTML before closing body tag", () => {
    const created = cm.createCanvas("Original", "<html><body>Hello</body></html>");
    const updated = cm.updateCanvas(created.canvas.id, {
      appendHTML: "<div>Appended</div>",
    });
    expect(updated!.html).toContain("<div>Appended</div>");
    expect(updated!.html).toContain("</body>");
    const bodyIndex = updated!.html.indexOf("</body>");
    const appendIndex = updated!.html.indexOf("<div>Appended</div>");
    expect(appendIndex).toBeLessThan(bodyIndex);
  });

  it("should concatenate when no body tag for append", () => {
    const created = cm.createCanvas("Simple", "<p>No body tag</p>");
    const updated = cm.updateCanvas(created.canvas.id, {
      appendHTML: "<p>More</p>",
    });
    // sanitizeHTML wraps fragment in full document with <body> tags,
    // so appendHTML inserts before </body> rather than raw concat
    expect(updated!.html).toContain("<p>No body tag</p>");
    expect(updated!.html).toContain("<p>More</p>");
    expect(updated!.html).toContain("</body>");
  });

  it("should update title", () => {
    const created = cm.createCanvas("Old Title", "<html></html>");
    const updated = cm.updateCanvas(created.canvas.id, { title: "New Title" });
    expect(updated!.title).toBe("New Title");
  });

  it("should update description", () => {
    const created = cm.createCanvas("Test", "<html></html>");
    const updated = cm.updateCanvas(created.canvas.id, {
      description: "Updated description",
    });
    expect(updated!.description).toBe("Updated description");
  });

  it("should update tags", () => {
    const created = cm.createCanvas("Test", "<html></html>");
    const updated = cm.updateCanvas(created.canvas.id, { tags: ["a", "b"] });
    expect(updated!.tags).toEqual(["a", "b"]);
  });

  it("should return null when updating unknown canvas", () => {
    expect(cm.updateCanvas("unknown", { title: "X" })).toBeNull();
  });

  // ── Canvas Deletion ───────────────────────────────

  it("should delete a canvas", () => {
    const created = cm.createCanvas("To Delete", "<html></html>");
    expect(cm.deleteCanvas(created.canvas.id)).toBe(true);
    expect(cm.getCanvas(created.canvas.id)).toBeUndefined();
  });

  it("should return false when deleting unknown canvas", () => {
    expect(cm.deleteCanvas("unknown")).toBe(false);
  });

  // ── Template ──────────────────────────────────────

  it("should create canvas from template", () => {
    const result = cm.createFromTemplate("Dashboard", {
      timestamp: "2024-01-01",
    });
    expect(result.canvas.title).toBe("Dashboard");
    expect(result.canvas.html).toContain("EvoClaw");
    expect(result.canvas.html).toContain("Dashboard");
  });

  it("should escape HTML in template title via escapeHTML", () => {
    const result = cm.createFromTemplate("Test & Demo");
    expect(result.canvas.html).toContain("Test &amp; Demo");
  });

  // ── CSP Header ────────────────────────────────────

  it("should generate CSP header", () => {
    const csp = cm.getCSPHeader();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src");
  });

  // ── Stats ─────────────────────────────────────────

  it("should return stats with created canvases", () => {
    cm.createCanvas("C1", "<html></html>");
    cm.createCanvas("C2", "<html></html>");

    const stats = cm.getStats();
    expect(stats.totalCanvases).toBe(2);
    expect(stats.maxFiles).toBe(10);
  });

  it("should return zero stats when empty", () => {
    const stats = cm.getStats();
    expect(stats.totalCanvases).toBe(0);
    expect(stats.storageUsedBytes).toBe(0);
  });

  // ── Sanitization ──────────────────────────────────

  it("should inject CSP meta tag into HTML without head", () => {
    const result = cm.createCanvas("Test", "<p>Hello</p>");
    expect(result.canvas.html).toContain("Content-Security-Policy");
  });
});