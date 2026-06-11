import subprocess, sys

# Try curl via subprocess
try:
    result = subprocess.run(
        ['curl', '-s', '-L', '-m', '20',
         '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
         '-H', 'Accept: text/html,application/xhtml+xml',
         '-H', 'Accept-Language: zh-CN,zh;q=0.9',
         'http://www.paoshu9.com/1_1789/'],
        capture_output=True, timeout=30
    )
    data = result.stdout
    if data:
        print(f"CURL OK, got {len(data)} bytes")
        for enc in ['utf-8', 'gbk', 'gb2312']:
            try:
                text = data.decode(enc)
                chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
                print(f"  Decode {enc}: {len(text)} chars, {chinese} chinese chars")
                if chinese > 100:
                    with open('index_debug.html', 'w', encoding='utf-8') as f:
                        f.write(text)
                    print(f"  Saved to index_debug.html")
                    print(f"  First 500 chars: {text[:500]}")
                    print(f"  Last 500 chars: {text[-500:]}")
                    break
            except:
                continue
    else:
        print(f"CURL stderr: {result.stderr.decode('utf-8', errors='ignore')[:500]}")
except FileNotFoundError:
    print("curl not found, trying urllib...")
    import urllib.request, ssl
    ssl._create_default_https_context = ssl._create_unverified_context
    req = urllib.request.Request('http://www.paoshu9.com/1_1789/', headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
    })
    try:
        resp = urllib.request.urlopen(req, timeout=20)
        data = resp.read()
        print(f"URLLIB OK, got {len(data)} bytes")
        for enc in ['utf-8', 'gbk', 'gb2312']:
            try:
                text = data.decode(enc)
                chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
                print(f"  Decode {enc}: {len(text)} chars, {chinese} chinese")
                if chinese > 100:
                    with open('index_debug.html', 'w', encoding='utf-8') as f:
                        f.write(text)
                    print(f"  Saved. First 500: {text[:500]}")
                    break
            except:
                continue
    except Exception as e:
        print(f"URLLIB error: {e}")
except Exception as e:
    print(f"Error: {e}")
