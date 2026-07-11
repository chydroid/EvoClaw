/**
 * Daemon Manager — cross-platform service installation for running
 * EvoClaw as a background daemon process.
 *
 * Supports:
 *  - Linux:   systemd service unit
 *  - macOS:   launchd plist (user agent)
 *  - Windows: Windows Service (via nssm or winsw)
 *
 * Provides install, uninstall, start, stop, restart, and status
 * operations. All operations are idempotent.
 */

import { spawn, execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface DaemonConfig {
  /** Service name (default: "evoclaw") */
  serviceName?: string;
  /** Display name (default: "EvoClaw Agent") */
  displayName?: string;
  /** Description */
  description?: string;
  /** Path to the EvoClaw executable/script */
  executablePath?: string;
  /** Working directory */
  workingDirectory?: string;
  /** Command line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Whether to auto-start on boot */
  autoStart?: boolean;
  /** Whether to restart on crash */
  restartOnCrash?: boolean;
  /** Restart delay in seconds (default: 10) */
  restartDelaySec?: number;
  /** User to run as (Linux/macOS only) */
  runAsUser?: string;
  /** Log output path */
  logPath?: string;
}

export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  platform: NodeJS.Platform;
  serviceName: string;
  pid?: number;
  uptime?: number;
  error?: string;
}

export class DaemonManager {
  private config: Required<DaemonConfig>;

  constructor(config: DaemonConfig = {}) {
    const serviceName = config.serviceName ?? "evoclaw";
    // Validate serviceName to prevent command injection in shell commands
    if (!/^[a-zA-Z0-9_-]+$/.test(serviceName)) {
      throw new Error("serviceName must only contain alphanumeric characters, hyphens, and underscores");
    }
    this.config = {
      serviceName,
      displayName: config.displayName ?? "EvoClaw Agent",
      description: config.description ?? "EvoClaw — Self-Evolving AI Agent Operating System",
      executablePath: config.executablePath ?? process.execPath,
      workingDirectory: config.workingDirectory ?? process.cwd(),
      args: config.args ?? ["apps/server/dist/index.js"],
      env: config.env ?? {},
      autoStart: config.autoStart ?? true,
      restartOnCrash: config.restartOnCrash ?? true,
      restartDelaySec: config.restartDelaySec ?? 10,
      runAsUser: config.runAsUser ?? os.userInfo().username,
      logPath: config.logPath ?? path.join(process.cwd(), "data", "logs", "daemon.log"),
    };
  }

  // ── Install ────────────────────────────────────────────────────────

  async install(): Promise<{ success: boolean; message: string; platform: string }> {
    const platform = os.platform();

    switch (platform) {
      case "linux":
        return this.installSystemd();
      case "darwin":
        return this.installLaunchd();
      case "win32":
        return this.installWindows();
      default:
        return {
          success: false,
          message: `Unsupported platform: ${platform}`,
          platform,
        };
    }
  }

  async uninstall(): Promise<{ success: boolean; message: string }> {
    const platform = os.platform();

    switch (platform) {
      case "linux":
        return this.uninstallSystemd();
      case "darwin":
        return this.uninstallLaunchd();
      case "win32":
        return this.uninstallWindows();
      default:
        return {
          success: false,
          message: `Unsupported platform: ${platform}`,
        };
    }
  }

  async getStatus(): Promise<DaemonStatus> {
    const platform = os.platform();
    const status: DaemonStatus = {
      installed: this.isInstalled(),
      running: false,
      platform,
      serviceName: this.config.serviceName,
    };

    try {
      if (platform === "linux") {
        const output = this.execSyncStdout(`systemctl is-active ${this.config.serviceName}`);
        status.running = output.trim() === "active";
      } else if (platform === "darwin") {
        const output = this.execSyncStdout(
          `launchctl list | grep ${this.config.serviceName}`
        );
        status.running = output.includes(this.config.serviceName);
      } else if (platform === "win32") {
        const output = this.execSyncStdout(
          `sc query ${this.config.serviceName}`
        );
        status.running = output.includes("RUNNING");
      }
    } catch {
      status.running = false;
      status.error = "Could not determine service status";
    }

    return status;
  }

  // ── Service Control ────────────────────────────────────────────────

