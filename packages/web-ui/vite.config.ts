import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));

// 后端端口：优先 EvoClaw_PORT，其次根 .env 里的值，最后默认 27788。
// 旧配置写死 localhost:3000，而服务端从不监听 3000（默认 27788），
// 于是 `pnpm dev` 的界面所有 /api 请求都代理到空端口。
function resolveGatewayPort(): string {
  if (process.env.EvoClaw_PORT) return process.env.EvoClaw_PORT;
  try {
    const envText = readFileSync(resolve(__dirname, "../../.env"), "utf-8");
    const line = envText.split(/\r?\n/).find((l) => /^\s*EvoClaw_PORT\s*=/.test(l));
    const value = line?.split("=")[1]?.trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  } catch { /* no .env — fall through */ }
  return "27788";
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${resolveGatewayPort()}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // 应用主包较大（React 19 + 业务代码）。将第三方依赖拆分为独立 vendor chunk 以利浏览器
    // 长效缓存；同时提高 chunk 体积告警阈值，避免构建噪声（主应用 chunk 仍较大属预期）。
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) {
              return "react-vendor";
            }
            if (id.includes("qrcode")) return "qrcode";
            return "vendor";
          }
        },
      },
    },
  },
});
