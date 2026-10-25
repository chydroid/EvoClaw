/**
 * blueprint-catalog — 参数化自动化蓝图（对标 hermes-agent cron/blueprint_catalog.py）
 *
 * Blueprint = 一个可参数化的自动化模板，用户通过对话填充 slot 后创建为 cron job。
 * 与 suggestion 的区别：
 *   - suggestion 是预设好的固定任务（"每日简报"），一键接受
 *   - blueprint 是模板（"自定义提醒"），需要用户填 slot（时间、内容、频率）
 *
 * Slot 类型（对标 hermes BlueprintSlot）：
 *   - time      — 时间选择（HH:MM）
 *   - enum      — 枚举选择（选项列表）
 *   - text      — 自由文本
 *   - weekdays  — 星期选择（周一~周日的子集）
 *
 * 内置 15 个蓝图（对标 hermes 的 CATALOG）：
 *   morning-brief, workday-start, evening-winddown, custom-reminder,
 *   news-digest, weekly-review, bill-renewal-watch, price-watch,
 *   competitor-watch, habit-checkin, hydration-move, meal-plan,
 *   learn-daily, gratitude-journal, on-this-day
 */

// ── 类型 ──────────────────────────────────────────────

export type BlueprintSlotType = "time" | "enum" | "text" | "weekdays";

export interface BlueprintSlot {
  name: string;
  type: BlueprintSlotType;
  label: string;
  default?: string;
  options?: string[];
  optional?: boolean;
  strict?: boolean;
  help?: string;
}

export interface AutomationBlueprint {
  key: string;
  title: string;
  description: string;
  category: string;
  /** cron 表达式模板，支持 ${slot} 占位符 */
  scheduleTemplate: string;
  /** 任务提示词模板，支持 ${slot} 占位符 */
  promptTemplate: string;
  slots: BlueprintSlot[];
  /** 默认投递方式 */
  deliverDefault?: string;
  /** 关联技能名 */
  skills?: string[];
  tags?: string[];
}

/** 渲染后的蓝图填充结果 */
export interface BlueprintFillResult {
  name: string;
  cronExpression: string;
  description: string;
  handlerType: "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom" | "shell";
  handlerConfig: Record<string, unknown>;
}

/** 蓝图填充错误 */
export class BlueprintFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintFillError";
  }
}

// ── 内置蓝图目录（对标 hermes 的 15 个） ────────────

