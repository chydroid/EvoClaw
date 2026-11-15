/**
 * Enhancement runtime — 增强能力模块的进程级单例。
 *
 * 这些模块此前只有类定义与 stats 端点占位响应，**没有真正接线**：
 * 工具执行路径从不记录质量/参数校正数据，页面因此长期显示"未就绪"。
 * 这里集中持有单例，避免 llm-caller / executor / gateway 各自 new 一份。
 */

import { ToolQualityManager } from "./tool-quality-manager";

/** 工具质量跟踪（记录每次工具执行的成功/失败/耗时）。 */
export const toolQualityManager = new ToolQualityManager();
