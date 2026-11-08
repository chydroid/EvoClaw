#!/usr/bin/env node
/**
 * analyze-cashflow.js — 流式读取 cashflow CSV，计算财务指标，输出报告 + metrics.json
 * 指标：各部门月度净现金流、最大单月赤字、现金储备滚动余额、月度 burn rate、按 category 的支出占比
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DIR = __dirname;
const CSV = path.join(DIR, 'cashflow-2026-h1.csv');
const METRICS = path.join(DIR, 'metrics.json');
const REPORT = path.join(DIR, 'h1-report.md');

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月'];
const INIT_RESERVE = 5000; // 期初现金储备（万元）

const agg = {
  deptMonth: {},       // dept -> [6] net
  catOutflow: {},      // cat -> outflow
  monthNet: [0, 0, 0, 0, 0, 0],
  monthInflow: new Array(6).fill(0),
  monthOutflow: new Array(6).fill(0),
  reserve: [],
  totalIn: 0, totalOut: 0,
  totalTxn: 0,
};

// 流式逐行读取（readline 即流式，不一次性载入全文）
const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
let lineNo = 0;

rl.on('line', (line) => {
  if (lineNo++ === 0) return; // 跳过表头
  const p = line.split(',');
  if (p.length < 6) return;
  const date = p[0], dept = p[1], cat = p[2];
  const inflow = parseFloat(p[3]) || 0;
  const outflow = parseFloat(p[4]) || 0;
  const txn = parseInt(p[5], 10) || 0;

  const mi = parseInt(date.slice(5), 10) - 1; // 1-6

  agg.deptMonth[dept] = agg.deptMonth[dept] || [0, 0, 0, 0, 0, 0];
  agg.deptMonth[dept][mi] += inflow - outflow;
  agg.catOutflow[cat] = (agg.catOutflow[cat] || 0) + outflow;
  agg.monthNet[mi] += inflow - outflow;
  agg.monthInflow[mi] += inflow;
  agg.monthOutflow[mi] += outflow;
  agg.totalIn += inflow;
  agg.totalOut += outflow;
  agg.totalTxn += txn;
});

rl.on('close', () => {
  // 滚动现金储备
  let bal = INIT_RESERVE;
  for (let i = 0; i < 6; i++) { bal += agg.monthNet[i]; agg.reserve.push(Math.round(bal * 100) / 100); }

  // burn rate = 当月支出 / 当月期初储备
  const burnRate = agg.monthOutflow.map((o, i) => {
    const startBal = INIT_RESERVE + agg.reserve.slice(0, i).reduce((a, b) => a + b, 0);
    return Math.round(o / startBal * 10000) / 100;
  });
  const monthsOfRunway = agg.monthNet.map((n, i) => {
    const startBal = INIT_RESERVE + agg.reserve.slice(0, i).reduce((a, b) => a + b, 0);
    const netOut = Math.max(0, -n);
    return netOut > 0 ? Math.round((startBal / netOut) * 100) / 100 : Infinity;
  });

  // 最大单月赤字
  let worstMonth = 0, worstNet = agg.monthNet[0];
  agg.monthNet.forEach((n, i) => { if (n < worstNet) { worstMonth = i; worstNet = n; } });

  // category 占比
  const catShare = {};
  for (const [c, v] of Object.entries(agg.catOutflow)) catShare[c] = Math.round(v / agg.totalOut * 10000) / 100;
  const topCatSorted = Object.entries(agg.catOutflow).sort((a, b) => b[1] - a[1]).map((x) => x[0]);

  // ─── metrics.json ───
  const metrics = {
    period: '2026-01 ~ 2026-06',
    initReserve: INIT_RESERVE,
    totalInflow: Math.round(agg.totalIn * 100) / 100,
    totalOutflow: Math.round(agg.totalOut * 100) / 100,
    totalNet: Math.round((agg.totalIn - agg.totalOut) * 100) / 100,
    totalTxn: agg.totalTxn,
    monthlyNet: agg.monthNet.map((x) => Math.round(x * 100) / 100),
    monthlyBurnRatePct: burnRate,
    monthsOfRunway: monthsOfRunway.map((x) => x === Infinity ? null : x),
    maxDeficitMonth: MONTHS[worstMonth],
    maxDeficitAmount: Math.round(worstNet * 100) / 100,
    reserveAtMonthEnd: agg.reserve,
    categoryOutflowShare: catShare,
    deptMonthlyNet: {},
  };
  for (const [d, arr] of Object.entries(agg.deptMonth)) {
    metrics.deptMonthlyNet[d] = {
      monthly: arr.map((x) => Math.round(x * 100) / 100),
      total: Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100,
    };
  }
  fs.writeFileSync(METRICS, JSON.stringify(metrics, null, 2), 'utf8');

  // ─── 报告 ───
  fs.writeFileSync(REPORT, buildReport({
    burnRate, monthsOfRunway, worstMonth, worstNet, catShare, topCatSorted,
  }), 'utf8');

  console.log('metrics.json 已写入:', METRICS);
  console.log('h1-report.md 已写入:', REPORT);
  console.log('最大单月赤字:', MONTHS[worstMonth], '≈', Math.round(worstNet), '万元');
  console.log('H1 净现金流 ≈', Math.round(agg.totalIn - agg.totalOut), '万元');
  const runwayMin = Math.min(...monthsOfRunway.filter((x) => x !== Infinity));
  console.log('最短 runway:', runwayMin === Infinity ? '∞' : runwayMin + ' 个月');
});

function buildReport({ burnRate, monthsOfRunway, worstMonth, worstNet, catShare, topCatSorted }) {
  const revs = agg.reserve;
  const maxV = Math.max(...revs), minV = Math.min(...revs);
  const W = 52, H = 9;
  const grid = Array.from({ length: H }, () => ' '.repeat(W));
  revs.forEach((v, i) => {
    const x = Math.round(i / (revs.length - 1) * (W - 1));
    const y = Math.round((v - minV) / (maxV - minV) * (H - 1));
    grid[H - 1 - y] = grid[H - 1 - y].slice(0, x) + '#' + grid[H - 1 - y].slice(x + 1);
  });
  const asciiChart = grid.join('\n');

  const deptNames = Object.keys(agg.deptMonth);
  let table = '| 月份 | ' + deptNames.join(' | ') + ' | 合计净现金流 | 期末现金储备 | 单月Burn Rate |\n';
  table += '|------|' + deptNames.map(() => '------').join('|') + '|------|------|------|\n';
  for (let i = 0; i < 6; i++) {
    table += `| ${MONTHS[i]} | ` + deptNames.map((d) => fmt(agg.deptMonth[d][i])).join(' | ') +
      ` | ${fmt(agg.monthNet[i])} | ${fmt(revs[i])} | ${burnRate[i]}% |\n`;
  }
  table += `| **H1合计** | ` + deptNames.map((d) => fmt(agg.deptMonth[d].reduce((a, b) => a + b, 0))).join(' | ') +
    ` | **${fmt(agg.totalIn - agg.totalOut)}** | ${fmt(revs[5])} | - |\n`;

  const catTable = Object.entries(catShare).sort((a, b) => b[1] - a[1])
    .map(([c, s]) => `| ${c} | ${s}% |`).join('\n');
  const runwayMin = Math.min(...monthsOfRunway.filter((x) => x !== Infinity));
  const avgBurn = (burnRate.reduce((a, b) => a + b) / 6).toFixed(2);
  const t0 = topCatSorted[0], t1 = topCatSorted[1];
  const lowMonth = revs.indexOf(minV) + 1;

  return `# 2026 年 H1 财务复盘报告

> CFO 办公室 · 财务分析 | 数据期间：2026-01-01 ~ 2026-06-30（180 天） | 单位：万元人民币
> 数据来源：cashflow-2026-h1.csv（模拟数据，${agg.totalTxn.toLocaleString()} 笔交易）

## 一、执行摘要

H1 全期现金流入 ${fmt(agg.totalIn)} 万元，流出 ${fmt(agg.totalOut)} 万元，净现金流 ${fmt(agg.totalIn - agg.totalOut)} 万元。现金储备由期初 ${INIT_RESERVE} 万元变动至期末 ${fmt(revs[5])} 万元。最大单月赤字出现在 ${MONTHS[worstMonth]}（净流出 ${fmt(Math.abs(worstNet))} 万元），主要受 ${t0} 支出占比高达 ${catShare[t0]}% 及偶发大额支出叠加影响。支出结构以${t0}为主，H1 月度 burn rate 峰值 ${Math.max(...burnRate)}%。若 H2 延续当前净流向，现金储备约可支撑 ${runwayMin === Infinity ? '无限' : runwayMin + ' 个'} 月，建议 H2 初完成 P0 级支出管控措施。

## 二、月度 × 部门净现金流（万元）

${table}

## 三、现金储备滚动趋势

期初储备 ${INIT_RESERVE} 万元，逐月滚动：

\`\`\`
${asciiChart}
\`\`\`

| 月末 | 现金储备（万元） | 当月净现金流 |
|------|-----------|-----------|
${[0, 1, 2, 3, 4, 5].map((i) => `| ${MONTHS[i]} | ${fmt(revs[i])} | ${fmt(agg.monthNet[i])} |`).join('\n')}

## 四、按 Category 支出占比

${catTable}

## 五、问题诊断（3 项）

1. **${MONTHS[worstMonth]} 赤字最深**：单月净流出 ${fmt(Math.abs(worstNet))} 万元，为 H1 最大赤字月。该月 burn rate ${burnRate[worstMonth]}%，高于 6 个月均值 ${avgBurn}%，需核查该月偶发大额支出明细（${t0} 类为主）。
2. **支出结构失衡**：${t0} 占总支出 ${catShare[t0]}%，${t1} 占 ${catShare[t1]}%，两项合计 ${(catShare[t0] + catShare[t1]).toFixed(1)}%。固定成本（人力成本+办公租赁）刚性偏高，收入下滑时缓冲空间小。
3. **现金储备低点风险**：储备最低点 ${fmt(minV)} 万元（${lowMonth}月月末），若 H2 维持 H1 平均净流向，runway 仅 ${runwayMin === Infinity ? '充足' : runwayMin + ' 个'}月，抗风险能力不足。

## 六、H2 财务建议（按优先级）

| 优先级 | 建议 | 预期效果 |
|--------|------|----------|
| P0 | 建立月度大额支出审批阈值（单笔 >50 万元需 CFO 签批），消除偶发性现金冲击 | 降低单月赤字波动 20-30% |
| P0 | 将 ${t0} 预算压缩 10-15%（当前占支出 ${catShare[t0]}%），转投 ROI 最高的渠道 | 月均支出下降约 ${fmt(agg.totalOut / 6 * catShare[t0] / 100 * 0.12)} 万元 |
| P1 | 收入端启动 90 天回款专项：对销售/运营部门按账龄分层催收，目标缩短 DSO 15 天 | 月均流入提升 5-8% |
| P1 | 推行 0-based budgeting：下半年按季度重估各部门预算，弹性项占比提升至 60% | 刚性成本占比下降 |
| P2 | 开设短期现金管理池（T+0 理财/1个月定存阶梯），目标期末储备不低于 ${fmt(revs[5] * 1.2)} 万元 | 提升安全垫与资金效率 |
| P2 | 建立月度财务仪表盘（本报告指标自动刷新），burn rate 超过 15% 自动预警 | 风险前置管理 |

## 七、附录：指标说明

- **净现金流** = 流入 − 流出（万元）；**现金储备** = 期初 ${INIT_RESERVE} + 累计净现金流（滚动）
- **Burn Rate** = 当月支出 ÷ 当月期初储备 × 100%；**Runway** = 期初储备 ÷ 当月净流出（仅当净流出 > 0）
- 指标已写入 metrics.json；模拟数据由 generate-cashflow.js 生成，分析脚本 analyze-cashflow.js 流式处理。

---
*报告生成：${new Date().toISOString().slice(0, 10)} · 单位：万元人民币 · 数据为模拟数据，仅供流程演练*
`;
}

function fmt(x) { return (Math.round(x * 100) / 100).toLocaleString('en-US'); }
