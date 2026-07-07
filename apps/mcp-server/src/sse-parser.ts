/**
 * SSE (Server-Sent Events) 解析器 — 将字节流解析为事件数组。
 *
 * 独立模块，便于单元测试。
 */

/** SSE 事件 */
export interface SSEEvent {
  /** 事件类型（如 tool_call_start / tool_result） */
  event: string;
  /** 事件数据（已解析为对象，解析失败时为 { raw: string }） */
  data: Record<string, unknown>;
}

/**
 * 解析 SSE 文本流为事件数组。
 *
 * SSE 协议：
 * - 事件以双换行 (\n\n) 分隔
 * - 每个事件由多行组成
 * - `event: <type>` 指定事件类型
 * - `data: <json>` 指定事件数据（可多行，自动拼接）
 * - 注释行以 `:` 开头
 *
 * @param text SSE 文本（可能包含多个事件和不完整的尾部）
 * @param onEvent 可选，每个完整事件触发回调
 * @returns 剩余未完成的文本（应作为下次输入的前缀）
 */
export function parseSSEChunk(
  text: string,
  onEvent?: (event: SSEEvent) => void,
): string {
  // SSE 事件以双换行分隔
  const events = text.split("\n\n");
  const remaining = events.pop() || "";

  for (const eventBlock of events) {
    const lines = eventBlock.split("\n");
    let eventType = "";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataStr += line.slice(6);
      }
      // 注释行（以 : 开头）和其他行忽略
    }

    if (!eventType) continue;

    let data: Record<string, unknown> = {};
    try {
      data = dataStr ? JSON.parse(dataStr) : {};
    } catch {
      data = { raw: dataStr };
    }

    onEvent?.({ event: eventType, data });
  }

  return remaining;
}

/**
 * 从 Reader<Uint8Array> 读取并解析完整 SSE 流。
 *
 * @param reader ReadableStreamDefaultReader
 * @param onEvent 每个事件的回调
 * @returns 所有事件的数组（也通过 onEvent 实时回调）
 */
export async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent?: (event: SSEEvent) => void,
): Promise<SSEEvent[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const allEvents: SSEEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = parseSSEChunk(buffer, (evt) => {
      allEvents.push(evt);
      onEvent?.(evt);
    });
  }

  // 处理最后剩余的缓冲区（如果以 \n\n 结尾则已全部解析，否则可能有未完成事件）
  if (buffer.trim()) {
    parseSSEChunk(buffer + "\n\n", (evt) => {
      allEvents.push(evt);
      onEvent?.(evt);
    });
  }

  return allEvents;
}