const BUILTIN_BLUEPRINTS: AutomationBlueprint[] = [
  {
    key: "morning-brief",
    title: "晨间简报",
    description: "每天早上自动汇总昨日重要动态",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "汇总昨日的重要动态、新闻和待办事项，生成简洁的晨间简报。",
    slots: [
      { name: "time", type: "time", label: "发送时间", default: "09:00", help: "格式 HH:MM" },
    ],
    deliverDefault: "notify",
    tags: ["daily", "briefing"],
  },
  {
    key: "workday-start",
    title: "工作日启动",
    description: "工作日早上提醒今日重点",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * 1-5",
    promptTemplate: "提醒用户今日重点事项和待办任务。",
    slots: [
      { name: "time", type: "time", label: "发送时间", default: "08:30" },
    ],
    deliverDefault: "notify",
    tags: ["workday", "reminder"],
  },
  {
    key: "evening-winddown",
    title: "晚间收尾",
    description: "每日晚上提醒复盘今日工作",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "提醒用户复盘今日完成的工作、未完成的任务和明日计划。",
    slots: [
      { name: "time", type: "time", label: "发送时间", default: "20:00" },
    ],
    deliverDefault: "notify",
    tags: ["daily", "review"],
  },
  {
    key: "custom-reminder",
    title: "自定义提醒",
    description: "创建任意内容的定时提醒",
    category: "custom",
    scheduleTemplate: "${time:MM} ${time:HH} * * *",
    promptTemplate: "${text:content}",
    slots: [
      { name: "time", type: "time", label: "提醒时间", default: "09:00", help: "格式 HH:MM" },
      { name: "content", type: "text", label: "提醒内容", required: true } as BlueprintSlot,
    ],
    deliverDefault: "notify",
    tags: ["custom", "reminder"],
  },
  {
    key: "news-digest",
    title: "新闻摘要",
    description: "每日聚合科技/行业新闻摘要",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "聚合今日科技和行业重要新闻，生成简洁摘要。",
    slots: [
      { name: "time", type: "time", label: "发送时间", default: "08:00" },
      {
        name: "category", type: "enum", label: "新闻类别",
        default: "tech", options: ["tech", "finance", "world", "all"],
      },
    ],
    deliverDefault: "notify",
    tags: ["daily", "news"],
  },
  {
    key: "weekly-review",
    title: "每周回顾",
    description: "每周自动回顾本周工作",
    category: "weekly",
    scheduleTemplate: "0 18 * * ${weekdays:0}",
    promptTemplate: "回顾本周完成的工作、未完成任务和重要决策，生成周报。",
    slots: [
      {
        name: "weekdays", type: "weekdays", label: "回顾日",
        default: "0", help: "0=周日, 1=周一, ..., 6=周六",
      },
    ],
    deliverDefault: "notify",
    tags: ["weekly", "review"],
  },
  {
    key: "bill-renewal-watch",
    title: "账单续费监控",
    description: "监控订阅/账单的续费日期",
    category: "finance",
    scheduleTemplate: "0 9 * * *",
    promptTemplate: "检查即将到期的订阅和账单，提醒用户续费。",
    slots: [],
    deliverDefault: "notify",
    tags: ["finance", "monitor"],
  },
  {
    key: "price-watch",
    title: "价格监控",
    description: "监控产品价格变动",
    category: "shopping",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "检查产品 ${text:product} 的价格变动，如有降价则提醒用户。",
    slots: [
      { name: "time", type: "time", label: "检查时间", default: "10:00" },
      { name: "product", type: "text", label: "产品名称", required: true } as BlueprintSlot,
    ],
    deliverDefault: "notify",
    tags: ["shopping", "monitor"],
  },
  {
    key: "habit-checkin",
    title: "习惯打卡",
    description: "每日习惯养成提醒",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "提醒用户完成今日习惯打卡：${text:habit}。",
    slots: [
      { name: "time", type: "time", label: "打卡时间", default: "21:00" },
      { name: "habit", type: "text", label: "习惯名称", required: true } as BlueprintSlot,
    ],
    deliverDefault: "notify",
    tags: ["daily", "habit"],
  },
  {
    key: "hydration-move",
    title: "喝水/运动提醒",
    description: "定时提醒喝水或运动",
    category: "health",
    scheduleTemplate: "0 * * * *",
    promptTemplate: "提醒用户：${enum:action}。",
    slots: [
      {
        name: "action", type: "enum", label: "提醒类型",
        default: "drink water", options: ["drink water", "take a walk", "stretch", "rest eyes"],
      },
    ],
    deliverDefault: "notify",
    tags: ["health", "reminder"],
  },
  {
    key: "meal-plan",
    title: "餐食规划",
    description: "每日餐食建议",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "根据用户饮食偏好生成今日餐食建议。",
    slots: [
      { name: "time", type: "time", label: "发送时间", default: "11:00" },
    ],
    deliverDefault: "notify",
    tags: ["daily", "food"],
  },
  {
    key: "learn-daily",
    title: "每日学习",
    description: "每日推送一个知识点",
    category: "learning",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "推送一个关于 ${text:topic} 的知识点或学习卡片。",
    slots: [
      { name: "time", type: "time", label: "推送时间", default: "14:00" },
      { name: "topic", type: "text", label: "学习主题", default: "general" },
    ],
    deliverDefault: "notify",
    tags: ["learning", "daily"],
  },
  {
    key: "gratitude-journal",
    title: "感恩日记",
    description: "每晚提醒记录感恩事项",
    category: "daily",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "提醒用户记录今日感恩的三件事。",
    slots: [
      { name: "time", type: "time", label: "提醒时间", default: "21:30" },
    ],
    deliverDefault: "notify",
    tags: ["daily", "journal"],
  },
  {
    key: "on-this-day",
    title: "历史上的今天",
    description: "每日推送历史上的今天发生的事件",
    category: "daily",
    scheduleTemplate: "0 9 * * *",
    promptTemplate: "搜索历史上的今天发生的重要事件，生成简短摘要。",
    slots: [],
    deliverDefault: "notify",
    tags: ["daily", "history"],
  },
  {
    key: "competitor-watch",
    title: "竞品监控",
    description: "定期监控竞品动态",
    category: "business",
    scheduleTemplate: "0 ${time:HH:MM} * * ${weekdays:1-5}",
    promptTemplate: "检查竞品 ${text:competitor} 的最新动态和公告。",
    slots: [
      { name: "time", type: "time", label: "检查时间", default: "09:00" },
      { name: "competitor", type: "text", label: "竞品名称", required: true } as BlueprintSlot,
    ],
    deliverDefault: "notify",
    tags: ["business", "monitor"],
  },
];

// ── 蓝图操作 ──────────────────────────────────────────

/** 获取内置蓝图目录 */
export function listBlueprints(): AutomationBlueprint[] {
  return [...BUILTIN_BLUEPRINTS];
}

/** 按 key 获取蓝图 */
export function getBlueprint(key: string): AutomationBlueprint | undefined {
  return BUILTIN_BLUEPRINTS.find((b) => b.key === key);
}

/** 从 scheduleTemplate 和 slots 解析 cron 表达式 */
function resolveScheduleTemplate(template: string, values: Record<string, string>): string {
  // 替换 ${slot:type} 占位符
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    // 匹配 ${slotName:type} 或 ${slotName}
    result = result.replace(new RegExp(`\\$\\{${key}(?::[^}]+)?\\}`, "g"), value);
  }
  return result;
}

