import requests
from bs4 import BeautifulSoup

url = "https://the-internet.herokuapp.com/dropdown"
response = requests.get(url)
soup = BeautifulSoup(response.text, 'html.parser')

# 查找下拉菜单
dropdown = soup.find('select', id='dropdown')
if dropdown:
    print("找到下拉菜单:")
    options = dropdown.find_all('option')
    for option in options:
        print(f"  值: {option.get('value')}, 文本: {option.text}")
    
    # 查找Option 2
    option2 = dropdown.find('option', value='2')
    if option2:
        print(f"\n找到Option 2: {option2.text}")
        print("选择Option 2需要Selenium，因为需要交互操作")
    else:
        print("\n未找到Option 2")
else:
    print("未找到下拉菜单")