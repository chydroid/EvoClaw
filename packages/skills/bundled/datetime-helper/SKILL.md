---
name: datetime-helper
version: 1.0.0
description: 提供当前时间、时区转换、日期格式化、时间差计算等能力。无外部依赖，纯本地计算。
category: utility
keywords:
  - datetime
  - time
  - timezone
  - date
  - 日期
  - 时间
license: MIT
platform:
  - node
language:
  - javascript
---

# Datetime Helper

提供当前时间、时区转换、日期格式化、时间差计算等能力。无外部依赖，纯本地计算。

## Capabilities

- 获取当前时间（支持多种格式：ISO 8601、Unix 时间戳、人类可读格式）
- 时区转换（支持所有 IANA 时区，如 Asia/Shanghai、America/New_York）
- 日期格式化（自定义格式字符串）
- 时间差计算（计算两个时间点之间的差值）

## Tools

### get_current_time

获取当前时间。

**Parameters:**
- `timezone` (string, optional): IANA 时区标识符，默认为系统本地时区
- `format` (string, optional): 输出格式，可选 `iso`、`timestamp`、`human`，默认 `iso`

**Example:**
```json
{
  "timezone": "Asia/Shanghai",
  "format": "iso"
}
```

### convert_timezone

将时间从一个时区转换到另一个时区。

**Parameters:**
- `time` (string): 源时间（ISO 8601 格式）
- `from_timezone` (string): 源时区
- `to_timezone` (string): 目标时区

### format_date

按指定格式格式化日期。

**Parameters:**
- `time` (string): 时间字符串
- `format` (string): 目标格式（如 YYYY-MM-DD HH:mm:ss）

### time_diff

计算两个时间点之间的差值。

**Parameters:**
- `start` (string): 开始时间
- `end` (string): 结束时间
- `unit` (string, optional): 输出单位，可选 `seconds`、`minutes`、`hours`、`days`

## Steps

1. 接收用户的时间相关请求
2. 解析时间参数（支持 ISO 8601、Unix 时间戳、自然语言）
3. 执行对应的时间操作（获取/转换/格式化/计算差值）
4. 返回结构化结果

## Notes

- 所有计算基于本地 JavaScript Date 对象，无网络调用
- 时区数据来源于 Intl API
- 对于历史时间（1970 年前）可能不准确
