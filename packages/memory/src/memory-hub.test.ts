import { describe, it, expect, beforeEach } from "vitest";
import { MemoryHub } from "./memory-hub";
import { TransformersEmbeddingProvider } from "./transformers-embedding";
import { ServiceRegistry } from "@evoclaw/core";
import { EventBus } from "@evoclaw/core";

describe("MemoryHub — Transformers embedding integration", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
  });

  it("auto-wires TransformersEmbeddingProvider when @huggingface/transformers is installed", () => {
    const hub = new MemoryHub(registry, eventBus);
    const status = hub.getEmbeddingProviderStatus();
    if (TransformersEmbeddingProvider.isAvailable()) {
      expect(status).toBe("transformers");
      expect(hub.getEmbeddingProvider()).not.toBeNull();
      expect(hub.getVectorStore()).not.toBeNull();
      // The vector store should be registered in the service registry
      const registered = registry.resolveService("vectorMemory");
      expect(registered).toBe(hub.getVectorStore());
    } else {
      // In CI without the package installed, ensure graceful degradation
      expect(status).toBe("unavailable");
      expect(hub.getEmbeddingProvider()).toBeNull();
      expect(hub.getVectorStore()).toBeNull();
    }
  });

  it("respects useTransformers: false", () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    expect(hub.getEmbeddingProviderStatus()).toBe("disabled");
    expect(hub.getEmbeddingProvider()).toBeNull();
  });

  it("exposes the embedding provider's dimensions (384 for all-MiniLM-L6-v2)", () => {
    const hub = new MemoryHub(registry, eventBus);
    const provider = hub.getEmbeddingProvider();
    if (provider) {
      expect(provider.dimensions).toBe(384);
    }
  });

  it("semanticSearch returns gracefully when provider unavailable", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    const results = await hub.semanticSearch("anything");
    // Falls back to FTS5 — should not throw
    expect(Array.isArray(results)).toBe(true);
  });
});
