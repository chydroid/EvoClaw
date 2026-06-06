import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WeixinPluginAdapter, matchSimpleGreeting, __test } from "./weixin-plugin-adapter";
import { EventBus } from "@evoclaw/core";
import type { AgentModelExecutor } from "@evoclaw/agent";

const { SIMPLE_GREETING_ENTRIES } = __test;

/** 工具：取出某 category 的所有 replies */
function repliesOf(category: string): string[] {
  const entry = SIMPLE_GREETING_ENTRIES.find((e) => e.category === category);
  if (!entry) throw new Error(`No entry for category: ${category}`);
  return entry.replies;
}

/**
 * 微信通道去重逻辑测试
 *
 * 验证：用户发送简单短消息（如"你还有反应吗"）时，WeixinPluginAdapter 只发送一条最终回复，
 * 不会因为 firstFeedback、onProgress 进度事件等产生重复回复。
 */

// ── 模拟的 AgentModelExecutor ─────────────────────────────────────────────────
function createMockAgentExecutor(): AgentModelExecutor {
  // 捕获 onProgress 回调以便在测试中触发进度事件
  let capturedOnProgress: ((event: any) => void) | null = null;

  const mock: any = {
    chat: vi.fn(async (text: string, ctx: any, onProgress?: any) => {
      capturedOnProgress = onProgress || null;
      // 模拟快速回复
      return {
        reply: "我在的，一切正常。",
        tokensUsed: 10,
        duration: 100,
        toolCalls: [],
      };
    }),
    generateBriefUnderstanding: vi.fn(async (text: string) => {
      return "正在理解您的问题...";
    }),
    approveAndExecute: vi.fn(),
    rejectPermission: vi.fn(),
    _triggerProgress: (event: any) => {
      if (capturedOnProgress) capturedOnProgress(event);
    },
  };

  return mock as AgentModelExecutor;
}

function createMockEventBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

