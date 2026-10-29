#!/usr/bin/env python3
"""Extract log sections for v5 retry sessions (avoids angle-bracket issues in shell)."""
import re, sys

LOG = '/tmp/evoclaw-server.log'
text = open(LOG, encoding='utf-8', errors='replace').read()
lines = text.split('\n')

def section(session_prefix, end_prefix=None):
    out, f = [], False
    for ln in lines:
        if session_prefix in ln:
            f = True
        if f:
            out.append(ln)
        if end_prefix and end_prefix in ln and f:
            break
    return out

which = sys.argv[1]
if which == 'task8':
    sec = section('v5-task-8-', 'v5-task-10-')
elif which == 'task10':
    sec = section('v5-task-10-')
elif which == 'task1':
    sec = section('v5-task-1-1793182486776', 'v5-task-3-')
for ln in sec:
    if re.search(r'reconcil|Disk verifi|missing|Auto-continue|nudge|tool_choice|tools: 0|Subtask|subtask', ln):
        print(ln)
