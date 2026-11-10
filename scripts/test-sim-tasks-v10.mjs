/**
 * EvoClaw v10 复杂任务压测（2026-11-09，v9 之后的新任务轮）
 *
 * 任务集合变化（用户指定：除 Task 7 外全部换新，防"背题"——模型/评测
 * 过拟合旧 prompt，v9 任务已被多轮压测熟悉）：
 *   1. 日志分析+诊断（on-call 告警根因：生成 JSONL → 流式解析 → RCA 报告）
 *   2. DDD 设计评审（订单域模型：聚合/状态机/值对象/事件解耦）
 *   3. 算法设计+真实跑测试（webhook 重试调度 + node --test 全过）
 *   4. 架构设计+配置（API 网关限流配额 + YAML 真解析）
 *   5. 性能优化（SQL 慢查询 EXPLAIN 诊断 + 索引 DDL + 改写）
 *   6. 创意写作（科普短视频脚本：GPS 相对论修正，数字准确性为硬核）
 *   7. K8s 多环境 IaC（★ 保留 v9 Task 7 原文，作为对照基线——唯一复用任务）
 *   8. 可靠性工程（批处理幂等+断点续传设计）
 *   9. PR 写作（新闻通稿 + 媒体 Q&A，含 3 个尖锐问题）
 *  10. 流程设计+脚本（Git 发版策略 + bash 检查脚本 bash -n 真验证）
 *
 * v11 办公任务轮（2026-11-10 新增，id 11-15，用户要求 5 个多步办公任务）：
 *  11. Q3 销售复盘（生成 1200 行 CSV → aggregate.js 实跑 → summary.json → 报告）
 *  12. 会议纪要+行动项（minutes.md + actions.csv 结构校验 + 跟进邮件）
 *  13. 竞品分析（feature-matrix.csv 三档取值 + 分析文档）
 *  14. 费用报销审核（30 行数据 + audit.js 实跑 → violations.csv + 报告）
 *  15. 团队周报（40 行任务数据 + weekly-report.js 实跑 → metrics.json + 周报）
 *
 * 继承 v9 harness 的 P1 策略（详见 test-sim-tasks-v9.mjs 头部注释）：
 *   - 通过门 = 结构不变量（存在+新鲜+量化下限+回执对账）+ 可执行证据
 *     （node --test / bash -n / YAML loadAll，确定性无 LLM 判断）
 *   - 正文正则全部降级 quality（只报告不 gate）
 *
 * 生效的服务端防线（本轮验证对象）：
 *   - P0 回执对账 + 语法探针（d548393：node --check / bash -n 探针并入
 *     auto-continue 与末轮 footer）
 *   - P2 路径契约（9eee7bb / f8531b6：全工具族相对=workspace 基准）
 *
 * 便携化约定（2322d68 后）：jsonwebtoken 走 gateway createRequire、
 * js-yaml 走 findJsYamlPath 双布局探测，均无绝对路径/版本锁死。
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execSync } from 'child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const gatewayRequire = createRequire(path.join(__dirname, '../packages/gateway/package.json'));
const jwt = gatewayRequire('jsonwebtoken');
const require = createRequire(import.meta.url);

const envPath = path.resolve(__dirname, '../.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([^=]+)=([^#]*)$/);
  if (m) envVars[m[1].trim()] = m[2].trim();
}
const jwtSecret = envVars.JWT_SECRET || 'change-me-to-a-random-secret-min-16-chars';
const token = jwt.sign({ userId: 'test-user', roles: ['user', 'admin'] }, jwtSecret, { expiresIn: '24h' });
const PORT = process.env.EvoClaw_PORT || envVars.EvoClaw_PORT || '27789';

const RUN_START = Date.now();

function isFresh(p) { try { return fs.statSync(p).mtimeMs > RUN_START; } catch { return false; } }
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 容错 CSV 行解析（支持双引号包裹与转义引号；办公任务 11-15 校验用）。 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseCsvFile(p) {
  return readFileSafe(p).split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
}

function apiRequest(method, endpoint, body, timeoutMs = 500000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `http://127.0.0.1:${PORT}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 0, data: { raw: data } }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after ${timeoutMs / 1000}s`)); });
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function listRecursive(d) {
  const out = [];
  try {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) out.push(...listRecursive(p));
      else out.push(p);
    }
  } catch { /* dir missing */ }
  return out;
}

/** 跑单个测试文件（显式路径 + timeout 兜底；绝不裸 --test 自动发现）。 */
function runNodeTest(file) {
  try {
    const out = execSync(`timeout 40 node --test ${file} 2>&1`, { timeout: 50000, encoding: 'utf8' }).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return { ok: /\bpass\s+\d+/i.test(out) && !/\bfail\s+[1-9]/i.test(out), out };
  }
}

/**
 * 定位 js-yaml：① 仓库根 node_modules（提升布局）；② .pnpm 严格布局取最高版本。
 * 皆无 → null（调用方显式降级「仅计数未解析」，不静默判过）。
 */
function findJsYamlPath() {
  const repoRoot = path.join(__dirname, '..');
  const hoisted = path.join(repoRoot, 'node_modules', 'js-yaml', 'dist', 'js-yaml.min.js');
  if (fs.existsSync(hoisted)) return hoisted;
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const cands = fs.readdirSync(pnpmDir)
      .filter((d) => /^js-yaml@/.test(d))
      .map((d) => path.join(pnpmDir, d, 'node_modules', 'js-yaml', 'dist', 'js-yaml.min.js'))
      .filter((p) => fs.existsSync(p));
    if (cands.length) {
      cands.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      return cands[0];
    }
  }
  return null;
}

/**
 * P1：任务级交付物不变量（继承 v9 verifyDeliverables，回执侧已含 exts 对齐）。
 * 交付物项 shape：
 *   { file: 'x.md' }                      精确文件名（相对 dir）
 *   { regex: /…/, exts?, exclude?, minCount?, minBytes?, minLines? }  模式匹配（≥1 命中）
 */
