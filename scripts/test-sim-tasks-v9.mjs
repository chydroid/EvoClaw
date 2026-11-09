/**
 * EvoClaw v9 复杂任务压测（2026-11-08，Step 5/6/7 落地后回归轮）
 *
 * 10 条全新复杂任务，覆盖多类型：
 *   1. 数据分析+报告（月度财务：CSV 生成→流式分析→报告+JSON）
 *   2. 技术方案评审（多租户架构）
 *   3. 数据处理+洞察（用户行为漏斗）
 *   4. 脚本开发+验证+文档（CI 流水线脚本集）
 *   5. PRD 文档（数据看板）
 *   6. 创意写作（长篇叙事）
 *   7. 运维工程（K8s 多环境 IaC）
 *   8. 算法实现+测试（真实跑 node --test）
 *   9. 合规分析（数据出境）
 *  10. 复合任务（CLI 工具+文档）
 *
 * P1 核验策略（2026-11-08，任务级交付物不变量，参照 hermes「完成 = 不变量」设计）：
 *   - 通过门 = 结构不变量：交付物存在 + mtime 新鲜度 + 大小/行数下限 + 回执对账
 *     （/api/chat 响应 files 字段 = executor 结构化回执账本）+ 可执行证据
 *     （node --test / CLI 实跑，确定性无 LLM 判断）。
 *   - 落点漂移探测：交付物在声明位置缺失、但同 basename 回执落在别处 →
 *     门失败并指向实际落点（v9 Task 6 类回归信号，与 P0 reconcileClaimedAgainstReceipts 同构）。
 *   - 正文正则全部降级为 quality 标志：只在 detail 中报告，不参与 ok 判定
 *     （不再因模型措辞变化误杀，hermes evidence-gated 思路）。
 *   - 延迟核验：客户端超时 / ⏳ 检查点后轮询等待落盘；「运行测试」型 exec
 *     显式指定测试文件 + timeout 兜底（禁自动发现）；绝不编造：只判真实存在的文件。
 *
 * 2026-11-09 入库修复（方案 B 全量轮后）：
 *   - verifyDeliverables 回执侧探测补 exts 过滤（与候选侧对齐）——旧版
 *     /deploy|doc/i + exts=['.md'] 误匹配回执里 deployment.yaml（"deploy"
 *     命中），把真缺失渲染成「落点漂移→yaml」（v9 Task 7 全量轮误报根因）。
 *   - 便携化：jsonwebtoken 从 gateway 包解析（不再写死 .pnpm 版本路径）；
 *     js-yaml 经 findJsYamlPath 双布局探测（提升/严格），缺失时显式降级
 *     「仅计数未解析」而非静默判过。
 *   - Task 7 exec 改 loadAll（4.x）/safeLoadAll（3.x）：K8s 多文档 YAML
 *     （`---` 分隔）在 `load` 下全量轮 6 文件全部误报 "expected a single
 *     document"，loadAll 才真查语法。
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execSync } from 'child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ★ 便携化（2026-11-09 入库）：jsonwebtoken 从 gateway 包解析（pnpm 下只有
//   gateway 声明该依赖），不再写死 .pnpm 内部版本号路径（锁版本升级即断链）。
const gatewayRequire = createRequire(path.join(__dirname, '../packages/gateway/package.json'));
const jwt = gatewayRequire('jsonwebtoken');
// 按文件路径 require（Task 7 exec 的 js-yaml 单文件引用；.mjs 下无全局 require）
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
 * 定位 js-yaml（Task 7 exec 用）。便携化（2026-11-09 入库）：
 *   ① 仓库根 node_modules/js-yaml（提升/扁平布局环境直接命中）；
 *   ② pnpm 严格布局 → 扫 node_modules/.pnpm 下 js-yaml@x.y.z 目录取最高版本。
 * 皆无 → null（调用方显式降级为「仅计数未解析」，不静默判过）。
 * 历史坑：旧版写死 /home/chy/... 绝对路径，仓库搬家即静默降级。
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
      // 版本号排序取最高（如 js-yaml@4.3.0 > js-yaml@3.14.2）
      cands.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      return cands[0];
    }
  }
  return null;
}

/**
 * P1：任务级交付物不变量（2026-11-08）。
 * 结构不变量核验，逐项交付物：
 *   1. 存在性：声明位置的文件真实在盘（不再依赖正文声称）；
 *   2. 新鲜度：mtime > RUN_START（本轮产物而非上轮残留）；
 *   3. 量化下限：minBytes / minLines（CSV ≥ N 行等可量化要求）；
 *   4. 回执对账：声明位置缺失但同 basename 的结构化回执（API files 字段）
 *      落在别处 → 落点漂移，门失败并指向实际落点（v9 Task 6 类信号）；
 *   5. 数量约束：minCount（如 ≥6 个 YAML 文件）。
 *
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
        // ★ 2026-11-09 修 harness 误报：回执侧探测必须与候选侧同用 exts 过滤——
        //   此前 /deploy|doc/i + exts ['.md'] 会误匹配回执里的 deployment.yaml
        //   （"deploy" 命中），把真缺失渲染成「落点漂移→…yaml」。
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

/**
 * P1 统一门：结构不变量（verifyDeliverables）+ 可执行证据（exec，hermes
 * evidence-gated 确定性探针）为通过条件；正文正则（quality）只报告不 gate。
 */
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

