import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
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
