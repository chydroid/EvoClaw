import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryAstronomyReply } from "./quick-reply";

// ═══════════════════════════════════════════════════════════
// 测试套件：天文时刻本地计算快速通道（tryAstronomyReply）
// 覆盖：日出日落查询通过 Open-Meteo API 本地计算，不依赖 LLM/搜索
// ═══════════════════════════════════════════════════════════

const mockResponses: Record<string, unknown> = {};

vi.mock("https", () => ({
  get: vi.fn((url: string, callback: (res: unknown) => void) => {
    const response = mockResponses[url];
    const res = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          if (response !== undefined) {
            handler(Buffer.from(JSON.stringify(response)));
          }
        } else if (event === "end") {
          handler();
        }
        return res;
      }),
    };
    callback(res);
    return { on: vi.fn() };
  }),
}));

function buildGeoUrl(location: string) {
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`;
}

function buildForecastUrl(lat: number, lon: number, date: string) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto&start_date=${date}&end_date=${date}`;
}

beforeEach(() => {
  Object.keys(mockResponses).forEach((k) => delete mockResponses[k]);
});

describe("quick-reply > tryAstronomyReply", () => {
  it("中文日出日落查询应返回格式化的日出日落时间", async () => {
    const geoUrl = buildGeoUrl("信阳市平桥区");
    mockResponses[geoUrl] = {
      results: [
        { name: "平桥", latitude: 32.43, longitude: 114.12, admin1: "河南省", country: "中国" },
      ],
    };

    const date = new Date();
    date.setDate(date.getDate() + 1);
    const dateStr = date.toISOString().slice(0, 10);
    const forecastUrl = buildForecastUrl(32.43, 114.12, dateStr);
    mockResponses[forecastUrl] = {
      daily: {
        time: [dateStr],
        sunrise: [`${dateStr}T05:20:00`],
        sunset: [`${dateStr}T19:35:00`],
      },
    };

    const reply = await tryAstronomyReply("告诉我信阳市平桥区明天的日出时间和日落时间");

    expect(reply).toContain("平桥");
    expect(reply).toContain("日出：05:20");
    expect(reply).toContain("日落：19:35");
  });

  it("英文 sunrise/sunset 查询应返回格式化的日出日落时间", async () => {
    const geoUrl = buildGeoUrl("Xinyang Pingqiao");
    mockResponses[geoUrl] = {
      results: [
        { name: "Pingqiao", latitude: 32.43, longitude: 114.12, admin1: "Henan", country: "China" },
      ],
    };

    const date = new Date();
    date.setDate(date.getDate() + 1);
    const dateStr = date.toISOString().slice(0, 10);
    const forecastUrl = buildForecastUrl(32.43, 114.12, dateStr);
    mockResponses[forecastUrl] = {
      daily: {
        time: [dateStr],
        sunrise: [`${dateStr}T05:20:00`],
        sunset: [`${dateStr}T19:35:00`],
      },
    };

    const reply = await tryAstronomyReply("What is the sunrise and sunset time in Xinyang Pingqiao tomorrow?");

    expect(reply).toContain("Pingqiao");
    expect(reply).toContain("日出：05:20");
    expect(reply).toContain("日落：19:35");
  });

  it("非天文查询应返回 null", async () => {
    const reply = await tryAstronomyReply("你好");
    expect(reply).toBeNull();
  });

  it("地理编码无结果时应返回 null 并优雅降级", async () => {
    const geoUrl = buildGeoUrl("不存在的地方");
    mockResponses[geoUrl] = { results: [] };

    const reply = await tryAstronomyReply("告诉我不存在的地方明天的日出日落时间");
    expect(reply).toBeNull();
  });

  it("API 异常时应返回 null 并优雅降级", async () => {
    const reply = await tryAstronomyReply("告诉我北京的日出日落时间");
    expect(reply).toBeNull();
  });
});
