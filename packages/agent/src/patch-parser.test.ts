import { describe, it, expect, vi } from "vitest";
import {
  parseV4APatch,
  applyV4AOperations,
  applyHunks,
  serializeV4A,
  type V4AOperation,
  type V4AHunk,
} from "./patch-parser";

describe("parseV4APatch", () => {
  it("应解析有效的 Add File 操作", () => {
    const patch = `*** Begin Patch
*** Add File: src/new.txt
+hello world
+second line
*** End Patch`;
    const result = parseV4APatch(patch);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].type).toBe("add");
    expect(result.operations[0].path).toBe("src/new.txt");
    expect(result.operations[0].addContent).toBe("hello world\nsecond line");
  });

  it("应解析 Update File 操作含 hunk", () => {
    const patch = `*** Begin Patch
*** Update File: src/existing.ts
@@ -10,3 +10,3 @@
 context line
-old line
+new line
 context line
*** End Patch`;
    const result = parseV4APatch(patch);
    expect(result.success).toBe(true);
    expect(result.operations).toHaveLength(1);
    const op = result.operations[0];
    expect(op.type).toBe("update");
    expect(op.path).toBe("src/existing.ts");
    expect(op.hunks).toHaveLength(1);
    expect(op.hunks![0].oldStart).toBe(10);
    // hunk 含 4 行：context / remove / add / trailing-context
    expect(op.hunks![0].lines).toHaveLength(4);
    expect(op.hunks![0].lines[0]).toEqual({ type: "context", content: "context line" });
    expect(op.hunks![0].lines[1]).toEqual({ type: "remove", content: "old line" });
    expect(op.hunks![0].lines[2]).toEqual({ type: "add", content: "new line" });
    expect(op.hunks![0].lines[3]).toEqual({ type: "context", content: "context line" });
  });

  it("应解析 Delete File 操作", () => {
    const patch = `*** Begin Patch
*** Delete File: src/old.txt
*** End Patch`;
    const result = parseV4APatch(patch);
    expect(result.success).toBe(true);
    expect(result.operations[0].type).toBe("delete");
    expect(result.operations[0].path).toBe("src/old.txt");
  });

  it("应解析 Move File 操作", () => {
    const patch = `*** Begin Patch
*** Move File: old.ts -> new.ts
*** End Patch`;
    const result = parseV4APatch(patch);
    expect(result.success).toBe(true);
    expect(result.operations[0].type).toBe("move");
    expect(result.operations[0].sourcePath).toBe("old.ts");
    expect(result.operations[0].targetPath).toBe("new.ts");
  });

  it("不以 *** Begin Patch 开头应返回失败", () => {
    const result = parseV4APatch("not a patch");
    expect(result.success).toBe(false);
    expect(result.operations).toHaveLength(0);
    expect(result.error).toContain("Begin Patch");
  });

  it("空输入应返回失败", () => {
    expect(parseV4APatch("").success).toBe(false);
    expect(parseV4APatch(null as unknown as string).success).toBe(false);
  });

  it("应解析多操作 patch", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+content a
*** Update File: b.ts
@@ -1,2 +1,2 @@
 old
+new
*** Delete File: c.txt
*** End Patch`;
    const result = parseV4APatch(patch);
    expect(result.success).toBe(true);
    expect(result.operations).toHaveLength(3);
    expect(result.operations[0].type).toBe("add");
    expect(result.operations[1].type).toBe("update");
    expect(result.operations[2].type).toBe("delete");
  });
});

describe("serializeV4A round-trip", () => {
  it("解析 → 序列化 → 解析应保持语义一致", () => {
    const original = `*** Begin Patch
*** Add File: new.txt
+line1
+line2
*** End Patch`;
    const parsed = parseV4APatch(original);
    expect(parsed.success).toBe(true);
    const serialized = serializeV4A(parsed.operations);
    const reparsed = parseV4APatch(serialized);
    expect(reparsed.success).toBe(true);
    expect(reparsed.operations).toEqual(parsed.operations);
  });

  it("序列化 update 操作应包含 hunk header", () => {
    const ops: V4AOperation[] = [
      {
        type: "update",
        path: "f.ts",
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              { type: "context", content: "ctx" },
              { type: "remove", content: "old" },
              { type: "add", content: "new" },
            ],
          },
        ],
      },
    ];
    const text = serializeV4A(ops);
    expect(text).toContain("*** Begin Patch");
    expect(text).toContain("*** Update File: f.ts");
    expect(text).toContain("@@ -1,2 +1,2 @@");
    expect(text).toContain(" ctx");
    expect(text).toContain("-old");
    expect(text).toContain("+new");
    expect(text).toContain("*** End Patch");
  });
});

describe("applyHunks", () => {
  it("应将 hunk 应用到内容", () => {
    const content = "line1\nold\nline3";
    const hunks: V4AHunk[] = [
      {
        lines: [
          { type: "context", content: "line1" },
          { type: "remove", content: "old" },
          { type: "add", content: "new" },
          { type: "context", content: "line3" },
        ],
      },
    ];
    const result = applyHunks(content, hunks);
    expect(result).toBe("line1\nnew\nline3");
  });

  it("纯添加 hunk 应追加内容", () => {
    const content = "existing";
    const hunks: V4AHunk[] = [
      {
        lines: [{ type: "add", content: "appended" }],
      },
    ];
    const result = applyHunks(content, hunks);
    expect(result).toContain("existing");
    expect(result).toContain("appended");
  });
});

describe("applyV4AOperations", () => {
  it("应应用 add 操作", async () => {
    const readFile = vi.fn();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deleteFile = vi.fn();

    const ops: V4AOperation[] = [
      { type: "add", path: "new.txt", addContent: "hello", hunks: [] },
    ];
    const result = await applyV4AOperations(ops, readFile, writeFile, deleteFile);
    expect(result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith("new.txt", "hello");
    expect(result.applied.get("new.txt")).toBe("hello");
  });

  it("应应用 delete 操作", async () => {
    const readFile = vi.fn();
    const writeFile = vi.fn();
    const deleteFile = vi.fn().mockResolvedValue(undefined);

    const ops: V4AOperation[] = [
      { type: "delete", path: "old.txt" },
    ];
    const result = await applyV4AOperations(ops, readFile, writeFile, deleteFile);
    expect(result.success).toBe(true);
    expect(deleteFile).toHaveBeenCalledWith("old.txt");
  });

  it("update 操作未产生变更应返回失败", async () => {
    const readFile = vi.fn().mockResolvedValue("same content");
    const writeFile = vi.fn();
    const deleteFile = vi.fn();

    const ops: V4AOperation[] = [
      {
        type: "update",
        path: "f.ts",
        hunks: [
          {
            lines: [
              { type: "context", content: "same content" },
            ],
          },
        ],
      },
    ];
    const result = await applyV4AOperations(ops, readFile, writeFile, deleteFile);
    expect(result.success).toBe(false);
    expect(result.error).toContain("未产生变更");
  });
});
