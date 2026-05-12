# Track B Railway Env Verification for PR #106

Generated: 2026-05-04
Branch: fix/security-dependency-hotfixes
Commit at verification start: 0657dfe
Scope: Railway production environment variables only

## Intended Final State

- `NODE_ENV=production`
- `DEV_MODE=true` only during a time-boxed production dev-auth smoke window; otherwise `false`
- Production dev-auth smoke now requires both `ALLOW_DEV_AUTH_IN_PROD=true` and `I_UNDERSTAND_DEV_AUTH_IN_PROD=yes`; otherwise `DEV_MODE=true` fails startup and dev-auth routes stay closed.
- `CORS_ALLOWED_ORIGINS` includes the production frontend URL

## Code Discovery

- `server/src/modules/auth/http-config.ts` defines `CORS_ALLOWED_ORIGINS` as the comma-separated origin allowlist input used by `getAllowedCorsOrigins`.
- `server/src/modules/auth/http-config.ts` also accepts `FRONTEND_URL`, `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_STATIC_URL`, and `RAILWAY_SERVICE_FRONTEND_URL` as additional origin sources.
- `server/src/modules/auth/http-config.ts` defines `ALLOW_DEV_AUTH_IN_PROD` plus `I_UNDERSTAND_DEV_AUTH_IN_PROD=yes` as the explicit production override for `DEV_MODE=true`.

## Command Log

### `git branch --show-current`

Exit code: 0

Output:

```text
fix/security-dependency-hotfixes
```

### `git status --short`

Exit code: 0

Output:

```text

```

### `git log -1 --oneline`

Exit code: 0

Output:

```text
0657dfe fix(security): add ALLOW_DEV_AUTH_IN_PROD override for pre-cutover E2E (B-09)
```

### `railway whoami`

Exit code: 1

Output:

```text
Unauthorized. Please check that your RAILWAY_API_TOKEN is valid and has access to the resource you're trying to use.
```

### `railway status`

Exit code: 1

Output:

```text
No linked project found. Run railway link to connect to a project
```

### `railway whoami` outside sandbox retry

Exit code: 1

Output:

```text
Unauthorized. Please check that your RAILWAY_API_TOKEN is valid and has access to the resource you're trying to use.
```

## Failure

Railway CLI authentication failed before any production environment variables could be read or written. Per the task failure handling, variable verification stopped immediately.

No Railway variables were modified.
No deploy commands were run.
No Railway project, service, or environment configuration was changed.

## Final State

Not verified because `railway whoami` failed with `Unauthorized`.

- `NODE_ENV`: not read
- `DEV_MODE`: not read
- `ALLOW_DEV_AUTH_IN_PROD`: not read
- `CORS_ALLOWED_ORIGINS`: not read
