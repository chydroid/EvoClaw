/**
 * TodoStore — 内存修订版本任务列表（对标 hermes-agent tools/todo_tool.py）
 *
 * 每个 session 一个 TodoStore，用于多步任务跟踪。
 * - 列表位置即优先级；同一时刻只有一个 in_progress
 * - parent 字段嵌套子任务
 * - 每次写入递增 revision（单调递增），UI 客户端可用 revision 拒绝过期更新
 * - formatForInjection() 在 context 压缩后重新注入活跃任务
 * - 上限保护：MAX_TODO_ITEMS / MAX_TODO_CONTENT_CHARS
 */

const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
const MAX_TODO_CONTENT_CHARS = 4000;
const MAX_TODO_ITEMS = 256;
const MAX_TODO_RESULT_CHARS = 512_000;
const TRUNCATION_MARKER = "… [truncated]";
export const TODO_INJECTION_HEADER = "[Your active task list was preserved across context compression]";
const STATUS_MARKERS: Record<string, string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
  cancelled: "[~]",
};
const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  parent?: string;
}

export interface TodoSnapshot {
  todos: TodoItem[];
  revision: number;
}

export class TodoStore {
  private _items: TodoItem[] = [];
  private _revision = 0;

  // ── 写入 ────────────────────────────────────────────────

  write(todos: unknown[], merge = false): TodoItem[] {
    const before = this.read();
    try {
      if (merge) {
        this._merge(todos);
      } else {
        this._items = this._freshItems(todos);
      }
    } catch (err) {
      this._items = before; // 拒绝写入不得留下部分列表
      throw err;
    }
    // 保留优先级头部；重放不能无限增长
    this._items = this._items.slice(0, MAX_TODO_ITEMS);
    this._sanitizeParents(this._items);
    if (!this._equalLists(this._items, before)) {
      this._revision++;
    }
    return this.read();
  }

  private _merge(todos: unknown[]): void {
    const existing = new Map(this._items.map((i) => [i.id, i]));
    const deduped = this._dedupeById(todos);
    for (const t of deduped) {
      const itemId = this._str(t, "id").trim();
      if (!itemId) continue; // 没有 id 无法合并
      const cur = existing.get(itemId);
      if (cur === undefined) {
        const validated = this._validate(t);
        existing.set(validated.id, validated);
        this._items.push(validated);
        continue;
      }
      const content = this._str(t, "content");
      if (content) cur.content = this._capContent(content.trim());
      const status = this._str(t, "status").trim().toLowerCase();
      if (status && VALID_STATUSES.has(status)) {
        cur.status = status as TodoItem["status"];
      }
      if (typeof t === "object" && t !== null && "parent" in t) {
        const parent = this._str(t, "parent").trim();
        if (parent) cur.parent = parent;
        else delete cur.parent;
      }
    }
    // 重建保留原始顺序（首次出现优先）
    const rebuilt: TodoItem[] = [];
    const seen = new Set<string>();
    for (const item of this._items) {
      const updated = existing.get(item.id) ?? item;
      if (!seen.has(updated.id)) {
        rebuilt.push(updated);
        seen.add(updated.id);
      }
    }
    this._items = this._normalizeOrder(rebuilt);
  }

  // ── 读取 ────────────────────────────────────────────────

  read(): TodoItem[] {
    return this._items.map((i) => ({ ...i }));
  }

  hasItems(): boolean {
    return this._items.length > 0;
  }

  snapshot(): TodoSnapshot {
    return { todos: this.read(), revision: this._revision };
  }

  restore(todos: unknown[], revision?: number): TodoItem[] {
    this._items = this._freshItems(todos).slice(0, MAX_TODO_ITEMS);
    const r = Number(revision ?? 0);
    this._revision = r > 0 && Number.isFinite(r) ? Math.floor(r) : 0;
    return this.read();
  }

