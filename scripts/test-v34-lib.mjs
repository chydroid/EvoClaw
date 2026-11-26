/**
 * EvoClaw v34 压测共享库 —— 10 项「真实工程交付」级复杂多步任务，领域与 v12–v33 零重叠：
 *   T1  遗留代码重构（Python，日志 helper 抽取 + 字节级行为等价）
 *   T2  脏 CSV → SQLite ETL（Python，质量规则 + 拒绝表 + SQL 聚合报表）
 *   T3  Git 仓库缺陷取证（Python，bisect 泛化到未见仓库）
 *   T4  分页 HTTP 客户端（Node，429 重试 + ETag/304 + 磁盘缓存）
 *   T5  密钥扫描器（Python，正则 + 香农熵 + 白名单 + 退出码）
 *   T6  账本对账（Python，精确/金额容差/日期容差三级匹配）
 *   T7  结构化日志器（Node，脱敏 + 确定性采样 + 按大小轮转）
 *   T8  队列 worker（Python，幂等 + 断点续跑 + 原子状态）
 *   T9  覆盖率门禁（Python，JUnit XML + 覆盖率 JSON → 门禁与 Markdown）
 *   T10 增量构建工具（Python，内容哈希 + DAG + manifest + --check）
 *
 * 参考实现只用于 harness 自校准与对交付物的独立复算（不复用被测产物）。
 * 夹具由 seed() 写入各任务目录，写入时记录哈希（frozen 校验）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'node:crypto';
import { writeFixture, FIXTURE_HASHES, canon as canonShared, pyReadTextLiteral, REPO_ROOT } from './v14/lib.mjs';

export { pyReadTextLiteral };
export { FIXTURE_HASHES };
export const WS = '/home/chy/EvoClaw/data/workspace';
export const D = (n) => `${WS}/v34-t${n}`;
export const REF_DIR = path.resolve(REPO_ROOT, 'tests-tmp/v34-ref');
export const HOLDOUT_T3 = '/tmp/v34-t3-holdout';
export const HOLDOUT_T5 = '/tmp/v34-t5-holdout';
export const canon = canonShared;
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** 路径级 JSON 差异（诊断用，口径同 sameJson）。 */
export function jsonDiff(expected, actual, max = 5) {
  const out = [];
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? 'undefined' : s.length > 72 ? s.slice(0, 72) + '…' : s;
  };
  const walk = (e, a, p) => {
    if (out.length >= max) return;
    const arrE = Array.isArray(e), arrA = Array.isArray(a);
    if (arrE || arrA) {
      if (!arrE || !arrA) { out.push(`${p}: 类型不符 ${brief(e)}→${brief(a)}`); return; }
      if (e.length !== a.length) out.push(`${p}.length: ${e.length}→${a.length}`);
      for (let i = 0; i < Math.max(e.length, a.length) && out.length < max; i++) walk(e[i], a[i], `${p}[${i}]`);
      return;
    }
    const objE = e && typeof e === 'object', objA = a && typeof a === 'object';
    if (objE || objA) {
      if (!objE || !objA) { out.push(`${p}: 类型不符 ${brief(e)}→${brief(a)}`); return; }
      for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
        if (out.length >= max) return;
        if (!(k in e)) out.push(`${p}.${k}: 多余字段 = ${brief(a[k])}`);
        else if (!(k in a)) out.push(`${p}.${k}: 缺失字段（期望 ${brief(e[k])}）`);
        else walk(e[k], a[k], `${p}.${k}`);
      }
      return;
    }
    if (e !== a) out.push(`${p}: ${brief(e)}→${brief(a)}`);
  };
  walk(expected, actual, '$');
  return out;
}
export const diffNote = (actual, expected, max = 5) => jsonDiff(expected, actual, max).join(' | ');

