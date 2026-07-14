import { ServiceRegistry, EventBus, atomicWriteFileSync } from "@evoclaw/core";
import * as Handlebars from "handlebars";
import * as fs from "fs";
import * as path from "path";

export interface ReportTemplate {
  name: string;
  title: string;
  description: string;
  templatePath?: string;
  templateContent?: string;
  compiled: Handlebars.TemplateDelegate;
}

export interface ReportData {
  title: string;
  generatedAt: string;
  sections: ReportSection[];
  summary?: ReportSummary;
  footer?: string;
}

export interface ReportSection {
  id: string;
  title: string;
  type: "text" | "table" | "chart" | "list" | "metrics" | "html";
  content?: string;
  data?: Record<string, unknown>;
  chartConfig?: ChartConfig;
  tableData?: TableData;
  listItems?: string[];
  metrics?: MetricItem[];
}

export interface ReportSummary {
  totalItems: number;
  highlights: string[];
  recommendations?: string[];
}

export interface ChartConfig {
  type: "bar" | "line" | "pie" | "doughnut" | "radar";
  title: string;
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string | string[];
  }>;
  width?: number;
  height?: number;
}

export interface TableData {
  headers: string[];
  rows: Array<Array<string | number>>;
  caption?: string;
}

export interface MetricItem {
  label: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  trend?: "up" | "down" | "stable";
  icon?: string;
}

export interface ReportOptions {
  templateName?: string;
  format?: "html" | "json";
  outputPath?: string;
  includeCharts?: boolean;
  locale?: string;
}

const CHART_COLORS = [
  "#4CAF50", "#2196F3", "#FF9800", "#E91E63", "#9C27B0",
  "#00BCD4", "#FF5722", "#607D8B", "#795548", "#3F51B5",
];

