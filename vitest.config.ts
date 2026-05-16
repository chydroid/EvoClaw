import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "evoclaw-ts-resolver",
      enforce: "pre",
      resolveId(source: string, importer: string | undefined) {
        if (source.startsWith("\0")) return undefined;

        if (source.endsWith(".js") && !source.startsWith("node:")) {
          const tsSource = source.slice(0, -3) + ".ts";
          return this.resolve(tsSource, importer, { skipSelf: true });
        }

        return undefined;
      },
    },
  ],
  resolve: {
    extensions: [".ts", ".js", ".mjs", ".json"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    typecheck: {
      tsconfig: "tsconfig.base.json",
    },
  },
});