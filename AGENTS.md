# Repository Guide

## Scope

This repository contains a FastAPI backend in `backend/` and a React/Vite PWA
in `frontend/`. Preserve unrelated user changes in the working tree.

## Architecture rules

- Keep HTTP/WebSocket concerns in `backend/app/application.py`.
- Keep persistence behind `backend/app/database.py`.
- Agent-specific behavior belongs under `backend/app/agents/` and must
  implement `AgentProvider`.
- Do not add provider conditionals to the transport or frontend protocol.
- All filesystem paths must pass through `Settings.resolve_allowed_path`.
- All non-public endpoints must depend on `require_auth`. `GET
  /api/shared/{token}` is the only intentional exception: keep it
  token-addressed, rate-limited, and free of workspace metadata.
- A share snapshot is stored once at creation and never re-read from
  `messages`. Do not turn it into a live view of the conversation.
- A share must never outlive the conversation it copied. `find_share_by_token_hash`
  joins `conversations` so resolution is impossible once the source is gone; keep
  that join, and keep the explicit `DELETE FROM shares` in both `clear_history`
  and `delete_conversation` even though the FK cascade duplicates it.
- Share tokens must never be written to a log. `ShareTokenLogFilter` covers the
  Uvicorn access log and the `map` in `deploy/nginx/` covers Nginx; any new
  logging around `/api/shared/` or `/s/` has to redact too.
- Reverse proxy configuration lives in `deploy/nginx/` and is the source of
  truth for what is installed under `/etc/nginx`. Note that Nginx's `add_header`
  replaces rather than merges, so every location includes the security snippet
  and `/s/` must not `try_files` into `location /`.
- Never enable unrestricted agent permissions by default.
- Frontend REST calls must use `frontend/src/lib/api.ts`.
- Do not re-enable raw HTML rendering for agent Markdown.

## Verification

Run all of the following after relevant changes:

```bash
python3 -m unittest discover -s backend/tests -v
python3 -m compileall -q backend
cd frontend && npm run lint && npm run build
```

After backend changes on the deployed Linux host:

```bash
pm2 restart orbitpane-backend --update-env
pm2 status orbitpane-backend
```

After frontend changes, ensure `frontend/dist` is rebuilt.
