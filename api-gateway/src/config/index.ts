/* [Code Analyzer v2.0.0] Scan results for api-gateway/src/config/index.ts: */


---
## Code Analyzer Report
- Source: `api-gateway/src/config/index.ts`
- Found 10 issue(s): 10 warning(s)

- 🟡 L23: Environment variable PORT accessed — ensure it's not leaked
- 🟡 L24: Environment variable NODE_ENV accessed — ensure it's not leaked
- 🟡 L26: Environment variable JWT_SECRET accessed — ensure it's not leaked
- 🟡 L27: Environment variable JWT_EXPIRES_IN accessed — ensure it's not leaked
- 🟡 L30: Environment variable RATE_LIMIT_WINDOW_MS accessed — ensure it's not leaked
- 🟡 L31: Environment variable RATE_LIMIT_MAX accessed — ensure it's not leaked
- 🟡 L34: Environment variable USER_SERVICE_URL accessed — ensure it's not leaked
- 🟡 L35: Environment variable ORDER_SERVICE_URL accessed — ensure it's not leaked
- 🟡 L36: Environment variable PRODUCT_SERVICE_URL accessed — ensure it's not leaked
- 🟡 L39: Environment variable LOG_LEVEL accessed — ensure it's not leaked

---

export interface AppConfig {
  port: number;
  env: string;
  jwt: {
    secret: string;
    expiresIn: string;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  services: {
    userService: string;
    orderService: string;
    productService: string;
  };
  log: {
    level: string;
  };
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1分钟
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // 100次/分钟
  },
  services: {
    userService: process.env.USER_SERVICE_URL || 'http://localhost:3001',
    orderService: process.env.ORDER_SERVICE_URL || 'http://localhost:3002',
    productService: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3003',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};