  /**
   * 压缩后注入渲染。只注入 pending/in_progress 项——已完成的项会让模型在压缩后重做工作。
   * parent 在任一后代活跃时保留（连同其真实状态标记），以便子任务保持上下文。
   */
  formatForInjection(): string | null {
    if (this._items.length === 0) return null;

    const children = new Map<string, TodoItem[]>();
    for (const item of this._items) {
      if (item.parent) {
        const arr = children.get(item.parent);
        if (arr) arr.push(item);
        else children.set(item.parent, [item]);
      }
    }

    const lines: string[] = [TODO_INJECTION_HEADER];

    const render = (item: TodoItem, depth: number, out: string[]): boolean => {
      const kidLines: string[] = [];
      let hasActiveKid = false;
      for (const kid of children.get(item.id) ?? []) {
        hasActiveKid = render(kid, depth + 1, kidLines) || hasActiveKid;
      }
      const keep = ACTIVE_STATUSES.has(item.status) || hasActiveKid;
      if (keep) {
        const marker = STATUS_MARKERS[item.status] ?? "[?]";
        out.push(`${"  ".repeat(depth)}- ${marker} ${item.id}. ${item.content} (${item.status})`);
        out.push(...kidLines);
      }
      return keep;
    };

    for (const item of this._items) {
      if (!item.parent) render(item, 0, lines);
    }

    return lines.length > 1 ? lines.join("\n") : null;
  }

  // ── 工具方法 ────────────────────────────────────────────

  private _capContent(content: string): string {
    if (content.length > MAX_TODO_CONTENT_CHARS) {
      return content.slice(0, MAX_TODO_CONTENT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    }
    return content;
  }

  private _validate(item: unknown): TodoItem {
    if (typeof item !== "object" || item === null) {
      return { id: "?", content: "(invalid item)", status: "pending" };
    }
    const obj = item as Record<string, unknown>;
    const id = this._str(item, "id").trim() || "?";
    const content = this._str(item, "content").trim();
    if (!content) {
      throw new Error(`Todo item '${id}' has empty or missing content. Each item must have a non-empty description.`);
    }
    const statusRaw = this._str(item, "status").trim().toLowerCase();
    const status = (VALID_STATUSES.has(statusRaw) ? statusRaw : "pending") as TodoItem["status"];
    const result: TodoItem = { id, content: this._capContent(content), status };
    const parent = this._str(item, "parent").trim();
    if (parent && parent !== id) result.parent = parent;
    return result;
  }

  private _sanitizeParents(items: TodoItem[]): void {
    const byId = new Map(items.map((i) => [i.id, i]));
    // 丢弃悬空 parent 引用
    for (const item of items) {
      if (item.parent && !byId.has(item.parent)) {
        delete item.parent;
      }
    }
    // 打破循环
    for (const item of items) {
      const seen = new Set<string>([item.id]);
      let node: TodoItem | undefined = item;
      while (node?.parent) {
        if (seen.has(node.parent)) {
          delete item.parent;
          break;
        }
        seen.add(node.parent);
        node = byId.get(node.parent);
      }
    }
  }

  private _dedupeById(todos: unknown[]): unknown[] {
    const lastIndex = new Map<string, number>();
    for (let i = 0; i < todos.length; i++) {
      const item = todos[i];
      const key =
        typeof item === "object" && item !== null
          ? this._str(item, "id").trim() || "?"
          : `__invalid_${i}`;
      lastIndex.set(key, i);
    }
    return Array.from(lastIndex.values()).sort((a, b) => a - b).map((i) => todos[i]);
  }

  private _normalizeOrder(items: TodoItem[]): TodoItem[] {
    // 把 in_progress 提升到前面的 pending 之前（同级列表保持作者顺序）
    const hasNested = items.some((i) => i.parent);
    if (hasNested) return items;
    const statuses = items.map((i) => i.status);
    const activeIdx = statuses.indexOf("in_progress");
    if (activeIdx === -1) return items;
    if (!statuses.slice(0, activeIdx).includes("pending")) return items;
    const normalized = [...items];
    const [inProgress] = normalized.splice(activeIdx, 1);
    const pendingIdx = normalized.findIndex((i) => i.status === "pending");
    normalized.splice(pendingIdx, 0, inProgress);
    return normalized;
  }

  private _freshItems(todos: unknown[]): TodoItem[] {
    const deduped = this._dedupeById(todos);
    const validated = deduped.map((t) => this._validate(t));
    return this._normalizeOrder(validated);
  }

  private _str(item: unknown, key: string): string {
    if (typeof item !== "object" || item === null) return "";
    const val = (item as Record<string, unknown>)[key];
    if (val === undefined || val === null) return "";
    return String(val);
  }

  private _equalLists(a: TodoItem[], b: TodoItem[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].content !== b[i].content || a[i].status !== b[i].status ||
          (a[i].parent ?? "") !== (b[i].parent ?? "")) return false;
    }
    return true;
  }
}

/** 限制单次工具结果 payload（防止伪造超大结果） */
export function capTodoResultPayload(payload: string): string {
  if (payload.length > MAX_TODO_RESULT_CHARS) {
    return payload.slice(0, MAX_TODO_RESULT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return payload;
}
