# OrbitPane

OrbitPane is a secure, self-hosted mission control for running coding agents inside
explicitly allowed server projects. Its browser PWA provides persistent
projects, queued execution, inline summary checkpoints, full-text search,
realtime execution and reconnect support without coupling the UI
protocol to a specific agent provider. Google Antigravity is the default
provider, with OpenAI Codex available behind a feature flag.

## Scheduled agent commands

Open a conversation and choose **定时任务** in its action menu, or the **定时**
tab in the task/context panel. Existing conversations can have multiple tasks,
each with its own prompt, recurrence, IANA timezone (default `Asia/Shanghai`),
and optional context compression. Supported rules are every N minutes/hours,
daily at one or more times, and weekly on selected weekdays at one or more
times. The panel supports editing, pausing, resuming, deleting and running now,
and shows the next trigger, latest result, failures and pending execution count.
Scheduled prompts and replies appear in the normal transcript with a clock
badge; their source name and planned trigger time survive edits and deletion.

The backend runs schedules while the browser is closed. Each accepted trigger
is persisted atomically and joins the existing per-conversation FIFO, including
every occurrence of a busy recurring task. Different conversations can run
concurrently. There is no coalescing and no automatic retry of agent commands.
Run-now requests are idempotent and do not move the next recurring trigger.
Rules survive restarts, but missed triggers are skipped. Existing queued or
running commands are marked interrupted on restart and are not resumed.
The poller tolerates five seconds of normal runtime jitter; older slots are
skipped. Intervals keep their original cadence; editing only a name or prompt
does not reset it. Creating, changing the recurrence or resuming an interval
waits a full period before the first trigger.

