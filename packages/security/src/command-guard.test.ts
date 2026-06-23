import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  normalizeCommand,
  checkHardline,
  HARDLINE_PATTERNS,
  ENV_VAR_NAME_DENYLIST,
  isEnvVarDenied,
  filterDeniedEnvVars,
  INVISIBLE_CHARS,
  detectInvisibleChars,
} from "./command-guard";

// ═══════════════════════════════════════════════════════════
// 测试套件：command-guard（命令安全护栏）
// 借鉴 hermes-agent tools/approval.py + tools/ansi_strip.py
// ═══════════════════════════════════════════════════════════

describe("command-guard > stripAnsi", () => {
  it("无 ANSI 序列时原样返回（快速路径）", () => {
    expect(stripAnsi("ls -la")).toBe("ls -la");
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("剥离 CSI 序列（颜色码）", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;32mgreen\x1b[0m")).toBe("green");
  });

  it("剥离 OSC 序列", () => {
    expect(stripAnsi("\x1b]0;title\x07ls")).toBe("ls");
    expect(stripAnsi("\x1b]2;window\x1b\\ls")).toBe("ls");
  });

  it("剥离 8-bit C1 控制字符", () => {
    expect(stripAnsi("\x9b31mred\x9b0m")).toBe("red");
  });

  it("复杂混合序列", () => {
    const input = "\x1b[31m\x1b]0;title\x07rm\x1b[0m -rf /";
    expect(stripAnsi(input)).toBe("rm -rf /");
  });
});

describe("command-guard > normalizeCommand", () => {
  it("空输入返回空字符串", () => {
    expect(normalizeCommand("")).toBe("");
  });

  it("剥离 ANSI 转义序列", () => {
    expect(normalizeCommand("\x1b[31mrm\x1b[0m -rf /")).toBe("rm -rf /");
  });

  it("移除 null 字节", () => {
    expect(normalizeCommand("rm\x00 -rf /")).toBe("rm -rf /");
  });

  it("Unicode NFKC 归一化（fullwidth → 半角）", () => {
    // ｒｍ（fullwidth）→ rm
    const fullwidth = "\uFF52\uFF4D -rf /";
    expect(normalizeCommand(fullwidth)).toBe("rm -rf /");
  });

  it("剥离反斜杠转义（r\\m → rm）", () => {
    expect(normalizeCommand("r\\m -rf /")).toBe("rm -rf /");
  });

  it("剥离空字符串字面量（r''m → rm）", () => {
    expect(normalizeCommand("r''m -rf /")).toBe("rm -rf /");
    expect(normalizeCommand('r""m -rf /')).toBe("rm -rf /");
  });

  it("组合多种混淆技术", () => {
    // ANSI + null + fullwidth + backslash
    const input = "\x1b[31mｒ\x00\\ｍ\x1b[0m -rf /";
    expect(normalizeCommand(input)).toBe("rm -rf /");
  });
});

describe("command-guard > HARDLINE_PATTERNS", () => {
  it("HARDLINE_PATTERNS 非空且每个项有 pattern 和 reason", () => {
    expect(HARDLINE_PATTERNS.length).toBeGreaterThan(0);
    for (const { pattern, reason } of HARDLINE_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(reason).toBeTypeOf("string");
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("command-guard > checkHardline", () => {
  // ── rm -rf / 系列 ──
  it("阻止 rm -rf /", () => {
    const result = checkHardline("rm -rf /");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("root filesystem");
  });

  it("阻止 rm -rf /*", () => {
    const result = checkHardline("rm -rf /*");
    expect(result.blocked).toBe(true);
  });

  it("阻止 rm -rf /etc", () => {
    const result = checkHardline("rm -rf /etc");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("system directory");
  });

  it("阻止 rm -rf /home", () => {
    const result = checkHardline("rm -rf /home");
    expect(result.blocked).toBe(true);
  });

  it("阻止 rm -rf ~", () => {
    const result = checkHardline("rm -rf ~");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("home directory");
  });

  it("阻止 rm -rf $HOME", () => {
    const result = checkHardline("rm -rf $HOME");
    expect(result.blocked).toBe(true);
  });

  it("不阻止 rm -rf /tmp/safe-dir", () => {
    const result = checkHardline("rm -rf /tmp/safe-dir");
    expect(result.blocked).toBe(false);
  });

  it("不阻止 ls -la", () => {
    const result = checkHardline("ls -la");
    expect(result.blocked).toBe(false);
  });

  // ── mkfs 系列 ──
  it("阻止 mkfs", () => {
    expect(checkHardline("mkfs.ext4 /dev/sda1").blocked).toBe(true);
    expect(checkHardline("mkfs /dev/sda1").blocked).toBe(true);
  });

  // ── dd 到块设备 ──
  it("阻止 dd 到 /dev/sd*", () => {
    expect(checkHardline("dd if=/dev/zero of=/dev/sda").blocked).toBe(true);
    expect(checkHardline("dd if=/dev/zero of=/dev/nvme0n1").blocked).toBe(true);
  });

  it("阻止重定向到块设备", () => {
    expect(checkHardline("cat /dev/urandom > /dev/sda").blocked).toBe(true);
  });

  it("不阻止 dd 到普通文件", () => {
    expect(checkHardline("dd if=/dev/zero of=/tmp/file bs=1M count=10").blocked).toBe(false);
  });

  // ── Fork bomb ──
  it("阻止 fork bomb", () => {
    expect(checkHardline(":(){ :|:& };:").blocked).toBe(true);
  });

  // ── kill -1 ──
  it("阻止 kill -1（杀死所有进程）", () => {
    expect(checkHardline("kill -1").blocked).toBe(true);
    expect(checkHardline("kill -9 -1").blocked).toBe(true);
  });

  it("不阻止 kill 单个 PID", () => {
    expect(checkHardline("kill 12345").blocked).toBe(false);
  });

  // ── shutdown/reboot ──
  it("阻止 shutdown", () => {
    expect(checkHardline("shutdown -h now").blocked).toBe(true);
  });

  it("阻止 reboot", () => {
    expect(checkHardline("reboot").blocked).toBe(true);
  });

  it("阻止 sudo reboot", () => {
    expect(checkHardline("sudo reboot").blocked).toBe(true);
  });

  it("阻止 systemctl poweroff", () => {
    expect(checkHardline("systemctl poweroff").blocked).toBe(true);
  });

  it("阻止 init 0", () => {
    expect(checkHardline("init 0").blocked).toBe(true);
    expect(checkHardline("init 6").blocked).toBe(true);
  });

  it("不阻止 echo reboot（命令位置锚定）", () => {
    expect(checkHardline("echo reboot").blocked).toBe(false);
    expect(checkHardline("grep shutdown /var/log/syslog").blocked).toBe(false);
  });

  // ── 归一化绕过防护 ──
  it("阻止 ANSI 混淆的 rm -rf /", () => {
    const result = checkHardline("\x1b[31mrm\x1b[0m -rf /");
    expect(result.blocked).toBe(true);
  });

  it("阻止 null 字节混淆的 rm -rf /", () => {
    const result = checkHardline("rm\x00 -rf /");
    expect(result.blocked).toBe(true);
  });

  it("阻止 fullwidth 混淆的 rm -rf /", () => {
    const fullwidth = "\uFF52\uFF4D -rf /";
    const result = checkHardline(fullwidth);
    expect(result.blocked).toBe(true);
  });

  it("阻止反斜杠混淆的 rm -rf /", () => {
    const result = checkHardline("r\\m -rf /");
    expect(result.blocked).toBe(true);
  });

  it("返回归一化后的命令", () => {
    const result = checkHardline("\x1b[31mrm\x1b[0m -rf /");
    expect(result.normalizedCommand).toBe("rm -rf /");
  });
});

describe("command-guard > ENV_VAR_NAME_DENYLIST", () => {
  it("包含 LLM provider 凭据", () => {
    expect(isEnvVarDenied("OPENAI_API_KEY")).toBe(true);
    expect(isEnvVarDenied("ANTHROPIC_API_KEY")).toBe(true);
    expect(isEnvVarDenied("ANTHROPIC_TOKEN")).toBe(true);
    expect(isEnvVarDenied("OPENROUTER_API_KEY")).toBe(true);
    expect(isEnvVarDenied("GOOGLE_API_KEY")).toBe(true);
    expect(isEnvVarDenied("DEEPSEEK_API_KEY")).toBe(true);
  });

  it("包含 RCE 向量", () => {
    expect(isEnvVarDenied("LD_PRELOAD")).toBe(true);
    expect(isEnvVarDenied("LD_LIBRARY_PATH")).toBe(true);
    expect(isEnvVarDenied("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isEnvVarDenied("PYTHONPATH")).toBe(true);
    expect(isEnvVarDenied("PYTHONSTARTUP")).toBe(true);
    expect(isEnvVarDenied("NODE_PATH")).toBe(true);
    expect(isEnvVarDenied("NODE_OPTIONS")).toBe(true);
    expect(isEnvVarDenied("JAVA_TOOL_OPTIONS")).toBe(true);
  });

  it("包含 Shell/编辑器劫持向量", () => {
    expect(isEnvVarDenied("PATH")).toBe(true);
    expect(isEnvVarDenied("SHELL")).toBe(true);
    expect(isEnvVarDenied("BASH_ENV")).toBe(true);
    expect(isEnvVarDenied("ENV")).toBe(true);
    expect(isEnvVarDenied("EDITOR")).toBe(true);
    expect(isEnvVarDenied("VISUAL")).toBe(true);
    expect(isEnvVarDenied("PROMPT_COMMAND")).toBe(true);
  });

  it("不阻止普通环境变量", () => {
    expect(isEnvVarDenied("HOME")).toBe(false);
    expect(isEnvVarDenied("USER")).toBe(false);
    expect(isEnvVarDenied("LANG")).toBe(false);
    expect(isEnvVarDenied("TERM")).toBe(true); // TERM 在黑名单中（保守）
    expect(isEnvVarDenied("MY_APP_CONFIG")).toBe(false);
  });

  it("filterDeniedEnvVars 移除黑名单项", () => {
    const env = {
      OPENAI_API_KEY: "sk-secret",
      HOME: "/home/user",
      LD_PRELOAD: "/evil.so",
      PYTHONPATH: "/evil",
      USER: "testuser",
      PATH: "/usr/bin",
    };
    const filtered = filterDeniedEnvVars(env);
    expect(filtered.OPENAI_API_KEY).toBeUndefined();
    expect(filtered.LD_PRELOAD).toBeUndefined();
    expect(filtered.PYTHONPATH).toBeUndefined();
    expect(filtered.PATH).toBeUndefined();
    expect(filtered.HOME).toBe("/home/user");
    expect(filtered.USER).toBe("testuser");
  });

  it("filterDeniedEnvVars 不修改输入", () => {
    const env = { OPENAI_API_KEY: "sk-secret", HOME: "/home" };
    filterDeniedEnvVars(env);
    expect(env.OPENAI_API_KEY).toBe("sk-secret");
  });
});

describe("command-guard > INVISIBLE_CHARS", () => {
  it("INVISIBLE_CHARS 非空", () => {
    expect(INVISIBLE_CHARS.size).toBeGreaterThan(0);
  });

  it("包含零宽字符", () => {
    expect(INVISIBLE_CHARS.has("\u200b")).toBe(true); // 零宽空格
    expect(INVISIBLE_CHARS.has("\u200c")).toBe(true); // 零宽非连接符
    expect(INVISIBLE_CHARS.has("\u200d")).toBe(true); // 零宽连接符
  });

  it("包含双向控制字符", () => {
    expect(INVISIBLE_CHARS.has("\u202e")).toBe(true); // RTL 覆盖
    expect(INVISIBLE_CHARS.has("\u202d")).toBe(true); // LTR 覆盖
    expect(INVISIBLE_CHARS.has("\u2066")).toBe(true); // LTR 隔离
  });

  it("包含 BOM", () => {
    expect(INVISIBLE_CHARS.has("\ufeff")).toBe(true);
  });
});

describe("command-guard > detectInvisibleChars", () => {
  it("无不可见字符返回空数组", () => {
    expect(detectInvisibleChars("hello world")).toEqual([]);
    expect(detectInvisibleChars("")).toEqual([]);
  });

  it("检测零宽空格", () => {
    const result = detectInvisibleChars("hello\u200bworld");
    expect(result).toContain("U+200B");
  });

  it("检测 RTL 覆盖字符", () => {
    const result = detectInvisibleChars("text\u202emore");
    expect(result).toContain("U+202E");
  });

  it("检测多个不可见字符（去重）", () => {
    const result = detectInvisibleChars("a\u200bb\u200bc\u202ed");
    expect(result).toContain("U+200B");
    expect(result).toContain("U+202E");
    expect(result.filter((c) => c === "U+200B").length).toBe(1); // 去重
  });

  it("检测 BOM", () => {
    const result = detectInvisibleChars("\ufeffhello");
    expect(result).toContain("U+FEFF");
  });
});
