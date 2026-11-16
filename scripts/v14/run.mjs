/**
 * 用法：node scripts/v14/run.mjs <1..6>
 * 环境变量 TASK_FILTER=9,10 可只跑指定任务 id。
 */
import { runRound } from './lib.mjs';

const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1 || n > 6) {
  console.error('用法: node scripts/v14/run.mjs <1..6>');
  process.exit(2);
}
const mod = await import(`./round${n}.mjs`);
await runRound(mod.default, mod.default.tasks);
