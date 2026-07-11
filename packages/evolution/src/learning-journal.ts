import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type LearningEntry,
  type LearningSession,
  type LearningStats,
  type LearningTrigger,
  type LearningCategory,
  type LearningSeverity,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";

export interface JournalConfig {
  journalPath: string;
  autoPersist: boolean;
  persistIntervalMs: number;
  maxEntries: number;
  maxSessions: number;
}

const DEFAULT_JOURNAL_CONFIG: JournalConfig = {
  journalPath: "LEARNINGS.md",
  autoPersist: true,
  persistIntervalMs: 5000,
  maxEntries: 10000,
  maxSessions: 1000,
};

export class LearningJournal {
  private entries = new Map<string, LearningEntry>();
  private sessions = new Map<string, LearningSession>();
  private config: JournalConfig;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    config?: Partial<JournalConfig>
  ) {
    this.config = { ...DEFAULT_JOURNAL_CONFIG, ...config };
    registry.registerService("learningJournal", this);

    if (this.config.autoPersist) {
      this.loadFromDisk();
      this.persistTimer = setInterval(() => {
        this.persistToDisk();
      }, this.config.persistIntervalMs);
      this.persistTimer.unref();
    }
  }

  recordLearning(input: {
    trigger: LearningTrigger;
    category: LearningCategory;
    title: string;
    context: string;
    error?: string;
    rootCause?: string;
    correction?: string;
    solution?: string;
    codeSnippet?: string;
    source: string;
    severity?: LearningSeverity;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): LearningEntry {
    const entry: LearningEntry = {
      id: uuid(),
      timestamp: new Date(),
      trigger: input.trigger,
      category: input.category,
      title: input.title,
      context: input.context,
      error: input.error || null,
      rootCause: input.rootCause || null,
      correction: input.correction || null,
      solution: input.solution || null,
      codeSnippet: input.codeSnippet || null,
      source: input.source,
      severity: input.severity || this.inferSeverity(input.category, input.trigger),
      resolved: false,
      resolvedAt: null,
      resolvedBy: null,
      resolvedApproach: null,
      relatedEntries: [],
      tags: input.tags || [],
      metadata: input.metadata || {},
    };

    this.entries.set(entry.id, entry);

    while (this.entries.size > this.config.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      } else {
        break;
      }
    }

    this.eventBus.publish(
      SystemEvents.LEARNING_ENTRY_CREATED,
      { entryId: entry.id, trigger: entry.trigger, category: entry.category },
      "learning-journal"
    );

    if (this.config.autoPersist) {
      this.schedulePersist();
    }

    return entry;
  }

  resolveEntry(
    entryId: string,
    resolvedBy: string,
    approach: string,
    codeSnippet?: string
  ): LearningEntry | null {
    const entry = this.entries.get(entryId);
    if (!entry) return null;

    entry.resolved = true;
    entry.resolvedAt = new Date();
    entry.resolvedBy = resolvedBy;
    entry.resolvedApproach = approach;
    if (codeSnippet) {
      entry.codeSnippet = codeSnippet;
    }

    this.eventBus.publish(
      SystemEvents.LEARNING_ENTRY_RESOLVED,
      { entryId, resolvedBy },
      "learning-journal"
    );

    if (this.config.autoPersist) {
      this.schedulePersist();
    }

    return entry;
  }

  findSimilarEntries(
    error: string,
    source?: string,
    limit = 5
  ): LearningEntry[] {
    const candidates: Array<{ entry: LearningEntry; score: number }> = [];

    for (const [, entry] of this.entries) {
      let score = 0;

      if (entry.error && this.textSimilarity(entry.error, error) > 0.5) {
        score += 0.6;
      }

      if (source && entry.source === source) {
        score += 0.2;
      }

      if (entry.error && error.toLowerCase().includes(entry.error.toLowerCase().slice(0, 20))) {
        score += 0.2;
      }

      if (score > 0.3) {
        candidates.push({ entry, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit).map((c) => c.entry);
  }

  startSession(taskId: string, taskDescription: string): LearningSession {
    const session: LearningSession = {
      id: uuid(),
      taskId,
      taskDescription,
      entries: [],
      progressReports: [],
      startedAt: new Date(),
      completedAt: null,
      status: "active",
      summary: null,
    };

    this.sessions.set(session.id, session);

    // 限制 sessions Map 增长：优先淘汰已完成/失败的旧会话，直到回到上限以内
    while (this.sessions.size > this.config.maxSessions) {
      let oldestRemovable: { id: string; startedAt: number } | null = null;
      for (const [id, s] of this.sessions) {
        if (s.status === "active") continue; // 不淘汰进行中的会话
        const t = s.startedAt instanceof Date && !Number.isNaN(s.startedAt.getTime())
          ? s.startedAt.getTime() : 0;
        if (!oldestRemovable || t < oldestRemovable.startedAt) {
          oldestRemovable = { id, startedAt: t };
        }
      }
      if (oldestRemovable) {
        this.sessions.delete(oldestRemovable.id);
      } else {
        break; // 无可淘汰的已完成/失败会话，剩余均为 active
      }
    }

    this.eventBus.publish(
      SystemEvents.LEARNING_SESSION_STARTED,
      { sessionId: session.id, taskId, taskDescription },
      "learning-journal"
    );

    return session;
  }

  addEntryToSession(sessionId: string, entry: LearningEntry): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.entries.push(entry);
    }
  }

  completeSession(sessionId: string, success: boolean): LearningSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.completedAt = new Date();
    session.status = success ? "completed" : "failed";
    session.summary = this.generateSessionSummary(session);

    this.eventBus.publish(
      SystemEvents.LEARNING_SESSION_COMPLETED,
      {
        sessionId,
        status: session.status,
        entryCount: session.entries.length,
        summary: session.summary,
      },
      "learning-journal"
    );

    if (this.config.autoPersist) {
      this.schedulePersist();
    }

    return session;
  }

  getStats(): LearningStats {
    const allEntries = Array.from(this.entries.values());
    const resolved = allEntries.filter((e) => e.resolved);
    const unresolved = allEntries.filter((e) => !e.resolved);

    const entriesByCategory = {} as Record<LearningCategory, number>;
    const entriesByTrigger = {} as Record<LearningTrigger, number>;
    const entriesBySeverity = {} as Record<LearningSeverity, number>;

    for (const entry of allEntries) {
      entriesByCategory[entry.category] = (entriesByCategory[entry.category] || 0) + 1;
      entriesByTrigger[entry.trigger] = (entriesByTrigger[entry.trigger] || 0) + 1;
      entriesBySeverity[entry.severity] = (entriesBySeverity[entry.severity] || 0) + 1;
    }

    const tagCounts = new Map<string, number>();
    for (const entry of allEntries) {
      for (const tag of entry.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    const resolutionTimes = resolved
      .filter((e) => e.resolvedAt && e.timestamp)
      .map((e) => e.resolvedAt!.getTime() - e.timestamp.getTime());

    const avgResolutionTime =
      resolutionTimes.length > 0
        ? resolutionTimes.reduce((sum, t) => sum + t, 0) / resolutionTimes.length
        : 0;

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    return {
      totalEntries: allEntries.length,
      resolvedEntries: resolved.length,
      unresolvedEntries: unresolved.length,
      entriesByCategory,
      entriesByTrigger,
      entriesBySeverity,
      recentEntries: allEntries.slice(-20).reverse(),
      topTags,
      resolutionRate: allEntries.length > 0 ? resolved.length / allEntries.length : 0,
      averageResolutionTimeMs: avgResolutionTime,
      newThisWeek: allEntries.filter((e) => e.timestamp >= weekAgo).length,
      resolvedThisWeek: resolved.filter(
        (e) => e.resolvedAt && e.resolvedAt >= weekAgo
      ).length,
    };
  }

  getEntries(filter?: {
    trigger?: LearningTrigger;
    category?: LearningCategory;
    resolved?: boolean;
    severity?: LearningSeverity;
    source?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): LearningEntry[] {
    let results = Array.from(this.entries.values());

    if (filter?.trigger) results = results.filter((e) => e.trigger === filter.trigger);
    if (filter?.category) results = results.filter((e) => e.category === filter.category);
    if (filter?.resolved !== undefined) results = results.filter((e) => e.resolved === filter.resolved);
    if (filter?.severity) results = results.filter((e) => e.severity === filter.severity);
    if (filter?.source) results = results.filter((e) => e.source === filter.source);
    if (filter?.tags && filter.tags.length > 0) {
      results = results.filter((e) => filter.tags!.some((t) => e.tags.includes(t)));
    }

    results.sort((a, b) => {
      const at = a.timestamp instanceof Date && !Number.isNaN(a.timestamp.getTime()) ? a.timestamp.getTime() : 0;
      const bt = b.timestamp instanceof Date && !Number.isNaN(b.timestamp.getTime()) ? b.timestamp.getTime() : 0;
      return bt - at;
    });

    const offset = filter?.offset || 0;
    const limit = filter?.limit || 50;

    return results.slice(offset, offset + limit);
  }

  getEntry(entryId: string): LearningEntry | undefined {
    return this.entries.get(entryId);
  }

  getSession(sessionId: string): LearningSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessions(): LearningSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
    );
  }

  persistToDisk(): void {
    try {
      const journalPath = path.resolve(this.config.journalPath);
      const dir = path.dirname(journalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const markdown = this.generateJournalMarkdown();
      this.atomicWriteFileSync(journalPath, markdown);

      this.eventBus.publish(
        SystemEvents.LEARNING_JOURNAL_UPDATED,
        { path: journalPath, entryCount: this.entries.size },
        "learning-journal"
      );
    } catch (err) {
      process.stderr.write("[LearningJournal] Failed to persist journal:" + " " + err + "\n");
    }
  }

  /**
   * 原子写入：temp + fsync + rename，跨设备（EXDEV/EBUSY）时回退到目标侧写。
   */
  private atomicWriteFileSync(targetPath: string, content: string): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, content, "utf-8");
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EXDEV" || code === "EBUSY") {
        // 跨设备回退：在目标侧写临时文件后 rename，再清理源临时文件
        const dstTmp = `${targetPath}.${process.pid}.dst.tmp`;
        const fd2 = fs.openSync(dstTmp, "w");
        try {
          fs.writeFileSync(fd2, content, "utf-8");
          fs.fsyncSync(fd2);
        } catch (w2err) {
          try { fs.closeSync(fd2); } catch { /* ignore */ }
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw w2err;
        }
        fs.closeSync(fd2);
        try {
          fs.renameSync(dstTmp, targetPath);
        } catch (renameErr) {
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw renameErr;
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } else {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw err;
      }
    }
  }

  loadFromDisk(): void {
    try {
      const journalPath = path.resolve(this.config.journalPath);
      if (!fs.existsSync(journalPath)) return;

      const content = fs.readFileSync(journalPath, "utf-8");
      this.parseJournalMarkdown(content);
    } catch (err) {
      process.stderr.write("[LearningJournal] Could not load journal from disk:" + " " + err + "\n");
    }
  }

  generateSessionSummary(session: LearningSession): string {
    const lines: string[] = [];
    const totalEntries = session.entries.length;
    const resolvedEntries = session.entries.filter((e) => e.resolved).length;

    lines.push(`## 任务小结`);
    lines.push("");
    lines.push(`- **任务**: ${session.taskDescription}`);
    lines.push(`- **状态**: ${session.status === "completed" ? "✅ 完成" : "❌ 失败"}`);
    lines.push(`- **学习记录**: ${totalEntries} 条`);
    lines.push(`- **已解决**: ${resolvedEntries} / ${totalEntries}`);
    lines.push(`- **用时**: ${session.completedAt ? Math.round((session.completedAt.getTime() - session.startedAt.getTime()) / 1000) : "?"} 秒`);
    lines.push("");

    if (totalEntries > 0) {
      lines.push("### 本次学习要点");
      lines.push("");
      for (const entry of session.entries) {
        const icon = entry.resolved ? "✅" : "📝";
        lines.push(`- ${icon} **${entry.title}** (${entry.trigger})`);
        if (entry.solution) {
          lines.push(`  - 解决方案: ${entry.solution}`);
        }
      }
    }

    if (totalEntries === 0) {
      lines.push("本次任务未触发新的学习记录。");
    }

    return lines.join("\n");
  }

  generateJournalMarkdown(): string {
    const stats = this.getStats();
    const allEntries = Array.from(this.entries.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );

    const lines: string[] = [];

    lines.push("# 🧬 EvoClaw 学习日志 (Learning Journal)");
    lines.push("");
    lines.push("> 本文件由 EvoClaw 进化引擎自动维护。记录系统从每次交互中学习到的经验教训。");
    lines.push("> ");
    lines.push("> **最后更新**: " + new Date().toISOString());
    lines.push("> **学习条目**: " + stats.totalEntries + " | **已解决**: " + stats.resolvedEntries + " | **解决率**: " + Math.round(stats.resolutionRate * 100) + "%");
    lines.push("");
    lines.push("---");
    lines.push("");

    lines.push("## 📊 统计概览");
    lines.push("");
    lines.push("| 指标 | 数值 |");
    lines.push("|------|------|");
    lines.push(`| 总学习条目 | ${stats.totalEntries} |`);
    lines.push(`| 已解决 | ${stats.resolvedEntries} |`);
    lines.push(`| 未解决 | ${stats.unresolvedEntries} |`);
    lines.push(`| 本周新增 | ${stats.newThisWeek} |`);
    lines.push(`| 本周解决 | ${stats.resolvedThisWeek} |`);
    lines.push(`| 解决率 | ${Math.round(stats.resolutionRate * 100)}% |`);
    lines.push("");

    if (stats.topTags.length > 0) {
      lines.push("### 热门标签");
      lines.push("");
      for (const { tag, count } of stats.topTags.slice(0, 5)) {
        lines.push(`- \`${tag}\`: ${count} 次`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");

    if (allEntries.length === 0) {
      lines.push("暂无学习记录。当系统遇到错误、用户纠正或发现改进机会时，会自动记录到这里。");
      lines.push("");
      return lines.join("\n");
    }

    const unresolved = allEntries.filter((e) => !e.resolved);
    const resolved = allEntries.filter((e) => e.resolved);

    if (unresolved.length > 0) {
      lines.push("## ⚠️ 待解决问题");
      lines.push("");
      for (const entry of unresolved.slice(0, 50)) {
        lines.push(this.formatEntryMarkdown(entry));
      }
      lines.push("");
    }

    if (resolved.length > 0) {
      lines.push("## ✅ 已解决经验");
      lines.push("");
      for (const entry of resolved.slice(0, 50)) {
        lines.push(this.formatEntryMarkdown(entry));
      }
      lines.push("");
    }

    if (allEntries.length > 100) {
      lines.push(`> ... 共 ${allEntries.length} 条记录，仅显示最近 100 条。`);
      lines.push("");
    }

    return lines.join("\n");
  }

  private formatEntryMarkdown(entry: LearningEntry): string {
    const lines: string[] = [];
    const icon = entry.resolved ? "✅" : "📝";
    const severityEmoji: Record<string, string> = {
      critical: "🔴",
      high: "🟠",
      medium: "🟡",
      low: "🔵",
      info: "⚪",
    };

    lines.push(`### ${icon} ${severityEmoji[entry.severity] || ""} ${entry.title}`);
    lines.push("");
    lines.push(`- **时间**: ${entry.timestamp.toISOString()}`);
    lines.push(`- **触发**: \`${entry.trigger}\` | **分类**: \`${entry.category}\` | **严重性**: \`${entry.severity}\``);
    lines.push(`- **来源**: ${entry.source}`);
    lines.push(`- **上下文**: ${entry.context}`);

    if (entry.error) {
      lines.push(`- **错误**: \`\`\`\n${entry.error}\n\`\`\``);
    }

    if (entry.rootCause) {
      lines.push(`- **根因**: ${entry.rootCause}`);
    }

    if (entry.correction) {
      lines.push(`- **纠正**: ${entry.correction}`);
    }

    if (entry.solution) {
      lines.push(`- **解决方案**: ${entry.solution}`);
    }

    if (entry.codeSnippet) {
      lines.push(`- **代码示例**:`);
      lines.push(`\`\`\`typescript`);
      lines.push(entry.codeSnippet);
      lines.push(`\`\`\``);
    }

    if (entry.resolved) {
      lines.push(`- **解决时间**: ${entry.resolvedAt?.toISOString()}`);
      lines.push(`- **解决方式**: ${entry.resolvedApproach || "手动修复"}`);
    }

    if (entry.tags.length > 0) {
      lines.push(`- **标签**: ${entry.tags.map((t) => "`" + t + "`").join(" ")}`);
    }

    lines.push("");
    return lines.join("\n");
  }

  private parseJournalMarkdown(content: string): void {
    // 解析已有的学习日志，重建内存中的条目
    const sections = content.split(/\n### /);
    let parsedCount = 0;

    for (const section of sections) {
      if (!section.startsWith("✅ ") && !section.startsWith("📝 ")) continue;

      try {
        const entry = this.parseEntrySection(section);
        if (entry && !this.entries.has(entry.id)) {
          this.entries.set(entry.id, entry);
          parsedCount++;
        }
      } catch {
        // 跳过无法解析的条目
      }
    }

    if (parsedCount > 0) {
      process.stdout.write(`[LearningJournal] Loaded ${parsedCount} entries from journal\n`);
    }
  }

  private parseEntrySection(section: string): LearningEntry | null {
    const lines = section.split("\n");
    const titleLine = lines[0].replace(/^✅ |📝 |🔴 |🟠 |🟡 |🔵 |⚪ /, "").trim();
    if (!titleLine) return null;

    // Parse the entry fields first so we can build a stable id from the
    // timestamp + source + title. Using a fresh uuid on every parse meant
    // the same persisted journal entry would be reloaded as a brand-new
    // record each time, defeating the deduplication check in
    // parseJournalMarkdown and growing the in-memory set without bound.
    let parsedTimestamp: Date = new Date();
    let parsedSource: string | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("- **时间**:")) {
        const dateStr = line.replace("- **时间**:", "").trim();
        const parsed = new Date(dateStr);
        if (!Number.isNaN(parsed.getTime())) {
          parsedTimestamp = parsed;
        }
      } else if (line.startsWith("- **来源**:")) {
        parsedSource = line.replace("- **来源**:", "").trim();
      }
    }

    const stableId = this.computeParsedEntryId(parsedTimestamp, parsedSource || "unknown", titleLine);

    const entry: LearningEntry = {
      id: stableId,
      timestamp: parsedTimestamp,
      trigger: "task_failure",
      category: "error_fix",
      title: titleLine,
      context: "",
      error: null,
      rootCause: null,
      correction: null,
      solution: null,
      codeSnippet: null,
      source: parsedSource || "unknown",
      severity: "medium",
      resolved: lines[0].startsWith("✅"),
      resolvedAt: null,
      resolvedBy: null,
      resolvedApproach: null,
      relatedEntries: [],
      tags: [],
      metadata: {},
    };

    let inCodeBlock = false;
    let codeLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("```")) {
        if (inCodeBlock) {
          entry.codeSnippet = codeLines.join("\n");
          codeLines = [];
        }
        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      if (line.startsWith("- **时间**:")) {
        // Already consumed during the pre-pass that built the stable id.
        continue;
      }

      if (line.startsWith("- **触发**:")) {
        const parts = line.replace("- **触发**:", "").trim();
        const triggerMatch = parts.match(/`(\w+)`/);
        if (triggerMatch) entry.trigger = triggerMatch[1] as LearningTrigger;
        const catMatch = parts.match(/分类.*?`(\w+)`/);
        if (catMatch) entry.category = catMatch[1] as LearningCategory;
        continue;
      }

      if (line.startsWith("- **来源**:")) {
        // Already captured during the pre-pass; keep value authoritative.
        continue;
      }

      if (line.startsWith("- **上下文**:")) {
        entry.context = line.replace("- **上下文**:", "").trim();
        continue;
      }

      if (line.startsWith("- **错误**:")) {
        entry.error = line.replace("- **错误**:", "").trim();
        continue;
      }

      if (line.startsWith("- **根因**:")) {
        entry.rootCause = line.replace("- **根因**:", "").trim();
        continue;
      }

      if (line.startsWith("- **纠正**:")) {
        entry.correction = line.replace("- **纠正**:", "").trim();
        continue;
      }

      if (line.startsWith("- **解决方案**:")) {
        entry.solution = line.replace("- **解决方案**:", "").trim();
        continue;
      }

      if (line.startsWith("- **解决方式**:")) {
        entry.resolvedApproach = line.replace("- **解决方式**:", "").trim();
        continue;
      }

      if (line.startsWith("- **标签**:")) {
        const tagText = line.replace("- **标签**:", "").trim();
        const tagMatches = tagText.match(/`([^`]+)`/g);
        if (tagMatches) {
          entry.tags = tagMatches.map((t) => t.replace(/`/g, ""));
        }
        continue;
      }

      if (line.startsWith("- **严重性**:")) {
        continue;
      }
    }

    return entry;
  }

  /**
   * Generate a stable id for a parsed journal entry. The id is derived from
   * the (timestamp, source, title) tuple so that re-parsing the same journal
   * produces the same id, which lets the deduplication guard in
   * parseJournalMarkdown actually dedupe.
   */
  private computeParsedEntryId(timestamp: Date, source: string, title: string): string {
    const key = `${timestamp.getTime()}|${source}|${title}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    // Match the uuid v4 layout loosely so consumers expecting a uuid-shaped
    // string (e.g. logging tools) still work. The exact value is irrelevant
    // as long as it is deterministic for the same input.
    const hex = Math.abs(hash).toString(16).padStart(8, "0").slice(0, 8);
    return `parsed-${hex}-${timestamp.getTime().toString(36)}`;
  }

  private inferSeverity(category: LearningCategory, trigger: LearningTrigger): LearningSeverity {
    if (trigger === "command_failed" || trigger === "api_failure") return "high";
    if (category === "error_fix" || category === "external_dependency") return "high";
    if (trigger === "user_correction") return "medium";
    if (trigger === "capability_gap") return "medium";
    if (trigger === "knowledge_outdated" || trigger === "pattern_improvement") return "low";
    return "medium";
  }

  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    return intersection / Math.max(wordsA.size, wordsB.size);
  }

  private persistScheduled = false;
  private pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    this.pendingPersistTimer = setTimeout(() => {
      this.pendingPersistTimer = null;
      this.persistToDisk();
      this.persistScheduled = false;
    }, 1000);
    this.pendingPersistTimer.unref();
  }

  stop(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.pendingPersistTimer) {
      clearTimeout(this.pendingPersistTimer);
      this.pendingPersistTimer = null;
    }
    this.persistScheduled = false;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}