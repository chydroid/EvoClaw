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
    const envLines = Object.entries({
      NODE_ENV: "production",
      ...this.config.env,
    })
      .map(([k, v]) => `Environment="${k}=${v}"`)
      .join("\n");

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

  // ── Platform: launchd (macOS) ──────────────────────────────────────

  private installLaunchd(): { success: boolean; message: string; platform: string } {
    try {
      const plistPath = this.getLaunchdPlistPath();
      const envDict = Object.entries({
        NODE_ENV: "production",
        ...this.config.env,
      })
        .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
        .join("\n");

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${this.config.serviceName}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${this.config.executablePath}</string>
    ${this.config.args.map((a) => `<string>${a}</string>`).join("\n    ")}
  </array>

  <key>WorkingDirectory</key>
  <string>${this.config.workingDirectory}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envDict}
  </dict>

  <key>RunAtLoad</key>
  <${this.config.autoStart}/>

  <key>KeepAlive</key>
  <${this.config.restartOnCrash}/>

  <key>StandardOutPath</key>
  <string>${this.config.logPath}</string>

  <key>StandardErrorPath</key>
  <string>${this.config.logPath}</string>

  <key>UserName</key>
  <string>${this.config.runAsUser}</string>

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
        .map(([k, v]) => `    <env name="${k}" value="${v}"/>`)
        .join("\n");

      const xml = `<service>
  <id>${this.config.serviceName}</id>
  <name>${this.config.displayName}</name>
  <description>${this.config.description}</description>
  <executable>${this.config.executablePath}</executable>
  <arguments>${this.config.args.join(" ")}</arguments>
  <workingdirectory>${this.config.workingDirectory}</workingdirectory>
  <logpath>${path.dirname(this.config.logPath)}</logpath>
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

      execSync(
        `sc create ${this.config.serviceName} binPath= "${binPath}" start= ${startMode} DisplayName= "${this.config.displayName}"`
      );

      if (this.config.restartOnCrash) {
        execSync(
          `sc failure ${this.config.serviceName} reset= 86400 actions= restart/${this.config.restartDelaySec * 1000}`
        );
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
    try {
      if (os.platform() === "win32") {
        execSync(`where ${cmd}`, { stdio: "ignore" });
      } else {
        execSync(`which ${cmd}`, { stdio: "ignore" });
      }
      return true;
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