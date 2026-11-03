/**
 * gateway-server.ts — Gateway HTTP 服务器骨架
 *
 * 本文件为重构任务生成的骨架，统一错误处理入口。
 * 实际实现位于 /home/chy/EvoClaw/packages/gateway/src/gateway-server.ts，
 * 此骨架用于演示统一 ErrorHandler 在 Gateway 侧的集成方式。
 */

import type { Response } from "express";
import { createErrorHandler, type ClassifiedError } from "@evoclaw/infrastructure/errors";

export interface GatewayConfig {
  port: number;
  host: string;
  isProduction: boolean;
}

/**
 * 统一错误处理：Express 错误中间件（替代原 handleError）
 * - 非生产：暴露 message
 * - 生产：固定 "Internal Server Error"，不泄漏内部细节
 */
export function handleError(res: Response, err: unknown, isProduction: boolean): void {
  const handler = createErrorHandler();
  const e: ClassifiedError = handler.classify({
    cause: err,
    domain: "gateway",
    context: { route: "unspecified" },
  });
  const { status, body } = handler.toHttpResponse(e, isProduction);
  res.status(status).json(body);
}

/**
 * 统一错误处理：Express 中间件封装（与原始 this.handleError 行为等价）
 */
export function errorHandlerMiddleware(
  res: Response,
  err: unknown,
  isProduction: boolean,
): void {
  handleError(res, err, isProduction);
}

export { GatewayConfig };
