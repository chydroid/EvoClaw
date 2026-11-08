#!/usr/bin/env node
/**
 * generate-cashflow.js — 生成 2026 H1（1-6 月）180 天模拟现金流 CSV
 * 字段: date, dept, category, inflow, outflow, txn_count
 * 6 部门 × 6 类别，含月度季节性 + 偶发大额支出
 */
const fs = require('fs');
const path = require('path');

const DEPTS = ['销售', '市场', '研发', '人力资源', '财务', '运营'];
const CATS = ['收入', '人力成本', '办公租赁', '市场营销', '技术采购', '其他'];

// 月度季节性系数（1月春节偏静，3月开年冲刺，6月年中结算）
const MONTH_SEASON = [0.85, 0.75, 1.15, 1.0, 1.1, 1.3];
// 各类别基础日均流量基准（万元）
const CAT_BASE = {
  收入:     { inflow: 42, outflow: 2 },
  人力成本: { inflow: 0,  outflow: 35 },
  办公租赁: { inflow: 0,  outflow: 8 },
  市场营销: { inflow: 0,  outflow: 12 },
  技术采购: { inflow: 0,  outflow: 6 },
  其他:     { inflow: 3,  outflow: 9 },
};
const DEPT_WEIGHT = { 销售: 1.25, 市场: 1.0, 研发: 1.35, 人力资源: 0.7, 财务: 0.55, 运营: 1.0 };

function rand(min, max) { return min + Math.random() * (max - min); }
function round2(x) { return Math.round(x * 100) / 100; }

// 确定性伪随机（可复现）
let seed = 20260101;
function rnd() { seed = (seed * 48271) % 2147483647; return seed / 2147483647; }

const START = new Date(Date.UTC(2026, 0, 1));
const DAYS = 180; // 2026-01-01 ~ 2026-06-30
const rows = [];

for (let d = 0; d < DAYS; d++) {
  const date = new Date(START.getTime() + d * 86400000);
  const mIdx = date.getUTCMonth();          // 0-5
  const season = MONTH_SEASON[mIdx];
  const isWeekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const weekendF = isWeekend ? 0.45 : 1.0;
  const ds = date.toISOString().slice(0, 10);

  for (const dept of DEPTS) {
    const w = DEPT_WEIGHT[dept];
    for (const cat of CATS) {
      const base = CAT_BASE[cat];
      let inflow = base.inflow * w * season * weekendF * rand(0.7, 1.3);
      let outflow = base.outflow * w * season * weekendF * rand(0.7, 1.3);

      // 部门-类别相关性：销售/市场多产生收入与营销支出，研发多技术采购
      if (cat === '收入' && !(dept === '销售' || dept === '运营')) inflow *= 0.3;
      if (cat === '市场营销' && !(dept === '市场' || dept === '销售')) outflow *= 0.3;
      if (cat === '人力成本' && dept === '人力资源') outflow *= 1.6;
      if (cat === '技术采购' && !(dept === '研发' || dept === '运营')) outflow *= 0.3;

      // 偶发大额支出（约 4% 概率）：设备/合同/并购类一次性支出
      let surge = 0;
      if (rnd() < 0.04) {
        surge = rand(30, 150) * (cat === '技术采购' ? 1.5 : 1.0);
        outflow += surge;
      }
      // 偶发大额收入（约 3% 概率）：大客户回款
      let bonus = 0;
      if (rnd() < 0.03 && cat === '收入') bonus = rand(20, 80);

      inflow = round2(inflow + bonus);
      outflow = round2(outflow + surge);
      const txn = Math.max(1, Math.round(rand(2, 40) * (isWeekend ? 0.3 : 1) + (surge > 0 ? 2 : 0)));

      if (inflow === 0 && outflow === 0) continue;
      rows.push([ds, dept, cat, inflow, outflow, txn].join(','));
    }
  }
}

const header = 'date,dept,category,inflow,outflow,txn_count';
const out = path.join(__dirname, 'cashflow-2026-h1.csv');
fs.writeFileSync(out, header + '\n' + rows.join('\n') + '\n', 'utf8');
console.log(`CSV 已生成: ${out}`);
console.log(`行数: ${rows.length}（不含表头），覆盖 ${DAYS} 天 / ${DEPTS.length} 部门 / ${CATS.length} 类别`);
