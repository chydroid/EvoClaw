/**
 * 同步原子写入工具：temp + fsync + rename，防止崩溃时文件被截断。
 *
 * 跨设备（EXDEV/EBUSY）时回退到 目标侧 temp + fsync + rename。
 * 临时文件名包含 pid + 随机后缀，避免同进程并发写入同一目标时冲突。
 *
 * 灵感来自 hermes-agent 的 utils.py atomic_json_write/atomic_replace。
 */
import * as fs from "fs";
import * as path from "path";

export function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);
  try {
    if (fs.existsSync(targetPath)) {
      const st = fs.statSync(targetPath);
      fs.chmodSync(tmpPath, st.mode);
    }
  } catch { /* ignore */ }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EBUSY") {
      // 跨设备回退：在目标侧写临时文件后 rename
      const dstTmp = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.dst.tmp`;
      const fd2 = fs.openSync(dstTmp, "w");
      try {
        fs.writeFileSync(fd2, content, "utf-8");
        fs.fsyncSync(fd2);
      } catch (w2err) {
        try { fs.closeSync(fd2); } catch { /* ignore */ }
        try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw w2err;
      }
      fs.closeSync(fd2);
      // 安全：EXDEV 回退的 rename 失败必须抛出，否则临时文件泄漏且静默数据丢失
      try {
        fs.renameSync(dstTmp, targetPath);
      } catch (renameErr) {
        try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw renameErr;
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}