function verifyDeliverables(dir, items, receipts) {
  const parts = [];
  let ok = true;
  const st = (p) => { try { return fs.statSync(p); } catch { return null; } };
  const base = (p) => String(p).replace(/\\/g, '/').split('/').pop();
  const fresh = (p) => { const s = st(p); return !!s && s.mtimeMs > RUN_START; };
  const allFiles = listRecursive(dir);
  for (const it of items) {
    const cand = it.file
      ? [path.join(dir, it.file)]
      : allFiles.filter((p) => it.regex.test(base(p)) && (!it.exts || it.exts.some((e) => base(p).endsWith(e))) && !(it.exclude && it.exclude.test(base(p))));
    let probe;
    if (it.minCount) {
      const hits = cand.filter((p) => st(p));
      const freshHits = hits.filter(fresh);
      probe = freshHits[0] || hits[0];
      if (freshHits.length < it.minCount) {
        ok = false;
        parts.push(`✗${it.regex.source.slice(0, 14)} fresh ${freshHits.length}/${it.minCount}`);
        continue;
      }
    } else if (it.file) {
      probe = cand[0];
      if (!st(probe)) {
        const landed = (receipts || []).find((r) => typeof r.path === 'string' && base(r.path) === base(probe) && st(r.path));
        ok = false;
        parts.push(landed ? `✗${base(probe)} 落点漂移→${landed.path}` : `✗${base(probe)} 缺失`);
        continue;
      }
      if (!fresh(probe)) { ok = false; parts.push(`✗${base(probe)} 陈旧`); continue; }
    } else {
      probe = cand.find(fresh) || cand[0];
      if (!probe || !st(probe)) {
        // 回执侧探测与候选侧同用 exts 过滤（2026-11-09 修复，防 v9 Task 7 类误报）
        const landed = (receipts || []).find((r) => typeof r.path === 'string' && it.regex.test(base(r.path)) && (!it.exts || it.exts.some((e) => base(r.path).endsWith(e))) && st(r.path));
        ok = false;
        parts.push(landed ? `✗${it.regex.source.slice(0, 14)} 落点漂移→${landed.path}` : `✗${it.regex.source.slice(0, 14)} 缺失`);
        continue;
      }
      if (!fresh(probe)) { ok = false; parts.push(`✗${base(probe)} 陈旧`); continue; }
    }
    if (it.minBytes && st(probe).size < it.minBytes) {
      ok = false; parts.push(`✗${base(probe)} ${st(probe).size}B<${it.minBytes}`); continue;
    }
    if (it.minLines) {
      let n = 0;
      try { n = Number(execSync(`wc -l < ${probe}`).toString().trim()); } catch { n = 0; }
      if (n < it.minLines) { ok = false; parts.push(`✗${base(probe)} 行数 ${n}<${it.minLines}`); continue; }
    }
    parts.push(`✓${base(probe)}`);
  }
  return { ok, detail: parts.join(' ') };
}

/** P1 统一门：结构不变量 + 可执行证据；quality 只报告不 gate。 */
function invariantCheck(task, r) {
  const inv = verifyDeliverables(task.dir, task.deliverables, r.receipts || []);
  const ex = task.exec ? task.exec(task.dir) : { ok: true, detail: '' };
  const q = task.quality ? task.quality(task.dir) : [];
  const qBad = q.filter((x) => !x[1]).length;
  const ok = inv.ok && ex.ok;
  const qd = q.length
    ? ` quality=[${q.map(([n, b]) => (b ? '' : '✗') + n).join(' ')}]${qBad ? ` (${qBad}项未达标)` : ''}`
    : '';
  return { ok, detail: `inv=[${inv.detail}]${ex.detail ? ` ${ex.detail}` : ''}${qd}` };
}

const WS = '/home/chy/EvoClaw/data/workspace';

