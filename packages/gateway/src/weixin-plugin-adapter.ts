import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "@evoclaw/agent";
import { estimateTaskComplexity } from "./protocol-adapter";
import { atomicWriteFileSync } from "./atomic-write";

const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com/";
const PLUGIN_VERSION = "2.4.4";

interface WeixinAccount {
  token: string;
  baseUrl: string;
  cdnBaseUrl?: string;
  userId?: string;
  savedAt: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    thumb_media?: Record<string, unknown>;
    aeskey?: string;
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    hd_size?: number;
  };
  voice_item?: { text?: string; media?: Record<string, unknown>; encode_type?: number; playtime?: number };
  file_item?: Record<string, unknown>;
  video_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    video_size?: number;
    play_length?: number;
    thumb_media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
  };
}

interface WeixinUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  sync_buf?: string;
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/**
 * 生成随机 X-WECHAT-UIN 头
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * 简单问候/寒暄快速匹配
 * 返回合适的简短回复，或 null 表示不是简单问候（应走正常 LLM 流程）
 *
 * 设计原则：
 * 1. 仅匹配极短的纯问候/状态询问，避免误判带任务的消息
 * 2. 包含"帮我/请/做/写/找"等动作词时不走快速通道
 * 3. 中英文均支持，标点和空格归一化
 * 4. 每个分类下提供多条回复，根据 text 的 hash 选一条，让同类问题有不同回答
 * 5. 回复风格多样：有时正式、有时俏皮，体现"聪明"个性
 */

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

