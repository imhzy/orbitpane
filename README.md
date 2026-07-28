# Agent Web Bridge

Agent Web Bridge is a self-hosted web interface for running coding agents inside
explicitly allowed server workspaces. The default provider is Google
Antigravity (`agy`). An optional OpenAI Codex provider is included behind a
feature flag.

## Architecture

```text
React + Vite PWA
  ├── authenticated REST ── conversations / history / filesystem
  └── authenticated WebSocket
          │
FastAPI application
  ├── signed session tokens
  ├── workspace path policy
  ├── SQLite repository
  ├── task coordinator + reconnect state
  └── AgentProvider
        ├── AgyProvider (default)
        └── CodexCliProvider (optional)
```

The backend is split by responsibility:

- `backend/app/application.py`: HTTP and WebSocket transport.
- `backend/app/security.py`: PIN verification and signed expiring tokens.
- `backend/app/database.py`: SQLite schema and repository.
- `backend/app/realtime.py`: connection hub and one-task-per-conversation
  coordination.
- `backend/app/agents/`: provider-neutral contract and concrete adapters.

The frontend uses `frontend/src/lib/api.ts` as the single authenticated REST
client. Authentication state is based on a signed, expiring, HttpOnly
same-site cookie rather than an independent browser flag or a token exposed to
JavaScript.

## Requirements

- Python 3.11+
- Node.js 20+
- `agy` CLI for the default provider
- PM2 and Nginx for the documented production setup

Install dependencies:

```bash
python3 -m pip install -e '.[test]'
cd frontend
npm ci
```

## Configuration

Configuration is read from environment variables. Start from `.env.example`,
but do not commit real credentials.

For production, these values are mandatory:

```bash
export AGY_ENV=production
export AGY_PIN='use-a-private-pin'
export AGY_AUTH_SECRET='use-a-long-random-secret'
export AGY_ALLOWED_ROOTS='/srv/workspaces,/root/projects'
```

Useful security settings:

- `AGY_ALLOWED_ROOTS`: comma-separated directory allowlist. Symlinks are
  resolved before authorization.
- `AGY_CORS_ORIGINS`: empty for same-origin deployments; otherwise a
  comma-separated explicit origin list.
- `AGY_DANGEROUS_SKIP_PERMISSIONS`: defaults to `false`. Only enable it inside
  an isolated environment.
- `AGY_AUTH_TTL_SECONDS`: signed login token lifetime, default 12 hours.

In development only, the legacy PIN `0524` remains available when `AGY_PIN` is
unset. The backend logs a warning and uses an ephemeral signing secret, so
sessions expire after every restart. Production refuses to start without both
authentication settings.

## Development

Backend:

```bash
python3 backend/main.py
```

Frontend:

```bash
cd frontend
npm run dev
```

The Vite dev server should proxy `/api` to port `8005`, or both applications can
be served through Nginx.

Verification:

```bash
python3 -m unittest discover -s backend/tests -v
python3 -m compileall -q backend
cd frontend
npm run lint
npm run build
```

## Production

Build the frontend:

```bash
cd /root/agy_web_bridge/frontend
npm ci
npm run build
```

Start the backend after exporting the production environment:

```bash
cd /root/agy_web_bridge/backend
pm2 start main.py --name agy-backend --interpreter python3
pm2 save
```

After backend changes:

```bash
pm2 restart agy-backend --update-env
pm2 status agy-backend
```

Minimal same-origin Nginx layout:

```nginx
location / {
    root /root/agy_web_bridge/frontend/dist;
    try_files $uri $uri/ /index.html;
}

location /api/ {
    proxy_pass http://127.0.0.1:8005/api/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Terminate TLS at Nginx. Do not expose port `8005` directly.

## Optional Codex provider

Codex is disabled by default. The adapter uses the documented
`codex exec --json` JSONL interface, runs in `workspace-write`, and shares the
same authentication, workspace policy, task coordinator, history and
WebSocket protocol as AGY.

```bash
export CODEX_ENABLED=true
export CODEX_MODELS='your-approved-codex-model'
export CODEX_SANDBOX=workspace-write
```

The provider abstraction can later be replaced by the official Python
`openai-codex` SDK without changing application routes or frontend state. The
official SDK is suitable for embedding coding-focused Codex threads in an
application, while JSONL non-interactive mode provides machine-readable agent
events:

- <https://developers.openai.com/codex/sdk/>
- <https://developers.openai.com/codex/noninteractive/>

## Security notes

- Every REST endpoint except login and health requires a signed session.
- WebSockets authenticate from the same HttpOnly session cookie.
- Failed PIN attempts are rate-limited in memory.
- Only one task can run per conversation; rejected concurrent messages are not
  persisted.
- Deleting a running conversation interrupts its process group first.
- Agent-produced Markdown does not render raw HTML.
- Provider model IDs are validated server-side.
- SQLite uses WAL mode, busy timeouts and indexed conversation history.

This service runs coding agents capable of changing files and executing tools.
Use an OS account, container or VM whose permissions match the intended trust
boundary.