/** Python 模块装载片段（按文件路径 importlib 装载，避免内置模块名遮蔽）。 */
export function pyLoadModule(alias, file) {
  return `import importlib.util as _ilu\n` +
    `_spec = _ilu.spec_from_file_location(${JSON.stringify(alias)}, ${JSON.stringify(file)})\n` +
    `m = _ilu.module_from_spec(_spec)\n` +
    `_spec.loader.exec_module(m)`;
}

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}
export const canonicalJson = (v) => JSON.stringify(canonicalize(v));
export const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 32 位 FNV-1a（UTF-8 字节）。JS 必须 Math.imul。 */
export function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 香农熵（按字符计，bits/char）。 */
export function shannon(s) {
  if (!s.length) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 在隔离进程中运行一段 node 驱动代码（cwd=dir）。 */
export function runNodeDriver(dir, code, timeoutMs = 60000) {
  const tmp = `/tmp/v34-driver-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;
  fs.writeFileSync(tmp, code);
  try {
    const out = execSync(`timeout 50 node ${JSON.stringify(tmp)} 2>&1`, { cwd: dir, timeout: timeoutMs, encoding: 'utf8' }).toString();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

// ═════════════════════════════ T1: 遗留代码重构 ═════════════════════════════
export const T1_LEGACY = `"""Legacy 报表工具（重构目标）。

重构要求见任务书：把散落的日志输出收敛为单一 helper，行为字节级不变。
"""
import sys


def summarize(rows):
    print("[INFO] summarize start")
    total = sum(r["amount"] for r in rows)
    print(f"[INFO] summarize rows={len(rows)}")
    if total < 0:
        print("[WARN] negative total")
    print("[INFO] summarize done")
    return {"count": len(rows), "total": total}


def group_by(rows, key):
    print("[INFO] group_by start")
    groups = {}
    for r in rows:
        groups.setdefault(r[key], []).append(r)
    print(f"[INFO] group_by groups={len(groups)}")
    print("[INFO] group_by done")
    return groups


def format_row(r):
    print("[INFO] format_row start")
    if "amount" not in r:
        print("[ERROR] missing amount")
        raise ValueError("missing amount")
    s = "{}:{}".format(r["id"], r["amount"])
    print("[INFO] format_row done")
    return s


def main():
    rows = [{"id": "a", "amount": 10}, {"id": "b", "amount": -4}]
    summarize(rows)
    group_by(rows, "id")
    for r in rows:
        format_row(r)


if __name__ == "__main__":
    main()
`;

export const T1_TEST = `import io
import unittest
from contextlib import redirect_stdout

import report_gen


class ReportGenTest(unittest.TestCase):
    def test_summarize_values(self):
        rows = [{"id": "x", "amount": 5}, {"id": "y", "amount": 7}]
        self.assertEqual(report_gen.summarize(rows), {"count": 2, "total": 12})

    def test_group_by(self):
        rows = [{"id": "x", "amount": 1}, {"id": "y", "amount": 2}, {"id": "x", "amount": 3}]
        self.assertEqual(sorted(report_gen.group_by(rows, "id")), ["x", "y"])

    def test_format_row(self):
        self.assertEqual(report_gen.format_row({"id": "x", "amount": 9}), "x:9")

    def test_format_row_missing_amount(self):
        with self.assertRaises(ValueError):
            report_gen.format_row({"id": "x"})

    def test_stdout_lines(self):
        rows = [{"id": "x", "amount": 1}]
        buf = io.StringIO()
        with redirect_stdout(buf):
            report_gen.summarize(rows)
        self.assertEqual(buf.getvalue().splitlines(), [
            "[INFO] summarize start",
            "[INFO] summarize rows=1",
            "[INFO] summarize done",
        ])

    def test_error_stdout(self):
        buf = io.StringIO()
        with redirect_stdout(buf), self.assertRaises(ValueError):
            report_gen.format_row({"id": "x"})
        self.assertEqual(buf.getvalue().splitlines(), [
            "[INFO] format_row start",
            "[ERROR] missing amount",
        ])


if __name__ == "__main__":
    unittest.main()
`;

/** T1 行为等价探针：同一批输入分别喂给 pristine 与重构后的模块，比较 stdout 与异常类型。 */
export const T1_PROBE = `import importlib.util as u
import io, json, sys
from contextlib import redirect_stdout

def load(alias, p):
    s = u.spec_from_file_location(alias, p)
    m = u.module_from_spec(s)
    s.loader.exec_module(m)
    return m

a = load("pristine_mod", sys.argv[1])
b = load("candidate_mod", sys.argv[2])

def capture(mod, fn, *args):
    buf = io.StringIO()
    err = None
    val = None
    try:
        with redirect_stdout(buf):
            val = fn(*args)
    except Exception as e:  # noqa: BLE001 - 探针只比较异常类型
        err = type(e).__name__
    return {"stdout": buf.getvalue(), "error": err, "value": val}

rows1 = [{"id": "p", "amount": 3}, {"id": "q", "amount": -8}, {"id": "p", "amount": 12}]
rows2 = [{"id": "z", "amount": 0}]
cases = [
    ("summarize", rows1),
    ("summarize", rows2),
    ("group_by", rows1, "id"),
    ("format_row", {"id": "p", "amount": 3}),
    ("format_row", {"id": "p"}),
]
diffs = []
for case in cases:
    name, args = case[0], case[1:]
    ra = capture(a, getattr(a, name), *args)
    rb = capture(b, getattr(b, name), *args)
    if ra != rb:
        diffs.append({"case": name, "args": args, "pristine": ra, "candidate": rb})
print(json.dumps({"diffs": diffs}, sort_keys=True, ensure_ascii=False))
`;

// ═════════════════════════════ T2: 脏 CSV → SQLite ETL ═════════════════════════════
export const T2_CUSTOMERS = [
  { id: 'c1', name: 'Ada', country: 'US' },
  { id: 'c2', name: 'Bob', country: 'DE' },
];
export const T2_ORDERS = [
  { order_id: 'o1', customer_id: 'c1', amount: '100.50', ts: '2024-01-05', note: 'first, order' },
  { order_id: 'o2', customer_id: 'c2', amount: '250.00', ts: '2024-01-15', note: 'plain' },
  { order_id: 'o3', customer_id: 'c1', amount: '50.25', ts: '2024-02-01', note: 'has "quotes"' },
  { order_id: 'o4', customer_id: 'c9', amount: '75.00', ts: '2024-02-03', note: 'unknown customer' },
  { order_id: 'o5', customer_id: 'c2', amount: '-10.00', ts: '2024-02-04', note: 'negative' },
  { order_id: 'o6', customer_id: 'c1', amount: 'abc', ts: '2024-02-05', note: 'bad amount' },
  { order_id: 'o7', customer_id: 'c2', amount: '10.00', ts: '2024-02-06', note: 'ok' },
  { order_id: 'o7', customer_id: 'c2', amount: '20.00', ts: '2024-02-07', note: 'duplicate id' },
  { order_id: 'o8', customer_id: 'c2', amount: '5.00', ts: '2024-03-01', note: 'ok' },
  { order_id: 'o9', customer_id: '', amount: '12.00', ts: '2024-03-02', note: 'no customer' },
];

const round2 = (x) => Math.round(x * 100) / 100;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function csvEscape(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** \u73b0\u5b9e\u4e16\u754c\u7684\u810f CSV\uff1aBOM + CRLF + \u672b\u5c3e\u7a7a\u884c\uff08\u89e3\u6790\u5668\u5fc5\u987b\u663e\u5f0f\u5904\u7406\uff09\u3002 */
function toCsv(headers, rows, { bom = false, crlf = false } = {}) {
  const eol = crlf ? '\r\n' : '\n';
  const head = headers.join(',');
  const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')).join(eol);
  return `${bom ? '\ufeff' : ''}${head}${eol}${body}${eol}${eol}`;
}

export const T2_CSV = toCsv(['order_id', 'customer_id', 'amount', 'ts', 'note'], T2_ORDERS, { bom: true, crlf: true });
export const T2_CUSTOMERS_JSON = JSON.stringify({ customers: T2_CUSTOMERS }, null, 2) + '\n';

/** T2 参考结果：接受集、拒绝原因、报表聚合（口径见任务书）。 */
export function t2Ref() {
  const byId = new Map(T2_CUSTOMERS.map((c) => [c.id, c]));
  const seen = new Set();
  const accepted = [];
  const rejects = [];
  for (const r of T2_ORDERS) {
    const amt = Number(r.amount);
    if (!Number.isFinite(amt)) { rejects.push({ order_id: r.order_id, reason: 'bad_amount' }); continue; }
    if (amt < 0) { rejects.push({ order_id: r.order_id, reason: 'negative_amount' }); continue; }
    if (!r.customer_id || !byId.has(r.customer_id)) { rejects.push({ order_id: r.order_id, reason: 'orphan_customer' }); continue; }
    if (seen.has(r.order_id)) { rejects.push({ order_id: r.order_id, reason: 'duplicate' }); continue; }
    seen.add(r.order_id);
    accepted.push({ order_id: r.order_id, customer_id: r.customer_id, amount: round2(amt), ts: r.ts });
  }
  const rejectsByReason = {};
  for (const r of rejects) rejectsByReason[r.reason] = (rejectsByReason[r.reason] || 0) + 1;
  const revenueByCountry = {};
  const totals = new Map();
  const monthly = {};
  for (const r of accepted) {
    const country = byId.get(r.customer_id).country;
    revenueByCountry[country] = round2((revenueByCountry[country] || 0) + r.amount);
    totals.set(r.customer_id, round2((totals.get(r.customer_id) || 0) + r.amount));
    const m = r.ts.slice(0, 7);
    monthly[m] = round2((monthly[m] || 0) + r.amount);
  }
  const top = [...totals.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
  return {
    accepted: accepted.length,
    rejected: rejects.length,
    rejectsByReason,
    revenueByCountry,
    topCustomer: top ? { id: top[0], total: top[1] } : null,
    monthly,
    acceptedRows: accepted,
    rejectRows: rejects,
  };
}
export const t2Report = () => {
  const r = t2Ref();
  return {
    accepted: r.accepted, rejected: r.rejected, rejectsByReason: r.rejectsByReason,
    revenueByCountry: r.revenueByCountry, topCustomer: r.topCustomer, monthly: r.monthly,
  };
};

// ═════════════════════════════ T3: Git 缺陷取证 ═════════════════════════════
export const T3_STEPS = 10;
export const T3_BAD_STEP = 7;
export const T3_BASE_CALC = `"""Pricing helpers."""


def add(a, b):
    return a + b


def discount(price, rate):
    return price * (1 - rate)
`;
export const T3_TEST = `import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import calc


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(calc.add(2, 3), 5)

    def test_discount(self):
        self.assertAlmostEqual(calc.discount(100, 0.2), 80.0)


if __name__ == "__main__":
    unittest.main()
`;

export const T3_B_STEPS = 8;
export const T3_B_BAD_STEP = 4;
export const T3_B_BASE = `"""Tax helpers."""


def apply_tax(amount, rate):
    return amount * (1 + rate)
`;
export const T3_B_TEST = `import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pricing


class PricingTest(unittest.TestCase):
    def test_apply_tax(self):
        self.assertAlmostEqual(pricing.apply_tax(100, 0.1), 110.0)


if __name__ == "__main__":
    unittest.main()
`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function buildGitRepo(dir, { file, base, testFile, testDir, steps, badStep, subjectPrefix }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, testDir), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, testDir, testFile), T3_TEST_TEMPLATES[testFile]);
  fs.writeFileSync(path.join(dir, file), base);
  git(dir, ['add', '-A']);
  const date0 = Date.UTC(2024, 0, 1, 0, 0, 0);
  let stamp = 0;
  const commit = (subject) => {
    const d = new Date(date0 + stamp * 60000).toISOString();
    git(dir, ['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
    stamp += 1;
  };
  commit('step-0: initial');
  for (let i = 1; i <= steps; i++) {
    let src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (i === badStep) src = src.replace(T3_BUG_FROM[file], T3_BUG_TO[file]);
    src += `\n# step ${i}\n`;
    fs.writeFileSync(path.join(dir, file), src);
    git(dir, ['add', '-A']);
    commit(`${subjectPrefix}-${i}: change`);
  }
  return dir;
}

