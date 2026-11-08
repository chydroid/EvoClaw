#!/usr/bin/env node
/**
 * 生成 2026 H1（1-6月，180天）模拟现金流数据
 * 输出: cashflow-h1.csv
 */
const fs = require('fs');
const path = require('path');

// 5 个部门
const depts = ['Engineering', 'Marketing', 'Sales', 'Operations', 'HR'];
// 6 个类别
const categories = ['Revenue', 'Payroll', 'Vendor', 'Marketing', 'Facilities', 'R&D'];

// 每部门每类别的基础日均值（元）
const base = {
  Engineering: { Revenue: 0, Payroll: 3800, Vendor: 1200, Marketing: 0, Facilities: 400, 'R&D': 1500 },
  Marketing:   { Revenue: 0, Payroll: 1800, Vendor: 300, Marketing: 2500, Facilities: 200, 'R&D': 0 },
  Sales:       { Revenue: 4200, Payroll: 2200, Vendor: 800, Marketing: 900, Facilities: 250, 'R&D': 0 },
  Operations:  { Revenue: 3500, Payroll: 2600, Vendor: 3200, Marketing: 100, Facilities: 3800, 'R&D': 0 },
  HR:          { Revenue: 0, Payroll: 1500, Vendor: 250, Marketing: 0, Facilities: 180, 'R&D': 0 },
};

// 月度季节性系数（1-6月）
const seasonal = { 1: 0.92, 2: 0.85, 3: 1.0, 4: 1.05, 5: 1.15, 6: 1.1 };

// 确定性伪随机（避免依赖 Math.random 使结果可复现）
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gauss() { // 近似正态 (0,1)
  return (rand() + rand() + rand() + rand() - 2) / 2;
}

const rows = [];
// 大额支出事件表（触发偶发大额支出）
const spikes = [
  { date: '2026-01-20', dept: 'Engineering', category: 'Vendor', amt: 185000, note: '服务器集群扩容' },
  { date: '2026-02-14', dept: 'Marketing', category: 'Marketing', amt: 95000, note: '春节营销投放' },
  { date: '2026-03-12', dept: 'Operations', category: 'Facilities', amt: 78000, note: '设备维修' },
  { date: '2026-04-08', dept: 'Engineering', category: 'R&D', amt: 150000, note: '新系统研发外包' },
  { date: '2026-05-20', dept: 'Sales', category: 'Marketing', amt: 88000, note: '行业大会参展' },
  { date: '2026-06-15', dept: 'Operations', category: 'Vendor', amt: 210000, note: '年度供应链补货' },
];
const spikeMap = {};
for (const s of spikes) spikeMap[s.date + '|' + s.dept + '|' + s.category] = s.amt;

const start = new Date('2026-01-01');
let day = 0;
for (; day < 180; day++) {
  const d = new Date(start.getTime() + day * 86400000);
  const dateStr = d.toISOString().slice(0, 10);
  const month = d.getMonth() + 1;
  const coef = seasonal[month];
  // 周六日：工资/研发照常发，收入与部分支出减少
  const dow = d.getDay(); // 0=Sun
  const isWeekend = dow === 0 || dow === 6;
  const dayCoef = isWeekend ? 0.4 : 1.0;

  for (const dept of depts) {
    for (const cat of categories) {
      const b = base[dept][cat];
      if (b === 0 && !(cat === 'Revenue' && dept === 'HR')) continue; // 仅 Sales/Operations 有收入
      let val = 0;
      // 基础部分
      const basePart = b * coef * dayCoef * (1 + gauss() * 0.18);
      val = Math.max(0, basePart);
      const inflow = cat === 'Revenue' ? val : 0;
      let outflow = cat === 'Revenue' ? 0 : val;
      // 大额事件叠加
      const key = dateStr + '|' + dept + '|' + cat;
      let txn = Math.max(1, Math.round(outflow / 800 + inflow / 2000 + rand() * 3));
      if (spikeMap[key]) {
        outflow += spikeMap[key];
        txn += 1;
      }
      // Sales 部门收入周末略减少
      rows.push([dateStr, dept, cat, inflow.toFixed(0), outflow.toFixed(0), txn].join(','));
    }
  }
}

const out = path.join(__dirname, 'cashflow-h1.csv');
fs.writeFileSync(out, 'date,dept,category,inflow,outflow,txn_count\n' + rows.join('\n') + '\n');
console.log(`Wrote ${rows.length} rows to ${out}`);
