# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email security concerns to: [maintainer email]
3. Include detailed reproduction steps
4. Allow reasonable time for response before public disclosure

## Security Features

EvoClaw includes multiple security layers:

- **SecurityGovernor**: Central security policy enforcement
- **AuditCenter**: Comprehensive audit logging
- **PermissionManager**: Role-based access control
- **ToolPolicyManager**: Tool execution policies
- **SecurityMiddleware**: Request/response security filtering
- **MCPToolPoisoningScanner**: Protection against tool poisoning attacks

## Configuration Security

- JWT secrets must be at least 16 characters
- API keys should be stored in environment variables, not code
- Use `.env` files for local development (not committed to git)
- Production deployments should use secure secret management

## Dependencies

- Regular security audits via `pnpm audit`
- Only `better-sqlite3` and `esbuild` are allowed to run build scripts
- Lockfile is committed for reproducible builds

## Best Practices

1. Keep dependencies updated
2. Use environment variables for secrets
3. Enable audit logging in production
4. Review permission configurations regularly
5. Use HTTPS in production deployments
