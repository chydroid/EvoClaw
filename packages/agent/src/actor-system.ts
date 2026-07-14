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
  /** 已 stop 的 actor id 集合。Bug 2.2 修复：behavior 是 async，
   *  stop() 后 behavior 仍可能在后台执行；用此集合让 processMessages
   *  在 behavior 完成后跳过状态更新与 resolver resolve。 */
  private stopped = new Set<string>();
  /** 每个 actor 当前正在执行的 message（如有）。Bug 2.1 修复：原 stop()
   *  仅遍历 mailbox，但 in-flight message 已被 shift 出 mailbox，其 resolver
   *  永远不会被 reject，导致 ask() 调用方永久挂起。 */
  private inflightMessages = new Map<string, ActorMessage>();
  /** ask() 入队消息的响应回调，按 ActorMessage 对象关联。
   *  processMessages 处理完该消息后 resolve；失败则 reject，避免调用方永久挂起。 */
  private askResolvers = new WeakMap<ActorMessage, { resolve: (msg: ActorMessage) => void; reject: (err: unknown) => void }>();

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
            process.stderr.write(`[ActorSystem] Unexpected error processing messages for "${id}":` + " " + err + "\n");
          });
        }
      },

      ask: async (message: ActorMessage): Promise<ActorMessage> => {
        const actor = this.actors.get(id);
        if (!actor) throw new Error(`Actor "${id}" not found`);
        const mailbox = this.mailboxes.get(id);
        if (!mailbox) throw new Error(`Mailbox for "${id}" not found`);

        // 将消息入队邮箱并通过 processMessages 统一处理，复用 processing 守卫，
        // 避免与 processMessages 并发执行 behavior 导致状态丢失（原实现直接调用
        // behavior 并 set 新 actor 对象，会覆盖 processMessages 正在进行的 state 变更）。
        const responsePromise = new Promise<ActorMessage>((resolve, reject) => {
          this.askResolvers.set(message, { resolve, reject });
        });

        mailbox.push(message);
        // 非阻塞触发消息处理；若 processMessages 整体失败（非单条 behavior 失败），
        // reject 对应的 ask 调用方，避免永久挂起。
        void this.processMessages(id).catch((err) => {
          const resolver = this.askResolvers.get(message);
          if (resolver) {
            this.askResolvers.delete(message);
            resolver.reject(err);
          }
        });

        return responsePromise;
      },

      stop: async () => {
        // 标记 actor 已停止，防止后续 processMessages 写入状态或 resolve resolver
        // （Bug 2.2：behavior 在 stop 后仍可能在后台执行）
        this.stopped.add(id);

        // 在删除 actor 和 mailbox 之前，reject 所有 pending 的 askResolvers，
        // 避免 ask() 调用方在 actor 被 stop() 后永久挂起：
        // stop() 删除 actor 和 mailbox 后，processMessages 会因 !actor || !mailbox
        // 提前返回，不触发 reject，askResolvers 中的 resolver 永远不会被 resolve/reject。
        // askResolvers 是 WeakMap<ActorMessage, {resolve, reject}>，按 message 关联，
        // 因此遍历 mailbox 中尚未处理的消息并 reject 对应 resolver。
        const mailbox = this.mailboxes.get(id);
        if (mailbox) {
          for (const message of mailbox) {
            const resolver = this.askResolvers.get(message);
            if (resolver) {
              this.askResolvers.delete(message);
              resolver.reject(new Error(`Actor ${id} stopped`));
            }
          }
        }
        // Bug 2.1 修复：reject in-flight 消息的 resolver。原代码仅遍历 mailbox，
        // 但 in-flight 消息已被 shift 出 mailbox，其 resolver 永远不会被 reject，
        // 导致 ask() 调用方永久挂起。
        const inflight = this.inflightMessages.get(id);
        if (inflight) {
          const resolver = this.askResolvers.get(inflight);
          if (resolver) {
            this.askResolvers.delete(inflight);
            resolver.reject(new Error(`Actor ${id} stopped`));
          }
          this.inflightMessages.delete(id);
        }
        this.actors.delete(id);
        this.mailboxes.delete(id);
      },
    };
  }

  private async processMessages(actorId: string): Promise<void> {
    if (this.processing.has(actorId)) return;
    if (this.stopped.has(actorId)) return;
    this.processing.add(actorId);

    try {
      const actor = this.actors.get(actorId);
      const mailbox = this.mailboxes.get(actorId);
      if (!actor || !mailbox) return;

      while (mailbox.length > 0) {
        // stop() 可能在此期间被调用；每次循环前检查
        if (this.stopped.has(actorId)) return;
        const message = mailbox.shift()!;
        // 跟踪当前 in-flight 消息，让 stop() 能 reject 其 resolver
        this.inflightMessages.set(actorId, message);
        try {
          const result = await actor.behavior(message, actor.state);
          // Bug 2.2 修复：behavior 完成后若 actor 已被 stop，跳过状态更新与
          // resolver resolve（stop() 已 reject 了 resolver）
          if (this.stopped.has(actorId)) {
            this.inflightMessages.delete(actorId);
            return;
          }
          actor.state = result.newState;
          // 若是 ask() 入队的消息，将响应回传给等待的调用方
          const resolver = this.askResolvers.get(message);
          if (resolver) {
            this.askResolvers.delete(message);
            resolver.resolve({
              type: "response",
              sender: actorId,
              recipient: message.sender,
              payload: result.response,
              correlationId: message.correlationId || "",
              timestamp: new Date(),
            });
          }
        } catch (err) {
          process.stderr.write(`[ActorSystem] Error processing message for "${actorId}":` + " " + err + "\n");
          // stop 后 behavior 抛错时也跳过 resolver（已 reject 过）
          if (this.stopped.has(actorId)) {
            this.inflightMessages.delete(actorId);
            return;
          }
          // ask() 消息处理失败时 reject，避免调用方永久挂起
          const resolver = this.askResolvers.get(message);
          if (resolver) {
            this.askResolvers.delete(message);
            resolver.reject(err);
          }
        } finally {
          this.inflightMessages.delete(actorId);
        }
      }
    } finally {
      this.processing.delete(actorId);
      // 重新检查邮箱：在循环退出后、finally 执行前若有新消息到达，
      // 新的 processMessages 调用会因 processing.has 为 true 而提前返回，
      // 导致该消息永久滞留。此处重新触发处理以避免消息丢失。
      // 已 stop 的 actor 不再处理新消息。
      if (this.stopped.has(actorId)) return;
      const mailbox = this.mailboxes.get(actorId);
      if (mailbox && mailbox.length > 0) {
        // 避免吞掉错误，记录到 stderr 以便排查
        void this.processMessages(actorId).catch((err) => {
          process.stderr.write(
            "[ActorSystem] processMessages failed for " +
              actorId +
              ": " +
              (err instanceof Error ? err.message : String(err)) +
              "\n",
          );
        });
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