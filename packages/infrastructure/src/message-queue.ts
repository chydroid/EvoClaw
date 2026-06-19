import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

interface QueueMessage {
  id: string;
  topic: string;
  payload: unknown;
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
}

type MessageHandler = (message: QueueMessage) => Promise<void>;

export class MessageQueue {
  private topics = new Map<string, QueueMessage[]>();
  private handlers = new Map<string, MessageHandler[]>();
  private processing = false;

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
      this.topics.set(topic, []);
    }
    this.topics.get(topic)!.push(message);

    this.processTopic(topic);

    return message.id;
  }

  subscribe(topic: string, handler: MessageHandler): void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, []);
    }
    this.handlers.get(topic)!.push(handler);
  }

  private async processTopic(topic: string): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const messages = this.topics.get(topic);
      const handlers = this.handlers.get(topic);
      if (!messages || !handlers) return;

      while (messages.length > 0) {
        const message = messages.shift()!;

        for (const handler of handlers) {
          try {
            await handler(message);
          } catch (err) {
            process.stderr.write(`[MessageQueue] Handler error for "${topic}": ${err instanceof Error ? err.message : String(err)}\n`);

            if (message.retryCount < message.maxRetries) {
              message.retryCount++;
              messages.push(message);
            }
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}