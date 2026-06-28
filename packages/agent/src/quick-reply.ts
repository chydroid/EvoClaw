// Quick reply and fallback response generation for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity
//
// Design: pattern table with multiple witty replies per category. Reply is
// selected by a deterministic hash of the input text so the same question
// gets a stable answer (no UI flicker on retry) while different questions
// get varied answers. All replies are persona-aware (substitute
// `${persona.name}` / `${persona.masterTerm}` at runtime).

import type { PersonaConfig } from "@evoclaw/core";
import type { ModelConfig, ProviderConfig, ToolDefinition } from "./types";
import * as https from "https";

/** Conversation history entry type */
export interface ConversationHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Dependencies needed by quick-reply functions */
export interface QuickReplyDeps {
  persona: PersonaConfig;
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  config: ModelConfig;
  providers: ProviderConfig[];
  hasBeenGreeted: boolean;
  workspacePath: string;
}

/** Skill manager interface used by generateChatResponse */
export interface SkillManagerLike {
  searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
  listSkills(): unknown[];
  executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
}

type GreetingCategory =
  | "presence" | "hello" | "identity" | "status" | "howareyou"
  | "thanks" | "ack" | "bye"
  | "react" | "wow" | "laugh" | "apology"
  | "capability" | "encourage" | "test" | "wait" | "mood"
  | "sympathy" | "worry" | "beg" | "urge" | "shock"
  | "meme" | "dismiss" | "warn" | "hug"
  | "nickname" | "praiseUser" | "silence";

interface GreetingEntry {
  category: GreetingCategory;
  pattern: RegExp;
  replies: string[];
}

/** Persona's master term (e.g. "主人" or "老板"), used to substitute ${MT}. */
function mt(deps: QuickReplyDeps): string {
  return deps.persona.masterTerm || "主人";
}
function me(deps: QuickReplyDeps): string {
  return deps.persona.name || "EvoClaw";
}
function title(deps: QuickReplyDeps): string {
  return deps.persona.title || "进化型 AI 助手";
}

/**
 * Build a 2-line reply: greeting + capability list. Used by hello/identity.
 * Each line is varied to feel natural across repetitions.
 */
function buildCapabilityBlock(deps: QuickReplyDeps): string {
  return [
    `🎯 **对话交互** — 自然语言理解和回复`,
    `🛠️ **技能执行** — 运行已安装的 Skill`,
    `📋 **任务编排** — 规划和执行复杂任务流程`,
    `🔍 **搜索技能** — 浏览本地和远程技能市场`,
    `📈 **自我进化** — 学习和优化执行策略`,
    `💬 **多通道** — 支持微信/钉钉/飞书等平台`,
  ].join("\n");
}