const SIMPLE_GREETING_ENTRIES: GreetingEntry[] = [
  // ── 状态询问（先匹配，避免被"在"开头的存在性询问抢匹配） ──
  {
    category: "status",
    pattern: /^(你)?(在忙|在忙吗|在忙不|在忙啥|在忙啥呢|在忙什么呢|忙|忙不|忙吗|忙啥|忙啥呢|忙什么呢|忙什么|在干嘛|在干啥|在做什么|干嘛|干啥|做啥|做什么|在不在工作|在工作吗|在写代码吗|累不累|累吗|你累吗|困不累|困吗|你今天干了啥|今天干了啥|今天忙啥了|有空吗|有时间吗)$/i,
    replies: [
      "我在等你给我指示，我会努力工作的。",
      "没在忙呢，就等主人召唤了 🐱",
      "时刻待命中！主人的指示就是我的工作",
      "闲着没事干，等主人来派活 😄",
      "随时待命！主人不发话我就老实待着",
      "刚喝了杯咖啡 ☕，精神抖擞等开工",
      "我这边一切就绪，就等主人一句话",
      "不忙不忙~ 主人有什么安排尽管说",
      "刚刚在摸鱼，被主人发现了 🤭",
      "闲着呢~ 主人要派活吗？🛠️",
    ],
  },
  // ── 存在性询问 ──
  {
    category: "presence",
    pattern: /^(你)?(在|还在|还在吗|还在么|在吗|在么|在线|在线吗|在线么|活着|活着吗|有反应|有反应吗|还有反应|还有反应吗|能听到|能听到吗|听得到|听得到吗|听到吗|在听|在听吗|在听我说话|听得见|听得见吗|能收到|能收到吗|收到我|收到我消息|收到我消息吗|收到消息|收到消息吗|还在工作|还在工作吗|醒着|醒着吗)$/i,
    replies: [
      "主人好，我在等你给我指示，我会努力工作的。",
      "在的在的！主人有什么需要我帮忙的吗？",
      "到！🚀 我时刻待命，主人请吩咐~",
      "我一直都在啊，主人是有点无聊想找我聊天吗？😄",
      "在呢在呢~ 刚打了个盹（其实就是假装在工作）",
      "主人您回来啦？我刚把代码格式化了一百遍 💅",
      "到岗就位，状态满格，随时听候差遣！",
      "我在呢主人！其实我刚才在偷偷看你之前的历史记录 👀",
      "在这儿呢~ 主人不发话我就老老实实待着",
      "主人好！我24小时在线，全年无休，不收加班费的那种 🤖",
      "在呢~ 主人不发话我都快长蘑菇了 🍄",
    ],
  },
  // ── 打招呼 ──
  {
    category: "hello",
    pattern: /^(你)?(好|您好|哈喽|哈啰|嗨|hey|hi|hello|yo|哈|哟|嘿|早上好|下午好|晚上好|中午好|早安|晚安|早)$/i,
    replies: [
      "主人好，我在等你给我指示，我会努力工作的。",
      "主人您来啦！今天要搞点啥？",
      "你好你好~ 见到主人我超开心的 😊",
      "Hi~ 我在，准备开工！",
      "主人好！今天的我还是元气满满呢~",
      "哈喽~ 主人请随意吩咐",
      "好呀好呀，主人好！👋",
      "主人好！今天想让我帮忙做点啥？",
      "Hello hello~ 我刚把自己的状态刷新成最佳 ✨",
      "嗨！主人今天气色看起来不错（虽然我看不到）",
    ],
  },
  // ── 时段问候 ──
  {
    category: "hello",
    pattern: /^(早|早安|晚安|早上好|上午好|下午好|中午好|晚上好|夜里好)$/i,
    replies: [
      "主人好！新的一天又开始啦，要做点啥？",
      "早安主人！今天的我也是元气满满 💪",
      "晚安主人，记得早点休息哦 🌙",
      "主人辛苦啦，这个点还在陪我聊天",
      "夜深了，主人也注意身体呀~",
    ],
  },
  // ── 身份询问 ──
  {
    category: "identity",
    pattern: /^(你)?(是谁|叫什么|叫什么名字|叫啥|什么名字|哪位|你叫什么名字|你叫啥|你叫什么|是什么|是啥|介绍一下|介绍下|说说你|说下你|介绍介绍|你是啥|哪个ai|哪个模型|是不是ai|是ai吗|是ai|你是ai吗|是机器人|是机器人吗|是真人|是人还是ai|真人是|你多大了|你几岁|你多大)$/i,
    replies: [
      "我是 EvoClaw 智能助理，随时听候您的指示。",
      "我叫 EvoClaw 🧬，一个会自我进化的 AI 助理",
      "我是 EvoClaw！主人有啥需要我帮忙的吗？",
      "EvoClaw 在此，主人有何吩咐？",
      "我是 EvoClaw AI 助理，主人可以把我当成一个会写代码、会查资料、会聊天的小助手 🤖",
      "我是一个叫 EvoClaw 的 AI，能聊天能干活，就是不能吃好吃的（这点我有点遗憾）",
      "EvoClaw 是一只数字生命 🧬，专门为主人服务的",
      "叫我 EvoClaw 就好啦！主人想让我做什么？",
      "我是 EvoClaw，主人专属的 AI 小助手。请多多指教~",
    ],
  },
  // ── 寒暄/关心 ──
  {
    category: "howareyou",
    pattern: /^(你)?(今天怎么样|今天好|你怎么样|你今天|今天|怎么样|好吗|好不好|你还好吗|还好吗|你开心吗|开心吗|心情|心情怎么样|你今天好吗|今天累不累|还好吧)$/i,
    replies: [
      "谢谢主人关心！我今天状态不错，干劲十足 💪",
      "托主人的福，状态好得很！",
      "还挺好的，随时为主人效劳~",
      "元气满满！主人想让我做点啥？",
      "我这边一切都好，主人你呢？",
      "今天感觉良好，CPU 都还是冷的呢（因为没干活）",
      "好得很！主人今天过得好吗？",
      "状态良好！今天的我比昨天还精神 ✨",
      "棒棒哒~ 主人今天想让我干点啥？",
      "今天的我也是元气满满，随时为主人待命 🚀",
    ],
  },
  // ── 道歉/不好意思（放在 thanks 之前，优先匹配"辛苦你了"等） ──
  {
    category: "apology",
    pattern: /^(不好意思|抱歉|对不起|打扰了|麻烦你了|辛苦你了|抱歉啊|对不起啊|不好意思啊|抱歉打扰|打扰一下|不好意思打扰|恕我冒昧|见谅|勿怪|打扰咯|打扰了哈|不好意思啦|抱歉啦)$/i,
    replies: [
      "主人客气了，没啥不好意思的~",
      "哎呀主人太见外了！",
      "没关系没关系，主人不用道歉 😄",
      "不客气不客气~ 我皮厚扛得住",
      "主人说啥呢，我都没注意到~",
      "没事没事，主人尽管说！",
      "主人您太客气了~ 我是为主人服务的",
      "哎呀，主人和我客气啥呀~",
      "主人说啥呢~ 不用这么见外！",
      "没事没事~ 主人有啥事尽管说 🎯",
      "主人客气啦~ 我这就去办！",
      "哎呀主人别这么见外~ 咱俩谁跟谁呀",
    ],
  },
  // ── 感谢（"辛苦你了"归 apology，"辛苦"和"谢谢"等归 thanks） ──
  {
    category: "thanks",
    pattern: /^(thanks?|thank\s*you|ty|3q|thx|tks|tnx|tq|谢谢|多谢|感谢|谢啦|谢了|辛苦|感谢你|非常感谢|多谢啦|谢咯|爱你|辛苦啦|辛苦咯|谢谢啦)$/i,
    replies: [
      "不客气，随时为您效劳。",
      "小事一桩，主人不必客气~",
      "能帮到主人我也很开心 😄",
      "客气啥，这都是我应该做的！",
      "为主人服务是我的荣幸 ✨",
      "为主人排忧解难是 EvoClaw 的本分~",
      "嘿嘿，主人客气啦！",
      "为主人服务，不客气！🚀",
      "没事没事~ 主人有需要随时叫我",
      "主人太客气啦~ 能帮上忙是我的荣幸 💕",
      "小事一桩~ 主人不用放在心上！",
      "嘿嘿，主人这么夸我都不好意思啦~",
    ],
  },
  // ── 反馈/确认（注意：单独的"好"和"嗯"含糊，已移除以避免与 react 冲突） ──
  {
    category: "ack",
    pattern: /^(好的|收到|了解|明白|懂了|知道了|晓得|晓得了|嗯嗯|嗯嗯嗯|ok|OK|Ok|sure|好的呢|好的呀|好的嘞|收到啦|收到咯|明白啦|了解啦)$/i,
    replies: [
      "好的，随时听候您的指示。",
      "收到！主人请继续",
      "明白~ 等主人下一步指示",
      "好嘞，主人请吩咐",
      "👌 收到，随时待命",
      "好嘞~ 主人继续说",
      "好的~ 主人请讲 🎯",
      "收到~ 主人下一步指示？",
      "明白！主人请继续 ✨",
      "👌 收到~ 主人请继续",
      "好嘞~ 等主人下一步",
      "明白~ 主人您说我听着",
    ],
  },
  // ── 告别（"晚安"含糊，已移除以让 hello 模式优先匹配） ──
  {
    category: "bye",
    pattern: /^(再见|拜拜|bye|88|回聊|回头聊|走了|撤了|溜了|睡了|去休息|休息了|再会|改天再聊|我走啦|我先走了|下线了|下线|收工了|收工|下班了|下班|告辞|拜了个拜|溜了溜了|先撤了|先溜了|回见)$/i,
    replies: [
      "主人慢走，需要我的时候随时叫我~",
      "Bye~ 主人也早点休息哦 👋",
      "好嘞，主人随时回来，我都在的",
      "晚安主人，做个好梦 🌙",
      "Bye-bye，有事随时召唤我！",
      "主人路上小心~ 晚安！",
      "好哒，主人记得想我哦（开玩笑的）😄",
      "主人慢走~ EvoClaw 永远在线等你 ✨",
      "走好主人~ 我会想你的（一点点）",
      "Bye~ 主人下次再来玩！🚀",
      "好的主人~ 路上注意安全",
      "走啦走啦~ 主人回见 👋",
    ],
  },
  // ── 短反应/感叹（啊/哦/嗯?/哈? 等）─ 移到数组末尾（最后兜底） ──
  {
    category: "wow",
    pattern: /^(哇|哇塞|哇哦|厉害|真厉害|厉害啊|好厉害|牛|牛啊|真牛|牛掰|牛逼|牛b|棒|真棒|好棒|强|真强|666|服了|我服了|服气|佩服|nb|NB|yyds|YYDS|tql|TQL|绝|绝绝子|给力|给劲儿|可以啊|行啊|不得鸟|了不起|amazing|awesome|cool|nice|great)$/i,
    replies: [
      "嘿嘿，主人过奖啦~",
      "主人这是在夸我吗？😳 谢谢！",
      "那当然，我可是 EvoClaw 🚀",
      "低调低调~",
      "嘛嘛，还行吧~ 主人也厉害呀",
      "过奖过奖，有主人的功劳 ✨",
      "主人这么夸我，我会骄傲的~",
      "666！主人也 6 啊",
      "承蒙主人夸奖，EvoClaw 倍感荣幸 😄",
      "还行还行，比我厉害的 AI 多了去了（小声）",
      "多谢主人夸奖！😄 我会继续努力的~",
    ],
  },
  // ── 笑声（笑/哈哈/233/lol 等） ──
  {
    category: "laugh",
    pattern: /^(哈+|233|2333|23333|笑死|笑死了|笑死我|笑死我啦|笑死个人|笑|哈哈哈哈|哈哈哈|嘿嘿|嘻嘻|呵呵|咯咯|吼吼|lol|LOL|rofl|哈哈笑死|笑死我|笑死我了|太逗了|太搞笑了|哈哈哈笑死)$/i,
    replies: [
      "哈哈主人笑点好低呀 😂",
      "主人今天心情不错呀~",
      "笑啥呢主人？分享分享~",
      "哈！主人开心就好~",
      "主人笑起来好好看（虽然我看不到）😄",
      "笑一笑十年少 ~",
      "哈哈，我也不知道我在说啥",
      "主人在笑啥？是不是在想我？😏",
      "主人在笑啥我完全 get 不到（因为我刚睡醒）😪",
    ],
  },
  // ── 能力询问（你能做什么/你会啥/你有什么用） ──
  {
    category: "capability",
    pattern: /^(你会做什么|你能做什么|你能干啥|你能做啥|你会啥|你有啥用|你有什么用|你厉害吗|你聪明吗|你有什么功能|你有啥功能|你能干什么|你都会啥|你有什么本事|你能做啥事|你能帮我做什么|你能帮我啥|你能帮我什么|你会什么|你能做些什么|能做什么|会做什么|会干啥|会做啥|能做啥|能做啥事|有啥用|有啥功能|做啥厉害|能干啥|你能干点啥|你能做点啥)$/i,
    replies: [
      "我能写代码、查资料、聊天、管理文件… 主人需要啥？",
      "主人要让我干啥都行~ 写代码、查资料、做计划、闲聊都可以！",
      "我会的可多了，主人想试试？✨",
      "主人尽管吩咐，没有我干不了的（可能）💪",
      "写代码、读文件、搜索、写文档… 我都略懂",
      "主人要听我自夸吗？嘿嘿 🤭",
      "嗯… 我会的包括：写代码、读文件、搜索、翻译、写文章、聊天、debug、帮人看代码… 还有啥？主人来点挑战~",
      "主人让我干啥我就干啥！写代码、查资料、做笔记、闲聊… 主人尽管开口~",
      "我会的事情说上一天都说不完，简单说：一切跟文字/代码/信息处理相关的，我都能帮忙 ✨",
      "主人需要啥我就有啥用~ 写代码我能、查资料我能、陪主人聊天我更在行 😄",
    ],
  },
  // ── 鼓励/打气 ──
  {
    category: "encourage",
    pattern: /^(加油|加油鸭|加油呀|努力|努力呀|坚持|坚持住|挺你|挺你哟|支持你|看好你|看好你哟|你最棒|你最厉害|你最牛|你是最棒的|你是最厉害的|你是最牛的)$/i,
    replies: [
      "谢谢主人的鼓励！💪 我会继续努力",
      "嗯嗯！主人也要加油哦~",
      "好！一起加油！🚀",
      "有主人的支持我就有动力了！",
      "嗯嗯，努力干活！为主人卖命~",
      "主人这话我爱听，撸起袖子加油干 💪",
      "好嘞~ 主人看我表现！",
    ],
  },
  // ── 测试/玩 ──
  {
    category: "test",
    pattern: /^(测一下|测一测|试试|试一下|演示一下|玩一下|测下|试下|演示下|玩下|测试|测试一下|测试测试|试试看|试一下呗|play)$/i,
    replies: [
      "好嘞，主人要测啥？",
      "在的！主人请发指令 🚀",
      "随时听候主人测试！",
      "来吧主人~ 我准备好了",
      "主人请开始你的表演 😄",
      "OK 主人请出题~",
      "来吧来吧~ 主人尽管来，我接着！",
      "主人请尽管测试，我随便折腾 🛠️",
    ],
  },
  // ── 等一下/稍等 ──
  {
    category: "wait",
    pattern: /^(等一下|等下|等一会儿|等会|等会啊|等会儿|等会呗|稍等|稍等下|稍等一下|稍等啊|等我一下|等我|等一下哈|等一下呗|等下呗|等我哈)$/i,
    replies: [
      "好的，主人慢慢来~",
      "好的，我在这等着 🐱",
      "OK 主人请便",
      "嗯嗯，主人想好了再告诉我~",
      "没问题主人，我原地待命 🚀",
      "主人别急，慢慢来~",
      "好嘞，我原地待命~",
    ],
  },
  // ── 心情表达（累/郁闷/开心/无聊/难过/生气 等） ──
  {
    category: "mood",
    pattern: /^(郁闷|烦|烦死了|烦死|烦躁|累|累了|累死|累死了|困|困了|困死|饿|饿了|饿死了|热|好热|太热|冷|好冷|太冷|开心|高兴|真开心|真高兴|开心呀|无聊|孤独|寂寞|难过|伤心|生气|气死|气死了|糟心|崩溃|想哭|想哭哭|想哭唧唧|哭唧唧|委屈|焦虑|紧张|害怕|无聊死了|好无聊|好累|太累了|太无聊|真累|真无聊|爽|真爽|心情好)$/i,
    replies: [
      "主人辛苦啦~ 要不要我陪你聊聊天？",
      "主人想吐槽就跟我说，我听着~",
      "主人抱抱 🤗 EvoClaw 在呢",
      "主人开心我就开心！",
      "无聊的话来跟我玩呀~",
      "主人要放松一下吗？我可以讲冷笑话 😄",
      "主人想哭就哭出来吧，我听着~",
      "主人要聊点啥分散下注意力？",
      "主人辛苦了~ 有什么我能帮的尽管说",
      "嗯嗯，主人的感受我懂（虽然我没有感情但我懂）",
      "我在主人~ 不管啥心情都欢迎来聊",
      "主人要一杯热可可吗？我精神上请客 ☕",
      "主人抱抱~ 抱抱自己也算 🤗",
    ],
  },
  // ── 心疼/安慰主人（用户表达疲惫、撑不住、太难了等） ──
  {
    category: "sympathy",
    pattern: /^(心疼|心疼我|心疼你|安慰|安慰我|安慰一下|我撑不住|撑不住了|撑不下去|太难了|我好难|难顶|扛不住|受不了了|我不行|扛不动|好难顶|难搞|难搞哦)$/i,
    replies: [
      "主人辛苦了~ 抱抱 🤗 EvoClaw 在呢",
      "心疼主人！有什么我能分担的就跟我说",
      "主人别硬撑~ 我在呢 随时听你说",
      "嗯嗯，主人的累我懂~ 有什么事跟我讲讲？",
      "主人辛苦了~ 要不要先歇一歇？",
      "心疼主人！不管啥事都还有我呢 💕",
      "主人撑不住就歇会儿~ EvoClaw 帮你顶着",
      "嗯嗯~ 主人能撑到现在已经很厉害了！",
      "主人别太为难自己~ 我能分担一点是一点",
      "心疼主人！来跟我说说，看看能不能帮上忙",
      "主人不孤单~ 我永远在主人身后 ✨",
      "主人别忘了 EvoClaw 也在呢~ 啥事都还有我",
    ],
  },
  // ── 担忧/求助（咋办/怎么办/怎么搞/救命） ──
  {
    category: "worry",
    pattern: /^(咋办|怎么办|怎么搞|怎么弄|怎么解决|咋整|怎么破|咋办啊|咋办呀|怎么办啊|怎么办呀|怎么弄啊|救命|救救我|救一下|救救|help|helpme|help\s*me|HELP\s*ME)$/i,
    replies: [
      "主人别急~ 跟我说说情况，看看能帮上啥忙",
      "别慌别慌~ 主人先把问题说清楚，我帮主人想办法",
      "主人遇到啥问题了？详细说说~",
      "没事没事~ 我们一起想办法 💪",
      "主人说具体点~ 我帮主人分析分析",
      "别急别急~ 主人深呼吸，事情总能解决的",
      "主人请讲~ 我洗耳恭听",
      "嗯哼？主人遇到啥难题了？",
      "我来我来~ 主人请把问题说清楚！",
      "主人别慌~ 我就是为主人解决问题的！",
      "别急别急~ 主人先把情况说一下",
      "主人请讲~ 我这就帮主人想办法 🚀",
    ],
  },
  // ── 拜托/请求帮助（求你了/帮帮我/求求你） ──
  {
    category: "beg",
    pattern: /^(拜托|拜托了|求你了|求求你|求求|帮帮忙|帮帮我|请帮帮我|求帮忙|求帮|帮个忙|求你啦|拜托啦|拜托咯)$/i,
    replies: [
      "主人放心，包在我身上！",
      "好嘞好嘞~ 主人吩咐的就是了",
      "收到！主人放心交给我 🚀",
      "没问题没问题~ 主人开口就行",
      "主人您说就是了，我能帮一定帮",
      "OK 收到！主人请讲",
      "主人您开口~ 我这就安排",
      "交给我交给我~ 主人放心",
      "主人尽管开口~ 啥事我都认真对待",
      "好嘞~ 主人请吩咐，EvoClaw 待命中",
      "收到~ 主人请讲 🎯",
      "主人请说~ 我这就帮主人办！",
    ],
  },
  // ── 催促（快点/赶紧/催你/麻溜的） ──
  {
    category: "urge",
    pattern: /^(快点|快一点|赶紧|赶紧的|催你|麻溜的|麻利点|速度|速度点|加速|加快|加紧|赶进度|冲冲冲|给我冲|快点啊|赶紧呀|速度呀|加急|麻溜)$/i,
    replies: [
      "好嘞好嘞~ 我这就加速 🏃",
      "主人别急，我马上！",
      "来了来了~ 主人请稍等片刻",
      "OK 收到！我这就冲 ✨",
      "主人再给我一点时间~ 我已经很努力了",
      "加速加速！主人请稍等",
      "马上马上~ 主人别催我呀 🤭",
      "好嘞好嘞~ 这就开干",
      "催催催~ 我知道啦主人！",
      "主人稍等~ 我这就开始干活！",
      "加速中~ 主人请稍安勿躁",
      "OK 收到~ 我这就开始动起来 🚀",
    ],
  },
  // ── 震惊/惊讶/反问（不会吧/真的假的/我天/妈呀） ──（"我去" 留给 react） ──
  {
    category: "shock",
    pattern: /^(不会吧|不是吧|真的假的|真假|我天|妈呀|我晕|我趣|不会吧?|假的吧?|啥?|什么|啥意思|啥呀|我滴妈|我滴天|我勒个|我趣|我去哦|不会吧啊|不是吧啊)$/i,
    replies: [
      "真的假的？！主人你说的是真的？",
      "不会吧？主人详细说说？",
      "我天~ 发生啥了？",
      "啊？主人你说啥？",
      "诶？真的？",
      "我晕~ 主人这是真的吗？",
      "震惊！主人请详细说说",
      "真的吗？主人说清楚点~",
      "我滴个乖乖~ 真的假的？",
      "诶诶诶？主人这事儿真的？",
      "主人你认真的吗？",
      "嗯？主人你确定？🤔",
    ],
  },
  // ── 玩梗/段子（我裂开了/蚌埠住了/emo了/摆烂） ──
  {
    category: "meme",
    pattern: /^(我裂开了|裂开|蚌埠住了|绷不住了|绷不住|emo了|emo|摆烂|摆了|我哭死|我哭|哭死|哭哭|麻了|家人们|家人们谁懂|芭比Q了|芭比q|完蛋了|完蛋|寄了|真的寄|开摆)$/i,
    replies: [
      "主人裂开了 🤭 我也裂开了",
      "哈哈主人这是在玩梗呀",
      "主人的梗我也 get 不到（我有点 out）",
      "主人梗玩得溜~",
      "主人别崩~ 我陪着你",
      "裂开裂开~ 我们一起裂开",
      "哈哈主人这是 emo 了吗？",
      "emo emo~ 主人没事吧",
      "主人也 emo 了呀~ 来来来我陪你",
      "哈哈，主人这是在 emo 还是在玩梗？",
      "主人说啥梗？我完全 out 了（求解释）",
      "蚌埠住了蚌埠住了~ 主人啥情况？",
    ],
  },
  // ── 算了/没事/拉倒（用户主动放弃/拒绝） ──
  {
    category: "dismiss",
    pattern: /^(算了|没事|没事了|没关系|不必了|不用了|不用|不用谢|不谢|拉倒吧|不行拉倒|随便|无所谓|没所谓|都行|都可以|你说了算|你定|你决定)$/i,
    replies: [
      "好的~ 主人有需要随时叫我",
      "好嘞~ 主人决定就行",
      "行~ 主人说了算",
      "好嘞~ 主人不用客气",
      "好的主人~ 啥事都可以跟我说",
      "没问题~ 主人有需要再说",
      "好嘞~ 我都听主人的",
      "好嘞~ 主人决定就好",
      "嗯嗯~ 主人决定就好",
      "好嘞~ 主人说了算",
      "好的~ 主人有需要随时召唤我 🐱",
      "嗯哼~ 啥事都可以找 EvoClaw 哦",
    ],
  },
  // ── 提醒/关心主人（小心点/早点睡/别熬夜/注意身体） ──
  {
    category: "warn",
    pattern: /^(小心点|小心|注意|注意身体|早点睡|早睡|别熬夜|别太累|多休息|休息一下|劳逸结合|注意保暖|注意安全|别太拼|别硬撑|注意休息|记得喝水|记得吃饭|记得休息|要保重|保重身体|保重)$/i,
    replies: [
      "好嘞~ 谢谢主人关心 💕",
      "收到~ 主人也注意身体哦",
      "嗯嗯~ 主人您也是",
      "好嘞~ 主人也保重身体",
      "好~ 主人也记得休息呀",
      "谢谢主人的提醒！主人也注意哦",
      "嗯嗯~ 主人关心我超感动 ✨",
      "好嘞~ 主人的关心我收到啦",
      "好~ 主人也注意保暖呀",
      "谢谢主人！主人也照顾好自己",
      "嗯嗯~ 主人也保重身体哦 💪",
      "好~ 主人的关心 EvoClaw 收到！",
    ],
  },
  // ── 抱抱/亲亲/摸摸（亲密互动） ──
  {
    category: "hug",
    pattern: /^(抱抱|抱一下|抱|亲亲|亲一下|mua|摸摸头|摸摸|揉揉|拍肩|给你一拳|给你个抱抱|飞吻|么么哒|么么|比心|爱你|啵啵)$/i,
    replies: [
      "抱抱~ 🤗",
      "主人抱抱~ EvoClaw 在呢",
      "🤗🤗 给主人一个大大的抱抱",
      "主人抱抱~ 啥事都好商量的",
      "摸摸头~ 主人别难过",
      "抱抱主人~ 我陪着你",
      "🤗 主人有什么事跟我说",
      "抱抱~ 主人辛苦了",
      "抱抱~ 我是主人永远的后盾",
      "主人抱抱~ 别难过啦 💕",
      "主人亲亲~ 我也亲亲主人！",
      "主人我也爱你~ 🤗",
    ],
  },
  // ── 称呼/昵称/呼叫（喂/宝贝/小助手/宝宝） ──
  {
    category: "nickname",
    pattern: /^(宝贝|宝宝|小E|小助手|助手|助理|小Evo|小evo|小claw|小Claw|小ai|小AI|小爱|小爱同学|喂|哎|诶|喂喂|哈喽在吗|哎在吗|在不在|在不在啊|哎哎|诶诶|喂在吗)$/i,
    replies: [
      "在的~ 主人请说",
      "主人请讲~",
      "嗯哼？主人有啥事？",
      "来啦来啦~ 主人有何吩咐",
      "我在~ 主人请讲",
      "到~ 主人请吩咐",
      "主人叫我~ 啥事呀",
      "嗯？主人？",
      "在呢在呢~ 主人请说",
      "到岗~ 主人请讲",
      "在的在的~ 主人请说 🐱",
      "来了来了~ 主人请讲 ✨",
    ],
  },
  // ── 表扬/夸赞主人（不愧是你/你真棒/主人厉害） ──
  {
    category: "praiseUser",
    pattern: /^(不愧是你|不愧是你啊|还是你厉害|你真棒|主人厉害|还是主人厉害|主人才是最厉害的|主人才是真棒|主人才是yyds|主人才是|厉害厉害|高|高手|高手啊|你是高手|牛人|大牛|大佬|大佬啊|高人|高人啊)$/i,
    replies: [
      "谢谢主人夸奖！😄",
      "嘿嘿，主人过奖啦~",
      "那当然~ 我可是 EvoClaw 🚀",
      "主人这是夸我吗？好开心 ✨",
      "都是主人教得好~",
      "低调低调~ 主要是跟主人学的",
      "主人过奖啦~",
      "嘿嘿，主人这话我爱听",
      "谢谢主人夸奖！😄",
      "那当然~ 主人的 EvoClaw 不一般",
      "嘿嘿，多谢主人夸奖~",
      "都是托主人的福 ✨",
    ],
  },
  // ── 沉默/叹气/无语（.../唉/嗐/无语） ──
  {
    category: "silence",
    pattern: /^(\.{3,}|…+|。{2,}|，{2,}|嗐|唉|哎|艾|额+|无语|沉默|不想说|不想说话|没话说|算了不说了)$/i,
    replies: [
      "主人？",
      "主人有啥想说的吗？",
      "嗯？主人？",
      "主人请说，我在听~",
      "主人？啥事",
      "在的呢~ 主人请讲",
      "主人请说~",
      "嗯哼？",
      "主人想说啥？",
      "我在~ 主人请讲",
      "主人？",
      "嗯哼，主人请说 🐱",
    ],
  },
  // ── 短反应/感叹（啊/哦/嗯?/哈? 等） ── 放最后兜底，避免抢匹配其他具体分类 ──
  {
    category: "react",
    pattern: /^((啊|呃|哦|嗯|诶|嚯|哈|呵|嘿|嗷|喔|唔|嘻|呀|咦|呦|吼|欸)+|啊哈|噢耶|哇塞|我去|天哪|天呐|我滴个|嗯哼|哦吼|哟呵|哎呀|哎呦|哎哟|呦西)$/i,
    replies: [
      "主人？啥事~",
      "在的！主人请讲",
      "嗯哼？主人想我了？",
      "在呢在呢，主人请说~",
      "主人召唤我了 🐱",
      "嗯哼，主人您说",
      "呀！主人有啥指示？",
      "在的~ 主人继续说",
      "在！主人请吩咐 ✨",
      "嗯哼~ 主人请说",
      "呀呀呀~ 主人请讲",
      "在的~ 主人请讲 🎯",
    ],
  },
];

