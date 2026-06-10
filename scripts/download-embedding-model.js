// Pre-download the embedding model from a Chinese mirror (hf-mirror.com) into
// the local cache so the next server start picks it up instantly.
//
// Run from the @evoclaw/memory package directory so the script can resolve
// @huggingface/transformers via the package's own node_modules:
//
//   cd packages/memory
//   HF_ENDPOINT=https://hf-mirror.com node ../../scripts/download-embedding-model.js
//
// Cache locations:
//   - HF_HOME env var, if set
//   - ~/.cache/huggingface (default on Linux/macOS)
//   - %USERPROFILE%\.cache\huggingface (default on Windows)

const path = require("path");
const fs = require("fs");
const os = require("os");

const MODEL = process.env.MODEL_NAME || "Xenova/all-MiniLM-L6-v2";
const ENDPOINT = process.env.HF_ENDPOINT || "https://hf-mirror.com";

(async () => {
  process.env.HF_ENDPOINT = ENDPOINT;

  console.log(`[download-embedding-model] Endpoint: ${ENDPOINT}`);
  console.log(`[download-embedding-model] Model:    ${MODEL}`);

  const cacheRoot =
    process.env.HF_HOME ||
    path.join(
      process.env.USERPROFILE || process.env.HOME || os.homedir(),
      ".cache",
      "huggingface"
    );
  console.log(`[download-embedding-model] Cache:    ${cacheRoot}`);
  fs.mkdirSync(cacheRoot, { recursive: true });

  let transformers;
  try {
    // Resolve from the script's own location by going up two levels to the
    // repo root, then into packages/memory. This works whether the script is
    // run from the repo root (path.resolve handles it) or from packages/memory.
    const candidates = [
      // scripts/ is at d:/abc/EvoClaw/scripts; repo root is two levels up
      path.resolve(__dirname, ".."),
      // If run from packages/memory as cwd, find the install in same dir's
      // node_modules. createRequire on a file inside packages/memory picks up
      // packages/memory's node_modules.
      process.cwd(),
      path.resolve(__dirname, "..", "packages", "memory"),
    ];
    for (const root of candidates) {
      try {
        const pkgPath = path.join(root, "node_modules", "@huggingface", "transformers");
        if (!fs.existsSync(pkgPath)) continue;
        transformers = require(pkgPath);
        console.log(`[download-embedding-model] Resolved from: ${pkgPath}`);
        break;
      } catch {
        /* try next */
      }
    }
    if (!transformers) throw new Error("Not found in any candidate root");
  } catch (err) {
    console.error(
      "[download-embedding-model] FAILED to import @huggingface/transformers:",
      err.message
    );
    console.error("Run from packages/memory or repo root after `pnpm install`.");
    process.exit(1);
  }

  try {
    // transformers.js v4 hard-codes env.remoteHost = "https://huggingface.co/".
    // It does NOT read HF_ENDPOINT. Patch the live env object's remoteHost
    // (and its `_remoteHost` mirror) so subsequent downloads go to the mirror.
    if (transformers.env) {
      transformers.env.remoteHost = ENDPOINT.endsWith("/") ? ENDPOINT : ENDPOINT + "/";
      // Some versions also store a private mirror; patch defensively.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const env = transformers.env;
      for (const k of Object.keys(env)) {
        const v = env[k];
        if (typeof v === "string" && v.includes("huggingface.co")) {
          env[k] = v.replace(/https?:\/\/huggingface\.co\/?/g, ENDPOINT);
        }
      }
      // Enable verbose logging so we can see what URLs are being hit.
      try {
        env.logLevel = "info";
      } catch {
        /* readonly */
      }
      console.log(`[download-embedding-model] env.remoteHost = ${transformers.env.remoteHost}`);
    } else {
      console.warn("[download-embedding-model] transformers.env not exported; mirror not applied");
    }
  } catch (err) {
    console.warn("[download-embedding-model] Could not patch env.remoteHost:", err.message);
  }

  console.log(
    "[download-embedding-model] Loading pipeline (this triggers the download if not cached)..."
  );
  const t0 = Date.now();
  const pipe = await transformers.pipeline("feature-extraction", MODEL, {
    dtype: "fp32",
  });
  console.log(
    `[download-embedding-model] Pipeline ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );

  const out = await pipe("hello world", { pooling: "mean", normalize: true });
  console.log(
    `[download-embedding-model] Embedding dims=${out.dims}, length=${out.data.length}`
  );

  console.log("[download-embedding-model] SUCCESS — model is cached and loadable.");
  process.exit(0);
})().catch((err) => {
  console.error("[download-embedding-model] FAILED:", err);
  process.exit(1);
});
