/**
 * v34 黄金实现核验：把 tests-tmp/v34-golden/<tN>/ 的交付物与已播种的夹具一起
 * 复制到**临时目录**，在那里跑核验器。全部通过 = 核验器与参考实现自洽
 * （模型开跑前的最后一道门）。
 *
 * 用法：node scripts/test-v34-golden.mjs [--keep]
 *   --keep  保留临时目录（诊断用；默认清理）
 *
 * ★ 2026-11-26（v34 run2 实证）：旧实现把黄金交付物**复制进真实任务目录**
 *   `data/workspace/v34-tN/`，跑完再删掉自己复制的文件。两个后果：
 *     1. 覆盖模型已经交付的同名文件（黄金门是开跑前的门，但也可以事后跑）；
 *     2. 删除时连带把**模型产物**删了（run2 后跑黄金门，10 个任务的交付物
 *        全被抹掉，无法再复核）。自检工具绝不能破坏被检对象。
 *   现在全程在 `/tmp/v34-golden-*` 沙箱里进行，只读真实任务目录。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FIXTURE_HASHES, frozenCheck, hashFile } from './v14/lib.mjs';
import { D, seed, saveFixtureHashes, selfCheck, crossCheck, t3GroundTruth, T3_BAD_STEP } from './test-v34-lib.mjs';
import { tasks } from './test-v34-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(__dirname, '../tests-tmp/v34-golden');

const bad = [...selfCheck(), ...crossCheck()];
if (bad.length) { console.error('FATAL 自校准失败: ' + bad.join('; ')); process.exit(2); }

// 夹具：写进真实任务目录（后续真实运行需要它们），黄金门只读复制。
seed();
saveFixtureHashes();

const keep = process.argv.includes('--keep');
const results = [];
for (const task of tasks) {
  const g = path.join(GOLDEN, `t${task.id}`);
  const realDir = task.dir;
  const sandbox = fs.mkdtempSync(`/tmp/v34-golden-t${task.id}-`);
  const dir = path.join(sandbox, 'work');
  // 1) 夹具整树复制（含 T3 的 repo/、T5 的 scan/ 等非 frozen 但必需的目录）
  fs.cpSync(realDir, dir, { recursive: true, force: true });
  // 2) 黄金交付物覆盖上去（不覆盖夹具：frozen 用相对路径比较，
  //    T1 的 legacy/report_gen.py 不应挡住顶层 report_gen.py）
  const frozen = new Set(task.frozen || []);
  for (const name of fs.readdirSync(g)) {
    if (frozen.has(name)) continue;
    const src = path.join(g, name);
    const dst = path.join(dir, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
    else fs.copyFileSync(src, dst);
  }
  // 3) frozen 哈希按**沙箱路径**重新登记：frozenCheck 按绝对路径查表，
  //    复制后路径变了。真实目录里的条目保持不动。
  for (const rel of frozen) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) FIXTURE_HASHES.set(p, hashFile(p));
  }
  // 4) 指向沙箱后跑与真实运行**同一条**校验路径
  const prevDir = task.dir;
  task.dir = dir;
  try {
    // T3 需真实生成 report.json（黄金实现里没有）
    if (task.id === 3) {
      const gt = t3GroundTruth(path.join(dir, 'repo'), 'step', T3_BAD_STEP);
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(gt, null, 2));
    }
    // T5 需真实生成 report.json（CLI 只打印 JSON）
    if (task.id === 5) {
      const { execSync } = await import('child_process');
      const out = execSync('python3 scan.py scan 2>/dev/null; true', { cwd: dir, encoding: 'utf8' }).toString().trim();
      fs.writeFileSync(path.join(dir, 'report.json'), out + '\n');
    }
    // T10 需真实产物（build.py 会自建 out/）
    if (task.id === 10) {
      const { execSync } = await import('child_process');
      try {
        execSync('python3 build.py build build.json >/dev/null 2>&1', { cwd: dir, timeout: 60000 });
      } catch { /* 由核验器报告 */ }
    }
    let verdict;
    try { verdict = await task.exec(dir); }
    catch (e) { verdict = { ok: false, detail: 'exec 异常: ' + String((e && e.message) || e).slice(0, 300) }; }
    // ★ v34 run1 教训：黄金实现只调 task.exec，绕过了 frozenCheck，于是
    //   「frozen 哈希算法不一致 → 所有冻结文件判改动」这类校验器缺陷永远
    //   不会在开跑前暴露。黄金门必须走与真实运行**同一条**校验路径。
    if (verdict.ok) {
      const fz = frozenCheck(task);
      if (!fz.ok) verdict = { ok: false, detail: `frozen 校验与真实运行不一致: ${fz.detail}` };
    }
    results.push({ id: task.id, name: task.name, ...verdict });
    console.log(`${verdict.ok ? '✅' : '❌'} T${task.id} ${task.name}`);
    console.log(`   ${verdict.detail}`);
  } finally {
    task.dir = prevDir;
    for (const rel of frozen) FIXTURE_HASHES.delete(path.join(dir, rel));
    if (!keep) fs.rmSync(sandbox, { recursive: true, force: true });
    else console.log(`   （沙箱保留：${sandbox}）`);
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\nGOLDEN: ${pass}/${results.length} 通过`);
if (!keep) console.log('（沙箱已清理；真实任务目录未被写入或删除）');
process.exit(pass === results.length ? 0 : 1);
