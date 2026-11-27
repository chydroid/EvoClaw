/**
 * v35 黄金实现核验：把 tests-tmp/v35-golden/<tN>/ 的交付物与已播种的夹具一起
 * 复制到**临时目录**，在那里跑核验器。全部通过 = 核验器与参考实现自洽
 * （模型开跑前的最后一道门）。
 *
 * 用法：node scripts/test-v35-golden.mjs [--keep]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FIXTURE_HASHES, frozenCheck, hashFile } from './v14/lib.mjs';
import { D, seed, saveFixtureHashes, selfCheck, crossCheck } from './test-v35-lib.mjs';
import { tasks } from './test-v35-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(__dirname, '../tests-tmp/v35-golden');

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
  const sandbox = fs.mkdtempSync(`/tmp/v35-golden-t${task.id}-`);
  const dir = path.join(sandbox, 'work');
  fs.cpSync(realDir, dir, { recursive: true, force: true });
  const frozen = new Set(task.frozen || []);
  for (const name of fs.readdirSync(g)) {
    if (frozen.has(name)) continue;
    const src = path.join(g, name);
    const dst = path.join(dir, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
    else fs.copyFileSync(src, dst);
  }
  for (const rel of frozen) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) FIXTURE_HASHES.set(p, hashFile(p));
  }
  const prevDir = task.dir;
  task.dir = dir;
  try {
    let verdict;
    try { verdict = await task.exec(dir); }
    catch (e) { verdict = { ok: false, detail: 'exec 异常: ' + String((e && e.message) || e).slice(0, 300) }; }
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
