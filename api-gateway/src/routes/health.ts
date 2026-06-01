/* [Code Analyzer v2.0.0] Scan results for api-gateway/src/routes/health.ts: */


---
## Code Analyzer Report
- Source: `api-gateway/src/routes/health.ts`
- Found 1 issue(s): 1 warning(s)

- 🟡 L29: Environment variable APP_VERSION accessed — ensure it's not leaked

---

import { Request, Response } from 'express';
import { logger } from '../utils/logger';

interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  service: string;
  version: string;
  checks: {
    [key: string]: {
      status: 'pass' | 'fail' | 'warn';
      message?: string;
      timestamp: string;
    };
  };
}

let startTime = Date.now();

export const healthCheck = (req: Request, res: Response): void => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  
  const healthStatus: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime,
    service: 'api-gateway',
    version: process.env.APP_VERSION || '1.0.0',
    checks: {
      gateway: {
        status: 'pass',
        message: 'Gateway is running',
        timestamp: new Date().toISOString(),
      },
      memory: {
        status: 'pass',
        message: 'Memory usage is normal',
        timestamp: new Date().toISOString(),
      },
    },
  };

  const memUsage = process.memoryUsage();
  const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  
  if (memUsedMB / memTotalMB > 0.9) {
    healthStatus.checks.memory = {
      status: 'warn',
      message: `High memory usage: ${memUsedMB}MB / ${memTotalMB}MB`,
      timestamp: new Date().toISOString(),
    };
    healthStatus.status = 'degraded';
  }

  const statusCode = healthStatus.status === 'healthy' ? 200 : 
                     healthStatus.status === 'degraded' ? 200 : 503;

  logger.debug('Health check performed', { 
    status: healthStatus.status, 
    uptime 
  });

  res.status(statusCode).json(healthStatus);
};

export const readinessCheck = (req: Request, res: Response): void => {
  const isReady = true;
  
  if (isReady) {
    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: 'not ready',
      timestamp: new Date().toISOString(),
    });
  }
};

export const livenessCheck = (req: Request, res: Response): void => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
};

export const setStartTime = (): void => {
  startTime = Date.now();
};