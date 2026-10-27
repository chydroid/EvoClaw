/**
 * Generate a JWT token for EvoClaw API access
 */
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

// Load .env
const envPath = path.resolve(__dirname, '../.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};

for (const line of envContent.split('\n')) {
  const match = line.match(/^([^=]+)=([^#]*)$/);
  if (match) {
    envVars[match[1].trim()] = match[2].trim();
  }
}

const jwtSecret = envVars.JWT_SECRET || 'change-me-to-a-random-secret-min-16-chars';
const webUiToken = envVars.WEB_UI_TOKEN || '';

console.log('JWT_SECRET length:', jwtSecret.length);
console.log('WEB_UI_TOKEN configured:', webUiToken.length > 0);

// Generate token
const token = jwt.sign(
  { userId: 'test-user', roles: ['user', 'admin'] },
  jwtSecret,
  { expiresIn: '24h' }
);

console.log('\nGenerated token:');
console.log(token);

// Also show how to use it
console.log('\nUsage:');
console.log(`curl -H "Authorization: Bearer ${token}" http://127.0.0.1:27789/api/v1/skills`);
