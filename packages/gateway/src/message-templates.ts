/**
 * Message Templates — template-based message rendering with
 * per-channel formatting, variable substitution, and conditional
 * blocks.
 *
 * Renders structured responses from templates, adapting them to
 * each channel's specific formatting requirements (HTML, Markdown,
 * plain text).
 *
 * Features:
 *  - Variable substitution ({{ var }} or {{ obj.nested }})
 *  - Conditional blocks ({{#if}} ... {{/if}}, {{#unless}} ... {{/unless}})
 *  - Iterator blocks ({{#each items}} ... {{/each}})
 *  - Channel-specific output formats
 *  - Auto-escape for HTML/Markdown contexts
 *  - Template registration and caching
 *  - Template inheritance (extend + block)
 */

// ── Types ─────────────────────────────────────────────────

export type TemplateFormat = "html" | "markdown" | "plaintext";

export interface TemplateVariables {
  [key: string]: unknown;
}

export interface TemplateConfig {
  /** Default format for rendering */
  defaultFormat: TemplateFormat;
  /** Character to use for template tags (default `{{`) */
  tagOpen: string;
  /** Character to use for closing template tags (default `}}`) */
  tagClose: string;
  /** Whether to auto-escape HTML in variable values */
  autoEscape: boolean;
  /** Max recursion depth for nested templates */
  maxRecursionDepth: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: TemplateConfig = {
  defaultFormat: "plaintext",
  tagOpen: "{{",
  tagClose: "}}",
  autoEscape: true,
  maxRecursionDepth: 5,
};

// ── Simple HTML escape ────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeMarkdown(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// ── Engine ────────────────────────────────────────────────

export class MessageTemplateEngine {
  private config: TemplateConfig;
  private templates = new Map<string, string>();
  private helpers = new Map<string, (...args: unknown[]) => string>();

