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
      send: async (message: ActorMessage) => {
        const mailbox = this.mailboxes.get(id);
        if (mailbox) {
          mailbox.push(message);
          await this.processMessages(id);
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
          console.error(`[ActorSystem] Error processing message for "${actorId}":`, err);
        }
      }
    } finally {
      this.processing.delete(actorId);

      const mailbox = this.mailboxes.get(actorId);
      if (mailbox && mailbox.length > 0) {
        await this.processMessages(actorId);
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