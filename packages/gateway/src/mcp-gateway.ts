import { ServiceRegistry, EventBus, MCPTransport, MCPCapabilities } from "@evoclaw/core";

export class MCPGateway {
  private transports = new Map<string, MCPTransport>();
  private capabilities = new Map<string, MCPCapabilities>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  initialize(): void {
    process.stdout.write("[MCP Gateway] Initializing MCP protocol support");
    this.registry.registerService("mcpGateway", this);
  }

  registerTransport(name: string, transport: MCPTransport): void {
    this.transports.set(name, transport);
    process.stdout.write(`[MCP Gateway] Registered transport "${name}" (${transport.type})`);
  }

  unregisterTransport(name: string): void {
    this.transports.delete(name);
  }

  registerCapabilities(source: string, capabilities: MCPCapabilities): void {
    this.capabilities.set(source, capabilities);
  }

  getRegisteredTransports(): string[] {
    return Array.from(this.transports.keys());
  }

  async discoverTools(): Promise<Record<string, MCPCapabilities>> {
    return Object.fromEntries(this.capabilities);
  }

  /** Release all registered transports and capabilities. */
  dispose(): void {
    this.transports.clear();
    this.capabilities.clear();
    process.stdout.write("[MCP Gateway] Disposed");
  }
}