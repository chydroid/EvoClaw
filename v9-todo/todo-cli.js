#!/usr/bin/env node
'use strict';

// Node.js 命令行任务管理器（无第三方依赖）
// 用法: node todo-cli.js <add|list|done|rm|next> [args] [--priority 高|中|低]

const fs = require('fs');
const path = require('path');

const DATA_DIR = __dirname;
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');

const PRIORITY_MAP = { '高': 3, '中': 2, '低': 1 };
const PRIORITY_LABELS = { 3: '高', 2: '中', 1: '低' };

function exit(msg, code) {
  if (code !== 0 && msg) console.error(`错误: ${msg}`);
  else if (msg) console.log(msg);
  process.exit(code);
}

function loadTasks() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tasks)) return { tasks: [], seq: 0 };
    return data;
  } catch {
    return { tasks: [], seq: 0 };
  }
}

function saveTasks(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseArgs(argv) {
  const args = { _: [], priority: '中' };
  let i = 0;
  let expectPriority = false;
  while (i < argv.length) {
    const a = argv[i];
    if (expectPriority) {
      args.priority = a;
      expectPriority = false;
    } else if (a === '--priority') {
      expectPriority = true;
    } else if (a.startsWith('--priority=')) {
      args.priority = a.slice('--priority='.length);
    } else {
      args._.push(a);
    }
    i++;
  }
  if (expectPriority) exit('缺少 --priority 的参数值', 1);
  if (PRIORITY_MAP[args.priority] === undefined) {
    exit(`无效的优先级 "${args.priority}"（可选: 高/中/低）`, 1);
  }
  return args;
}

function nextId(data) {
  data.seq += 1;
  return data.seq;
}

function cmdAdd(args) {
  const title = args._.join(' ').trim();
  if (!title) exit('请提供任务标题，例如: node todo-cli.js add "写周报"', 1);
  const data = loadTasks();
  const id = nextId(data);
  const task = {
    id,
    title,
    status: 'todo',
    priority: args.priority,
    createdAt: new Date().toISOString(),
    doneAt: null,
  };
  data.tasks.push(task);
  saveTasks(data);
  exit(`✓ 已添加任务 #${id}「${title}」(优先级: ${args.priority})`, 0);
}

function cmdList(args) {
  const data = loadTasks();
  const filter = args._[0]; // 可选过滤: todo / doing / done
  if (filter && !['todo', 'doing', 'done'].includes(filter)) {
    exit(`无效的过滤 "${filter}"（可选: todo/doing/done）`, 1);
  }
  let tasks = data.tasks;
  if (filter) tasks = tasks.filter(t => t.status === filter);
  // 未完成在前，按优先级高->低、id 升序；已完成在后按 doneAt 排序
  const rank = t => PRIORITY_MAP[t.priority] || 0;
  const open = tasks.filter(t => t.status !== 'done')
    .sort((a, b) => rank(b) - rank(a) || a.id - b.id);
  const closed = tasks.filter(t => t.status === 'done')
    .sort((a, b) => new Date(b.doneAt).getTime() - new Date(a.doneAt).getTime());
  if (open.length + closed.length === 0) {
    exit('暂无任务', 0);
    return;
  }
  const lines = [];
  if (open.length) lines.push('待办:');
  for (const t of open) {
    lines.push(`  [${t.id}] ${t.title}  (${t.status}, 优先级: ${t.priority})`);
  }
  if (closed.length) lines.push('已完成:');
  for (const t of closed) {
    lines.push(`  [${t.id}] ${t.title}  (done, 完成于 ${new Date(t.doneAt).toLocaleString('zh-CN')})`);
  }
  exit(lines.join('\n'), 0);
}

function findTask(data, idRaw) {
  const id = parseInt(idRaw, 10);
  if (Number.isNaN(id)) return null;
  return data.tasks.find(t => t.id === id) || null;
}

function cmdDone(args) {
  const idRaw = args._[0];
  if (!idRaw) exit('请提供任务 ID，例如: node todo-cli.js done 1', 1);
  const data = loadTasks();
  const task = findTask(data, idRaw);
  if (!task) exit(`未找到任务 #${idRaw}`, 1);
  if (task.status === 'done') exit(`任务 #${idRaw} 已是完成状态`, 1);
  task.status = 'done';
  task.doneAt = new Date().toISOString();
  saveTasks(data);
  exit(`✓ 任务 #${idRaw}「${task.title}」已完成`, 0);
}

function cmdRm(args) {
  const idRaw = args._[0];
  if (!idRaw) exit('请提供任务 ID，例如: node todo-cli.js rm 1', 1);
  const data = loadTasks();
  const task = findTask(data, idRaw);
  if (!task) exit(`未找到任务 #${idRaw}`, 1);
  data.tasks = data.tasks.filter(t => t.id !== task.id);
  saveTasks(data);
  exit(`✓ 已删除任务 #${idRaw}「${task.title}」`, 0);
}

function cmdNext(args) {
  const data = loadTasks();
  const open = data.tasks.filter(t => t.status !== 'done');
  if (open.length === 0) exit('没有未完成的任务', 0);
  const rank = t => PRIORITY_MAP[t.priority] || 0;
  open.sort((a, b) => rank(b) - rank(a) || a.id - b.id);
  const top = open[0];
  exit(`下一条任务: [${top.id}] ${top.title} (优先级: ${top.priority})`, 0);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'add':
      return cmdAdd(parseArgs(rest));
    case 'list':
      return cmdList(parseArgs(rest));
    case 'done':
      return cmdDone(parseArgs(rest));
    case 'rm':
      return cmdRm(parseArgs(rest));
    case 'next':
      return cmdNext(parseArgs(rest));
    case '-h':
    case '--help':
    case 'help':
      return exit(
        [
          '任务管理器 CLI 用法:',
          '  node todo-cli.js add <标题> [--priority 高|中|低]',
          '  node todo-cli.js list [todo|doing|done]',
          '  node todo-cli.js done <id>',
          '  node todo-cli.js rm <id>',
          '  node todo-cli.js next',
        ].join('\n'),
        0
      );
    default:
      return exit(`未知命令 "${cmd || ''}"，可用命令: add / list / done / rm / next / help`, 1);
  }
}

main();
