import requests
from bs4 import BeautifulSoup
import json

# 获取表单页面
url = 'https://httpbin.org/forms/post'
response = requests.get(url)
if response.status_code != 200:
    print(f'Failed to fetch page: {response.status_code}')
    exit(1)

# 解析HTML
soup = BeautifulSoup(response.text, 'html.parser')
form = soup.find('form')
if not form:
    print('No form found')
    exit(1)

# 提取表单信息
action = form.get('action', '')
method = form.get('method', 'post').lower()
print(f'Form action: {action}')
print(f'Form method: {method}')

# 提取所有输入字段
inputs = form.find_all(['input', 'textarea', 'select'])
fields = []
for inp in inputs:
    name = inp.get('name')
    if name:
        fields.append(name)
print(f'Form fields: {fields}')

# 准备表单数据
data = {}
for field in fields:
    if field == 'custname':
        data[field] = 'EvoClaw'
    elif field == 'custtel':
        data[field] = ''  # 电话字段可选
    elif field == 'custemail':
        data[field] = 'test@evoclaw.com'
    elif field == 'size':
        data[field] = 'medium'  # 默认选择中等披萨
    elif field == 'topping':
        data[field] = 'cheese'  # 默认选择芝士
    elif field == 'comments':
        data[field] = 'Hello from EvoClaw'
    else:
        data[field] = ''

print(f'Form data: {data}')

# 提交表单
submit_url = url if not action else action
if not submit_url.startswith('http'):
    submit_url = url + '/' + action

print(f'Submitting to: {submit_url}')

if method == 'post':
    submit_response = requests.post(submit_url, data=data)
else:
    submit_response = requests.get(submit_url, params=data)

print(f'Status code: {submit_response.status_code}')
print(f'Response content:')
print(submit_response.text[:2000])  # 只显示前2000字符

# 保存完整响应
with open('form_response.txt', 'w', encoding='utf-8') as f:
    f.write(submit_response.text)

print('Response saved to form_response.txt')