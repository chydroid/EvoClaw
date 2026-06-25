import { type ActorMessage, type ActorRef } from "@evoclaw/core";

interface Actor {
  id: string;
  ref: ActorRef;
  state: unknown;
  behavior: (message: ActorMessage, state: unknown) => Promise<{ newState: unknown; response?: unknown }>;
}

export class ActorSystem {
  private actors = new Map<string, Actor>();
  private mailboxes = new Map<string, ActorMessage[]>();
  private processing = new Set<string>();

  spawn<T>(
    id: string,
    initialState: T,
    behavior: (message: ActorMessage, state: T) => Promise<{ newState: T; response?: unknown }>
  ): ActorRef {
    if (this.actors.has(id)) {
      throw new Error(`Actor "${id}" already exists`);
    }

    const actor: Actor = {
      id,
      ref: this.createActorRef(id),
      state: initialState,
      behavior: behavior as (message: ActorMessage, state: unknown) => Promise<{ newState: unknown; response?: unknown }>,
    };

    this.actors.set(id, actor);
    this.mailboxes.set(id, []);

    return actor.ref;
  }

  private createActorRef(id: string): ActorRef {
    return {
      // send 为 fire-and-forget：仅入队邮箱并触发处理，不阻塞发送方。
      // processMessages 内部已有 processing 守卫防止并发重入，并通过 while
      // 循环迭代处理整个邮箱（非递归，无栈溢出风险）。
      send: async (message: ActorMessage) => {
        const mailbox = this.mailboxes.get(id);
        if (mailbox) {
          mailbox.push(message);
          // 非阻塞触发消息处理；错误在 processMessages 内部已捕获。
          void this.processMessages(id).catch((err) => {
            process.stderr.write(`[ActorSystem] Unexpected error processing messages for "${id}":` + " " + err);
          });
        }
      },

      ask: async (message: ActorMessage): Promise<ActorMessage> => {
        const actor = this.actors.get(id);
        if (!actor) throw new Error(`Actor "${id}" not found`);

        const result = await actor.behavior(message, actor.state);
        const { newState, response } = result;

        this.actors.set(id, { ...actor, state: newState });

        return {
          type: "response",
          sender: id,
          recipient: message.sender,
          payload: response,
          correlationId: message.correlationId || "",
          timestamp: new Date(),
        };
      },

      stop: async () => {
        this.actors.delete(id);
        this.mailboxes.delete(id);
      },
    };
  }

  private async processMessages(actorId: string): Promise<void> {
    if (this.processing.has(actorId)) return;
    this.processing.add(actorId);

    try {
      const actor = this.actors.get(actorId);
      const mailbox = this.mailboxes.get(actorId);
      if (!actor || !mailbox) return;

      while (mailbox.length > 0) {
        const message = mailbox.shift()!;
        try {
          const result = await actor.behavior(message, actor.state);
          actor.state = result.newState;
        } catch (err) {
          process.stderr.write(`[ActorSystem] Error processing message for "${actorId}":` + " " + err);
        }
      }
    } finally {
      this.processing.delete(actorId);
      // 重新检查邮箱：在循环退出后、finally 执行前若有新消息到达，
      // 新的 processMessages 调用会因 processing.has 为 true 而提前返回，
      // 导致该消息永久滞留。此处重新触发处理以避免消息丢失。
      const mailbox = this.mailboxes.get(actorId);
      if (mailbox && mailbox.length > 0) {
        void this.processMessages(actorId).catch(() => {});
      }
    }
  }

  getActor(id: string): Actor | undefined {
    return this.actors.get(id);
  }

  listActors(): string[] {
    return Array.from(this.actors.keys());
  }
}