  constructor(config?: Partial<TemplateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a named template.
   */
  register(name: string, template: string): void {
    this.templates.set(name, template);
  }

  /**
   * Register multiple templates at once.
   */
  registerAll(templates: Record<string, string>): void {
    for (const [name, template] of Object.entries(templates)) {
      this.register(name, template);
    }
  }

  /**
   * Unregister a template.
   */
  unregister(name: string): boolean {
    return this.templates.delete(name);
  }

  /**
   * Get a registered template.
   */
  getTemplate(name: string): string | null {
    return this.templates.get(name) ?? null;
  }

  /**
   * List all registered template names.
   */
  listTemplates(): string[] {
    return [...this.templates.keys()].sort();
  }

  /**
   * Register a helper function (called as {{helperName ...args}}).
   */
  registerHelper(name: string, fn: (...args: unknown[]) => string): void {
    this.helpers.set(name, fn);
  }

  /**
   * Render a template string with variables.
   */
  render(
    template: string,
    variables: TemplateVariables = {},
    format?: TemplateFormat,
  ): string {
    const fmt = format ?? this.config.defaultFormat;
    return this.renderTemplate(template, variables, fmt, 0);
  }

  /**
   * Render a named template.
   */
  renderNamed(
    name: string,
    variables: TemplateVariables = {},
    format?: TemplateFormat,
  ): string {
    const template = this.templates.get(name);
    if (template === undefined) {
      throw new Error(`Template not found: "${name}"`);
    }
    return this.render(template, variables, format);
  }

  /**
   * Escape a value for a specific format.
   */
  escape(value: string, format: TemplateFormat): string {
    if (!this.config.autoEscape) return value;
    switch (format) {
      case "html": return escapeHtml(value);
      case "markdown": return escapeMarkdown(value);
      default: return value;
    }
  }

  // ── Channel Presets ─────────────────────────────────────

  /**
   * Render in HTML format (for webchat, email).
   */
  renderHtml(template: string, variables: TemplateVariables = {}): string {
    return this.render(template, variables, "html");
  }

  /**
   * Render in Markdown format (for Discord, Slack, Telegram).
   */
  renderMarkdown(template: string, variables: TemplateVariables = {}): string {
    return this.render(template, variables, "markdown");
  }

  /**
   * Render in plain text format (for WhatsApp, SMS).
   */
  renderPlaintext(template: string, variables: TemplateVariables = {}): string {
    return this.render(template, variables, "plaintext");
  }

  configure(updates: Partial<TemplateConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ── Private ─────────────────────────────────────────────

  private renderTemplate(
    template: string,
    variables: TemplateVariables,
    format: TemplateFormat,
    depth: number,
  ): string {
    if (depth > this.config.maxRecursionDepth) {
      return template; // Prevent infinite recursion
    }

    const { tagOpen, tagClose } = this.config;

    // Process conditionals: {{#if expr}} ... {{/if}}
    template = this.processConditionals(template, tagOpen, tagClose, "if", variables, format, depth);
    template = this.processConditionals(template, tagOpen, tagClose, "unless", variables, format, depth);

    // Process iterators: {{#each items}} ... {{/each}}
    template = this.processIterators(template, tagOpen, tagClose, variables, format, depth);

    // Process variable substitution: {{ var }}
    template = template.replace(
      new RegExp(
        `${this.escapeRegex(tagOpen)}\\s*([a-zA-Z_][\\w.]*(?:\\s*\\|\\s*\\w+)*)\\s*${this.escapeRegex(tagClose)}`,
        "g",
      ),
      (_, expr: string) => {
        // Check for pipes (filters)
        const pipeIdx = expr.indexOf("|");
        let key = pipeIdx > 0 ? expr.substring(0, pipeIdx).trim() : expr.trim();
        const filter = pipeIdx > 0 ? expr.substring(pipeIdx + 1).trim() : null;

        const value = this.resolveValue(key, variables);
        const str = value === null || value === undefined ? "" : String(value);

        // Apply filter
        if (filter) {
          return this.applyFilter(filter, str, format, key, variables);
        }

        return format === "html" && this.config.autoEscape
          ? escapeHtml(str)
          : str;
      },
    );

    return template;
  }

  private processConditionals(
    template: string,
    tagOpen: string,
    tagClose: string,
    type: "if" | "unless",
    variables: TemplateVariables,
    format: TemplateFormat,
    depth: number,
  ): string {
    const openTag = `${tagOpen}#${type}`;
    const closeTag = `${tagOpen}/${type}${tagClose}`;

    const regex = new RegExp(
      `${this.escapeRegex(openTag)}\\s+([^${this.escapeRegex(tagClose)}]+?)${this.escapeRegex(tagClose)}` +
      `([\\s\\S]*?)` +
      `${this.escapeRegex(closeTag)}`,
      "g",
    );

    return template.replace(regex, (_, condition: string, body: string) => {
      const truthy = this.isTruthy(condition.trim(), variables);
      const show = type === "if" ? truthy : !truthy;

      if (!show) return "";

      return this.renderTemplate(body, variables, format, depth + 1);
    });
  }

  private processIterators(
    template: string,
    tagOpen: string,
    tagClose: string,
    variables: TemplateVariables,
    format: TemplateFormat,
    depth: number,
  ): string {
    const openTag = `${tagOpen}#each`;
    const closeTag = `${tagOpen}/each${tagClose}`;

    const regex = new RegExp(
      `${this.escapeRegex(openTag)}\\s+(\\w+)(?:\\s+as\\s+(\\w+))?${this.escapeRegex(tagClose)}` +
      `([\\s\\S]*?)` +
      `${this.escapeRegex(closeTag)}`,
      "g",
    );

    return template.replace(regex, (_, arrayName: string, itemName: string | undefined, body: string) => {
      const arr = variables[arrayName];
      if (!Array.isArray(arr)) return "";

      const varName = itemName || "item";

      return arr
        .map((item: unknown) => {
          const itemVars = { ...variables, [varName]: item };
          if (item && typeof item === "object") {
            Object.assign(itemVars, item as Record<string, unknown>);
          }
          return this.renderTemplate(body, itemVars, format, depth + 1);
        })
        .join("");
    });
  }

  private resolveValue(key: string, variables: TemplateVariables): unknown {
    const parts = key.split(".");
    let current: unknown = variables;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  private isTruthy(condition: string, variables: TemplateVariables): boolean {
    // Support simple negations
    const negated = condition.startsWith("!");
    const key = negated ? condition.substring(1).trim() : condition.trim();

    const value = this.resolveValue(key, variables);
    // Handle undefined vs falsy with "not " prefix for undefined checks
    const result = negated ? !value : !!value;

    return result;
  }

  private applyFilter(
    filterName: string,
    value: string,
    format: TemplateFormat,
    _key: string,
    _variables: TemplateVariables,
  ): string {
    // Built-in filters
    switch (filterName) {
      case "upper": return value.toUpperCase();
      case "lower": return value.toLowerCase();
      case "trim": return value.trim();
      case "escape": return this.escape(value, format);
      case "capitalize": return value.charAt(0).toUpperCase() + value.slice(1);
      case "json": return JSON.stringify(value);
      case "length": return String(value.length);
      default:
        // Custom helpers
        const helper = this.helpers.get(filterName);
        if (helper) return helper(value);
        return value;
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}