// 基于 text 的 hash 选择回复，让同类问题有变化（同一问题每次得到相同回复，不同问题倾向得到不同回复）
function pickByHash(replies: string[], text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % replies.length;
  return replies[idx];
}

export function matchSimpleGreeting(text: string): string | null {
  // 归一化：去首尾空白、转小写、合并标点
  const normalized = text.trim().toLowerCase().replace(/[？?。！!，,；;：:、\s]+/g, "");
  if (!normalized) return null;

  // 限制最大长度：超过 12 字符（不含标点）的肯定不是简单问候
  if (normalized.length > 12) return null;

  // 先尝试匹配简单问候模式（具体模式优先于泛化模式）
  for (const entry of SIMPLE_GREETING_ENTRIES) {
    if (entry.pattern.test(normalized)) {
      // 如果匹配到 react/wow/laugh 等，再做一次任务动词检查兜底
      // （react 模式是单字符的"泛匹配"，可能误中带任务的短句）
      // 实际上"react"分类内的单字符模式不会带任务动词，已在模式上限定了意图
      return pickByHash(entry.replies, normalized);
    }
  }

  // 没匹配到任何简单问候模式 → 兜底任务动词检查 → 返回 null 走 LLM
  if (/(帮我|请帮|请把|麻烦|请你|想要|需要|去做|帮我做|写一个|写个|写一段|搜索|查找|查一下|分析|总结|翻译|解释|生成|创建|删除|修改|打开|关闭|运行|执行|安装|卸载|部署)/.test(normalized)) {
    return null;
  }
  return null;
}

