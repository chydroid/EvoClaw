import { describe, it, expect } from "vitest";
import { SemanticQuickReply } from "./semantic-quick-reply";

/**
 * SemanticQuickReply 回归（2026-11-26 实证）。
 *
 * 事故：用户发「请只回复两个字：收到」，本地 embedding 余弦相似度把 top3 判成
 *   capability=0.7195, worry=0.7106, identity=0.7103
 * ——冠军与亚军只差 0.009，纯属噪声。旧实现只看绝对阈值 0.45（对闲聊短句
 * 形同虚设），于是"谁排第一谁赢"，把用户的明确指令劫持成自我介绍。
 *
 * 修复：① 绝对阈值 0.45→0.6；② 新增 top1−top2 margin 判据（默认 0.05）；
 * ③ 显式指令与长消息前置闸门，根本不进分类。
 */

/** 构造一个可控的假 embedding provider：按文本返回预设向量。 */
function makeProvider(vectors: Record<string, number[]>) {
  return {
    embed: async (text: string) => {
      if (vectors[text]) return vectors[text];
      throw new Error(`no vector for: ${text}`);
    },
  };
}

/**
 * 让某个 category 的模板全部映射到同一方向，便于构造确定性的相似度。
 * 用 3 维单位向量，角度直接决定余弦值。
 */
function unit(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), 0];
}

describe("SemanticQuickReply > margin 判据（分类器拿不准就交给 LLM）", () => {
  it("top1 与 top2 过于接近时返回 null（事故复现）", async () => {
    // presence 与 hello 两个类别的模板都落在 0° 附近
    const provider = makeProvider({
      "你在吗": unit(0),
      "你在不在": unit(0),
      "在吗": unit(0),
      "在线吗": unit(0),
      "你还在吗": unit(0),
      "are you there": unit(0),
      "are you online": unit(0),
      "you around": unit(0),
      "你好": unit(1),
      "嗨": unit(1),
      "哈喽": unit(1),
      "早上好": unit(1),
      "晚上好": unit(1),
      "下午好": unit(1),
      "hello": unit(1),
      "hi": unit(1),
      "hey": unit(1),
      "good morning": unit(1),
      "good evening": unit(1),
      // 用户消息恰好卡在两个类别中间 → 两个分数几乎相同
      "嗯？": unit(0.5),
    });

    const clf = new SemanticQuickReply();
    clf.setProvider(provider);
    const reply = await clf.classify("嗯？", { name: "EvoClaw", masterTerm: "主人" } as never);

    // 两个候选分数差 < margin(0.05) → 必须放弃，交给 LLM
    expect(reply).toBeNull();
  });

  it("top1 显著领先时才返回快捷回复", async () => {
    const provider = makeProvider({
      "你好": unit(0),
      "嗨": unit(0),
      "哈喽": unit(0),
      "早上好": unit(0),
      "晚上好": unit(0),
      "下午好": unit(0),
      "hello": unit(0),
      "hi": unit(0),
      "hey": unit(0),
      "good morning": unit(0),
      "good evening": unit(0),
      "你在吗": unit(60),
      "在吗": unit(60),
      // 用户消息几乎与 hello 同向 → 与 presence 差距巨大
      "你好呀": unit(2),
    });

    const clf = new SemanticQuickReply();
    clf.setProvider(provider);
    const reply = await clf.classify("你好呀", { name: "EvoClaw", masterTerm: "主人" } as never);

    expect(reply).toBeTruthy();
    expect(typeof reply).toBe("string");
  });
});

describe("SemanticQuickReply > 输入闸门（显式指令绝不进分类）", () => {
  it("「请只回复两个字：收到」直接返回 null，连 embed 都不调用", async () => {
    let embedCalls = 0;
    const provider = {
      embed: async () => {
        embedCalls++;
        // 故意返回与 capability 同向的向量：若闸门失效，就会被判成闲聊
        return unit(0);
      },
    };
    const clf = new SemanticQuickReply();
    clf.setProvider(provider);

    const reply = await clf.classify("请只回复两个字：收到", {
      name: "EvoClaw",
      masterTerm: "主人",
    } as never);

    expect(reply).toBeNull();
    // 闸门在 initialize() 之前就拦下——一次 embedding 都不该发生（零成本拒绝）
    expect(embedCalls).toBe(0);
  });

  it("classifyIntent 同样拒绝显式指令", async () => {
    const provider = {
      embed: async () => unit(0),
    };
    const clf = new SemanticQuickReply();
    clf.setProvider(provider);

    expect(await clf.classifyIntent("只输出 OK")).toBeNull();
    expect(await clf.classifyIntent("请只回复两个字：收到")).toBeNull();
  });
});

describe("SemanticQuickReply > 阈值默认值", () => {
  it("默认阈值 0.6、margin 0.05（旧值 0.45 对本地 embedding 形同虚设）", () => {
    const status = new SemanticQuickReply().getStatus();
    expect(status.threshold).toBe(0.6);
    expect(status.margin).toBe(0.05);
  });

  it("可显式覆盖", () => {
    const status = new SemanticQuickReply({ threshold: 0.8, margin: 0.12 }).getStatus();
    expect(status.threshold).toBe(0.8);
    expect(status.margin).toBe(0.12);
  });
});