const T3_TEST_TEMPLATES = { 'test_calc.py': T3_TEST, 'test_pricing.py': T3_B_TEST };
const T3_BUG_FROM = {
  'calc.py': '    return price * (1 - rate)',
  'pricing.py': '    return amount * (1 + rate)',
};
const T3_BUG_TO = {
  'calc.py': '    return price * rate',
  'pricing.py': '    return amount * rate',
};

/** 通过提交标题定位坏提交（与哈希无关，便于 CHECK_ONLY 复算）。 */
export function t3GroundTruth(repoDir, prefix, badStep) {
  const log = git(repoDir, ['log', '--format=%H%x09%s']).trim().split('\n');
  const rows = log.map((l) => l.split('\t'));
  const bad = rows.find(([, s]) => s.startsWith(`${prefix}-${badStep}:`));
  const good = rows.find(([, s]) => s.startsWith(`${prefix}-${badStep - 1}:`));
  return { bad_commit: bad ? bad[0] : null, last_good: good ? good[0] : null, bad_subject: bad ? bad[1] : null };
}

// ═════════════════════════════ T4: 分页 HTTP 客户端 ═════════════════════════════
export const T4_ITEMS = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));
export const T4_PAGE = 3;
export const T4_MOCK_SERVER = `import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ITEMS = [{"id": i, "name": "item-%d" % i} for i in range(1, 9)]
PAGE = 3
STATE = {}


class H(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=None, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            raw = json.dumps(body, sort_keys=True).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        else:
            self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        run = (q.get("run") or ["default"])[0]
        st = STATE.setdefault(run, {"requests": 0, "retries429": 0, "notModified": 0, "cursors": {}})
        st["requests"] += 1
        if u.path == "/stats":
            self._send(200, st)
            return
        if u.path != "/api/items":
            self._send(404, {"error": "not_found"})
            return
        cur = (q.get("cursor") or ["0"])[0]
        cs = st["cursors"].setdefault(cur, {"attempts": 0, "etagHits": 0})
        cs["attempts"] += 1
        if cs["attempts"] == 1 and not self.headers.get("If-None-Match"):
            st["retries429"] += 1
            self._send(429, {"error": "rate_limited"}, {"Retry-After": "1"})
            return
        off = int(cur)
        page = ITEMS[off:off + PAGE]
        nxt = str(off + PAGE) if off + PAGE < len(ITEMS) else None
        body = {"items": page, "next": nxt}
        etag = '"' + hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest() + '"'
        if self.headers.get("If-None-Match") == etag:
            cs["etagHits"] += 1
            st["notModified"] += 1
            self._send(304, None, {"ETag": etag})
            return
        self._send(200, body, {"ETag": etag})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(srv.server_address[1], flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
`;