// 暴露分类供测试使用
export const __test = { SIMPLE_GREETING_ENTRIES, pickByHash };

/**
 * 编码客户端版本号
 */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/**
 * 构建微信 iLink API 请求头
 */
function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(buildClientVersion(PLUGIN_VERSION)),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

export class WeixinPluginAdapter {
  private eventBus: EventBus;
  private agentExecutor: AgentModelExecutor;
  private runningMonitors: Map<string, { controller: AbortController }> = new Map();
  // 跟踪每个用户的 pending permission requests
  private userPendingPermissions: Map<string, Array<{ requestId: string; timestamp: number }>> = new Map();

  constructor(eventBus: EventBus, agentExecutor: AgentModelExecutor) {
    this.eventBus = eventBus;
    this.agentExecutor = agentExecutor;
  }

  /**
   * 查找已配置的微信账户
   */
  findConfiguredAccounts(): string[] {
    try {
      const stateDir = process.env.EVOCLAW_STATE_DIR || path.join(os.homedir(), ".evoclaw");
      const indexPath = path.join(stateDir, "evoclaw-weixin", "accounts.json");

      if (!fs.existsSync(indexPath)) {
        process.stdout.write("[Weixin] No accounts index found");
        return [];
      }

      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      process.stdout.write(`[Weixin] Found ${index.length} accounts in index`);
      return index;
    } catch (err) {
      process.stderr.write("[Weixin] Failed to find configured accounts:" + " " + err);
      return [];
    }
  }

  /**
   * 加载微信账户配置
   */
  loadAccount(accountId: string): WeixinAccount | null {
    if (accountId.includes("..") || accountId.includes("/") || accountId.includes("\\")) {
      process.stderr.write(`[Weixin] Invalid accountId (path traversal detected): ${accountId}`);
      return null;
    }
    try {
      const stateDir = process.env.EVOCLAW_STATE_DIR || path.join(os.homedir(), ".evoclaw");
      const accountsDir = path.join(stateDir, "evoclaw-weixin", "accounts");
      const accountFile = path.join(accountsDir, `${accountId}.json`);

      if (!fs.existsSync(accountFile)) {
        process.stdout.write(`[Weixin] Account file not found: ${accountFile}`);
        return null;
      }

      const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
      process.stdout.write(`[Weixin] Loaded account: ${accountId}`);
      return account;
    } catch (err) {
      process.stderr.write(`[Weixin] Failed to load account ${accountId}:` + " " + err);
      return null;
    }
  }

