import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { RequestWithId } from './requestLogger';

export const rateLimitMiddleware = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req: Request, res: Response) => {
    const requestId = (req as RequestWithId).id;
    logger.warn('Rate limit exceeded', {
      requestId,
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    
    return {
      success: false,
      error: 'Too many requests, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil(config.rateLimit.windowMs / 1000),
    };
  },
  keyGenerator: (req: Request): string => {
    const request = req as RequestWithId;
    if (request.userId) {
      return request.userId;
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
  skip: (req: Request): boolean => {
    const publicPaths = ['/health', '/api/health'];
    return publicPaths.includes(req.path);
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil(config.rateLimit.windowMs / 1000),
    });
  },
});

export const createRateLimiter = (options?: {
  windowMs?: number;
  max?: number;
  keyGenerator?: (req: Request) => string;
}) => {
  return rateLimit({
    windowMs: options?.windowMs || config.rateLimit.windowMs,
    max: options?.max || config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: 'Too many requests, please try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
    },
    keyGenerator: options?.keyGenerator || ((req: Request) => {
      const request = req as RequestWithId;
      return request.userId || req.ip || req.socket.remoteAddress || 'unknown';
    }),
  });
};