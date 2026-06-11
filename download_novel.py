import urllib.request
import re
import time
import os
import sys
import ssl
import socket

BASE_URL = "http://www.paoshu9.com"
INDEX_URL = "http://www.paoshu9.com/1_1789/"
OUTPUT_FILE = "逆天邪神_2100章之后.txt"

# 宽松SSL
ssl._create_default_https_context = ssl._create_unverified_context

def make_opener():
    handler = urllib.request.HTTPCookieProcessor()
    opener = urllib.request.build_opener(handler)
    opener.addheaders = [
        ('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
        ('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
        ('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8'),
        ('Accept-Encoding', 'identity'),
        ('Connection', 'keep-alive'),
        ('Referer', 'http://www.paoshu9.com/'),
    ]
    return opener

opener = make_opener()

def fetch_page(url, retries=3):
    for attempt in range(retries):
        try:
            resp = opener.open(url, timeout=30)
            data = resp.read()
            for enc in ['utf-8', 'gbk', 'gb2312', 'gb18030', 'big5', 'latin-1']:
                try:
                    text = data.decode(enc)
                    # 检查是否解码出有意义的中文
                    chinese_count = len(re.findall(r'[\u4e00-\u9fff]', text))
                    if chinese_count > 10 or len(text) > 500:
                        return text
                except:
                    continue
            return data.decode('utf-8', errors='ignore')
        except Exception as e:
            print(f"    [重试 {attempt+1}/{retries}] {url} -> {type(e).__name__}: {e}")
            time.sleep(2)
    return None

def extract_chapter_content(html):
    content = None
    # 尝试各种正文容器
    for pat in [
        r'<div[^>]*id=["\']content["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']booktext["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']chaptercontent["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']BookText["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']chapterContent["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']novelcontent["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']articlecontent["\'][^>]*>(.*?)</div>',
        r'<div[^>]*class=["\'][^"\']*content[^"\']*["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']htmlContent["\'][^>]*>(.*?)</div>',
        r'<div[^>]*id=["\']TextContent["\'][^>]*>(.*?)</div>',
    ]:
        m = re.search(pat, html, re.DOTALL | re.IGNORECASE)
        if m:
            content = m.group(1)
            break
    # 找最长div作为后备
    if not content:
        divs = re.findall(r'<div[^>]*>(.*?)</div>', html, re.DOTALL)
        if divs:
            longest = max(divs, key=len)
            if len(longest) > 500:
                content = longest
    if not content:
        return None
    # 清理HTML
    text = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
    text = re.sub(r'<br\s*/?\s*>', '\n', text)
    text = re.sub(r'<p[^>]*>', '\n', text)
    text = re.sub(r'</p>', '', text)
    text = re.sub(r'<[^>]+>', '', text)
    text = text.replace('&nbsp;', ' ').replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').replace('\u3000', ' ').replace('\r', '')
    lines = []
    for line in text.split('\n'):
        line = line.strip()
        if line and len(line) > 1:
            skip_words = ['百度搜索', '手机阅读', '本站', 'paoshu', '天才一秒', '记住',
                         '最新章节', 'www.', '.com', '.net', '本章未完', '点击下一页',
                         '上一章', '下一章', '返回目录', '加入书签', '笔趣阁', '一秒记住',
                         '请收藏', 'txt下载', '下载地址', 'txt电子书']
            if any(kw in line for kw in skip_words):
                continue
            lines.append(line)
    return '\n'.join(lines)

def extract_title(html):
    m = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.DOTALL)
    if m:
        return re.sub(r'<[^>]+>', '', m.group(1)).strip()
    m = re.search(r'<title>(.*?)</title>', html, re.DOTALL)
    if m:
        t = re.sub(r'<[^>]+>', '', m.group(1)).strip()
        for s in [' - 笔趣阁', ' - paoshu9', '_paoshu9', ' paoshu9.com', '- paoshu9.com', '-paoshu9.com']:
            t = t.replace(s, '')
        return t.strip()
    return None

print("=" * 50)
print("《逆天邪神》第2100章之后下载器")
print("=" * 50)
print()

# 测试网络连通性
print("[0] 测试网络连通性...")
test = fetch_page("http://www.paoshu9.com/")
if test:
    print(f"  主站可达, 大小: {len(test)} 字符")
else:
    print("  主站不可达，退出")
    sys.exit(1)

# Step 1: 获取目录页
print("\n[1] 获取目录页...")
index_html = fetch_page(INDEX_URL)
if not index_html:
    print("  目录页获取失败!")
    sys.exit(1)
print(f"  目录页大小: {len(index_html)} 字符")
with open('index_debug.html', 'w', encoding='utf-8') as f:
    f.write(index_html)

# Step 2: 解析章节链接
print("\n[2] 解析章节列表...")
links = re.findall(r'<a[^>]*href=["\']([^"\']*?)["\'][^>]*>(.*?)</a>', index_html, re.DOTALL)

chapter_list = []
for href, text in links:
    text = re.sub(r'<[^>]+>', '', text).strip()
    m = re.search(r'第(\d+)章', text)
    if m:
        ch_num = int(m.group(1))
        if href.startswith('http'):
            full_url = href
        elif href.startswith('/'):
            full_url = BASE_URL + href
        else:
            full_url = BASE_URL + '/' + href
        chapter_list.append({'num': ch_num, 'title': text, 'url': full_url})

seen = set()
unique = []
for ch in chapter_list:
    if ch['url'] not in seen:
        seen.add(ch['url'])
        unique.append(ch)
chapter_list = sorted(unique, key=lambda x: x['num'])

print(f"  找到 {len(chapter_list)} 个章节链接")
if chapter_list:
    print(f"  范围: 第{chapter_list[0]['num']}章 ~ 第{chapter_list[-1]['num']}章")
    # 显示2100附近
    for ch in chapter_list:
        if 2098 <= ch['num'] <= 2105:
            print(f"    第{ch['num']}章 -> {ch['url']}")

targets = [ch for ch in chapter_list if ch['num'] > 2100]
targets.sort(key=lambda x: x['num'])

if not targets:
    print("\n  未找到2100章之后的链接!")
    # 打印页面中所有链接看结构
    all_links = re.findall(r'<a[^>]*href=["\']([^"\']*?)["\'][^>]*>(.*?)</a>', index_html[:5000], re.DOTALL)
    print(f"  页面前5000字符中找到 {len(all_links)} 个链接:")
    for href, text in all_links[:20]:
        print(f"    {re.sub('<[^>]+>', '', text).strip()[:50]} -> {href}")
    sys.exit(1)

print(f"\n[3] 开始下载 {len(targets)} 章 (第{targets[0]['num']}章 ~ 第{targets[-1]['num']}章)")

# 先下载第一章验证
print("  验证第一章...")
first_html = fetch_page(targets[0]['url'])
if first_html:
    with open('chapter_sample.html', 'w', encoding='utf-8') as f:
        f.write(first_html)
    sample = extract_chapter_content(first_html)
    if sample:
        print(f"  验证成功! 内容长度: {len(sample)} 字")
        print(f"  预览: {sample[:100]}...")
    else:
        print(f"  [!] 内容提取失败，查看 chapter_sample.html")
        # 打印HTML片段帮助调试
        m = re.search(r'<body[^>]*>(.*?)</body>', first_html, re.DOTALL)
        if m:
            body = m.group(1)[:2000]
            print(f"  Body前2000字符: {body[:500]}")

all_content = []
success = 0
fail = 0

for idx, ch in enumerate(targets):
    if idx == 0 and first_html:
        html = first_html
    else:
        html = fetch_page(ch['url'])
    if not html:
        fail += 1
        continue
    title = extract_title(html) or ch['title']
    content = extract_chapter_content(html)
    if content and len(content) > 50:
        all_content.append(f"\n\n{'='*40}\n{title}\n{'='*40}\n\n{content}")
        success += 1
    else:
        fail += 1
    if (idx + 1) % 20 == 0:
        print(f"  进度: {idx+1}/{len(targets)} (成功:{success} 失败:{fail})")
    time.sleep(0.3)

print(f"\n[4] 保存文件... 成功: {success} 章, 失败: {fail} 章")

if all_content:
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(f"《逆天邪神》第2100章之后内容\n")
        f.write(f"来源: {INDEX_URL}\n")
        f.write(f"章节数: {success}\n")
        f.write(f"范围: 第{targets[0]['num']}章 ~ 第{targets[-1]['num']}章\n")
        f.write(f"\n{'#'*50}\n")
        for block in all_content:
            f.write(block)
    size = os.path.getsize(OUTPUT_FILE)
    print(f"\n{'='*50}")
    print(f"完成! 文件: {OUTPUT_FILE}")
    print(f"大小: {size/1024:.1f} KB, 章节: {success}")
    print(f"{'='*50}")
else:
    print("没有成功下载任何内容!")
    sys.exit(1)
