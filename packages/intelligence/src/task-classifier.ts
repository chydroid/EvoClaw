import { ServiceRegistry, EventBus } from "@evoclaw/core";

export type TaskCategory =
  | "code_generation"
  | "file_operation"
  | "web_search"
  | "browser_automation"
  | "email_handling"
  | "data_analysis"
  | "system_operation"
  | "question_answering"
  | "skill_execution"
  | "report_generation"
  | "analysis_report";  // 新增：分析报告类

export type ComplexityLevel = "simple" | "medium" | "complex";

export interface ExtractedEntity {
  type: "file_path" | "url" | "email" | "language" | "framework" | "tool_name" | "folder_name" | "domain" | "number" | "date" | "person" | "other";
  value: string;
  start: number;
  end: number;
}

export interface ClassificationResult {
  categories: TaskCategory[];
  primaryCategory: TaskCategory;
  confidence: number;
  complexity: ComplexityLevel;
  entities: ExtractedEntity[];
  suggestedTools: string[];
  suggestedSkills: string[];
  keywords: string[];
  estimatedSteps: number;
  language: "zh" | "en" | "mixed";
  hasCode: boolean;
  requiresAuth: boolean;
  intentSimilarity?: Record<string, number>;  // 各意图的相似度
}

interface CategoryPattern {
  category: TaskCategory;
  patterns: RegExp[];
  tools: string[];
  skills: string[];
  examples?: string[];  // 用于向量匹配的示例句子（可选，优先使用 INTENT_VECTORS）
}

