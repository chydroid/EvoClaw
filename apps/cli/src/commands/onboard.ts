import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, VERSION, DEFAULT_PORT } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("onboard")
    .description("Run guided onboarding to get started")
    .action(async () => {
      console.log(section("EvoClaw Onboarding"));

      console.log(c("cyan", "Step 1: Checking Gateway status..."));
      const serverAlive = await checkServer();
      if (serverAlive) {
        console.log(`  ${ICONS.ok()} Gateway is running`);
        try {
          const health = await apiRequest<Record<string, unknown>>("GET", "/health");
          console.log(`  ${ICONS.arrow()} Version: ${health.data.version || VERSION}`);
          console.log(`  ${ICONS.arrow()} Uptime: ${health.data.uptime || 0}s`);
        } catch {
          console.log(`  ${ICONS.arrow()} Health details unavailable`);
        }
      } else {
        console.log(`  ${ICONS.error()} Gateway is NOT running`);
        console.log(c("yellow", "  Start it with: EvoClaw gateway start"));
        console.log();
      }

      console.log();
      console.log(c("cyan", "Step 2: Checking LLM configuration..."));
      if (serverAlive) {
        try {
          const providersRes = await apiRequest<Array<Record<string, unknown>>>("GET", "/api/system/providers");
          const providers = providersRes.data || [];
          if (providers.length === 0) {
            console.log(`  ${ICONS.warn()} No LLM providers configured`);
            console.log(c("yellow", "  Open Web UI → LLM tab → add API key, or run: EvoClaw configure"));
          } else {
            const active = providers.filter((p: Record<string, unknown>) => p.status === "active");
            console.log(`  ${ICONS.ok()} ${active.length} active provider(s), ${providers.length} total`);
            for (const p of providers) {
              const icon = p.status === "active" ? ICONS.ok() : ICONS.warn();
              console.log(`  ${icon} ${p.name || p.provider} (${p.model || "default"}) — ${p.status}`);
              if (p.lastError) console.log(c("red", `     Last error: ${p.lastError}`));
            }
          }
        } catch {
          console.log(`  ${ICONS.warn()} Could not fetch provider info`);
        }
      } else {
        console.log(c("gray", "  Skipped (gateway offline)"));
      }

      console.log();
      console.log(c("cyan", "Step 3: Checking channels..."));
      if (serverAlive) {
        try {
          const chRes = await apiRequest<Record<string, unknown>>("GET", "/api/channels/status");
          const channels = (chRes.data as Record<string, unknown>)?.channels || [];
          const chList = channels as Array<Record<string, unknown>>;
          if (chList.length === 0) {
            console.log(`  ${ICONS.warn()} No channels configured`);
            console.log(c("gray", "  Optional: Open Web UI → Channels tab to add channels"));
          } else {
            const connected = chList.filter((ch: Record<string, unknown>) => ch.connected);
            console.log(`  ${ICONS.ok()} ${connected.length}/${chList.length} channel(s) connected`);
            for (const ch of chList) {
              const icon = ch.connected ? ICONS.ok() : ICONS.warn();
              console.log(`  ${icon} ${ch.label || ch.type} — ${ch.connected ? "connected" : "disconnected"}`);
            }
          }
        } catch {
          console.log(`  ${ICONS.warn()} Could not fetch channel status`);
        }
      } else {
        console.log(c("gray", "  Skipped (gateway offline)"));
      }

      console.log();
      console.log(c("cyan", "Step 4: Checking skills..."));
      if (serverAlive) {
        try {
          const skillsRes = await apiRequest<unknown[]>("GET", "/api/skills");
          const skills = skillsRes.data || [];
          if (skills.length === 0) {
            console.log(`  ${ICONS.warn()} No skills installed`);
            console.log(c("gray", "  Install one: EvoClaw skills install <slug>"));
          } else {
            console.log(`  ${ICONS.ok()} ${skills.length} skill(s) installed`);
            for (const sk of skills) {
              const s = sk as Record<string, unknown>;
              console.log(`  ${ICONS.bullet()} ${s.name} ${c("gray", `v${s.version}`)}`);
            }
          }
        } catch {
          console.log(`  ${ICONS.warn()} Could not fetch skills`);
        }
      } else {
        console.log(c("gray", "  Skipped (gateway offline)"));
      }

      console.log();
      console.log(c("cyan", "Step 5: Checking bootstrap status..."));
      if (serverAlive) {
        try {
          const bsRes = await apiRequest<Record<string, unknown>>("GET", "/api/bootstrap");
          const bsData = bsRes.data || {};
          if (bsData.pending) {
            console.log(`  ${ICONS.warn()} Bootstrap is pending`);
            const missing = (bsData.missingFiles as string[]) || [];
            if (missing.length > 0) {
              console.log(c("yellow", `  Missing files: ${missing.join(", ")}`));
            }
            console.log(c("gray", "  Complete bootstrap via Web UI or: EvoClaw configure"));
          } else {
            console.log(`  ${ICONS.ok()} Bootstrap completed`);
            try {
              await apiRequest("POST", "/api/bootstrap/complete");
            } catch { /* already completed */ }
          }
        } catch {
          console.log(`  ${ICONS.warn()} Could not check bootstrap status`);
        }
      } else {
        console.log(c("gray", "  Skipped (gateway offline)"));
      }

      console.log();
      if (serverAlive) {
        console.log(c("green", `${ICONS.ok()} Onboarding check complete!`));
        console.log(c("gray", `  Dashboard: http://localhost:${DEFAULT_PORT}`));
      } else {
        console.log(c("yellow", `${ICONS.warn()} Start the gateway first: EvoClaw gateway start`));
        console.log(c("gray", "  Then re-run: EvoClaw onboard"));
      }
      console.log();
    });
}
