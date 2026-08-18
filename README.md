# OrbitPane

OrbitPane is a secure, self-hosted mission control for running coding agents inside
explicitly allowed server projects. Its browser PWA provides persistent
projects, queued execution, inline summary checkpoints, full-text search,
realtime execution and reconnect support without coupling the UI
protocol to a specific agent provider. Google Antigravity is the default
provider, with OpenAI Codex available behind a feature flag.

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
  ├── persistent task catalog + per-project queue
  └── AgentProvider
        ├── AntigravityProvider (default)
        └── CodexCliProvider (optional)
```

The backend is split by responsibility:

- `backend/app/application.py`: HTTP and WebSocket transport.
- `backend/app/security.py`: PIN verification and signed expiring tokens.
- `backend/app/database.py`: SQLite schema and repository.
- `backend/app/realtime.py`: connection hub, per-project serial task queue and
  reconnect state.
- `backend/app/agents/`: provider-neutral contract and concrete adapters.

The frontend uses `frontend/src/lib/api.ts` as the single authenticated REST
client. Authentication state is based on a signed, expiring, HttpOnly
HttpOnly cookie rather than an independent browser flag or a token exposed to
JavaScript. Same-origin deployments use `SameSite=Lax`; explicit cross-origin
production deployments use a Secure `SameSite=None` cookie.

## Requirements

- Python 3.11+
- Node.js 20+
- `antigravity` CLI command for the default provider
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
export ORBITPANE_ENV=production
export ORBITPANE_PIN='use-a-private-pin'
export ORBITPANE_AUTH_SECRET='use-a-long-random-secret'
export ORBITPANE_ALLOWED_ROOTS='/srv/workspaces,/root/projects'
```

Useful security settings:

- `ORBITPANE_ALLOWED_ROOTS`: comma-separated directory allowlist. Symlinks are
  resolved before authorization.
- `ORBITPANE_CORS_ORIGINS`: empty for same-origin deployments; otherwise a
  comma-separated explicit origin list.
- `ORBITPANE_AUTH_TTL_SECONDS`: signed login token lifetime, default 12 hours.
- `ORBITPANE_DATABASE_PATH`: SQLite database location. Tests always use an
  isolated temporary database and never share production persistence.
- Agent filesystem permissions are selected per project. New projects default to
  unrestricted mode; workspace-restricted mode can be selected explicitly.

In development, an unset PIN and signing secret are replaced with process-local
random values, so login credentials and sessions do not survive a restart.
Configure both values explicitly when interactive login is needed. Production
refuses to start without both authentication settings.

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
cd /srv/orbitpane/frontend
npm ci
npm run build
```

Start the backend after exporting the production environment:

```bash
cd /srv/orbitpane
pm2 start backend/main.py --name orbitpane-backend --interpreter python3
pm2 save
```

After backend changes:

```bash
pm2 restart orbitpane-backend --update-env
pm2 status orbitpane-backend
```

Minimal same-origin Nginx layout:

```nginx
server_name orbitpane.hzycode.com;

location / {
    root /srv/orbitpane/frontend/dist;
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
WebSocket protocol as Antigravity.

```bash
export CODEX_ENABLED=true
export CODEX_SANDBOX=workspace-write
```

Model lists are discovered once per backend process from `antigravity models`
(or `agy models`, when configured as the command) and `codex debug models`.
`ORBITPANE_ANTIGRAVITY_MODELS` and `CODEX_MODELS` can still be set to a
comma-separated list when an explicit allowlist is preferred. If discovery
fails, the built-in defaults are used as a fallback.

The provider abstraction can later be replaced by the official Python
`openai-codex` SDK without changing application routes or frontend state. The
official SDK is suitable for embedding coding-focused Codex threads in an
application, while JSONL non-interactive mode provides machine-readable agent
events:

- <https://developers.openai.com/codex/sdk/>
- <https://developers.openai.com/codex/noninteractive/>

## Conversation sharing

Any project can be published as a read-only snapshot at `/s/<token>`. The page
needs no session, and it is a copy rather than a view: turns added after the
link was created never appear in it.

- The token is 192 bits from `secrets.token_urlsafe`. Only its SHA-256 digest is
  stored, so a database copy is not also a set of working links.
- A snapshot carries the conversation and nothing else. The workspace path, run
  ids, per-run character accounting and feedback ratings stay private, and the
  agent's execution transcript is included only when the sender asks for it.
- Links can be given a 7- or 30-day expiry. Expiry deletes the stored snapshot
  rather than hiding it; revoking takes effect immediately.
- At most 20 links per project, so the list of what is public stays reviewable.
- `GET /api/shared/{token}` is the only unauthenticated read in the application.
  It is rate-limited per client, answers `404` for unknown and revoked tokens
  alike, and is served with `X-Robots-Tag: noindex` and
  `Referrer-Policy: no-referrer`. The HTML is covered by `robots.txt` and a
  page-level `noindex`.
- Visitors do not download the application bundle and no service worker is
  registered for them.

### Deleted content stops being served

Four independent mechanisms, because a public copy outliving the content it
copied is the one failure this feature must not have:

1. `clear_history` and `delete_conversation` delete the project's snapshots
   explicitly, in the same transaction as the content itself.
2. `shares.conversation_id` is `ON DELETE CASCADE`, and startup aborts if
   SQLite's per-connection foreign key pragma is not actually in force.
3. `find_share_by_token_hash` joins `conversations`, so a snapshot whose project
   is gone cannot resolve *even if it is still on disk*. This is the guarantee
   that does not depend on any write path being correct.
4. Expired and orphaned rows are swept at startup, hourly, and whenever the
   owner opens the share panel.

Revocation stops future loads. It cannot reach what a reader already saw, and
SQLite frees the row's bytes without overwriting them until the file is
vacuumed.

### Deployment

`deploy/nginx/` is the source of truth for the reverse proxy:

```bash
sudo cp deploy/nginx/snippets/*.conf /etc/nginx/snippets/
sudo cp deploy/nginx/conf.d/*.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

It sets HSTS, a `script-src 'self'` CSP, `frame-ancestors 'none'` and a
`Permissions-Policy` on every route, marks `/s/` `no-store` and `noindex` at the
HTTP level, and **masks share tokens in the access log** — a capability URL in
plaintext in a log file is a working link. The backend applies the same
redaction to its own Uvicorn access log.

## Security notes

- Every REST endpoint except login and health requires a signed session.
- WebSockets authenticate from the same HttpOnly session cookie.
- Failed PIN attempts are rate-limited in memory.
- Only one task runs per project at a time; additional messages enter an
  editable, reorderable and cancelable FIFO queue.
- Project pins, archives, preferred models and drafts are persisted on the
  server. The browser retains caches and drafts for offline recovery.
- Summary checkpoints create collapsible boundaries directly in the chat while
  retaining the full history for on-demand review.
- Task runs retain status, duration and input/output/context character metrics.
- WebSockets use application-level heartbeats and automatically reconnect.
- Deleting a running conversation interrupts its process group first.
- Agent-produced Markdown does not render raw HTML.
- Provider model IDs are validated server-side.
- Shared snapshots are frozen copies addressed by an unguessable, revocable
  token; possession of the link is the entire grant.
- SQLite uses WAL mode, busy timeouts and indexed conversation history.

This service runs coding agents capable of changing files and executing tools.
Use an OS account, container or VM whose permissions match the intended trust
boundary.