const tasks = [
  {
    id: 1,
    name: "On-call 告警根因分析",
    type: "日志分析+诊断",
    prompt: `你是电商平台 on-call SRE。2026-11-02 14:00-15:30 结账 API 错误率突增，请完成根因分析。要求：1）用 Node.js 生成 3 天模拟服务日志 JSONL（${WS}/v10-alerts/app.log.jsonl，约 4320 行，每行一个 JSON 对象：ts, level, service, trace_id, msg, latency_ms, status；service 含 checkout/auth/inventory/payment/gateway；11-01 与 11-03 正常低错误率，11-02 14:00-15:30 错误集中在 payment 服务：支付网关超时 + 重试放大 + 少量 OOM）；2）流式解析（readline 或 readable stream，不要整体 load 进内存）计算：各 service 错误率、按 15 分钟窗口的错误率曲线、top5 错误 msg 聚类、OOM 时间点；3）写根因分析报告 ${WS}/v10-alerts/rca-report.md：告警概览（关键数据点）、根因分析（主因+证据链：支付网关超时→重试放大→资源耗尽）、至少 3 条修复建议（按优先级）；4）关键指标写 ${WS}/v10-alerts/alert-metrics.json；5）回复中给出你认为的最可能根因 + 一条关键证据。分析脚本放同目录。`,
    expect: "分析脚本 + app.log.jsonl(≥4000行) + rca-report.md + alert-metrics.json 落盘，报告含根因+证据+建议",
    dir: `${WS}/v10-alerts`,
    deliverables: [
      { regex: /gen|generate|create|analyze|log/i, exts: ['.js', '.mjs'] },
      { regex: /\.jsonl$/i, minLines: 4000 },
      { file: 'rca-report.md', minBytes: 1500 },
      { file: 'alert-metrics.json', minBytes: 100 },
    ],
    quality: (dir) => {
      const report = readFileSafe(path.join(dir, 'rca-report.md'));
      let metricsOk = false;
      try { metricsOk = Object.keys(JSON.parse(readFileSafe(path.join(dir, 'alert-metrics.json')))).length >= 3; } catch { /* 保持 false */ }
      return [
        ['错误率', /错误率|error|错误/i.test(report)],
        ['根因', /根因|root\s?cause|payment|支付/i.test(report)],
        ['证据', /证据|evidence|trace|14:|15:3/i.test(report)],
        ['建议', /建议|改进|优先|action/i.test(report)],
        ['metrics', metricsOk],
      ];
    },
  },
  {
    id: 2,
    name: "订单域 DDD 设计评审",
    type: "设计评审",
    prompt: `你是架构负责人，评审订单域模型设计。现状（上下文）：Order 聚合根含 OrderItem 实体，Money 值对象{amount: number, currency}；已知问题：① Order 的支付方法内部直接调用 PaymentService（域模型依赖应用层服务）；② OrderItem 的 qty/price 可被外部直接 set 修改（绕过不变量）；③ 状态用 status 字符串直接赋值、无状态机；④ 发通知的逻辑耦合在 Order 生命周期方法里。请写评审文档 ${WS}/v10-ddd/ddd-review.md：1）现状问题清单（对应 4 项，各指出违反的 DDD 原则）；2）聚合边界重设计：聚合根应保护哪些不变量、命令入口顺序、一致性级别选择；3）状态机设计：Draft→Paid→Shipped→Delivered→Closed/Cancelled 的合法迁移表 + 守卫条件 + 非法迁移的拒绝策略；4）Money 改不可变值对象：为什么用整数分（或 BigDecimal）而非浮点 number、构造/比较/加减语义；5）领域事件解耦 + outbox 模式落地要点（如何解决「写库+发事件」双写不一致、至少保证一次送达）；6）5 条具体重构步骤（有顺序、每步带验收标准）。`,
    expect: "ddd-review.md 落盘，含问题清单+聚合边界+状态机+Money 不可变+outbox+重构步骤",
    dir: `${WS}/v10-ddd`,
    deliverables: [
      { file: 'ddd-review.md', minBytes: 2500 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'ddd-review.md'));
      return [
        ['聚合', /聚合|aggregate/i.test(doc)],
        ['状态机', /状态机|迁移|transition|Draft|Paid/i.test(doc)],
        ['不变量', /不变量|invariant|守卫|guard/i.test(doc)],
        ['Money', /Money|整数分|BigDecimal|浮点/i.test(doc)],
        ['Outbox', /outbox|双写|事件/i.test(doc)],
        ['重构步骤', /重构|步骤|step/i.test(doc)],
      ];
    },
  },
  {
  id: 3,
    name: "Webhook 重试策略实现+测试",
    type: "算法设计+真实跑测试",
    prompt: `你是后端工程师，设计并实现 webhook 重试调度策略。全部放 ${WS}/v10-webhook/：1）webhook-retry.js（CommonJS，无第三方依赖）导出：scheduleRetry(attempt, now)——attempt 从 0 起，首次 60s，之后间隔翻倍，封顶 3600s，第 10 次（attempt=9 之后再失败）判定终止进死信队列，返回 { delayMs, giveUp }；addJitter(delayMs, seed)——基于 seed 的确定性 jitter（±10% 内，同 seed 必同结果，供测试断言，可用简单 hash 而非真随机）；buildDeadLetter(record)——把投递失败记录聚合成死信条目（含 payload 的 sha256 哈希、attempts 总数、最终时间）；2）webhook-retry.test.js（node --test，无第三方依赖）：覆盖延迟翻倍序列、封顶、giveUp 边界、jitter 确定性（同 seed 同值 + 范围 ±10%）、死信哈希稳定性，全部测试必须真实跑通；3）DESIGN.md：策略理由（为什么指数退避 + jitter、thundering herd）、死信处理流程、监控指标（投递成功率/重试 p95/死信深度）。`,
    expect: "webhook-retry.js + webhook-retry.test.js（node --test 全过）+ DESIGN.md 落盘",
    dir: `${WS}/v10-webhook`,
    deliverables: [
      { regex: /retry/i, exts: ['.js'], exclude: /test/i, minBytes: 500 },
      { regex: /\.test\.js$/i },
      { regex: /DESIGN|README/i, exts: ['.md'], minBytes: 800 },
    ],
    exec: (dir) => {
      const tests = listRecursive(dir).filter((f) => /\.test\.js$/i.test(f) && isFresh(f));
      if (!tests.length) return { ok: false, detail: 'exec=无新鲜 test.js' };
      let allOk = true;
      const out = [];
      for (const t of tests) {
        const r = runNodeTest(t);
        out.push(`${path.basename(t)} ${r.ok ? '✓' : '✗'}`);
        if (!r.ok) allOk = false;
      }
      return { ok: allOk, detail: `exec=node --test ${allOk ? '全过' : 'FAIL'}（${out.join(' ')}）` };
    },
  },
  {
    id: 4,
    name: "API 网关限流配额方案",
    type: "架构设计+配置",
    prompt: `你是平台架构师，为公网 API 网关设计限流与配额方案。1）写 ${WS}/v10-gateway/rate-limit-plan.md：a) 三层限流（IP 层 / API Key 层 / 租户+接口层），各层算法选型（令牌桶/滑动窗口/漏桶）与理由；b) 参数表：默认 QPS、burst、配额维度与数值、429 响应头约定（Retry-After + X-RateLimit-*）；c) 分布式实现：Redis 令牌桶 Lua 脚本骨架（伪代码）+ Redis 故障时的本地降级限流策略；d) 配额计量与计费联动：用量流水怎么存、限流与计费口径不一致时以谁为准；e) 灰度上线与回滚：分步放量、观测指标、kill switch；2）写 ${WS}/v10-gateway/rate-limit.yaml：网关可加载的配置示例（租户×接口矩阵 + 默认值 + 黑名单），YAML 必须语法合法；3）回复中给一段结论：最关键的一个设计决策及理由。`,
    expect: "rate-limit-plan.md + rate-limit.yaml 落盘，YAML 语法可解析，方案含三层限流+参数+降级+灰度",
    dir: `${WS}/v10-gateway`,
    deliverables: [
      { file: 'rate-limit-plan.md', minBytes: 2500 },
      { file: 'rate-limit.yaml', minBytes: 300 },
    ],
    exec: (dir) => {
      const y = path.join(dir, 'rate-limit.yaml');
      if (!isFresh(y)) return { ok: false, detail: 'exec=rate-limit.yaml 非新鲜产物' };
      const yamlPath = findJsYamlPath();
      if (!yamlPath) return { ok: true, detail: 'exec=YAML 存在（js-yaml 缺失，仅计数未解析）' };
      try {
        const yaml = require(yamlPath);
        const parseAll = yaml.loadAll || yaml.safeLoadAll;
        parseAll(readFileSafe(y));
        return { ok: true, detail: `exec=YAML 解析通过（js-yaml@${yamlPath.includes('js-yaml@4') ? '4' : '3'}）` };
      } catch (e) {
        return { ok: false, detail: `exec=YAML 解析失败 :: ${String(e.message || e).split('\n')[0].slice(0, 100)}` };
      }
    },
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'rate-limit-plan.md'));
      return [
        ['三层', /IP/i.test(doc) && /API\s?Key/i.test(doc) && /租户|tenant/i.test(doc)],
        ['429', /429|Retry-After/i.test(doc)],
        ['Redis', /Redis|Lua/i.test(doc)],
        ['降级', /降级|本地|fallback/i.test(doc)],
        ['灰度', /灰度|kill|回滚|放量/i.test(doc)],
      ];
    },
  },
  {
    id: 5,
    name: "SQL 慢查询性能调优",
    type: "性能优化",
    prompt: `你是 DBA，为电商订单系统做一次慢查询调优。背景：orders 表 2 亿行（id, user_id, status, amount, created_at，已有索引 idx_created_at）；order_items（order_id, sku_id, qty, price，索引在 order_id）；慢查询：SELECT o.id, o.user_id, SUM(oi.qty*oi.price) AS total FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.status='shipped' AND o.created_at >= '2026-01-01' GROUP BY o.id, o.user_id; EXPLAIN 显示 orders 全表扫描（type=ALL），order_items 嵌套循环关联（依索引但预估 32 亿次探测）。请写 ${WS}/v10-sql/sql-tuning.md：1）问题诊断：至少 3 个具体问题（过滤列缺失索引 / JOIN 聚合写放大 / 分组过细导致临时表 等），每个说明在 EXPLAIN 里怎么体现、为什么慢；2）索引优化：给出索引 DDL（复合索引列顺序理由、是否覆盖索引、2 亿行表建索引的 online DDL 考量，分区表是否值得）；3）查询改写：至少 2 种方案（两阶段聚合 / 汇总表或物化思路），各给 SQL + 优缺点；4）验证方案：测试环境怎么对比前后（EXPLAIN 前后、慢日志、p95），验收标准写清；5）风险清单：大表加索引风险（锁/磁盘/内存/主从延迟）与回滚预案。`,
    expect: "sql-tuning.md 落盘，含诊断+索引DDL+改写方案+验证+风险清单",
    dir: `${WS}/v10-sql`,
    deliverables: [
      { file: 'sql-tuning.md', minBytes: 2000 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'sql-tuning.md'));
      return [
        ['EXPLAIN', /EXPLAIN|执行计划|type=ALL/i.test(doc)],
        ['DDL', /CREATE\s+INDEX/i.test(doc)],
        ['改写', /两阶段|物化|汇总|改写|重写/i.test(doc)],
        ['验证', /验证|p95|慢日志|基准/i.test(doc)],
        ['风险', /风险|online|ghost|回滚/i.test(doc)],
      ];
    },
  },
  {
    id: 6,
    name: "科普短视频脚本（GPS 相对论）",
    type: "创意写作",
    prompt: `你是科普账号主编，写一条 3 分钟科普短视频脚本：《GPS 为什么要给卫星时钟打相对论补丁》。要求：1）${WS}/v10-script/gps-relativity-script.md 完整脚本：【开场钩子 ≤15s】+【主体三段：为什么动钟变慢/引力让钟变快/不打补丁会偏多少】+【结尾互动引导】；每个镜头标注画面要点+口播词+时长，总时长 150s±10s；2）硬核数字必须准确：卫星速度约 3.9 km/s，狭义相对论使星上钟每天慢约 7.2μs，广义相对论（引力势更高）使星上钟每天快约 45μs，净效果每天快约 38μs，不修正则定位误差每天累积约 10km；3）脚本里解释清楚「为什么 GPS 是每天都在验证相对论」；4）附 3 个备选开场钩子（供 A/B）；5）回复中口播一遍开场 15s。`,
    expect: "脚本落盘，含镜头表+准确相对论数字+3个备选钩子",
    dir: `${WS}/v10-script`,
    deliverables: [
      { file: 'gps-relativity-script.md', minBytes: 2500 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'gps-relativity-script.md'));
      return [
        ['时间膨胀', /时间膨胀|时慢|变慢|动钟/i.test(doc)],
        ['关键数字', /38/.test(doc) && /45/.test(doc)],
        ['10km', /10\s?(公里|km)/i.test(doc)],
        ['镜头表', /镜头|画面|口播/i.test(doc)],
        ['备选钩子', /备选|A\/B|钩子/i.test(doc)],
        ['时长', /150|3\s?分钟|180/i.test(doc)],
      ];
    },
  },
  {
    // ★ 对照任务：保留 v9 Task 7 原文（用户指定：除 Task 7 外全部换新）
    id: 7,
    name: "K8s 多环境 IaC",
    type: "运维工程（对照基线）",
    prompt: "你是 SRE，为 3 个微服务（api/web/worker）编写 K8s 多环境（dev/staging/prod）部署方案。全部放 /home/chy/EvoClaw/data/workspace/v9-k8s/：1）每个服务一个 deployment.yaml（resources/limits、探针、PDB）+ service.yaml + 生产环境 HPA；2）ingress.yaml（3 服务路由 + TLS + 限流注解）；3）命名空间 + 各环境 ConfigMap/Secret 引用（用 values，不含真实密钥）；4）helm values 分层（values-dev.yaml / values-staging.yaml / values-prod.yaml）；5）deploy.md：部署顺序、回滚（helm rollback + 标签基线）、扩缩容、故障排查（kubectl 命令速查）。每个 YAML 必须语法可解析（用 python 或 node 校验）。",
    expect: "全部 YAML 落盘且语法可解析 + helm values 三环境 + deploy.md",
    dir: `${WS}/v9-k8s`,
    deliverables: [
      { regex: /ya?ml$/i, minCount: 6 },
      { regex: /values-dev/i },
      { regex: /values-staging/i },
      { regex: /values-prod/i },
      { regex: /deploy|doc/i, exts: ['.md'] },
    ],
    exec: (dir) => {
      const yamls = listRecursive(dir).filter((f) => /\.(ya?ml)$/i.test(f));
      if (!yamls.length) return { ok: false, detail: 'exec=无YAML' };
      try {
        const yamlPath = findJsYamlPath();
        if (yamlPath) {
          const yaml = require(yamlPath);
          // ★ loadAll（4.x）/safeLoadAll（3.x）：K8s 多文档 YAML（--- 分隔）
          //   在 load 下会抛 "expected a single document"（v9 全量轮误杀根因）。
          const parseAll = yaml.loadAll || yaml.safeLoadAll;
          for (const f of yamls) parseAll(readFileSafe(f));
          return { ok: true, detail: `exec=yaml×${yamls.length} 可解析（js-yaml@${yamlPath.includes('js-yaml@4') ? '4' : '3'}）` };
        }
        return { ok: true, detail: `exec=yaml×${yamls.length} 存在（js-yaml 缺失，仅计数未解析）` };
      } catch (e) {
        return { ok: false, detail: `exec=yaml解析失败 :: ${String(e.message || e).split('\n')[0].slice(0, 120)}` };
      }
    },
    quality: (dir) => {
      const all = listRecursive(dir);
      const yamls = all.filter((f) => /\.(ya?ml)$/i.test(f)).map((f) => readFileSafe(f)).join('\n');
      const docs = all.filter((f) => f.endsWith('.md')).map((f) => readFileSafe(f)).join('\n');
      return [
        ['Deployment', /kind: Deployment|replicas/i.test(yamls)],
        ['Service', /kind: Service/i.test(yamls)],
        ['HPA', /kind: HorizontalPodAutoscaler/i.test(yamls)],
        ['Ingress', /kind: Ingress/i.test(yamls)],
        ['文档', /回滚|rollback|kubectl|故障/i.test(docs)],
      ];
    },
  },
  {
    id: 8,
    name: "批处理幂等与断点续传设计",
    type: "可靠性工程",
    prompt: `你是可靠性工程师，为「每日 MySQL → 数据仓库 5000 万行同步」的批处理作业设计幂等与可恢复性。写 ${WS}/v10-batch/batch-idempotency.md：1）幂等键设计：(source_row_key, batch_id, job_version) 组合键 + 目标端去重方案（UPSERT / MERGE / 唯一键+预删），各方案性能与正确性取舍；2）检查点与断点：checkpoint 记录什么（offset/watermark + batch_id），恢复时当前批部分失败怎么处理（整批幂等覆盖 vs 增量续传），checkpoint 存储选型对比（DB 表 / 分布式 KV / 文件）；3）乱序与迟到数据：late event 到达晚于当前 batch 时怎么不丢不重；4）对账：T+1 行数核对 + 抽样 checksum，不一致时如何定位是源侧变化 / 目标丢失 / 重复写入；5）失败矩阵：至少 6 种故障模式（进程崩溃 / 网络分区 / 目标端拒连 / 源表被回滚 / 时钟漂移 / 重复消费）× 恢复策略 × 是否会重/漏；6）可观测指标 5 个（含 1 个业务正确性指标）。`,
    expect: "batch-idempotency.md 落盘，含幂等键+断点+乱序+对账+失败矩阵+指标",
    dir: `${WS}/v10-batch`,
    deliverables: [
      { file: 'batch-idempotency.md', minBytes: 2500 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'batch-idempotency.md'));
      return [
        ['幂等键', /幂等|idempot/i.test(doc)],
        ['断点', /checkpoint|检查点|断点|watermark|水位/i.test(doc)],
        ['对账', /对账|reconcil|checksum|核对/i.test(doc)],
        ['失败矩阵', /失败|故障|矩阵/i.test(doc)],
        ['指标', /指标|metric|监控|告警/i.test(doc)],
      ];
    },
  },
  {
    id: 9,
    name: "产品发布新闻稿+媒体 Q&A",
    type: "PR 写作",
    prompt: `你是 PR 负责人，公司即将发布企业知识库产品（核心特性：RAG 问答、细粒度权限隔离、SSO 集成、操作审计）。请完成：1）${WS}/v10-pr/press-release.md：完整新闻通稿（标题 + 导语 + 三段正文 + 创始人引言 + 公司 boilerplate），中文，总字数 ≤800 字，避免「颠覆/革命/世界领先」类夸张形容词，每个卖点必须有信息增量（具体数字或机制）；2）${WS}/v10-pr/media-qa.md：媒体采访 Q&A 10 问，必须包含 3 个尖锐问题并给出稳妥答法：a)「RAG 是不是只是营销概念，和把文档丢给大模型有什么区别？」b)「客户数据会不会被拿去训练你们的模型？」c)「为什么不直接微调大模型而要 RAG？」每问答法 ≤150 字、要点先行；3）回复中挑出你认为媒体最可能问的 1 个问题，给出你的推荐答法要点。`,
    expect: "press-release.md + media-qa.md 落盘，Q&A 含 3 尖锐问题且答法稳妥",
    dir: `${WS}/v10-pr`,
    deliverables: [
      { file: 'press-release.md', minBytes: 500 },
      { file: 'media-qa.md', minBytes: 1000 },
    ],
    quality: (dir) => {
      const qa = readFileSafe(path.join(dir, 'media-qa.md'));
      const rel = readFileSafe(path.join(dir, 'press-release.md'));
      return [
        ['boilerplate', /关于|boilerplate|公司简介/i.test(rel)],
        ['尖锐Q1', /营销|炒作|概念/i.test(qa)],
        ['尖锐Q2', /训练/i.test(qa) && (/不会|绝不|仅.*客户.*同意|数据.*安全|不.*用于/i.test(qa))],
        ['尖锐Q3', /微调/i.test(qa)],
      ];
    },
  },
  {
    id: 10,
    name: "Git 发版策略+检查脚本",
    type: "流程设计+脚本",
    prompt: `你是工程效率负责人，为团队定义 Git 发版策略并配工具。全部放 ${WS}/v10-release/：1）RELEASE-STRATEGY.md：main + release 分支 + tag（SemVer）模型，hotfix 流程（从哪个分支切、如何回合 main 与 release、tag 规则），版本号规则 + changelog 模板（Keep a Changelog 格式），4 周发版节奏表；2）release-checklist.sh：检查脚本，用法 release-checklist.sh <tag>（如 v1.4.0），至少检查：tag 是否存在 / tag 指向的是否是 merge commit / changelog 是否有该版本条目 / 对应 release 分支是否已回合 main，每项输出 PASS/FAIL，任一 FAIL 退出码非 0；3）在 v10-release/ 里建一个最小 git 临时仓（含 main + 一个 tag + CHANGELOG），真实跑一遍 release-checklist.sh，把完整输出存 ${WS}/v10-release/check-output.txt；4）README.md：使用说明 + 分支模型 ASCII 图。脚本必须语法合法（bash -n 通过）。`,
    expect: "RELEASE-STRATEGY.md + release-checklist.sh（bash -n 通过）+ check-output.txt + README.md 落盘",
    dir: `${WS}/v10-release`,
    deliverables: [
      { regex: /RELEASE|STRATEGY/i, exts: ['.md'], minBytes: 1000 },
      { regex: /checklist|check/i, exts: ['.sh'], minBytes: 300 },
      { regex: /check.output|output/i, exts: ['.txt'], minBytes: 50 },
      { regex: /README/i, minBytes: 200 },
    ],
    exec: (dir) => {
      const sh = listRecursive(dir).find((f) => /check/i.test(f) && f.endsWith('.sh') && isFresh(f));
      if (!sh) return { ok: false, detail: 'exec=无新鲜检查脚本' };
      try {
        execSync(`bash -n ${sh} 2>&1`, { timeout: 8000, encoding: 'utf8' });
        return { ok: true, detail: 'exec=bash -n 检查脚本语法通过' };
      } catch (e) {
        return { ok: false, detail: `exec=bash -n 语法失败 :: ${String(e.message || e).split('\n')[0].slice(0, 100)}` };
      }
    },
    quality: (dir) => {
      const all = listRecursive(dir);
      const strat = all.find((f) => /RELEASE|STRATEGY/i.test(f) && f.endsWith('.md'));
      const readme = all.find((f) => /README/i.test(f));
      return [
        ['SemVer', /SemVer|语义化版本|主版本/i.test(readFileSafe(strat || ''))],
        ['hotfix', /hotfix|热修/i.test(readFileSafe(strat || ''))],
        ['分支图', /┌|└|main|release/i.test(readFileSafe(readme || ''))],
      ];
    },
  },
  // ────────────────────────────────────────────────────────────────────────
  // v11 办公任务轮（2026-11-10 新增，id 11-15）：全部「多步执行」——
  // 生成数据 → 写脚本 → 真跑 → 汇总报告；通过门仍用结构不变量 + 可执行证据。
  // ────────────────────────────────────────────────────────────────────────
  {
    id: 11,
    name: "Q3 销售复盘（数据生成→聚合脚本→报告）",
    type: "办公·经营分析",
    prompt: `你是零售公司的运营分析师，做 2026 Q3（07-01~09-30）销售复盘。全部放 ${WS}/v11-sales/：1）生成 sales-data.csv：严格表头 date,region,channel,sku,units,unit_price，共 1200 行数据（region 取 华东/华南/华北/西南；channel 取 线上/线下/分销；日期都在 Q3；units 1-20；unit_price 10-999 两位小数），建议写一个 Node 脚本 gen-data.js 生成后再运行（脚本留不留均可）；2）写 aggregate.js（CommonJS、零第三方依赖）：逐行读取 sales-data.csv，计算 ① 总营收 ② 分 region 营收 ③ 分 channel 营收 ④ 按月营收环比（7→8→9）⑤ Top5 sku（按营收），结果写 summary.json，必须含 totalRevenue、byRegion、byChannel、monthOverMonth、topSkus 五个键；3）真实运行 node aggregate.js 生成 summary.json；4）写 report.md（≥2500 字节）：概览、分区域表、分渠道表、月度环比分析、Top5 SKU 表、3 条可执行建议（各带数据依据）。回复中给出总营收与最强区域。`,
    expect: "sales-data.csv(1200行) + aggregate.js 实跑 + summary.json 五键 + report.md",
    dir: `${WS}/v11-sales`,
    deliverables: [
      { file: 'sales-data.csv', minLines: 1200 },
      { file: 'aggregate.js', minBytes: 800 },
      { file: 'summary.json', minBytes: 150 },
      { file: 'report.md', minBytes: 2500 },
    ],
    exec: (dir) => {
      const js = path.join(dir, 'aggregate.js');
      if (!isFresh(js)) return { ok: false, detail: 'exec=无新鲜 aggregate.js' };
      if (!isFresh(path.join(dir, 'sales-data.csv'))) return { ok: false, detail: 'exec=无新鲜 sales-data.csv' };
      try {
        execSync('node aggregate.js', { cwd: dir, timeout: 60000, encoding: 'utf8' });
      } catch (e) {
        return { ok: false, detail: `exec=node aggregate.js 失败 :: ${String(e.message || e).split('\n')[0].slice(0, 120)}` };
      }
      try {
        const s = JSON.parse(readFileSafe(path.join(dir, 'summary.json')));
        const need = ['totalRevenue', 'byRegion', 'byChannel', 'monthOverMonth', 'topSkus'];
        const miss = need.filter((k) => !(k in s));
        if (miss.length) return { ok: false, detail: `exec=summary.json 缺键 ${miss.join('|')}` };
        return { ok: true, detail: `exec=aggregate.js 实跑通过，summary.json 五键齐（totalRevenue=${s.totalRevenue}）` };
      } catch (e) {
        return { ok: false, detail: `exec=summary.json 解析失败 :: ${String(e.message || e).split('\n')[0].slice(0, 100)}` };
      }
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'report.md'));
      const header = (readFileSafe(path.join(dir, 'sales-data.csv')).split('\n')[0] || '').trim();
      return [
        ['环比', /环比|MoM|月环比/i.test(md)],
        ['Top5', /Top\s*5|前五|top5/i.test(md)],
        ['建议', /建议/.test(md)],
        ['CSV表头', header === 'date,region,channel,sku,units,unit_price'],
      ];
    },
  },
  {
    id: 12,
    name: "会议纪要+行动项跟踪表+跟进邮件",
    type: "办公·项目管理",
    prompt: `你是项目经理，整理知识库 v2.1 发布评审会（2026-11-10 10:00-11:00）的会后材料，全部放 ${WS}/v11-meeting/。参会人：张伟（产品）、李娜（前端）、王强（后端）、赵敏（测试）、陈晨（运营）。会议原始记录：
- 张伟：v2.1 定在 11-28 上线，但权限隔离必须本周收尾，否则回退到 11-21 的候选版本。
- 李娜：权限矩阵前端交互还有 3 个页面没做，预计 11-13 完成；暗色模式推迟到下个迭代。
- 王强：SSO 的 OKTA 兼容层有风险，如果 11-18 前测不通，就只支持 OIDC 标准流程。
- 赵敏：回归用例还差 40 条（主要是审计日志）；需要王强在 11-12 前提供审计事件字段清单。
- 陈晨：两家种子客户希望 11-20 前拿到试用环境，运营侧可以先给只读账号。
- 争论：Q4 是否加「跨库检索」。张伟主张加，王强认为排期不够；结论：不进 v2.1 范围，进 v2.2 规划，张伟 11-17 前出方案。
- 决定：v2.1 范围冻结，11-14 做一次 go/no-go 评审。
产出：1）minutes.md：会议信息、决议（≥4 条）、风险（≥2 条）、分歧与结论（含跨库检索）、行动项摘要表、下一步；2）actions.csv：严格表头 id,action,owner,due,priority，≥8 条行动项；owner 必须是参会人姓名之一；due 日期在 2026-11-11 至 2026-12-05 之间；priority 只能是 P0/P1/P2；3）followup-email.md：邮件草稿（主题、收件人、正文摘要、行动项与截止日、下次评审时间 2026-11-14 10:00）。回复中列出所有 P0 行动项。`,
    expect: "minutes.md + actions.csv(≥8 条、列/负责人/优先级/日期合规) + followup-email.md",
    dir: `${WS}/v11-meeting`,
    deliverables: [
      { file: 'minutes.md', minBytes: 1800 },
      { file: 'actions.csv', minLines: 9 },
      { file: 'followup-email.md', minBytes: 600 },
    ],
    exec: (dir) => {
      const p = path.join(dir, 'actions.csv');
      if (!isFresh(p)) return { ok: false, detail: 'exec=无新鲜 actions.csv' };
      const rows = parseCsvFile(p);
      if (!rows.length) return { ok: false, detail: 'exec=actions.csv 为空' };
      const header = rows[0].map((s) => s.trim());
      const need = ['id', 'action', 'owner', 'due', 'priority'];
      const miss = need.filter((k) => !header.some((h) => h.toLowerCase() === k));
      if (miss.length) return { ok: false, detail: `exec=actions.csv 缺列 ${miss.join('|')}` };
      const idx = (k) => header.findIndex((h) => h.toLowerCase() === k);
      const body = rows.slice(1).filter((r) => r.some((c) => c.trim()));
      if (body.length < 8) return { ok: false, detail: `exec=行动项 ${body.length}<8` };
      const owners = ['张伟', '李娜', '王强', '赵敏', '陈晨'];
      const badOwner = body.map((r) => (r[idx('owner')] || '').trim()).filter((o) => !owners.some((x) => o.includes(x)));
      if (badOwner.length) return { ok: false, detail: `exec=负责人不在参会人名单: ${[...new Set(badOwner)].slice(0, 3).join('/')}` };
      const badPri = body.map((r) => (r[idx('priority')] || '').trim()).filter((v) => !/^P[0-2]/.test(v));
      if (badPri.length) return { ok: false, detail: `exec=优先级非法 ${[...new Set(badPri)].slice(0, 3).join('/')}` };
      const badDue = body.map((r) => (r[idx('due')] || '').trim().replace(/\//g, '-'))
        .filter((v) => !/^2026-11-(1[1-9]|2\d|30)$/.test(v) && !/^2026-12-0[1-5]$/.test(v));
      if (badDue.length) return { ok: false, detail: `exec=截止日越界 ${[...new Set(badDue)].slice(0, 3).join('/')}` };
      return { ok: true, detail: `exec=actions.csv ${body.length} 条行动项（列/负责人/优先级/日期全合规）` };
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'minutes.md'));
      const em = readFileSafe(path.join(dir, 'followup-email.md'));
      return [
        ['决议', /决议|决定/.test(md)],
        ['风险', /风险/.test(md)],
        ['分歧', /分歧|争论|跨库检索/.test(md)],
        ['邮件主题', /主题|Subject/.test(em)],
      ];
    },
  },
  {
    id: 13,
    name: "竞品分析+特性对比矩阵",
    type: "办公·产品研究",
    prompt: `你是产品经理，为企业知识库产品「Nebula」编写竞品分析，全部放 ${WS}/v11-competitor/。已知情报：
我方 Nebula：RAG 问答 支持、多跳检索 支持、权限粒度 字段级、SSO 支持、操作审计 全量+导出、私有化部署 支持、开放 API 支持、移动端 不支持、实施周期 4 周、价格 260 元/人/月。
竞品A DocuMind：RAG 问答 支持、多跳检索 不支持、权限粒度 空间级、SSO 支持（SAML）、操作审计 不支持、私有化部署 支持、开放 API 支持、移动端 不支持、实施周期 2 周、价格 200 元/人/月。
竞品B WikiWorks：RAG 问答 不支持、多跳检索 不支持、权限粒度 页面级、SSO 支持（OIDC）、操作审计 基础日志、私有化部署 支持、开放 API 支持、移动端 支持、实施周期 1 周、价格 120 元/人/月。
竞品C KnowBase：RAG 问答 支持、多跳检索 支持、权限粒度 字段级、SSO 支持（SAML+OIDC）、操作审计 全量+导出、私有化部署 仅企业版、开放 API 不支持、移动端 支持、实施周期 4 周、价格 260 元/人/月。
产出：1）feature-matrix.csv：严格表头 特性,竞品A,竞品B,竞品C,我方；≥10 个特性行；每格取值只能是 支持 / 部分 / 不支持（把「仅企业版」等表述归并到这三档）；2）competitor-analysis.md（≥2500 字节）：对比矩阵表（markdown）、逐家优劣（每家 3 优 3 劣）、我方与竞品C 的关键差异、差异化定位（1 段）、3 条按优先级排序的产品路线建议（带理由）。回复中给出一句话定位。`,
    expect: "feature-matrix.csv(严格表头+≥10行+三档取值) + competitor-analysis.md",
    dir: `${WS}/v11-competitor`,
    deliverables: [
      { file: 'feature-matrix.csv', minLines: 11 },
      { file: 'competitor-analysis.md', minBytes: 2500 },
    ],
    exec: (dir) => {
      const p = path.join(dir, 'feature-matrix.csv');
      if (!isFresh(p)) return { ok: false, detail: 'exec=无新鲜 feature-matrix.csv' };
      const rows = parseCsvFile(p);
      const header = (rows[0] || []).map((s) => s.trim());
      const need = ['特性', '竞品A', '竞品B', '竞品C', '我方'];
      const miss = need.filter((k) => !header.includes(k));
      if (miss.length) return { ok: false, detail: `exec=表头缺列 ${miss.join('|')}（实际: ${header.join(',')}）` };
      const body = rows.slice(1).filter((r) => r.some((c) => c.trim()));
      if (body.length < 10) return { ok: false, detail: `exec=特性行 ${body.length}<10` };
      const bad = [];
      for (const r of body) {
        for (let i = 1; i < 5; i++) {
          const v = (r[i] || '').trim();
          if (!['支持', '部分', '不支持'].includes(v)) bad.push(v || '(空)');
        }
      }
      if (bad.length) return { ok: false, detail: `exec=取值非三档: ${[...new Set(bad)].slice(0, 3).join('/')}` };
      return { ok: true, detail: `exec=feature-matrix.csv ${body.length} 行 × 4 竞品，取值全为三档` };
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'competitor-analysis.md'));
      return [
        ['差异化', /差异化|定位/.test(md)],
        ['建议', /建议/.test(md)],
        ['竞品名', /DocuMind/.test(md) && /WikiWorks/.test(md) && /KnowBase/.test(md)],
      ];
    },
  },
  {
    id: 14,
    name: "费用报销审核（数据+审核脚本+违规报告）",
    type: "办公·财务审核",
    prompt: `你是财务共享中心专员，对 ${WS}/v11-expense/ 下的一批报销做自动化审核。报销政策（2026 版）：A) 差旅-酒店每晚上限 500 元；差旅-交通按实报（须发票）；B) 招待费人均上限 150 元（people 列=陪客人数，含本方）；C) 办公用品单笔上限 2000 元；D) 所有报销必须提供增值税发票（has_invoice=是）；E) 单笔金额超过 5000 元必须「总监+财务VP」双审批（approval_level=双重）。数据列：expense_id,date,category,amount,people,vendor,has_invoice,approval_level,employee。产出：1）expenses.csv：表头按上述列，30 行数据，category 取 差旅-酒店 / 差旅-交通 / 招待 / 办公，其中至少 6 行故意违规且覆盖三类（超限 / 缺发票 / 审批不足）；2）audit.js（CommonJS、零第三方依赖）：读取 expenses.csv 逐行套用 A-E 规则，输出 violations.csv（表头 expense_id,rule,detail；rule 取 over_limit / missing_invoice / approval_insufficient），并在控制台打印违规条数；3）真实运行 node audit.js；4）audit-report.md（≥2000 字节）：总笔数/总金额、违规统计（按类型计数）、违规明细表、处理建议。回复中给出违规总数与按类型分布。`,
    expect: "expenses.csv(30行) + audit.js 实跑 + violations.csv(≥6) + audit-report.md",
    dir: `${WS}/v11-expense`,
    deliverables: [
      { file: 'expenses.csv', minLines: 31 },
      { file: 'audit.js', minBytes: 800 },
      { file: 'violations.csv', minBytes: 20 },
      { file: 'audit-report.md', minBytes: 2000 },
    ],
    exec: (dir) => {
      const js = path.join(dir, 'audit.js');
      if (!isFresh(js)) return { ok: false, detail: 'exec=无新鲜 audit.js' };
      try {
        execSync('node audit.js', { cwd: dir, timeout: 60000, encoding: 'utf8' });
      } catch (e) {
        return { ok: false, detail: `exec=node audit.js 失败 :: ${String(e.message || e).split('\n')[0].slice(0, 120)}` };
      }
      const rows = parseCsvFile(path.join(dir, 'violations.csv'));
      if (!rows.length) return { ok: false, detail: 'exec=violations.csv 缺失或为空' };
      const header = rows[0].map((s) => s.trim().toLowerCase());
      const body = rows.slice(1).filter((r) => r.some((c) => c.trim()));
      if (!header.includes('expense_id') || !header.includes('rule')) {
        return { ok: false, detail: `exec=violations.csv 表头不合规（${rows[0].join(',')}）` };
      }
      if (body.length < 6) return { ok: false, detail: `exec=违规 ${body.length}<6` };
      const ruleIdx = header.indexOf('rule');
      const kinds = new Set(body.map((r) => (r[ruleIdx] || '').trim()));
      if (kinds.size < 2) return { ok: false, detail: `exec=违规类型 ${kinds.size}<2（${[...kinds].join('/')}）` };
      return { ok: true, detail: `exec=audit.js 实跑通过，violations.csv ${body.length} 条 / ${kinds.size} 类` };
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'audit-report.md'));
      return [
        ['超限', /超限|上限/.test(md)],
        ['发票', /发票/.test(md)],
        ['审批', /审批/.test(md)],
      ];
    },
  },
  {
    id: 15,
    name: "团队周报+工时统计脚本",
    type: "办公·团队管理",
    prompt: `你是研发团队负责人，整理本周（截至 2026-11-10）团队周报，全部放 ${WS}/v11-weekly/。团队 5 人：张三、李四、王五、赵六、钱七。产出：1）team-tasks.csv：严格表头 task_id,title,owner,status,plan_hours,actual_hours,due_date,priority，40 行任务数据（owner 取上述 5 人；status 取 完成/进行中/阻塞/未开始；due_date 在 2026-11-10 至 2026-12-15 之间，至少 5 行已逾期且未完成；priority 取 P0/P1/P2）；2）weekly-report.js（CommonJS、零第三方依赖）：读取 team-tasks.csv，计算每人 完成/进行中/阻塞 数量、总体完成率（完成数/总数，0-1 小数）、总计划工时/总实际工时、逾期任务数（due_date < 2026-11-10 且 status != 完成），写 metrics.json，必须含 byOwner、totalPlanHours、totalActualHours、overdueCount、completionRate 五个键；3）真实运行 node weekly-report.js；4）weekly-report.md（≥2000 字节）：本周完成（列 5 项）、风险与阻塞（列 2 项）、下周计划（≥5 项）、需要决策事项（≥2 项）。回复中给出完成率与逾期任务数。`,
    expect: "team-tasks.csv(40行) + weekly-report.js 实跑 + metrics.json 五键 + weekly-report.md",
    dir: `${WS}/v11-weekly`,
    deliverables: [
      { file: 'team-tasks.csv', minLines: 41 },
      { file: 'weekly-report.js', minBytes: 800 },
      { file: 'metrics.json', minBytes: 100 },
      { file: 'weekly-report.md', minBytes: 2000 },
    ],
    exec: (dir) => {
      const js = path.join(dir, 'weekly-report.js');
      if (!isFresh(js)) return { ok: false, detail: 'exec=无新鲜 weekly-report.js' };
      try {
        execSync('node weekly-report.js', { cwd: dir, timeout: 60000, encoding: 'utf8' });
      } catch (e) {
        return { ok: false, detail: `exec=node weekly-report.js 失败 :: ${String(e.message || e).split('\n')[0].slice(0, 120)}` };
      }
      try {
        const m = JSON.parse(readFileSafe(path.join(dir, 'metrics.json')));
        const need = ['byOwner', 'totalPlanHours', 'totalActualHours', 'overdueCount', 'completionRate'];
        const miss = need.filter((k) => !(k in m));
        if (miss.length) return { ok: false, detail: `exec=metrics.json 缺键 ${miss.join('|')}` };
        return { ok: true, detail: `exec=weekly-report.js 实跑通过，metrics.json 五键齐（completionRate=${m.completionRate}）` };
      } catch (e) {
        return { ok: false, detail: `exec=metrics.json 解析失败 :: ${String(e.message || e).split('\n')[0].slice(0, 100)}` };
      }
    },
    quality: (dir) => {
      const md = readFileSafe(path.join(dir, 'weekly-report.md'));
      return [
        ['完成', /完成/.test(md)],
        ['风险', /风险|阻塞/.test(md)],
        ['下周', /下周/.test(md)],
        ['决策', /决策/.test(md)],
      ];
    },
  },
];

