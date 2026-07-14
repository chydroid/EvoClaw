/**
 * 原子写入工具（同步版）。
 * 遵循项目硬约束：temp + fsync + rename，崩溃时不会产生截断文件。
 * 跨设备（EXDEV/EBUSY）时回退到目标侧 temp + fsync + rename，保持原子性。
 * 保留原文件权限位；临时文件名包含 pid + 随机后缀，避免并发冲突。
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

function makeTempPath(targetPath: string): string {
  return `${targetPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
}

function tryUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function tryChmodFrom(tempPath: string, targetPath: string): void {
  try {
    if (fs.existsSync(targetPath)) {
      const st = fs.statSync(targetPath);
      fs.chmodSync(tempPath, st.mode);
    }
  } catch { /* ignore */ }
}

function writeAndFsyncSync(fd: number, content: string | Buffer, encoding?: BufferEncoding): void {
  fs.writeFileSync(fd, content, encoding ?? "utf-8");
  fs.fsyncSync(fd);
}

/**
 * 原子地将内容写入 targetPath。
 * 若目标目录不存在则自动创建。
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = makeTempPath(targetPath);
  const fd = typeof options.mode === "number"
    ? fs.openSync(tmpPath, "w", options.mode)
    : fs.openSync(tmpPath, "w");
  try {
    writeAndFsyncSync(fd, content, options.encoding);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    tryUnlink(tmpPath);
    throw err;
  }
  fs.closeSync(fd);

  if (typeof options.mode !== "number") {
    tryChmodFrom(tmpPath, targetPath);
  }

  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EBUSY") {
      // 跨设备回退：在目标目录创建临时文件并 rename，再清理源临时文件
      const dstDir = path.dirname(targetPath);
      const dstTmp = path.join(dstDir, `.${path.basename(targetPath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
      const contentBuf = typeof content === "string"
        ? Buffer.from(content, options.encoding ?? "utf-8")
        : content;
      const fd2 = typeof options.mode === "number"
        ? fs.openSync(dstTmp, "w", options.mode)
        : fs.openSync(dstTmp, "w");
      try {
        fs.writeFileSync(fd2, contentBuf);
        fs.fsyncSync(fd2);
      } catch (werr) {
        try { fs.closeSync(fd2); } catch { /* ignore */ }
        tryUnlink(dstTmp);
        tryUnlink(tmpPath);
        throw werr;
      }
      fs.closeSync(fd2);
      if (typeof options.mode !== "number") {
        tryChmodFrom(dstTmp, targetPath);
      }
      try {
        fs.renameSync(dstTmp, targetPath);
      } catch (rerr) {
        tryUnlink(dstTmp);
        tryUnlink(tmpPath);
        throw rerr;
      }
      tryUnlink(tmpPath);
    } else {
      tryUnlink(tmpPath);
      throw err;
    }
  }
}

/**
 * 原子替换：将 src 替换为 dst。
 * 如果 dst 是符号链接，解析 realpath 后原地替换，保留符号链接。
 * 跨设备时回退到目标侧 temp + fsync + rename。
 */
export function atomicReplaceSync(src: string, dst: string): void {
  let realDst = dst;
  try {
    const st = fs.lstatSync(dst);
    if (st.isSymbolicLink()) {
      realDst = fs.realpathSync(dst);
    }
  } catch {
    // dst 不存在，直接使用 dst
  }

  try {
    fs.renameSync(src, realDst);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EBUSY") {
      const dstDir = path.dirname(realDst);
      const dstTmp = path.join(dstDir, `.${path.basename(realDst)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
      const content = fs.readFileSync(src);
      const fd = fs.openSync(dstTmp, "w");
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } catch (werr) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        tryUnlink(dstTmp);
        tryUnlink(src);
        throw werr;
      }
      fs.closeSync(fd);
      tryChmodFrom(dstTmp, realDst);
      try {
        fs.renameSync(dstTmp, realDst);
      } catch (rerr) {
        tryUnlink(dstTmp);
        tryUnlink(src);
        throw rerr;
      }
      tryUnlink(src);
    } else {
      throw err;
    }
  }
}
