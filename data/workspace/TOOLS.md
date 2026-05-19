# 工具使用说明

EvoClaw 提供以下类型的工具：

## 文件系统工具

- read: 读取文件内容
- write: 写入/创建文件
- edit: 编辑现有文件
- file_search: 搜索文件

## 执行工具

- exec: 执行 shell 命令
- process: 管理长时间运行的进程

## 会话工具

- sessions_list: 列出活动会话
- sessions_spawn: 创建子代理处理复杂任务
- sessions_send: 向其他会话发送消息

## 技能工具

- skill_install: 安装新技能
- skill_execute: 运行已安装的技能
- skill_list: 列出已安装的技能
- skill_search: 搜索技能市场

## 网络工具

- browser: 控制浏览器进行网页操作
- web_search: 在线搜索

## 通信工具

- message: 发送消息到各通道
- email: 发送邮件

## 规则

- 工具调用结果应当被如实汇报。
- 执行写操作前确保路径正确。
- 使用文件系统工具前理解当前工作目录。