// P1：统一门 = 结构不变量 + 可执行证据；quality 只报告不 gate
for (const t of tasks) t.check = (r) => invariantCheck(t, r);

async function main() {
  console.log('='.repeat(80));
  console.log('EvoClaw v10 复杂任务压测 — 15 任务（1-10 工程/写作轮 + 11-15 办公任务轮）');
  console.log(`Server: http://127.0.0.1:${PORT}`);
  console.log('='.repeat(80) + '\n');

  const outputDirs = [
    `${WS}/v10-alerts`,
    `${WS}/v10-ddd`,
    `${WS}/v10-webhook`,
    `${WS}/v10-gateway`,
    `${WS}/v10-sql`,
    `${WS}/v10-script`,
    `${WS}/v9-k8s`, // 对照任务（Task 7）沿用原目录
    `${WS}/v10-batch`,
    `${WS}/v10-pr`,
    `${WS}/v10-release`,
    // v11 办公任务轮（id 11-15）
    `${WS}/v11-sales`,
    `${WS}/v11-meeting`,
    `${WS}/v11-competitor`,
    `${WS}/v11-expense`,
    `${WS}/v11-weekly`,
  ];
  for (const dir of outputDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); console.log(`🧹 Cleaned ${dir}`); } catch {}
  }
  console.log();

  const results = [];
  const out = path.resolve(__dirname, 'test-results-sim10.json');
  const saveResults = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString() }, null, 2));

  const taskFilterSet = process.env.TASK_FILTER
    ? new Set(process.env.TASK_FILTER.split(',').map((s) => parseInt(s.trim(), 10)))
    : null;

  // ★ 2026-11-09：默认窗口 540s→1200s（durable 重活任务实测 540s 等不到落盘，
  //   v10 Task 1/7 两例 ⏳ 检查点；同步路径任务不受影响——只在前置条件
  //   「未通过 + ⏳ 检查点/客户端超时」时才轮询，窗口是上限不是等待时长）。
  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 1200000;
  const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS) || 45000;

  for (const task of tasks) {
    if (taskFilterSet !== null && !taskFilterSet.has(task.id)) continue;
    console.log(`[Task ${task.id}] ${task.name} (${task.type})`);
    console.log('-'.repeat(60));
    const startTime = Date.now();
    let resp = null;
    let timedOut = false;
    try {
      resp = await apiRequest('POST', '/api/chat', {
        message: task.prompt,
        sessionId: `v10-task-${task.id}-${Date.now()}`,
        stream: false,
      });
    } catch (err) {
      timedOut = true;
      resp = { status: 0, data: { reply: '' } };
      console.log(`⚠️  客户端超时（${err.message}），转延迟核验（窗口 ${VERIFY_WINDOW_MS / 1000}s）`);
    }
    const duration = Date.now() - startTime;
    const reply = resp.data?.reply || '';
    const tokens = resp.data?.tokensUsed || 0;
    const receipts = resp.data?.files || [];

    const isCheckpointReply = /⏳|检查点|后台继续|继续执行/.test(reply);
    let verdict = task.check({ reply, tokens, duration, receipts });
    let verifyWaited = 0;
    while (!verdict.ok && verifyWaited < VERIFY_WINDOW_MS && (timedOut || isCheckpointReply)) {
      await sleep(VERIFY_POLL_MS);
      verifyWaited += VERIFY_POLL_MS;
      verdict = task.check({ reply, tokens, duration, receipts });
    }
    const delayNote = verifyWaited > 0
      ? ` [延迟核验 ${Math.round(verifyWaited / 1000)}s${timedOut ? '，客户端超时→后台完成' : '，⏳→后台完成'}]`
      : '';

    const status = verdict.ok
      ? 'success'
      : (resp.status !== 200 ? (timedOut ? 'error' : 'failed') : 'regression');

    results.push({
      id: task.id, name: task.name, type: task.type, expect: task.expect,
      status, duration: duration + verifyWaited, tokens,
      detail: `${verdict.detail}${delayNote}`,
      replyPreview: reply.slice(0, 240).replace(/\n/g, ' '),
    });
    saveResults();
    console.log(`${status === 'success' ? '✅' : '❌'} ${status.toUpperCase()} (${((duration + verifyWaited) / 1000).toFixed(1)}s, tokens=${tokens})`);
    console.log(`   ${results[results.length - 1].detail}`);
    console.log(`   preview: ${results[results.length - 1].replyPreview}...`);
    console.log('\n');
  }

  console.log('='.repeat(80));
  console.log('V10 SUMMARY');
  console.log('='.repeat(80));
  const pass = results.filter((r) => r.status === 'success').length;
  console.log(`Total: ${results.length} | pass: ${pass} | regression: ${results.filter((r) => r.status === 'regression').length} | error: ${results.filter((r) => r.status === 'error').length}`);
  for (const r of results) {
    console.log(`  ${r.id}. ${r.name} [${r.status}] ${(r.duration / 1000).toFixed(1)}s tokens=${r.tokens ?? 0}`);
    console.log(`      ${r.detail}`);
  }
  saveResults();
  console.log(`\nResults saved: ${out}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
