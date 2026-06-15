export { GatewayServer } from "./gateway-server";
export { AuthProvider } from "./auth-provider";
export { ProtocolAdapter } from "./protocol-adapter";
export { MCPGateway } from "./mcp-gateway";
export { MCPSSETransport, MCPStdioTransport } from "./mcp-transport";
export type { MCPTransportImpl } from "./mcp-transport";
export { ChannelManager } from "./channel-manager";
export type { ChannelConfig, ChannelType, ChannelMessage, ChannelSendResult, ChannelAdapter, ChannelStatus, DirectMessagePolicy } from "./channel-manager";
export { ProtocolHandler } from "./ws-protocol";
export type { ProtocolFrame, ConnectFrame, ConnectResponse, ConnectError, RequestFrame, ResponseFrame, EventFrame, WSClient, AllowedMethod } from "./ws-protocol";
export { WSServerTransport } from "./ws-server-transport";
export { WebhookManager } from "./webhook-manager";
export { IncomingWebhookManager } from "./webhook-manager";
export type { WebhookConfig, WebhookDelivery, WebhookEvent, WebhookEndpoint, WebhookEventLog, WebhookActionHandler } from "./webhook-manager";
export { TelegramAdapter, DiscordAdapter, SlackAdapter, WhatsAppAdapter, FeishuAdapter, WeChatAdapter, QQAdapter, MatrixAdapter, DingtalkAdapter } from "./channels/index.js";
export type { TelegramConfig, DiscordConfig, SlackConfig, WhatsAppConfig, FeishuConfig, WeChatConfig, QQConfig, MatrixConfig, DingtalkConfig } from "./channels/index.js";
export { CanvasManager } from "./canvas-manager";
export type { CanvasConfig, CanvasFile, CanvasListResult } from "./canvas-manager";

export { CanvasHost } from "./canvas-host";
export type { CanvasFile as CanvasHostFile, CanvasProject } from "./canvas-host";

export { createInboundEnvelope, filterEnvelope, serializeEnvelope, deserializeEnvelope, bumpRetry, withRoutingHint, withAgentBinding, tagEnvelope } from "./inbound-envelope";
export type { InboundEnvelope, MessageIntent, EnvelopePriority, DeliveryContext, RoutingHint, EnvelopeMetadata, EnvelopeOptions, EnvelopeFilter } from "./inbound-envelope";

export { MessageLifecycleManager } from "./message-lifecycle";
export type { MessageState, LifecycleRecord, StateTransition, LifecycleEvent, LifecycleConfig } from "./message-lifecycle";

export { RetryPolicy, isRetryableError, RetryPresets } from "./retry-policy";
export type { RetryConfig, RetryResult, RetryAttempt, RetryCallbacks } from "./retry-policy";

// v0.35: 性能与可用性增强
export { GatewayMetadataCache, DEFAULT_MODEL_COSTS } from "./gateway-metadata-cache";
export type { GatewayMetadata, ModelCostInfo, GatewayMetadataCacheConfig } from "./gateway-metadata-cache";
export { DispatchDedupeStore } from "./dispatch-dedupe-store";
export type { DispatchDedupeKey, DispatchDedupeEntry, DispatchDedupeConfig } from "./dispatch-dedupe-store";
export { ReactionApprovalHandler } from "./reaction-approval-handler";
export type {
  ReactionChannel,
  ApprovalType,
  ReactionApprovalRequest,
  ReactionDecision,
  ReactionApprovalConfig,
} from "./reaction-approval-handler";

export { StreamingManager } from "./streaming-manager";
export type { StreamChunk, StreamConfig, StreamSession, StreamEvent, StreamCallback } from "./streaming-manager";

export { MediaRuntime } from "./media-runtime";
export type { MediaConstraint, MediaValidationResult, MediaOptimizationHint, MediaAttachment, MediaRuntimeConfig } from "./media-runtime";

export { OutboundRouter } from "./outbound-router";
export type { OutboundRoute, OutboundMessage, RoutingRule, OutboundRouterConfig, ChannelStatus as ChannelRouteStatus } from "./outbound-router";

export { ChannelBridgeManager } from "./channel-bridge";
export type { BridgePair, BridgeGroup, BridgeFilter, BridgedMessage, ChannelBridgeConfig } from "./channel-bridge";

export { HealthAggregator, createHealthCheck } from "./health-aggregator";
export type { HealthStatus, ComponentHealth, AggregatedHealth, HealthTransition, HealthAggregatorConfig } from "./health-aggregator";

export { MessageTemplateEngine } from "./message-templates";
export type { TemplateFormat, TemplateVariables, TemplateConfig } from "./message-templates";

export { DeadLetterQueue } from "./dead-letter-queue";
export type { DeadLetter, DLQQuery, DLQStats, DLQConfig } from "./dead-letter-queue";

export { ReplyReferenceManager } from "./reply-reference";
export type { ReplyRef, ReplyChainContext, ReplyNode, ReplyTree, ReplyReferenceConfig, MentionInfo } from "./reply-reference";

export { WeixinPluginAdapter } from "./weixin-plugin-adapter.js";

export { MCPProtocolHandler } from "./mcp-protocol-handler";
export type { ToolDefinition, ToolRegistry, ResourceDefinition, PromptDefinition } from "./mcp-protocol-handler";

export { ChannelAdapterBase, WebhookChannelAdapter, TelegramChannelAdapter } from "./channel-adapter-framework";
export type { ChannelAdapterConfig, ChannelAdapterStatus, WebhookChannelConfig, TelegramChannelConfig } from "./channel-adapter-framework";