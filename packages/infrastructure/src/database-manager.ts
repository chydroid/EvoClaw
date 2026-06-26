import { ServiceRegistry, EventBus } from "@evoclaw/core";

interface DatabaseConfig {
  type: "sqlite" | "memory";
  path: string;
  enableWAL: boolean;
}

interface QueryResult<T = unknown> {
  rows: T[];
  changes: number;
  lastInsertId: number | bigint;
}

export class DatabaseManager {
  private config: DatabaseConfig;
  private store = new Map<string, Record<string, unknown>[]>();
  private sequences = new Map<string, number>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.config = {
      type: "memory",
      path: ":memory:",
      enableWAL: false,
    };

    if (registry) {
      registry.registerService("database", this);
    }
  }

  configure(config: Partial<DatabaseConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async execute<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const operation = this.parseOperation(sql);

    switch (operation.type) {
      case "create":
      case "insert": {
        const rows = this.extractRows(operation);
        const table = operation.table || "default";

        if (!this.store.has(table)) {
          this.store.set(table, []);
        }

        if (!this.sequences.has(table)) {
          this.sequences.set(table, 0);
        }

        const id = this.sequences.get(table)! + 1;
        this.sequences.set(table, id);

        const row = { _id: id, ...this.bindParams(operation, params) };
        this.store.get(table)!.push(row);

        return { rows: [row as unknown as T], changes: 1, lastInsertId: id };
      }

      case "select": {
        const table = operation.table || "default";
        const rows = this.store.get(table) || [];
        const filtered = this.applyWhere(rows, operation.where, params);
        return { rows: filtered as unknown as T[], changes: 0, lastInsertId: 0 };
      }

      case "delete": {
        const table = operation.table || "default";
        const allRows = this.store.get(table) || [];
        const filtered = this.applyWhere(allRows, operation.where, params);
        const toDelete = new Set(filtered);
        const remaining = allRows.filter(r => !toDelete.has(r));
        this.store.set(table, remaining);
        return { rows: [], changes: filtered.length, lastInsertId: 0 };
      }

      case "update": {
        const table = operation.table || "default";
        const allRows = this.store.get(table) || [];
        const filtered = this.applyWhere(allRows, operation.where, params);
        // Apply SET clause (basic: col = value pairs)
        if (operation.setClause) {
          const setPairs = operation.setClause.split(/,\s*/);
          for (const row of filtered) {
            const r = row as Record<string, unknown>;
            for (const pair of setPairs) {
              const m = pair.match(/(\w+)\s*=\s*(.+)/);
              if (m) {
                const col = m[1];
                let val: unknown = m[2].trim();
                // Remove quotes around string values
                if (typeof val === "string" && val.startsWith("'") && val.endsWith("'")) {
                  val = val.slice(1, -1);
                } else if (val === "true") val = true;
                else if (val === "false") val = false;
                else if (val !== "null" && !isNaN(Number(val))) val = Number(val);
                r[col] = val;
              }
            }
          }
        }
        return { rows: filtered as unknown as T[], changes: filtered.length, lastInsertId: 0 };
      }

      default:
        return { rows: [], changes: 0, lastInsertId: 0 };
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    const result = await this.execute<T>(sql, params);
    return result.rows;
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  private parseOperation(sql: string): {
    type: string;
    table?: string;
    where?: string;
    columns?: string[];
    setClause?: string;
  } {
    const upper = sql.toUpperCase().trim();

    if (upper.startsWith("CREATE")) {
      return { type: "create", table: this.extractTableName(sql) };
    }
    if (upper.startsWith("INSERT")) {
      return { type: "insert", table: this.extractTableName(sql) };
    }
    if (upper.startsWith("SELECT")) {
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i);
      return {
        type: "select",
        table: this.extractTableName(sql),
        where: whereMatch ? whereMatch[1] : undefined,
      };
    }
    if (upper.startsWith("DELETE")) {
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s*$)/i);
      return { type: "delete", table: this.extractTableName(sql), where: whereMatch ? whereMatch[1] : undefined };
    }
    if (upper.startsWith("UPDATE")) {
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s*$)/i);
      const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|\s*$)/i);
      return { type: "update", table: this.extractTableName(sql), where: whereMatch ? whereMatch[1] : undefined, setClause: setMatch ? setMatch[1] : undefined };
    }

    return { type: "unknown" };
  }

  private extractTableName(sql: string): string | undefined {
    const patterns = [
      /FROM\s+(\w+)/i,
      /INTO\s+(\w+)/i,
      /TABLE\s+(\w+)/i,
      /UPDATE\s+(\w+)/i,
    ];

    for (const pattern of patterns) {
      const match = sql.match(pattern);
      if (match) return match[1].toLowerCase();
    }
    return undefined;
  }

  private extractRows(op: ReturnType<typeof this.parseOperation>): unknown[] {
    if (op.type === "insert") {
      return [{}];
    }
    return [];
  }

  private bindParams(
    _op: { type: string },
    params?: unknown[]
  ): Record<string, unknown> {
    if (!params || params.length === 0) return {};
    const obj: Record<string, unknown> = {};
    params.forEach((p, i) => {
      if (p !== undefined && p !== null) {
        obj[`p${i}`] = p;
      }
    });
    return obj;
  }

  private applyWhere(
    rows: unknown[],
    where?: string,
    params?: unknown[]
  ): unknown[] {
    if (!where) return rows;
    // Basic WHERE support: column = ? / column = value [AND column2 = value2]
    const conditions = where.split(/\s+AND\s+/i);
    return rows.filter(row => {
      const r = row as Record<string, unknown>;
      let paramIdx = 0;
      for (const cond of conditions) {
        const m = cond.trim().match(/(\w+)\s*=\s*(\?|'[^']*'|true|false|null|-?\d+(?:\.\d+)?)/i);
        if (!m) continue; // Skip unsupported conditions
        const col = m[1];
        let val: unknown;
        if (m[2] === "?") {
          val = params?.[paramIdx++];
        } else if (m[2].startsWith("'")) {
          val = m[2].slice(1, -1);
        } else if (m[2].toLowerCase() === "true") {
          val = true;
        } else if (m[2].toLowerCase() === "false") {
          val = false;
        } else if (m[2].toLowerCase() === "null") {
          val = null;
        } else {
          val = Number(m[2]);
        }
        if (r[col] !== val) return false;
      }
      return true;
    });
  }

  async healthCheck(): Promise<boolean> {
    return this.store.size > 0;
  }
}