Calendar rules use local wall time and store instants in UTC. A nonexistent
daylight-saving time is skipped; a repeated time runs once at its first
occurrence. These policies follow the distinction between scheduling deadlines
and execution concurrency in the [APScheduler user guide](https://apscheduler.readthedocs.io/en/3.x/userguide.html)
and use Python's [IANA timezone support](https://docs.python.org/3/library/zoneinfo.html).

Compression runs when the command reaches the front of the queue, using the
latest conversation context and the provider's checkpoint capability. The
current stateless CLI adapters generate a summary checkpoint, retain the
original messages, and use the summary for subsequent turns. A failed or
interrupted compression stops the scheduled command and records its reason.
Commands inherit the conversation's agent, model and filesystem permissions;
scheduling never grants additional permissions. Completed commands and failed
scheduled commands use the existing opt-in browser/Web Push notifications.

Pausing stops future triggers while accepted queue items remain. Deleting a
schedule cancels its pending items and lets its running command finish.
Deleting a conversation removes its schedules; clearing its history cancels
accepted commands and removes execution history while retaining the recurrence
rules. Authenticated schedule APIs live under `/api/conversations/{id}/schedules`;
`GET /api/schedules` lists the owner's schedules. Use one backend process, as
with the existing PM2 fork deployment: conversation execution queues belong to
that process. Tests use isolated databases and fake agents.

## Task-completion push notifications

iOS/iPadOS 16.4+ supports notifications for HTTPS PWAs installed on the Home
Screen. OrbitPane uses standard Web Push with VAPID and encrypted payloads;
Apple delivers these through APNs. No native APNs certificate, `.p8` key, or
Apple Developer membership is needed. Chrome and Firefox Web Push also work.

After installing backend dependencies, generate the server key once:

```bash
python3 -m backend.setup_push --subject https://your-orbitpane.example.com
pm2 restart orbitpane-backend --update-env
```

This writes `ORBITPANE_PUSH_VAPID_PRIVATE_KEY` (base64url DER P-256 key) and
`ORBITPANE_PUSH_VAPID_SUBJECT` into the gitignored `.env`, without printing the
private key. Back up that key with the deployment configuration. Rotating it
requires devices to enable notifications again. Without a key, push is disabled.
The subject can also be a real `mailto:` contact address.

On iPhone, use Safari's **Add to Home Screen**, open OrbitPane from that icon,
log in, and select **开启任务通知** in the sidebar. Accept the system permission
prompt. Existing installations should apply the app update first. The same
button disables notifications on that device; explicit logout removes its
subscription. Browser permission denial must be changed in system settings.

Each successfully completed task, including queued tasks and summaries,
notifies subscribed devices even when the app is closed. Failed or interrupted
tasks do not send a success notification. Failed scheduled commands send a
generic failure notification. Notifications contain only a generic
completion message, and tapping one opens the corresponding conversation
(`/?id=…`), with login required when the session has expired.

Delivery jobs are persisted atomically with task completion and survive backend
restarts. Network errors, HTTP 429 and 5xx responses retry with backoff for up
to 24 hours; 404/410 subscriptions are removed. Clearing history, deleting a
conversation, or unsubscribing removes its pending delivery jobs. The push
service may accept a send just before a process crash; stable notification tags
coalesce a retried send on the device. The host needs outbound HTTPS access to
the browser's push service (Apple uses `*.push.apple.com`). This is a single-owner
workspace: all devices that opted in receive completions across its projects.

Notification regressions:

```bash
python3 -m unittest backend.tests.test_notifications -v
node --test frontend/tests/push-worker.test.mjs
```

For a device check, start a task, background or close the PWA, wait for completion,
and tap the notification to verify that the right conversation opens. Focus
modes and system notification settings may affect presentation.

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
- `ORBITPANE_WEBAUTHN_ORIGIN`: exact public HTTPS origin for passkeys, for
  example `https://orbitpane.hzycode.com`. The hostname is the WebAuthn RP ID;
  it is never taken from request headers. For local Vite development use
  `http://localhost:5173`. If unset, passkey operations are disabled and PIN
  login continues to work.
- `ORBITPANE_DATABASE_PATH`: SQLite database location. Tests always use an
  isolated temporary database and never share production persistence.
- Agent filesystem permissions are selected per project. New projects default to
  workspace-restricted mode; unrestricted mode requires an explicit choice.

In development, an unset PIN and signing secret are replaced with process-local
random values, so login credentials and sessions do not survive a restart.
Configure both values explicitly when interactive login is needed. Production
refuses to start without both authentication settings.

### Passkey login (iOS and other supported devices)

The browser remembers the last successful sign-in method and opens it by default.
With no saved preference, the login screen defaults to **使用通行密钥登录**;
**使用 PIN 登录** remains available. In the PIN view, passkeys remain a prominent
one-click action. First sign in with your existing PIN, then select **绑定通行密钥**
in the sidebar. Accept the system prompt to save the passkey (for example in
iCloud Keychain). Subsequent logins can use Face ID, Touch ID, or the device's
verification method. Cancelling a prompt never removes the PIN fallback.
Browsers without WebAuthn or a secure context show the PIN form directly.

Registration requires an authenticated session. Both ceremonies verify the
configured origin, RP ID, user verification and a browser-bound, single-use
challenge expiring after five minutes. Public login options do not expose
registered credential IDs. Public keys and signature counters persist in
SQLite; private keys stay with the authenticator. Synced passkeys with zero
signature counters are supported. Keep your PIN as a recovery method if a
device or passkey is lost, and keep the public hostname stable.

The backend uses [py_webauthn](https://duo-labs.github.io/py_webauthn/registration.html)
for registration and signature verification.

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

An `error` notification does not immediately stop a running Codex process:
the adapter keeps listening for recovery and requires `turn.completed` before
accepting an answer. An unresolved error without further work is allowed 120
seconds to recover. Confirmed capacity, rate-limit, and recognized transient
connection failures get up to three continuations after 5, 15, and 30 seconds.
The UI shows the recovery status, and Stop also cancels a pending retry.

Codex session files are now persisted by the CLI (no `--ephemeral`) so automatic
recovery can use `exec resume` with the exact thread ID and the same model and
permissions. Recovery asks the agent to check saved work and continue only
unfinished actions. The original task is retried without a thread only if no
agent/tool work has started. Authentication, quota, and other permanent errors
are not automatically retried. This recovery applies within a running task;
it does not resume tasks across a backend restart.

```bash
export CODEX_ENABLED=true
export CODEX_SANDBOX=workspace-write
export CODEX_REASONING_SUMMARY=detailed
```

`CODEX_REASONING_SUMMARY` accepts `auto`, `concise`, `detailed`, or `none` and
defaults to `detailed`, so supported Codex models publish useful reasoning
summaries to the execution timeline. This does not enable raw hidden reasoning.

Each reasoning effort a Codex model supports (its `supported_reasoning_levels`
in `codex debug models`) is offered as a model entry of its own, the way the
Antigravity ids already carry theirs: `gpt-5.5@high` runs `gpt-5.5` with
`model_reasoning_effort="high"`. The bare slug, labelled *Default*, passes no
effort, so Codex falls back to `model_reasoning_effort` in the server's
`~/.codex/config.toml` — which the Codex TUI rewrites whenever a level is picked
there — and, when that is unset, to the model's own `default_reasoning_level`.
Projects created before the levels were listed keep the bare slug and so behave
as they did. `CODEX_MODELS` accepts the same `slug@effort` form for a shorter
list.

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

- The token is 192 bits from `secrets.token_urlsafe`. Resolution is by SHA-256
  digest; a second copy is stored sealed with AES-GCM under a key derived from
  `ORBITPANE_AUTH_SECRET`, which is what lets the share panel show a link again
  rather than only revoke it. The secret lives in the environment and not in
  the database, so a stolen `history.db` is still not a set of working links.
  Rotating the secret leaves existing links working but no longer listable with
  their address, and links created before this was kept list the same way.
- The share panel lists every live link of the open project with its address,
  snapshot date, view count and expiry, so a link handed out last week can be
  copied again from the app that made it.
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
