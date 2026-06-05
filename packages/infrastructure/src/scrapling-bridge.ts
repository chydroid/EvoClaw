/**
 * Scrapling Bridge — 将 Scrapling 框架的关键功能集成到 EvoClaw
 *
 * Scrapling (https://github.com/D4Vinci/Scrapling) 是一个自适应 Web Scraping 框架，
 * 核心能力：
 *   - Fetchers: StealthyFetcher (绕过 Cloudflare), DynamicFetcher (浏览器渲染)
 *   - 自适应解析: auto_save + adaptive 模式，页面结构变化时自动重定位元素
 *   - 内容提取: css()/xpath() + text_content() + 相似元素发现
 */

import { execSync } from "child_process";

/** Python 解释器路径 */
const PYTHON = "python";

/** 检查 Scrapling 是否已安装 */
export function isScraplingAvailable(): boolean {
  try {
    execSync(`${PYTHON} -c "import scrapling; print(scrapling.__version__)"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成 Scrapling 自适应抓取脚本
 * 使用 StealthyFetcher 绕过简单反爬，auto_save 保存元素指纹用于后续自适应
 */
export function generateAdaptiveScraperScript(params: {
  url: string;
  outputFile: string;
  titleSelector?: string;
  contentSelector?: string;
  nextLinkSelector?: string;
  startChapter?: number;
  maxChapters?: number;
  encoding?: string;
  delay?: number;
}): string {
  const titleSel = params.titleSelector || "h1";
  const contentSel = params.contentSelector || "#content, .content, .chapter-content, article";
  const nextSel = params.nextLinkSelector || 'a:contains("下一章"), a:contains("下一节"), a.next, a:contains("▶")';
  const encoding = params.encoding || "utf-8";
  const delay = params.delay || 1;
  const startChapter = params.startChapter || 1;
  const maxChapters = params.maxChapters || 50;

  return `#!/usr/bin/env python3
"""
Scrapling 自适应抓取脚本 — 由 EvoClaw Scrapling Bridge 生成
使用 Scrapling 的 StealthyFetcher + 自适应解析能力
"""
import sys, os, time, json
try:
    from scrapling.fetchers import StealthyFetcher
    StealthyFetcher.adaptive = True
except ImportError:
    print("[ERROR] Scrapling not installed. Run: pip install scrapling")
    sys.exit(1)

URL = ${JSON.stringify(params.url)}
OUTPUT = ${JSON.stringify(params.outputFile)}
TITLE_SEL = ${JSON.stringify(titleSel)}
CONTENT_SEL = ${JSON.stringify(contentSel)}
NEXT_SEL = ${JSON.stringify(nextSel)}
ENCODING = ${JSON.stringify(encoding)}
DELAY = ${JSON.stringify(delay)}
START = ${JSON.stringify(startChapter)}
MAX = ${JSON.stringify(maxChapters)}

class ScraplingNovelDownloader:
    def __init__(self):
        self.fetcher = StealthyFetcher()
        self.count = 0
        self.checkpoint_file = OUTPUT + ".checkpoint.json"

    def save_checkpoint(self, url):
        with open(self.checkpoint_file, "w") as f:
            json.dump({"url": url, "count": self.count, "output": OUTPUT}, f)

    def load_checkpoint(self):
        if os.path.exists(self.checkpoint_file):
            with open(self.checkpoint_file, "r") as f:
                return json.load(f)
        return None

    def extract_text(self, page, selector):
        """使用 Scrapling 自适应选择器提取文本"""
        try:
            elements = page.css(selector, auto_save=True, adaptive=True)
            if elements:
                return elements[0].text_content().strip()
        except Exception:
            pass
        return ""

    def find_next_link(self, page):
        """使用多策略查找下一章链接"""
        # 策略1: 文本匹配
        next_links = page.css('a[href]')
        for link in next_links:
            text = link.text_content().strip()
            if any(kw in text for kw in ['下一章', '下一节', '下一頁', '下一頁', '►', '▶', 'Next']):
                return link.attrib.get('href', '')
        # 策略2: rel属性
        next_by_rel = page.css('a[rel="next"]')
        if next_by_rel:
            return next_by_rel[0].attrib.get('href', '')
        return ""

    def download(self, start_url=None):
        checkpoint = self.load_checkpoint()
        if checkpoint and not start_url:
            current_url = checkpoint["url"]
            self.count = checkpoint["count"]
            print(f"[检查点] 从第 {self.count} 章恢复，URL: {current_url}")
        else:
            current_url = start_url or URL
            self.count = 0

        with open(OUTPUT, "a", encoding="utf-8") as f:
            while current_url and self.count < MAX:
                try:
                    print(f"[{self.count + 1}/{MAX}] 正在抓取: {current_url}")
                    page = self.fetcher.fetch(current_url, headless=False)

                    title = self.extract_text(page, TITLE_SEL)
                    content = self.extract_text(page, CONTENT_SEL)

                    if not content:
                        print(f"  [警告] 未找到内容，尝试重试...")
                        page = self.fetcher.fetch(current_url, headless=True, network_idle=True)
                        content = self.extract_text(page, CONTENT_SEL)

                    if content:
                        f.write(f"\\n\\n{'='*60}\\n")
                        f.write(f"第{START + self.count}章\\n")
                        if title:
                            f.write(f"{title}\\n")
                        f.write(f"{'='*60}\\n\\n")
                        f.write(content)
                        f.flush()
                        self.count += 1
                        print(f"  [完成] 已保存 {len(content)} 字")
                    else:
                        print(f"  [跳过] 无法提取内容")

                    next_url = self.find_next_link(page)
                    if not next_url:
                        print("[完成] 无下一章链接，下载结束")
                        break

                    # 处理相对URL
                    if next_url.startswith("/"):
                        from urllib.parse import urljoin
                        current_url = urljoin(current_url, next_url)
                    elif not next_url.startswith("http"):
                        from urllib.parse import urljoin
                        current_url = urljoin(current_url, next_url)
                    else:
                        current_url = next_url

                    self.save_checkpoint(current_url)
                    time.sleep(DELAY)

                except Exception as e:
                    print(f"[错误] {e}")
                    self.save_checkpoint(current_url)
                    time.sleep(DELAY * 3)

        print(f"\\n{'='*60}")
        print(f"下载完成! 共 {self.count} 章")
        print(f"输出文件: {OUTPUT}")
        if os.path.exists(self.checkpoint_file):
            os.remove(self.checkpoint_file)

if __name__ == "__main__":
    downloader = ScraplingNovelDownloader()
    downloader.download()
`;
}

/**
 * 生成 Scrapling 简单页面抓取脚本（通用用途）
 */
export function generateSimpleFetchScript(url: string, options?: {
  selector?: string;
  extractLinks?: boolean;
  extractText?: boolean;
  headless?: boolean;
}): string {
  const sel = options?.selector || "body";
  return `#!/usr/bin/env python3
"""Scrapling 快速抓取脚本"""
from scrapling.fetchers import StealthyFetcher

url = ${JSON.stringify(url)}
page = StealthyFetcher.fetch(url, headless=${options?.headless !== false ? "True" : "False"})
print(f"Title: {page.css('title::text').get('')}")
print(f"Status: {page.status}")
print(f"URL: {page.url}")
${options?.extractText ? 'print(f"Text: {page.text_content()[:2000]}")' : ''}
${options?.extractLinks ? 'links = page.css("a[href]"); print(f"Links: {len(links)}"); [print(f"  {l.attrib.get(\'href\')} | {l.text_content().strip()[:80]}") for l in links[:20]]' : ''}
`;
}

/**
 * 获取 Scrapling 版本信息（用于诊断）
 */
export function getScraplingInfo(): string {
  try {
    return execSync(
      `${PYTHON} -c "import scrapling; print(f'Scrapling v{scrapling.__version__}')"`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
  } catch {
    return "Scrapling not available";
  }
}