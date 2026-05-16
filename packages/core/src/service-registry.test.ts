import { describe, it, expect } from "vitest";
import { ServiceRegistry } from "./service-registry";

describe("ServiceRegistry", () => {
  it("should register and resolve services", () => {
    const registry = new ServiceRegistry();

    registry.registerService("testService", { name: "test" });
    registry.registerService("numberService", 42);

    expect(registry.hasService("testService")).toBe(true);
    expect(registry.hasService("unknown")).toBe(false);
    expect(registry.resolveService("testService")).toEqual({ name: "test" });
    expect(registry.resolveService<number>("numberService")).toBe(42);
  });

  it("should throw on duplicate registration", () => {
    const registry = new ServiceRegistry();
    registry.registerService("test", {});
    expect(() => registry.registerService("test", {})).toThrow();
  });

  it("should list registered services", () => {
    const registry = new ServiceRegistry();
    registry.registerService("a", {});
    registry.registerService("b", {});

    expect(registry.getRegisteredServices()).toEqual(["a", "b"]);
  });

  it("should manage service lifecycle via IService", async () => {
    const registry = new ServiceRegistry();
    let started = false;
    let stopped = false;
    let healthChecked = false;

    const service = {
      name: "lifecycleTest",
      start: async () => { started = true; },
      stop: async () => { stopped = true; },
      healthCheck: async () => { healthChecked = true; return true; },
    };

    registry.registerService("lifecycleTest", service);
    registry.setServiceStatus("lifecycleTest", "starting");
    expect(started).toBe(false);

    await registry.startAll();
    expect(started).toBe(true);

    const health = await registry.healthCheckAll();
    expect(health.get("lifecycleTest")).toBe(true);
    expect(healthChecked).toBe(true);

    await registry.stopAll();
    expect(stopped).toBe(true);
  });

  it("should return undefined for unregistered services", () => {
    const registry = new ServiceRegistry();
    expect(registry.resolveService("nonexistent")).toBeUndefined();
    expect(registry.getServiceInfo("nonexistent")).toBeUndefined();
  });
});