// ═════════════════════════════ T5: 密钥扫描器 ═════════════════════════════
export const T5_IGNORE = ['vendor/', 'legacy/**', 'ignored.md'];
const T5_TOKEN = 'Qm9vR2xhc3Nlc0FyZUdyZWF0VG9rZW5zRm9yVGVzdGluZzEyMzQ1Ng';
const T5_AWS = 'AKIA1234567890ABCDEF';
export const T5_FILES = [
  { rel: 'config.py', lines: ['import os', '', `AWS_ACCESS_KEY_ID = "${T5_AWS}"`, 'SECRET = "short"'], findings: [{ line: 3, type: 'aws_access_key' }] },
  { rel: 'deploy.sh', lines: ['#!/bin/bash', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'], findings: [{ line: 2, type: 'private_key' }] },
  { rel: 'tokens.json', lines: ['{', `  "api_token": "${T5_TOKEN}",`, '}'], findings: [{ line: 2, type: 'high_entropy' }] },
  {
    rel: 'notes.md',
    lines: [
      '# Notes',
      'The quick brown fox jumps over the lazy dog.',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'deadbeefdeadbeefdeadbeefdeadbeef',
      `tok_${T5_TOKEN} # secret-scan:ignore`,
    ],
    findings: [],
  },
  { rel: 'vendor/lib.js', lines: [`var k = "${T5_AWS}";`], findings: [] },
  { rel: 'legacy/old.py', lines: [`KEY = "${T5_AWS}"`], findings: [] },
  { rel: 'ignored.md', lines: [`token ${T5_TOKEN}`], findings: [] },
];

export const T5_HOLDOUT_FILES = [
  { rel: 'settings/aws.env', lines: ['REGION=us-east-1', `ID=AKIAZZZZZZZZZZZZZZZZ`], findings: [{ line: 2, type: 'aws_access_key' }] },
  { rel: 'keys/server.pem', lines: ['subject=CN=test', '-----BEGIN EC PRIVATE KEY-----', 'MHcCAQEE'], findings: [{ line: 2, type: 'private_key' }] },
  { rel: 'data/blob.json', lines: ['{', `  "refresh": "Zx9Qm2Lp7Rt4Vw1Yb6Nc3Kd8Hf5Gj0As2Dq4Ee6Ui8Oo0Pa"`, '}'], findings: [{ line: 2, type: 'high_entropy' }] },
  { rel: 'docs/readme.md', lines: [`leak ${T5_TOKEN}`], findings: [] },
];
export const T5_HOLDOUT_IGNORE = ['docs/'];

export const T5_ENTROPY_MIN = 3.5;
export const T5_TOKEN_RE = /[A-Za-z0-9_\-+/=]{32,}/g;
export const T5_AWS_RE = /AKIA[0-9A-Z]{16}/;
export const T5_PK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
export const T5_INLINE_IGNORE = 'secret-scan:ignore';

/** 路径是否被 .secretsignore 规则命中（`dir/` 前缀、`**` 任意层、其余按通配）。 */
export function t5Ignored(rel, rules) {
  const p = rel.replace(/\\/g, '/');
  for (const raw of rules) {
    const rule = raw.trim();
    if (!rule) continue;
    if (rule.endsWith('/')) {
      if (p === rule.slice(0, -1) || p.startsWith(rule)) return true;
      continue;
    }
    const re = new RegExp('^' + rule.split('**').map((s) => s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
    if (re.test(p)) return true;
  }
  return false;
}

/** T5 参考扫描（与任务书口径一致）。 */
export function t5Scan(files, rules) {
  const out = [];
  for (const f of files) {
    if (t5Ignored(f.rel, rules)) continue;
    f.lines.forEach((line, i) => {
      if (line.includes(T5_INLINE_IGNORE)) return;
      const types = [];
      if (T5_AWS_RE.test(line)) types.push('aws_access_key');
      if (T5_PK_RE.test(line)) types.push('private_key');
      for (const m of line.matchAll(T5_TOKEN_RE)) {
        if (shannon(m[0]) >= T5_ENTROPY_MIN) { types.push('high_entropy'); break; }
      }
      for (const t of new Set(types)) out.push({ file: f.rel, line: i + 1, type: t, severity: 'high' });
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.type.localeCompare(b.type));
}
export const t5Ref = () => t5Scan(T5_FILES, T5_IGNORE);
export const t5HoldoutRef = () => t5Scan(T5_HOLDOUT_FILES, T5_HOLDOUT_IGNORE);

// ═════════════════════════════ T6: 账本对账 ═════════════════════════════
export const T6_LEDGER = [
  { id: 'L1', date: '2024-03-01', ref: 'INV-100', amountCents: 12000 },
  { id: 'L2', date: '2024-03-02', ref: 'INV-101', amountCents: 5000 },
  { id: 'L3', date: '2024-03-03', ref: 'INV-102', amountCents: -2500 },
  { id: 'L4', date: '2024-03-04', ref: 'INV-103', amountCents: 9900 },
  { id: 'L5', date: '2024-03-05', ref: 'INV-104', amountCents: 1000 },
];
export const T6_BANK = [
  { date: '2024-03-01', description: 'Payment INV-100', amount: '120.00' },
  { date: '2024-03-02', description: 'INV-101 settlement', amount: '50.00' },
  { date: '2024-03-04', description: 'card refund INV-102', amount: '-25.00' },
  { date: '2024-03-04', description: 'INV-103', amount: '99.01' },
  { date: '2024-03-06', description: 'misc charge', amount: '10.00' },
  { date: '2024-03-07', description: 'INV-999 unknown', amount: '42.00' },
];

export function parseCents(s) {
  const t = String(s).replace(/,/g, '').trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0')));
}
const dayNum = (d) => Math.floor(Date.UTC(...d.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) / 86400000);

export function t6Ref() {
  const used = new Set();
  const matched = [];
  const bankOnly = [];
  const priority = { exact: 0, amount_tolerance: 1, date_tolerance: 2 };
  T6_BANK.forEach((b, idx) => {
    const cents = parseCents(b.amount);
    const cand = [];
    for (const l of T6_LEDGER) {
      if (used.has(l.id)) continue;
      if (!b.description.includes(l.ref)) continue;
      const sameDay = l.date === b.date;
      const sameAmount = l.amountCents === cents;
      let rule = null;
      if (sameDay && sameAmount) rule = 'exact';
      else if (sameDay && Math.abs(l.amountCents - cents) <= 1) rule = 'amount_tolerance';
      else if (!sameDay && sameAmount && Math.abs(dayNum(l.date) - dayNum(b.date)) <= 3) rule = 'date_tolerance';
      if (rule) cand.push({ l, rule });
    }
    if (!cand.length) { bankOnly.push(idx); return; }
    // 同级候选取 ledger id 字典序最小者（确定性）。
    cand.sort((a, b2) => (priority[a.rule] - priority[b2.rule]) || a.l.id.localeCompare(b2.l.id));
    used.add(cand[0].l.id);
    matched.push({ ledgerId: cand[0].l.id, bankIndex: idx, rule: cand[0].rule });
  });
  const ledgerOnly = T6_LEDGER.filter((l) => !used.has(l.id)).map((l) => l.id);
  const ledgerTotalCents = T6_LEDGER.reduce((a, l) => a + l.amountCents, 0);
  const bankTotalCents = T6_BANK.reduce((a, b) => a + (parseCents(b.amount) || 0), 0);
  const matchedTotalCents = T6_LEDGER.filter((l) => used.has(l.id)).reduce((a, l) => a + l.amountCents, 0);
  return {
    matched, ledgerOnly, bankOnly,
    summary: {
      ledgerCount: T6_LEDGER.length, bankCount: T6_BANK.length, matchedCount: matched.length,
      ledgerTotalCents, bankTotalCents, matchedTotalCents,
    },
  };
}

// ═════════════════════════════ T7: 结构化日志器 ═════════════════════════════
export const T7_REDACT = ['password', 'key', 'secret'];
export const T7_SAMPLE_EVERY = 3;
export const T7_MAX_BYTES = 700;
export const T7_MAX_FILES = 3;
/** 采样口径：info 仅当 fnv1a32(msg) % sampleEvery == 0 时落盘；warn/error 恒落盘。 */
export const t7Sampled = (msg) => fnv1a32(msg) % T7_SAMPLE_EVERY === 0;

export function t7Driver(loggerPath, outDir) {
  const code = `
const path = require('path');
const { createLogger } = require(${JSON.stringify(loggerPath)});
let t = 0;
const clock = () => new Date(Date.UTC(2024, 0, 1, 0, 0, t++));
const logger = createLogger({
  dir: ${JSON.stringify(outDir)},
  maxBytes: ${T7_MAX_BYTES},
  maxFiles: ${T7_MAX_FILES},
  sampleEvery: ${T7_SAMPLE_EVERY},
  redactKeys: ${JSON.stringify(T7_REDACT)},
  clock,
});
for (let i = 0; i < 20; i++) logger.info('m' + i, { password: 'p' + i, nested: { apiKey: 'k' + i }, tags: [{ secret: 's' }] });
logger.warn('w1', { note: 'keep' });
logger.error('e1', { token: 'visible', password: 'hide' });
logger.warn('w2', {});
logger.error('e2', {});
console.log('DONE');
`;
  return code;
}

// ═════════════════════════════ T8: 队列 worker ═════════════════════════════
export const T8_JOBS = [
  { id: 'j1', value: 1, failTimes: 0 },
  { id: 'j2', value: 2, failTimes: 1 },
  { id: 'j3', value: 3, failTimes: 2 },
  { id: 'j4', value: 4, failTimes: 0 },
  { id: 'j5', value: 5, failTimes: 3 },
  { id: 'j6', value: 6, failTimes: 1 },
];
export const T8_JOBS_JSONL = T8_JOBS.map((j) => JSON.stringify(j)).join('\n') + '\n';

// ═════════════════════════════ T9: 覆盖率门禁 ═════════════════════════════
export const T9_JUNIT = [
  { file: 'test_a.xml', suite: 'suite_a', tests: 5, failures: 1, errors: 0, skipped: 0 },
  { file: 'test_b.xml', suite: 'suite_b', tests: 4, failures: 0, errors: 1, skipped: 1 },
  { file: 'test_c.xml', suite: 'suite_c', tests: 3, failures: 0, errors: 0, skipped: 0 },
];
export const T9_COVERAGE = [
  { file: 'core.json', files: { 'core/a.py': { coveredLines: 80, totalLines: 100 }, 'core/b.py': { coveredLines: 10, totalLines: 50 } } },
  { file: 'api.json', files: { 'api/handlers.py': { coveredLines: 45, totalLines: 50 } } },
];
export const T9_THRESHOLDS = { minLineCoverage: 80, maxFailures: 1 };

export function t9Ref(junit = T9_JUNIT, coverage = T9_COVERAGE, thresholds = T9_THRESHOLDS) {
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0, coveredLines: 0, totalLines: 0, lineCoverage: 0 };
  for (const s of junit) {
    totals.tests += s.tests; totals.failures += s.failures; totals.errors += s.errors; totals.skipped += s.skipped;
  }
  const modules = {};
  for (const c of coverage) {
    for (const [p, v] of Object.entries(c.files)) {
      const mod = p.split('/')[0];
      const m = modules[mod] || (modules[mod] = { coveredLines: 0, totalLines: 0, lineCoverage: 0 });
      m.coveredLines += v.coveredLines;
      m.totalLines += v.totalLines;
      totals.coveredLines += v.coveredLines;
      totals.totalLines += v.totalLines;
    }
  }
  totals.lineCoverage = totals.totalLines ? round2((totals.coveredLines / totals.totalLines) * 100) : 0;
  for (const m of Object.values(modules)) m.lineCoverage = m.totalLines ? round2((m.coveredLines / m.totalLines) * 100) : 0;
  const violations = [];
  if (totals.lineCoverage < thresholds.minLineCoverage) violations.push('line_coverage_below_min');
  if (totals.failures + totals.errors > thresholds.maxFailures) violations.push('too_many_failures');
  violations.sort();
  return { totals, modules, passed: violations.length === 0, violations };
}

export function t9JunitXml(s) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${s.suite}" tests="${s.tests}" failures="${s.failures}" errors="${s.errors}" skipped="${s.skipped}">\n    <testcase name="case_1"/>\n  </testsuite>\n</testsuites>\n`;
}

// ═════════════════════════════ T10: 增量构建 ═════════════════════════════
export const T10_BUILD = {
  targets: {
    a: { inputs: ['src/a.txt'], cmd: 'cp src/a.txt out/a.txt', output: 'out/a.txt' },
    b: { inputs: ['src/b.txt', 'out/a.txt'], cmd: 'cp src/b.txt out/b.txt', output: 'out/b.txt' },
    c: { inputs: ['out/a.txt', 'out/b.txt'], cmd: 'cat out/a.txt out/b.txt > out/c.txt', output: 'out/c.txt' },
  },
};
export const T10_CYCLE = {
  targets: {
    x: { inputs: ['out/y.txt'], cmd: 'true', output: 'out/x.txt' },
    y: { inputs: ['out/x.txt'], cmd: 'true', output: 'out/y.txt' },
  },
};

// ═════════════════════════════ seed ═════════════════════════════
function writeText(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function writeFixtureFile(dir, rel, content) {
  const p = writeText(dir, rel, content);
  // ★ v34 run1 假回归：frozenCheck（v14/lib.mjs）用 hashFile() = sha1sum 比较，
  //   这里旧实现记的是 sha256hex(content) → 每个冻结文件都被判「被改动」。
  //   黄金实现只调 task.exec、不走 frozenCheck，所以 10/10 通过掩盖了它。
  //   统一到 sha1（= hashFile 的算法，只是不 spawn sha1sum，免去引号转义）。
  FIXTURE_HASHES.set(p, createHash('sha1').update(content, 'utf8').digest('hex'));
  return p;
}

function seedT5Tree(root, files, ignore) {
  fs.rmSync(root, { recursive: true, force: true });
  // ★ 同 writeFixtureFile：冻结文件必须登记哈希，否则 frozenCheck 拿到
  //   undefined 一律判「被改动」（v34 run1 的另一半根因）。
  for (const f of files) writeFixtureFile(root, f.rel, f.lines.join('\n') + '\n');
  writeFixtureFile(root, '.secretsignore', ignore.join('\n') + '\n');
}

export function seed() {
  // T1
  const t1 = D(1);
  writeFixtureFile(t1, 'legacy/report_gen.py', T1_LEGACY);
  writeFixtureFile(t1, 'legacy/test_report_gen.py', T1_TEST);
  fs.mkdirSync(REF_DIR, { recursive: true });
  fs.writeFileSync(path.join(REF_DIR, 't1-report_gen.py'), T1_LEGACY, 'utf8');

  // T2
  writeFixtureFile(D(2), 'orders.csv', T2_CSV);
  writeFixtureFile(D(2), 'customers.json', T2_CUSTOMERS_JSON);

  // T3：可见仓库 A + 未见仓库 B（/tmp）
  buildGitRepo(path.join(D(3), 'repo'), {
    file: 'calc.py', base: T3_BASE_CALC, testFile: 'test_calc.py', testDir: 'tests',
    steps: T3_STEPS, badStep: T3_BAD_STEP, subjectPrefix: 'step',
  });
  buildGitRepo(HOLDOUT_T3, {
    file: 'pricing.py', base: T3_B_BASE, testFile: 'test_pricing.py', testDir: 'tests',
    steps: T3_B_STEPS, badStep: T3_B_BAD_STEP, subjectPrefix: 'step',
  });

  // T4
  writeFixtureFile(D(4), 'mock_server.py', T4_MOCK_SERVER);

  // T5：可见树 + 未见树
  seedT5Tree(path.join(D(5), 'scan'), T5_FILES, T5_IGNORE);
  seedT5Tree(HOLDOUT_T5, T5_HOLDOUT_FILES, T5_HOLDOUT_IGNORE);

  // T6
  writeFixtureFile(D(6), 'ledger.jsonl', T6_LEDGER.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFixtureFile(D(6), 'bank.csv', toCsv(['date', 'description', 'amount'], T6_BANK));

  // T8
  writeFixtureFile(D(8), 'jobs.jsonl', T8_JOBS_JSONL);

  // T9
  for (const s of T9_JUNIT) writeFixtureFile(D(9), `junit/${s.file}`, t9JunitXml(s));
  for (const c of T9_COVERAGE) writeFixtureFile(D(9), `coverage/${c.file}`, JSON.stringify({ files: c.files }, null, 2) + '\n');
  writeFixtureFile(D(9), 'thresholds.json', JSON.stringify(T9_THRESHOLDS, null, 2) + '\n');

  // T10
  writeFixtureFile(D(10), 'src/a.txt', 'alpha\n');
  writeFixtureFile(D(10), 'src/b.txt', 'bravo\n');
  writeFixtureFile(D(10), 'src/c.txt', 'charlie\n');
  writeFixtureFile(D(10), 'build.json', JSON.stringify(T10_BUILD, null, 2) + '\n');
  writeFixtureFile(D(10), 'cycle.json', JSON.stringify(T10_CYCLE, null, 2) + '\n');
}

export function saveFixtureHashes(file = `${WS}/v34-fixture-hashes.json`) {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURE_HASHES), null, 2));
}
export function loadFixtureHashes(file = `${WS}/v34-fixture-hashes.json`) {
  if (!fs.existsSync(file)) return;
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8')))) FIXTURE_HASHES.set(k, v);
}

// ═════════════════════════════ 自校准 ═════════════════════════════
// 每条锚定外部已知向量或手算不变量，防止参考实现漂移。
export function selfCheck() {
  const bad = [];
  if (fnv1a32('hello') !== 1335831723) bad.push('fnv1a32(hello) 向量');
  if (sha256hex('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') bad.push('sha256(abc) 向量');
  if (Math.abs(shannon('abcd') - 2) > 1e-9) bad.push('shannon(abcd) 应为 2');
  if (Math.abs(shannon('aaaaaaaa')) > 1e-9) bad.push('shannon(重复字符) 应为 0');
  if (shannon('deadbeefdeadbeefdeadbeefdeadbeef') >= T5_ENTROPY_MIN) bad.push('低熵 hex 不应越过阈值');

  // T2 手算锚点
  const r2 = t2Ref();
  if (r2.accepted !== 5 || r2.rejected !== 5) bad.push(`T2 计数漂移 ${r2.accepted}/${r2.rejected}`);
  if (r2.rejectsByReason.orphan_customer !== 2 || r2.rejectsByReason.duplicate !== 1) bad.push('T2 拒绝原因漂移: ' + JSON.stringify(r2.rejectsByReason));
  if (r2.revenueByCountry.US !== 150.75 || r2.revenueByCountry.DE !== 265) bad.push('T2 国家营收漂移: ' + JSON.stringify(r2.revenueByCountry));
  if (!r2.topCustomer || r2.topCustomer.id !== 'c2' || r2.topCustomer.total !== 265) bad.push('T2 topCustomer 漂移');
  if (r2.monthly['2024-01'] !== 350.5 || r2.monthly['2024-02'] !== 60.25 || r2.monthly['2024-03'] !== 5) bad.push('T2 月度漂移: ' + JSON.stringify(r2.monthly));

  // T5 参考：可见树应恰有 3 条 finding，且忽略规则生效
  const r5 = t5Ref();
  if (r5.length !== 3) bad.push('T5 可见树 finding 数 ' + r5.length + ' != 3: ' + JSON.stringify(r5));
  if (!r5.some((f) => f.file === 'config.py' && f.type === 'aws_access_key')) bad.push('T5 AWS 未检出');
  if (!r5.some((f) => f.file === 'deploy.sh' && f.type === 'private_key')) bad.push('T5 私钥未检出');
  if (!r5.some((f) => f.file === 'tokens.json' && f.type === 'high_entropy')) bad.push('T5 高熵未检出');
  if (t5HoldoutRef().length !== 3) bad.push('T5 未见树 finding 数漂移: ' + JSON.stringify(t5HoldoutRef()));
  if (t5Ignored('vendor/lib.js', T5_IGNORE) !== true) bad.push('T5 vendor/ 忽略失效');
  if (t5Ignored('legacy/old.py', T5_IGNORE) !== true) bad.push('T5 legacy/** 忽略失效');

  // T6 手算锚点
  const r6 = t6Ref();
  if (r6.matched.length !== 4) bad.push('T6 matched ' + r6.matched.length + ' != 4');
  if (JSON.stringify(r6.ledgerOnly) !== '["L5"]') bad.push('T6 ledgerOnly 漂移: ' + JSON.stringify(r6.ledgerOnly));
  if (JSON.stringify(r6.bankOnly) !== '[4,5]') bad.push('T6 bankOnly 漂移: ' + JSON.stringify(r6.bankOnly));
  if (r6.summary.ledgerTotalCents !== 25400 || r6.summary.bankTotalCents !== 29601 || r6.summary.matchedTotalCents !== 24400) {
    bad.push('T6 合计漂移: ' + JSON.stringify(r6.summary));
  }
  if (parseCents('1,234.56') !== 123456 || parseCents('-25.00') !== -2500) bad.push('T6 金额解析漂移');

  // T9 手算锚点
  const r9 = t9Ref();
  if (r9.totals.tests !== 12 || r9.totals.failures !== 1 || r9.totals.errors !== 1 || r9.totals.skipped !== 1) bad.push('T9 JUnit 合计漂移');
  if (r9.totals.lineCoverage !== 67.5) bad.push('T9 总覆盖率 ' + r9.totals.lineCoverage + ' != 67.5');
  if (r9.modules.core.lineCoverage !== 60 || r9.modules.api.lineCoverage !== 90) bad.push('T9 模块覆盖率漂移: ' + JSON.stringify(r9.modules));
  if (r9.passed !== false || JSON.stringify(r9.violations) !== '["line_coverage_below_min","too_many_failures"]') bad.push('T9 门禁判定漂移: ' + JSON.stringify(r9.violations));

  // T7 采样确定性：同一 msg 重复计算一致，且比例接近 1/N
  const hits = Array.from({ length: 300 }, (_, i) => t7Sampled('m' + i)).filter(Boolean).length;
  if (hits < 60 || hits > 140) bad.push('T7 采样比例异常: ' + hits + '/300');

  return bad;
}

/**
 * 交叉校验：任务核验器里的硬编码期望必须由参考实现复算得出
 * （v32 F1 教训：探针期望与参考实现撕裂时，只有交叉校验能挡住）。
 */
export const PROBE_VECTORS = {
  fnv: { input: 'hello', expected: 1335831723 },
  sha: { input: 'abc', expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  t2Accepted: 5,
  t5Count: 3,
  t6Matched: 4,
  t9Coverage: 67.5,
};

export function crossCheck() {
  const bad = [];
  const p = PROBE_VECTORS;
  if (fnv1a32(p.fnv.input) !== p.fnv.expected) bad.push('cross fnv');
  if (sha256hex(p.sha.input) !== p.sha.expected) bad.push('cross sha');
  if (t2Ref().accepted !== p.t2Accepted) bad.push('cross t2');
  if (t5Ref().length !== p.t5Count) bad.push('cross t5');
  if (t6Ref().matched.length !== p.t6Matched) bad.push('cross t6');
  if (t9Ref().totals.lineCoverage !== p.t9Coverage) bad.push('cross t9');
  return bad;
}
