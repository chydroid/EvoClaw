const jwt = require("./packages/gateway/node_modules/jsonwebtoken");
const token = jwt.sign({ userId: 'test', roles: ['user'] }, 'EvoClaw-dev-secret-key-2026', { expiresIn: '24h' });
console.log(token);