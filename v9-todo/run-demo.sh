#!/bin/bash
cd /home/chy/EvoClaw/data/workspace/v9-todo
rm -f tasks.json demo-output.txt
{
  echo '=== node todo-cli.js add "写周报" --priority 高 ==='
  node todo-cli.js add "写周报" --priority 高
  echo '=== node todo-cli.js add "回复邮件" ==='
  node todo-cli.js add "回复邮件"
  echo '=== node todo-cli.js list ==='
  node todo-cli.js list
  echo '=== node todo-cli.js next ==='
  node todo-cli.js next
} > demo-output.txt 2>&1
cat demo-output.txt
echo '--- exit code checks ---'
node todo-cli.js add "写周报" --priority 高 >/dev/null; echo "add_exit=$?"
node todo-cli.js list >/dev/null; echo "list_exit=$?"
node todo-cli.js next >/dev/null; echo "next_exit=$?"
node todo-cli.js done 1; echo "done_exit=$?"
node todo-cli.js done 1; echo "done_again_exit=$?"
node todo-cli.js nope; echo "bad_cmd_exit=$?"
rm -f tasks.json
