import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:27788";
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SCREENSHOTS = {
  zh: path.join(ROOT, "screenshots", "zh"),
  en: path.join(ROOT, "screenshots", "en"),
};

const PAGES = [
  { id: "evolution", name: "evolution", labelZh: "进化", labelEn: "Evolution" },
  { id: "workboard", name: "workboard", labelZh: "工作台", labelEn: "Workboard" },
  { id: "dashboard", name: "dashboard", labelZh: "仪表盘", labelEn: "Dashboard" },
  { id: "observability", name: "observability", labelZh: "可观测性", labelEn: "Observability", extraTabs: [{ zh: "执行", en: "Executions", name: "executions" }] },
  { id: "token-usage", name: "token-usage", labelZh: "Token 用量", labelEn: "Token Usage" },
  { id: "stream-view", name: "stream-view", labelZh: "流视图", labelEn: "Stream View" },
  { id: "permissions", name: "permissions", labelZh: "权限", labelEn: "Permissions" },
  { id: "mcp-scanner", name: "mcp-scanner", labelZh: "MCP 扫描", labelEn: "MCP Scanner" },
  { id: "reply-refs", name: "reply-refs", labelZh: "引用回复", labelEn: "Reply Refs" },
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
  const labels = PAGES.find(p => p.id === itemId);
  const texts = lang === "zh" ? [labels.labelZh, labels.labelEn] : [labels.labelEn, labels.labelZh];
  return await page.evaluate((searchTexts) => {
    const buttons = Array.from(document.querySelectorAll("aside nav button"));
    for (const t of searchTexts) {
      const btn = buttons.find(b => b.textContent?.trim().includes(t));
      if (btn) {
        btn.scrollIntoView({ block: "nearest" });
        btn.click();
        return true;
      }
    }
    return false;
  }, texts);
}

async function switchLang(page, targetLang) {
  const btn = page.locator("header button", { hasText: /EN|ZH|中文|English/ }).first();
  if (await btn.isVisible().catch(() => false)) {
    const current = await btn.textContent();
    // The button label shows the language you will switch TO.
    // If current page is zh, button says "English"; if page is en, button says "中文".
    const inTargetLang = targetLang === "zh" ? /English|EN/.test(current) : /中文|ZH/.test(current);
    if (!inTargetLang) await btn.click();
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

async function detectUntranslated(page) {
  return await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      if (/^[\x00-\x7F]+$/.test(text) && text.length > 3 && !/^\d+(\.\d+)?(ms|s|MB|GB|KB|k|M)?$/.test(text) && !/^[\s\-\|\/\:\(\)\[\]\{\}\,\.\+\*\%\$\#\@\!\?]+$/.test(text)) {
        if (/^(ID|API|URL|HTTP|HTTPS|LLM|MCP|JWT|UI|GB|MB|KB|ms|s|k|M|ok|OK|ON|OFF|v\d+\.\d+|EvoClaw|Trace|Span|Node|JS|TS|JSON|YAML|SQL|No|Yes|OFF|ON)$/.test(text)) continue;
        const parent = node.parentElement;
        if (parent) {
          const tag = parent.tagName.toLowerCase();
          if (["script", "style", "noscript", "code", "pre"].includes(tag)) continue;
          const style = window.getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") continue;
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

  const report = { zh: [], en: [] };

  for (const lang of ["zh", "en"]) {
    await page.goto(BASE);
    await waitForContent(page);

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

      let hasRenderError = await page.locator("text=Render Error").isVisible().catch(() => false);
      let untranslated = lang === "zh" ? await detectUntranslated(page) : [];

      report[lang].push({
        id: item.id,
        clicked,
        renderError: hasRenderError,
        untranslated,
        screenshot: screenshotPath,
      });

      // Extra tabs (e.g. observability "执行" tab)
      if (item.extraTabs) {
        for (const tab of item.extraTabs) {
          const tabLabel = lang === "zh" ? tab.zh : tab.en;
          const tabClicked = await page.evaluate((text) => {
            const tabs = Array.from(document.querySelectorAll("[role='tab'], button, div"));
            const el = tabs.find(e => e.textContent?.trim() === text);
            if (el) { el.click(); return true; }
            return false;
          }, tabLabel);
          await page.waitForTimeout(800);
          const tabScreenshot = path.join(SCREENSHOTS[lang], `${item.name}-${tab.name}.png`);
          await page.screenshot({ path: tabScreenshot, fullPage: true });
          hasRenderError = await page.locator("text=Render Error").isVisible().catch(() => false);
          untranslated = lang === "zh" ? await detectUntranslated(page) : [];
          report[lang].push({
            id: `${item.id}-${tab.name}`,
            clicked: tabClicked,
            renderError: hasRenderError,
            untranslated,
            screenshot: tabScreenshot,
          });
        }
      }
    }
  }

  await browser.close();

  const outPath = path.join(ROOT, "screenshots", "report.json");
  fs.writeFileSync(outPath, JSON.stringify({ ...report, globalErrors: getAllErrors() }, null, 2), "utf-8");
  console.log("Report saved to", outPath);

  console.log("\n=== Verification Summary ===");
  for (const lang of ["zh", "en"]) {
    console.log(`\n[${lang.toUpperCase()}]`);
    for (const r of report[lang]) {
      const status = r.renderError ? "RENDER ERROR" : (r.clicked ? "OK" : "NAV FAILED");
      console.log(`  ${r.id}: ${status}`);
      if (r.untranslated.length) console.log(`    Untranslated samples: ${r.untranslated.slice(0, 5).join(" | ")}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
