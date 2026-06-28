import { describe, it, expect, beforeEach } from "vitest";
import {
  StabilityMonitor,
  DEFAULT_STABILITY_CONFIG,
  type StabilityConfig,
} from "./diagnostic-stability";

describe("StabilityMonitor", () => {
  let monitor: StabilityMonitor;

  beforeEach(() => {
    monitor = new StabilityMonitor();
  });

  describe("frequent-retry 检测", () => {
    it("窗口内重试 >= threshold 应触发 frequent-retry", () => {
      monitor.recordRetry("session-1");
      monitor.recordRetry("session-1");
      monitor.recordRetry("session-1");
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("frequent-retry");
      expect(result.severity).toBe("warning");
      expect(result.evidence.retryCount).toBe(3);
    });

    it("recordRetry 应使用自定义时间戳", () => {
      const now = new Date();
      const old = new Date(now.getTime() - 120_000); // 120s 前
      monitor.recordRetry("session-1", old);
      monitor.recordRetry("session-1", old);
      // 当前时间窗口内无重试
      const result = monitor.assess("session-1", now);
      expect(result.issue).toBe("none");
    });
  });

  describe("phase-flapping 检测", () => {
    it("A→B→A→B 应触发 phase-flapping", () => {
      monitor.recordPhaseTransition("session-1", "init");
      monitor.recordPhaseTransition("session-1", "auth");
      monitor.recordPhaseTransition("session-1", "init");
      monitor.recordPhaseTransition("session-1", "auth");
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("phase-flapping");
      expect(result.severity).toBe("warning");
      expect(result.evidence.transitions).toBe(4);
    });

    it("线性阶段切换不应触发 phase-flapping", () => {
      monitor.recordPhaseTransition("session-1", "init");
      monitor.recordPhaseTransition("session-1", "auth");
      monitor.recordPhaseTransition("session-1", "llm-call");
      monitor.recordPhaseTransition("session-1", "reply");
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("none");
    });
  });

  describe("error-spike 检测", () => {
    it("错误率超阈值应触发 error-spike", () => {
      // 阈值 0.5；单次错误即触发（1/(1+1)=0.5 不超过，需 2 次）
      monitor.recordError("session-1", "error");
      monitor.recordError("session-1", "error");
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("error-spike");
      expect(result.severity).toBe("error");
      expect(result.evidence.errorCount).toBe(2);
      expect(result.evidence.errorRate).toBeGreaterThan(0.5);
    });

    it("单次错误不应触发 error-spike（0.5 不大于 0.5）", () => {
      monitor.recordError("session-1", "warning");
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("none");
    });
  });

  describe("stalled 检测", () => {
    it("任务超过阈值未完成应触发 stalled", () => {
      const config: Partial<StabilityConfig> = { stalledThresholdMs: 100 };
      const m = new StabilityMonitor(config);
      const oldStart = new Date(Date.now() - 500);
      m.recordStart("session-1", oldStart);
      const result = m.assess("session-1");
      expect(result.issue).toBe("stalled");
      expect(result.severity).toBe("critical");
      expect(result.evidence.ageMs).toBeGreaterThanOrEqual(500);
    });

    it("任务未超阈值不应触发 stalled", () => {
      const config: Partial<StabilityConfig> = { stalledThresholdMs: 60_000 };
      const m = new StabilityMonitor(config);
      m.recordStart("session-1");
      const result = m.assess("session-1");
      expect(result.issue).toBe("none");
    });
  });

  describe("resource-spike 检测", () => {
    it("资源增长超过比例阈值应触发 resource-spike", () => {
      const config: Partial<StabilityConfig> = { resourceSpikeRatio: 2.0 };
      const m = new StabilityMonitor(config);
      m.recordResourceUsage("session-1", "rss", 100_000_000);
      m.recordResourceUsage("session-1", "rss", 250_000_000);
      const result = m.assess("session-1");
      expect(result.issue).toBe("resource-spike");
      expect(result.severity).toBe("warning");
      expect(result.evidence.metric).toBe("rss");
      expect(result.evidence.baseline).toBe(100_000_000);
      expect(result.evidence.current).toBe(250_000_000);
      expect(result.evidence.ratio).toBe(2.5);
    });

    it("首次记录应作为基线", () => {
      monitor.recordResourceUsage("session-1", "rss", 100);
      // 检查内部基线是否设置（通过 assess 间接验证）
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("none");
    });
  });

  describe("assessAll", () => {
    it("应批量评估所有跟踪中的实体", () => {
      monitor.recordRetry("session-1");
      monitor.recordRetry("session-1");
      monitor.recordRetry("session-1");
      monitor.recordError("session-2", "error");
      monitor.recordError("session-2", "error");

      const results = monitor.assessAll();
      expect(results).toHaveLength(2);
      const issues = results.map((r) => r.issue).sort();
      expect(issues).toEqual(["error-spike", "frequent-retry"]);
    });

    it("无问题时应返回空数组", () => {
      monitor.recordRetry("session-1");
      expect(monitor.assessAll()).toEqual([]);
    });
  });

  describe("prune", () => {
    it("应清理过期的重试与错误记录", () => {
      const config: Partial<StabilityConfig> = {
        retryWindowMs: 100,
        errorRateWindowMs: 100,
      };
      const m = new StabilityMonitor(config);
      const now = new Date();
      const old = new Date(now.getTime() - 500);
      m.recordRetry("session-1", old);
      m.recordError("session-1", "error", old);
      const removed = m.prune(now);
      expect(removed).toBe(2);
      const result = m.assess("session-1", now);
      expect(result.issue).toBe("none");
    });

    it("未过期的记录应保留", () => {
      monitor.recordRetry("session-1");
      monitor.recordRetry("session-1");
      monitor.recordRetry("session-1");
      const removed = monitor.prune();
      expect(removed).toBe(0);
      expect(monitor.assess("session-1").issue).toBe("frequent-retry");
    });
  });

  describe("clear", () => {
    it("应清空所有跟踪数据", () => {
      monitor.recordRetry("session-1");
      monitor.recordError("session-1", "error");
      monitor.recordPhaseTransition("session-1", "init");
      monitor.recordStart("session-1");
      monitor.recordResourceUsage("session-1", "rss", 100);

      monitor.clear();
      expect(monitor.assessAll()).toEqual([]);
    });
  });

  describe("recordError", () => {
    it("应支持 warning / error / critical 三种严重度", () => {
      monitor.recordError("session-1", "warning");
      monitor.recordError("session-1", "error");
      monitor.recordError("session-1", "critical");
      // 三次错误均触发 error-spike
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("error-spike");
      const severities = result.evidence.severities as string[];
      expect(severities).toEqual(["warning", "error", "critical"]);
    });
  });

  describe("配置", () => {
    it("DEFAULT_STABILITY_CONFIG 应有合理默认值", () => {
      expect(DEFAULT_STABILITY_CONFIG.retryWindowMs).toBe(60_000);
      expect(DEFAULT_STABILITY_CONFIG.retryThreshold).toBe(3);
      expect(DEFAULT_STABILITY_CONFIG.phaseFlapCount).toBe(4);
      expect(DEFAULT_STABILITY_CONFIG.errorRateThreshold).toBe(0.5);
      expect(DEFAULT_STABILITY_CONFIG.stalledThresholdMs).toBe(30 * 60_000);
      expect(DEFAULT_STABILITY_CONFIG.resourceSpikeRatio).toBe(2.0);
    });

    it("应支持自定义配置", () => {
      const m = new StabilityMonitor({
        retryThreshold: 5,
        errorRateThreshold: 0.9,
      });
      const config = m.getConfig();
      expect(config.retryThreshold).toBe(5);
      expect(config.errorRateThreshold).toBe(0.9);
      // 未指定的应使用默认值
      expect(config.retryWindowMs).toBe(60_000);
    });

    it("getConfig 应返回配置拷贝", () => {
      const config = monitor.getConfig();
      config.retryThreshold = 999;
      // 修改返回值不应影响内部配置
      expect(monitor.getConfig().retryThreshold).toBe(3);
    });
  });

  describe("recordResourceUsage", () => {
    it("应支持多个不同 metric 同时跟踪", () => {
      monitor.recordResourceUsage("session-1", "rss", 100);
      monitor.recordResourceUsage("session-1", "heap", 50);
      monitor.recordResourceUsage("session-1", "rss", 250);
      // rss 触发 resource-spike
      const result = monitor.assess("session-1");
      expect(result.issue).toBe("resource-spike");
      expect(result.evidence.metric).toBe("rss");
    });

    it("应限制每个 metric 的样本数（>100 时丢弃最旧）", () => {
      // 记录 110 个样本
      for (let i = 0; i < 110; i++) {
        monitor.recordResourceUsage("session-1", "rss", i);
      }
      // 增长比例不超阈值（基线 0，最新 109；但基线 0 时跳过）
      const result = monitor.assess("session-1");
      // 基线为 0 时跳过检测，应返回 none
      expect(result.issue).toBe("none");
    });
  });

  describe("无数据实体", () => {
    it("assess 应返回 none", () => {
      const result = monitor.assess("nonexistent");
      expect(result.issue).toBe("none");
      expect(result.severity).toBe("info");
    });
  });
});