// 意图向量库 - 预定义的意图及其典型表述
const INTENT_VECTORS: Array<{
  category: TaskCategory;
  name: string;
  examples: string[];
}> = [
  {
    category: "web_search",
    name: "信息搜索",
    examples: [
      "搜索最新的AI发展情况",
      "帮我查一下国内AI发展情况",
      "了解一下当前的人工智能发展现状",
      "帮我搜索最近AI领域的新闻",
      "查询一下最新的科技动态",
      "搜索当前国内国际形势分析",
      "查找AI行业的最新发展",
      "搜索人工智能发展趋势",
      "帮我搜集AI发展相关资料",
      "了解一下AI领域的现状",
    ],
  },
  {
    category: "analysis_report",
    name: "分析报告",
    examples: [
      "写一份AI发展分析报告",
      "做一个1000字的分析报告",
      "生成一份市场分析报告",
      "帮我写一个详细的情况分析",
      "做一个全面的分析总结",
      "生成行业发展报告",
      "撰写一份分析报告",
      "做一份详细的情况报告",
      "帮我整理一份分析材料",
      "做一个深度的分析总结",
    ],
  },
  {
    category: "code_generation",
    name: "代码生成",
    examples: [
      "写一个网页代码",
      "帮我生成一段Python代码",
      "创建一个React组件",
      "写一个登录页面",
      "帮我写个排序算法",
      "生成一个API接口",
    ],
  },
  {
    category: "file_operation",
    name: "文件操作",
    examples: [
      "帮我创建一个文件夹",
      "删除这个文件",
      "读取上面的内容",
      "修改这个配置",
      "列出当前目录文件",
      "保存到桌面",
    ],
  },
  {
    category: "question_answering",
    name: "问答对话",
    examples: [
      "你好",
      "今天天气怎么样",
      "你是谁",
      "你能做什么",
      "介绍一下你自己",
      "解释一下什么是区块链",
    ],
  },
  {
    category: "report_generation",
    name: "报告生成",
    examples: [
      "生成一份周报",
      "帮我写个工作总结",
      "制作一个月度报告",
      "生成销售报表",
      "导出项目进度报告",
    ],
  },
  {
    category: "browser_automation",
    name: "浏览器自动化",
    examples: [
      "帮我登录这个网站",
      "自动填写表单",
      "监控这个页面的价格",
      "抓取网页数据",
      "自动点击这个按钮",
    ],
  },
  {
    category: "email_handling",
    name: "邮件处理",
    examples: [
      "帮我发一封邮件",
      "查看收件箱",
      "回复这封邮件",
      "分析邮件内容",
      "配置邮件账户",
      "整理我的邮件",
      "帮我整理邮件",
      "整理邮箱中的邮件",
      "把邮件整理一下",
      "整理收件箱",
      "帮我把邮件分类整理",
      "整理一下邮箱里的邮件",
      "把未读邮件整理一下",
      "整理邮件并生成报告",
      "整理邮件并做个总结",
      "自动整理邮件",
      "帮我把邮箱整理好",
      "邮件太多了帮我整理",
      "生成邮件报告",
      "邮件摘要",
      "整理所有邮件",
      "批量处理邮件",
      "清理邮箱",
      "把垃圾邮件清理一下",
      "统计一下邮件",
    ],
  },
  {
    category: "data_analysis",
    name: "数据分析",
    examples: [
      "分析这份数据",
      "统计一下销售额",
      "做个可视化图表",
      "清洗一下这个数据集",
      "计算增长率",
    ],
  },
  {
    category: "system_operation",
    name: "系统操作",
    examples: [
      "启动服务",
      "查看系统状态",
      "安装这个依赖",
      "设置定时任务",
      "备份数据库",
    ],
  },
  {
    category: "skill_execution",
    name: "技能执行",
    examples: [
      "安装这个技能",
      "运行我的脚本",
      "帮我搜索AI技能",
      "列出已安装技能",
    ],
  },
];

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: "code_generation",
    patterns: [
      /写(一个|个)?.*(代码|程序|脚本|页面|网站|网页|组件|函数|类|模块|API|接口|服务)/i,
      /(create|generate|write|build|make|code|develop|implement).*(code|script|page|website|app|component|function|class|module|api)/i,
      /(用|使用|using).*(React|Vue|Angular|Express|Next|Nuxt|Flask|Django|FastAPI|Spring)/i,
      /(html|css|javascript|typescript|python|java|go|rust|c\+\+|ruby|php|swift|kotlin)/i,
      /(编程|开发|实现).*(功能|feature|functionality)/i,
      /(生成|创建).*(模板|template|样式|style|布局|layout|结构|structure)/i,
      /(重构|优化|修复|fix|refactor|optimize).*(代码|code|bug|问题)/i,
    ],
    tools: ["file_create", "file_modify", "browser_js_eval"],
    skills: ["code-generator", "web-dev", "template-engine"],
  },
  {
    category: "file_operation",
    patterns: [
      /(创建|新建|删除|移动|复制|重命名|读取|查看|写入|修改|编辑|打开).*(文件|文件夹|目录|file|folder|directory)/i,
      /(create|delete|move|copy|rename|read|write|edit|open|modify).*(file|folder|directory)/i,
      /(ls|dir|mkdir|rm|mv|cp|touch|cat)/,
      /(列出|显示).*(文件|目录|内容|列表)/i,
      /(保存|另存为|save|store).*(文件|file)/i,
      /(上传|下载|upload|download).*(文件|file)/i,
    ],
    tools: ["file_create", "file_read", "file_list", "file_delete", "file_modify"],
    skills: ["file-manager", "data-migration"],
  },
  {
    category: "web_search",
    patterns: [
      /(搜索|查找|查询|search|find|look.*up|query).*(信息|资料|内容|网页|网站|答案|结果|info|information|web|internet|online)/i,
      /(帮我查|查一下|了解|知道|告诉我).*(关于|about)/i,
      /(什么是|what is|who is|when|where|how|why)/i,
      /(最新的|最近的|latest|recent|news|trending)/i,
      /(百度|谷歌|必应|google|bing|搜索)/i,
    ],
    tools: ["browser_search", "browser_navigate"],
    skills: ["web-researcher", "news-aggregator"],
  },
  {
    category: "browser_automation",
    patterns: [
      /(打开|访问|浏览|登录|登入|登出|填写|提交|点击|截屏|截图|open|visit|browse|login|log.*in|log.*out|fill|submit|click|screenshot).*(网页|网站|页面|浏览器|web|site|page|browser)/i,
      /(自动|自动化|automate).*(浏览|网页|填写|表单|登录|brows|web|form|login)/i,
      /(抓取|爬取|采集|scrape|crawl|extract).*(数据|内容|信息|data|content|info)/i,
      /(监控|monitor|watch).*(网页|网站|页面|价格|库存|web|site|page|price|stock)/i,
    ],
    tools: ["browser_launch", "browser_navigate", "browser_screenshot", "browser_login", "browser_click", "browser_fill_form", "browser_get_html", "browser_js_eval"],
    skills: ["web-automator", "login-bot", "price-tracker"],
  },
  {
    category: "email_handling",
    patterns: [
      /(邮件|邮箱|email|mail|收件箱|发件箱|inbox|outbox|发邮件|发信|收信|send.*mail|receive.*mail)/i,
      /(检查|查看|check).*(邮件|邮箱|email|inbox)/i,
      /(发送|回复|转发|send|reply|forward).*(邮件|email|mail)/i,
      /(邮件|email).*(摘要|分析|分类|整理|summary|analysis|digest|categorize)/i,
      /(添加|配置|add|configure|setup).*(邮箱|邮件|账户|email|mail|account)/i,
    ],
    tools: ["email_send", "email_analyze", "email_summarize", "email_add_account", "email_list_accounts"],
    skills: ["email-assistant", "inbox-organizer"],
  },
  {
    category: "data_analysis",
    patterns: [
      /(分析|统计|汇总|计算|处理|清洗|可视化|图表|analysis|statistics|aggregate|calculate|process|clean|visualize|chart|graph)/i,
      /(数据|data|报表|report|excel|csv|json|表格|table|database)/i,
      /(导出|导入|转换|格式化|export|import|convert|format|transform).*(数据|data)/i,
      /(趋势|模式|异常|pattern|trend|anomaly|insight)/i,
      /(最大|最小|平均|总和|总数|max|min|average|sum|total|count)/i,
    ],
    tools: ["file_read", "email_analyze", "report_generate"],
    skills: ["data-analyzer", "chart-builder", "spreadsheet-processor"],
  },
  {
    category: "system_operation",
    patterns: [
      /(启动|停止|重启|start|stop|restart|reboot).*(服务|进程|service|process|server)/i,
      /(安装|卸载|更新|升级|install|uninstall|update|upgrade|setup).*(软件|包|依赖|software|package|dependency)/i,
      /(查看|检查|check|monitor).*(系统|状态|磁盘|内存|CPU|网络|system|status|disk|memory|network)/i,
      /(定时|计划|调度|schedule|cron|定时任务|scheduled.*task)/i,
      /(备份|恢复|迁移|backup|restore|migrate)/i,
    ],
    tools: ["scheduler_create", "scheduler_list", "scheduler_execute"],
    skills: ["system-monitor", "backup-manager"],
  },
  {
    category: "question_answering",
    patterns: [
      /^[你您]?(好|hi|hello|hey)/i,
      /(你是谁|你能做什么|介绍一下|what.*you|who.*you|help|帮助)/i,
      /(怎么|如何|how.*to|how.*do|教程|指导|guide|tutorial)/i,
      /(为什么|原因|理由|why|reason|cause)/i,
      /(是什么意思|含义|定义|definition|meaning|解释|解释一下|explain)/i,
      /(建议|推荐|推荐一下|recommend|suggest|advice|tip)/i,
    ],
    tools: [],
    skills: ["knowledge-base", "tutor"],
  },
  {
    category: "skill_execution",
    patterns: [
      /(安装|卸载|启用|禁用|install|uninstall|enable|disable).*(技能|skill|skills|插件|plugin)/i,
      /(查找|搜索|find|search).*(技能|skill|skills|plugin)/i,
      /(列出|显示|list|show).*(技能|skill|skills|已安装|installed)/i,
      /(运行|执行|run|execute|launch).*(技能|skill|脚本|script)/i,
      /(管理|配置|manage|configure).*(技能|skill|插件|plugin)/i,
    ],
    tools: ["skill_search", "skill_find_and_install"],
    skills: [],
  },
  {
    category: "report_generation",
    patterns: [
      /(生成|创建|制作|generate|create|produce|make|build).*(报告|报表|周报|月报|日报|摘要|report|summary|digest|weekly|monthly|daily)/i,
      /(报告|报表|report).*(模板|格式|template|format)/i,
      /(导出|保存|export|save).*(报告|报表|PDF|HTML|report)/i,
      /(总结|汇总|归纳|summarize|aggregate|recap).*(工作|进度|成果|work|progress|result)/i,
    ],
    tools: ["report_generate", "report_templates", "report_email_digest", "report_weekly"],
    skills: ["report-builder", "document-generator"],
  },
];

