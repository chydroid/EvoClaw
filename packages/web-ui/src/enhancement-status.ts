/**
 * 增强能力状态推导 — 纯函数，便于测试。
 *
 * 旧实现只有 active/inactive 二值，且只认 /api/system/services 的
 * "ok"/"healthy"/"online"，而 ServiceRegistry 实际返回 "running" ——
 * 于是 EnhancementHub 的 30 张卡片全部显示"未就绪"，连已接线能力也被误判。
 *
 * 现在按证据分级：
 *   active    → 服务已注册且 running，或指标端点明确 enabled/active/registered
 *   available → 模块可用（端点可达），但未注册为常驻服务 / 统计未接线
 *   inactive  → 端点明确报告未启用（enabled:false）
 *   unknown   → 既无服务状态也无指标端点，无法确认
 */

export type CapabilityState = "active" | "available" | "inactive" | "unknown";

/** 从服务注册表状态判定是否健康。ServiceStatus 见 core/types/plugin.ts。 */
export function isHealthyServiceStatus(status: unknown): boolean {
  return (
    status === "running" ||
    status === "ok" ||
    status === "healthy" ||
    status === "online" ||
    status === "started"
  );
}

/** 从指标端点响应推导能力状态。 */
export function deriveCapabilityState(
  registered: boolean | undefined,
  metrics: Record<string, unknown> | null,
): CapabilityState {
  if (metrics) {
    if (
      metrics.enabled === true ||
      metrics.active === true ||
      metrics.registered === true ||
      metrics.wired === true
    ) {
      return "active";
    }
    if (metrics.available === true) return "available";
    if (metrics.enabled === false || metrics.active === false || metrics.available === false) {
      return registered === true ? "active" : "inactive";
    }
    // 端点可达但没有状态标志：模块至少是可用的。
    return registered === true ? "active" : "available";
  }
  if (registered === true) return "active";
  if (registered === false) return "inactive";
  return "unknown";
}

/** 指标端的说明文案（比单纯字段数更有信息量）。 */
export function describeMetrics(
  state: CapabilityState,
  metrics: Record<string, unknown> | null,
): string | null {
  if (!metrics) return null;
  const note = typeof metrics.note === "string" ? metrics.note : "";
  if (note.includes("not yet instrumented")) {
    return metrics.wired === true ? "已接线 · 计数未细化" : "模块可用 · 统计未接线";
  }
  if (metrics.wired === true) return "已接线";
  if (state === "active" && typeof metrics.enabled === "boolean") {
    const count = Object.keys(metrics).filter((k) => k !== "enabled" && k !== "note").length;
    return count > 0 ? `${count} 项指标` : null;
  }
  if (state === "inactive") return "接口报告未启用";
  return null;
}