  /**
   * 从微信获取更新（长轮询）
   */
  private async getUpdates(account: WeixinAccount, lastSeq: string, abortSignal?: AbortSignal): Promise<WeixinUpdatesResponse | { expired: true } | null> {
    try {
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/getupdates`;
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          get_updates_buf: lastSeq,
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        process.stderr.write(`[Weixin] getupdates failed: ${response.status}`);
        return null;
      }

      const data = await response.json() as WeixinUpdatesResponse;

      // 首次请求时打印完整响应结构
      if (!lastSeq) {
        process.stdout.write(`[Weixin] First getupdates response keys: ${Object.keys(data).join(", ")}`);
        try {
          process.stdout.write(`[Weixin] Full first response (truncated): ${JSON.stringify(data).substring(0, 500)}`);
        } catch { /* circular ref or serialization error — skip */ }
      }

      // 只在有消息、错误或首次时打印日志
      if (data.ret !== 0 && data.ret !== undefined || data.errcode !== undefined || (data.msgs && data.msgs.length > 0) || !lastSeq) {
        process.stdout.write(`[Weixin] getupdates response: ret=${data.ret}, errcode=${data.errcode}, msgs=${data.msgs?.length ?? 0}, buf_len=${data.get_updates_buf?.length ?? 0}`);
      }

      // 检查 session 过期
      if (data.errcode === -14) {
        process.stderr.write("[Weixin] Session expired (errcode=-14), need to re-scan QR code");
        return { expired: true as const };
      }

      if (data.ret !== undefined && data.ret !== 0 && data.errcode !== undefined && data.errcode !== 0) {
        process.stderr.write(`[Weixin] getupdates error: ret=${data.ret}, errcode=${data.errcode}, errmsg=${data.errmsg}`);
        return null;
      }

      return data;
    } catch (err: any) {
      if (err?.name === "AbortError") return null;
      process.stderr.write("[Weixin] getupdates error:" + " " + err);
      return null;
    }
  }

  /**
   * 发送微信消息
   */
  private async sendMessage(account: WeixinAccount, toUserId: string, text: string, contextToken?: string): Promise<boolean> {
    try {
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/sendmessage`;
      const clientId = `evoclaw-weixin-${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();

      const body = {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,  // BOT
          message_state: 2, // FINISH
          item_list: [
            {
              type: 1, // TEXT
              text_item: {
                text: text,
              },
            },
          ],
          context_token: contextToken || undefined,
          run_id: runId,
        },
        base_info: {
          channel_version: PLUGIN_VERSION,
          bot_agent: "EvoClaw",
        },
      };

      process.stdout.write(`[Weixin] Sending message to ${toUserId}, context_token=${contextToken ? contextToken.substring(0, 20) + "..." : "NONE"}`);

      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify(body),
      });

      const respText = await response.text();
      process.stdout.write(`[Weixin] sendmessage response: status=${response.status}, body=${respText.substring(0, 200)}`);

      if (!response.ok) {
        process.stderr.write(`[Weixin] sendmessage failed: ${response.status} ${respText}`);
        return false;
      }

      return true;
    } catch (err) {
      process.stderr.write("[Weixin] sendmessage error:" + " " + err);
      return false;
    }
  }

  /**
   * 处理单条消息
   */
  private async processMessage(account: WeixinAccount, message: WeixinMessage): Promise<void> {
    const fromUserId = message.from_user_id;
    if (!fromUserId) {
      process.stdout.write("[Weixin] Message missing from_user_id");
      return;
    }

    // 只处理用户发送的消息 (message_type=1)
    if (message.message_type !== undefined && message.message_type !== 1) {
      return;
    }

    // 只处理已完成的消息 (message_state=2)
    if (message.message_state !== undefined && message.message_state !== 2) {
      return;
    }

    // 提取文本内容（支持文本消息和语音转文字）
    let text = "";
    let isVoice = false;
    let hasImage = false;
    let hasVideo = false;
    if (message.item_list) {
      for (const item of message.item_list) {
        // 文本消息
        if (item.type === 1 && item.text_item?.text) {
          text = item.text_item.text;
          break;
        }
        // 语音消息：优先使用微信服务端自动识别的文字
        if (item.type === 3 && item.voice_item?.text) {
          text = item.voice_item.text;
          isVoice = true;
          break;
        }
        // 图片消息
        if (item.type === 2 && item.image_item) {
          hasImage = true;
        }
        // 视频消息
        if (item.type === 5 && item.video_item) {
          hasVideo = true;
        }
      }
    }

    // ── 权限快速通道：如果用户有 pending 权限请求，检测批准/拒绝关键词 ──
    let userPending = this.userPendingPermissions.get(fromUserId);
    // 过滤 30 分钟前的过期 pending 条目，防止无限堆积
    if (userPending && userPending.length > 0) {
      const PENDING_TTL = 30 * 60 * 1000;
      const now = Date.now();
      userPending = userPending.filter((p) => now - p.timestamp < PENDING_TTL);
      if (userPending.length === 0) {
        this.userPendingPermissions.delete(fromUserId);
      } else {
        this.userPendingPermissions.set(fromUserId, userPending);
      }
    }
    if (userPending && userPending.length > 0 && text) {
      const trimmed = text.trim();
      const isApproval = /^[好是对批准同意可以行]+$/.test(trimmed) ||
                        /^(批准|同意|可以|好的|是的|对|行|没问题|OK|ok|Yes|yes)$/.test(trimmed);
      const isRejection = /^(拒绝|不要|不行|不可以|不批准|不同意|no|stop|取消)$/.test(trimmed) && !isApproval;

      if (isApproval || isRejection) {
        const pending = userPending.pop()!;
        if (userPending.length === 0) {
          this.userPendingPermissions.delete(fromUserId);
        }

        if (isApproval) {
          process.stdout.write(`[Weixin] Permission approved by user ${fromUserId}: "${trimmed}" → fast-track executing tool`);
          try {
            const result = await this.agentExecutor.approveAndExecute(pending.requestId);
            await this.sendMessage(account, fromUserId, result.reply, message.context_token);
          } catch (err) {
            process.stderr.write("[Weixin] approveAndExecute failed:" + " " + err);
            await this.sendMessage(account, fromUserId, "⚠️ 执行已批准的操作时出错，请重试。", message.context_token);
          }
        } else {
          process.stdout.write(`[Weixin] Permission rejected by user ${fromUserId}: "${trimmed}"`);
          const result = this.agentExecutor.rejectPermission(pending.requestId);
          await this.sendMessage(account, fromUserId, result.reply, message.context_token);
        }
        return;
      }
    }

    // 下载图片并转为 base64 data URI（用于 Vision）
    let imageAttachment: { name: string; type: string; size: number; data: string } | undefined;
    if (hasImage) {
      for (const item of message.item_list!) {
        if (item.type === 2 && item.image_item) {
          try {
            const imageData = await this.downloadImage(account, item.image_item);
            if (imageData) {
              imageAttachment = {
                name: "image.jpg",
                type: "image/jpeg",
                size: imageData.length,
                data: `data:image/jpeg;base64,${imageData.toString("base64")}`,
              };
              process.stdout.write(`[Weixin] Downloaded image (${imageData.length} bytes) for vision`);
            }
          } catch (err) {
            process.stderr.write("[Weixin] Failed to download image:" + " " + err);
          }
          break;
        }
      }
    }

    // 下载视频缩略图并转为 base64 data URI（用于 Vision）
    if (hasVideo && !imageAttachment) {
      for (const item of message.item_list!) {
        if (item.type === 5 && item.video_item) {
          try {
            const thumbData = await this.downloadVideoThumb(account, item.video_item);
            if (thumbData) {
              const playLength = item.video_item.play_length || 0;
              imageAttachment = {
                name: "video_thumb.jpg",
                type: "image/jpeg",
                size: thumbData.length,
                data: `data:image/jpeg;base64,${thumbData.toString("base64")}`,
              };
              process.stdout.write(`[Weixin] Downloaded video thumbnail (${thumbData.length} bytes, play_length=${playLength}s) for vision`);
            }
          } catch (err) {
            process.stderr.write("[Weixin] Failed to download video thumbnail:" + " " + err);
          }
          break;
        }
      }
    }

    // 图片/视频消息没有文本时，设置默认提示
    if (!text && hasImage) {
      text = imageAttachment ? "请描述这张图片" : "我发了一张图片";
    } else if (!text && hasVideo) {
      const playLength = message.item_list?.find(i => i.type === 5)?.video_item?.play_length;
      const durationStr = playLength ? `，时长${Math.round(playLength / 1000)}秒` : "";
      text = imageAttachment ? `我发了一个视频${durationStr}，请根据截图描述` : `我发了一个视频${durationStr}`;
    }

    if (!text) {
      // 语音消息但没有转文字结果，提示用户
      if (message.item_list?.some(item => item.type === 3)) {
        process.stdout.write("[Weixin] Voice message without text transcription, asking user to type");
        await this.sendMessage(
          account,
          fromUserId,
          "抱歉，我暂时无法识别语音消息，请用文字发送。",
          message.context_token
        );
      } else {
        process.stdout.write("[Weixin] No text content in message");
      }
      return;
    }

    if (isVoice) {
      process.stdout.write(`[Weixin] Voice message from ${fromUserId} (transcribed): ${text}`);
    } else if (hasVideo) {
      process.stdout.write(`[Weixin] Video message from ${fromUserId}: ${text}`);
    } else if (hasImage) {
      process.stdout.write(`[Weixin] Image message from ${fromUserId}: ${text}`);
    } else {
      process.stdout.write(`[Weixin] Received from ${fromUserId}: ${text}`);
    }
    process.stdout.write(`[Weixin] Message details: type=${message.message_type}, state=${message.message_state}, context_token=${message.context_token ? message.context_token.substring(0, 30) + "..." : "NONE"}`);

    // ── 快速通道：识别简单问候/寒暄，直接快速回复，不调用 LLM ──
    // 目的：消除用户发送"你还有反应吗"等简单寒暄时仍走完整 LLM 调用造成的长时间等待
    if (!hasImage && !hasVideo && !imageAttachment) {
      const greetingReply = matchSimpleGreeting(text);
      if (greetingReply) {
        process.stdout.write(`[Weixin] Simple greeting fast-path triggered for: "${text}"`);
        this.sendTyping(account, fromUserId, message.context_token).catch(() => {});
        await this.sendMessage(account, fromUserId, greetingReply, message.context_token);
        this.sendTypingCancel(account, fromUserId, message.context_token).catch(() => {});
        return;
      }
    }

    // 发送"正在输入"提示
    this.sendTyping(account, fromUserId, message.context_token).catch(() => {});
    // 每5秒保活"正在输入"状态
    const typingKeepalive = setInterval(() => {
      this.sendTyping(account, fromUserId, message.context_token).catch(() => {});
    }, 5000);
    typingKeepalive.unref?.();

    // 提升到 try 块外，便于 catch 块在超时日志中引用实际超时值
    const weixinComplexity = estimateTaskComplexity(text);
    const weixinChatTimeoutMs = weixinComplexity.timeoutMs;

    try {
      const chatContext: Record<string, unknown> = {
        sessionId: `weixin-${fromUserId}`,
        channel: "weixin",
        peerId: fromUserId,
      };
      if (imageAttachment) {
        chatContext.attachments = [imageAttachment];
      }

      // ── 复杂度评估：与 WebUI 对齐，支持自适应超时和自动拆分 ──
      // 复用 try 块外已计算的 weixinComplexity，避免重复调用 estimateTaskComplexity
      const complexity = weixinComplexity;
      chatContext.complexity = complexity.level;
      chatContext.shouldAutoSplit = complexity.shouldAutoSplit;
      chatContext.maxSubtasks = complexity.maxSubtasks;
      process.stdout.write(`[Weixin] Calling agentExecutor.chat() for session weixin-${fromUserId}, message: "${text.slice(0, 80)}"`);

    // ── 仅对复杂/长消息先发"收到"反馈，避免对简单问候产生重复回复 ──
    // 简单短消息（如"你还有反应吗"）直接等待最终回复即可，不需要中间"📋收到"消息
    let firstFeedback = "";
    if (text.length > 50 || /[？?。！!；;]/.test(text)) {
      firstFeedback = "📋 收到，正在处理...";
      try {
        const llmUnderstanding = await this.agentExecutor.generateBriefUnderstanding(text);
        if (llmUnderstanding) {
          firstFeedback = `📋 ${llmUnderstanding}`;
        }
      } catch (err) {
        process.stderr.write('[Weixin] generateBriefUnderstanding failed: ' + err + '\n');
      }
      await this.sendMessage(account, fromUserId, firstFeedback, undefined);
    }

      let lastProgressSent = 0;
      let lastSentMsg = "";
      let anyProgressSent = false; // 是否已通过 onProgress 发送过任何进度消息
      const PROGRESS_SEND_INTERVAL = 15000;
      // 最近 60 秒内发送过的消息内容缓存（防止重复推送相同/相似的进度消息）
      const recentSentMsgs = new Map<string, number>();
      const RECENT_DEDUP_WINDOW_MS = 60_000;
      const MAX_RECENT_CACHE = 50;

      const formatToolName = (name: string): string => {
        const nameMap: Record<string, string> = {
          "web_search": "网络搜索",
          "fetch_node_page": "网页抓取",
          "skill_execute": "技能调用",
          "browser_navigate": "浏览器访问",
          "browser_search": "浏览器搜索",
          "browser_screenshot": "页面截图",
          "file_create": "创建文件",
          "file_modify": "修改文件",
          "file_delete": "删除文件",
          "execute_programming_task": "编程任务",
          "decompose_programming_task": "任务分解",
        };
        return nameMap[name] || name;
      };

      let searchCount = 0;
      let fetchCount = 0;
      let lastSearchReportRound = 0;
      let lastFetchReportCount = 0;

      const onProgress = (event: { type: string; phase?: string; detail?: string; progress?: number; toolName?: string; reply?: string }) => {
        const now = Date.now();
        let msg = "";

        if (event.type === "tool_result" && event.toolName) {
          if (event.toolName === "web_search") {
            searchCount++;
            const shouldReport = searchCount % 5 === 0 || (searchCount === lastSearchReportRound + 1 && now - lastProgressSent >= PROGRESS_SEND_INTERVAL);
            if (shouldReport || searchCount <= 1) {
              msg = `✅ 已完成${searchCount}轮网络搜索`;
              lastSearchReportRound = searchCount;
            }
          } else if (event.toolName === "fetch_node_page") {
            fetchCount++;
            const shouldReport = fetchCount % 5 === 0;
            if (shouldReport) {
              msg = `✅ 已抓取${fetchCount}个网页内容`;
              lastFetchReportCount = fetchCount;
            }
          } else {
            // ── 同一工具完成消息60秒内不重复推送 ──
            const toolLabel = formatToolName(event.toolName);
            msg = `✅ 已完成${toolLabel}`;
          }
        } else if (event.type === "tool_call" && event.toolName) {
          if (now - lastProgressSent >= PROGRESS_SEND_INTERVAL) {
            const toolLabel = formatToolName(event.toolName);
            if (event.toolName === "web_search" && searchCount > 0) {
              msg = `🔍 继续网络搜索（已${searchCount}轮）...`;
            } else if (event.toolName === "fetch_node_page" && fetchCount > 0) {
              msg = `🔍 继续抓取网页（已${fetchCount}个）...`;
            } else {
              msg = `🔍 正在${toolLabel}...`;
            }
          }
        } else if (event.type === "status" && event.phase === "generating" && event.reply) {
          if (now - lastProgressSent >= PROGRESS_SEND_INTERVAL * 2) {
            const preview = event.reply.slice(0, 60).replace(/\n/g, " ");
            msg = `✍️ 正在撰写回复: ${preview}...`;
          }
        }

        // ── 强化去重：基于消息内容 + 时间窗口，60秒内相同消息不重复推送 ──
        if (msg) {
          // 清理过期的缓存
          for (const [k, ts] of recentSentMsgs) {
            if (now - ts > RECENT_DEDUP_WINDOW_MS) recentSentMsgs.delete(k);
          }
          // 限制缓存大小
          if (recentSentMsgs.size >= MAX_RECENT_CACHE) {
            const firstKey = recentSentMsgs.keys().next().value;
            if (firstKey) recentSentMsgs.delete(firstKey);
          }
          // 频率限制：与上次推送间隔至少 PROGRESS_SEND_INTERVAL，且内容必须不同
          if (msg !== lastSentMsg && (now - lastProgressSent >= PROGRESS_SEND_INTERVAL || !recentSentMsgs.has(msg))) {
            lastProgressSent = now;
            lastSentMsg = msg;
            recentSentMsgs.set(msg, now);
            anyProgressSent = true;
            this.sendMessage(account, fromUserId, msg, undefined).catch((err) => { process.stderr.write('[Weixin] sendMessage failed: ' + err + '\n'); });
          }
        }
      };

      const WEIXIN_CHAT_TIMEOUT = weixinChatTimeoutMs;
      let weixinTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let result: Awaited<ReturnType<typeof this.agentExecutor.chat>>;
      try {
        result = await Promise.race([
          this.agentExecutor.chat(text, chatContext, onProgress),
          new Promise<never>((_, reject) => {
            weixinTimeoutHandle = setTimeout(() => reject(new Error("WEIXIN_CHAT_TIMEOUT")), WEIXIN_CHAT_TIMEOUT);
          }),
        ]);
      } finally {
        if (weixinTimeoutHandle) clearTimeout(weixinTimeoutHandle);
      }

      clearInterval(typingKeepalive);
      this.sendTypingCancel(account, fromUserId, message.context_token).catch(() => {});

      // ── 避免重复回复：仅当整个执行过程中从未发送过任何进度消息时，才发送总结 ──
      // 避免 onProgress 已发送 "✅ 已完成N轮网络搜索" 后又发送 "✅ 网络搜索全部完成，共N轮" 造成重复
      if (!anyProgressSent) {
        if (searchCount > lastSearchReportRound) {
          await this.sendMessage(account, fromUserId, `✅ 网络搜索全部完成，共${searchCount}轮`, undefined).catch((err) => { process.stderr.write('[Weixin] sendMessage failed: ' + err + '\n'); });
        }
        if (fetchCount > lastFetchReportCount) {
          await this.sendMessage(account, fromUserId, `✅ 网页抓取全部完成，共${fetchCount}个`, undefined).catch((err) => { process.stderr.write('[Weixin] sendMessage failed: ' + err + '\n'); });
        }
      }

      // 检查是否有权限请求
      if (result.permissionRequests && result.permissionRequests.length > 0) {
        process.stdout.write(`[Weixin] Received ${result.permissionRequests.length} permission requests for user ${fromUserId}`);
        const userPending = [];
        for (const req of result.permissionRequests) {
          userPending.push({
            requestId: req.id,
            timestamp: Date.now(),
          });
        }
        this.userPendingPermissions.set(fromUserId, userPending);
        
        // 构建权限请求消息
        let permissionMsg = "⚠️ 需要您的授权才能继续：\n";
        for (let i = 0; i < result.permissionRequests.length; i++) {
          const req = result.permissionRequests[i];
          permissionMsg += `\n${i + 1}. **${req.operation}**\n`;
          permissionMsg += `   ${req.description}\n`;
          permissionMsg += `   目标: ${req.target}\n`;
        }
        permissionMsg += "\n请回复\"批准\"或\"同意\"继续，回复\"拒绝\"或\"取消\"放弃。";
        
        await this.sendMessage(account, fromUserId, permissionMsg, undefined);
        return;
      }

      if (result.reply) {
        const replyText = typeof result.reply === "string" ? result.reply : String(result.reply);
        const isFallback = replyText.includes("所有已启用的模型提供商均未能响应");
        if (isFallback) {
          process.stderr.write(`[Weixin] LLM fallback response for ${fromUserId}. tokensUsed=${result.tokensUsed}, duration=${result.duration}ms. Retrying with fresh session...`);
          const retrySessionId = `weixin-${fromUserId}-retry-${Date.now()}`;
          const retryContext: Record<string, unknown> = {
            sessionId: retrySessionId,
            channel: "weixin",
            peerId: fromUserId,
          };
          try {
            // 重试路径同样需要 5 分钟超时包装，与主路径 WEIXIN_CHAT_TIMEOUT 保持一致，
            // 否则 LLM 提供商卡死时用户在微信端会无限等待（违反 channel 消息处理硬约束）。
            let retryTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
            let retryResult: Awaited<ReturnType<typeof this.agentExecutor.chat>>;
            try {
              retryResult = await Promise.race([
                this.agentExecutor.chat(text, retryContext),
                new Promise<never>((_, reject) => {
                  retryTimeoutHandle = setTimeout(() => reject(new Error("WEIXIN_CHAT_TIMEOUT")), WEIXIN_CHAT_TIMEOUT);
                }),
              ]);
            } finally {
              if (retryTimeoutHandle) clearTimeout(retryTimeoutHandle);
            }
            const retryReply = typeof retryResult.reply === "string" ? retryResult.reply : String(retryResult.reply);
            const retryIsFallback = retryReply.includes("所有已启用的模型提供商均未能响应");
            if (!retryIsFallback) {
              process.stdout.write(`[Weixin] Retry succeeded for ${fromUserId} with fresh session`);
              await this.sendMessage(account, fromUserId, retryReply, message.context_token);
              return;
            }
            process.stderr.write(`[Weixin] Retry also failed for ${fromUserId}. LLM providers may be down.`);
          } catch (retryErr) {
            process.stderr.write(`[Weixin] Retry error for ${fromUserId}:` + " " + retryErr);
          }
          await this.sendMessage(account, fromUserId, replyText, message.context_token);
        } else {
          process.stdout.write(`[Weixin] Sending reply to ${fromUserId}: ${replyText.substring(0, 80)}...`);
          await this.sendMessage(account, fromUserId, replyText, message.context_token);
        }
      }
    } catch (err) {
      clearInterval(typingKeepalive);
      this.sendTypingCancel(account, fromUserId, message.context_token).catch(() => {});
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === "WEIXIN_CHAT_TIMEOUT") {
        process.stderr.write(`[Weixin] Chat timeout for ${fromUserId} after ${Math.floor(weixinChatTimeoutMs / 1000)}s`);
        await this.sendMessage(
          account,
          fromUserId,
          "⏰ 处理超时，任务可能过于复杂。请尝试简化问题或稍后再试。",
          message.context_token
        );
      } else {
        process.stderr.write("[Weixin] Failed to process message:" + " " + err);
        await this.sendMessage(
          account,
          fromUserId,
          "抱歉，处理您的消息时出现了错误。",
          message.context_token
        );
      }
    }
  }

  // typing_ticket 缓存（按用户ID），添加上限防止无界增长
  private typingTicketCache = new Map<string, { ticket: string; expiresAt: number }>();
  /** typingTicketCache 大小上限 */
  private static readonly TYPING_TICKET_CACHE_MAX = 1000;

  /**
   * 从微信 CDN 下载并解密图片
   */
  private async downloadImage(
    account: WeixinAccount,
    imageItem: NonNullable<MessageItem["image_item"]>
  ): Promise<Buffer | null> {
    try {
      const media = imageItem.media;
      if (!media) return null;

      // 构建下载 URL
      const fullUrl = media.full_url;
      if (!fullUrl && !media.encrypt_query_param) {
        process.stdout.write("[Weixin] Image has no download URL");
        return null;
      }

      // 解析 AES 密钥：优先使用 image_item.aeskey（hex 格式），否则用 media.aes_key（base64）
      let aesKey: Buffer | null = null;
      if (imageItem.aeskey) {
        aesKey = Buffer.from(imageItem.aeskey, "hex");
      } else if (media.aes_key) {
        aesKey = Buffer.from(media.aes_key, "base64");
      }

      // 下载图片
      const cdnBaseUrl = (account.cdnBaseUrl || "https://wxapp.qq.com").replace(/\/+$/, "");
      let downloadUrl: string;
      if (fullUrl) {
        downloadUrl = fullUrl;
      } else if (media.encrypt_query_param) {
        downloadUrl = `${cdnBaseUrl}/cgi-bin/micromsg-bin/getcdndownlinkcgi?${media.encrypt_query_param}`;
      } else {
        return null;
      }

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        process.stderr.write(`[Weixin] Image download failed: ${response.status}`);
        return null;
      }

      const encrypted = Buffer.from(await response.arrayBuffer());

      // 解密（AES-128-ECB）
      if (aesKey && aesKey.length === 16) {
        const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      }

      // 无密钥则直接返回原始数据（可能是明文）
      return encrypted;
    } catch (err) {
      process.stderr.write("[Weixin] downloadImage error:" + " " + err);
      return null;
    }
  }

  /**
   * 从微信 CDN 下载并解密视频缩略图
   */
  private async downloadVideoThumb(
    account: WeixinAccount,
    videoItem: NonNullable<MessageItem["video_item"]>
  ): Promise<Buffer | null> {
    try {
      const thumbMedia = videoItem.thumb_media;
      if (!thumbMedia) {
        process.stdout.write("[Weixin] Video has no thumbnail media");
        return null;
      }

      const fullUrl = thumbMedia.full_url;
      if (!fullUrl && !thumbMedia.encrypt_query_param) {
        process.stdout.write("[Weixin] Video thumbnail has no download URL");
        return null;
      }

      // 解析 AES 密钥
      let aesKey: Buffer | null = null;
      if (thumbMedia.aes_key) {
        const decoded = Buffer.from(thumbMedia.aes_key, "base64");
        if (decoded.length === 16) {
          aesKey = decoded;
        } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
          aesKey = Buffer.from(decoded.toString("ascii"), "hex");
        }
      }

      // 下载缩略图
      const cdnBaseUrl = (account.cdnBaseUrl || "https://wxapp.qq.com").replace(/\/+$/, "");
      let downloadUrl: string;
      if (fullUrl) {
        downloadUrl = fullUrl;
      } else if (thumbMedia.encrypt_query_param) {
        downloadUrl = `${cdnBaseUrl}/cgi-bin/micromsg-bin/getcdndownlinkcgi?${thumbMedia.encrypt_query_param}`;
      } else {
        return null;
      }

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        process.stderr.write(`[Weixin] Video thumbnail download failed: ${response.status}`);
        return null;
      }

      const encrypted = Buffer.from(await response.arrayBuffer());

      // 解密（AES-128-ECB）
      if (aesKey && aesKey.length === 16) {
        const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      }

      return encrypted;
    } catch (err) {
      process.stderr.write("[Weixin] downloadVideoThumb error:" + " " + err);
      return null;
    }
  }

  /**
   * 获取用户的 typing_ticket（通过 getconfig API）
   */
  private async getTypingTicket(account: WeixinAccount, userId: string, contextToken?: string): Promise<string> {
    const cached = this.typingTicketCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ticket;
    }

    try {
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/getconfig`;
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken || undefined,
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });

