# EvoClaw Vision

EvoClaw is a self-evolving AI assistant platform that learns, adapts, and improves through interactions.

## Current State

EvoClaw is a TypeScript monorepo with 14+ internal packages and 2 apps, providing:

- Intelligent conversation system with task orchestration
- Multi-channel gateway (WeChat, REST API, WebSocket)
- Skill learning and management system
- Self-evolution engine for continuous improvement
- Memory system with RAG pipeline
- Security governance and audit
- Browser automation and file operations

## Goals

### Priority

- **Stability**: Bug fixes, reliability, and production readiness
- **Security**: Safe defaults, audit trails, permission management
- **Developer Experience**: Clear APIs, comprehensive documentation, easy plugin development

### Next Priorities

- **Plugin Ecosystem**: Extensible plugin SDK for community contributions
- **Multi-Model Support**: Support for all major LLM providers
- **Channel Expansion**: More messaging platform integrations
- **Performance**: Optimized resource usage and response times
- **Observability**: Better monitoring, logging, and debugging tools

## Architecture Principles

1. **Modularity**: Each package has a clear responsibility
2. **Extensibility**: Plugin SDK for community extensions
3. **Security**: Defense in depth, least privilege
4. **Evolution**: System learns and improves from interactions
5. **Simplicity**: Clean code, minimal complexity

## Plugin Philosophy

EvoClaw stays lean by design. Optional capabilities should ship as plugins, not core features.

- Core provides the foundation: types, services, event bus, config
- Plugins extend functionality through the plugin SDK
- Community plugins are encouraged and supported

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get involved.

## Security

See [`SECURITY.md`](SECURITY.md) for security policies and reporting.
