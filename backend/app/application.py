from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from collections.abc import Sequence
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .agents.base import ProviderError
from .agents.registry import ProviderRegistry
from .config import Settings
from .database import Database
from .models import (
    ChatMessage,
    Conversation,
    ConversationCreate,
    ConversationUpdate,
    LoginRequest,
    Message,
    MessageFeedbackUpdate,
    QueueReorder,
    QueueUpdate,
    ShareCreate,
    SummaryUpdate,
)
from .realtime import AgentCoordinator, ConnectionHub
from .security import (
    LoginRateLimiter,
    SESSION_COOKIE_NAME,
    SHARE_TOKEN_PATTERN,
    ShareTokenCipher,
    TokenService,
    authenticate_websocket,
    hash_share_token,
    new_share_token,
    require_auth,
)

logger = logging.getLogger(__name__)

#: Public, unauthenticated read path. Everything under it is addressed by a
#: capability token rather than a session.
SHARE_API_PREFIX = "/api/shared/"
#: Client-side route that renders a snapshot. Returned as a path so the link is
#: built from the origin the browser is already on, never from a Host header.
SHARE_URL_PREFIX = "/s/"
SHARE_SNAPSHOT_VERSION = 1
SHARE_SNAPSHOT_MAX_CHARS = 4_000_000
#: Every snapshot is a full second copy of the conversation, and every live one
#: is a separate URL the owner would have to remember to revoke. Bounded so a
#: stuck client cannot quietly turn one project into hundreds of public copies.
SHARE_MAX_PER_CONVERSATION = 20
#: Expiry is a promise about wall-clock time, so it cannot depend on someone
#: opening the link or the share panel again.
SHARE_SWEEP_INTERVAL_SECONDS = 3600
#: `system` rows are transport notices, not conversation.
SHAREABLE_ROLES = frozenset({"user", "agent", "summary"})

FILE_SEARCH_IGNORED_DIRECTORIES = {
    ".git",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
}
FILE_SEARCH_SCAN_LIMIT = 50_000


def _file_match_score(relative_path: str, query: str) -> tuple[int, int, str] | None:
    """Rank a project file using exact, substring, then subsequence matches."""
    normalized_path = relative_path.casefold().replace("\\", "/")
    normalized_query = query.strip().casefold().replace("\\", "/")
    name = normalized_path.rsplit("/", 1)[-1]
    depth = normalized_path.count("/")

    if not normalized_query:
        return (500 + depth, len(normalized_path), normalized_path)
    if name == normalized_query:
        return (0, depth, normalized_path)
    if name.startswith(normalized_query):
        return (20, len(name), normalized_path)
    if normalized_query in name:
        return (40 + name.index(normalized_query), len(name), normalized_path)
    if normalized_query in normalized_path:
        return (100 + normalized_path.index(normalized_query), depth, normalized_path)

    query_index = 0
    first_match = -1
    previous_match = -1
    gap_cost = 0
    for path_index, character in enumerate(normalized_path):
        if character != normalized_query[query_index]:
            continue
        if first_match < 0:
            first_match = path_index
        if previous_match >= 0:
            gap_cost += path_index - previous_match - 1
        previous_match = path_index
        query_index += 1
        if query_index == len(normalized_query):
            return (200 + gap_cost + first_match, depth, normalized_path)
    return None


def _search_workspace_files(
    settings: Settings,
    workspace: Path,
    query: str,
    limit: int,
) -> tuple[list[dict[str, object]], bool]:
    matches: list[tuple[tuple[int, int, str], Path, str]] = []
    scanned = 0
    for directory_path, directory_names, file_names in os.walk(
        workspace,
        topdown=True,
        followlinks=False,
    ):
        current_directory = Path(directory_path)
        directory_names[:] = [
            name
            for name in directory_names
            if name not in FILE_SEARCH_IGNORED_DIRECTORIES
            and not name.startswith(".")
            and not (current_directory / name).is_symlink()
        ]
        for name in file_names:
            scanned += 1
            if scanned > FILE_SEARCH_SCAN_LIMIT:
                break
            if name.startswith("."):
                continue
            candidate = current_directory / name
            if candidate.is_symlink():
                continue
            relative_path = candidate.relative_to(workspace).as_posix()
            score = _file_match_score(relative_path, query)
            if score is None:
                continue
            matches.append((score, candidate, relative_path))
        if scanned > FILE_SEARCH_SCAN_LIMIT:
            break

    matches.sort(key=lambda match: match[0])
    items: list[dict[str, object]] = []
    for _, candidate, relative_path in matches:
        if len(items) >= limit:
            break
        try:
            resolved_candidate = settings.resolve_allowed_path(str(candidate))
        except ValueError:
            continue
        if workspace != resolved_candidate and workspace not in resolved_candidate.parents:
            continue
        items.append(
            {
                "name": candidate.name,
                "path": str(resolved_candidate),
                "relative_path": relative_path,
            }
        )
    return items, (scanned > FILE_SEARCH_SCAN_LIMIT or len(matches) > len(items))


