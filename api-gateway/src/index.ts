import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config';
import { logger, setStartTime } from './utils/logger';
import { requestLoggerMiddleware, RequestWithId } from './middlewares/requestLogger';
import { jwtAuthMiddleware } from './middlewares/jwtAuth';
import { rateLimitMiddleware } from './middlewares/rateLimiter';
import { setupRoutes } from './middlewares/router';
import { healthCheck, readinessCheck, livenessCheck } from './routes/health';
import authRoutes from './routes/auth';

const app: Application = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(requestLoggerMiddleware);

app.get('/health', healthCheck);
app.get('/api/health', healthCheck);
app.get('/api/health/readiness', readinessCheck);
app.get('/api/health/liveness', livenessCheck);

app.use('/api/auth', authRoutes);

app.use(rateLimitMiddleware);

app.use(jwtAuthMiddleware);

setupRoutes(app);

app.use((req: RequestWithId, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.path,
  });
});

app.use((err: Error, req: Request, res: Response, next: any) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.url,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

const PORT = config.port;

app.listen(PORT, () => {
  setStartTime();
  logger.info(`🚀 API Gateway started on port ${PORT}`);
  logger.info(`📋 Environment: ${config.env}`);
  logger.info(`🔒 JWT Secret: ${config.jwt.secret.substring(0, 8)}...`);
  logger.info(`⚡ Rate Limit: ${config.rateLimit.max} requests per ${config.rateLimit.windowMs / 1000}s`);
  logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
});

export default app;