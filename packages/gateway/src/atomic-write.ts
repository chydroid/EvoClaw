/**
 * 同步原子写入工具：委托给 @evoclaw/core 的 atomicWriteFileSync。
 * 保持本模块原有导出，避免 gateway 内部调用方改动。
 */
import { atomicWriteFileSync } from "@evoclaw/core";

export { atomicWriteFileSync };
