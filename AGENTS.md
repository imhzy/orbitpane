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
- All non-public endpoints must depend on `require_auth`.
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
