import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

interface QueueMessage {
  id: string;
  topic: string;
  payload: unknown;
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
  /** 下一次允许重试的时间戳（毫秒），用于指数退避 */
  nextRetryAt?: number;
}

type MessageHandler = (message: QueueMessage) => Promise<void>;

export class MessageQueue {
  private topics = new Map<string, QueueMessage[]>();
  private handlers = new Map<string, MessageHandler[]>();
  private processingTopics = new Set<string>();
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly maxTopics = 1024;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("messageQueue", this);
  }

  async publish(topic: string, payload: unknown): Promise<string> {
    const message: QueueMessage = {
      id: uuid(),
      topic,
      payload,
      timestamp: new Date(),
      retryCount: 0,
      maxRetries: 3,
    };

    if (!this.topics.has(topic)) {
      if (this.topics.size >= this.maxTopics) {
        throw new Error(`Topic limit (${this.maxTopics}) exceeded, cannot create topic: ${topic}`);
      }
      this.topics.set(topic, []);
    }
    this.topics.get(topic)!.push(message);

    this.processTopic(topic);

    return message.id;
  }

  subscribe(topic: string, handler: MessageHandler): void {
    if (!this.handlers.has(topic)) {
      if (this.handlers.size >= this.maxTopics) {
        throw new Error(`Handler topic limit (${this.maxTopics}) exceeded, cannot subscribe to: ${topic}`);
      }
      this.handlers.set(topic, []);
    }
    this.handlers.get(topic)!.push(handler);
  }

  private async processTopic(topic: string): Promise<void> {
    if (this.processingTopics.has(topic)) return;
    this.processingTopics.add(topic);

    try {
      const messages = this.topics.get(topic);
      const handlers = this.handlers.get(topic);
      if (!messages || !handlers) return;

      let backoffSkipped = 0;
      while (messages.length > 0) {
        const message = messages.shift()!;

        // 指数退避：未到重试时间的消息放回队列尾部，继续处理后续消息
        if (message.nextRetryAt && Date.now() < message.nextRetryAt) {
          messages.push(message);
          // 调度退避结束后重新处理该 topic，避免消息永久滞留
          const delay = message.nextRetryAt - Date.now();
          const timer = setTimeout(() => { this.pendingTimers.delete(timer); this.processTopic(topic); }, delay);
          this.pendingTimers.add(timer);
          if (timer.unref) timer.unref();
          backoffSkipped++;
          // 所有剩余消息都在退避中，等待定时器触发
          if (backoffSkipped >= messages.length) break;
          continue;
        }
        backoffSkipped = 0;

        for (const handler of handlers) {
          try {
            await handler(message);
          } catch (err) {
            process.stderr.write(`[MessageQueue] Handler error for "${topic}": ${err instanceof Error ? err.message : String(err)}\n`);

            if (message.retryCount < message.maxRetries) {
              message.retryCount++;
              // 指数退避：2^retryCount 秒后重试
              message.nextRetryAt = Date.now() + Math.pow(2, message.retryCount) * 1000;
              messages.push(message);
            } else {
              // 重试耗尽：记录告警，避免消息被静默丢弃
              process.stderr.write(`[MessageQueue] Message "${message.topic}" dropped after ${message.maxRetries} retries\n`);
            }
            // 使用 continue 而非 break，确保同一 topic 的后续 handler 仍有机会处理该消息
            continue;
          }
        }
      }
    } finally {
      this.processingTopics.delete(topic);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** 清理所有 pending 退避定时器 */
  dispose(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }
}