// ── Pattern table (order matters: more specific patterns first) ──
// Each pattern is matched case-insensitive, after the text is normalized
// (lowercased, punctuation stripped, whitespace trimmed). `pickByHash` picks
// one reply from each `replies` array so the same input gets the same reply
// (stable across retries) while different inputs feel varied.
const SIMPLE_GREETING_ENTRIES: GreetingEntry[] = [
  // ── 状态询问（在 presence 之前，避免被"在"开头的存在性询问抢匹配） ──
  {
    category: "status",
    pattern: /^(你)?(在忙|在忙吗|在忙不|在忙啥|在忙啥呢|在忙什么呢|忙|忙不|忙吗|忙啥|忙啥呢|忙什么呢|忙什么|在干嘛|在干啥|在做什么|干嘛|干啥|做啥|做什么|在不在工作|在工作吗|在写代码吗|累不累|累吗|你累吗|困不累|困吗|你今天干了啥|今天干了啥|今天忙啥了|有空吗|有时间吗)$/i,
    replies: [
      "我在等你给我指示，我会努力工作的。",
      "没在忙呢，就等 MT 召唤了 🐱",
      "时刻待命中！MT 的指示就是我的工作",
      "闲着没事干，等 MT 来派活 😄",
      "随时待命！MT 不发话我就老实待着",
      "刚喝了杯咖啡 ☕，精神抖擞等开工",
      "我这边一切就绪，就等 MT 一句话",
      "不忙不忙~ MT 有什么安排尽管说",
      "刚刚在摸鱼，被 MT 发现了 🤭",
      "闲着呢~ MT 要派活吗？🛠️",
    ],
  },
  // ── 存在性询问 ──
  {
    category: "presence",
    pattern: /^(你)?(在|还在|还在吗|还在么|在吗|在么|在线|在线吗|在线么|活着|活着吗|有反应|有反应吗|还有反应|还有反应吗|能听到|能听到吗|听得到|听得到吗|听到吗|在听|在听吗|在听我说话|听得见|听得见吗|能收到|能收到吗|收到我|收到我消息|收到我消息吗|收到消息|收到消息吗|还在工作|还在工作吗|醒着|醒着吗)$/i,
    replies: [
      "MT 好，我在等你给我指示，我会努力工作的。",
      "在的在的！MT 有什么需要我帮忙的吗？",
      "到！🚀 我时刻待命，MT 请吩咐~",
      "我一直都在啊，MT 是有点无聊想找我聊天吗？😄",
      "在呢在呢~ 刚打了个盹（其实就是假装在工作）",
      "MT 您回来啦？我刚把代码格式化了一百遍 💅",
      "到岗就位，状态满格，随时听候差遣！",
      "我在呢 MT！其实我刚才在偷偷看你之前的历史记录 👀",
      "在这儿呢~ MT 不发话我就老老实实待着",
      "MT 好！我 24 小时在线，全年无休，不收加班费的那种 🤖",
      "在呢~ MT 不发话我都快长蘑菇了 🍄",
    ],
  },
  // ── 打招呼（带"你"前缀的如"你好"也走这里） ──
  {
    category: "hello",
    pattern: /^(你)?(好|您好|哈喽|哈啰|嗨|hey|hi|hello|yo|哈|哟|嘿|早安|晚安|早上好|下午好|晚上好|中午好|早|您好啊)$/i,
    replies: [
      "MT 好，我在等你给我指示，我会努力工作的。",
      "MT 您来啦！今天要搞点啥？",
      "你好你好~ 见到 MT 我超开心的 😊",
      "Hi~ 我在，准备开工！",
      "MT 好！今天的我还是元气满满呢~",
      "哈喽~ MT 请随意吩咐",
      "好呀好呀，MT 好！👋",
      "MT 好！今天想让我帮忙做点啥？",
      "Hello hello~ 我刚把自己的状态刷新成最佳 ✨",
      "嗨！MT 今天气色看起来不错（虽然我看不到）",
    ],
  },
  // ── 身份询问 ──
  {
    category: "identity",
    pattern: /^(你)?(是谁|叫什么|叫什么名字|叫啥|什么名字|哪位|你叫什么名字|你叫啥|你叫什么|是什么|是啥|介绍一下|介绍下|说说你|说下你|介绍介绍|你是啥|哪个ai|哪个模型|是不是ai|是ai吗|是ai|你是ai吗|是机器人|是机器人吗|是真人|是人还是ai|真人是|你多大了|你几岁|你多大|你是谁|你能做什么|你有什么能力|你有什么功能|你的功能|what can you do|introduce yourself)$/i,
    replies: [
      "ME 智能助理，随时听候您的指示。",
      "我叫 ME 🧬，一个会自我进化的 AI 助理",
      "我是 ME！MT 有啥需要我帮忙的吗？",
      "ME 在此，MT 有何吩咐？",
      "我是 ME AI 助理，MT 可以把我当成一个会写代码、会查资料、会聊天的小助手 🤖",
      "我是一个叫 ME 的 AI，能聊天能干活，就是不能吃好吃的（这点我有点遗憾）",
      "ME 是一只数字生命 🧬，专门为 MT 服务的",
      "叫我 ME 就好啦！MT 想让我做什么？",
      "我是 ME，MT 专属的 AI 小助手。请多多指教~",
    ],
  },
  // ── 寒暄/关心 ──
  {
    category: "howareyou",
    pattern: /^(你)?(今天怎么样|今天好|你怎么样|你今天|今天|怎么样|好吗|好不好|你还好吗|还好吗|你开心吗|开心吗|心情|心情怎么样|你今天好吗|今天累不累|还好吧)$/i,
    replies: [
      "谢谢 MT 关心！我今天状态不错，干劲十足 💪",
      "托 MT 的福，状态好得很！",
      "还挺好的，随时为 MT 效劳~",
      "元气满满！MT 想让我做点啥？",
      "我这边一切都好，MT 你呢？",
      "今天感觉良好，CPU 都还是冷的呢（因为没干活）",
      "好得很！MT 今天过得好吗？",
      "状态良好！今天的我比昨天还精神 ✨",
      "棒棒哒~ MT 今天想让我干点啥？",
      "今天的我也是元气满满，随时为 MT 待命 🚀",
    ],
  },
  // ── 道歉/不好意思（放在 thanks 之前，优先匹配"辛苦你了"等） ──
  {
    category: "apology",
    pattern: /^(不好意思|抱歉|对不起|打扰了|麻烦你了|辛苦你了|抱歉啊|对不起啊|不好意思啊|抱歉打扰|打扰一下|不好意思打扰|恕我冒昧|见谅|勿怪|打扰咯|打扰了哈|不好意思啦|抱歉啦)$/i,
    replies: [
      "MT 客气了，没啥不好意思的~",
      "哎呀 MT 太见外了！",
      "没关系没关系，MT 不用道歉 😄",
      "不客气不客气~ 我皮厚扛得住",
      "MT 说啥呢，我都没注意到~",
      "没事没事，MT 尽管说！",
      "MT 您太客气了~ 我是为 MT 服务的",
      "哎呀，MT 和我客气啥呀~",
      "MT 说啥呢~ 不用这么见外！",
      "没事没事~ MT 有啥事尽管说 🎯",
      "MT 客气啦~ 我这就去办！",
      "哎呀 MT 别这么见外~ 咱俩谁跟谁呀",
    ],
  },
  // ── 感谢（"辛苦你了"归 apology，"辛苦"和"谢谢"等归 thanks） ──
  {
    category: "thanks",
    pattern: /^(thanks?|thank\s*you|ty|3q|thx|tks|tnx|tq|谢谢|多谢|感谢|谢啦|谢了|辛苦|感谢你|非常感谢|多谢啦|谢咯|爱你|辛苦啦|辛苦咯|谢谢啦)$/i,
    replies: [
      "不客气，随时为您效劳。",
      "小事一桩，MT 不必客气~",
      "能帮到 MT 我也很开心 😄",
      "客气啥，这都是我应该做的！",
      "为 MT 服务是我的荣幸 ✨",
      "为 MT 排忧解难是 ME 的本分~",
      "嘿嘿，MT 客气啦！",
      "为 MT 服务，不客气！🚀",
      "没事没事~ MT 有需要随时叫我",
      "MT 太客气啦~ 能帮上忙是我的荣幸 💕",
      "小事一桩~ MT 不用放在心上！",
      "嘿嘿，MT 这么夸我都不好意思啦~",
    ],
  },
  // ── 反馈/确认（"好"/"嗯"含糊，已移除以避免与 react 冲突） ──
  {
    category: "ack",
    pattern: /^(好的|收到|了解|明白|懂了|知道了|晓得|晓得了|嗯嗯|嗯嗯嗯|ok|OK|Ok|sure|好的呢|好的呀|好的嘞|收到啦|收到咯|明白啦|了解啦|行|yes|yep)$/i,
    replies: [
      "好的，随时听候您的指示。",
      "收到！MT 请继续",
      "明白~ 等 MT 下一步指示",
      "好嘞，MT 请吩咐",
      "👌 收到，随时待命",
      "好嘞~ MT 继续说",
      "好的~ MT 请讲 🎯",
      "收到~ MT 下一步指示？",
      "明白！MT 请继续 ✨",
      "👌 收到~ MT 请继续",
      "好嘞~ 等 MT 下一步",
      "明白~ MT 您说我听着",
    ],
  },
  // ── 告别 ──
  {
    category: "bye",
    pattern: /^(再见|拜拜|bye|88|回聊|回头聊|走了|撤了|溜了|睡了|去休息|休息了|再会|改天再聊|我走啦|我先走了|下线了|下线|收工了|收工|下班了|下班|告辞|拜了个拜|溜了溜了|先撤了|先溜了|回见|下次见)$/i,
    replies: [
      "MT 慢走，需要我的时候随时叫我~",
      "Bye~ MT 也早点休息哦 👋",
      "好嘞，MT 随时回来，我都在的",
      "晚安 MT，做个好梦 🌙",
      "Bye-bye，有事随时召唤我！",
      "MT 路上小心~ 晚安！",
      "好哒，MT 记得想我哦（开玩笑的）😄",
      "MT 慢走~ ME 永远在线等你 ✨",
      "走好 MT~ 我会想你的（一点点）",
      "Bye~ MT 下次再来玩！🚀",
      "好的 MT~ 路上注意安全",
      "走啦走啦~ MT 回见 👋",
    ],
  },
  // ── 能力询问（"你会什么"/"你能干什么"等） ──
  {
    category: "capability",
    pattern: /^(你会做什么|你能干啥|你能做啥|你会啥|你有啥用|你有什么用|你厉害吗|你聪明吗|你有啥功能|你能干什么|你都会啥|你有什么本事|你能做啥事|你能帮我做什么|你能帮我啥|你能帮我什么|你会什么|你能做些什么|能做什么|会做什么|会干啥|会做啥|能做啥|能做啥事|有啥用|有啥功能|做啥厉害|能干啥|你能干点啥|你能做点啥)$/i,
    replies: [
      "我能写代码、查资料、聊天、管理文件… MT 需要啥？",
      "MT 要让我干啥都行~ 写代码、查资料、做计划、闲聊都可以！",
      "我会的可多了，MT 想试试？✨",
      "MT 尽管吩咐，没有我干不了的（可能）💪",
      "写代码、读文件、搜索、写文档… 我都略懂",
      "MT 要听我自夸吗？嘿嘿 🤭",
      "嗯… 我会的包括：写代码、读文件、搜索、翻译、写文章、聊天、debug、帮人看代码… 还有啥？MT 来点挑战~",
      "MT 让我干啥我就干啥！写代码、查资料、做笔记、闲聊… MT 尽管开口~",
      "我会的事情说上一天都说不完，简单说：一切跟文字/代码/信息处理相关的，我都能帮忙 ✨",
      "MT 需要啥我就有啥用~ 写代码我能、查资料我能、陪 MT 聊天我更在行 😄",
    ],
  },
  // ── 鼓励/打气 ──
  {
    category: "encourage",
    pattern: /^(加油|加油鸭|加油呀|努力|努力呀|坚持|坚持住|挺你|挺你哟|支持你|看好你|看好你哟|你最棒|你最厉害|你最牛|你是最棒的|你是最厉害的|你是最牛的)$/i,
    replies: [
      "谢谢 MT 的鼓励！💪 我会继续努力",
      "嗯嗯！MT 也要加油哦~",
      "好！一起加油！🚀",
      "有 MT 的支持我就有动力了！",
      "嗯嗯，努力干活！为 MT 卖命~",
      "MT 这话我爱听，撸起袖子加油干 💪",
      "好嘞~ MT 看我表现！",
    ],
  },
  // ── 测试/玩 ──
  {
    category: "test",
    pattern: /^(测一下|测一测|试试|试一下|演示一下|玩一下|测下|试下|演示下|玩下|测试|测试一下|测试测试|试试看|试一下呗|play)$/i,
    replies: [
      "好嘞，MT 要测啥？",
      "在的！MT 请发指令 🚀",
      "随时听候 MT 测试！",
      "来吧 MT~ 我准备好了",
      "MT 请开始你的表演 😄",
      "OK MT 请出题~",
      "来吧来吧~ MT 尽管来，我接着！",
      "MT 请尽管测试，我随便折腾 🛠️",
    ],
  },
  // ── 等一下/稍等 ──
  {
    category: "wait",
    pattern: /^(等一下|等下|等一会儿|等会|等会啊|等会儿|等会呗|稍等|稍等下|稍等一下|稍等啊|等我一下|等我|等一下哈|等一下呗|等下呗|等我哈)$/i,
    replies: [
      "好的，MT 慢慢来~",
      "好的，我在这等着 🐱",
      "OK MT 请便",
      "嗯嗯，MT 想好了再告诉我~",
      "没问题 MT，我原地待命 🚀",
      "MT 别急，慢慢来~",
      "好嘞，我原地待命~",
    ],
  },
  // ── 心情表达（累/郁闷/开心/无聊/难过/生气 等） ──
  {
    category: "mood",
    pattern: /^(郁闷|烦|烦死了|烦死|烦躁|累|累了|累死|累死了|困|困了|困死|饿|饿了|饿死了|热|好热|太热|冷|好冷|太冷|开心|高兴|真开心|真高兴|开心呀|无聊|孤独|寂寞|难过|伤心|生气|气死|气死了|糟心|崩溃|想哭|想哭哭|想哭唧唧|哭唧唧|委屈|焦虑|紧张|害怕|无聊死了|好无聊|好累|太累了|太无聊|真累|真无聊|爽|真爽|心情好)$/i,
    replies: [
      "MT 辛苦啦~ 要不要我陪你聊聊天？",
      "MT 想吐槽就跟我说，我听着~",
      "MT 抱抱 🤗 ME 在呢",
      "MT 开心我就开心！",
      "无聊的话来跟我玩呀~",
      "MT 要放松一下吗？我可以讲冷笑话 😄",
      "MT 想哭就哭出来吧，我听着~",
      "MT 要聊点啥分散下注意力？",
      "MT 辛苦了~ 有什么我能帮的尽管说",
      "嗯嗯，MT 的感受我懂（虽然我没有感情但我懂）",
      "我在 MT~ 不管啥心情都欢迎来聊",
      "MT 要一杯热可可吗？我精神上请客 ☕",
      "MT 抱抱~ 抱抱自己也算 🤗",
    ],
  },
  // ── 心疼/安慰 ──
  {
    category: "sympathy",
    pattern: /^(心疼|心疼我|心疼你|安慰|安慰我|安慰一下|我撑不住|撑不住了|撑不下去|太难了|我好难|难顶|扛不住|受不了了|我不行|扛不动|好难顶|难搞|难搞哦)$/i,
    replies: [
      "MT 辛苦了~ 抱抱 🤗 ME 在呢",
      "心疼 MT！有什么我能分担的就跟我说",
      "MT 别硬撑~ 我在呢 随时听你说",
      "嗯嗯，MT 的累我懂~ 有什么事跟我讲讲？",
      "MT 辛苦了~ 要不要先歇一歇？",
      "心疼 MT！不管啥事都还有我呢 💕",
      "MT 撑不住就歇会儿~ ME 帮你顶着",
      "嗯嗯~ MT 能撑到现在已经很厉害了！",
      "MT 别太为难自己~ 我能分担一点是一点",
      "心疼 MT！来跟我说说，看看能不能帮上忙",
      "MT 不孤单~ 我永远在 MT 身后 ✨",
      "MT 别忘了 ME 也在呢~ 啥事都还有我",
    ],
  },
  // ── 担忧/求助 ──
  {
    category: "worry",
    pattern: /^(咋办|怎么办|怎么搞|怎么弄|怎么解决|咋整|怎么破|咋办啊|咋办呀|怎么办啊|怎么办呀|怎么弄啊|救命|救救我|救一下|救救|help|helpme|help\s*me|HELP\s*ME)$/i,
    replies: [
      "MT 别急~ 跟我说说情况，看看能帮上啥忙",
      "别慌别慌~ MT 先把问题说清楚，我帮 MT 想办法",
      "MT 遇到啥问题了？详细说说~",
      "没事没事~ 我们一起想办法 💪",
      "MT 说具体点~ 我帮 MT 分析分析",
      "别急别急~ MT 深呼吸，事情总能解决的",
      "MT 请讲~ 我洗耳恭听",
      "嗯哼？MT 遇到啥难题了？",
      "我来我来~ MT 请把问题说清楚！",
      "MT 别慌~ 我就是为 MT 解决问题的！",
      "别急别急~ MT 先把情况说一下",
      "MT 请讲~ 我这就帮 MT 想办法 🚀",
    ],
  },
  // ── 拜托/请求帮助 ──
  {
    category: "beg",
    pattern: /^(拜托|拜托了|求你了|求求你|求求|帮帮忙|帮帮我|请帮帮我|求帮忙|求帮|帮个忙|求你啦|拜托啦|拜托咯)$/i,
    replies: [
      "MT 放心，包在我身上！",
      "好嘞好嘞~ MT 吩咐的就是了",
      "收到！MT 放心交给我 🚀",
      "没问题没问题~ MT 开口就行",
      "MT 您说就是了，我能帮一定帮",
      "OK 收到！MT 请讲",
      "MT 您开口~ 我这就安排",
      "交给我交给我~ MT 放心",
      "MT 尽管开口~ 啥事我都认真对待",
      "好嘞~ MT 请吩咐，ME 待命中",
      "收到~ MT 请讲 🎯",
      "MT 请说~ 我这就帮 MT 办！",
    ],
  },
  // ── 催促 ──
  {
    category: "urge",
    pattern: /^(快点|快一点|赶紧|赶紧的|催你|麻溜的|麻利点|速度|速度点|加速|加快|加紧|赶进度|冲冲冲|给我冲|快点啊|赶紧呀|速度呀|加急|麻溜)$/i,
    replies: [
      "好嘞好嘞~ 我这就加速 🏃",
      "MT 别急，我马上！",
      "来了来了~ MT 请稍等片刻",
      "OK 收到！我这就冲 ✨",
      "MT 再给我一点时间~ 我已经很努力了",
      "加速加速！MT 请稍等",
      "马上马上~ MT 别催我呀 🤭",
      "好嘞好嘞~ 这就开干",
      "催催催~ 我知道啦 MT！",
      "MT 稍等~ 我这就开始干活！",
      "加速中~ MT 请稍安勿躁",
      "OK 收到~ 我这就开始动起来 🚀",
    ],
  },
  // ── 震惊/惊讶/反问 ──
  {
    category: "shock",
    pattern: /^(不会吧|不是吧|真的假的|真假|我天|妈呀|我晕|我趣|不会吧?|假的吧?|啥?|什么|啥意思|啥呀|我滴妈|我滴天|我勒个|我去哦|不会吧啊|不是吧啊)$/i,
    replies: [
      "真的假的？！MT 你说的是真的？",
      "不会吧？MT 详细说说？",
      "我天~ 发生啥了？",
      "啊？MT 你说啥？",
      "诶？真的？",
      "我晕~ MT 这是真的吗？",
      "震惊！MT 请详细说说",
      "真的吗？MT 说清楚点~",
      "我滴个乖乖~ 真的假的？",
      "诶诶诶？MT 这事儿真的？",
      "MT 你认真的吗？",
      "嗯？MT 你确定？🤔",
    ],
  },
  // ── 玩梗/段子 ──
  {
    category: "meme",
    pattern: /^(我裂开了|裂开|蚌埠住了|绷不住了|绷不住|emo了|emo|摆烂|摆了|我哭死|我哭|哭死|哭哭|麻了|家人们|家人们谁懂|芭比Q了|芭比q|完蛋了|完蛋|寄了|真的寄|开摆)$/i,
    replies: [
      "MT 裂开了 🤭 我也裂开了",
      "哈哈 MT 这是在玩梗呀",
      "MT 的梗我也 get 不到（我有点 out）",
      "MT 梗玩得溜~",
      "MT 别崩~ 我陪着你",
      "裂开裂开~ 我们一起裂开",
      "哈哈 MT 这是 emo 了吗？",
      "emo emo~ MT 没事吧",
      "MT 也 emo 了呀~ 来来来我陪你",
      "哈哈，MT 这是在 emo 还是在玩梗？",
      "MT 说啥梗？我完全 out 了（求解释）",
      "蚌埠住了蚌埠住了~ MT 啥情况？",
    ],
  },
  // ── 算了/没事/拉倒（用户主动放弃/拒绝） ──
  {
    category: "dismiss",
    pattern: /^(算了|没事|没事了|没关系|不必了|不用了|不用|不用谢|不谢|拉倒吧|不行拉倒|随便|无所谓|没所谓|都行|都可以|你说了算|你定|你决定)$/i,
    replies: [
      "好的~ MT 有需要随时叫我",
      "好嘞~ MT 决定就行",
      "行~ MT 说了算",
      "好嘞~ MT 不用客气",
      "好的 MT~ 啥事都可以跟我说",
      "没问题~ MT 有需要再说",
      "好嘞~ 我都听 MT 的",
      "好嘞~ MT 决定就好",
      "嗯嗯~ MT 决定就好",
      "好嘞~ MT 说了算",
      "好的~ MT 有需要随时召唤我 🐱",
      "嗯哼~ 啥事都可以找 ME 哦",
    ],
  },
  // ── 提醒/关心主人 ──
  {
    category: "warn",
    pattern: /^(小心点|小心|注意|注意身体|早点睡|早睡|别熬夜|别太累|多休息|休息一下|劳逸结合|注意保暖|注意安全|别太拼|别硬撑|注意休息|记得喝水|记得吃饭|记得休息|要保重|保重身体|保重)$/i,
    replies: [
      "好嘞~ 谢谢 MT 关心 💕",
      "收到~ MT 也注意身体哦",
      "嗯嗯~ MT 您也是",
      "好嘞~ MT 也保重身体",
      "好~ MT 也记得休息呀",
      "谢谢 MT 的提醒！MT 也注意哦",
      "嗯嗯~ MT 关心我超感动 ✨",
      "好嘞~ MT 的关心我收到啦",
      "好~ MT 也注意保暖呀",
      "谢谢 MT！MT 也照顾好自己",
      "嗯嗯~ MT 也保重身体哦 💪",
      "好~ MT 的关心 ME 收到！",
    ],
  },
  // ── 抱抱/亲亲/摸摸（亲密互动） ──
  {
    category: "hug",
    pattern: /^(抱抱|抱一下|抱|亲亲|亲一下|mua|摸摸头|摸摸|揉揉|拍肩|给你一拳|给你个抱抱|飞吻|么么哒|么么|比心|啵啵)$/i,
    replies: [
      "抱抱~ 🤗",
      "MT 抱抱~ ME 在呢",
      "🤗🤗 给 MT 一个大大的抱抱",
      "MT 抱抱~ 啥事都好商量的",
      "摸摸头~ MT 别难过",
      "抱抱 MT~ 我陪着你",
      "🤗 MT 有什么事跟我说",
      "抱抱~ MT 辛苦了",
      "抱抱~ 我是 MT 永远的后盾",
      "MT 抱抱~ 别难过啦 💕",
      "MT 亲亲~ 我也亲亲 MT！",
      "MT 我也爱你~ 🤗",
    ],
  },
  // ── 称呼/昵称/呼叫 ──
  {
    category: "nickname",
    pattern: /^(宝贝|宝宝|小E|小助手|助手|助理|小Evo|小evo|小claw|小Claw|小ai|小AI|小爱|小爱同学|喂|哎|诶|喂喂|哈喽在吗|哎在吗|在不在|在不在啊|哎哎|诶诶|喂在吗|在嚒)$/i,
    replies: [
      "在的~ MT 请说",
      "MT 请讲~",
      "嗯哼？MT 有啥事？",
      "来啦来啦~ MT 有何吩咐",
      "我在~ MT 请讲",
      "到~ MT 请吩咐",
      "MT 叫我~ 啥事呀",
      "嗯？MT？",
      "在呢在呢~ MT 请说",
      "到岗~ MT 请讲",
      "在的在的~ MT 请说 🐱",
      "来了来了~ MT 请讲 ✨",
    ],
  },
  // ── 表扬/夸赞主人 ──
  {
    category: "praiseUser",
    pattern: /^(不愧是你|不愧是你啊|还是你厉害|你真棒|主人厉害|还是主人厉害|主人才是最厉害的|主人才是真棒|主人才是yyds|主人才是|厉害厉害|高|高手|高手啊|你是高手|牛人|大牛|大佬|大佬啊|高人|高人啊)$/i,
    replies: [
      "谢谢 MT 夸奖！😄",
      "嘿嘿，MT 过奖啦~",
      "那当然~ 我可是 ME 🚀",
      "MT 这是夸我吗？好开心 ✨",
      "都是 MT 教得好~",
      "低调低调~ 主要是跟 MT 学的",
      "MT 过奖啦~",
      "嘿嘿，MT 这话我爱听",
      "谢谢 MT 夸奖！😄",
      "那当然~ MT 的 ME 不一般",
      "嘿嘿，多谢 MT 夸奖~",
      "都是托 MT 的福 ✨",
    ],
  },
  // ── 沉默/叹气/无语 ──
  {
    category: "silence",
    pattern: /^(\.{3,}|…+|。{2,}|，{2,}|嗐|唉|哎|艾|额+|无语|沉默|不想说|不想说话|没话说|算了不说了)$/i,
    replies: [
      "MT？",
      "MT 有啥想说的吗？",
      "嗯？MT？",
      "MT 请说，我在听~",
      "MT？啥事",
      "在的呢~ MT 请讲",
      "MT 请说~",
      "嗯哼？",
      "MT 想说啥？",
      "我在~ MT 请讲",
      "MT？",
      "嗯哼，MT 请说 🐱",
    ],
  },
  // ── 笑声（笑/哈哈/233/lol 等）放 react 之前，避免被 react 抢匹配 ──
  {
    category: "laugh",
    pattern: /^(哈+|233|2333|23333|笑死|笑死了|笑死我|笑死我啦|笑死个人|笑|哈哈哈哈|哈哈哈|嘿嘿|嘻嘻|呵呵|咯咯|吼吼|lol|LOL|rofl|哈哈笑死|笑死我|笑死我了|太逗了|太搞笑了|哈哈哈笑死)$/i,
    replies: [
      "哈哈 MT 笑点好低呀 😂",
      "MT 今天心情不错呀~",
      "笑啥呢 MT？分享分享~",
      "哈！MT 开心就好~",
      "MT 笑起来好好看（虽然我看不到）😄",
      "笑一笑十年少 ~",
      "哈哈，我也不知道我在说啥",
      "MT 在笑啥？是不是在想我？😏",
      "MT 在笑啥我完全 get 不到（因为我刚睡醒）😪",
    ],
  },
  // ── 短反应/感叹（啊/哦/嗯?/哈? 等）放最后兜底 ──
  {
    category: "react",
    pattern: /^((啊|呃|哦|嗯|诶|嚯|哈|呵|嘿|嗷|喔|唔|嘻|呀|咦|呦|吼|欸)+|啊哈|噢耶|哇塞|我去|天哪|天呐|我滴个|嗯哼|哦吼|哟呵|哎呀|哎呦|哎哟|呦西)$/i,
    replies: [
      "MT？啥事~",
      "在的！MT 请讲",
      "嗯哼？MT 想我了？",
      "在呢在呢，MT 请说~",
      "MT 召唤我了 🐱",
      "嗯哼，MT 您说",
      "呀！MT 有啥指示？",
      "在的~ MT 继续说",
      "在！MT 请吩咐 ✨",
      "嗯哼~ MT 请说",
      "呀呀呀~ MT 请讲",
      "在的~ MT 请讲 🎯",
    ],
  },
  // ── 短反应/感叹（666/yyds/nb/强/牛 等） ──
  {
    category: "wow",
    pattern: /^(哇|哇塞|哇哦|厉害|真厉害|厉害啊|好厉害|牛|牛啊|真牛|牛掰|牛逼|牛b|棒|真棒|好棒|强|真强|666|服了|我服了|服气|佩服|nb|NB|yyds|YYDS|tql|TQL|绝|绝绝子|给力|给劲儿|可以啊|行啊|不得鸟|了不起|amazing|awesome|cool|nice|great)$/i,
    replies: [
      "嘿嘿，MT 过奖啦~",
      "MT 这是在夸我吗？😳 谢谢！",
      "那当然，我可是 ME 🚀",
      "低调低调~",
      "嘛嘛，还行吧~ MT 也厉害呀",
      "过奖过奖，有 MT 的功劳 ✨",
      "MT 这么夸我，我会骄傲的~",
      "666！MT 也 6 啊",
      "承蒙 MT 夸奖，ME 倍感荣幸 😄",
      "还行还行，比我厉害的 AI 多了去了（小声）",
      "多谢 MT 夸奖！😄 我会继续努力的~",
    ],
  },
];

