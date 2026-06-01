/* [Code Analyzer v2.0.0] Scan results for api-gateway/src/routes/auth.ts: */


---
## Code Analyzer Report
- Source: `api-gateway/src/routes/auth.ts`
- Found 2 issue(s): 2 warning(s)

- 🟡 L57: Environment variable JWT_EXPIRES_IN accessed — ensure it's not leaked
- 🟡 L161: Environment variable JWT_EXPIRES_IN accessed — ensure it's not leaked

---

import { Router, Request, Response } from 'express';
import { generateToken, verifyToken } from '../middlewares/jwtAuth';
import { logger } from '../utils/logger';

const router = Router();

interface LoginRequest {
  username: string;
  password: string;
}

interface RegisterRequest {
  username: string;
  password: string;
  email: string;
}

const users: Map<string, { username: string; password: string; email: string; role: string }> = new Map();

router.post('/login', (req: Request, res: Response): void => {
  try {
    const { username, password } = req.body as LoginRequest;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required',
        code: 'MISSING_CREDENTIALS',
      });
      return;
    }

    const user = users.get(username);
    
    if (!user || user.password !== password) {
      logger.warn('Login failed - invalid credentials', { username });
      res.status(401).json({
        success: false,
        error: 'Invalid username or password',
        code: 'INVALID_CREDENTIALS',
      });
      return;
    }

    const token = generateToken({
      userId: username,
      username: user.username,
      role: user.role,
    });

    logger.info('User logged in successfully', { username });

    res.json({
      success: true,
      data: {
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h',
        user: {
          userId: user.username,
          username: user.username,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (error) {
    logger.error('Login error', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'LOGIN_ERROR',
    });
  }
});

router.post('/register', (req: Request, res: Response): void => {
  try {
    const { username, password, email } = req.body as RegisterRequest;

    if (!username || !password || !email) {
      res.status(400).json({
        success: false,
        error: 'Username, password, and email are required',
        code: 'MISSING_FIELDS',
      });
      return;
    }

    if (users.has(username)) {
      res.status(409).json({
        success: false,
        error: 'Username already exists',
        code: 'USER_EXISTS',
      });
      return;
    }

    users.set(username, {
      username,
      password,
      email,
      role: 'user',
    });

    logger.info('User registered successfully', { username, email });

    const token = generateToken({
      userId: username,
      username,
      role: 'user',
    });

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          userId: username,
          username,
          email,
          role: 'user',
        },
      },
    });
  } catch (error) {
    logger.error('Registration error', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'REGISTRATION_ERROR',
    });
  }
});

router.post('/refresh', (req: Request, res: Response): void => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      res.status(401).json({
        success: false,
        error: 'Authorization header required',
        code: 'NO_AUTH_HEADER',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = verifyToken(token);
    
    const newToken = generateToken({
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
    });

    res.json({
      success: true,
      data: {
        token: newToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h',
      },
    });
  } catch (error) {
    logger.error('Token refresh error', { error: (error as Error).message });
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN',
    });
  }
});

router.get('/verify', (req: Request, res: Response): void => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      res.status(401).json({
        success: false,
        error: 'Authorization header required',
        code: 'NO_AUTH_HEADER',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = verifyToken(token);

    res.json({
      success: true,
      data: {
        valid: true,
        user: decoded,
      },
    });
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN',
    });
  }
});

export default router;