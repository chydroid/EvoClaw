import { describe, it, expect } from "vitest";
import { parseSSEChunk, readSSEStream, type SSEEvent } from "../src/sse-parser.js";

describe("SSE Parser", () => {
  describe("parseSSEChunk", () => {
    it("应解析单个完整事件", () => {
      const text = `event: tool_call_start
data: {"callId":"abc","toolName":"search"}

`;
      const events: SSEEvent[] = [];
      const remaining = parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("tool_call_start");
      expect(events[0].data).toEqual({ callId: "abc", toolName: "search" });
      expect(remaining).toBe("");
    });

    it("应解析多个事件", () => {
      const text = `event: tool_call_start
data: {"callId":"abc"}

event: tool_result
data: {"result":"success"}

`;
      const events: SSEEvent[] = [];
      parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("tool_call_start");
      expect(events[1].event).toBe("tool_result");
      expect(events[1].data).toEqual({ result: "success" });
    });

    it("应保留不完整的尾部作为 remaining", () => {
      const text = `event: tool_call_start
data: {"callId":"abc"}

event: tool_progress
data: {"incomplete`;
      const events: SSEEvent[] = [];
      const remaining = parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("tool_call_start");
      expect(remaining).toContain("tool_progress");
      expect(remaining).toContain("incomplete");
    });

    it("应处理多行 data 字段（自动拼接）", () => {
      const text = `event: tool_result
data: {"part1":"a",
data: "part2":"b"}

`;
      const events: SSEEvent[] = [];
      parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ part1: "a", part2: "b" });
    });

    it("应忽略注释行（以 : 开头）", () => {
      const text = `: this is a comment

event: tool_result
data: {"ok":true}

`;
      const events: SSEEvent[] = [];
      parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("tool_result");
    });

    it("应处理无 event 字段的事件（跳过）", () => {
      const text = `data: {"noEvent":true}

`;
      const events: SSEEvent[] = [];
      parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(0);
    });

    it("应在 JSON 解析失败时回退为 { raw: string }", () => {
      const text = `event: tool_error
data: not valid json

`;
      const events: SSEEvent[] = [];
      parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ raw: "not valid json" });
    });

    it("应处理空数据事件", () => {
      const text = `event: ping

`;
      const events: SSEEvent[] = [];
      parseSSEChunk(text, (evt) => events.push(evt));

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("ping");
      expect(events[0].data).toEqual({});
    });

    it("应处理流式分片（多次调用）", () => {
      // 模拟 TCP 分片：一个事件被拆成两段
      const chunk1 = `event: tool_call
data: {"cal`;
      const chunk2 = `lId":"split"}

`;

      const events: SSEEvent[] = [];
      let remaining = parseSSEChunk(chunk1, (evt) => events.push(evt));
      expect(events).toHaveLength(0);

      remaining = parseSSEChunk(remaining + chunk2, (evt) => events.push(evt));
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ callId: "split" });
      expect(remaining).toBe("");
    });
  });

  describe("readSSEStream", () => {
    it("应从 ReadableStream 读取并解析完整事件流", async () => {
      const sseText = `event: tool_call_start
data: {"callId":"test-1","toolName":"search"}

event: tool_progress
data: {"elapsedMs":5000}

event: tool_result
data: {"result":"found 3 items"}

event: done
data: {"success":true,"durationMs":1500}

`;
      const stream = new ReadableStream({
        start(controller) {
          // 模拟分片传输
          controller.enqueue(new TextEncoder().encode(sseText.slice(0, 50)));
          controller.enqueue(new TextEncoder().encode(sseText.slice(50, 120)));
          controller.enqueue(new TextEncoder().encode(sseText.slice(120)));
          controller.close();
        },
      });

      const events: SSEEvent[] = [];
      const allEvents = await readSSEStream(stream.getReader(), (evt) => events.push(evt));

      expect(allEvents).toHaveLength(4);
      expect(events).toHaveLength(4);
      expect(allEvents[0].event).toBe("tool_call_start");
      expect(allEvents[1].event).toBe("tool_progress");
      expect(allEvents[2].event).toBe("tool_result");
      expect(allEvents[3].event).toBe("done");
      expect(allEvents[2].data).toEqual({ result: "found 3 items" });
      expect(allEvents[3].data).toEqual({ success: true, durationMs: 1500 });
    });

    it("应处理空流", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const events = await readSSEStream(stream.getReader());
      expect(events).toHaveLength(0);
    });

    it("应处理无尾部换行的流（补 \n\n 后解析）", async () => {
      const sseText = `event: ping
data: {}

`; // 注意：以 \n\n 结尾，但缓冲区 trim 后为空
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText));
          controller.close();
        },
      });

      const events = await readSSEStream(stream.getReader());
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("ping");
    });
  });
});