// XSS 防护：对插入 SVG 文本的变量做 XML 实体转义
function escapeXml(s: unknown): string {
  return String(s ?? "").replace(/[<>&"']/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!)
  );
}

const DEFAULT_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #333; background: #f5f7fa; line-height: 1.6;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 20px; }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff; padding: 40px; border-radius: 12px; margin-bottom: 24px;
    }
    .header h1 { font-size: 28px; font-weight: 700; }
    .header .meta { margin-top: 8px; opacity: 0.85; font-size: 14px; }
    .section {
      background: #fff; border-radius: 10px; padding: 24px; margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .section h2 { font-size: 20px; color: #333; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #eee; }
    .section-content { font-size: 15px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .metric-card {
      background: #f8f9fb; border-radius: 8px; padding: 16px; text-align: center;
      border-left: 4px solid #667eea;
    }
    .metric-card .metric-value { font-size: 32px; font-weight: 700; color: #333; }
    .metric-card .metric-label { font-size: 13px; color: #666; margin-top: 4px; }
    .metric-card .metric-change { font-size: 12px; margin-top: 4px; }
    .metric-card .metric-change.up { color: #4CAF50; }
    .metric-card .metric-change.down { color: #E91E63; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { background: #f0f2f5; padding: 12px 16px; text-align: left; font-weight: 600; border-bottom: 2px solid #ddd; }
    td { padding: 10px 16px; border-bottom: 1px solid #eee; }
    tr:hover td { background: #f8f9fb; }
    .list-items { list-style: none; }
    .list-items li { padding: 10px 16px; border-bottom: 1px solid #eee; display: flex; align-items: center; }
    .list-items li::before { content: "•"; color: #667eea; font-weight: bold; margin-right: 12px; font-size: 18px; }
    .chart-container { text-align: center; margin: 16px 0; }
    .chart-container img { max-width: 100%; border-radius: 6px; }
    .chart-container .chart-title { font-size: 14px; color: #666; margin-bottom: 10px; }
    .summary-box {
      background: #f0f4ff; border-radius: 8px; padding: 20px; margin-bottom: 20px;
    }
    .summary-box h3 { color: #667eea; margin-bottom: 12px; }
    .highlight-item { padding: 8px 0; font-size: 14px; }
    .recommendation { padding: 8px 0 8px 20px; font-size: 14px; color: #555; border-left: 3px solid #FF9800; margin: 6px 0; }
    .footer {
      text-align: center; padding: 24px; color: #999; font-size: 13px;
      border-top: 1px solid #eee; margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>{{title}}</h1>
      <div class="meta">生成时间：{{generatedAt}}</div>
    </div>

    {{#if summary}}
    <div class="summary-box">
      <h3>概览摘要</h3>
      <p style="margin-bottom:8px;color:#666;">总计 {{summary.totalItems}} 项内容</p>
      {{#each summary.highlights}}
      <div class="highlight-item">✦ {{this}}</div>
      {{/each}}
      {{#if summary.recommendations}}
      <h4 style="margin-top:16px;color:#FF9800;">建议行动</h4>
      {{#each summary.recommendations}}
      <div class="recommendation">{{this}}</div>
      {{/each}}
      {{/if}}
    </div>
    {{/if}}

    {{#each sections}}
    <div class="section">
      <h2>{{title}}</h2>
      <div class="section-content">
        {{#if (eq type "text")}}
          <div>{{content}}</div>
        {{/if}}

        {{#if (eq type "html")}}
          {{{sanitizeHtml content}}}
        {{/if}}

        {{#if (eq type "metrics")}}
          <div class="metrics-grid">
            {{#each metrics}}
            <div class="metric-card">
              <div class="metric-value">{{value}}</div>
              <div class="metric-label">{{label}}</div>
              {{#if change}}
              <div class="metric-change {{trend}}">
                {{#if (eq trend "up")}}↑{{else if (eq trend "down")}}↓{{/if}}
                {{change}}{{#if changeLabel}} {{changeLabel}}{{/if}}
              </div>
              {{/if}}
            </div>
            {{/each}}
          </div>
        {{/if}}

        {{#if (eq type "table")}}
          {{#if tableData.caption}}
          <p style="color:#666;font-size:13px;margin-bottom:8px;">{{tableData.caption}}</p>
          {{/if}}
          <table>
            <thead>
              <tr>
                {{#each tableData.headers}}
                <th>{{this}}</th>
                {{/each}}
              </tr>
            </thead>
            <tbody>
              {{#each tableData.rows}}
              <tr>
                {{#each this}}
                <td>{{this}}</td>
                {{/each}}
              </tr>
              {{/each}}
            </tbody>
          </table>
        {{/if}}

        {{#if (eq type "list")}}
          <ul class="list-items">
            {{#each listItems}}
            <li>{{this}}</li>
            {{/each}}
          </ul>
        {{/if}}

        {{#if (eq type "chart")}}
          {{#if chartConfig}}
          <div class="chart-container">
            <div class="chart-title">{{chartConfig.title}}</div>
            <img src="{{chartImage}}" alt="{{chartConfig.title}}" />
          </div>
          {{/if}}
        {{/if}}
      </div>
    </div>
    {{/each}}

    {{#if footer}}
    <div class="footer">{{footer}}</div>
    {{/if}}
  </div>
</body>
</html>`;

export class ReportGenerator {
  private templates: Map<string, ReportTemplate> = new Map();
  private templateDir: string;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    options?: { templateDir?: string }
  ) {
    this.templateDir = options?.templateDir || path.join(__dirname, "templates");
    this.registerHelpers();
  }

  async initialize(): Promise<void> {
    this.registerBuiltinTemplate("default-report", {
      name: "default-report",
      title: "Default Report",
      description: "The default report template with rich styling",
      templateContent: DEFAULT_TEMPLATE,
      compiled: Handlebars.compile(DEFAULT_TEMPLATE),
    });

    await this.loadTemplates();
  }

  registerTemplate(name: string, template: {
    title: string;
    description: string;
    templateContent?: string;
    templatePath?: string;
  }): void {
    const content = template.templateContent
      || (template.templatePath ? this.readTemplateFile(template.templatePath) : DEFAULT_TEMPLATE);

    this.templates.set(name, {
      name,
      title: template.title,
      description: template.description,
      templatePath: template.templatePath,
      templateContent: content,
      compiled: Handlebars.compile(content),
    });
  }

  private registerBuiltinTemplate(name: string, tmpl: ReportTemplate): void {
    if (!this.templates.has(name)) {
      this.templates.set(name, tmpl);
    }
  }

  getTemplateNames(): string[] {
    return [...this.templates.keys()];
  }

  getTemplate(name: string): ReportTemplate | undefined {
    return this.templates.get(name);
  }

  generateReport(data: ReportData, options: ReportOptions = {}): string {
    const templateName = options.templateName || "default-report";
    const template = this.templates.get(templateName);

    if (!template) {
      throw new Error(`Template not found: ${templateName}. Available: ${this.getTemplateNames().join(", ")}`);
    }

    const enrichedData = this.enrichData(data, options);

    const html = template.compiled(enrichedData);

    const output = options.format === "json"
      ? JSON.stringify(data, null, 2)
      : html;

    if (options.outputPath) {
      // 安全：校验 outputPath 在 data/reports/ 目录内，防止路径穿越
      const allowedBase = path.resolve(process.cwd(), "data", "reports");
      const resolved = path.resolve(options.outputPath);
      if (resolved !== allowedBase && !resolved.startsWith(allowedBase + path.sep)) {
        throw new Error(`Output path must be within ${allowedBase}`);
      }
      // 安全：原子写入（tmp + fsync + rename），避免进程崩溃时报告文件被截断损坏
      atomicWriteFileSync(resolved, output, { encoding: "utf-8" });
    }

    this.eventBus.publish(
      "reporting.report_generated",
      {
        templateName,
        title: data.title,
        sectionCount: data.sections.length,
        format: options.format || "html",
      },
      "report-generator"
    );

    return output;
  }

  generateChartImage(chartConfig: ChartConfig): string {
    const svg = this.renderChartSVG(chartConfig);
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  private renderChartSVG(config: ChartConfig): string {
    const { type, labels, datasets, width = 600, height = 300, title } = config;
    const dataset = datasets[0];
    if (!dataset) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="50%" y="50%" text-anchor="middle" fill="#999">No data</text></svg>`;

    const colors = dataset.backgroundColor
      ? (Array.isArray(dataset.backgroundColor) ? dataset.backgroundColor : [dataset.backgroundColor])
      : CHART_COLORS;

    const values = dataset.data;
    const maxVal = values.reduce((max, v) => Math.max(max, v), 1);
    const margin = { top: 40, right: 30, bottom: 50, left: 60 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;
    const barWidth = Math.min(chartW / values.length * 0.7, 40);

    let svgParts = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="background:#fff;border-radius:6px;">`;
    svgParts += `<text x="${width / 2}" y="25" text-anchor="middle" font-size="14" fill="#333" font-weight="600">${escapeXml(title)}</text>`;

    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (chartH * i / 4);
      const val = Math.round(maxVal * (1 - i / 4));
      svgParts += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#eee" stroke-width="1"/>`;
      svgParts += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#999">${val}</text>`;
    }

    if (type === "bar") {
      for (let i = 0; i < values.length; i++) {
        const x = margin.left + (chartW / values.length) * i + (chartW / values.length - barWidth) / 2;
        const barH = (values[i] / maxVal) * chartH;
        const y = margin.top + chartH - barH;
        const color = colors[i % colors.length];
        svgParts += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" rx="3" opacity="0.9"/>`;
        svgParts += `<text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="#555">${escapeXml(values[i])}</text>`;

        const lblX = margin.left + (chartW / values.length) * i + chartW / values.length / 2;
        svgParts += `<text x="${lblX}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#888">${escapeXml(labels[i])}</text>`;
      }
    } else if (type === "line") {
      let pathD = "";
      const points: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < values.length; i++) {
        const x = margin.left + (chartW / (values.length - 1 || 1)) * i;
        const y = margin.top + chartH - (values[i] / maxVal) * chartH;
        points.push({ x, y });
        pathD += `${i === 0 ? "M" : "L"} ${x} ${y} `;
      }

      svgParts += `<path d="${pathD}" fill="none" stroke="${colors[0]}" stroke-width="2.5" opacity="0.8"/>`;

      for (const pt of points) {
        svgParts += `<circle cx="${pt.x}" cy="${pt.y}" r="4" fill="${colors[0]}"/>`;
      }

      for (let i = 0; i < values.length; i++) {
        svgParts += `<text x="${points[i].x}" y="${points[i].y - 10}" text-anchor="middle" font-size="11" fill="#555">${escapeXml(values[i])}</text>`;
        const lblX = margin.left + (chartW / (values.length - 1 || 1)) * i;
        svgParts += `<text x="${lblX}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#888">${escapeXml(labels[i])}</text>`;
      }
    } else {
      const cx = width / 2;
      const cy = margin.top + chartH / 2;
      const r = Math.min(chartW, chartH) / 2 - 10;
      const total = values.reduce((a, b) => a + b, 0) || 1;
      let angleOffset = -Math.PI / 2;

      for (let i = 0; i < values.length; i++) {
        const sliceAngle = (values[i] / total) * 2 * Math.PI;
        const x1 = cx + r * Math.cos(angleOffset);
        const y1 = cy + r * Math.sin(angleOffset);
        const x2 = cx + r * Math.cos(angleOffset + sliceAngle);
        const y2 = cy + r * Math.sin(angleOffset + sliceAngle);
        const largeArc = sliceAngle > Math.PI ? 1 : 0;
        const color = colors[i % colors.length];

        svgParts += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${color}" opacity="0.85"/>`;

        const midAngle = angleOffset + sliceAngle / 2;
        const lx = cx + (r * 0.7) * Math.cos(midAngle);
        const ly = cy + (r * 0.7) * Math.sin(midAngle);
        const pct = Math.round((values[i] / total) * 100);
        svgParts += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="12" fill="#fff" font-weight="600">${pct > 3 ? escapeXml(pct + "%") : ""}</text>`;

        angleOffset += sliceAngle;
      }

      let legendY = cy + r + 25;
      for (let i = 0; i < labels.length; i++) {
        const lx = margin.left + 15;
        svgParts += `<rect x="${lx}" y="${legendY}" width="12" height="12" fill="${colors[i % colors.length]}" rx="2"/>`;
        svgParts += `<text x="${lx + 18}" y="${legendY + 10}" font-size="12" fill="#555">${escapeXml(labels[i])} (${escapeXml(values[i])})</text>`;
        legendY += 20;
      }
    }

    svgParts += "</svg>";
    return svgParts;
  }

  private enrichData(data: ReportData, options: ReportOptions): Record<string, unknown> {
    const enrichedSections = data.sections.map((section) => {
      if (section.type === "chart" && section.chartConfig && options.includeCharts !== false) {
        return {
          ...section,
          chartImage: this.generateChartImage(section.chartConfig),
        };
      }
      return section;
    });

    return {
      ...data,
      sections: enrichedSections,
      generatedAt: data.generatedAt || new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    };
  }

  private registerHelpers(): void {
    Handlebars.registerHelper("eq", function (this: unknown, a: unknown, b: unknown) {
      return a === b;
    });

    Handlebars.registerHelper("formatDate", function (this: unknown, date: unknown) {
      if (!date) return "";
      const d = new Date(date as string);
      return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
    });

    Handlebars.registerHelper("formatNumber", function (this: unknown, num: unknown) {
      if (num === null || num === undefined) return "0";
      const n = Number(num);
      if (Number.isNaN(n)) return "0";
      return n.toLocaleString("zh-CN");
    });

    Handlebars.registerHelper("truncate", function (this: unknown, str: unknown, len: unknown) {
      const s = String(str || "");
      const l = Number(len) || 100;
      return s.length > l ? s.substring(0, l) + "..." : s;
    });

    // XSS 防护：对 HTML 类型内容进行净化，移除 <script> 标签和事件处理器属性
    Handlebars.registerHelper("sanitizeHtml", function (this: unknown, html: unknown) {
      if (!html) return new Handlebars.SafeString("");
      let s = String(html);
      // 移除 <script>...</script> 块（非贪婪匹配，避免灾难性回溯）
      s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
      // 移除事件处理器属性 (onclick, onerror, onload, etc.)
      // 使用 [\s/]+ 而非 \s+：HTML 规范允许用 / 作为属性分隔符（如 <img/onerror=...>）
      s = s.replace(/[\s/]+on\w+\s*=\s*"[^"]*"/gi, "");
      s = s.replace(/[\s/]+on\w+\s*=\s*'[^']*'/gi, "");
      s = s.replace(/[\s/]+on\w+\s*=\s*[^\s>]+/gi, "");
      // 移除危险协议的 href/src：javascript:、vbscript:、data:text/html
      s = s.replace(/(href|src)\s*=\s*["'](?:javascript|vbscript|data:text\/html):[^"']*["']/gi, "");
      return new Handlebars.SafeString(s);
    });
  }

  private readTemplateFile(filePath: string): string {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(this.templateDir, filePath);
    // 安全：校验 resolved 在 templateDir 内，防止路径穿越读取任意文件
    const resolvedAbs = path.resolve(resolved);
    const templateDirAbs = path.resolve(this.templateDir);
    if (resolvedAbs !== templateDirAbs && !resolvedAbs.startsWith(templateDirAbs + path.sep)) {
      throw new Error(`Template path outside template directory: ${filePath}`);
    }
    if (!fs.existsSync(resolvedAbs)) {
      throw new Error(`Template file not found: ${resolved}`);
    }
    return fs.readFileSync(resolved, "utf-8");
  }

  private async loadTemplates(): Promise<void> {
    try {
      if (fs.existsSync(this.templateDir)) {
        const files = fs.readdirSync(this.templateDir);
        for (const file of files) {
          if (!file.endsWith(".hbs")) continue;
          const name = file.replace(".hbs", "");
          const content = fs.readFileSync(path.join(this.templateDir, file), "utf-8");
          const tmpl = Handlebars.compile(content);
          this.templates.set(name, {
            name,
            title: name,
            description: `Custom template: ${file}`,
            templatePath: file,
            templateContent: content,
            compiled: tmpl,
          });
        }
      }
    } catch (err) {
      process.stderr.write(`[ReportGenerator] Failed to load templates: ${err}\n`);
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.templates.size > 0;
  }
}