import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:27788";
const SCREENSHOTS = {
  zh: path.resolve("d:\\abc\\EvoClaw\\screenshots\\zh"),
  en: path.resolve("d:\\abc\\EvoClaw\\screenshots\\en"),
};

const PAGES = [
  { id: "evolution", name: "evolution", labelZh: "进化", labelEn: "Evolution" },
  { id: "workboard", name: "workboard", labelZh: "工作台", labelEn: "Workboard" },
  { id: "dashboard", name: "dashboard", labelZh: "仪表盘", labelEn: "Dashboard" },
  { id: "observability", name: "observability", labelZh: "可观测性", labelEn: "Observability" },
  { id: "token-usage", name: "token-usage", labelZh: "Token用量", labelEn: "Token Usage" },
  { id: "stream-view", name: "stream-view", labelZh: "流视图", labelEn: "Stream View" },
  { id: "permissions", name: "permissions", labelZh: "权限", labelEn: "Permissions" },
  { id: "mcp-scanner", name: "mcp-scanner", labelZh: "MCP扫描", labelEn: "MCP Scanner" },
  { id: "reply-refs", name: "reply-refs", labelZh: "引用回复", labelEn: "Reply References" },
  { id: "message-queue", name: "message-queue", labelZh: "消息队列", labelEn: "Message Queue" },
  { id: "channel-messages", name: "channel-messages", labelZh: "通道消息", labelEn: "Channel Messages" },
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function waitForContent(page, timeout = 10000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(800);
}

async function clickNav(page, itemId, lang) {
  // Try clicking the nav button by text in both languages
  const labels = PAGES.find(p => p.id === itemId);
  const texts = lang === "zh" ? [labels.labelZh, labels.labelEn] : [labels.labelEn, labels.labelZh];
  for (const text of texts) {
    const locator = page.locator("nav button", { hasText: text }).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  // Fallback: evaluate JS to set active tab via localStorage/AppState isn't exposed; use URL hash not available.
  // Try sidebar buttons with matching title/aria not possible. Just log failure.
  return false;
}

async function switchLang(page, targetLang) {
  const btn = page.locator("header button", { hasText: /EN|ZH|中文|English/ }).first();
  if (await btn.isVisible().catch(() => false)) {
    const current = await btn.textContent();
    // The button label shows the language you will switch TO.
    const targetPattern = targetLang === "zh" ? /中文|ZH/ : /English|EN/;
    const needSwitch = !targetPattern.test(current);
    if (needSwitch) await btn.click();
    await page.waitForTimeout(600);
  }
}

function setupErrorCollection(page) {
  const errors = [];
  page.on("pageerror", err => errors.push({ type: "pageerror", message: err.message }));
  page.on("console", msg => {
    if (msg.type() === "error") errors.push({ type: "console", text: msg.text() });
  });
  return () => errors.slice();
}

async function collectErrors(page) {
  return setupErrorCollection(page);
}

async function detectUntranslated(page) {
  // Heuristic: in Chinese mode, visible text nodes that are purely ASCII letters/numbers/symbols longer than 3 chars
  return await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      if (/^[\x00-\x7F]+$/.test(text) && text.length > 3 && !/^\d+(\.\d+)?$/.test(text) && !/^[\s\-\|\/\:\(\)\[\]\{\}\,\.]+$/.test(text)) {
        // Exclude common non-translatable tokens
        if (/^(ID|API|URL|HTTP|HTTPS|LLM|MCP|JWT|UI|GB|MB|KB|ms|s|k|M|ok|OK|ON|OFF|v\d+\.\d+)$/.test(text)) continue;
        const parent = node.parentElement;
        if (parent) {
          const tag = parent.tagName.toLowerCase();
          if (["script", "style", "noscript", "code", "pre"].includes(tag)) continue;
        }
        results.push(text.slice(0, 120));
      }
    }
    return [...new Set(results)].slice(0, 30);
  });
}

async function main() {
  ensureDir(SCREENSHOTS.zh);
  ensureDir(SCREENSHOTS.en);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const getAllErrors = setupErrorCollection(page);

  const report = { zh: [], en: [], errors: [] };

  for (const lang of ["zh", "en"]) {
    await page.goto(BASE);
    await waitForContent(page);

    // Auth screen may appear if cookie not set; try default token
    const authInput = page.locator('input[type="password"]').first();
    if (await authInput.isVisible().catch(() => false)) {
      await authInput.fill("evoclaw-202620262026");
      await page.locator('button', { hasText: /登录|Login|进入|Submit/ }).first().click();
      await page.waitForTimeout(1000);
    }

    await switchLang(page, lang);

    for (const item of PAGES) {
      const clicked = await clickNav(page, item.id, lang);
      await page.waitForTimeout(1000);
      await waitForContent(page);

      const screenshotPath = path.join(SCREENSHOTS[lang], `${item.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const hasRenderError = await page.locator("text=Render Error").isVisible().catch(() => false);
      const untranslated = lang === "zh" ? await detectUntranslated(page) : [];
      const getErrors = await collectErrors(page);
      const pageErrors = getErrors();

      report[lang].push({
        id: item.id,
        clicked,
        renderError: hasRenderError,
        untranslated,
        errors: pageErrors,
        screenshot: screenshotPath,
      });
    }
  }

  await browser.close();

  const outPath = path.resolve("d:\\abc\\EvoClaw\\screenshots\\report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  console.log("Report saved to", outPath);

  // Print summary
  console.log("\n=== Verification Summary ===");
  for (const lang of ["zh", "en"]) {
    console.log(`\n[${lang.toUpperCase()}]`);
    for (const r of report[lang]) {
      const status = r.renderError ? "RENDER ERROR" : (r.clicked ? "OK" : "NAV FAILED");
      console.log(`  ${r.id}: ${status}`);
      if (r.untranslated.length) console.log(`    Untranslated: ${r.untranslated.slice(0, 5).join(" | ")}`);
      if (r.errors.length) console.log(`    Errors: ${r.errors.length}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
