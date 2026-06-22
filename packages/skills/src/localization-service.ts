import { ServiceRegistry, type SkillI18n } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

interface TranslationCache {
  [key: string]: string;
}

interface I18nFile {
  description_zh?: string;
  instructions_zh?: string;
  examples_zh?: string[];
  translatedAt?: string;
}

export class LocalizationService {
  private cache = new Map<string, TranslationCache>();
  private translationQueue: Array<() => Promise<void>> = [];
  private isProcessing = false;

  constructor(private registry: ServiceRegistry) {
    registry.registerService("localizationService", this);
  }

  needsChineseTranslation(text: string | undefined | null): boolean {
    if (!text || text.trim().length === 0) return false;
    const cjkRatio = this.cjkRatio(text);
    return cjkRatio < 0.1;
  }

  hasChineseContent(text: string | undefined | null): boolean {
    if (!text || text.trim().length === 0) return false;
    return this.cjkRatio(text) >= 0.1;
  }

  async translateToChinese(text: string, context?: string): Promise<string> {
    if (!text || text.trim().length === 0) return text;
    if (!this.needsChineseTranslation(text)) return text;

    const cacheKey = this.getCacheKey(text);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const translated = await this.callLLMForTranslation(text, context);
      this.saveToCache(cacheKey, translated);
      return translated;
    } catch (err) {
      process.stderr.write(`[LocalizationService] Translation failed: ${err instanceof Error ? err.message : String(err)}`);
      return text;
    }
  }

  async translateSkillContent(
    description: string,
    instructions: string,
    examples: string[],
    skillName: string
  ): Promise<SkillI18n> {
    const i18n: SkillI18n = {};
    const tasks: Promise<void>[] = [];

    if (this.needsChineseTranslation(description)) {
      tasks.push(
        this.translateToChinese(description, `技能"${skillName}"的描述`).then(t => { i18n.description_zh = t; })
      );
    }

    if (this.needsChineseTranslation(instructions)) {
      tasks.push(
        this.translateToChinese(instructions, `技能"${skillName}"的使用说明`).then(t => { i18n.instructions_zh = t; })
      );
    }

    const examplesToTranslate = examples.filter(e => this.needsChineseTranslation(e));
    if (examplesToTranslate.length > 0) {
      tasks.push(
        Promise.all(
          examplesToTranslate.map(e => this.translateToChinese(e, `技能"${skillName}"的使用示例`))
        ).then(translated => { i18n.examples_zh = translated; })
      );
    }

    await Promise.all(tasks);
    i18n.translatedAt = new Date().toISOString();
    return i18n;
  }

  async translatePluginContent(
    description: string,
    pluginName: string
  ): Promise<{ description_zh?: string; translatedAt?: string }> {
    const result: { description_zh?: string; translatedAt?: string } = {};

    if (this.needsChineseTranslation(description)) {
      result.description_zh = await this.translateToChinese(description, `插件"${pluginName}"的描述`);
    }

    if (result.description_zh) {
      result.translatedAt = new Date().toISOString();
    }

    return result;
  }

  saveI18nFile(skillDir: string, i18n: SkillI18n): void {
    const i18nPath = path.join(skillDir, "_i18n.json");
    try {
      const existing = this.loadI18nFile(skillDir);
      const merged = { ...existing, ...i18n };
      fs.writeFileSync(i18nPath, JSON.stringify(merged, null, 2), "utf-8");
    } catch (err) {
      process.stderr.write(`[LocalizationService] Failed to save i18n file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  loadI18nFile(skillDir: string): I18nFile | null {
    const i18nPath = path.join(skillDir, "_i18n.json");
    try {
      if (fs.existsSync(i18nPath)) {
        return JSON.parse(fs.readFileSync(i18nPath, "utf-8"));
      }
    } catch { /* ignore */ }
    return null;
  }

  async checkAndTranslateSkill(
    skill: {
      name: string;
      description: string;
      installPath: string;
      body: { instructions: string; examples: string[] };
      i18n?: SkillI18n;
    }
  ): Promise<SkillI18n | undefined> {
    const skillDir = path.dirname(skill.installPath);
    const existingI18n = skill.i18n || this.loadI18nFile(skillDir) || undefined;

    const needsDesc = this.needsChineseTranslation(skill.description) && !existingI18n?.description_zh;
    const needsInstr = this.needsChineseTranslation(skill.body.instructions) && !existingI18n?.instructions_zh;
    const needsExamples = skill.body.examples.some(e => this.needsChineseTranslation(e)) &&
      (!existingI18n?.examples_zh || existingI18n.examples_zh.length === 0);

    if (!needsDesc && !needsInstr && !needsExamples) {
      return existingI18n || undefined;
    }

    process.stdout.write(`[LocalizationService] Translating skill "${skill.name}" to Chinese...`);

    try {
      const i18n = await this.translateSkillContent(
        skill.description,
        skill.body.instructions,
        skill.body.examples,
        skill.name
      );

      const merged: SkillI18n = {
        description_zh: i18n.description_zh || existingI18n?.description_zh,
        instructions_zh: i18n.instructions_zh || existingI18n?.instructions_zh,
        examples_zh: i18n.examples_zh || existingI18n?.examples_zh,
        translatedAt: i18n.translatedAt || existingI18n?.translatedAt,
      };

      this.saveI18nFile(skillDir, merged);
      process.stdout.write(`[LocalizationService] Skill "${skill.name}" translated successfully`);
      return merged;
    } catch (err) {
      process.stderr.write(`[LocalizationService] Failed to translate skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`);
      return existingI18n || undefined;
    }
  }

  async checkAndTranslatePlugin(
    plugin: { name: string; description: string }
  ): Promise<{ description_zh?: string; translatedAt?: string } | undefined> {
    if (!this.needsChineseTranslation(plugin.description)) {
      return undefined;
    }

    process.stdout.write(`[LocalizationService] Translating plugin "${plugin.name}" to Chinese...`);

    try {
      const result = await this.translatePluginContent(plugin.description, plugin.name);
      process.stdout.write(`[LocalizationService] Plugin "${plugin.name}" translated successfully`);
      return result;
    } catch (err) {
      process.stderr.write(`[LocalizationService] Failed to translate plugin "${plugin.name}": ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  enqueueTranslation(task: () => Promise<void>): void {
    this.translationQueue.push(task);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.translationQueue.length > 0) {
      const task = this.translationQueue.shift();
      if (task) {
        try {
          await task();
        } catch (err) {
          process.stderr.write(`[LocalizationService] Queue task failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    this.isProcessing = false;
  }

  private async callLLMForTranslation(text: string, context?: string): Promise<string> {
    const executor = this.registry.resolveService<{
      getProviders(): Array<{
        id: string;
        name: string;
        provider: string;
        model: string;
        apiKey?: string;
        baseURL?: string;
        enabled: boolean;
      }>;
    }>("agentModelExecutor");

    if (!executor) {
      // 没有可用的翻译执行器时直接返回原文，避免在测试等未注册 LLM 的场景中反复输出错误日志
      return text;
    }

    const providers = executor.getProviders().filter(p => p.enabled);
    if (providers.length === 0) {
      throw new Error("No LLM providers available for translation");
    }

    const provider = providers[0];
    const baseURL = provider.baseURL || "https://api.openai.com/v1";
    const apiUrl = `${baseURL}/chat/completions`;

    const systemPrompt = `你是一个专业的技术翻译专家。将以下英文内容翻译成准确、专业的中文。保持技术术语的准确性，使用行业通用译法。只返回翻译结果，不要添加任何解释或注释。如果内容中包含代码或命令，保持原样不翻译。`;

    const userPrompt = context
      ? `上下文：${context}\n\n请翻译以下内容：\n${text}`
      : `请翻译以下内容：\n${text}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (provider.provider === "anthropic" || provider.model?.includes("claude")) {
      headers["x-api-key"] = provider.apiKey || "";
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${provider.apiKey || ""}`;
    }

    const body = provider.provider === "anthropic" || provider.model?.includes("claude")
      ? {
          model: provider.model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }
      : {
          model: provider.model,
          max_tokens: 2048,
          temperature: 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<{ message: { content: string } }> | undefined;
      if (choices && choices.length > 0 && choices[0].message?.content) {
        return choices[0].message.content.trim();
      }

      const content = data.content as Array<{ type: string; text: string }> | undefined;
      if (content && content.length > 0 && content[0].text) {
        return content[0].text.trim();
      }

      throw new Error("Unexpected LLM response format");
    } finally {
      clearTimeout(timeout);
    }
  }

  private cjkRatio(text: string): number {
    if (text.length === 0) return 0;
    let cjkCount = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef)
      ) {
        cjkCount++;
      }
    }
    return cjkCount / text.length;
  }

  private getCacheKey(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `tr_${Math.abs(hash).toString(36)}`;
  }

  private getFromCache(key: string): string | undefined {
    const entry = this.cache.get(key);
    return entry?.[key];
  }

  private saveToCache(key: string, value: string): void {
    this.cache.set(key, { [key]: value });
    if (this.cache.size > 500) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
