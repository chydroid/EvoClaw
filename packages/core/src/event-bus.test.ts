import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus";
import { SystemEvents } from "./types/event";

describe("EventBus", () => {
  it("should publish and receive events", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.subscribe("test.event", async (event) => {
      received.push(event.data);
    });

    await bus.publish("test.event", { hello: "world" }, "test");

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ hello: "world" });
  });

  it("should handle multiple subscribers", async () => {
    const bus = new EventBus();
    let count = 0;

    bus.subscribe("test.multi", async () => { count++; });
    bus.subscribe("test.multi", async () => { count++; });

    await bus.publish("test.multi", {}, "test");

    expect(count).toBe(2);
  });

  it("should support once subscriptions", async () => {
    const bus = new EventBus();
    let count = 0;

    bus.once("test.once", async () => { count++; });

    await bus.publish("test.once", {}, "test");
    await bus.publish("test.once", {}, "test");

    expect(count).toBe(1);
  });

  it("should track history", async () => {
    const bus = new EventBus();

    await bus.publish("test.history", { id: 1 }, "test");
    await bus.publish("test.history", { id: 2 }, "test");

    const history = bus.getHistory("test.history");
    expect(history).toHaveLength(2);
    expect(history[0].data).toEqual({ id: 1 });
    expect(history[1].data).toEqual({ id: 2 });
  });

  it("should unsubscribe correctly", async () => {
    const bus = new EventBus();
    let count = 0;

    const sub = bus.subscribe("test.unsub", async () => { count++; });
    bus.unsubscribe(sub.id);

    await bus.publish("test.unsub", {}, "test");

    expect(count).toBe(0);
  });

  it("should have correct system event constants", () => {
    expect(SystemEvents.SKILL_INSTALLED).toBe("skill.installed");
    expect(SystemEvents.TASK_CREATED).toBe("task.created");
    expect(SystemEvents.SYSTEM_READY).toBe("system.ready");
  });
});