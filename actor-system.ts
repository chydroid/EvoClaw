/**
 * 从 /home/chy/EvoClaw/packages/agent/src/actor-system.ts 提取的前 30 行分析副本
 * 职责：Actor 模型的消息系统（ActorSystem），含邮箱、ask 响应回调、
 * 停止/挂起（Bug 2.1/2.2 修复）逻辑，用于并发 actor 间消息通信。
 */
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
