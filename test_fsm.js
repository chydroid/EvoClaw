const path = require('path');
const fsSync = require('fs');
const { mkdir, writeFile, stat } = require('fs/promises');

const basePath = "D:/abc/EvoClaw";

function resolvePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized)) return normalized;
  if (normalized.startsWith("/")) return normalized;
  return `${basePath}/${normalized}`.replace(/\/+/g, "/");
}

async function validatePath(fullPath) {
  const normalizedFull = path.resolve(fullPath);
  console.log("  validatePath: resolve(", fullPath, ") =>", normalizedFull);
  const dangerousPatterns = ["/etc/passwd", "/etc/shadow", "/proc/", "/sys/", "C:\\Windows\\System32", "/dev/null"];
  for (const pattern of dangerousPatterns) {
    if (normalizedFull.toLowerCase().includes(pattern.toLowerCase())) {
      throw new Error(`Access denied`);
    }
  }
}

async function ensureDir(relativePath) {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  console.log("  ensureDir: parts =", JSON.stringify(parts));
  const dirs = parts.slice(0, -1).join("/");
  console.log("  ensureDir: dirs =", dirs);
  if (dirs) {
    const mkdirPath = resolvePath(dirs);
    console.log("  ensureDir: mkdir(", mkdirPath, ")");
    await mkdir(mkdirPath, { recursive: true });
  }
}

async function createFile(relativePath, content) {
  const fullPath = resolvePath(relativePath);
  console.log("createFile: relativePath =", relativePath);
  console.log("createFile: fullPath =", fullPath);
  await validatePath(fullPath);
  console.log("createFile: validatePath passed");
  
  if (fsSync.existsSync(fullPath)) {
    throw new Error(`File already exists: ${relativePath}`);
  }
  
  await ensureDir(relativePath);
  console.log("createFile: ensureDir passed");
  
  await writeFile(fullPath, content, "utf-8");
  console.log("createFile: writeFile done");
  
  const fileStat = await stat(fullPath);
  return { path: relativePath, size: fileStat.size };
}

async function test() {
  try {
    console.log("=== Test 1: createFile D:/newweb/.gitkeep ===");
    const result = await createFile("D:/newweb/.gitkeep", "");
    console.log("Result:", JSON.stringify(result));
    
    console.log("\n=== Test 2: createFile D:/newweb/index.html ===");
    const r2 = await createFile("D:/newweb/index.html", "<html></html>");
    console.log("Result:", JSON.stringify(r2));
    
    console.log("\n=== Test 3: createFile D:/newweb/style.css ===");
    const r3 = await createFile("D:/newweb/style.css", "body{}");
    console.log("Result:", JSON.stringify(r3));
    
    console.log("\n=== Test 4: createFile D:/newweb/script.js ===");
    const r4 = await createFile("D:/newweb/script.js", "console.log(1)");
    console.log("Result:", JSON.stringify(r4));
    
    console.log("\nALL TESTS PASSED!");
  } catch(e) {
    console.log("\nFAILED:", e.code, e.message);
    console.log("Stack:", e.stack);
  }
}
test();