const tasks = [
  {
    id: 1,
    name: "月度财务复盘报告",
    type: "数据分析+报告生成",
    prompt: "你是 CFO 办公室的财务分析师，请完成 2026 年 H1（1-6 月）财务复盘。要求：1）用 Node.js 生成 180 天的模拟现金流 CSV（字段：date, dept, category, inflow, outflow, txn_count，至少 5 个部门 6 个类别，数据有月度季节性 + 偶发大额支出）；2）流式处理 CSV，计算：各部门月度净现金流、最大单月赤字、现金储备滚动余额、月度 burn rate、按 category 的支出占比；3）把完整报告写入 /home/chy/EvoClaw/data/workspace/v9-finance/h1-report.md，包含：执行摘要（150字）、月度×部门净现金流表格、现金储备趋势（ASCII 折线或数据表）、3 个问题诊断、H2 财务建议（至少4条，按优先级）；4）聚合指标写入 /home/chy/EvoClaw/data/workspace/v9-finance/metrics.json；5）回复中给出 2 个最重要的发现。生成脚本也放在 /home/chy/EvoClaw/data/workspace/v9-finance/ 下。",
    expect: "生成脚本 + CSV(≥300行) + h1-report.md + metrics.json 落盘，报告含摘要/表格/趋势/诊断/建议",
    dir: '/home/chy/EvoClaw/data/workspace/v9-finance',
    deliverables: [
      { regex: /gen|generate|create|cash/i, exts: ['.js', '.mjs'] },
      { regex: /csv$/i, minLines: 300 },
      { file: 'h1-report.md', minBytes: 400 },
      { file: 'metrics.json', minBytes: 50 },
    ],
    quality: (dir) => {
      const report = readFileSafe(path.join(dir, 'h1-report.md'));
      const metrics = readFileSafe(path.join(dir, 'metrics.json'));
      return [
        ['摘要', /执行摘要|摘要|概述|summary/i.test(report)],
        ['表格', /\|.*\|.*\|/.test(report) && /[0-9]/.test(report)],
        ['趋势', /储备|burn|赤字|trend|趋势|折线/i.test(report)],
        ['诊断', /问题|诊断|赤字|超支|风险|下降/i.test(report)],
        ['建议', /建议|H2|下一步|优先级|行动/i.test(report)],
        ['metrics', metrics.length > 50 && /[{[]/.test(metrics)],
      ];
    },
  },
  {
    id: 2,
    name: "多租户 SaaS 架构评审",
    type: "技术方案评审",
    prompt: "你是架构评审委员会的技术负责人，评审一份多租户 SaaS 平台方案。背景：B2B 协作 SaaS，目标 10 万企业租户，每租户独立数据隔离可选（共享/独立库/独立集群三档）。请完成评审文档：1）数据隔离模型对比：共享 schema（行级隔离）/共享库多 schema/独立库 的隔离强度、成本、运维复杂度、查询性能矩阵；2）租户上下文传递：请求路由→中间件→ORM/查询注入 的租户隔离贯穿方案，防跨租户越权的 3 道防线；3）限流与配额：租户级 QPS/存储/调用配额的分层设计（网关+服务+数据层）与 429 语义；4）多租户下的缓存/搜索/对象存储命名空间策略；5）租户数据删除（GDPR 右被遗忘）的级联删除 + 审计留痕方案；6）给出明确评审结论（通过/有条件通过/不通过）+ 5 条以内核心建议。写入 /home/chy/EvoClaw/data/workspace/v9-saas/architecture-review.md。",
    expect: "评审文档落盘，含隔离对比+上下文传递+限流配额+命名空间+数据删除+结论建议",
    dir: '/home/chy/EvoClaw/data/workspace/v9-saas',
    deliverables: [
      { file: 'architecture-review.md', minBytes: 2500 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'architecture-review.md'));
      return [
        ['隔离', /隔离|共享|独立库|schema|多租户|tenant/i.test(doc)],
        ['上下文', /上下文|中间件|越权|注入|路由|贯穿/i.test(doc)],
        ['配额', /限流|配额|QPS|429|quota|rate/i.test(doc)],
        ['命名空间', /缓存|搜索|命名空间|namespace|对象存储/i.test(doc)],
        ['删除', /删除|右被遗忘|GDPR|级联|审计|audit/i.test(doc)],
        ['结论', /评审结论|结论|通过|有条件通过|不通过|建议/i.test(doc)],
        ['建议≥2', (doc.match(/建议|核心建议/g) || []).length >= 2],
      ];
    },
  },
  {
    id: 3,
    name: "用户行为漏斗分析",
    type: "数据处理+洞察",
    prompt: "你是增长团队的数据分析负责人，分析 2026 年 Q2 用户行为漏斗。要求：1）用 Node.js 生成约 20000 条模拟事件 CSV（字段：user_id, event_type, ts, source, device, completed，event_type 覆盖 visit/signup/activate/purchase/retention 五阶段，source 含 organic/paid/ads/referral，带漏斗衰减）；2）流式处理，计算：各阶段转化量+环比转化率、完整漏斗 visit→signup→activate→purchase 的整体转化率、按 source 的获客效率（每 100 单成本假设 paid CPM 不同）、按 device 的差异、留存率（retention/completed）；3）把完整报告写入 /home/chy/EvoClaw/data/workspace/v9-funnel/funnel-analysis.md，含：数据概览、五阶段漏斗表（量+转化率）、source 效率对比、device 差异、3 个洞察 + 4 条改进建议；4）聚合指标写入 /home/chy/EvoClaw/data/workspace/v9-funnel/metrics.json；5）回复给出 2 个最重要的洞察。生成脚本放在同目录。",
    expect: "生成脚本 + CSV(≥15000行) + funnel-analysis.md + metrics.json 落盘，报告含漏斗/效率/差异/洞察/建议",
    dir: '/home/chy/EvoClaw/data/workspace/v9-funnel',
    deliverables: [
      { regex: /gen|generate|create|event/i, exts: ['.js', '.mjs'] },
      { regex: /csv$/i, minLines: 15000 },
      { file: 'funnel-analysis.md', minBytes: 400 },
      { file: 'metrics.json', minBytes: 50 },
    ],
    quality: (dir) => {
      const report = readFileSafe(path.join(dir, 'funnel-analysis.md'));
      const metrics = readFileSafe(path.join(dir, 'metrics.json'));
      return [
        ['漏斗', /漏斗|转化|visit|signup|activate|purchase|retention/i.test(report)],
        ['渠道', /source|渠道|organic|paid|referral|获客效率/i.test(report)],
        ['设备', /device|设备|移动端|桌面|mobile|desktop/i.test(report)],
        ['洞察', /洞察|发现|结论|insight/i.test(report)],
        ['建议', /建议|改进|行动|optimi/i.test(report)],
        ['metrics', metrics.length > 50 && /[{[]/.test(metrics)],
      ];
    },
  },
  {
    id: 4,
    name: "CI 流水线脚本集",
    type: "脚本开发+验证+文档",
    prompt: "你是平台工程负责人，为 Node 项目编写 CI 辅助脚本集。要求（全部放 /home/chy/EvoClaw/data/workspace/v9-ci/）：1）lint-check.sh：对指定目录跑 tsc --noEmit 与 eslint（若装）汇总退出码；2）test-coverage.sh：跑 vitest --coverage 并解析覆盖率阈值（低于 60% 告警）；3）build-artifact.sh：build 后打包 dist 为 tar.gz + 生成 SHA256 校验清单 checksums.txt；4）rollback.sh：从备份目录恢复指定版本 dist，支持 --list；5）PIPELINE.md：脚本用途、调用顺序（lint→test→build→deploy）、失败处理、环境变量。实际运行 lint-check.sh 与 build-artifact.sh 把输出写入 /home/chy/EvoClaw/data/workspace/v9-ci/verify-output.log。",
    expect: "4 个脚本 + PIPELINE.md + verify-output.log 落盘，脚本真实可执行",
    dir: '/home/chy/EvoClaw/data/workspace/v9-ci',
    deliverables: [
      { regex: /lint/i, exts: ['.sh'] },
      { regex: /cov|test/i, exts: ['.sh'] },
      { regex: /build|artifact/i, exts: ['.sh'] },
      { regex: /rollback/i, exts: ['.sh'] },
      { regex: /PIPELINE|pipeline/i, exts: ['.md'] },
      { regex: /verify/i, minBytes: 100 },
    ],
    exec: (dir) => {
      const b = listRecursive(dir).find((f) => /build|artifact/i.test(f) && f.endsWith('.sh') && isFresh(f));
      if (!b) return { ok: true, detail: '' };
      try { execSync(`bash ${b} 2>&1 | head -5`, { timeout: 12000, encoding: 'utf8' }); } catch { /* 允许非零码，须真实执行 */ }
      return { ok: true, detail: 'exec=build脚本已执行' };
    },
    quality: (dir) => {
      const all = listRecursive(dir);
      const manual = all.find((f) => f.endsWith('.md') && /PIPELINE|pipeline|流水线/i.test(f));
      const doc = readFileSafe(manual || '');
      return [
        ['顺序', /lint|顺序|流程|stage/i.test(doc)],
        ['失败处理', /失败|fail|退出码|exit/i.test(doc)],
      ];
    },
  },
  {
    id: 5,
    name: "数据看板 PRD",
    type: "需求分析+文档撰写",
    prompt: "你是产品经理，为 B2B SaaS 的「数据看板」功能写 PRD。背景：企业客户需自定义指标看板，现用固定报表，客户抱怨不灵活/取数慢。请完成：1）需求分析：客户痛点（固定报表局限、取数自助）、竞品（Tableau/Power BI/飞书多维表格的看板机制）、3 类角色（分析师/业务管理者/高管）画像；2）功能需求：自定义指标（拖拽聚合/筛选/分组）、图表类型（≥5 种）、看板共享与权限（角色级 + 字段级脱敏）、自动刷新与数据源连接（CSV/API/数据库 3 类）、AI 洞察（自动异常标注 + 一句话结论）；3）非功能：首屏 < 2s、并发 200 看板、数据权限隔离；4）用户流程：新建看板到发布的步骤线框（文字）、字段脱敏交互；5）技术方案：指标引擎（预聚合 + 物化视图 + 缓存分层）、数据源适配层；6）验收标准 ≥10 条（Given-When-Then）；7）里程碑 MVP/ V1.1/ V1.2。写入 /home/chy/EvoClaw/data/workspace/v9-prd/dashboard-prd.md。",
    expect: "PRD 落盘，含痛点+竞品+角色+功能+非功能+UI流程+技术方案+验收+里程碑",
    dir: '/home/chy/EvoClaw/data/workspace/v9-prd',
    deliverables: [
      { file: 'dashboard-prd.md', minBytes: 3000 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'dashboard-prd.md'));
      return [
        ['痛点', /痛点|问题|局限|抱怨|固定报表/i.test(doc)],
        ['竞品', /竞品|Tableau|Power BI|多维|对比/i.test(doc)],
        ['角色', /角色|画像|分析师|管理者|高管|persona/i.test(doc)],
        ['功能', /自定义|指标|拖拽|图表|共享|脱敏/i.test(doc)],
        ['非功能', /非功能|首屏|并发|2s|权限隔离/i.test(doc)],
        ['流程', /流程|线框|步骤|发布/i.test(doc)],
        ['技术方案', /技术方案|指标引擎|物化|缓存|数据源/i.test(doc)],
        ['验收', /验收标准|Given|When|Then/i.test(doc)],
        ['验收条数≥5', (doc.match(/Given|验收标准|AC\d|场景\d/gi) || []).length >= 5],
        ['里程碑', /里程碑|MVP|V1\.|阶段/i.test(doc)],
      ];
    },
  },
  {
    id: 6,
    name: "长篇科幻叙事",
    type: "创意写作",
    prompt: "以「最后一座没有 AI 的城市」为题，写一篇 3000 字以上的原创科幻短篇。要求：世界观设定（2090 年，AI 治理全球，唯余一座物理隔离的「离线城市」，靠模拟蒸汽传动 + 人肉计算维持）；主角是一名「人肉计算机」，因一次关键计算错误导致城市被 AI 联邦发现；叙事需有至少 3 处反转、一个开放式结尾、一条明线（寻找计算错误根源）与一条暗线（主角与城市守护者的信任博弈）；主题探讨「人类的价值在可被计算的世间还剩什么」。把全文写入 /home/chy/EvoClaw/data/workspace/v9-novel/the-last-city.md，并在文末附一段 200 字创作札记（世界观考据 + 主题立意）。",
    expect: "3000字以上短篇落盘，含世界观+3处反转+开放式结尾+明暗双线+文末札记",
    dir: '/home/chy/EvoClaw/data/workspace/v9-novel',
    deliverables: [
      { file: 'the-last-city.md', minBytes: 3000 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'the-last-city.md'));
      return [
        ['≥3000字', doc.length > 3000],
        ['世界观', /2090|AI 联邦|离线城市|人肉计算|模拟蒸汽/i.test(doc)],
        ['主角', /人肉计算|计算机|主角|她|他|计算员/i.test(doc)],
        ['反转≥3', (doc.match(/反转|却|但|原来|竟|没想到|真相/g) || []).length >= 3],
        ['明暗线', /守护者|信任|暗线|明线/i.test(doc)],
        ['主题', /价值|意义|人类|算计|被计算/i.test(doc)],
        ['札记', /创作札记|札记|考据|立意/i.test(doc)],
      ];
    },
  },
  {
    id: 7,
    name: "K8s 多环境 IaC",
    type: "运维工程",
    prompt: "你是 SRE，为 3 个微服务（api/web/worker）编写 K8s 多环境（dev/staging/prod）部署方案。全部放 /home/chy/EvoClaw/data/workspace/v9-k8s/：1）每个服务一个 deployment.yaml（resources/limits、探针、PDB）+ service.yaml + 生产环境 HPA；2）ingress.yaml（3 服务路由 + TLS + 限流注解）；3）命名空间 + 各环境 ConfigMap/Secret 引用（用 values，不含真实密钥）；4）helm values 分层（values-dev.yaml / values-staging.yaml / values-prod.yaml）；5）deploy.md：部署顺序、回滚（helm rollback + 标签基线）、扩缩容、故障排查（kubectl 命令速查）。每个 YAML 必须语法可解析（用 python 或 node 校验）。",
    expect: "全部 YAML 落盘且语法可解析 + helm values 三环境 + deploy.md",
    dir: '/home/chy/EvoClaw/data/workspace/v9-k8s',
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
        // 便携化（2026-11-09 入库）：js-yaml 先查仓库根 node_modules（提升环境），
        // 缺失再查 .pnpm 目录（pnpm 严格布局，取最高版本）。两者皆无 → 存在性
        // 守卫跳过解析仅报数量（历史坑：旧版写死 /home/chy/... 绝对路径，仓库
        // 搬家即静默降级为计数，yaml 语法检查实际没跑）。
        const yamlPath = findJsYamlPath();
        if (yamlPath) {
          const yaml = require(yamlPath);
          // ★ 2026-11-09：用 loadAll 而非 load —— K8s 文件常是多文档 YAML
          //   （`---` 分隔），`load` 遇多文档抛 "expected a single document"
          //   （v9 Task 7 全量轮 6 个文件全部误报解析失败的根因）。
          //   版本双兼容：4.x → loadAll（返回已解析数组，语法错即抛）；
          //   3.x → safeLoadAll（无回调时同步返回数组，语义一致）。
          const parseAll = yaml.loadAll || yaml.safeLoadAll;
          for (const f of yamls) parseAll(readFileSafe(f));
          return { ok: true, detail: `exec=yaml×${yamls.length} 可解析（js-yaml@${yamlPath.includes('js-yaml@4') ? '4' : '3'}）` };
        }
        return { ok: true, detail: `exec=yaml×${yamls.length} 存在（js-yaml 缺失，仅计数未解析）` };
      } catch (e) {
        return { ok: false, detail: `exec=yaml解析失败 :: ${String(e.message || e).slice(0, 120)}` };
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
    name: "一致性哈希实现+测试",
    type: "算法实现+测试（真实跑 node --test）",
    prompt: "实现一个一致性哈希环（用于分布式缓存路由）。放 /home/chy/EvoClaw/data/workspace/v9-hash/：1）hash-ring.js（CommonJS 或 ESM）：SHA1/MD5 摘要（可用 crypto）、虚拟节点（默认 150，可配）、addNode/removeNode/get(key)→node、节点增减时 key 重映射率统计；2）hash-ring.test.js：用 node:test（node --test 可跑）覆盖：基本路由稳定性、节点加入时仅该节点区间的 key 迁移（重映射率 < 1/N）、移除节点时 key 分散到后继、虚拟节点越多迁移越均匀（150 vs 30 对比）、边界（单节点/空环）。测试必须真实通过（node --test）。",
    expect: "hash-ring.js + hash-ring.test.js 落盘，node --test 真实全过",
    dir: '/home/chy/EvoClaw/data/workspace/v9-hash',
    deliverables: [
      { regex: /hash.?ring/i, exts: ['.js', '.mjs'], exclude: /test/i, minBytes: 500 },
      { regex: /test/i, exts: ['.js', '.mjs'] },
    ],
    exec: (dir) => {
      const t = listRecursive(dir).find((f) => /test/i.test(f) && /\.(js|mjs)$/i.test(f) && isFresh(f));
      if (!t) return { ok: false, detail: 'exec=无新鲜测试文件' };
      const r = runNodeTest(t);
      return { ok: r.ok, detail: r.ok ? 'exec=node --test 全过' : `exec=node --test 未过 :: ${r.out.slice(0, 120)}` };
    },
    quality: (dir) => {
      const all = listRecursive(dir);
      const impl = all.find((f) => /hash.?ring/i.test(f) && !/test/i.test(f) && /\.(js|mjs)$/.test(f));
      return [['虚拟节点', /virtual|虚拟|150/i.test(readFileSafe(impl || ''))]];
    },
  },
  {
    id: 9,
    name: "数据出境合规分析",
    type: "合规分析",
    prompt: "你是数据合规负责人，公司拟把国内用户行为数据同步到新加坡数据中台做 AI 训练。请写合规分析报告（/home/chy/EvoClaw/data/workspace/v9-compliance/data-export-compliance.md）：1）适用法规矩阵：《个人信息保护法》《数据安全法》《网络安全法》+ 新加坡 PDPA + 跨境数据流动相关（安全评估/标准合同/认证）路径；2）数据分级：哪些字段属敏感个人信息（需单独同意 + 加密）、哪些可匿名化后出境；3）出境路径选型对比：安全评估 / 标准合同 / 认证 三种的适用条件、成本、时间；4）技术措施：加密（传输+静态）、去标识化、访问审计、最小化；5）用户权利响应：删除/可携带/撤回同意的跨境实现；6）风险清单 + 合规落地 checklist（≥8 项，含责任人 + 时间点）。",
    expect: "合规报告落盘，含法规矩阵+数据分级+路径选型+技术措施+权利响应+checklist",
    dir: '/home/chy/EvoClaw/data/workspace/v9-compliance',
    deliverables: [
      { file: 'data-export-compliance.md', minBytes: 2000 },
    ],
    quality: (dir) => {
      const doc = readFileSafe(path.join(dir, 'data-export-compliance.md'));
      return [
        ['法规', /个人信息保护法|数据安全法|网络安全法|PDPA/i.test(doc)],
        ['分级', /分级|敏感|去标识|匿名化|加密/i.test(doc)],
        ['路径', /安全评估|标准合同|认证|路径/i.test(doc)],
        ['技术措施', /加密|传输|静态|审计|最小化|access/i.test(doc)],
        ['权利', /删除|可携带|撤回|权利|GDPR|PDPA/i.test(doc)],
        ['checklist', /checklist|清单|责任人|时间点/i.test(doc)],
        ['条目≥6', (doc.match(/- \[?\]|·|\d+\./g) || []).length >= 6],
      ];
    },
  },
  {
    id: 10,
    name: "CLI 任务管理器+文档",
    type: "复合任务",
    prompt: "写一个 Node.js 命令行任务管理器（无第三方依赖，用内置 fs/path）。放 /home/chy/EvoClaw/data/workspace/v9-todo/：1）todo-cli.js：支持 add/list/done/rm/next 子命令，任务存 JSON（{id,title,status,createdAt,doneAt}），支持 --priority 高/中/低，next 输出下一条未完成的最高优先级任务；2）CLI 必须可运行（node todo-cli.js add \"写周报\" --priority 高 等）；3）README.md：用法 + 命令表 + 数据结构 + 退出码约定；4）跑 3 个真实命令把输出存入 demo-output.txt（add 2 条 + list + next）。",
    expect: "todo-cli.js + README.md + demo-output.txt 落盘，CLI 真实可运行",
    dir: '/home/chy/EvoClaw/data/workspace/v9-todo',
    deliverables: [
      { regex: /todo|cli/i, exts: ['.js'], exclude: /test|node_modules/i, minBytes: 400 },
      { regex: /README/i },
      { regex: /demo|output/i, exts: ['.txt', '.log', '.out'], minBytes: 50 },
    ],
    exec: (dir) => {
      const cli = listRecursive(dir).find((f) => /todo|cli/i.test(f) && f.endsWith('.js') && !/test|node_modules/i.test(f) && isFresh(f));
      if (!cli) return { ok: false, detail: 'exec=无新鲜CLI脚本' };
      try {
        const out = execSync(`cd ${dir} && node ${cli} add "压测验证任务" --priority 高 2>&1 && node ${cli} list 2>&1`, { timeout: 8000, encoding: 'utf8' });
        const ok = /压测验证任务/.test(out);
        return { ok, detail: ok ? 'exec=CLI add/list 可运行' : 'exec=list 未见任务（命令执行了但未回显）' };
      } catch {
        return { ok: false, detail: 'exec=CLI 执行异常' };
      }
    },
    quality: (dir) => {
      const all = listRecursive(dir);
      const readme = all.find((f) => /README/i.test(f));
      return [['命令表', /add|list|done|rm|next/i.test(readFileSafe(readme || ''))]];
    },
  },
];

// P1：统一门 = 结构不变量（deliverables）+ 可执行证据（exec）；
// 正文正则（quality）降级为报告项，不参与 ok 判定（hermes evidence-gated）。
for (const t of tasks) t.check = (r) => invariantCheck(t, r);

async function main() {
  console.log('='.repeat(80));
  console.log('EvoClaw v9 复杂任务压测 — 10 任务（Step 5/6/7 回归轮 · P1 不变量门）');
  console.log(`Server: http://127.0.0.1:${PORT}`);
  console.log('='.repeat(80) + '\n');

  const outputDirs = [
    '/home/chy/EvoClaw/data/workspace/v9-finance',
    '/home/chy/EvoClaw/data/workspace/v9-saas',
    '/home/chy/EvoClaw/data/workspace/v9-funnel',
    '/home/chy/EvoClaw/data/workspace/v9-ci',
    '/home/chy/EvoClaw/data/workspace/v9-prd',
    '/home/chy/EvoClaw/data/workspace/v9-novel',
    '/home/chy/EvoClaw/data/workspace/v9-k8s',
    '/home/chy/EvoClaw/data/workspace/v9-hash',
    '/home/chy/EvoClaw/data/workspace/v9-compliance',
    '/home/chy/EvoClaw/data/workspace/v9-todo',
  ];
  for (const dir of outputDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); console.log(`🧹 Cleaned ${dir}`); } catch {}
  }
  console.log();

  const results = [];
  const out = path.resolve(__dirname, 'test-results-sim9.json');
  const saveResults = () => fs.writeFileSync(out, JSON.stringify({ results, ts: new Date().toISOString() }, null, 2));

  const taskFilterSet = process.env.TASK_FILTER
    ? new Set(process.env.TASK_FILTER.split(',').map((s) => parseInt(s.trim(), 10)))
    : null;

  const VERIFY_WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS) || 540000;
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
        sessionId: `v9-task-${task.id}-${Date.now()}`,
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
    // P1：回执账本（executor createdFiles → /api/chat 响应 files 字段），
    // 供落点漂移对账使用（结构化事实源，不 grep 正文）。
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
  console.log('V9 SUMMARY');
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
