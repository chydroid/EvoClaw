import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { RequestWithId } from './requestLogger';
import { logger } from '../utils/logger';

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends RequestWithId {
  user?: JwtPayload;
}

export const jwtAuthMiddleware = (
  req: AuthRequest, 
  res: Response, 
  next: NextFunction
): void => {
  const publicPaths = ['/health', '/api/health', '/api/auth/login', '/api/auth/register'];
  
  if (publicPaths.includes(req.path)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    logger.warn('No authorization header provided', { 
      path: req.path, 
      ip: req.ip 
    });
    res.status(401).json({
      success: false,
      error: 'Authorization header is required',
      code: 'NO_AUTH_HEADER',
    });
    return;
  }

  const parts = authHeader.split(' ');
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logger.warn('Invalid authorization header format', { 
      path: req.path, 
      ip: req.ip,
      authHeader: authHeader.substring(0, 20) + '...'
    });
    res.status(401).json({
      success: false,
      error: 'Invalid authorization header format. Use: Bearer <token>',
      code: 'INVALID_AUTH_FORMAT',
    });
    return;
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    req.user = decoded;
    req.userId = decoded.userId;
    
    logger.debug('JWT token verified successfully', { 
      userId: decoded.userId, 
      username: decoded.username 
    });
    
    next();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (error instanceof jwt.TokenExpiredError) {
      logger.warn('JWT token expired', { 
        path: req.path, 
        ip: req.ip,
        expiredAt: (error as any).expiredAt 
      });
      res.status(401).json({
        success: false,
        error: 'Token has expired',
        code: 'TOKEN_EXPIRED',
      });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid JWT token', { 
        path: req.path, 
        ip: req.ip,
        error: errorMessage 
      });
      res.status(401).json({
        success: false,
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      });
      return;
    }

    logger.error('JWT verification failed', { 
      path: req.path, 
      ip: req.ip,
      error: errorMessage 
    });
    res.status(500).json({
      success: false,
      error: 'Token verification failed',
      code: 'TOKEN_VERIFICATION_FAILED',
    });
  }
};

export const generateToken = (payload: Omit<JwtPayload, 'iat' | 'exp'>): string => {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
};

export const verifyToken = (token: string): JwtPayload => {
  return jwt.verify(token, config.jwt.secret) as JwtPayload;
};