  async start(): Promise<{ success: boolean; message: string }> {
    try {
      const platform = os.platform();
      if (platform === "linux") {
        execSync(`systemctl start ${this.config.serviceName}`);
        return { success: true, message: "Service started" };
      } else if (platform === "darwin") {
        const plist = this.getLaunchdPlistPath();
        execSync(`launchctl load ${plist}`);
        return { success: true, message: "Service started" };
      } else if (platform === "win32") {
        execSync(`sc start ${this.config.serviceName}`);
        return { success: true, message: "Service started" };
      }
      return { success: false, message: "Unsupported platform" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    try {
      const platform = os.platform();
      if (platform === "linux") {
        execSync(`systemctl stop ${this.config.serviceName}`);
        return { success: true, message: "Service stopped" };
      } else if (platform === "darwin") {
        const plist = this.getLaunchdPlistPath();
        execSync(`launchctl unload ${plist}`);
        return { success: true, message: "Service stopped" };
      } else if (platform === "win32") {
        execSync(`sc stop ${this.config.serviceName}`);
        return { success: true, message: "Service stopped" };
      }
      return { success: false, message: "Unsupported platform" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async restart(): Promise<{ success: boolean; message: string }> {
    const stopResult = await this.stop();
    const startResult = await this.start();
    return {
      success: startResult.success,
      message: `Stop: ${stopResult.message}; Start: ${startResult.message}`,
    };
  }

  // ── Platform: systemd (Linux) ──────────────────────────────────────

  private installSystemd(): { success: boolean; message: string; platform: string } {
    try {
      const unitPath = this.getSystemdUnitPath();
      const unitContent = this.generateSystemdUnit();

      // Ensure log directory exists
      const logDir = path.dirname(this.config.logPath);
      fs.mkdirSync(logDir, { recursive: true });

      // Write unit file
      fs.writeFileSync(unitPath, unitContent, "utf-8");

      // Reload systemd, enable and start
      execSync("systemctl daemon-reload");

      if (this.config.autoStart) {
        execSync(`systemctl enable ${this.config.serviceName}`);
      }

      process.stdout.write(`[DaemonManager] systemd service installed at ${unitPath}\n`);
      return {
        success: true,
        message: `systemd service "${this.config.serviceName}" installed`,
        platform: "linux",
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
        platform: "linux",
      };
    }
  }

  private uninstallSystemd(): { success: boolean; message: string } {
    try {
      execSync(`systemctl stop ${this.config.serviceName}`, { stdio: "ignore" });
      execSync(`systemctl disable ${this.config.serviceName}`, { stdio: "ignore" });

      const unitPath = this.getSystemdUnitPath();
      if (fs.existsSync(unitPath)) {
        fs.unlinkSync(unitPath);
      }
      execSync("systemctl daemon-reload");

      return { success: true, message: "systemd service removed" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getSystemdUnitPath(): string {
    // User services go to ~/.config/systemd/user/
    const userDir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(userDir, { recursive: true });
    return path.join(userDir, `${this.config.serviceName}.service`);
  }

  private generateSystemdUnit(): string {
    // 校验所有 config 字段，防止 systemd 指令注入
    this.validateNoNewline(this.config.description, "description");
    this.validateNoNewline(this.config.executablePath, "executablePath");
    this.validateNoNewline(this.config.workingDirectory, "workingDirectory");
    this.validateNoNewline(this.config.logPath, "logPath");
    this.config.args.forEach((a, i) =>
      this.validateNoNewline(a, `args[${i}]`)
    );

    // runAsUser 必须只含字母、数字、下划线、连字符
    if (!/^[a-zA-Z0-9_-]+$/.test(this.config.runAsUser)) {
      throw new Error(
        `Invalid runAsUser: "${this.config.runAsUser}" must match /^[a-zA-Z0-9_-]+$/`
      );
    }

    const envEntries = Object.entries({
      NODE_ENV: "production",
      ...this.config.env,
    }).map(([k, v]) => {
      // env key 必须是合法的 POSIX 环境变量名
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        throw new Error(`Invalid env key: ${k}`);
      }
      // env value 不得含换行符（防止注入 systemd 指令）
      this.validateNoNewline(String(v), `env[${k}]`);
      return `Environment="${k}=${v}"`;
    });
    const envLines = envEntries.join("\n");

    return `[Unit]
Description=${this.config.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${this.config.runAsUser}
WorkingDirectory=${this.config.workingDirectory}
ExecStart=${this.config.executablePath} ${this.config.args.join(" ")}
Restart=${this.config.restartOnCrash ? "always" : "no"}
RestartSec=${this.config.restartDelaySec}
${envLines}
StandardOutput=append:${this.config.logPath}
StandardError=append:${this.config.logPath}

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${this.config.workingDirectory}
PrivateTmp=yes

[Install]
WantedBy=default.target
`;
  }

  /** 校验字符串字段不得含换行符（防止 systemd/launchd 指令注入） */
  private validateNoNewline(value: string, fieldName: string): void {
    if (typeof value === "string" && /[\r\n]/.test(value)) {
      throw new Error(
        `Invalid ${fieldName}: must not contain newline characters`
      );
    }
  }

  /**
   * XML 实体转义：对插入 XML plist / WinSW 配置的用户值进行转义，
   * 防止 & < > " 等字符破坏 XML 结构或注入新的标签节点。
   * 注意：& 必须最先替换，避免二次转义。
   */
  private xmlEscape(value: string): string {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Platform: launchd (macOS) ──────────────────────────────────────

  private installLaunchd(): { success: boolean; message: string; platform: string } {
    try {
      const plistPath = this.getLaunchdPlistPath();
      const envDict = Object.entries({
        NODE_ENV: "production",
        ...this.config.env,
      })
        .map(([k, v]) => `    <key>${this.xmlEscape(k)}</key>\n    <string>${this.xmlEscape(v)}</string>`)
        .join("\n");

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${this.xmlEscape(this.config.serviceName)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${this.xmlEscape(this.config.executablePath)}</string>
    ${this.config.args.map((a) => `<string>${this.xmlEscape(a)}</string>`).join("\n    ")}
  </array>

  <key>WorkingDirectory</key>
  <string>${this.xmlEscape(this.config.workingDirectory)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envDict}
  </dict>

  <key>RunAtLoad</key>
  <${this.config.autoStart}/>

  <key>KeepAlive</key>
  <${this.config.restartOnCrash}/>

  <key>StandardOutPath</key>
  <string>${this.xmlEscape(this.config.logPath)}</string>

  <key>StandardErrorPath</key>
  <string>${this.xmlEscape(this.config.logPath)}</string>

  <key>UserName</key>
  <string>${this.xmlEscape(this.config.runAsUser)}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>`;

      fs.writeFileSync(plistPath, plistContent, "utf-8");

      // Load the launchd agent
      if (this.config.autoStart) {
        execSync(`launchctl load ${plistPath}`);
      }

      process.stdout.write(`[DaemonManager] launchd agent installed at ${plistPath}\n`);
      return {
        success: true,
        message: `launchd agent "${this.config.serviceName}" installed`,
        platform: "darwin",
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
        platform: "darwin",
      };
    }
  }

  private uninstallLaunchd(): { success: boolean; message: string } {
    try {
      const plistPath = this.getLaunchdPlistPath();
      execSync(`launchctl unload ${plistPath}`, { stdio: "ignore" });

      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
      }

      return { success: true, message: "launchd agent removed" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getLaunchdPlistPath(): string {
    const launchDir = path.join(os.homedir(), "Library", "LaunchAgents");
    fs.mkdirSync(launchDir, { recursive: true });
    return path.join(launchDir, `com.evoclaw.${this.config.serviceName}.plist`);
  }

  // ── Platform: Windows Service ──────────────────────────────────────

  private installWindows(): { success: boolean; message: string; platform: string } {
    try {
      // Try nssm first, then fall back to sc
      const hasNSSM = this.checkCommand("nssm");
      const hasWinSW = this.checkCommand("winsw");

      if (hasNSSM) {
        return this.installWindowsNSSM();
      } else if (hasWinSW) {
        return this.installWindowsWinSW();
      } else {
        return this.installWindowsSC();
      }
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
        platform: "win32",
      };
    }
  }

  private installWindowsNSSM(): { success: boolean; message: string; platform: string } {
    try {
      // Stop existing if running
      spawnSync("nssm", ["stop", this.config.serviceName], { stdio: "ignore", shell: false });

      spawnSync(
        "nssm",
        ["install", this.config.serviceName, this.config.executablePath, ...this.config.args],
        { shell: false }
      );

      spawnSync(
        "nssm",
        ["set", this.config.serviceName, "AppDirectory", this.config.workingDirectory],
        { shell: false }
      );
      spawnSync(
        "nssm",
        ["set", this.config.serviceName, "DisplayName", this.config.displayName],
        { shell: false }
      );
      spawnSync(
        "nssm",
        ["set", this.config.serviceName, "Description", this.config.description],
        { shell: false }
      );

      if (this.config.autoStart) {
        spawnSync("nssm", ["set", this.config.serviceName, "Start", "SERVICE_AUTO_START"], { shell: false });
      }

      for (const [k, v] of Object.entries({ NODE_ENV: "production", ...this.config.env })) {
        spawnSync("nssm", ["set", this.config.serviceName, "AppEnvironmentExtra", `${k}=${v}`], { shell: false });
      }

      process.stdout.write(`[DaemonManager] Windows Service installed via nssm\n`);
      return {
        success: true,
        message: `Windows Service "${this.config.serviceName}" installed (nssm)`,
        platform: "win32",
      };
    } catch (err) {
      return {
        success: false,
        message: `nssm error: ${err instanceof Error ? err.message : String(err)}`,
        platform: "win32",
      };
    }
  }

  private installWindowsWinSW(): { success: boolean; message: string; platform: string } {
    try {
      const xmlPath = path.join(
        this.config.workingDirectory,
        `${this.config.serviceName}.xml`
      );

      const envEntries = Object.entries({ NODE_ENV: "production", ...this.config.env })
        .map(([k, v]) => `    <env name="${this.xmlEscape(k)}" value="${this.xmlEscape(v)}"/>`)
        .join("\n");

      const xml = `<service>
  <id>${this.xmlEscape(this.config.serviceName)}</id>
  <name>${this.xmlEscape(this.config.displayName)}</name>
  <description>${this.xmlEscape(this.config.description)}</description>
  <executable>${this.xmlEscape(this.config.executablePath)}</executable>
  <arguments>${this.config.args.map((a) => this.xmlEscape(a)).join(" ")}</arguments>
  <workingdirectory>${this.xmlEscape(this.config.workingDirectory)}</workingdirectory>
  <logpath>${this.xmlEscape(path.dirname(this.config.logPath))}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
${envEntries}
  <startmode>${this.config.autoStart ? "Automatic" : "Manual"}</startmode>
</service>`;

      fs.writeFileSync(xmlPath, xml, "utf-8");

      const winswPath = path.join(this.config.workingDirectory, "winsw.exe");
      execSync(`"${winswPath}" install`);
      if (this.config.autoStart) {
        execSync(`"${winswPath}" start`);
      }

      return {
        success: true,
        message: `Windows Service "${this.config.serviceName}" installed (WinSW)`,
        platform: "win32",
      };
    } catch (err) {
      return {
        success: false,
        message: `WinSW error: ${err instanceof Error ? err.message : String(err)}`,
        platform: "win32",
      };
    }
  }

  private installWindowsSC(): { success: boolean; message: string; platform: string } {
    try {
      const binPath = `"${this.config.executablePath}" ${this.config.args.join(" ")}`;
      const startMode = this.config.autoStart ? "auto" : "demand";

      // 使用 spawnSync 数组形式避免 shell 解析 binPath/displayName 中的特殊字符
      const createResult = spawnSync(
        "sc",
        ["create", this.config.serviceName, "binPath=", binPath, "start=", startMode, "DisplayName=", this.config.displayName],
        { shell: false, stdio: "ignore" }
      );
      if (createResult.status !== 0) {
        throw new Error(
          `sc create failed with exit code ${createResult.status}: ${createResult.stderr?.toString() ?? ""}`
        );
      }

      if (this.config.restartOnCrash) {
        const failureResult = spawnSync(
          "sc",
          ["failure", this.config.serviceName, "reset=", "86400", "actions=", `restart/${this.config.restartDelaySec * 1000}`],
          { shell: false, stdio: "ignore" }
        );
        if (failureResult.status !== 0) {
          throw new Error(
            `sc failure failed with exit code ${failureResult.status}: ${failureResult.stderr?.toString() ?? ""}`
          );
        }
      }

      process.stdout.write(`[DaemonManager] Windows Service installed via sc\n`);
      return {
        success: true,
        message: `Windows Service "${this.config.serviceName}" installed (sc)`,
        platform: "win32",
      };
    } catch (err) {
      return {
        success: false,
        message: `sc error: ${err instanceof Error ? err.message : String(err)}`,
        platform: "win32",
      };
    }
  }

  private uninstallWindows(): { success: boolean; message: string } {
    try {
      // Try multiple approaches
      try { spawnSync("nssm", ["remove", this.config.serviceName, "confirm"], { stdio: "ignore", shell: false }); } catch { /* not nssm */ }
      try { execSync(`sc delete ${this.config.serviceName}`, { stdio: "ignore" }); } catch { /* not sc */ }

      return { success: true, message: "Windows Service removed" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private isInstalled(): boolean {
    const platform = os.platform();
    try {
      if (platform === "linux") return fs.existsSync(this.getSystemdUnitPath());
      if (platform === "darwin") return fs.existsSync(this.getLaunchdPlistPath());
      if (platform === "win32") {
        const output = this.execSyncStdout(
          `sc query ${this.config.serviceName}`
        );
        return !output.includes("1060"); // 1060 = service not found
      }
      return false;
    } catch {
      return false;
    }
  }

  private checkCommand(cmd: string): boolean {
    // 校验 cmd 格式，拒绝含 shell 元字符的输入（防止 where/which 命令注入）
    if (!/^[a-zA-Z0-9_\-\/.]+$/.test(cmd)) {
      return false;
    }
    try {
      // spawnSync 不会在非零退出码时抛异常，需显式检查 status
      const result = os.platform() === "win32"
        ? spawnSync("where", [cmd], { shell: false, stdio: "ignore" })
        : spawnSync("which", [cmd], { shell: false, stdio: "ignore" });
      // status === 0 表示命令存在；null 表示 where/which 自身启动失败
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private execSyncStdout(command: string): string {
    try {
      return execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  }
}