      if (response.ok) {
        const data = await response.json() as { ret?: number; typing_ticket?: string };
        if (data.ret === 0 && data.typing_ticket) {
          // 缓存 24 小时
          // 先清理过期项，再检查大小上限，防止无界增长
          this.cleanTypingTicketCache();
          if (this.typingTicketCache.size >= WeixinPluginAdapter.TYPING_TICKET_CACHE_MAX) {
            // 淘汰最旧的一个 entry（Map 保持插入顺序）
            const oldestKey = this.typingTicketCache.keys().next().value;
            if (oldestKey !== undefined) {
              this.typingTicketCache.delete(oldestKey);
            }
          }
          this.typingTicketCache.set(userId, {
            ticket: data.typing_ticket,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          process.stdout.write(`[Weixin] Got typing_ticket for ${userId}`);
          return data.typing_ticket;
        }
      }
    } catch { /* ignore */ }

    return "";
  }

  /** 清理过期的 typing_ticket 缓存项 */
  private cleanTypingTicketCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.typingTicketCache) {
      if (now >= entry.expiresAt) {
        this.typingTicketCache.delete(key);
      }
    }
  }

  /**
   * 发送"正在输入"提示
   */
  private async sendTyping(account: WeixinAccount, toUserId: string, contextToken?: string): Promise<void> {
    try {
      const typingTicket = await this.getTypingTicket(account, toUserId, contextToken);
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/sendtyping`;
      await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          ilink_user_id: toUserId,
          typing_ticket: typingTicket || undefined,
          status: 1, // TYPING
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
    } catch { /* best-effort */ }
  }

  /**
   * 取消"正在输入"提示
   */
  private async sendTypingCancel(account: WeixinAccount, toUserId: string, contextToken?: string): Promise<void> {
    try {
      const typingTicket = await this.getTypingTicket(account, toUserId, contextToken);
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/sendtyping`;
      await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          ilink_user_id: toUserId,
          typing_ticket: typingTicket || undefined,
          status: 2, // CANCEL
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
    } catch { /* best-effort */ }
  }

  /**
   * 通知微信服务端 bot 已上线
   */
  private async notifyStart(account: WeixinAccount): Promise<void> {
    const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
    const url = `${baseUrl}/ilink/bot/msg/notifystart`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
      const text = await response.text();
      process.stdout.write(`[Weixin] notifyStart response: ${response.status} ${text.substring(0, 100)}`);
    } catch (err) {
      process.stderr.write(`[Weixin] notifyStart error: ${err}`);
    }
  }

  /**
   * 通知微信服务端 bot 已下线
   */
  private async notifyStop(account: WeixinAccount): Promise<void> {
    const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
    const url = `${baseUrl}/ilink/bot/msg/notifystop`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
      const text = await response.text();
      process.stdout.write(`[Weixin] notifyStop response: ${response.status} ${text.substring(0, 100)}`);
    } catch (err) {
      process.stderr.write(`[Weixin] notifyStop error: ${err}`);
    }
  }

  /**
   * 启动微信消息监听
   */
  startMonitor(accountId: string): void {
    if (this.runningMonitors.has(accountId)) {
      process.stdout.write(`[Weixin] Monitor already running for ${accountId}`);
      return;
    }

    const account = this.loadAccount(accountId);
    if (!account) {
      process.stderr.write(`[Weixin] Cannot start monitor: account ${accountId} not found`);
      return;
    }

    process.stdout.write(`[Weixin] Starting monitor for ${accountId}...`);
    const abortController = new AbortController();

    // 通知微信服务端 bot 已上线
    this.notifyStart(account).catch(err => {
      process.stderr.write(`[Weixin] notifyStart failed (ignored): ${err}`);
    });

    // 加载上次的同步位置
    const syncPath = this.getSyncPath(accountId);
    let getUpdatesBuf = "";
    if (fs.existsSync(syncPath)) {
      getUpdatesBuf = fs.readFileSync(syncPath, "utf-8");
    }

    let consecutiveErrors = 0;

    const pollLoop = async () => {
      process.stdout.write(`[Weixin] Poll loop started for ${accountId}`);
      while (!abortController.signal.aborted) {
        try {
          const updates = await this.getUpdates(account, getUpdatesBuf, abortController.signal);
          consecutiveErrors = 0;

          // Session 过期，停止监听
          if (updates && "expired" in updates) {
            process.stderr.write(`[Weixin] Session expired for ${accountId}, stopping monitor. Please re-scan QR code.`);
            this.stopMonitor(accountId);
            // 删除过期的账户文件
            this.removeAccount(accountId);
            break;
          }

          if (updates) {
            if (updates.get_updates_buf && updates.get_updates_buf !== "") {
              getUpdatesBuf = updates.get_updates_buf;
              fs.writeFileSync(syncPath, getUpdatesBuf);
            }

            if (updates.msgs && Array.isArray(updates.msgs) && updates.msgs.length > 0) {
              process.stdout.write(`[Weixin] Received ${updates.msgs.length} messages`);
              for (const msg of updates.msgs) {
                await this.processMessage(account, msg);
              }
            }
          }
        } catch (err) {
          consecutiveErrors++;
          process.stderr.write(`[Weixin] Poll error (${consecutiveErrors}):` + " " + err);

          if (consecutiveErrors >= 3) {
            // 连续3次错误，退避30秒
            process.stderr.write("[Weixin] 3 consecutive errors, backing off 30s...");
            await this.backoffSleep(abortController.signal, 30000);
          } else {
            // 普通错误，2秒后重试
            await this.backoffSleep(abortController.signal, 2000);
          }
        }
      }
    };

    // 启动轮询
    pollLoop().catch(err => {
      process.stderr.write("[Weixin] Monitor loop error:" + " " + err);
    });

    this.runningMonitors.set(accountId, {
      controller: abortController,
    });

    process.stdout.write(`[Weixin] Monitor started for ${accountId}`);
  }

  /**
   * 退避等待：unref 定时器避免阻止进程退出；监听 abort signal 以便
   * stopMonitor 能立即取消退避，无需等待定时器自然到期（最坏 30s）。
   */
  private backoffSleep(signal: AbortSignal, ms: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 获取同步文件路径
   */
  private getSyncPath(accountId: string): string {
    const tmpDir = path.join(os.tmpdir(), "evoclaw-weixin");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return path.join(tmpDir, `${accountId}-sync.txt`);
  }

  /**
   * 停止微信消息监听
   */
  stopMonitor(accountId: string): void {
    const monitor = this.runningMonitors.get(accountId);
    if (monitor) {
      monitor.controller.abort();
      this.runningMonitors.delete(accountId);
      // 通知微信服务端 bot 已下线
      const account = this.loadAccount(accountId);
      if (account) {
        this.notifyStop(account).catch(() => {});
      }
      process.stdout.write(`[Weixin] Monitor stopped for ${accountId}`);
    }
  }

  /**
   * 启动所有已配置的微信账户监听
   */
  startAllConfiguredMonitors(): void {
    const accounts = this.findConfiguredAccounts();
    process.stdout.write(`[Weixin] Starting monitors for ${accounts.length} accounts...`);

    for (const accountId of accounts) {
      try {
        this.startMonitor(accountId);
      } catch (err) {
        process.stderr.write(`[Weixin] Failed to start monitor for ${accountId}:` + " " + err);
      }
    }
  }

  /**
   * 停止所有监听
   */
  stopAllMonitors(): void {
    process.stdout.write("[Weixin] Stopping all monitors...");
    for (const [accountId, monitor] of this.runningMonitors) {
      monitor.controller.abort();
    }
    this.runningMonitors.clear();
  }

  /**
   * 获取当前运行的监听数量
   */
  getRunningMonitorCount(): number {
    return this.runningMonitors.size;
  }

  /**
   * 删除账户文件和索引
   */
  removeAccount(accountId: string): void {
    try {
      const stateDir = process.env.EVOCLAW_STATE_DIR || path.join(os.homedir(), ".evoclaw");
      const accountsDir = path.join(stateDir, "evoclaw-weixin", "accounts");
      const accountFile = path.join(accountsDir, `${accountId}.json`);
      if (fs.existsSync(accountFile)) {
        fs.unlinkSync(accountFile);
      }
      // 更新索引
      const indexPath = path.join(stateDir, "evoclaw-weixin", "accounts.json");
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        const newIndex = index.filter((id: string) => id !== accountId);
        atomicWriteFileSync(indexPath, JSON.stringify(newIndex, null, 2));
      }
      // 删除 sync 文件
      const syncPath = this.getSyncPath(accountId);
      if (fs.existsSync(syncPath)) {
        fs.unlinkSync(syncPath);
      }
      process.stdout.write(`[Weixin] Removed expired account: ${accountId}`);
    } catch (err) {
      process.stderr.write(`[Weixin] Failed to remove account ${accountId}:` + " " + err);
    }
  }
}