const COMPLEXITY_INDICATORS = {
  simple: [
    /^(你|我|他|她)\s*(好|hi|hello)/,
    /(是什么|什么是|定义|meaning|definition)/,
    /(列出|显示|查看|list|show|view|ls|dir)/,
    /(计算|算一下|calculate).{1,20}/,
    /(帮我看一下|查一下|check)/,
  ],
  complex: [
    /(完整|整个|全部|整个|整套|full|complete|entire|whole).*(项目|系统|应用|网站|project|system|app|website|application)/,
    /(and|并且|同时|然后|接着|之后|之后还要|还要).*(and|并且)/,
    /(多个|多项|multi|multiple|several).*(步骤|阶段|模块|step|phase|module)/,
    /(架构|设计|design|architecture|structure).*(系统|项目|应用|system|project|app)/,
    /(部署|deploy|deployment|production|上线|发布|release)/,
    /(数据库|database|认证|auth|权限|permission|支付|payment|实时|realtime)/,
    /(多页面|多模块|前后端|全栈|full.?stack|前后端分离)/,
    /(可扩展|高并发|分布式|scalable|distributed|microservice|微服务)/,
  ],
};

export class TaskClassifier {
  private tfidfCache = new Map<string, Map<string, number>>();
  private documentFrequency = new Map<string, number>();
  private isInitialized = false;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.initializeTfidf();
  }

  /**
   * 初始化 TF-IDF 向量库
   */
  private initializeTfidf(): void {
    if (this.isInitialized) return;

    // 计算每个意图示例的 TF
    for (const intent of INTENT_VECTORS) {
      for (const example of intent.examples) {
        const tf = this.computeTf(example);
        const docId = `${intent.category}_${example}`;
        this.tfidfCache.set(docId, tf);
      }
    }

    // 计算 IDF (逆文档频率)
    const allTerms = new Set<string>();
    for (const [, tf] of this.tfidfCache) {
      for (const term of tf.keys()) {
        allTerms.add(term);
      }
    }

    const numDocs = INTENT_VECTORS.reduce((sum, i) => sum + i.examples.length, 0);
    for (const term of allTerms) {
      let docCount = 0;
      for (const [, tf] of this.tfidfCache) {
        if (tf.has(term)) docCount++;
      }
      this.documentFrequency.set(term, Math.log(numDocs / (docCount + 1)));
    }

    // 将 TF 转换为 TF-IDF (TF * IDF)，使缓存可直接用于相似度计算，避免 matchIntentByVector 重复计算
    const fallbackIdf = Math.log(INTENT_VECTORS.length);
    for (const [, tfidf] of this.tfidfCache) {
      for (const [term, tfValue] of tfidf) {
        const idf = this.documentFrequency.get(term) || fallbackIdf;
        tfidf.set(term, tfValue * idf);
      }
    }

    this.isInitialized = true;
    process.stdout.write(`[TaskClassifier] TF-IDF 向量库初始化完成: ${INTENT_VECTORS.length} 个意图, ${numDocs} 个示例\n`);
  }

  /**
   * 计算 TF (词频)
   */
  private computeTf(text: string): Map<string, number> {
    const terms = this.tokenize(text);
    const tf = new Map<string, number>();
    const total = terms.length || 1;

    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    // 归一化
    for (const [term, count] of tf) {
      tf.set(term, count / total);
    }

    return tf;
  }

  /**
   * 分词 (简单的中英文混合分词)
   */
  private tokenize(text: string): string[] {
    // 简单的分词逻辑
    const terms: string[] = [];
    
    // 处理中文 - 简单按标点和空格分割
    const chineseTerms = text.toLowerCase().split(/[\s,.;:!?()\[\]{}""''<>'~@#$%^&*+=\\/|，。！？、；：（）【】《》""'']+/)
      .filter(t => t.length >= 2);
    
    // 处理英文 - 提取单词
    const englishWords = text.toLowerCase().match(/[a-z]{2,}/g) || [];
    
    // 提取重要概念 (2-3个字的组合)
    const bigrams: string[] = [];
    for (const term of chineseTerms) {
      if (term.length >= 3) {
        // 提取关键概念
        const concepts = term.match(/[\u4e00-\u9fff]{2,4}/g);
        if (concepts) {
          bigrams.push(...concepts);
        }
      }
    }

    return [...new Set([...chineseTerms, ...englishWords, ...bigrams])];
  }

  /**
   * 计算 TF-IDF 向量
   */
  private computeTfidf(text: string): Map<string, number> {
    const tf = this.computeTf(text);
    const tfidf = new Map<string, number>();

    for (const [term, tfValue] of tf) {
      const idf = this.documentFrequency.get(term) || Math.log(INTENT_VECTORS.length);
      tfidf.set(term, tfValue * idf);
    }

    return tfidf;
  }

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const [term, valueA] of a) {
      const valueB = b.get(term) || 0;
      dotProduct += valueA * valueB;
      normA += valueA * valueA;
    }

    for (const valueB of b.values()) {
      normB += valueB * valueB;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 使用 TF-IDF 向量匹配判断用户意图
   */
  private matchIntentByVector(task: string): Array<{ category: TaskCategory; similarity: number }> {
    const taskVector = this.computeTfidf(task);
    const results: Array<{ category: TaskCategory; similarity: number }> = [];

    // 计算与每个意图类别的相似度
    const categoryVectors = new Map<TaskCategory, Map<string, number>[]>();
    for (const intent of INTENT_VECTORS) {
      categoryVectors.set(intent.category, []);
    }

    // 计算每个示例的 TF-IDF 向量（读取 initializeTfidf 中预计算的缓存，避免重复计算）
    for (const intent of INTENT_VECTORS) {
      for (const example of intent.examples) {
        const docId = `${intent.category}_${example}`;
        const exampleVector = this.tfidfCache.get(docId);
        if (exampleVector) categoryVectors.get(intent.category)!.push(exampleVector);
      }
    }

    // 计算每个类别的平均相似度
    for (const [category, vectors] of categoryVectors) {
      let totalSimilarity = 0;
      for (const vec of vectors) {
        totalSimilarity += this.cosineSimilarity(taskVector, vec);
      }
      const avgSimilarity = vectors.length > 0 ? totalSimilarity / vectors.length : 0;
      results.push({ category, similarity: avgSimilarity });
    }

    // 按相似度排序
    results.sort((a, b) => b.similarity - a.similarity);

    return results;
  }

  /**
   * 综合分类：结合向量匹配和正则匹配
   */
  classify(task: string): ClassificationResult {
    // 使用 TF-IDF 向量匹配
    const vectorMatches = this.matchIntentByVector(task);
    const vectorPrimary = vectorMatches[0];
    const intentSimilarity: Record<string, number> = {};
    for (const m of vectorMatches) {
      intentSimilarity[m.category] = Math.round(m.similarity * 100) / 100;
    }

    // 使用正则匹配
    const regexCategories = this.detectCategories(task);
    const regexPrimary = regexCategories[0] || "question_answering";

    // 综合判断：优先使用向量匹配（语义更准确）
    let primaryCategory: TaskCategory;
    let confidence: number;

    if (vectorPrimary && vectorPrimary.similarity > 0.3) {
      // 向量匹配置信度高
      primaryCategory = vectorPrimary.category;
      confidence = Math.min(vectorPrimary.similarity + 0.2, 1.0);
    } else if (vectorMatches.length > 0 && vectorPrimary) {
      // 向量匹配结果作为参考，结合正则匹配
      const regexIndex = regexCategories.indexOf(vectorPrimary.category);
      if (regexIndex >= 0) {
        primaryCategory = vectorPrimary.category;
        confidence = vectorPrimary.similarity;
      } else {
        // 正则匹配的结果与向量匹配不一致，以向量为准（语义理解更准确）
        primaryCategory = vectorPrimary.category;
        confidence = vectorPrimary.similarity * 0.8;
      }
    } else {
      // 默认使用正则匹配结果
      primaryCategory = regexPrimary;
      confidence = 0.5;
    }

    // 合并分类结果
    const allCategories = new Set([primaryCategory, ...regexCategories]);
    const categories = Array.from(allCategories);

    const complexity = this.detectComplexity(task);
    const entities = this.extractEntities(task);
    const keywords = this.extractKeywords(task);
    const suggestedTools = this.getSuggestedTools(categories);
    const suggestedSkills = this.getSuggestedSkills(categories);
    const estimatedSteps = this.estimateSteps(task, complexity);
    const language = this.detectLanguage(task);
    const hasCode = this.detectHasCode(task);
    const requiresAuth = this.detectRequiresAuth(categories);

    // 发布分类事件
    this.eventBus.publish(
      "intelligence.task_classified",
      {
        primaryCategory,
        categories,
        complexity,
        confidence,
        estimatedSteps,
        language,
        intentSimilarity,
        vectorMatch: vectorPrimary,
      },
      "task-classifier"
    ).catch((err) => {
      process.stderr.write(`[TaskClassifier] Failed to publish task_classified event: ${err}\n`);
    });

    const result: ClassificationResult = {
      categories,
      primaryCategory,
      confidence,
      complexity,
      entities,
      suggestedTools,
      suggestedSkills,
      keywords,
      estimatedSteps,
      language,
      hasCode,
      requiresAuth,
      intentSimilarity,
    };

    process.stdout.write(`[TaskClassifier] 分类结果: ${primaryCategory} (置信度: ${(confidence * 100).toFixed(0)}%)\n`);
    // 输出 top-3 相似度而非整个对象，避免打印 [object Object]
    const top3 = Object.entries(intentSimilarity)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join(", ");
    process.stdout.write(`[TaskClassifier] 意图相似度(top3): ${top3}\n`);

    return result;
  }

  /**
   * 判断是否需要网络搜索（基于向量匹配）
   */
  needsWebSearch(task: string, preclassified?: ClassificationResult): { needed: boolean; confidence: number; reason: string } {
    const result = preclassified ?? this.classify(task);
    
    // 需要排除的意图类别（这些操作不需要网络搜索）
    const excludedCategories: TaskCategory[] = [
      "email_handling",  // 邮件操作不需要网络搜索
      "file_operation",  // 文件操作不需要网络搜索
      "code_generation", // 代码生成不需要网络搜索
      "skill_execution",  // 技能执行不需要网络搜索
      "system_operation", // 系统操作不需要网络搜索
    ];
    
    // 如果主要意图是排除的类别，不触发搜索
    if (excludedCategories.includes(result.primaryCategory)) {
      return { 
        needed: false, 
        confidence: 0, 
        reason: `检测到${result.primaryCategory}意图，无需网络搜索` 
      };
    }
    
    const searchCategories: TaskCategory[] = ["web_search", "analysis_report"];
    
    const searchSimilarity = result.intentSimilarity?.["web_search"] || 0;
    const reportSimilarity = result.intentSimilarity?.["analysis_report"] || 0;
    const maxSimilarity = Math.max(searchSimilarity, reportSimilarity);

    if (maxSimilarity > 0.35) {
      // 再次确认不是排除的类别
      const entries = Object.entries(result.intentSimilarity || {});
      if (entries.length === 0) {
        return { needed: false, confidence: 0, reason: "无意图相似度数据" };
      }
      const topCategory = entries
        .sort(([, a], [, b]) => (typeof b === "number" ? b : 0) - (typeof a === "number" ? a : 0))[0];
      
      if (topCategory && excludedCategories.includes(topCategory[0] as TaskCategory)) {
        return { 
          needed: false, 
          confidence: 0, 
          reason: `检测到${topCategory[0]}意图，无需网络搜索` 
        };
      }
      
      const reason = maxSimilarity === searchSimilarity 
        ? "检测到信息搜索意图" 
        : "检测到分析报告意图";
      return { needed: true, confidence: maxSimilarity, reason };
    }

    return { needed: false, confidence: 0, reason: "未检测到需要搜索的意图" };
  }

  private detectCategories(task: string): TaskCategory[] {
    const results: Array<{ category: TaskCategory; score: number }> = [];

    for (const cp of CATEGORY_PATTERNS) {
      let score = 0;
      for (const pattern of cp.patterns) {
        // 使用 pattern.test 判断是否匹配（非全局正则的 match.length 返回捕获组数+1，非匹配次数）
        if (pattern.test(task)) {
          score += 1;
          // 检查匹配位置是否靠前（增加权重）
          const match = task.match(pattern);
          if (match && match.index !== undefined && match.index < 20) {
            score += 1;
          }
        }
      }
      if (score > 0) {
        results.push({ category: cp.category, score });
      }
    }

    results.sort((a, b) => b.score - a.score);

    if (results.length === 0) {
      return ["question_answering"];
    }

    return results.map((r) => r.category);
  }

  private calculateConfidence(task: string, primaryCategory: TaskCategory): number {
    const cp = CATEGORY_PATTERNS.find((p) => p.category === primaryCategory);
    if (!cp) return 0.3;

    let matchCount = 0;
    let totalWeight = 0;

    for (const pattern of cp.patterns) {
      const matches = task.match(pattern);
      if (matches) {
        matchCount++;
        totalWeight += matches.length > 1 ? 2 : 1;
      }
    }

    const coverage = matchCount / Math.min(cp.patterns.length, 5);
    const intensity = Math.min(totalWeight / 8, 1);

    return Math.min(coverage * 0.5 + intensity * 0.3 + 0.2, 1.0);
  }

  private detectComplexity(task: string): ComplexityLevel {
    let complexScore = 0;
    let simpleScore = 0;

    for (const pattern of COMPLEXITY_INDICATORS.complex) {
      if (pattern.test(task)) complexScore += 2;
    }

    for (const pattern of COMPLEXITY_INDICATORS.simple) {
      if (pattern.test(task)) simpleScore += 2;
    }

    const wordCount = task.split(/\s+/).length;
    if (wordCount > 80) complexScore += 2;
    else if (wordCount < 10) simpleScore += 1;

    const sentenceCount = task.split(/[。！？.!?]\s*/).filter(Boolean).length;
    if (sentenceCount > 5) complexScore += 1;
    else if (sentenceCount <= 2) simpleScore += 1;

    const hasMultipleActions = (task.match(/(并且|同时|然后|接着|and|also|then|next)/gi) || []).length;
    if (hasMultipleActions >= 2) complexScore += 2;
    else if (hasMultipleActions === 1) complexScore += 1;

    if (complexScore > simpleScore + 2) return "complex";
    if (simpleScore > complexScore + 1) return "simple";
    return "medium";
  }

  private extractEntities(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];

    const urlPattern = /https?:\/\/[^\s"'`<>，。！？、（）()]+/gi;
    for (const match of text.matchAll(urlPattern)) {
      if (match.index !== undefined) {
        entities.push({ type: "url", value: match[0], start: match.index, end: match.index + match[0].length });
      }
    }

    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    for (const match of text.matchAll(emailPattern)) {
      if (match.index !== undefined) {
        entities.push({ type: "email", value: match[0], start: match.index, end: match.index + match[0].length });
      }
    }

    const filePathPattern = /(?:(?:[a-zA-Z]:[\\/])|(?:\.{1,2}[\\/])|(?:~[\\/])|(?:[\\/]\w+))(?:[\w\-.]+[\\/])*[\w\-.]+\.\w{1,6}/g;
    for (const match of text.matchAll(filePathPattern)) {
      if (match.index !== undefined) {
        entities.push({ type: "file_path", value: match[0], start: match.index, end: match.index + match[0].length });
      }
    }

    const folderPattern = /(?:在|到|于|in|to|at|into)\s*[`"']?([\w\-.\\/]+)(?:[`"']?\s*(?:文件夹|目录|folder|directory))/gi;
    for (const match of text.matchAll(folderPattern)) {
      if (match.index !== undefined && match[1]) {
        entities.push({ type: "folder_name", value: match[1], start: match.index, end: match.index + match[0].length });
      }
    }

    const langPattern = /(?:用|使用|using|in|language|语言)\s*(Python|JavaScript|TypeScript|Java|Go|Rust|C\+\+|Ruby|PHP|Swift|Kotlin|HTML|CSS|SQL|Bash|Shell)(?:\s|$|，|。|！)/gi;
    for (const match of text.matchAll(langPattern)) {
      if (match.index !== undefined && match[1]) {
        entities.push({ type: "language", value: match[1], start: match.index, end: match.index + match[0].length });
      }
    }

    const frameworkPattern = /(React|Vue|Angular|Express|Next\.?js|Nuxt\.?js|Flask|Django|FastAPI|Spring|Laravel|Rails|Gin|Echo|Fiber|Svelte|Solid)/gi;
    for (const match of text.matchAll(frameworkPattern)) {
      if (match.index !== undefined) {
        entities.push({ type: "framework", value: match[0], start: match.index, end: match.index + match[0].length });
      }
    }

    const toolNamePattern = /(?:用|使用|调用|运行|执行|using|with|via|through|run|execute|call)\s*(browser_\w+|email_\w+|scheduler_\w+|report_\w+|file_\w+|skill_\w+|task_\w+)/gi;
    for (const match of text.matchAll(toolNamePattern)) {
      if (match.index !== undefined && match[1]) {
        entities.push({ type: "tool_name", value: match[1], start: match.index, end: match.index + match[0].length });
      }
    }

    return entities;
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "can", "shall", "to", "of", "in", "for",
      "on", "with", "at", "by", "from", "as", "into", "through", "during",
      "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
      "this", "that", "these", "those", "it", "its", "he", "she", "they",
      "你", "我", "他", "她", "它", "们", "这", "那", "是", "的", "了",
      "在", "不", "和", "也", "就", "都", "而", "及", "与", "着", "把",
      "被", "从", "让", "对", "用", "要", "有", "去", "很", "能", "会",
      "可以", "一个", "这个", "那个", "什么", "怎么", "哪些", "哪个", "吗",
      "吧", "呢", "啊", "哦", "嗯", "就", "还", "请", "帮", "谢谢",
    ]);

    const words = text.toLowerCase().split(/[\s,.;:!?()\[\]{}"'`<>，。！？、；：（）【】《》""'']+/);

    const freq = new Map<string, number>();
    for (const word of words) {
      if (word.length < 2 || stopWords.has(word)) continue;
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word]) => word);
  }

  private getSuggestedTools(categories: TaskCategory[]): string[] {
    const tools = new Set<string>();
    for (const cat of categories) {
      const cp = CATEGORY_PATTERNS.find((p) => p.category === cat);
      if (cp) {
        for (const t of cp.tools) tools.add(t);
      }
    }
    return [...tools];
  }

  private getSuggestedSkills(categories: TaskCategory[]): string[] {
    const skills = new Set<string>();
    for (const cat of categories) {
      const cp = CATEGORY_PATTERNS.find((p) => p.category === cat);
      if (cp) {
        for (const s of cp.skills) skills.add(s);
      }
    }
    return [...skills];
  }

  private estimateSteps(task: string, complexity: ComplexityLevel): number {
    const wordCount = task.split(/\s+/).length;
    const actionCount = (task.match(/(并且|同时|然后|接着|and|also|then|next|first|second|third|最后|finally|\d+[.、\.])/gi) || []).length;

    const baseSteps: Record<ComplexityLevel, number> = {
      simple: 1,
      medium: 3,
      complex: 6,
    };

    let steps = baseSteps[complexity] + actionCount;

    if (wordCount > 150) steps += 3;
    else if (wordCount > 80) steps += 1;

    return Math.min(Math.max(steps, 1), 20);
  }

  private detectLanguage(text: string): ClassificationResult["language"] {
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const englishChars = (text.match(/[a-zA-Z]/g) || []).length;

    if (chineseChars > englishChars * 2) return "zh";
    if (englishChars > chineseChars * 2) return "en";
    return "mixed";
  }

  private detectHasCode(text: string): boolean {
    if (text.includes("```")) return true;
    const patterns = [
      /function\s+\w+\s*\(/,
      /class\s+\w+/,
      /import\s+/,
      /(?:const|let|var)\s+\w+\s*=/,
      /=>/,
      /def\s+\w+\s*\(/,
      /public\s+(?:static\s+)?(?:void|class)/,
      /from\s+['"][\w@]/,
    ];
    return patterns.some((p) => p.test(text));
  }

  private detectRequiresAuth(categories: TaskCategory[]): boolean {
    return categories.some((c) => ["email_handling", "browser_automation"].includes(c));
  }

  async healthCheck(): Promise<boolean> {
    return CATEGORY_PATTERNS.length > 0;
  }
}