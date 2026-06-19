# EvoClaw Plugin Development Guide

## Overview

EvoClaw's Plugin SDK provides a type-safe framework for extending the platform with custom channels, providers, tools, and more.

## Quick Start

### 1. Create a Plugin Project

```bash
mkdir my-evoclaw-plugin
cd my-evoclaw-plugin
npm init -y
npm install @evoclaw/plugin-sdk
```

### 2. Define Your Plugin

```typescript
import { Plugin, PluginManifest, ServiceLocator, PluginLogger } from "@evoclaw/plugin-sdk";

const manifest: PluginManifest = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  description: "A custom EvoClaw plugin",
  categories: ["tool"],
};

export class MyPlugin implements Plugin {
  readonly manifest = manifest;
  readonly state = { manifest, status: "registered" as const };

  async init(services: ServiceLocator, logger: PluginLogger): Promise<void> {
    logger.info("MyPlugin initialized");
  }

  async shutdown(): Promise<void> {
    // Cleanup resources
  }
}
```

### 3. Register Your Plugin

```typescript
import { PluginManager } from "@evoclaw/core";

const manager = new PluginManager();
manager.register(new MyPlugin());
```

## Plugin Types

### Channel Plugins

Channel plugins connect EvoClaw to messaging platforms (WhatsApp, Telegram, Discord, etc.).

```typescript
import { ChannelPlugin, ChannelConfig } from "@evoclaw/plugin-sdk/channel";

export class MyChannel implements ChannelPlugin {
  readonly manifest = { id: "my-channel", name: "My Channel", version: "1.0.0", description: "" };

  async connect(config: ChannelConfig): Promise<void> {
    // Connect to the messaging platform
  }

  async disconnect(): Promise<void> {
    // Disconnect cleanly
  }

  async sendMessage(target: string, message: string): Promise<void> {
    // Send a message
  }
}
```

### Provider Plugins

Provider plugins add support for new LLM providers.

```typescript
import { ProviderPlugin, ProviderConfig } from "@evoclaw/plugin-sdk/provider";

export class MyProvider implements ProviderPlugin {
  readonly manifest = { id: "my-provider", name: "My Provider", version: "1.0.0", description: "" };

  async complete(prompt: string, config: ProviderConfig): Promise<string> {
    // Call your LLM API
    return "response";
  }
}
```

### Tool Plugins

Tool plugins add custom tools that agents can use.

```typescript
import { ToolPlugin, ToolDefinition, ToolResult } from "@evoclaw/plugin-sdk/tool";

export class MyTool implements ToolPlugin {
  readonly manifest = { id: "my-tool", name: "My Tool", version: "1.0.0", description: "" };

  getDefinition(): ToolDefinition {
    return {
      name: "my_tool",
      description: "Does something useful",
      parameters: {
        input: { type: "string", description: "Input text" },
      },
    };
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    return { success: true, result: "Done!" };
  }
}
```

## Lifecycle Hooks

Plugins can subscribe to lifecycle events:

```typescript
getHooks() {
  return ["onMessageReceived", "onToolExecuted"];
}

async onHook(hook: PluginHookContext): Promise<void> {
  switch (hook.hookName) {
    case "onMessageReceived":
      // Handle incoming message
      break;
    case "onToolExecuted":
      // Handle tool execution
      break;
  }
}
```

Available hooks:
- `onInit` - Plugin initialization
- `onShutdown` - Plugin shutdown
- `onConfigChanged` - Configuration changes
- `onChannelConnected` - Channel connection
- `onChannelDisconnected` - Channel disconnection
- `onMessageReceived` - Incoming message
- `onMessageSent` - Outgoing message
- `onModelCalled` - LLM API call
- `onToolExecuted` - Tool execution
- `onSkillInstalled` - Skill installation
- `onSkillExecuted` - Skill execution
- `onAuditEvent` - Audit event

## Service Locator

Access core services through the ServiceLocator:

```typescript
async init(services: ServiceLocator, logger: PluginLogger): Promise<void> {
  const config = services.get<ConfigManager>("config");
  const eventBus = services.get<EventBus>("eventBus");
  const logger2 = services.get<Logger>("logger");
}
```

## Configuration

Add custom config sections:

```typescript
import { ConfigSchema } from "@evoclaw/plugin-sdk/config";

export const myConfigSchema: ConfigSchema = {
  myPlugin: {
    apiKey: { type: "string", required: true },
    enabled: { type: "boolean", default: true },
  },
};
```

## Health Checks

Implement health checks for monitoring:

```typescript
async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
  try {
    // Check if your service is healthy
    return { healthy: true, message: "OK" };
  } catch (error) {
    return { healthy: false, message: error.message };
  }
}
```

## Testing

Test your plugin:

```typescript
import { describe, it, expect } from "vitest";
import { MyPlugin } from "./my-plugin";

describe("MyPlugin", () => {
  it("should initialize", async () => {
    const plugin = new MyPlugin();
    const services = {} as ServiceLocator;
    const logger = { info: vi.fn() } as PluginLogger;

    await plugin.init(services, logger);

    expect(logger.info).toHaveBeenCalledWith("MyPlugin initialized");
  });
});
```

## Best Practices

1. **Keep plugins focused** - One plugin, one responsibility
2. **Use TypeScript** - Take advantage of type safety
3. **Handle errors gracefully** - Don't crash the host
4. **Clean up resources** - Implement shutdown properly
5. **Log meaningful messages** - Help with debugging
6. **Write tests** - Ensure reliability
7. **Document your plugin** - Help users understand it

## Distribution

Publish your plugin to npm:

```bash
npm publish
```

Users can install it:

```bash
npm install my-evoclaw-plugin
```

Then register it in their EvoClaw configuration.