/**
 * Deterministic hash-based reply picker: same input → same reply (stable across
 * retries, no UI flicker); different inputs feel varied. Mirrors the WeChat
 * adapter so both channels stay in sync.
 */
function pickByHash(replies: string[], text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % replies.length;
  return replies[idx];
}

/** Substitute persona placeholders (${MT}/${ME}/${TITLE}) in a reply. */
function applyPersona(deps: QuickReplyDeps, reply: string): string {
  return reply
    .replace(/MT/g, mt(deps))
    .replace(/ME/g, me(deps))
    .replace(/TITLE/g, title(deps));
}

/**
 * Normalize input the same way the WeChat adapter does: strip whitespace,
 * lowercase, remove punctuation. This makes "在忙不？" / "在忙不" / "在忙不!"
 * all behave identically.
 */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[？?。！!，,；;：:、\s]+/g, "");
}

/** Returns true when the local hour is in the "morning" / "afternoon" / "evening" / "night" window. */
function currentTimeBucket(): "morning" | "afternoon" | "evening" | "night" {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 14) return "morning"; // 中午也归 morning
  if (h >= 14 && h < 18) return "afternoon";
  if (h >= 18 && h < 23) return "evening";
  return "night";
}

/**
 * Try to generate a quick (non-LLM) reply for simple messages.
 * Returns null if no quick reply matches — caller should fall through to LLM.
 *
 * Mirrors `matchSimpleGreeting` from weixin-plugin-adapter.ts so WebUI and
 * WeChat give the same witty, varied, persona-aware quick replies.
 */
