import {
  ServiceRegistry,
  EventBus,
  type AnomalyDetection,
  type AnomalyIndicator,
  SystemEvents,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export class AnomalyDetector {
  private baseline = new Map<string, AnomalyIndicator>();
  private alerts: AnomalyDetection[] = [];

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.initializeBaselines();
  }

  private initializeBaselines(): void {
    this.baseline.set("task_failure_rate", {
      metric: "task_failure_rate",
      expectedValue: 0,
      actualValue: 0,
      deviation: 0,
      threshold: 0.5,
    });

    this.baseline.set("response_time", {
      metric: "response_time",
      expectedValue: 1000,
      actualValue: 0,
      deviation: 0,
      threshold: 5000,
    });

    this.baseline.set("error_spike", {
      metric: "error_spike",
      expectedValue: 0,
      actualValue: 0,
      deviation: 0,
      threshold: 10,
    });
  }

  async detect(
    metric: string,
    actualValue: number,
    context?: Record<string, unknown>
  ): Promise<AnomalyDetection | null> {
    const baseline = this.baseline.get(metric);
    if (!baseline) return null;

    baseline.actualValue = actualValue;
    baseline.deviation = Math.abs(actualValue - baseline.expectedValue);

    if (baseline.deviation > baseline.threshold) {
      const alert: AnomalyDetection = {
        id: uuid(),
        type: metric,
        severity: baseline.deviation > baseline.threshold * 2 ? "critical" : "warning",
        source: "anomaly-detector",
        description: `${metric} deviated from baseline: ${baseline.deviation.toFixed(2)}`,
        detectedAt: new Date(),
        indicators: [baseline],
        suggestedAction: "Review system metrics and investigate the spike",
        autoResolved: false,
      };

      this.alerts.push(alert);
      if (this.alerts.length > 1000) {
        this.alerts = this.alerts.slice(-500);
      }

      await this.eventBus.publish(
        SystemEvents.SECURITY_ALERT,
        { alert, context },
        "anomaly-detector"
      );

      return alert;
    }

    return null;
  }

  getAlerts(): AnomalyDetection[] {
    return this.alerts;
  }

  resolve(alertId: string): void {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.autoResolved = true;
    }
  }

  clearAlerts(): void {
    this.alerts = [];
  }
}