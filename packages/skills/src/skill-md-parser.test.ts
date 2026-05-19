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
});