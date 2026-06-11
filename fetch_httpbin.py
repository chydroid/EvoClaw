#!/usr/bin/env python3
"""
Fetch and display content from httpbin.org/get
"""

import json
import requests
import sys

def fetch_httpbin_get():
    """Fetch content from httpbin.org/get and display it"""
    url = "https://httpbin.org/get"
    
    try:
        # 发送GET请求
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        
        # 解析JSON响应
        data = response.json()
        
        print("=" * 60)
        print("📡 httpbin.org/get 响应内容:")
        print("=" * 60)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        print("=" * 60)
        
        # 保存到文件
        output_file = "httpbin_get_response.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        print(f"\n✅ 响应已保存到: {output_file}")
        
        # 显示关键信息
        print("\n📊 关键信息:")
        print(f"• 客户端IP: {data.get('origin', '未知')}")
        print(f"• 请求URL: {data.get('url', '未知')}")
        print(f"• 用户代理: {data.get('headers', {}).get('User-Agent', '未知')}")
        
        return data
        
    except requests.exceptions.RequestException as e:
        print(f"❌ 请求失败: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"❌ JSON解析失败: {e}")
        return None

if __name__ == "__main__":
    fetch_httpbin_get()