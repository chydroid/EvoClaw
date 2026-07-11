import { describe, it, expect } from "vitest";
import { SKILLmdParser } from "./skill-md-parser";

const sampleSKILLmd = `---
name: weather-reporter
version: 1.2.0
description: Fetch and report weather information
author: EvoClaw Team
triggers:
  - type: keyword
    pattern: "weather"
    description: Fetched when user mentions weather
  - type: intent
    pattern: "check_temperature"
    description: Temperature lookup
requires:
  - name: weather-api
    version: ">=2.0.0"
  - name: geo-locator
    version: "*"
    optional: true
config:
  apiEndpoint: "https://api.weather.com"
  units: "metric"
---

## Instructions

To fetch weather data, call the weather API with location parameters.

1. Detect the user's location
2. Query the weather API
3. Format results for display

## Scripts

\`\`\`typescript
export async function fetchWeather(location: string): Promise<WeatherData> {
  const api = getConfig("apiEndpoint");
  const response = await fetch(\`\${api}/current?q=\${location}\`);
  return response.json();
}
\`\`\`

\`\`\`bash
#!/bin/bash
echo "Installing weather skill dependencies..."
npm install axios
\`\`\`

## Examples

User: "What's the weather in Tokyo?"
Assistant: Fetching and displaying weather data for Tokyo.
`;

describe("SKILLmdParser", () => {
  it("should parse frontmatter metadata", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(sampleSKILLmd);

    expect(doc.meta.name).toBe("weather-reporter");
    expect(doc.meta.version).toBe("1.2.0");
    expect(doc.meta.description).toBe("Fetch and report weather information");
    expect(doc.meta.author).toBe("EvoClaw Team");
  });

  it("should parse triggers", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(sampleSKILLmd);

    expect(doc.meta.triggers).toHaveLength(2);
    expect(doc.meta.triggers[0]).toEqual({
      type: "keyword",
      pattern: "weather",
      description: "Fetched when user mentions weather",
    });
    expect(doc.meta.triggers[1]).toEqual({
      type: "intent",
      pattern: "check_temperature",
      description: "Temperature lookup",
    });
  });

  it("should parse dependencies", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(sampleSKILLmd);

    expect(doc.meta.requires).toHaveLength(2);
    expect(doc.meta.requires[0]).toEqual({
      name: "weather-api",
      version: ">=2.0.0",
      optional: false,
    });
    expect(doc.meta.requires[1]).toEqual({
      name: "geo-locator",
      version: "*",
      optional: true,
    });
  });

  it("should parse configuration", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(sampleSKILLmd);

    expect(doc.meta.config).toEqual({
      apiEndpoint: "https://api.weather.com",
      units: "metric",
    });
  });

  it("should parse code scripts", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(sampleSKILLmd);

    const scripts = doc.scripts || {};
    const scriptKeys = Object.keys(scripts);
    expect(scriptKeys.length).toBeGreaterThanOrEqual(2);

    const tsScript = scripts["typescript"] || scripts["default"] || Object.values(scripts)[0];
    expect(tsScript).toContain("fetchWeather");
  });

  // 回归：远端 ClawHub 技能 SKILL.md 的 frontmatter 可能是无效 YAML
  // （典型如 description block scalar 中夹杂顶格的中文段落，破坏 js-yaml 解析）。
  // gray-matter 抛异常时，parser 应回退到 lenient 行级扫描，抢救 name/version/description，
  // 而非让 name 回退到 H1 标题（会导致命名规范校验失败）。
  it("should fall back to lenient parser when YAML frontmatter is malformed", async () => {
    const parser = new SKILLmdParser();
    // description: | block scalar 中夹杂顶格"重要：..."段落，js-yaml 会抛
    // "can not read a block mapping entry; a multiline key may not be an implicit key"
    const malformed = `---
name: longtask_system
version: 1.2.0
description: |
  长程任务执行管理系统 | Long-running Task Execution Management System
  通过状态文件驱动，将长任务拆分为子任务。

重要：为了确保长程任务执行的效果，每一个子任务会强制通过/new重置对话后执行。

---

# LongTask System - 长程任务执行管理

## 核心机制
正文内容
`;

    const doc = await parser.parse(malformed);

    // name 应来自 frontmatter 的 name 字段（合法 slug），而非 H1 标题
    expect(doc.meta.name).toBe("longtask_system");
    expect(doc.meta.version).toBe("1.2.0");
    // description 应包含完整 block scalar 内容（含顶格的"重要：..."段落）
    expect(doc.meta.description).toContain("长程任务执行管理系统");
    expect(doc.meta.description).toContain("重要：为了确保长程任务执行的效果");
    // 不应回退到 H1 标题作为 name
    expect(doc.meta.name).not.toBe("LongTask System - 长程任务执行管理");
  });
});