describe("WeixinPluginAdapter - 重复回复去重", () => {
  let adapter: WeixinPluginAdapter;
  let mockExecutor: any;
  let mockEventBus: EventBus;
  let sentMessages: string[];

  // 拦截 sendMessage 调用
  const originalSend = (WeixinPluginAdapter.prototype as any).sendMessage;

  beforeEach(() => {
    mockEventBus = createMockEventBus();
    mockExecutor = createMockAgentExecutor();
    adapter = new WeixinPluginAdapter(mockEventBus, mockExecutor);
    sentMessages = [];

    // 替换 sendMessage 私有方法以捕获发送的消息
    (adapter as any).sendMessage = vi.fn(async (account: any, toUserId: string, text: string) => {
      sentMessages.push(text);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("简单短消息（'你还有反应吗'）应走问候快速通道", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [
        {
          type: 1,
          text_item: { text: "你还有反应吗" },
        },
      ],
    };

    // 拦截 sendTyping 等副作用
    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    // 关键断言：不应该有 "📋 收到" 这样的反馈消息
    const feedbackMessages = sentMessages.filter((m) => m.startsWith("📋"));
    expect(feedbackMessages).toEqual([]);

    // 走快速通道：只发送 1 条问候回复
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBeTruthy();
    expect(mockExecutor.chat).not.toHaveBeenCalled();
  });

  it("带问号的长消息应该触发 firstFeedback '收到'消息", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const longText = "请帮我详细分析一下当前中国和美国在人工智能领域的技术差距，包括芯片、算法、数据、应用场景和未来趋势？";
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [
        {
          type: 1,
          text_item: { text: longText },
        },
      ],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    // 应该有 firstFeedback
    const feedbackMessages = sentMessages.filter((m) => m.startsWith("📋"));
    expect(feedbackMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("短消息带句号应走问候快速通道（不调用 LLM）", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [
        {
          type: 1,
          text_item: { text: "你好。" },
        },
      ],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    // 问候应走快速通道，发送 1 条简短回复
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBeTruthy();
    expect(sentMessages[0].length).toBeGreaterThan(2);
    expect(mockExecutor.chat).not.toHaveBeenCalled();
  });

  it("'你还有反应吗'应走问候快速通道（不调用 LLM）", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [
        {
          type: 1,
          text_item: { text: "你还有反应吗" },
        },
      ],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    // 问候走快速通道：1 条消息，不调用 LLM
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBeTruthy();
    expect(sentMessages[0].length).toBeGreaterThan(2);
    expect(mockExecutor.chat).not.toHaveBeenCalled();
  });

  it("onProgress 工具完成事件60秒内不重复推送", async () => {
    // 自定义 mock：让 chat 调用期间触发多个 tool_result 事件
    let capturedOnProgress: ((event: any) => void) | null = null;
    mockExecutor.chat = vi.fn(async (text: string, ctx: any, onProgress?: any) => {
      capturedOnProgress = onProgress || null;
      if (capturedOnProgress) {
        // 模拟连续多次完成同一工具
        capturedOnProgress({ type: "tool_result", toolName: "web_search" });
        capturedOnProgress({ type: "tool_result", toolName: "web_search" });
        capturedOnProgress({ type: "tool_result", toolName: "web_search" });
      }
      return { reply: "搜索完成", tokensUsed: 10, duration: 100, toolCalls: [] };
    });

    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [
        {
          type: 1,
          text_item: { text: "请帮我搜索一些信息" },
        },
      ],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    // web_search 第一次发送"✅ 已完成1轮网络搜索"
    // 后续第2、3次应在 60 秒内被去重，不应再发送
    const searchMessages = sentMessages.filter((m) => m.includes("网络搜索"));
    expect(searchMessages.length).toBe(1);
  });
});

describe("matchSimpleGreeting - 简单问候快速匹配", () => {
  // ── 存在性询问 ──
  const presenceReplies = repliesOf("presence");

  it.each([
    "你还有反应吗", "你还有反应吗？",
    "在吗", "你在吗", "你还在吗",
    "你在线吗", "在线么", "在线吗",
    "活着吗", "你活着吗",
    "在听吗", "听得到吗", "听得到",
    "能听到吗", "能收到吗",
    "醒着吗", "你醒着",
    "收到我消息吗", "收到消息",
  ])("'应匹配存在性询问: %s'", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(presenceReplies).toContain(reply!);
  });

  // ── 打招呼 ──
  const helloReplies = repliesOf("hello");

  it.each([
    "你好", "您好", "Hi", "hi", "Hello", "hello",
    "嗨", "哈喽", "hey", "Hey", "yo",
    "早上好", "下午好", "晚上好", "中午好",
    "早安", "晚安", "早",
  ])("应匹配打招呼: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(helloReplies).toContain(reply!);
  });

  // ── 身份询问 ──
  const identityReplies = repliesOf("identity");

  it.each([
    "你是谁", "你叫什么", "你叫什么名字", "你叫啥",
    "介绍下", "介绍一下", "介绍介绍",
    "哪个AI", "哪个模型",
    "是AI吗", "你是AI吗", "是不是AI",
    "是机器人", "是机器人吗", "是人还是AI",
    "你几岁", "你多大了", "你多大",
  ])("应匹配身份询问: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(identityReplies).toContain(reply!);
  });

  // ── 状态询问 ──
  const statusReplies = repliesOf("status");

  it.each([
    "你忙啥", "忙啥", "忙啥呢", "你忙啥呢",
    "在干嘛", "在干啥", "在做什么",
    "干嘛", "干啥", "做啥", "你做啥",
    "在忙吗", "在工作吗", "在写代码吗",
    "累不累", "你累吗", "累吗",
    "困吗", "你今天干了啥", "今天干了啥",
  ])("应匹配状态询问: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(statusReplies).toContain(reply!);
  });

  // ── 寒暄/关心 ──
  const howReplies = repliesOf("howareyou");

  it.each([
    "你今天怎么样", "今天怎么样", "你怎么样",
    "你好吗", "好不好", "你还好吗", "还好吗",
    "你开心吗", "心情怎么样",
  ])("应匹配寒暄/关心: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(howReplies).toContain(reply!);
  });

  // ── 感谢 ──
  const thanksReplies = repliesOf("thanks");

  it.each([
    "谢谢", "多谢", "感谢", "谢啦", "谢了", "辛苦",
    "thanks", "thank you", "Thank you", "ty", "3q",
    "thx", "tks", "tnx", "tq",
  ])("应匹配感谢: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(thanksReplies).toContain(reply!);
  });

  // ── 反馈/确认 ──
  const ackReplies = repliesOf("ack");

  it.each([
    "好的", "收到", "了解", "明白", "懂了", "知道了", "晓得",
    "嗯嗯", "OK", "ok", "Ok",
  ])("应匹配确认: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(ackReplies).toContain(reply!);
  });

  // ── 告别 ──
  const byeReplies = repliesOf("bye");

  it.each([
    "再见", "拜拜", "bye", "Bye", "走了", "撤了", "溜了",
    "回聊", "回头聊", "88",
    "睡了", "去休息", "休息了", "再会", "改天再聊",
  ])("应匹配告别: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(byeReplies).toContain(reply!);
  });

  // ── 短反应/感叹（这些是 react 独占的） ──
  const reactReplies = repliesOf("react");

  it.each([
    "啊", "啊?", "啊！", "啊哈", "噢耶",
    "哦", "哦?", "嗯", "嗯?",
    "呀", "咦", "呦",
    "天哪", "我去", "哎呀", "哎呦", "嗯哼",
  ])("应匹配短反应: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(reactReplies).toContain(reply!);
  });

  it("连续相同字符应匹配: 啊啊", () => {
    const reply = matchSimpleGreeting("啊啊");
    expect(reply).toBeTruthy();
    expect(reactReplies).toContain(reply!);
  });

  // ── 佩服/赞叹 ──
  const wowReplies = repliesOf("wow");

  it.each([
    "哇", "哇塞", "哇哦",
    "厉害", "真厉害", "厉害啊", "好厉害",
    "牛", "牛啊", "真牛", "牛掰", "牛逼",
    "棒", "真棒", "好棒", "强", "真强",
    "666", "nb", "NB", "yyds", "YYDS", "tql", "TQL",
    "服了", "我服了", "服气", "佩服", "绝",
    "给力", "可以啊", "行啊", "了不起",
    "amazing", "awesome", "cool", "nice", "great",
  ])("应匹配佩服/赞叹: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(wowReplies).toContain(reply!);
  });

  // ── 笑声（笑/哈哈/233/lol 等） ──
  // 注意："哈" 单独时归 hello，"哈哈"+"哈+"归 laugh
  const laughReplies = repliesOf("laugh");

  it.each([
    "哈哈", "哈哈哈", "哈哈哈哈",
    "233", "2333", "23333",
    "笑死", "笑死了", "笑死我", "笑死我了",
    "嘿嘿", "嘻嘻", "呵呵", "咯咯",
    "lol", "LOL", "rofl",
    "太逗了", "太搞笑了",
  ])("应匹配笑声: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(laughReplies).toContain(reply!);
  });

  // ── 道歉/不好意思 ──
  const apologyReplies = repliesOf("apology");

  it.each([
    "不好意思", "抱歉", "对不起", "打扰了", "麻烦你了",
    "辛苦你了", "抱歉啊", "对不起啊", "不好意思啊",
    "抱歉打扰", "打扰一下", "不好意思打扰", "恕我冒昧", "见谅",
  ])("应匹配道歉: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(apologyReplies).toContain(reply!);
  });

  // ── 能力询问 ──
  const capabilityReplies = repliesOf("capability");

  it.each([
    "你会做什么", "你能做什么", "你能干啥", "你能做啥",
    "你会啥", "你有啥用", "你有什么用",
    "你厉害吗", "你聪明吗", "你有什么功能", "你有啥功能",
    "你能干什么", "你都会啥", "你有什么本事",
    "你能做啥事", "能做啥事", "能做啥", "会做啥",
    "你能帮我做什么", "你能帮我啥",
    "你能帮我什么", "你会什么", "你能做些什么",
    "能做什么", "会做什么", "会干啥", "能干啥", "有啥用", "有啥功能",
  ])("应匹配能力询问: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(capabilityReplies).toContain(reply!);
  });

  // ── 鼓励/打气 ──
  const encourageReplies = repliesOf("encourage");

  it.each([
    "加油", "加油鸭", "加油呀", "努力", "努力呀",
    "坚持", "坚持住", "挺你", "挺你哟", "支持你", "看好你",
    "你最棒", "你最厉害", "你最牛",
    "你是最棒的", "你是最厉害的", "你是最牛的",
  ])("应匹配鼓励: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(encourageReplies).toContain(reply!);
  });

  // ── 测试/玩 ──
  const testReplies = repliesOf("test");

  it.each([
    "测一下", "测一测", "试试", "试一下", "演示一下", "玩一下",
    "测下", "试下", "演示下", "玩下",
    "测试", "测试一下", "测试测试", "试试看", "试一下呗", "play",
  ])("应匹配测试/玩: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(testReplies).toContain(reply!);
  });

  // ── 等一下/稍等 ──
  const waitReplies = repliesOf("wait");

  it.each([
    "等一下", "等下", "等一会儿", "等会", "等会啊", "等会儿", "等会呗",
    "稍等", "稍等下", "稍等一下", "稍等啊",
    "等我一下", "等我", "等一下哈", "等一下呗", "等下呗", "等我哈",
  ])("应匹配稍等: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(waitReplies).toContain(reply!);
  });

  // ── 心情表达 ──
  const moodReplies = repliesOf("mood");

  it.each([
    "郁闷", "烦", "烦死了", "烦死", "烦躁",
    "累", "累了", "累死", "累死了", "真累", "好累", "太累了",
    "困", "困了", "困死", "饿", "饿了", "饿死了",
    "热", "好热", "太热", "冷", "好冷", "太冷",
    "开心", "高兴", "真开心", "真高兴", "开心呀", "爽", "真爽", "心情好",
    "无聊", "孤独", "寂寞", "无聊死了", "好无聊", "太无聊", "真无聊",
    "难过", "伤心", "生气", "气死", "气死了", "糟心", "崩溃",
    "想哭", "想哭哭", "哭唧唧", "委屈",
    "焦虑", "紧张", "害怕",
  ])("应匹配心情: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(moodReplies).toContain(reply!);
  });

  // ── 心疼/安慰主人 ──
  const sympathyReplies = repliesOf("sympathy");

  it.each([
    "心疼", "心疼我", "安慰", "安慰我", "安慰一下",
    "我撑不住", "撑不住了", "太难了", "我好难", "难顶",
    "扛不住", "受不了了", "我不行", "好难顶", "难搞",
  ])("应匹配心疼/安慰: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(sympathyReplies).toContain(reply!);
  });

  // ── 担忧/求助 ──
  const worryReplies = repliesOf("worry");

  it.each([
    "咋办", "怎么办", "怎么搞", "怎么弄", "怎么解决",
    "咋整", "怎么破", "咋办啊", "怎么办啊", "怎么弄啊",
    "救命", "救救我", "救一下", "救救", "help", "help me",
  ])("应匹配担忧/求助: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(worryReplies).toContain(reply!);
  });

  // ── 拜托/请求 ──
  const begReplies = repliesOf("beg");

  it.each([
    "拜托", "拜托了", "求你了", "求求你", "求求",
    "帮帮忙", "帮帮我", "请帮帮我", "求帮忙", "求帮",
    "帮个忙", "求你啦", "拜托啦",
  ])("应匹配拜托/请求: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(begReplies).toContain(reply!);
  });

  // ── 催促 ──
  const urgeReplies = repliesOf("urge");

  it.each([
    "快点", "快一点", "赶紧", "赶紧的", "催你",
    "麻溜的", "麻利点", "速度", "速度点", "加速",
    "加快", "加紧", "冲冲冲", "给我冲", "快点啊",
    "赶紧呀", "速度呀", "加急", "麻溜",
  ])("应匹配催促: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(urgeReplies).toContain(reply!);
  });

  // ── 震惊/反问 ──
  const shockReplies = repliesOf("shock");

  it.each([
    "不会吧", "不是吧", "真的假的", "真假", "我天",
    "妈呀", "我晕", "我趣", "不会吧?", "假的吧?",
    "啥?", "我滴妈", "我滴天", "我勒个",
  ])("应匹配震惊/反问: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(shockReplies).toContain(reply!);
  });

  // ── 玩梗/段子 ──
  const memeReplies = repliesOf("meme");

  it.each([
    "我裂开了", "裂开", "蚌埠住了", "绷不住了", "绷不住",
    "emo了", "emo", "摆烂", "摆了", "我哭死", "我哭",
    "哭死", "麻了", "家人们", "芭比Q了", "芭比q",
    "完蛋了", "完蛋", "寄了", "真的寄", "开摆",
  ])("应匹配玩梗/段子: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(memeReplies).toContain(reply!);
  });

  // ── 算了/没事 ──
  const dismissReplies = repliesOf("dismiss");

  it.each([
    "算了", "没事", "没事了", "没关系", "不必了",
    "不用了", "不用", "不用谢", "不谢", "拉倒吧",
    "不行拉倒", "随便", "无所谓", "没所谓", "都行",
    "都可以", "你说了算", "你定", "你决定",
  ])("应匹配算了/没事: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(dismissReplies).toContain(reply!);
  });

  // ── 提醒/关心主人 ──
  const warnReplies = repliesOf("warn");

  it.each([
    "小心点", "小心", "注意", "注意身体", "早点睡",
    "早睡", "别熬夜", "别太累", "多休息", "休息一下",
    "劳逸结合", "注意保暖", "注意安全", "别太拼", "别硬撑",
    "注意休息", "记得喝水", "记得吃饭", "记得休息",
    "要保重", "保重身体", "保重",
  ])("应匹配提醒/关心: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(warnReplies).toContain(reply!);
  });

  // ── 抱抱/亲亲 ──
  const hugReplies = repliesOf("hug");

  it.each([
    "抱抱", "抱一下", "抱", "亲亲", "亲一下", "mua",
    "摸摸头", "摸摸", "揉揉", "拍肩", "给你一拳",
    "给你个抱抱", "飞吻", "么么哒", "么么", "比心", "啵啵",
  ])("应匹配抱抱/亲亲: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(hugReplies).toContain(reply!);
  });

  // ── 称呼/昵称 ──
  const nicknameReplies = repliesOf("nickname");

  it.each([
    "宝贝", "宝宝", "小E", "小助手", "助手", "助理",
    "小Evo", "小evo", "小claw", "小Claw", "小ai", "小AI",
    "小爱", "小爱同学", "喂", "哎", "诶", "喂喂",
    "哎在吗", "在不在", "在不在啊", "哎哎", "诶诶", "喂在吗",
  ])("应匹配称呼/昵称: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(nicknameReplies).toContain(reply!);
  });

  // ── 表扬/夸赞主人 ──
  const praiseUserReplies = repliesOf("praiseUser");

  it.each([
    "不愧是你", "不愧是你啊", "还是你厉害", "你真棒", "主人厉害",
    "还是主人厉害", "主人才是最厉害的", "主人才是真棒", "厉害厉害",
    "高", "高手", "高手啊", "你是高手", "牛人", "大牛",
    "大佬", "大佬啊", "高人", "高人啊",
  ])("应匹配表扬/夸赞主人: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(praiseUserReplies).toContain(reply!);
  });

  // ── 沉默/叹气 ──
  const silenceReplies = repliesOf("silence");

  it.each([
    "...", "....", "…", "……",
    "嗐", "唉", "艾", "额", "额额", "无语",
    "沉默", "不想说", "不想说话", "没话说", "算了不说了",
  ])("应匹配沉默/叹气: %s", (text) => {
    const reply = matchSimpleGreeting(text);
    expect(reply).toBeTruthy();
    expect(silenceReplies).toContain(reply!);
  });

  // ── 整体变化测试 ──

  it("扩展后回复种类应明显增多", () => {
    const queries = [
      "在吗", "你还有反应吗", "活着吗",
      "你好", "嗨", "hi",
      "你是谁", "是AI吗", "你能做什么",
      "忙啥", "累不累",
      "你今天怎么样",
      "谢谢", "辛苦了",
      "好的", "收到",
      "再见", "拜拜",
      "啊", "嗯?", "哦",
      "666", "厉害", "yyds",
      "哈哈", "233",
      "不好意思", "抱歉",
      "加油", "坚持",
      "测一下", "试一下",
      "等一下", "稍等",
      "郁闷", "累了", "开心", "无聊", "害怕",
      // 新增的
      "心疼我", "安慰我", "咋办", "救命", "拜托", "帮帮我",
      "快点", "催你", "不会吧", "真的假的",
      "我裂开了", "emo了", "算了", "没关系",
      "小心点", "早点睡", "抱抱", "亲亲",
      "宝贝", "喂", "不愧是你", "大佬",
      "唉", "...",
    ];
    const seen = new Set<string>();
    for (const q of queries) {
      const reply = matchSimpleGreeting(q);
      if (reply) seen.add(reply);
    }
    // 至少应该有 30 种不同回复，证明扩展后回复非常丰富
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });

  // ── 变体测试 ──

  it("回复应该有变化（不同问题倾向得到不同回复）", () => {
    const seen = new Set<string>();
    const queries = [
      "在吗", "你在吗", "你还在吗", "你还有反应吗", "你在线吗",
      "活着吗", "你忙啥", "你今天怎么样", "谢谢", "拜拜",
    ];
    for (const q of queries) {
      const reply = matchSimpleGreeting(q);
      if (reply) seen.add(reply);
    }
    // 至少应该有 5 种不同回复，证明回复有变化
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it("同一个问题多次询问应得到相同回复（确定性）", () => {
    const first = matchSimpleGreeting("在吗");
    for (let i = 0; i < 5; i++) {
      expect(matchSimpleGreeting("在吗")).toBe(first);
    }
  });

  it("同义的不同问题应倾向得到不同回复", () => {
    // 存在性询问的多种说法
    const queries = ["在吗", "你在吗", "你还在吗", "你还有反应吗", "你在线吗", "活着吗"];
    const replies = queries.map((q) => matchSimpleGreeting(q)!);
    const unique = new Set(replies);
    // 至少 3 种不同回复
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });

  // ── 负向测试 ──

  it("不应匹配带任务的'你好，帮我写个函数'", () => {
    expect(matchSimpleGreeting("你好，帮我写个函数")).toBeNull();
  });

  it("不应匹配'请帮我搜索一下React'", () => {
    expect(matchSimpleGreeting("请帮我搜索一下React")).toBeNull();
  });

  it("不应匹配长消息", () => {
    expect(matchSimpleGreeting("你好，我有一个很复杂的问题需要你帮忙分析一下")).toBeNull();
  });

  it("不应匹配包含任务动词的句子", () => {
    expect(matchSimpleGreeting("在吗？帮我看看这个文件")).toBeNull();
  });

  it("空字符串应返回 null", () => {
    expect(matchSimpleGreeting("")).toBeNull();
    expect(matchSimpleGreeting("   ")).toBeNull();
    expect(matchSimpleGreeting("？？？")).toBeNull();
  });
});

