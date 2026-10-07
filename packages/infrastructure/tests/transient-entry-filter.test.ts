import { describe, it, expect } from "vitest";
import { isTransientEntryName } from "../src/filesystem-manager";

/**
 * 回归：目录列举必须过滤编辑器/Office 临时文件。
 *
 * 真实事故（2026-10-07 15:3x）：worktemp 目录里有一个
 * `~$月6日信阳市文旅系统明查暗访情况汇总.docx`（Word 打开文档时生成的 162 字节锁文件）。
 * 模型把它当成一个待转换的真实文档：
 *  - 把它塞进批量转换队列 → 必然失败（格式不完整）
 *  - 汇报口径变成"共 16 个文件"，实际真实文档只有 14 个
 */
describe("isTransientEntryName — Office/编辑器临时文件过滤", () => {
  it("★ Word 锁文件（~$ 前缀）必须被识别", () => {
    expect(isTransientEntryName("~$月6日信阳市文旅系统明查暗访情况汇总.docx")).toBe(true);
    expect(isTransientEntryName("~$report.docx")).toBe(true);
  });

  it("★ LibreOffice 锁文件必须被识别", () => {
    expect(isTransientEntryName(".~lock.report.docx#")).toBe(true);
  });

  it("★ 常见系统/编辑器垃圾文件必须被识别", () => {
    for (const n of [".DS_Store", "Thumbs.db", "desktop.ini", ".hidden.tmp"]) {
      expect(isTransientEntryName(n), `${n} 应被过滤`).toBe(true);
    }
  });

  it("★ 真实文档绝不能被误伤（这是最关键的边界）", () => {
    for (const n of [
      "10.6 羊山新区文广旅局明查暗访发现问题隐患清单.docx",
      "国庆假期明查暗访发现问题隐患清单10.6.wps",
      "鸡公山管理区明查暗访发现问题隐患清单（报送模版）..docx6.docx",
      "我的总结.docx",
    ]) {
      expect(isTransientEntryName(n), `${n} 是真实文件，不该被过滤`).toBe(false);
    }
  });

  it("以 ~ 开头但不是 ~$ 的文件不误伤（Office 锁文件前缀是 ~$ 而非 ~）", () => {
    expect(isTransientEntryName("~备份文件.docx")).toBe(false);
    expect(isTransientEntryName("~temp")).toBe(false);
  });

  it("空名按无效条目跳过（防御性：readdir 不会返回空名，但万一如此也不该当文件处理）", () => {
    expect(isTransientEntryName("")).toBe(true);
    expect(isTransientEntryName("   ")).toBe(false);
  });
});