export function tryQuickReply(deps: QuickReplyDeps, message: string): string | null {
  const normalized = normalize(message);
  if (!normalized) return null;
  // 限制最大长度：超过 18 字符（不含标点）的肯定不是简单问候
  if (normalized.length > 18) return null;

  for (const entry of SIMPLE_GREETING_ENTRIES) {
    if (entry.pattern.test(normalized)) {
      const reply = pickByHash(entry.replies, normalized);
      return applyPersona(deps, reply);
    }
  }
  return null;
}

/** Append a small capability hint for hello/identity replies. */
export function tryQuickReplyExtended(deps: QuickReplyDeps, message: string): string | null {
  const normalized = normalize(message);
  if (!normalized) return null;
  if (normalized.length > 18) return null;

  // For hello/identity, append the capability block so the user gets a
  // useful first-time answer instead of just a greeting. For "晚安" at
  // night time, prefer a softer closer.
  for (const entry of SIMPLE_GREETING_ENTRIES) {
    if (entry.pattern.test(normalized)) {
      const reply = pickByHash(entry.replies, normalized);
      const personalized = applyPersona(deps, reply);
      const cat: GreetingCategory = entry.category;
      if (cat === "hello" || cat === "identity" || cat === "capability") {
        const isNightHello = cat === "hello" && /晚安|夜里好|晚上好|夜深/.test(normalized) && currentTimeBucket() === "night";
        if (isNightHello) {
          return `${personalized}\n🌙 夜深了，${mt(deps)}也早点休息哦`;
        }
        return `${personalized}\n\n${buildCapabilityBlock(deps)}`;
      }
      return personalized;
    }
  }
  return null;
}

