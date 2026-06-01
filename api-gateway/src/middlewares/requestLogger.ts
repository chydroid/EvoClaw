import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestLogger } from '../utils/logger';

export interface RequestWithId extends Request {
  id?: string;
  userId?: string;
  startTime?: number;
}

export const requestLoggerMiddleware = (
  req: RequestWithId, 
  res: Response, 
  next: NextFunction
): void => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.id = requestId;
  req.startTime = Date.now();

  const logData = {
    requestId,
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    ip: req.ip || req.socket.remoteAddress,
    userAgent: req.get('user-agent'),
    timestamp: new Date().toISOString(),
  };

  requestLogger.info(`Incoming request`, logData);

  const originalSend = res.send;
  res.send = function (body: any): Response {
    const duration = Date.now() - (req.startTime || Date.now());
    
    const responseLogData = {
      ...logData,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userId: req.userId || 'anonymous',
    };

    if (res.statusCode >= 400) {
      requestLogger.error(`Request completed with error`, {
        ...responseLogData,
        error: true,
      });
    } else {
      requestLogger.info(`Request completed successfully`, responseLogData);
    }

    return originalSend.call(this, body);
  };

  next();
};