/** 从 promptTemplate 和 slots 解析提示词 */
function resolvePromptTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\$\\{${key}(?::[^}]+)?\\}`, "g"), value);
  }
  return result;
}

/** 星期名称映射 */
const WEEKDAY_MAP: Record<string, string> = {
  "0": "0", // 周日
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6",
  "sun": "0", "mon": "1", "tue": "2", "wed": "3", "thu": "4", "fri": "5", "sat": "6",
  "周日": "0", "周一": "1", "周二": "2", "周三": "3", "周四": "4", "周五": "5", "周六": "6",
};

/**
 * 填充蓝图——将 slot 值填入模板，生成 cron job 配置。
 *
 * @param blueprint 蓝图对象
 * @param values  slot 值映射
 * @returns 填充后的任务配置
 * @throws BlueprintFillError 当必填 slot 缺失或值无效时
 */
export function fillBlueprint(
  blueprint: AutomationBlueprint,
  values: Record<string, string>,
): BlueprintFillResult {
  // 验证必填 slot
  for (const slot of blueprint.slots) {
    if (!slot.optional && !slot.default && !values[slot.name]) {
      throw new BlueprintFillError(`缺少必填 slot: "${slot.label}" (${slot.name})`);
    }
  }

  // 合并默认值和用户值
  const merged: Record<string, string> = {};
  for (const slot of blueprint.slots) {
    const val = values[slot.name] ?? slot.default ?? "";
    merged[slot.name] = val;
  }

  // 验证枚举值
  for (const slot of blueprint.slots) {
    if (slot.type === "enum" && slot.options && merged[slot.name]) {
      if (!slot.options.includes(merged[slot.name])) {
        throw new BlueprintFillError(
          `slot "${slot.label}" 的值 "${merged[slot.name]}" 不在选项列表中: ${slot.options.join(", ")}`,
        );
      }
    }
  }

  // 解析星期值
  for (const slot of blueprint.slots) {
    if (slot.type === "weekdays" && merged[slot.name]) {
      const mapped = merged[slot.name].split(",").map((d) => WEEKDAY_MAP[d.trim().toLowerCase()] ?? d.trim()).join(",");
      merged[slot.name] = mapped;
    }
  }

  // 解析时间值（HH:MM → HH MM 用于 cron）
  for (const slot of blueprint.slots) {
    if (slot.type === "time" && merged[slot.name]) {
      const parts = merged[slot.name].split(":");
      if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1])) {
        throw new BlueprintFillError(`slot "${slot.label}" 的时间格式无效: "${merged[slot.name]}"（应为 HH:MM）`);
      }
      // 在 scheduleTemplate 中，time slot 占位符期望的是 "HH MM" 格式
      // 但我们的模板用的是 ${time:HH:MM}，所以直接传递原始值
      // cron 表达式中 "0 9 * * *" 表示 9:00
      // 模板 "0 ${time:HH:MM} * * *" → "0 09:00 * * *" 是无效的
      // 需要特殊处理：time slot 在 scheduleTemplate 中应该展开为 "HH MM"
    }
  }

  // 特殊处理 time slot：在 scheduleTemplate 中替换为 "HH MM"
  const scheduleValues: Record<string, string> = { ...merged };
  for (const slot of blueprint.slots) {
    if (slot.type === "time" && scheduleValues[slot.name]) {
      const parts = scheduleValues[slot.name].split(":");
      scheduleValues[slot.name] = `${parts[0]} ${parts[1]}`;
    }
  }

  const cronExpression = resolveScheduleTemplate(blueprint.scheduleTemplate, scheduleValues);
  const prompt = resolvePromptTemplate(blueprint.promptTemplate, merged);

  return {
    name: blueprint.title,
    cronExpression,
    description: blueprint.description,
    handlerType: "custom",
    handlerConfig: { prompt },
  };
}

/** 生成蓝图表单 schema（供 UI 渲染） */
export function blueprintFormSchema(blueprint: AutomationBlueprint): Array<{
  slot: string;
  label: string;
  type: BlueprintSlotType;
  default?: string;
  options?: string[];
  required: boolean;
  help?: string;
}> {
  return blueprint.slots.map((s) => ({
    slot: s.name,
    label: s.label,
    type: s.type,
    default: s.default,
    options: s.options,
    required: !s.optional && !s.default,
    help: s.help,
  }));
}

/** 蓝图 deep link 格式：blueprint://<key>?slot=value&... */
export function blueprintDeepLink(key: string, values?: Record<string, string>): string {
  let link = `blueprint://${key}`;
  if (values) {
    const params = Object.entries(values)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    if (params.length > 0) link += `?${params.join("&")}`;
  }
  return link;
}
