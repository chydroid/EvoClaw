// Quick reply and fallback response generation for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { PersonaConfig } from "@evoclaw/core";
import type { ModelConfig, ProviderConfig, ToolDefinition } from "./types";

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

/**
 * Try to generate a quick (non-LLM) reply for simple messages.
 * Returns null if no quick reply matches — caller should fall through to LLM.
 */
export function tryQuickReply(deps: QuickReplyDeps, message: string): string | null {
  const msg = message.toLowerCase().trim();

  // Greetings: short, simple hellos
  const greetingPatterns = [
    /^(你好|嗨|hi|hello|hey|哈喽|您好|早上好|下午好|晚上好|早安|晚安|good morning|good afternoon|good evening)\s*[!！.。~～]*$/i,
  ];
  for (const pattern of greetingPatterns) {
    if (pattern.test(msg)) {
      const greetings = [
        `${deps.persona.masterTerm}您好！我是 ${deps.persona.name}，${deps.persona.title} 🧬`,
        `请问有什么可以帮您的？`,
      ];
      return greetings.join("\n");
    }
  }

  // Capability queries
  if (/^(你能做什么|你有什么能力|你有什么功能|你的功能|介绍一下你自己|你是谁|who are you|what can you do|introduce yourself)\s*[?？!！.。]*$/i.test(msg)) {
    const lines = [
      `我是 ${deps.persona.name}，${deps.persona.title} 🧬`,
      `以下是当前能力：`,
      `🎯 **对话交互** — 自然语言理解和回复`,
      `🛠️ **技能执行** — 运行已安装的 Skill`,
      `📋 **任务编排** — 规划和执行复杂任务流程`,
      `🔍 **搜索技能** — 浏览本地和远程技能市场`,
      `📈 **自我进化** — 学习和优化执行策略`,
      `💬 **多通道** — 支持微信/钉钉/飞书等平台`,
    ];
    return lines.join("\n");
  }

  // Thank you
  if (/^(谢谢|感谢|thanks|thank you|thx|多谢|3q)\s*[!！.。~～]*$/i.test(msg)) {
    return `不客气！有任何问题随时找我 😊`;
  }

  // Goodbye
  if (/^(再见|拜拜|bye|goodbye|see you|回见|下次见)\s*[!！.。~～]*$/i.test(msg)) {
    return `再见！随时欢迎回来找我 🧬`;
  }

  // No quick reply matched — let LLM handle it
  return null;
}

/**
 * Check if a message contains action-oriented intent keywords.
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
    "新闻", "热搜", "天气", "邮件",
    "下载", "爬取", "抓取", "小说", "download", "scrape", "crawl", "novel",
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
