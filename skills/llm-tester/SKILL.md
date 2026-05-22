# LLM 通用测试工具 (llm-tester)

## 描述
一个基于 PyQt5 的图形界面应用，用于测试各大 LLM 服务商的 API 连通性、响应时间和性能指标。

## 支持的 LLM 服务商
- OpenAI (GPT-4o, GPT-4-turbo, GPT-3.5-turbo)
- DeepSeek (deepseek-chat, deepseek-reasoner)
- 通义千问 Qwen (qwen-plus, qwen-max, qwen-turbo)
- 月之暗面 Moonshot (moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k)
- 智谱 GLM (glm-4-plus, glm-4-flash, glm-4-air)
- 零一万物 Yi (yi-lightning, yi-large, yi-medium)
- 百度千帆 (ernie-4.0, ernie-3.5, ernie-speed)
- 自定义 (任意兼容 OpenAI 协议的 API)

## 测试指标
- 总响应时间
- 首 Token 时间 (TTFT)
- Token 生成速度 (tokens/s)
- Token 用量统计
- 多轮测试取平均值

## 使用方法
```bash
cd skills/llm-tester
pip install PyQt5 requests sseclient-py
python llm_tester.py
```

## 文件结构
- `llm_tester.py` - 主程序文件
- `SKILL.md` - 本说明文件