describe("WeixinPluginAdapter - 简单问候快速通道集成", () => {
  let adapter: WeixinPluginAdapter;
  let mockExecutor: any;
  let mockEventBus: EventBus;
  let sentMessages: string[];

  beforeEach(() => {
    mockEventBus = createMockEventBus();
    mockExecutor = createMockAgentExecutor();
    adapter = new WeixinPluginAdapter(mockEventBus, mockExecutor);
    sentMessages = [];

    (adapter as any).sendMessage = vi.fn(async (account: any, toUserId: string, text: string) => {
      sentMessages.push(text);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'你还有反应吗'应走快速通道，不调用 LLM", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "你还有反应吗" } }],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    const startTime = Date.now();
    await (adapter as any).processMessage(account, message);
    const duration = Date.now() - startTime;

    // 应只发 1 条消息
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBeTruthy();
    // 不应调用 LLM
    expect(mockExecutor.chat).not.toHaveBeenCalled();
    // 快速通道应在 500ms 内完成（不依赖 LLM）
    expect(duration).toBeLessThan(500);
  });

  it("'你还有反应吗？'带问号也应走快速通道", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "你还有反应吗？" } }],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBeTruthy();
    expect(sentMessages[0].length).toBeGreaterThan(2);
    expect(mockExecutor.chat).not.toHaveBeenCalled();
  });

  it("带任务的消息'请帮我搜索X'应走正常 LLM 流程", async () => {
    const account: any = { token: "test", baseUrl: "https://test", savedAt: "" };
    const message: any = {
      from_user_id: "user-1",
      message_type: 1,
      message_state: 2,
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "请帮我搜索X" } }],
    };

    (adapter as any).sendTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as any).sendTypingCancel = vi.fn().mockResolvedValue(undefined);

    await (adapter as any).processMessage(account, message);

    // 应调用 LLM
    expect(mockExecutor.chat).toHaveBeenCalled();
    // 应该有 1 条最终回复
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBe("我在的，一切正常。");
  });
});
