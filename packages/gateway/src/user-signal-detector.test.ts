import { describe, it, expect } from "vitest";
import {
  detectUserCorrection,
  detectCapabilityGap,
  RecentSignalStore,
} from "../src/user-signal-detector";

describe("detectUserCorrection", () => {
  it("检测强信号：你错了 / 不是让你", () => {
    expect(detectUserCorrection("你错了，应该用 POST")).not.toBeNull();
    expect(detectUserCorrection("不是让你删库，是让你改配置")).not.toBeNull();
  });

  it("检测强信号（英文）：that's wrong / no, you're wrong", () => {
    expect(detectUserCorrection("No, that's not what I asked")).not.toBeNull();
    expect(detectUserCorrection("You're wrong about the port")).not.toBeNull();
  });

  it("检测弱信号：不对+指代上文", () => {
    expect(detectUserCorrection("不对，你刚才说的端口是错的")).not.toBeNull();
  });

  it("检测弱信号：应该是+指代上文，并提取正确做法", () => {
    const sig = detectUserCorrection("应该是 27789，你上面说错了");
    expect(sig).not.toBeNull();
    expect(sig!.correction).toContain("27789");
  });

  it("普通陈述不误报：不对/应该是 无指代上文时不触发", () => {
    expect(detectUserCorrection("这个说法不对")).toBeNull();
    expect(detectUserCorrection("今天天气应该是晴天")).toBeNull();
    expect(detectUserCorrection("帮助一下谢谢")).toBeNull();
  });

  it("空消息 / 过短消息不触发", () => {
    expect(detectUserCorrection("")).toBeNull();
    expect(detectUserCorrection("好")).toBeNull();
  });
});

describe("detectCapabilityGap", () => {
  it("检测中文拒绝句式", () => {
    const sig = detectCapabilityGap("抱歉，我无法完成这个任务。", "把 Excel 转成多维表格");
    expect(sig).not.toBeNull();
    expect(sig!.kind).toBe("capability_gap");
    expect(sig!.capability).toContain("Excel");
  });

  it("检测英文拒绝句式", () => {
    const sig = detectCapabilityGap("I'm sorry, but I cannot do that request.", "rotate keys");
    expect(sig).not.toBeNull();
  });

  it("普通回复不误报", () => {
    expect(detectCapabilityGap("好的，已经完成了文件整理。", "整理文件")).toBeNull();
    expect(detectCapabilityGap("该页面无法访问，请检查网络连接。", "打开页面")).toBeNull();
    expect(detectCapabilityGap("", "任意")).toBeNull();
  });
});

describe("RecentSignalStore", () => {
  it("同签名在 TTL 内只放行一次", () => {
    const store = new RecentSignalStore(60_000);
    expect(store.isDuplicate("k1")).toBe(false);
    expect(store.isDuplicate("k1")).toBe(true);
    expect(store.isDuplicate("k2")).toBe(false);
  });

  it("TTL 过期后重新放行", () => {
    const store = new RecentSignalStore(60_000);
    expect(store.isDuplicate("k1", 0)).toBe(false);
    expect(store.isDuplicate("k1", 60_001)).toBe(false);
  });
});