def _redact_share_token(value: str) -> str:
    """Replace a capability token in a request path with a placeholder."""
    for prefix in (SHARE_API_PREFIX, SHARE_URL_PREFIX):
        if value.startswith(prefix):
            return f"{prefix}<redacted>"
    return value


class ShareTokenLogFilter(logging.Filter):
    """Keep share tokens out of the access log.

    `GET /api/shared/<token>` *is* the credential, and a log file is copied,
    tailed, shipped and pasted into issues far more casually than a database
    ever is. Redacting at the logger means a token never reaches disk in the
    first place, rather than being scrubbed afterwards.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _redact_share_token(arg) if isinstance(arg, str) else arg
                for arg in record.args
            )
        return True


def _share_expiry(days: int | None) -> str | None:
    if days is None:
        return None
    deadline = datetime.now(timezone.utc) + timedelta(days=days)
    return deadline.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _owner_share_response(
    share: dict[str, Any], cipher: ShareTokenCipher
) -> dict[str, Any]:
    """Turn a stored share row into what its owner is allowed to see.

    `token_cipher` is storage and never API: it is unsealed here into the same
    `url_path` the creation response returns, or into a null that means "this
    link still works, but we can no longer show you what it is". The column
    itself must not reach the client, so it is dropped rather than overwritten.
    """
    token = cipher.decrypt(share.get("token_cipher"))
    return {
        **{key: value for key, value in share.items() if key != "token_cipher"},
        "url_path": f"{SHARE_URL_PREFIX}{token}" if token else None,
    }


def _is_expired(expires_at: str | None) -> bool:
    if not expires_at:
        return False
    try:
        deadline = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        # An unparseable deadline is treated as reached: a link nobody can date
        # must not be a link that never ends.
        return True
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    return deadline <= datetime.now(timezone.utc)


def _build_share_snapshot(
    conversation: Conversation,
    messages: Sequence[Message],
    *,
    include_thoughts: bool,
) -> dict[str, object]:
    """Freeze what the chat shows into a self-contained public document.

    Deliberately narrower than the stored history. The workspace path, run ids,
    per-run character accounting and thumb ratings describe the machine and its
    operator rather than the conversation, and a snapshot handed to a stranger
    is the wrong place for any of them.
    """
    return {
        "version": SHARE_SNAPSHOT_VERSION,
        "title": conversation.name,
        "include_thoughts": include_thoughts,
        "messages": [
            {
                "id": message.id,
                "role": message.role,
                "content": message.content,
                "timestamp": message.timestamp,
                "model": message.model,
                "duration": round(message.duration, 1),
                **(
                    {"thought": message.thought}
                    if include_thoughts and message.thought
                    else {}
                ),
            }
            for message in messages
            if message.role in SHAREABLE_ROLES and message.content.strip()
        ],
    }


def _workspace_git_status(workspace: Path) -> dict[str, object]:
    """Return a bounded, read-only Git change summary for the UI radar."""
    try:
        root_result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if root_result.returncode != 0:
            return {"is_git": False, "branch": "", "files": [], "counts": {}}
        status_result = subprocess.run(
            [
                "git",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--",
                ".",
            ],
            cwd=workspace,
            capture_output=True,
            timeout=8,
            check=False,
        )
        branch_result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {"is_git": False, "branch": "", "files": [], "counts": {}}

    entries = status_result.stdout.decode("utf-8", errors="replace").split("\0")
    files: list[dict[str, str]] = []
    counts = {"added": 0, "modified": 0, "deleted": 0, "renamed": 0, "untracked": 0}
    index = 0
    while index < len(entries) and len(files) < 200:
        entry = entries[index]
        index += 1
        if not entry or len(entry) < 4:
            continue
        code = entry[:2]
        path = entry[3:]
        if "R" in code and index < len(entries):
            renamed_to = entries[index]
            index += 1
            path = renamed_to or path
        if code == "??":
            kind = "untracked"
        elif "D" in code:
            kind = "deleted"
        elif "R" in code:
            kind = "renamed"
        elif "A" in code:
            kind = "added"
        else:
            kind = "modified"
        counts[kind] += 1
        files.append({"path": path, "status": kind, "code": code})
    return {
        "is_git": True,
        "branch": branch_result.stdout.strip(),
        "files": files,
        "counts": counts,
        "truncated": len(files) >= 200,
    }


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    database = Database(resolved_settings.database_path)
    providers = ProviderRegistry(resolved_settings)
    hub = ConnectionHub()
    coordinator = AgentCoordinator(database, providers, hub)

    async def sweep_dead_shares() -> None:
        """Delete expired and orphaned snapshots on a timer.

        `migrate()` sweeps at startup and `list_shares` sweeps when the owner
        looks, but a link nobody touches again is exactly the one whose stored
        copy matters most — this process can stay up for weeks.
        """
        while True:
            await asyncio.sleep(SHARE_SWEEP_INTERVAL_SECONDS)
            try:
                removed = await asyncio.to_thread(database.purge_dead_shares)
                if removed:
                    logger.info("Purged %d dead share snapshot(s)", removed)
            except Exception:
                # A failed sweep is a retry next hour, never a dead process.
                logger.exception("Share snapshot sweep failed")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        database.migrate()
        sweeper = asyncio.create_task(sweep_dead_shares())
        yield
        sweeper.cancel()
        await coordinator.shutdown()

    app = FastAPI(
        title="OrbitPane",
        version="2.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if resolved_settings.environment == "development" else None,
        redoc_url=None,
    )
    app.state.settings = resolved_settings
    app.state.database = database
    app.state.providers = providers
    app.state.hub = hub
    app.state.coordinator = coordinator
    app.state.tokens = TokenService(
        resolved_settings.auth_pin,
        resolved_settings.auth_secret,
        resolved_settings.auth_ttl_seconds,
    )
    # Derived from the signing secret rather than stored: rotating
    # ORBITPANE_AUTH_SECRET makes existing links unshowable, not unusable.
    share_cipher = ShareTokenCipher(resolved_settings.auth_secret)
    app.state.share_cipher = share_cipher
    logging.getLogger("uvicorn.access").addFilter(ShareTokenLogFilter())
    app.state.login_limiter = LoginRateLimiter()
    # Share tokens are far too large to guess, but the public lookup is the one
    # route a stranger can reach, so it gets the same bucketed backpressure the
    # PIN does rather than an unbounded read loop.
    app.state.share_limiter = LoginRateLimiter(max_attempts=60, window_seconds=60)
    cookie_same_site = (
        "none"
        if resolved_settings.environment == "production"
        and resolved_settings.cors_origins
        else "lax"
    )

    if resolved_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved_settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cache-Control"] = (
            "no-store" if request.url.path.startswith("/api/") else "no-cache"
        )
        if request.url.path.startswith(SHARE_API_PREFIX):
            # A shared snapshot is addressed by the token in its own URL. Keep
            # that URL out of search indexes, and out of the Referer header of
            # anything a reader clicks through to.
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        return response

    @app.exception_handler(ProviderError)
    async def provider_error_handler(_, exc: ProviderError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "version": app.version}

    @app.post("/api/login")
    async def login(payload: LoginRequest, request: Request, response: Response):
        client_id = request.client.host if request.client else "unknown"
        if not app.state.login_limiter.check(client_id):
            raise HTTPException(
                status_code=429,
                detail="Too many failed login attempts; try again later",
            )
        if app.state.tokens.verify_pin(payload.pin):
            app.state.login_limiter.reset(client_id)
            token = app.state.tokens.issue()
            response.set_cookie(
                key=SESSION_COOKIE_NAME,
                value=token,
                max_age=resolved_settings.auth_ttl_seconds,
                httponly=True,
                secure=resolved_settings.environment == "production",
                samesite=cookie_same_site,
                path="/",
            )
            return {
                "success": True,
                "expires_in": resolved_settings.auth_ttl_seconds,
            }
        app.state.login_limiter.record_failure(client_id)
        raise HTTPException(status_code=401, detail="Invalid PIN")

    @app.get("/api/session", dependencies=[Depends(require_auth)])
    async def session():
        return {"authenticated": True}

    @app.post("/api/logout", dependencies=[Depends(require_auth)])
    async def logout(response: Response):
        response.delete_cookie(
            key=SESSION_COOKIE_NAME,
            path="/",
            httponly=True,
            secure=resolved_settings.environment == "production",
            samesite=cookie_same_site,
        )
        return {"success": True}

    @app.get("/api/agents", dependencies=[Depends(require_auth)])
    async def agent_catalog():
        return {
            "default_provider": resolved_settings.default_provider,
            "providers": providers.catalog(),
        }

    @app.get("/api/models", dependencies=[Depends(require_auth)])
    async def get_models(provider: str | None = None):
        provider_id = provider or resolved_settings.default_provider
        selected = providers.get(provider_id)
        return {
            "provider": provider_id,
            # Ids paired with the provider's own display names, so adding a
            # model never requires a matching client release.
            "models": selected.model_catalog(),
            "providers": providers.catalog(),
        }

    @app.get("/api/workspace-roots", dependencies=[Depends(require_auth)])
    async def workspace_roots():
        return {
            "roots": [str(root) for root in resolved_settings.allowed_roots],
            "default_root": str(resolved_settings.default_workspace_root),
        }

    @app.get("/api/conversations", dependencies=[Depends(require_auth)])
    async def list_conversations(include_archived: bool = False):
        return [
            asdict(item)
            for item in database.list_conversations(include_archived=include_archived)
        ]

    @app.post(
        "/api/conversations",
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_auth)],
    )
    async def create_conversation(request: ConversationCreate):
        name = request.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Conversation name is required")
        try:
            path = resolved_settings.resolve_allowed_path(request.path)
            provider = providers.get(request.provider)
        except (ValueError, ProviderError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not path.is_dir():
            raise HTTPException(status_code=400, detail="Workspace path must be a directory")
        preferred_model = request.preferred_model.strip()
        if preferred_model:
            preferred_model = provider.validate_model(preferred_model)
        return asdict(
            database.create_conversation(
                name,
                str(path),
                provider.id,
                preferred_model=preferred_model,
                permission_mode=request.permission_mode,
            )
        )

    @app.put(
        "/api/conversations/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    async def update_conversation(conversation_id: int, request: ConversationUpdate):
        if coordinator.is_running(conversation_id) and (
            request.path is not None
            or request.provider is not None
            or request.permission_mode is not None
        ):
            raise HTTPException(
                status_code=409,
                detail="Cannot change path or provider while a task is running",
            )
        name = request.name.strip() if request.name is not None else None
        if request.name is not None and not name:
            raise HTTPException(status_code=422, detail="Conversation name is required")
        path = None
        if request.path is not None:
            try:
                resolved_path = resolved_settings.resolve_allowed_path(request.path)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not resolved_path.is_dir():
                raise HTTPException(status_code=400, detail="Workspace path must be a directory")
            path = str(resolved_path)
        selected_provider = None
        if request.provider is not None:
            selected_provider = providers.get(request.provider)
        preferred_model = request.preferred_model
        if preferred_model:
            current = database.get_conversation(conversation_id)
            provider_id = request.provider or (current.provider if current else None)
            if provider_id is None:
                raise HTTPException(status_code=404, detail="Conversation not found")
            preferred_model = providers.get(provider_id).validate_model(preferred_model)
        conversation = database.update_conversation(
            conversation_id,
            name=name,
            path=path,
            provider=selected_provider.id if selected_provider else None,
            is_pinned=request.is_pinned,
            is_archived=request.is_archived,
            preferred_model=preferred_model,
            permission_mode=request.permission_mode,
            draft=request.draft,
        )
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return asdict(conversation)

    @app.delete(
        "/api/conversations/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    async def delete_conversation(conversation_id: int):
        await coordinator.cancel(conversation_id)
        deleted = database.delete_conversation(conversation_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {"status": "ok"}

    @app.get(
        "/api/history/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    async def get_history(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return [asdict(item) for item in database.list_messages(conversation_id)]

    @app.delete(
        "/api/history/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    async def clear_history(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        await coordinator.clear_history(conversation_id)
        return {"status": "ok"}

    @app.patch(
        "/api/conversations/{conversation_id}/messages/{message_id}/feedback",
        dependencies=[Depends(require_auth)],
    )
    async def set_message_feedback(
        conversation_id: int, message_id: int, request: MessageFeedbackUpdate
    ):
        message = database.set_message_feedback(
            conversation_id, message_id, request.feedback
        )
        if message is None:
            raise HTTPException(status_code=404, detail="Message not found")
        return asdict(message)

    @app.post(
        "/api/conversations/{conversation_id}/summarize",
        dependencies=[Depends(require_auth)],
    )
    async def summarize_conversation(conversation_id: int):
        conversation = database.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            task = await coordinator.submit(
                conversation,
                content="Please summarize the conversation history so far into a concise 'Current Context / State' document. This summary will be used as the sole memory for our future turns. Include key technical decisions, current progress, and pending tasks. Start directly with the summary content and reply in the same language as the conversation.",
                model=None,
                provider_id=None,
                is_summary=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return task

    @app.get(
        "/api/conversations/{conversation_id}/summaries",
        dependencies=[Depends(require_auth)],
    )
    async def list_summaries(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return database.list_summary_checkpoints(conversation_id)

    @app.patch(
        "/api/conversations/{conversation_id}/summaries/{summary_id}",
        dependencies=[Depends(require_auth)],
    )
    async def update_summary(
        conversation_id: int, summary_id: int, request: SummaryUpdate
    ):
        if coordinator.is_running(conversation_id):
            raise HTTPException(status_code=409, detail="Task is currently running")
        title = request.title.strip() if request.title is not None else None
        content = request.content.strip() if request.content is not None else None
        if request.title is not None and not title:
            raise HTTPException(status_code=422, detail="Summary title is required")
        if request.content is not None and not content:
            raise HTTPException(status_code=422, detail="Summary content is required")
        summary = database.update_summary_checkpoint(
            conversation_id,
            summary_id,
            title=title,
            content=content,
            active=request.active,
        )
        if summary is None:
            raise HTTPException(status_code=404, detail="Summary checkpoint not found")
        return summary

    @app.post(
        "/api/conversations/{conversation_id}/shares",
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_auth)],
    )
    async def create_share(conversation_id: int, request: ShareCreate):
        conversation = database.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if database.count_shares(conversation_id) >= SHARE_MAX_PER_CONVERSATION:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This conversation already has the maximum number of share "
                    "links; revoke one before creating another"
                ),
            )
        snapshot = _build_share_snapshot(
            conversation,
            database.list_messages(conversation_id),
            include_thoughts=request.include_thoughts,
        )
        messages = snapshot["messages"]
        if not isinstance(messages, list) or not messages:
            raise HTTPException(status_code=422, detail="Conversation has nothing to share")
        payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        if len(payload) > SHARE_SNAPSHOT_MAX_CHARS:
            raise HTTPException(
                status_code=413, detail="Conversation is too large to share"
            )
        token = new_share_token()
        share = database.create_share(
            conversation_id,
            token_hash=hash_share_token(token),
            token_cipher=share_cipher.encrypt(token),
            title=conversation.name,
            snapshot=payload,
            message_count=len(messages),
            include_thoughts=request.include_thoughts,
            expires_at=_share_expiry(request.expires_in_days),
        )
        # `token` is returned only here; the link list rebuilds `url_path` from
        # the sealed copy instead, and never exposes the raw token again.
        return {
            **_owner_share_response(share, share_cipher),
            "token": token,
            "url_path": f"{SHARE_URL_PREFIX}{token}",
        }

    @app.get(
        "/api/conversations/{conversation_id}/shares",
        dependencies=[Depends(require_auth)],
    )
    async def list_shares(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        shares = [
            _owner_share_response(share, share_cipher)
            for share in database.list_shares(conversation_id)
            if not _is_expired(share["expires_at"])
        ]
        return {"items": shares}

    @app.delete(
        "/api/conversations/{conversation_id}/shares/{share_id}",
        dependencies=[Depends(require_auth)],
    )
    async def revoke_share(conversation_id: int, share_id: int):
        if not database.delete_share(conversation_id, share_id):
            raise HTTPException(status_code=404, detail="Share link not found")
        return {"status": "revoked"}

    @app.get(SHARE_API_PREFIX + "{token}")
    async def read_shared_conversation(token: str, request: Request):
        """The one unauthenticated read in the application.

        The token is the entire credential, so this route stays a dead end for
        anyone who does not already hold one: no session, no enumeration, and
        the same answer for a token that never existed as for one that was
        revoked.
        """
        client_id = request.client.host if request.client else "unknown"
        if not app.state.share_limiter.check(client_id):
            raise HTTPException(
                status_code=429, detail="Too many share lookups; try again later"
            )
        share = (
            database.find_share_by_token_hash(hash_share_token(token))
            if SHARE_TOKEN_PATTERN.match(token)
            else None
        )
        if share is None:
            app.state.share_limiter.record_failure(client_id)
            raise HTTPException(status_code=404, detail="Share link not found")
        if _is_expired(share["expires_at"]):
            # Expiry deletes rather than hides: past its deadline a snapshot
            # should stop existing, not merely stop resolving.
            database.delete_share_by_id(int(share["id"]))
            raise HTTPException(status_code=410, detail="Share link has expired")
        database.record_share_view(int(share["id"]))
        return {
            **json.loads(share["snapshot"]),
            "shared_at": share["created_at"],
            "expires_at": share["expires_at"],
        }

    @app.get("/api/search", dependencies=[Depends(require_auth)])
    async def search(
        q: str = Query(min_length=1, max_length=256),
        limit: int = Query(default=50, ge=1, le=100),
    ):
        query = q.strip()
        if not query:
            raise HTTPException(status_code=422, detail="Search query is required")
        return {"items": database.search(query, limit)}

    @app.get("/api/tasks", dependencies=[Depends(require_auth)])
    async def list_tasks(limit: int = Query(default=100, ge=1, le=200)):
        return {"items": coordinator.task_catalog(limit=limit)}

    @app.get(
        "/api/conversations/{conversation_id}/tasks",
        dependencies=[Depends(require_auth)],
    )
    async def conversation_tasks(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {
            "items": coordinator.task_catalog(conversation_id=conversation_id),
            "queue": coordinator.queue_items(conversation_id),
            "running": coordinator.sync_message(conversation_id),
        }

    @app.patch(
        "/api/conversations/{conversation_id}/queue/{run_id}",
        dependencies=[Depends(require_auth)],
    )
    async def update_queued_task(
        conversation_id: int, run_id: str, request: QueueUpdate
    ):
        content = request.content.strip() if request.content is not None else None
        if request.content is not None and not content:
            raise HTTPException(status_code=422, detail="Task content is required")
        item = await coordinator.update_queued(
            conversation_id,
            run_id,
            content=content,
            model=request.model,
        )
        if item is None:
            raise HTTPException(status_code=404, detail="Queued task not found")
        return item

    @app.delete(
        "/api/conversations/{conversation_id}/queue/{run_id}",
        dependencies=[Depends(require_auth)],
    )
    async def cancel_queued_task(conversation_id: int, run_id: str):
        if not await coordinator.cancel_queued(conversation_id, run_id):
            raise HTTPException(status_code=404, detail="Queued task not found")
        return {"status": "canceled"}

    @app.put(
        "/api/conversations/{conversation_id}/queue",
        dependencies=[Depends(require_auth)],
    )
    async def reorder_queued_tasks(conversation_id: int, request: QueueReorder):
        try:
            queue = await coordinator.reorder_queue(conversation_id, request.run_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"queue": queue}

    @app.get(
        "/api/conversations/{conversation_id}/stats",
        dependencies=[Depends(require_auth)],
    )
    async def conversation_stats(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {
            **database.conversation_stats(conversation_id),
            "context_limit": resolved_settings.history_max_chars,
        }

    @app.get(
        "/api/conversations/{conversation_id}/workspace-status",
        dependencies=[Depends(require_auth)],
    )
    async def workspace_status(conversation_id: int):
        conversation = database.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            workspace = resolved_settings.resolve_allowed_path(conversation.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return await asyncio.to_thread(_workspace_git_status, workspace)

    @app.get("/api/ls", dependencies=[Depends(require_auth)])
    async def list_directory(
        path: str | None = Query(default=None, min_length=1, max_length=4096),
        show_hidden: bool = False,
    ):
        try:
            directory = resolved_settings.resolve_allowed_path(
                path or str(resolved_settings.default_workspace_root)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not directory.is_dir():
            raise HTTPException(status_code=400, detail="Path must be a directory")
        items: list[dict[str, object]] = []
        try:
            for child in directory.iterdir():
                if not show_hidden and child.name.startswith("."):
                    continue
                try:
                    stat_result = child.stat()
                except OSError:
                    continue
                items.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "is_dir": child.is_dir(),
                        "size": stat_result.st_size,
                        "mtime": int(stat_result.st_mtime),
                    }
                )
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="Directory is not readable") from exc
        items.sort(key=lambda item: (not item["is_dir"], str(item["name"]).lower()))
        return {"items": items, "current_path": str(directory)}

    @app.get(
        "/api/conversations/{conversation_id}/files",
        dependencies=[Depends(require_auth)],
    )
    async def search_conversation_files(
        conversation_id: int,
        q: str = Query(default="", max_length=256),
        limit: int = Query(default=50, ge=1, le=100),
    ):
        conversation = database.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            workspace = resolved_settings.resolve_allowed_path(conversation.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not workspace.is_dir():
            raise HTTPException(status_code=400, detail="Conversation path must be a directory")

        items, truncated = await asyncio.to_thread(
            _search_workspace_files,
            resolved_settings,
            workspace,
            q,
            limit,
        )
        return {
            "items": items,
            "truncated": truncated,
        }

    @app.websocket("/api/chat")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        conversation_id: int | None = None
        try:
            config = await asyncio.wait_for(websocket.receive_json(), timeout=10)
            if not await authenticate_websocket(websocket, config.get("token")):
                return
            conversation_id = int(config.get("conversation_id"))
            conversation = database.get_conversation(conversation_id)
            if conversation is None:
                await websocket.send_json(
                    {
                        "type": "error",
                        "conversation_id": conversation_id,
                        "code": "not_found",
                        "content": "Conversation not found",
                    }
                )
                await websocket.close(code=4404)
                return
            await hub.connect(websocket, conversation_id)
            if sync_message := coordinator.sync_message(conversation_id):
                await hub.send(websocket, conversation_id, sync_message)
            else:
                await hub.send(
                    websocket,
                    conversation_id,
                    {"type": "ready", "conversation_id": conversation_id},
                )

            while True:
                raw_message = await websocket.receive_json()
                action = raw_message.get("action")
                if action == "ping":
                    await hub.send(
                        websocket,
                        conversation_id,
                        {"type": "pong", "conversation_id": conversation_id},
                    )
                    continue
                if action == "interrupt":
                    await coordinator.interrupt(conversation_id)
                    continue
                if action == "cancel_queued":
                    run_id = str(raw_message.get("run_id") or "")
                    await coordinator.cancel_queued(conversation_id, run_id)
                    continue
                try:
                    chat_message = ChatMessage.model_validate(raw_message)
                    latest_conversation = database.get_conversation(conversation_id)
                    if latest_conversation is None:
                        raise ValueError("Conversation not found")
                    submitted = await coordinator.submit(
                        latest_conversation,
                        content=chat_message.content.strip(),
                        model=chat_message.model,
                        provider_id=chat_message.provider,
                    )
                    await hub.send(
                        websocket,
                        conversation_id,
                        {
                            "type": "submitted",
                            "conversation_id": conversation_id,
                            "task": submitted,
                        },
                    )
                except (ProviderError, ValueError) as exc:
                    await hub.send(
                        websocket,
                        conversation_id,
                        {
                            "type": "error",
                            "conversation_id": conversation_id,
                            "code": "invalid_request",
                            "content": str(exc),
                        },
                    )
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            logger.exception("Unhandled websocket error")
        finally:
            if conversation_id is not None:
                await hub.disconnect(websocket, conversation_id)

    return app
