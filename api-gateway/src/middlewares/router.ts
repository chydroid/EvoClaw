import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config';
import { logger } from '../utils/logger';
import { RequestWithId } from './requestLogger';

interface RouteConfig {
  path: string;
  target: string;
  methods?: string[];
}

const routes: RouteConfig[] = [
  {
    path: '/api/users',
    target: config.services.userService,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  {
    path: '/api/orders',
    target: config.services.orderService,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  {
    path: '/api/products',
    target: config.services.productService,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
];

export const setupRoutes = (app: any): void => {
  routes.forEach((route) => {
    logger.info(`Setting up route: ${route.path} -> ${route.target}`);
    
    const proxy = createProxyMiddleware({
      target: route.target,
      changeOrigin: true,
      pathRewrite: (path: string) => {
        return path.replace(/^\/api\/[a-z]+/, '');
      },
      onProxyReq: (proxyReq, req: Request) => {
        const request = req as RequestWithId;
        if (request.userId) {
          proxyReq.setHeader('x-user-id', request.userId);
        }
        if (request.id) {
          proxyReq.setHeader('x-request-id', request.id);
        }
        logger.debug(`Proxying request`, {
          originalPath: req.url,
          targetPath: route.target,
          requestId: request.id,
        });
      },
      onError: (err: Error, req: Request, res: Response) => {
        logger.error('Proxy error', {
          error: err.message,
          path: req.url,
          target: route.target,
        });
        res.status(502).json({
          success: false,
          error: 'Bad Gateway - Service unavailable',
          code: 'SERVICE_UNAVAILABLE',
        });
      },
      onProxyRes: (proxyRes, req: Request, res: Response) => {
        logger.debug(`Proxy response received`, {
          statusCode: proxyRes.statusCode,
          path: req.url,
        });
      },
    });

    app.use(route.path, proxy);
  });

  logger.info('All routes configured successfully');
};

export const getRoutes = (): RouteConfig[] => {
  return routes;
};