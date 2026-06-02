import * as dns from "dns";
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";

interface DnsResult {
  hostname?: string;
  address?: string;
  addresses?: string[];
  reverse?: string[];
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const dnsCmd = program
    .command("dns")
    .description("DNS lookup tool (OpenClaw compatible)");

  dnsCmd
    .argument("<hostname>", "Hostname to resolve")
    .option("--reverse <ip>", "Reverse DNS lookup for IP address")
    .option("--json", "Output as JSON")
    .action(async (hostname: string, opts: Record<string, unknown>) => {
      if (opts.reverse) {
        const ip = opts.reverse as string;
        try {
          const hostnames = await new Promise<string[]>((resolve, reject) => {
            dns.reverse(ip, (err, hostnames) => {
              if (err) reject(err);
              else resolve(hostnames);
            });
          });

          if (opts.json) {
            const result: DnsResult = { address: ip, reverse: hostnames };
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(section(`Reverse DNS: ${ip}`));
          if (hostnames.length === 0) {
            console.log(c("gray", "  No reverse DNS records found."));
          } else {
            for (const h of hostnames) {
              console.log(`  ${ICONS.arrow()} ${c("cyan", h)}`);
            }
          }
        } catch (err: any) {
          if (opts.json) {
            console.log(JSON.stringify({ error: err.message, address: ip }, null, 2));
          } else {
            console.log(c("red", `${ICONS.error()} Reverse lookup failed for ${ip}: ${err.message}`));
          }
        }
        return;
      }

      try {
        const addresses = await new Promise<string[]>((resolve, reject) => {
          dns.resolve4(hostname, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
          });
        });

        let ipv6Addresses: string[] = [];
        try {
          ipv6Addresses = await new Promise<string[]>((resolve, reject) => {
            dns.resolve6(hostname, (err, addresses) => {
              if (err) reject(err);
              else resolve(addresses);
            });
          });
        } catch {}

        if (opts.json) {
          const result: DnsResult = {
            hostname,
            addresses: [...addresses, ...ipv6Addresses],
          };
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(section(`DNS Lookup: ${hostname}`));
        if (addresses.length > 0) {
          console.log(`  ${ICONS.arrow()} A Records:`);
          for (const addr of addresses) {
            console.log(`    ${ICONS.bullet()} ${c("green", addr)}`);
          }
        }
        if (ipv6Addresses.length > 0) {
          console.log(`  ${ICONS.arrow()} AAAA Records:`);
          for (const addr of ipv6Addresses) {
            console.log(`    ${ICONS.bullet()} ${c("cyan", addr)}`);
          }
        }
      } catch (err: any) {
        if (opts.json) {
          console.log(JSON.stringify({ error: err.message, hostname }, null, 2));
        } else {
          console.log(c("red", `${ICONS.error()} DNS lookup failed for ${hostname}: ${err.message}`));
        }
      }
    });
}
