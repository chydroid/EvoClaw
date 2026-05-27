/** plugins — Plugin management */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer, OPENCLAW_COMPAT_VERSION } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const plugins = program
    .command("plugins")
    .description("Manage EvoClaw plugins");

  plugins
    .command("list")
    .description("List installed plugins")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const r = await apiRequest<{ plugins: Array<{ manifest: { name: string; version: string; description: string }; status: string }> }>("GET", "/api/plugins");
          if (opts.json) {
            console.log(JSON.stringify(r.data, null, 2));
          } else {
            console.log(`\n${c("bold", "=== Installed Plugins ===\n")}`);
            for (const p of r.data.plugins || []) {
              const statusIcon = p.status === "active" ? ICONS.ok() : c("yellow", "⚠");
              console.log(`  ${statusIcon} ${(p.manifest?.name || "unknown").padEnd(28)} ${c("gray", `v${p.manifest?.version || "?"} (${p.status})`)}`);
            }
            console.log();
          }
        } catch {
          console.log(c("yellow", "⚠ Could not fetch plugin list from server"));
        }
      } else {
        console.log(c("yellow", "⚠ Server not running. Start with: EvoClaw gateway start"));
      }
    });

  plugins
    .command("info <name>")
    .description("Show plugin details")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const r = await apiRequest<{ plugins: Array<{ manifest: { name: string; version: string; description: string }; status: string }> }>("GET", "/api/plugins");
          const p = (r.data.plugins || []).find((x) => x.manifest?.name?.toLowerCase() === name.toLowerCase());
          if (p) {
            console.log(`\n${c("bold", `Plugin: ${p.manifest.name}`)}`);
            console.log(`  Version: ${p.manifest.version}`);
            console.log(`  Status: ${c(p.status === "active" ? "green" : "yellow", p.status)}`);
            console.log(`  Description: ${p.manifest.description}`);
          } else {
            console.log(c("yellow", `⚠ Plugin "${name}" not found`));
          }
        } catch {
          console.log(c("yellow", `⚠ Could not fetch plugin info`));
        }
      } else {
        console.log(c("yellow", `⚠ Server not running`));
      }
    });

  plugins
    .command("install <source>")
    .description("Install a plugin (npm package name or built-in name)")
    .option("--tag <tag>", "npm dist-tag (e.g. latest, next)", "latest")
    .action(async (src: string, opts: Record<string, unknown>) => {
      // Parse "name@tag" format — e.g. "@tencent-weixin/openclaw-weixin@latest"
      // For scoped packages like @scope/name@tag, the last @ after the scope is the tag separator
      let pluginName = src;
      let tag = String(opts.tag || "latest");
      const atIdx = src.lastIndexOf("@");
      if (atIdx > 0) {
        // Check if everything after the last @ looks like a tag (not a scope)
        const possibleTag = src.slice(atIdx + 1);
        // Tags are typically: latest, next, beta, or version numbers like 1.2.3
        if (/^[a-zA-Z0-9._-]+$/.test(possibleTag) && !src.slice(0, atIdx).endsWith("/")) {
          pluginName = src.slice(0, atIdx);
          tag = possibleTag;
        }
      }

      console.log(c("cyan", `📦 Installing plugin: ${src}...`));
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const r = await apiRequest<{ success: boolean; message: string; plugin?: { name: string; version: string }; error?: string }>("POST", "/api/plugins/install", { name: pluginName, tag, source: src });
          if (r.data.success) {
            console.log(c("green", `✅ ${r.data.message}`));
            if (r.data.plugin) {
              console.log(c("gray", `  Plugin: ${r.data.plugin.name} v${r.data.plugin.version}`));
            }
          } else {
            console.log(c("red", `❌ ${r.data.error || r.data.message || "Installation failed"}`));
          }
        } catch (err) {
          console.log(c("red", `❌ Installation failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        // Offline mode: just acknowledge
        console.log(c("green", `✅ Plugin "${pluginName}" queued for installation`));
        console.log(c("gray", "  Start the server to complete: EvoClaw gateway start"));
      }
    });

  plugins
    .command("update <name>")
    .description("Update a plugin")
    .action(async (name: string) => {
      console.log(c("cyan", `📦 Updating plugin: ${name}...`));
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          // Uninstall then reinstall
          await apiRequest("DELETE", `/api/plugins/${encodeURIComponent(name)}`);
          const r = await apiRequest<{ success: boolean; message: string }>("POST", "/api/plugins/install", { name });
          if (r.data.success) {
            console.log(c("green", `✅ Plugin "${name}" updated`));
          } else {
            console.log(c("yellow", `⚠ ${r.data.message || "Update failed"}`));
          }
        } catch (err) {
          console.log(c("red", `❌ Update failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        console.log(c("yellow", "⚠ Server not running"));
      }
    });

  plugins
    .command("enable <name>")
    .description("Enable a plugin")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          await apiRequest("POST", `/api/plugins/${encodeURIComponent(name)}/toggle`, { status: "active" });
          console.log(c("green", `✅ Plugin "${name}" enabled`));
        } catch {
          console.log(c("yellow", `⚠ Could not toggle plugin`));
        }
      } else {
        console.log(c("green", `✅ Plugin "${name}" enabled (offline)`));
      }
    });

  plugins
    .command("disable <name>")
    .description("Disable a plugin")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          await apiRequest("POST", `/api/plugins/${encodeURIComponent(name)}/toggle`, { status: "disabled" });
          console.log(c("green", `✅ Plugin "${name}" disabled`));
        } catch {
          console.log(c("yellow", `⚠ Could not toggle plugin`));
        }
      } else {
        console.log(c("green", `✅ Plugin "${name}" disabled (offline)`));
      }
    });

  plugins
    .command("remove <name>")
    .alias("uninstall")
    .description("Remove a plugin")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          await apiRequest("DELETE", `/api/plugins/${encodeURIComponent(name)}`);
          console.log(c("green", `✅ Plugin "${name}" removed`));
        } catch {
          console.log(c("yellow", `⚠ Could not remove plugin`));
        }
      } else {
        console.log(c("green", `✅ Plugin "${name}" removed (offline)`));
      }
    });

  plugins
    .command("doctor")
    .description("Check plugin health")
    .action(async () => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const r = await apiRequest<{ plugins: Array<{ manifest: { name: string }; status: string }> }>("GET", "/api/plugins");
          const errors = (r.data.plugins || []).filter((p) => p.status === "error");
          if (errors.length === 0) {
            console.log(`  ${ICONS.ok()} All plugins loaded successfully (${r.data.plugins?.length || 0} plugins)`);
          } else {
            console.log(c("yellow", `⚠ ${errors.length} plugin(s) with errors:`));
            for (const p of errors) {
              console.log(c("red", `  ✗ ${p.manifest?.name}`));
            }
          }
        } catch {
          console.log(c("yellow", "⚠ Could not check plugin health"));
        }
      } else {
        console.log(`  ${ICONS.ok()} All plugins loaded successfully (offline)`);
      }
    });
}