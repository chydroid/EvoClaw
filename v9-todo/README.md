# Node.js 命令行任务管理器 (todo-cli)

零依赖任务管理器：仅用 Node.js 内置 `fs` / `path`。

## 快速开始

```bash
node todo-cli.js add "写周报" --priority 高
node todo-cli.js add "回复邮件"
node todo-cli.js list
node todo-cli.js next
node todo-cli.js done 1
node todo-cli.js rm 2
```

任务数据保存在脚本同目录的 `tasks.json`。

## 命令表

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `add <标题>` | 新增任务 | `--priority 高\|中\|低`（默认：中），标题可含空格（引号包裹或原样连接） |
| `list [过滤]` | 列出任务 | 可选过滤：`todo` / `doing` / `done` |
| `done <id>` | 标记任务完成 | 任务 ID（数字） |
| `rm <id>` | 删除任务 | 任务 ID（数字） |
| `next` | 输出下一条未完成的最高优先级任务 | 无 |
| `help` | 显示帮助 | 无 |

优先级：`高 > 中 > 低`。`next` 从所有 `status != done` 的任务中取优先级最高的一条（同级按 ID 升序）。

## 数据结构

`tasks.json`：

```json
{
  "seq": 3,
  "tasks": [
    {
      "id": 1,
      "title": "写周报",
      "status": "todo",       // todo | doing | done
      "priority": "高",       // 高 | 中 | 低
      "createdAt": "2026-11-08T01:00:00.000Z",
      "doneAt": null         // ISO 时间戳，未完成任务为 null
    }
  ]
}
```

- `seq`：自增序号，保证 `id` 唯一（删除不回收 ID）。
- 完成任务时自动写入 `doneAt`。

## 退出码约定

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功（含 `list`/`next` 无任务、`add` 成功等正常输出） |
| `1` | 用户/运行时错误：未知命令、缺参数、无效优先级、任务不存在、重复标记完成等 |