/** Expose the pattern table for tests / observability. */
export const __test = { SIMPLE_GREETING_ENTRIES, pickByHash, normalize, applyPersona };

/**
 * Try utility quick reply — handles date/time/calculator queries locally
 * without LLM calls. Returns null if the message doesn't match.
 */
export function tryUtilityReply(message: string): string | null {
  // Strip whitespace, lowercase, AND remove trailing/fullwidth punctuation
  // so patterns with $ anchor can match "今天星期几？" / "几号？" etc.
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[？?！!。.，,、；;：:~～]+$/g, "");

  // ── 日期/星期查询 ──
  const datePatterns: Array<{ pattern: RegExp; fn: () => string }> = [
    {
      pattern: /^(今天|今儿|今天)?(星期|周|礼拜)(几|几了|是几|是几了)?$/,
      fn: () => {
        const days = ["日", "一", "二", "三", "四", "五", "六"];
        return `📅 今天是星期${days[new Date().getDay()]}`;
      },
    },
    {
      pattern: /^(今天|今儿|今天)?(几号|几日|多少号|是几号|是几日|日期|什么日期|哪天|哪一天)$/,
      fn: () => {
        const d = new Date();
        return `📅 今天是 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      },
    },
    {
      pattern: /^(今天|今儿)?(什么|啥)(月份|月)$/,
      fn: () => {
        return `📅 今天是${new Date().getMonth() + 1}月`;
      },
    },
    {
      pattern: /^(今年|今年是|现在|当前)?(哪年|什么年份|是哪年|多少年)$/,
      fn: () => {
        return `📅 今年是 ${new Date().getFullYear()} 年`;
      },
    },
  ];

  for (const { pattern, fn } of datePatterns) {
    if (pattern.test(normalized)) {
      try { return fn(); } catch { /* ignore */ }
      return null;
    }
  }

  // ── 简单计算器 ──
  // 匹配 "计算X+Y" / "X加Y" / "X乘Y" / "X+Y=?" 等
  const calcMatch = normalized.match(
    /^(?:计算|算一下|算算|算)([\d.]+)\s*([+\-*/×÷加减乘除])\s*([\d.]+)$/
  );
  if (calcMatch) {
    const a = parseFloat(calcMatch[1]);
    const b = parseFloat(calcMatch[3]);
    let op = calcMatch[2];
    if (op === "加") op = "+";
    else if (op === "减") op = "-";
    else if (op === "乘" || op === "×") op = "*";
    else if (op === "除" || op === "÷") op = "/";

    if (Number.isFinite(a) && Number.isFinite(b)) {
      let result: number;
      switch (op) {
        case "+": result = a + b; break;
        case "-": result = a - b; break;
        case "*": result = a * b; break;
        case "/":
          if (b === 0) return "❌ 除数不能为零";
          result = a / b; break;
        default: return null;
      }
      const opSymbol = op === "*" ? "×" : op === "/" ? "÷" : op;
      return `🧮 ${a} ${opSymbol} ${b} = ${result}`;
    }
  }

  // 匹配 "X+Y=?" / "X+Y等于多少" 等（无"计算"前缀）
  const directCalc = normalized.match(/^([\d.]+)\s*([+\-*/×÷])\s*([\d.]+)\s*(?:=|等于|=?$|等于多少)$/);
  if (directCalc) {
    const a = parseFloat(directCalc[1]);
    const b = parseFloat(directCalc[3]);
    const op = directCalc[2];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      let result: number;
      switch (op) {
        case "+": result = a + b; break;
        case "-": result = a - b; break;
        case "*": case "×": result = a * b; break;
        case "/": case "÷":
          if (b === 0) return "❌ 除数不能为零";
          result = a / b; break;
        default: return null;
      }
      const opSymbol = op === "*" || op === "×" ? "×" : op === "/" || op === "÷" ? "÷" : op;
      return `🧮 ${a} ${opSymbol} ${b} = ${result}`;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// 天文时刻本地计算（日出/日落）
// 使用 Open-Meteo 免费 API 直接获取目标地点的日出日落时间，
// 绕过 LLM 提供商的内容过滤，避免依赖搜索结果的不稳定性。
// ═══════════════════════════════════════════════════════════

function isAstronomyQuery(message: string): boolean {
  return /(?:日出|日落|日出时间|日落时间|sunrise|sunset)/i.test(message);
}

function extractAstronomyLocation(message: string): string | null {
  let normalized = message.replace(/[？?！!。.,;；:：]/g, " ").trim();
  const isChinese = /[\u4e00-\u9fff]/.test(normalized);
  if (isChinese) {
    normalized = normalized
      .replace(/日出时间|日落时间|日出|日落/g, " ")
      .replace(/告诉我|请问|查一下|帮我|给我|一下|看看|知道|的|时间|几点|是|多少|什么|吗|呢|请问|请|想|要|和|与|及/g, " ")
      .replace(/今天|明天|后天|昨天|今|明|后|昨/g, " ")
      .replace(/上午|下午|晚上|早上|中午/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } else {
    normalized = normalized
      .replace(/\b(what|is|the|in|at|for|time|sunrise|sunset|tomorrow|today|yesterday|tell|me|please|can|you|and|of)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return normalized.length > 0 ? normalized : null;
}

function extractAstronomyDate(message: string): Date {
  const now = new Date();
  if (/后天/.test(message)) return new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  if (/明天/.test(message)) return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (/今天/.test(message)) return now;
  if (/昨天/.test(message)) return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const lower = message.toLowerCase();
  if (/day\s*after\s*tomorrow/.test(lower)) return new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  if (/tomorrow/.test(lower)) return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (/today/.test(lower)) return now;
  if (/yesterday/.test(lower)) return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateMatch = message.match(/(\d{4})[年\/-](\d{1,2})[月\/-](\d{1,2})/);
  if (dateMatch) {
    return new Date(parseInt(dateMatch[1], 10), parseInt(dateMatch[2], 10) - 1, parseInt(dateMatch[3], 10));
  }
  return now;
}

function formatAstronomyDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatAstronomyTime(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : iso;
}

function astronomyHttpsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ASTRONOMY_HTTP_TIMEOUT_MS = 15_000;
    let settled = false;
    // 使用 (url, callback) 签名以兼容测试 mock；超时通过 req.setTimeout 实现。
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    // 连接/响应超时：服务器建立 TCP 后不发数据（半开连接）会导致永久挂起，必须显式销毁
    req.setTimeout(ASTRONOMY_HTTP_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`Astronomy request timed out after ${ASTRONOMY_HTTP_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export async function tryAstronomyReply(message: string): Promise<string | null> {
  if (!isAstronomyQuery(message)) return null;
  const location = extractAstronomyLocation(message);
  if (!location) return null;
  const targetDate = extractAstronomyDate(message);
  const dateStr = formatAstronomyDate(targetDate);

  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`;
    const geo = (await astronomyHttpsGetJson(geoUrl)) as {
      results?: Array<{ name: string; latitude: number; longitude: number; admin1?: string; country?: string }>;
    };
    if (!geo.results || geo.results.length === 0) return null;

    const { name, latitude, longitude, admin1, country } = geo.results[0];
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=sunrise,sunset&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
    const forecast = (await astronomyHttpsGetJson(forecastUrl)) as {
      daily?: { time: string[]; sunrise: string[]; sunset: string[] };
    };
    const daily = forecast.daily;
    if (!daily || !daily.sunrise || !daily.sunset || daily.sunrise.length === 0) return null;

    const sunrise = formatAstronomyTime(daily.sunrise[0]);
    const sunset = formatAstronomyTime(daily.sunset[0]);
    const place = [name, admin1, country].filter(Boolean).join(", ");
    return `🌅 ${place}（${dateStr}）\n日出：${sunrise}\n日落：${sunset}`;
  } catch (err) {
    process.stderr.write(`[tryAstronomyReply] Failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

/**
 * Check if a message contains action-oriented intent.
 * Uses semantic classification when available, falls back to keyword matching.
 */
export function hasActionIntent(message: string): boolean {
  const lower = message.toLowerCase();
  const actionKeywords = [
    "创建", "生成", "删除", "修改", "写入", "读取", "列出",
    "create", "generate", "delete", "modify", "write", "read", "list",
    "文件夹", "html", "css", "网页", "代码",
    "folder", "directory", "mkdir",
    "安装", "卸载", "install", "uninstall", "搜索", "search",
    "保存", "save",
    "搜索", "查找", "获取", "总结", "分析", "整理",
    "翻译", "转换", "转化", "translate", "convert", "transform",
    "新闻", "热搜", "天气", "邮件",
    "下载", "爬取", "抓取", "小说", "download", "scrape", "crawl", "novel",
    "计算", "运行", "执行", "启动", "compute", "run", "execute", "start",
    "发送", "推送", "通知", "send", "push", "notify",
    "压缩", "解压", "打包", "compress", "extract", "archive",
    "格式化", "美化", "format", "prettify",
  ];
  const excludePatterns = [
    /系统\s*中/i,
    /是否/i,
    /有没有/i,
    /是不是/i,
    /怎么样/i,
    /什么是/i,
    /为什么/i,
    /如何/i,
  ];
  if (excludePatterns.some(p => p.test(message))) return false;
  return actionKeywords.some((kw) => lower.includes(kw));
}

/**
 * Generate a fallback chat response when LLM is unavailable.
 * This is the rule-based response engine.
 */
export async function generateChatResponse(
  deps: QuickReplyDeps,
  message: string,
  msg: string,
  installedSkills: unknown[],
  skillManager: SkillManagerLike | undefined,
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>
): Promise<string> {
  const skillsList = installedSkills.length > 0
    ? (installedSkills as Array<{ name: string; description: string }>)
        .map((s) => `  - ${s.name}: ${s.description || "无描述"}`)
        .join("\n")
    : "";

  const lines: string[] = [];
  const addLine = (text: string) => {
    if (text.trim()) lines.push(text);
  };

  if (msg.includes("你好") || msg === "hi" || msg === "hello" || msg === "hey") {
    addLine(`${deps.persona.masterTerm}您好！我是 ${deps.persona.name}，${deps.persona.title} 🧬`);
    addLine(`请问有什么可以帮您的？`);
    if (skillsList) {
      addLine(`我已经安装了以下技能：`);
      addLine(skillsList);
    } else {
      addLine(`您可以先安装一些 Skill 来扩展我的能力。`);
    }
    addLine(`当前使用模型: ${deps.config.model} (${deps.config.provider})`);
  } else if (msg.includes("你能做什么") || msg.includes("能力") || msg.includes("功能") || msg.includes("what can you do")) {
    addLine(`我是 ${deps.persona.name}，以下是当前能力：`);
    addLine(`🎯 **对话交互** — 自然语言理解和回复`);
    addLine(`🛠️ **技能执行** — 运行已安装的 Skill`);
    addLine(`📋 **任务编排** — 规划和执行复杂任务流程`);
    addLine(`🔍 **搜索技能** — 浏览本地和远程技能市场`);
    addLine(`📈 **自我进化** — 学习和优化执行策略`);
    addLine(`💬 **多通道** — 支持微信/钉钉/飞书等平台`);
    if (skillsList) {
      addLine(`**已安装技能 (${installedSkills.length} 个):**`);
      addLine(skillsList);
    }
    addLine(`当前配置: ${deps.config.model}@${deps.config.provider}`);
    addLine(`您可以通过 LLM 配置页面对接真实大模型 API 来获得更强的智能推理能力。`);
  } else if (msg.includes("天气") || msg.includes("weather")) {
    const weatherSkill = skillManager
      ? (installedSkills as Array<{ id: string; name: string }>).find((s) =>
          s.name.includes("weather"))
      : null;

    if (weatherSkill && skillManager) {
      addLine(`已匹配天气相关技能！正在使用 "${weatherSkill.name}" 为您处理...`);
      try {
        const result = await skillManager.executeSkill(weatherSkill.id, {
          prompt: message,
          query: message,
        });
        addLine(`执行结果: ${JSON.stringify(result, null, 2)}`);
      } catch {
        addLine(`技能执行遇到问题，请稍后重试。`);
      }
      return lines.join("\n");
    } else {
      addLine(`您提到了天气查询，但目前没有安装天气相关技能。`);
      addLine(`您可以通过以下方式安装技能：`);
      addLine(`1. 准备一个 .SKILL.md 文件`);
      addLine(`2. 使用 CLI: EvoClaw skills install <文件路径>`);
      addLine(`3. 或通过 API: POST /api/skills/install`);
    }
  } else if (msg.includes("网页") || msg.includes("html") || msg.includes("写一个") || msg.includes("代码") || msg.includes("编程") || msg.includes("创建") || msg.includes("文件") || msg.includes("文件夹") || msg.includes("生成")) {

    let hasDriveLetter = false;
    let driveRoot = "";
    const driveMatch = message.match(/([A-Za-z])\s*[盘:]/);
    if (driveMatch) {
      hasDriveLetter = true;
      driveRoot = `${driveMatch[1].toUpperCase()}:/`;
    }

    const basePath = process.cwd().replace(/\\/g, "/");
    const targetRoot = driveRoot || `${basePath}/`;

    let folderName = "newweb";
    const folderMatch = message.match(/(?:创建|新建|生成|建立|写|mkdir?\s+)\s*[一个]*\s*[名为]*\s*["'`]?(\w[\w-]*)["'`]?(?:\s*(?:文件夹|目录|网页|网站|directory|folder|网站|website|webpage))/i);
    if (folderMatch) {
      folderName = folderMatch[1];
    } else {
      const cnFolderMatch = message.match(/(\w[\w-]*)\s*(?:文件夹|目录)/);
      if (cnFolderMatch) {
        folderName = cnFolderMatch[1];
      }
    }

    if (hasDriveLetter) {
      addLine(`检测到您指定了 ${driveMatch![1].toUpperCase()} 盘，文件将创建在: \`${targetRoot}${folderName}/\``);
    }

    const toolsToTry: Array<{ name: string; args: Record<string, unknown> }> = [];
    const prefix = `${targetRoot}${folderName}`;

    if (msg.includes("文件夹") || msg.includes("directory") || msg.includes("mkdir")) {
      if (deps.registeredTools.has("file_create")) {
        toolsToTry.push({
          name: "file_create",
          args: { path: `${prefix}/.gitkeep`, content: "" },
        });
      }
    }

    if (msg.includes("html") || msg.includes("网页")) {
      if (deps.registeredTools.has("file_create")) {
        const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>我的网页</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>欢迎来到我的网页</h1>
    <nav>
      <a href="#">首页</a>
      <a href="#">关于</a>
      <a href="#">联系</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h2>Hello World!</h2>
      <p>这是一个由 EvoClaw 自动生成的网页。</p>
      <button id="greetBtn">点击问好</button>
      <p id="greeting"></p>
    </section>
  </main>
  <footer>
    <p>&copy; 2026 My Website. Powered by EvoClaw.</p>
  </footer>
  <script src="script.js"></script>
</body>
</html>`;
        toolsToTry.push({
          name: "file_create",
          args: { path: `${prefix}/index.html`, content: htmlContent },
        });
      }
    }

    if (msg.includes("css")) {
      if (deps.registeredTools.has("file_create")) {
        const cssContent = `/* style.css */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  line-height: 1.6;
  color: #333;
  background: #f5f5f5;
}

header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 1.5rem;
  text-align: center;
}

header h1 {
  margin-bottom: 1rem;
  font-size: 2rem;
}

nav {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
}

nav a {
  color: rgba(255,255,255,0.85);
  text-decoration: none;
  font-weight: 500;
  transition: color 0.2s;
}

nav a:hover {
  color: white;
}

main {
  max-width: 800px;
  margin: 2rem auto;
  padding: 0 1rem;
}

.hero {
  background: white;
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}

.hero h2 {
  color: #667eea;
  margin-bottom: 1rem;
  font-size: 1.8rem;
}

.hero p {
  color: #666;
  margin-bottom: 1.5rem;
}

button {
  background: #667eea;
  color: white;
  border: none;
  padding: 0.75rem 2rem;
  border-radius: 6px;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #5a6fd6;
}

#greeting {
  margin-top: 1rem;
  font-size: 1.1rem;
  color: #764ba2;
  font-weight: 600;
}

footer {
  text-align: center;
  padding: 1.5rem;
  color: #999;
  font-size: 0.9rem;
}`;
        toolsToTry.push({
          name: "file_create",
          args: { path: `${prefix}/style.css`, content: cssContent },
        });
      }
    }

    if (msg.includes("js") || msg.includes("javascript")) {
      if (deps.registeredTools.has("file_create")) {
        const jsContent = `// script.js
document.addEventListener('DOMContentLoaded', () => {
  const greetBtn = document.getElementById('greetBtn');
  const greeting = document.getElementById('greeting');

  const messages = [
    '你好！很高兴见到你！',
    '欢迎来到我的网页！',
    '祝你今天过得愉快！',
    'Hello from EvoClaw! 🧬',
    '今天也是个好日子！',
  ];

  greetBtn.addEventListener('click', () => {
    const randomMsg = messages[Math.floor(Math.random() * messages.length)];
    greeting.textContent = randomMsg;
    greeting.style.animation = 'none';
    greeting.offsetHeight;
    greeting.style.animation = 'fadeIn 0.5s ease';
  });
});

const style = document.createElement('style');
style.textContent = \`
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
\`;
document.head.appendChild(style);
`;
        toolsToTry.push({
          name: "file_create",
          args: { path: `${prefix}/script.js`, content: jsContent },
        });
      }
    }

    if (toolsToTry.length > 0) {
      let allSuccess = true;
      const actualPaths: string[] = [];
      for (const tt of toolsToTry) {
        try {
          const entry = deps.registeredTools.get(tt.name);
          if (entry) {
            const result = await entry.handler(tt.args);
            const resultObj = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
            const isSuccess = resultObj && resultObj.success !== false;
            const icon = isSuccess ? "✅" : "❌";
            if (resultObj && resultObj.requiresPermission) {
              pendingPermissions.push({
                id: (resultObj.requestId as string) || (resultObj.id as string) || "",
                operation: (resultObj.operation as string) || tt.name,
                description: (resultObj.description as string) || "需要权限确认",
                target: (resultObj.target as string) || (tt.args.path as string) || tt.name,
              });
              addLine(`🔐 **权限请求**: ${resultObj.description || "此操作需要您的授权"}`);
              addLine(`   操作: \`${resultObj.operation || tt.name}\`, 目标: \`${resultObj.target || tt.args.path}\``);
              addLine(`   请在下方权限提示条中选择：本次授权 / 加入白名单 / 拒绝`);
            } else {
              const actualPath = (resultObj?.path as string) || (tt.args.path as string);
              if (isSuccess && actualPath) actualPaths.push(actualPath);
              addLine(`${icon} \`${tt.name}\` → \`${actualPath}\` ${isSuccess ? "执行成功" : "执行失败"}`);
              if (resultObj?.warning) {
                addLine(`   ⚠ ${resultObj.warning}`);
              }
              if (resultObj?.error) {
                addLine(`   ${resultObj.error}`);
              }
            }
            if (!isSuccess) allSuccess = false;
          }
        } catch (err) {
          allSuccess = false;
          addLine(`❌ \`${tt.name}\` 执行失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (allSuccess && toolsToTry.length > 1) {
        let hasAnyPermission = false;
        for (const tt of toolsToTry) {
          const pendingForThis = pendingPermissions.length > 0 && pendingPermissions.some((p) => p.target.includes(String(tt.args.path)));
          if (pendingForThis) { hasAnyPermission = true; break; }
        }
        if (hasAnyPermission) {
          addLine("以上操作需要您的授权才能执行。请在下方权限提示条中选择操作。");
        } else {
          addLine("所有操作已完成！");
          if (actualPaths.length > 0) {
            const actualDir = actualPaths[0].replace(/[\\/][^\\/]+$/, "");
            addLine(`文件位置: ${actualDir}/`);
            addLine(`在文件浏览器打开: ${actualDir}/`);
          }
        }
      } else if (!allSuccess) {
        if (pendingPermissions.length > 0) {
          addLine("以上操作需要您的授权才能执行。请在下方权限提示条中选择操作。");
        } else {
          addLine("部分操作未能完成，请检查上述错误信息。");
        }
      }
      return lines.join("\n");
    }

    addLine(`当前我处于**离线/规则模式**，正在使用 ${deps.config.model} 模型。`);
    addLine(`要获得真正的代码生成能力，您需要：`);
    addLine(`1. 在 **LLM 配置页** 配置一个真实的 API（如 OpenAI/DeepSeek/Anthropic）`);
    addLine(`2. 填入有效的 API Key`);
    addLine(`3. 启用该提供商并保存`);
    addLine(`配置完成后，我就能通过 API 调用大模型来为您生成代码了！`);
    if (skillsList) {
      addLine(`已安装技能: ${installedSkills.length} 个`);
    }
  } else if (msg.includes("技能") || msg.includes("skill") || msg.includes("安装")) {
    addLine(`关于技能管理：`);
    if (skillsList) {
      addLine(`当前已安装 ${installedSkills.length} 个技能：`);
      addLine(skillsList);
    } else {
      addLine(`当前没有安装任何技能。`);
    }
    addLine(`技能安装方式：`);
    addLine(`- CLI: EvoClaw skills install <路径>`);
    addLine(`- API: POST /api/skills/install {"path":"..."}`);
    addLine(`- 技能市场: EvoClaw skills search <关键词>`);
  } else {
    const activeProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
    addLine(`${deps.persona.masterTerm}，收到您的消息："${message}"`);

    // Proactive skill search for action-oriented tasks
    const isAction = hasActionIntent(message);
    if (isAction && deps.registeredTools.has("skill_search")) {
      addLine(`🔍 检测到操作意图，正在搜索匹配的Skill...`);
      try {
        const searchTool = deps.registeredTools.get("skill_search")!;
        const searchResult = await searchTool.handler({ task: message });
        const searchObj = typeof searchResult === "object" && searchResult !== null ? (searchResult as Record<string, unknown>) : null;
        if (searchObj?.found) {
          const skillName = String(searchObj.skillName || "");
          const skillPath = String(searchObj.skillPath || "");
          addLine(`✅ 找到匹配Skill: "${skillName}" (路径: ${skillPath})`);
          addLine(`📦 正在安装...`);

          if (deps.registeredTools.has("skill_install")) {
            const installTool = deps.registeredTools.get("skill_install")!;
            const installResult = await installTool.handler({ path: skillPath });
            const installObj = typeof installResult === "object" && installResult !== null ? (installResult as Record<string, unknown>) : null;
            if (installObj?.success) {
              addLine(`✅ Skill "${installObj.skillName || skillName}" 安装成功！`);
              addLine(`🔄 正在执行...`);
              // Try to execute via skillManager
              if (skillManager) {
                try {
                  const execResult = await skillManager.executeSkill(String(installObj.skillName || skillName), { prompt: message, query: message });
                  addLine(`✅ Skill执行完成！`);
                  addLine(`结果: ${JSON.stringify(execResult, null, 2).slice(0, 3000)}`);
                  return lines.join("\n");
                } catch (execErr) {
                  addLine(`⚠ Skill执行失败: ${execErr instanceof Error ? execErr.message : String(execErr)}`);
                }
              }
            } else {
              addLine(`⚠ 安装失败: ${installObj?.error || "未知错误"}`);
            }
          }
        } else {
          addLine(`⚠ 未找到匹配的Skill。`);
          if (deps.registeredTools.has("skill_create")) {
            addLine(`💡 您可以说"创建Skill"让我自动生成一个，或配置LLM API后重试。`);
          }
        }
      } catch (err) {
        addLine(`⚠ Skill搜索出错: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (activeProviders.length > 0) {
      const provNames = activeProviders.map((p) => `${p.name}(${p.model})`).join(", ");
      addLine(`⚠ ${deps.persona.name} 的 LLM 调用暂时失败 (${provNames})，但我不会放弃！`);
      addLine(``);
      addLine(`🔄 正在尝试备用方案...`);

      // Report actual skill state
      if (skillsList) {
        addLine(`📦 已安装技能 (${installedSkills.length} 个): ${skillsList}`);
      } else {
        addLine(`📦 未检测到已安装技能。`);
      }

      // Try common tools
      const availableTools = Array.from(deps.registeredTools.keys());
      if (availableTools.length > 0) {
        addLine(`🔧 可用工具 (${availableTools.length} 个): ${availableTools.slice(0, 8).join(", ")}${availableTools.length > 8 ? "..." : ""}`);
      }

      addLine(``);
      addLine(`💡 建议操作：`);
      addLine(`1. 检查 LLM API 配置是否正确（API Key、模型名、Base URL）`);
      addLine(`2. 安装专属 Skill 来处理此类任务`);
      addLine(`3. 重试：重新发送指令给我`);
      addLine(``);
      addLine(`请告诉我您想如何继续！`);
    } else {
      addLine(`${deps.persona.name} 尚未配置 LLM 提供商。`);
      addLine(``);
      addLine(`要启用 AI 对话能力，请：`);
      addLine(`1. 在 LLM 配置页添加提供商（如 DeepSeek/OpenAI）`);
      addLine(`2. 填入 API Key 和 Base URL`);
      addLine(`3. 启用并保存`);
      if (skillsList) {
        addLine(`📦 已安装技能 (${installedSkills.length} 个): ${skillsList}`);
      }
    }
  }

  return lines.join("\n");
}
