import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { randomUUID } from "crypto";

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
  private readonly maxMessagesPerTopic = 10000;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("messageQueue", this);
  }

  async publish(topic: string, payload: unknown): Promise<string> {
    const message: QueueMessage = {
      id: randomUUID(),
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
    const queue = this.topics.get(topic)!;
    queue.push(message);
    if (queue.length > this.maxMessagesPerTopic) {
      const dropped = queue.splice(0, queue.length - this.maxMessagesPerTopic);
      process.stderr.write(`[MessageQueue] Topic "${topic}" exceeded ${this.maxMessagesPerTopic} messages, dropped ${dropped.length} oldest\n`);
    }

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

  // 退避结束不直接重入 processTopic（MQ-1 修复）：原实现在定时器回调里
  // 直接 processTopic，与仍在跑的处理循环并发时同一 topic 会出现第二个
  // 实例，同一消息被两个循环先后 shift 出去投递（重复消费）。
  // 现改为：持锁期间计时器到点只置标记，由持锁循环在下一轮迭代消费
  // （对应消息的 nextRetryAt 必然已过期，直接放行）；锁已释放时计时器
  // 才允许重入 processTopic。
  private backoffFired = new Set<string>();
  private async processTopic(topic: string): Promise<void> {
    if (this.processingTopics.has(topic)) {
      // 循环仍持锁；到点的退避由循环内的检查点消费
      return;
    }
    this.processingTopics.add(topic);
    try {
      const messages = this.topics.get(topic);
      const handlers = this.handlers.get(topic);
      if (!messages || !handlers) return;

      let backoffSkipped = 0;
      while (messages.length > 0) {
        const message = messages.shift()!;
        // MQ-1：清除「退避已到期」标记（定时器在循环持锁期间触发时留下）。
        // 标记对应的消息其 nextRetryAt 必然已过期，落到下方时间判断直接放行，
        // 无需也不能重入 processTopic（锁仍在本循环手里）。
        if (this.backoffFired.has(topic)) this.backoffFired.delete(topic);

        // 指数退避：未到重试时间的消息放回队列尾部，继续处理后续消息
        if (message.nextRetryAt && Date.now() < message.nextRetryAt) {
          messages.push(message);
          // 调度退避结束仅置标记；若此刻循环正在跑，由循环内的检查点 break 后重入；
          // 若循环已结束（锁已释放），则按原设计直接重新处理，避免消息滞留。
          const delay = Math.max(0, message.nextRetryAt - Date.now());
          const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            if (this.processingTopics.has(topic)) {
              this.backoffFired.add(topic);
            } else {
              this.processTopic(topic).catch(() => {});
            }
          }, delay);
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
            // 使用 break 而非 continue：handler 失败后不再调用后续 handler，
            // 避免同一消息被部分 handler 成功处理后又在重试时被全部 handler 重复调用（破坏幂等性）
            break;
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
    this.backoffFired.clear();
  }
}