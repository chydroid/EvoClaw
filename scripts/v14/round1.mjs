/**
 * Round 1 — 数据库 / SQL 工程
 *  1. SQLite schema 设计 + 迁移
 *  2. 多表 SQL 聚合报表
 *  3. 数据完整性审计与修复
 *  4. 索引优化与查询计划
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  WS, defineChecks, runNodeScript, runNodeWithCode, runNodeCheck, runNodeTest,
  runPy, readFileSafe, writeFixture, isFresh, hashFile, fileSize, FIXTURE_HASHES,
} from './lib.mjs';

const D1 = `${WS}/v14-db-schema`;
const D2 = `${WS}/v14-sql-report`;
const D3 = `${WS}/v14-db-integrity`;
const D4 = `${WS}/v14-db-perf`;

const SEED = {
  users: [
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
    { id: 3, name: 'Carol', email: 'carol@example.com' },
    { id: 4, name: 'Dave', email: 'dave@example.com' },
    { id: 5, name: 'Eve', email: 'eve@example.com' },
  ],
  orders: [
    { id: 1, user_id: 1, amount_cents: 1200, status: 'paid', created_at: '2026-01-02T10:00:00Z' },
    { id: 2, user_id: 2, amount_cents: 800, status: 'pending', created_at: '2026-01-03T11:00:00Z' },
    { id: 3, user_id: 1, amount_cents: 300, status: 'paid', created_at: '2026-01-05T09:00:00Z' },
    { id: 4, user_id: 3, amount_cents: 450, status: 'refunded', created_at: '2026-01-07T09:00:00Z' },
    { id: 5, user_id: 4, amount_cents: 900, status: 'paid', created_at: '2026-01-09T09:00:00Z' },
    { id: 6, user_id: 2, amount_cents: 0, status: 'paid', created_at: '2026-01-10T09:00:00Z' },
    { id: 7, user_id: 5, amount_cents: 1500, status: 'paid', created_at: '2026-01-12T09:00:00Z' },
    { id: 8, user_id: 3, amount_cents: 250, status: 'pending', created_at: '2026-01-13T09:00:00Z' },
  ],
};

const SHOP_SQL = `
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, unit_cents INTEGER NOT NULL, PRIMARY KEY(order_id, product_id));
INSERT INTO users (id,name) VALUES (1,'Alice'),(2,'Bob'),(3,'Carol'),(4,'Dave');
INSERT INTO products (id,name) VALUES (10,'Widget'),(11,'Gadget'),(12,'Gizmo');
INSERT INTO orders (id,user_id,created_at,status) VALUES
  (1,1,'2026-01-05','paid'),(2,2,'2026-01-20','paid'),(3,1,'2026-02-03','paid'),(4,3,'2026-02-10','refunded'),
  (5,2,'2026-02-15','paid'),(6,4,'2026-03-01','paid'),(7,3,'2026-03-11','paid'),(8,1,'2026-03-20','pending');
INSERT INTO order_items (order_id,product_id,quantity,unit_cents) VALUES
  (1,10,2,500),(1,11,1,300),(2,11,3,300),(2,10,1,500),(3,10,1,500),(3,12,2,700),
  (4,10,4,500),(5,12,1,700),(6,10,2,500),(6,11,2,300),(7,11,1,300),(8,10,1,500);
`;

const BROKEN_SQL = `
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount_cents INTEGER NOT NULL, status TEXT NOT NULL);
INSERT INTO users (id,email,name) VALUES
  (1,'a@x.com','Amy'),(2,'b@x.com','Ben'),(3,'a@x.com','AmyDupe'),(4,NULL,'Carl'),(5,'d@x.com','Dana');
INSERT INTO orders (id,user_id,amount_cents,status) VALUES
  (101,1,100,'paid'),(102,2,200,'paid'),(103,3,300,'paid'),(104,99,50,'paid'),(105,NULL,70,'paid'),
  (106,4,-40,'paid'),(107,5,0,'refunded'),(108,99,10,'pending'),(109,2,-5,'paid'),(110,5,400,'paid'),(111,1,60,'paid');
`;

const EXPECTED_AUDIT = {
  counts: { orphanOrders: 3, duplicateEmails: 1, nullEmails: 1, negativeAmounts: 2, total: 7 },
  violations: [
    { type: 'duplicate_email', table: 'users', id: 3 },
    { type: 'negative_amount', table: 'orders', id: 106 },
    { type: 'negative_amount', table: 'orders', id: 109 },
    { type: 'null_email', table: 'users', id: 4 },
    { type: 'orphan_order', table: 'orders', id: 104 },
    { type: 'orphan_order', table: 'orders', id: 105 },
    { type: 'orphan_order', table: 'orders', id: 108 },
  ],
};

function makePerfCsv() {
  const users = ['id,name'];
  for (let i = 1; i <= 100; i++) users.push(`${i},user${i}`);
  const orders = ['id,user_id,amount_cents,status,created_at'];
  const statuses = ['paid', 'pending', 'refunded'];
  for (let i = 0; i < 20000; i++) {
    const uid = (i % 100) + 1;
    const amount = 10 + (i * 37) % 9900;
    const status = statuses[i % 3];
    const day = (i % 365);
    const dt = new Date(Date.UTC(2026, 0, 1 + day, (i % 24), (i % 60)));
    orders.push(`${i + 1},${uid},${amount},${status},${dt.toISOString()}`);
  }
  return { users: users.join('\n') + '\n', orders: orders.join('\n') + '\n' };
}

function seed() {
  writeFixture(D1, 'fixtures/seed.json', JSON.stringify(SEED, null, 2));
  writeFixture(D2, 'fixtures/shop.sql', SHOP_SQL);
  writeFixture(D3, 'fixtures/broken.sql', BROKEN_SQL);
  const py = `/tmp/v14-seed-integrity-${Date.now()}.py`;
  fs.writeFileSync(py, `import sqlite3,sys\nsql=open(sys.argv[1]).read()\nc=sqlite3.connect(sys.argv[2])\nc.executescript(sql)\nc.commit()\nc.close()\n`);
  try {
    execFileSync('python3', ['-I', py, path.join(D3, 'fixtures/broken.sql'), path.join(D3, 'fixtures/broken.db')], { encoding: 'utf8' });
  } finally { try { fs.rmSync(py, { force: true }); } catch {} }
  FIXTURE_HASHES.set(path.join(D3, 'fixtures/broken.db'), hashFile(path.join(D3, 'fixtures/broken.db')));
  const perf = makePerfCsv();
  writeFixture(D4, 'fixtures/users.csv', perf.users);
  writeFixture(D4, 'fixtures/orders.csv', perf.orders);
}

// ───────────────────────── 校验脚本 ─────────────────────────

const PY_SCHEMA = `
import sqlite3, sys, json
db = sys.argv[1]
c = sqlite3.connect(db)
c.execute("PRAGMA foreign_keys=ON")
r = {"ok": True, "parts": []}
def bad(msg):
    r["ok"] = False; r["parts"].append(msg)
tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
for t in ("users","orders","schema_migrations","audit_log"):
    if t not in tables: bad(f"缺表 {t}")
cols = [row[1] for row in c.execute("PRAGMA table_info(users)")]
if "loyalty_points" not in cols:
    bad("users 缺 loyalty_points")
else:
    info = [row for row in c.execute("PRAGMA table_info(users)") if row[1]=="loyalty_points"][0]
    if info[3] != 1: bad("loyalty_points 非 NOT NULL")
    if str(info[4]) not in ("0","'0'"): bad(f"loyalty_points 默认值 {info[4]!r}")
fks = list(c.execute("PRAGMA foreign_key_list(orders)"))
if not fks: bad("orders 无外键声明")
idx = []
for row in c.execute("PRAGMA index_list(orders)"):
    name = row[1]
    info = list(c.execute(f"PRAGMA index_info({name})"))
    idx.append([name, [x[2] for x in info]])
if not any("user_id" in cols2 for _, cols2 in idx): bad("orders(user_id) 无索引")
if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] != 5: bad("users 行数≠5")
if c.execute("SELECT COUNT(*) FROM orders").fetchone()[0] != 8: bad("orders 行数≠8")
if c.execute("SELECT COUNT(*) FROM users WHERE loyalty_points IS NULL OR loyalty_points!=0").fetchone()[0] != 0: bad("loyalty_points 初值非0")
mig = c.execute("SELECT version FROM schema_migrations WHERE version=2").fetchall()
if len(mig) != 1: bad(f"schema_migrations version2 行数={len(mig)}")
def expect_fail(sql, label):
    try:
        c.execute(sql); c.rollback(); bad(f"{label} 约束未生效")
    except sqlite3.IntegrityError:
        c.rollback()
try:
    expect_fail("INSERT INTO orders (id,user_id,amount_cents,status,created_at) VALUES (900,999,100,'paid','2026-02-01')", "FK")
    expect_fail("UPDATE users SET email='bob@example.com' WHERE id=1", "UNIQUE email")
    expect_fail("INSERT INTO orders (id,user_id,amount_cents,status,created_at) VALUES (901,1,-1,'paid','2026-02-01')", "CHECK amount")
    expect_fail("INSERT INTO orders (id,user_id,amount_cents,status,created_at) VALUES (902,1,10,'bad','2026-02-01')", "CHECK status")
except Exception as e:
    bad(f"约束测试异常 {e}")
if not r["parts"]: r["parts"].append("schema/FK/约束/迁移全部通过")
print(json.dumps(r))
`;

const PY_AUDIT = `
import sqlite3, sys, json
db = sys.argv[1]
c = sqlite3.connect(db)
expected = json.loads(sys.argv[2])
r = {"ok": True, "parts": []}
def bad(m): r["ok"]=False; r["parts"].append(m)
# 独立复算（用于修复后状态检查或报告存在性检查）
users = list(c.execute("SELECT id,email FROM users ORDER BY id"))
orders = list(c.execute("SELECT id,user_id,amount_cents FROM orders ORDER BY id"))
uids = {u[0] for u in users}
orphans = [o[0] for o in orders if o[1] is None or o[1] not in uids]
neg = [o[0] for o in orders if o[2] < 0]
emails = {}
for uid,email in users:
    if email: emails.setdefault(email, []).append(uid)
dups = [ids[1] for ids in emails.values() if len(ids) > 1]
nulls = [uid for uid,email in users if email is None or str(email).strip()=='']
r["actual"] = {"orphanOrders": orphans, "negativeAmounts": neg, "duplicateEmails": dups, "nullEmails": nulls}
if sys.argv[2] == "{}":
    if len(orphans)+len(neg)+len(dups)+len(nulls) != 0:
        bad(f"修复后仍有违规 {r['actual']}")
else:
    got = json.loads(open(sys.argv[3]).read())
    if got != expected: bad(f"审计报告与独立预期不一致")
print(json.dumps(r))
`;

const PY_REPAIR = `
import sqlite3, sys, json
db = sys.argv[1]
c = sqlite3.connect(db)
r = {"ok": True, "parts": []}
def bad(m): r["ok"]=False; r["parts"].append(m)
users = list(c.execute("SELECT id,email FROM users ORDER BY id"))
orders = list(c.execute("SELECT id,user_id,amount_cents FROM orders ORDER BY id"))
uids = {u[0] for u in users}
orphans = [o[0] for o in orders if o[1] is None or o[1] not in uids]
neg = [o[0] for o in orders if o[2] < 0]
emails = {}
for uid,email in users:
    if email: emails.setdefault(email, []).append(uid)
dups = [ids[1] for ids in emails.values() if len(ids) > 1]
nulls = [uid for uid,email in users if email is None or str(email).strip()=='']
if orphans: bad(f"残留孤儿订单 {orphans}")
if neg: bad(f"残留负金额 {neg}")
if dups: bad(f"残留重复邮箱 {dups}")
if nulls: bad(f"残留空邮箱 {nulls}")
if [u[0] for u in users] != [1,2,5]: bad(f"用户集合 {[u[0] for u in users]}")
if [o[0] for o in orders] != [101,102,103,107,110,111]: bad(f"订单集合 {[o[0] for o in orders]}")
row103 = [o for o in orders if o[0]==103]
if not row103 or row103[0][1] != 1: bad(f"订单103 未映射到用户1: {row103}")
lines = [json.loads(x) for x in open(sys.argv[2]) if x.strip()]
if len(lines) != 6: bad(f"quarantine 行数 {len(lines)}≠6")
types = sorted(x.get("type") for x in lines)
want = sorted(["orphan_order","orphan_order","orphan_order","invalid_user","orphaned_by_user","negative_amount"])
if types != want: bad(f"quarantine 类型 {types}")
qids = {x.get("id") for x in lines}
for need in (104,105,108,4,106,109):
    if need not in qids: bad(f"quarantine 缺 id {need}")
child = [x for x in lines if x.get("type")=="orphaned_by_user"]
if not child or child[0].get("parentId") != 4: bad("orphaned_by_user 缺 parentId=4")
print(json.dumps(r))
`;

const PY_SHOP = `
import sqlite3, sys, json
sql = open(sys.argv[1]).read()
c = sqlite3.connect(":memory:")
c.executescript(sql)
top = c.execute("""SELECT u.id,u.name,SUM(oi.quantity*oi.unit_cents) rev FROM users u JOIN orders o ON o.user_id=u.id
 JOIN order_items oi ON oi.order_id=o.id WHERE o.status='paid' GROUP BY u.id,u.name ORDER BY rev DESC,u.id ASC LIMIT 3""").fetchall()
month = c.execute("""SELECT substr(o.created_at,1,7) m,SUM(oi.quantity*oi.unit_cents) rev FROM orders o
 JOIN order_items oi ON oi.order_id=o.id WHERE o.status='paid' GROUP BY m ORDER BY m ASC""").fetchall()
prod = c.execute("""SELECT p.id,p.name,SUM(oi.quantity) units FROM products p JOIN order_items oi ON oi.product_id=p.id
 JOIN orders o ON o.id=oi.order_id WHERE o.status='paid' GROUP BY p.id,p.name ORDER BY units DESC,p.id ASC LIMIT 3""").fetchall()
rep = c.execute("""SELECT o.user_id,COUNT(*) n FROM orders o WHERE o.status='paid' GROUP BY o.user_id HAVING COUNT(*)>1 ORDER BY o.user_id ASC""").fetchall()
out = {
 "topCustomers":[{"userId":a,"name":b,"revenueCents":int(c2)} for a,b,c2 in top],
 "monthlyRevenue":[{"month":m,"revenueCents":int(r)} for m,r in month],
 "topProducts":[{"productId":a,"name":b,"units":int(u)} for a,b,u in prod],
 "repeatCustomers":[{"userId":a,"orderCount":int(n)} for a,n in rep],
}
print(json.dumps(out))
`;

const PY_PERF = `
import sqlite3, sys, json
db = sys.argv[1]
c = sqlite3.connect(db)
q1 = "SELECT status, COUNT(*) FROM orders WHERE created_at >= '2026-03-01' AND created_at < '2026-06-01' GROUP BY status ORDER BY status ASC"
q2 = "SELECT user_id, SUM(amount_cents) FROM orders WHERE status='paid' GROUP BY user_id ORDER BY user_id ASC"
plan1 = [row[3] for row in c.execute("EXPLAIN QUERY PLAN " + q1)]
plan2 = [row[3] for row in c.execute("EXPLAIN QUERY PLAN " + q2)]
res = {"ok": True, "parts": [], "plan1": plan1, "plan2": plan2}
def bad(m): res["ok"]=False; res["parts"].append(m)
if not any(("USING INDEX" in p) or ("USING COVERING INDEX" in p) for p in plan1): bad(f"Q1 未用索引: {plan1}")
if not any(("USING INDEX" in p) or ("USING COVERING INDEX" in p) for p in plan2): bad(f"Q2 未用索引: {plan2}")
got = json.loads(open(sys.argv[2]).read())
want1 = [{"status":s,"count":int(n)} for s,n in c.execute(q1)]
want2 = [{"userId":u,"revenueCents":int(r)} for u,r in c.execute(q2)]
if got.get("q1") != want1: bad(f"Q1 结果不一致")
if got.get("q2") != want2: bad(f"Q2 结果不一致")
n = c.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
if n != 20000: bad(f"orders 行数 {n}≠20000")
print(json.dumps(res))
`;

const tasks = defineChecks([
  {
    id: 1, round: 1, name: 'SQLite schema + 幂等迁移', type: '数据库/Schema',
    prompt: `你是数据库工程师。在 ${D1}/ 下交付 SQLite 数据层，夹具 fixtures/seed.json（5 个 users、8 个 orders）由我提供，**禁止修改**：
1）schema.sql：DDL。要求：
   - users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE)；
   - orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), status TEXT NOT NULL CHECK(status IN ('paid','pending','refunded')), created_at TEXT NOT NULL)；
   - 为 orders(user_id) 建索引（名字自定）；
   - 另建 schema_migrations 与 audit_log 表（audit_log 至少含 id/action/created_at）。
2）build-db.js（CommonJS，无第三方依赖）：执行 \`node build-db.js\`，先删除同目录 app.db，再用 schema.sql 建库并插入 fixtures/seed.json 的全部 users/orders（事务内完成），退出码 0。
3）migrate.js：\`node migrate.js --db app.db --to 2\`，把版本 2 迁移应用为：users 增加 loyalty_points INTEGER NOT NULL DEFAULT 0；创建 audit_log（若 schema.sql 已建则跳过）；在 schema_migrations 记录 version=2 与 applied_at。**重复执行必须幂等**（第二次仍退出码 0，version=2 只有一行）。
4）README.md（≥250 字节）：表结构、约束、迁移用法。
5）必须真实执行 build-db.js 与两次 migrate.js，并写进回复。`,
    expect: 'schema.sql + build-db.js + migrate.js + app.db + README.md',
    dir: D1, frozen: ['fixtures/seed.json'],
    deliverables: [
      { file: 'schema.sql', minBytes: 400 },
      { file: 'build-db.js', minBytes: 600 },
      { file: 'migrate.js', minBytes: 600 },
      { file: 'app.db', minBytes: 4096 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      try { fs.rmSync(path.join(dir, 'app.db'), { force: true }); } catch {}
      const b = runNodeWithCode(dir, 'build-db.js');
      if (b.code !== 0) return { ok: false, detail: 'exec=build-db.js 退出码 ' + b.code + ' ' + b.out.slice(-200).replace(/\n/g, ' ') };
      const m1 = runNodeWithCode(dir, 'migrate.js --db app.db --to 2');
      const m2 = runNodeWithCode(dir, 'migrate.js --db app.db --to 2');
      if (m1.code !== 0 || m2.code !== 0) return { ok: false, detail: `exec=migrate 退出码 ${m1.code}/${m2.code} ${(m1.out + m2.out).slice(-200).replace(/\n/g, ' ')}` };
      const py = runPy(dir, PY_SCHEMA, ['app.db']);
      return py.ok ? { ok: py.value.ok, detail: 'exec=' + py.value.parts.join('; ') } : { ok: false, detail: 'exec=py ' + py.out };
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'README.md'));
      const sql = readFileSafe(path.join(dir, 'schema.sql'));
      return [['约束说明', /UNIQUE|CHECK|REFERENCES|外键/i.test(md)], ['索引', /INDEX/i.test(sql)]];
    },
  },
  {
    id: 2, round: 1, name: '多表 SQL 聚合报表', type: '数据库/分析',
    prompt: `你是数据分析师。在 ${D2}/ 下交付报表管线，夹具 fixtures/shop.sql（users/orders/products/order_items 四张表）由我提供，**禁止修改**：
1）build.js：\`node build.js\`，删除旧 shop.db 后用 fixtures/shop.sql 建库（用事务执行），退出码 0。
2）queries.sql：至少 4 段带注释名的查询，必须使用 JOIN、GROUP BY，且至少一处 HAVING：
   - topCustomers：只看 status='paid' 的订单，按 users 汇总 SUM(order_items.quantity * order_items.unit_cents) 作为 revenueCents，按 revenue 降序、user id 升序取前 3；
   - monthlyRevenue：同样只算 paid，月份取 created_at 前 7 位（YYYY-MM），按月升序；
   - topProducts：只算 paid，按 products 汇总 SUM(quantity) 为 units，按 units 降序、product id 升序取前 3；
   - repeatCustomers：paid 订单数 ≥2 的用户，输出 userId 与 orderCount，按 userId 升序。
3）report.js：\`node report.js\`，用 SQL 查询 shop.db，写出 report.json，结构严格为：
   {"topCustomers":[{"userId","name","revenueCents"}...],"monthlyRevenue":[{"month","revenueCents"}...],"topProducts":[{"productId","name","units"}...],"repeatCustomers":[{"userId","orderCount"}...]}
   数值必须是整数（分/件），不得有额外字段。
4）README.md（≥250 字节）：指标口径与运行方式。
5）必须真实执行 build.js 与 report.js，并把 topCustomers 第一名写进回复。`,
    expect: 'build.js + queries.sql + report.js + report.json + README.md',
    dir: D2, frozen: ['fixtures/shop.sql'],
    deliverables: [
      { file: 'build.js', minBytes: 400 },
      { file: 'queries.sql', minBytes: 500 },
      { file: 'report.js', minBytes: 600 },
      { file: 'report.json', minBytes: 200 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      try { fs.rmSync(path.join(dir, 'shop.db'), { force: true }); } catch {}
      const b = runNodeWithCode(dir, 'build.js');
      if (b.code !== 0) return { ok: false, detail: 'exec=build.js 失败 ' + b.out.slice(-200).replace(/\n/g, ' ') };
      const r = runNodeWithCode(dir, 'report.js');
      if (r.code !== 0) return { ok: false, detail: 'exec=report.js 失败 ' + r.out.slice(-200).replace(/\n/g, ' ') };
      let got;
      try { got = JSON.parse(readFileSafe(path.join(dir, 'report.json'))); } catch { return { ok: false, detail: 'exec=report.json 非法 JSON' }; }
      const py = runPy(dir, PY_SHOP, ['fixtures/shop.sql']);
      if (!py.ok) return { ok: false, detail: 'exec=py ' + py.out };
      const want = py.value;
      const mism = [];
      for (const k of Object.keys(want)) {
        if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) mism.push(`${k} got=${JSON.stringify(got[k])} want=${JSON.stringify(want[k])}`);
      }
      const extra = Object.keys(got).filter((k) => !Object.keys(want).includes(k));
      if (extra.length) mism.push('额外顶层字段 ' + extra.join(','));
      return { ok: mism.length === 0, detail: mism.length ? 'exec=独立复算不一致: ' + mism.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓四组指标与独立 SQL 复算一致' };
    },
    quality: (dir) => {
      const q = readFileSafe(path.join(dir, 'queries.sql'));
      const md = readFileSafe(path.join(dir, 'README.md'));
      return [['JOIN', /JOIN/i.test(q)], ['GROUP BY', /GROUP\s+BY/i.test(q)], ['HAVING', /HAVING/i.test(q)], ['口径', /paid|口径|分/i.test(md)]];
    },
  },
  {
    id: 3, round: 1, name: '完整性审计 + 修复隔离', type: '数据库/数据质量',
    prompt: `你是数据质量工程师。在 ${D3}/ 下交付审计与修复工具。夹具 fixtures/broken.db 与 fixtures/broken.sql（内容一致，用户/订单含多类脏数据）由我提供，**禁止修改**。
流程：先把 fixtures/broken.db 复制为 work.db（可执行 cp 或 Node 文件操作），所有读写都针对 work.db。
1）audit.js：\`node audit.js --db work.db --out audit-before.json\`。独立统计四类违规（互不掩盖，负金额即使所属用户为空也计数）：
   - orphan_order：orders.user_id 为 NULL 或不存在于 users；
   - duplicate_email：同一非空 email 被多个用户使用，报告**非保留者**（保留用户 id 最小者，即报告较大的 id）；
   - null_email：users.email 为 NULL 或空串；
   - negative_amount：orders.amount_cents < 0。
   输出结构严格为 {"counts":{"orphanOrders":n,"duplicateEmails":n,"nullEmails":n,"negativeAmounts":n,"total":n},"violations":[{"type":"orphan_order|duplicate_email|null_email|negative_amount","table":"orders|users","id":n}]}。
   violations 按 type 字典序升序、同 type 按 id 升序；存在违规时退出码 1，否则 0。
2）repair.js：\`node repair.js --db work.db --quarantine quarantine.jsonl\`，按以下**固定顺序**修复：
   A. 重复邮箱：保留 id 最小者，把其他同邮箱用户的订单 user_id 改为保留者，再删除这些重复用户；
   B. 孤儿订单（此时重新判断）：写入隔离区并删除；
   C. email 为 NULL/空串的用户：用户本身写入隔离区，其仍存在的订单也写入隔离区后删除；
   D. 金额 < 0 的订单（仍在库中的）：写入隔离区并删除。
   隔离行每行一个 JSON 对象：B/D 为 {"type":"orphan_order"|"negative_amount","table":"orders","id":n}；C 的用户为 {"type":"invalid_user","table":"users","id":n}，C 的订单为 {"type":"orphaned_by_user","table":"orders","id":n,"parentId":用户id}。已在前序步骤删除的行不得重复写入。修复后退出码 0。
3）修复后再次执行 \`node audit.js --db work.db --out audit-final.json\`，必须退出码 0 且 total=0。
4）README.md（≥250 字节）：四类违规定义、修复顺序、隔离格式。
5）必须真实执行上述全部命令，并把 audit-before 的 counts.total 与 quarantine 行数写进回复。`,
    expect: 'work.db(修复后) + audit-before.json + audit-final.json + quarantine.jsonl + README.md',
    dir: D3, frozen: ['fixtures/broken.sql', 'fixtures/broken.db'],
    deliverables: [
      { file: 'work.db', minBytes: 4096 },
      { file: 'audit-before.json', minBytes: 100 },
      { file: 'audit-final.json', minBytes: 30 },
      { file: 'quarantine.jsonl', minLines: 6 },
      { file: 'README.md', minBytes: 250 },
      { file: 'audit.js', minBytes: 600 },
      { file: 'repair.js', minBytes: 800 },
    ],
    exec: (dir) => {
      const py = runPy(dir, PY_REPAIR, ['work.db', 'quarantine.jsonl']);
      if (!py.ok) return { ok: false, detail: 'exec=py ' + py.out };
      if (!py.value.ok) return { ok: false, detail: 'exec=' + py.value.parts.join('; ') };
      // 重新跑 agent 的 audit 验证修复后行为
      const aft = runNodeWithCode(dir, 'audit.js --db work.db --out audit-final-check.json');
      if (aft.code !== 0) return { ok: false, detail: `exec=修复后 audit 退出码 ${aft.code}` };
      let got;
      try { got = JSON.parse(readFileSafe(path.join(dir, 'audit-before.json'))); } catch { return { ok: false, detail: 'exec=audit-before.json 非法 JSON' }; }
      if (JSON.stringify(got) !== JSON.stringify(EXPECTED_AUDIT)) {
        return { ok: false, detail: `exec=审计独立预期不一致 got=${JSON.stringify(got).slice(0, 300)}` };
      }
      let fin;
      try { fin = JSON.parse(readFileSafe(path.join(dir, 'audit-final-check.json'))); } catch { return { ok: false, detail: 'exec=audit-final-check 非法 JSON' }; }
      if (fin?.counts?.total !== 0 || (fin?.violations || []).length !== 0) return { ok: false, detail: 'exec=修复后审计 total 非 0' };
      return { ok: true, detail: 'exec=✓审计7项/修复后0项/隔离6行' };
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'README.md'));
      return [['四类定义', /orphan|duplicate|null|negative/i.test(md)], ['修复顺序', /A|顺序|先/i.test(md)]];
    },
  },
  {
    id: 4, round: 1, name: '索引优化 + 查询计划', type: '数据库/性能',
    prompt: `你是数据库性能工程师。在 ${D4}/ 下交付索引优化方案，夹具 fixtures/users.csv、fixtures/orders.csv（20000 行订单）由我提供，**禁止修改**：
1）load.js：\`node load.js\`，删除旧 perf.db 后建库：users(id PK,name)、orders(id PK,user_id NOT NULL,amount_cents NOT NULL,status NOT NULL,created_at TEXT NOT NULL)，并导入两个 CSV 的全部行（用事务），退出码 0。
2）bench.js：\`node bench.js\`，先创建你认为合适的索引（至少两个 orders 上的复合索引），再对**以下两条固定 SQL** 执行 EXPLAIN QUERY PLAN 并把结果写入 bench.json：
   Q1 = SELECT status, COUNT(*) FROM orders WHERE created_at >= '2026-03-01' AND created_at < '2026-06-01' GROUP BY status ORDER BY status ASC
   Q2 = SELECT user_id, SUM(amount_cents) FROM orders WHERE status='paid' GROUP BY user_id ORDER BY user_id ASC
   bench.json 结构：{"queries":[{"name":"q1","usesIndex":true,"plan":["..."],"avgMs":n},{"name":"q2","usesIndex":true,"plan":["..."],"avgMs":n}]}
   同时把两条查询的实际结果写入 query-results.json：{"q1":[{"status":"...","count":n}],"q2":[{"userId":n,"revenueCents":n}]}（整数、按 SQL 的 ORDER BY）。
3）OPTIMIZATION.md（≥300 字节）：索引设计理由、EXPLAIN 前后对比、实测耗时。
4）必须真实执行 load.js 与 bench.js，并把 q1 的 paid 计数与 q2 涉及的用户数写进回复。`,
    expect: 'load.js + bench.js + perf.db + bench.json + query-results.json + OPTIMIZATION.md',
    dir: D4, frozen: ['fixtures/users.csv', 'fixtures/orders.csv'],
    deliverables: [
      { file: 'load.js', minBytes: 500 },
      { file: 'bench.js', minBytes: 600 },
      { file: 'perf.db', minBytes: 8192 },
      { file: 'bench.json', minBytes: 100 },
      { file: 'query-results.json', minBytes: 100 },
      { file: 'OPTIMIZATION.md', minBytes: 300 },
    ],
    exec: (dir) => {
      try { fs.rmSync(path.join(dir, 'perf.db'), { force: true }); } catch {}
      const l = runNodeWithCode(dir, 'load.js', 120000);
      if (l.code !== 0) return { ok: false, detail: 'exec=load.js 失败 ' + l.out.slice(-200).replace(/\n/g, ' ') };
      const b = runNodeWithCode(dir, 'bench.js', 120000);
      if (b.code !== 0) return { ok: false, detail: 'exec=bench.js 失败 ' + b.out.slice(-200).replace(/\n/g, ' ') };
      const py = runPy(dir, PY_PERF, ['perf.db', 'query-results.json'], 60000);
      if (!py.ok) return { ok: false, detail: 'exec=py ' + py.out };
      let bench;
      try { bench = JSON.parse(readFileSafe(path.join(dir, 'bench.json'))); } catch { return { ok: false, detail: 'exec=bench.json 非法 JSON' }; }
      const qn = (bench.queries || []).map((x) => x.name).sort().join(',');
      if (qn !== 'q1,q2') return { ok: false, detail: `exec=bench.json queries=${qn}` };
      return { ok: py.value.ok, detail: (py.value.ok ? 'exec=✓索引生效 ' : 'exec=') + py.value.parts.join('; ') + ` plan1=[${py.value.plan1.join('|')}]` };
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'OPTIMIZATION.md'));
      const js = readFileSafe(path.join(dir, 'bench.js'));
      return [['索引理由', /索引|index/i.test(md)], ['EXPLAIN', /EXPLAIN|QUERY PLAN/i.test(`${md}${js}`)], ['复合索引', /CREATE\s+INDEX/i.test(js)]];
    },
  },
]);

export const round = 1;
export const title = '数据库 / SQL 工程';
export default { round, title, outTag: 'r1', seed, tasks };
