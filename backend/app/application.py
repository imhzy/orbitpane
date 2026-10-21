from __future__ import annotations

from .agents.usage import empty_usage

import asyncio
import hashlib
import json
import logging
import os
import secrets
import subprocess
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
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
from webauthn import (
    generate_authentication_options, generate_registration_options,
    options_to_json, verify_authentication_response, verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
    ResidentKeyRequirement, UserVerificationRequirement,
)

from .agents.base import ProviderError, SUMMARY_PROMPT
from .agents.registry import ProviderRegistry
from .config import Settings
from .database import Database
from .plugins import PluginService, PluginUpdate, PluginCreate
from pydantic import ValidationError
from .models import (
    ChatMessage,
    Conversation,
    ConversationCreate,
    ConversationReorder,
    ConversationUpdate,
    LoginRequest,
    PasskeyResponse,
    PushEndpoint,
    PushSubscription,
    Message,
    MessageFeedbackUpdate,
    QueueReorder,
    QueueUpdate,
    ShareCreate,
    SummaryUpdate,
    ScheduleCreate,
    ScheduleUpdate,
    ScheduleRunRequest,
)
from .realtime import AgentCoordinator, ConnectionHub
from .notifications import PushNotifications
from .scheduler import ScheduleService
from .security import (
    LoginRateLimiter,
    SESSION_COOKIE_NAME,
    SHARE_TOKEN_PATTERN,
    ShareTokenCipher,
    TokenService,
    authenticate_websocket,
    bearer_token,
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
#: Workspace walks allowed to run at once; further searches wait for a slot.
FILE_SEARCH_CONCURRENCY = 2
#: Size of the event loop's default executor, which `asyncio.to_thread` uses.
IO_THREADS = 32


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
    providers = ProviderRegistry(resolved_settings, store=database)
    hub = ConnectionHub()
    coordinator = AgentCoordinator(database, providers, hub, resolved_settings)
    scheduler = ScheduleService(database, coordinator, hub)
    notifications = PushNotifications(resolved_settings, database)
    # Walking a large workspace is CPU-bound Python holding the GIL, so running
    # many at once slows the event loop's own thread down, not just the walks.
    file_search_slots = asyncio.Semaphore(FILE_SEARCH_CONCURRENCY)
    #: Newest search per conversation, so an overtaken one can be skipped.
    file_search_generations: dict[int, int] = {}

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
        # `asyncio.to_thread` shares one executor sized from the CPU count —
        # six threads on a two-core host — between quick SQLite calls and jobs
        # that hold a thread for seconds: CLI model probes, git, workspace
        # walks. Six such jobs at once would leave a WebSocket's conversation
        # lookup waiting behind them. These threads mostly wait on disk and
        # subprocesses, so a larger pool costs little.
        asyncio.get_running_loop().set_default_executor(
            ThreadPoolExecutor(
                max_workers=IO_THREADS, thread_name_prefix="orbitpane-io"
            )
        )
        database.migrate()
        await scheduler.prepare()
        schedule_worker = asyncio.create_task(scheduler.run(), name="schedule-worker")
        sweeper = asyncio.create_task(sweep_dead_shares())
        push_worker = asyncio.create_task(notifications.run())
        # Discovering models means shelling out to each agent CLI, so it runs
        # here rather than under the first request: a client that opens the app
        # right after a restart finds the caches already filled. Startup is not
        # held up for it — the probe resolves in the background while the
        # server is already answering.
        prewarm = asyncio.create_task(providers.prewarm())
        yield
        prewarm.cancel()
        sweeper.cancel()
        schedule_worker.cancel()
        await asyncio.gather(schedule_worker, return_exceptions=True)
        await coordinator.shutdown()
        push_worker.cancel()
        await asyncio.gather(push_worker, return_exceptions=True)

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
    app.state.scheduler = scheduler
    app.state.notifications = notifications
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
    app.state.passkey_limiter = LoginRateLimiter(max_attempts=30, window_seconds=60)
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
            return issue_session(response)
        app.state.login_limiter.record_failure(client_id)
        raise HTTPException(status_code=401, detail="Invalid PIN")

    def issue_session(response: Response) -> dict[str, object]:
        response.set_cookie(
            key=SESSION_COOKIE_NAME, value=app.state.tokens.issue(),
            max_age=resolved_settings.auth_ttl_seconds, httponly=True,
            secure=resolved_settings.environment == "production",
            samesite=cookie_same_site, path="/",
        )
        return {"success": True, "expires_in": resolved_settings.auth_ttl_seconds}

    # Authentication ceremonies are public like /api/login. Registration is
    # authenticated, and all four endpoints are restricted to the configured
    # origin (never derived from an untrusted Host/forwarded header).
    challenge_cookie = "orbitpane_webauthn"
    passkey_user_id = b"orbitpane-user"

    def check_passkey_request(request: Request) -> None:
        if not resolved_settings.webauthn_origin:
            raise HTTPException(503, "通行密钥尚未配置，请使用 PIN 登录")
        if request.headers.get("origin") != resolved_settings.webauthn_origin:
            raise HTTPException(403, "Invalid passkey origin")
        client_id = request.client.host if request.client else "unknown"
        if not app.state.passkey_limiter.check(client_id):
            raise HTTPException(429, "操作过于频繁，请稍后重试")
        app.state.passkey_limiter.record_failure(client_id)

    def session_hash(request: Request, purpose: str) -> str:
        return hashlib.sha256((bearer_token(request) or "").encode()).hexdigest() if purpose == "register" else ""

    def save_ceremony(request: Request, response: Response, options: Any, purpose: str):
        challenge_id = secrets.token_urlsafe(32)
        if not database.save_passkey_challenge(
            challenge_id, options.challenge, purpose, session_hash(request, purpose),
            request.cookies.get(challenge_cookie),
        ):
            raise HTTPException(429, "操作过于频繁，请稍后重试")
        response.set_cookie(
            challenge_cookie, challenge_id, max_age=300, httponly=True,
            secure=resolved_settings.environment == "production",
            samesite=cookie_same_site, path="/api/passkeys",
        )
        return json.loads(options_to_json(options))

    def consume_ceremony(request: Request, purpose: str) -> bytes:
        challenge = database.consume_passkey_challenge(
            request.cookies.get(challenge_cookie, ""), purpose, session_hash(request, purpose),
        )
        if challenge is None:
            raise HTTPException(400, "验证已过期，请重试")
        return challenge

    @app.post("/api/passkeys/register/options", dependencies=[Depends(require_auth)])
    async def passkey_register_options(request: Request, response: Response):
        check_passkey_request(request)
        options = generate_registration_options(
            rp_id=resolved_settings.webauthn_rp_id, rp_name="OrbitPane",
            user_id=passkey_user_id, user_name="OrbitPane", user_display_name="OrbitPane",
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.REQUIRED,
                user_verification=UserVerificationRequirement.REQUIRED,
            ),
            exclude_credentials=[PublicKeyCredentialDescriptor(id=value) for value in database.passkey_ids()],
        )
        return save_ceremony(request, response, options, "register")

    @app.post("/api/passkeys/register/verify", dependencies=[Depends(require_auth)])
    async def passkey_register_verify(payload: PasskeyResponse, request: Request):
        check_passkey_request(request)
        challenge = consume_ceremony(request, "register")
        try:
            verified = verify_registration_response(
                credential=payload.credential, expected_challenge=challenge,
                expected_rp_id=resolved_settings.webauthn_rp_id,
                expected_origin=resolved_settings.webauthn_origin,
                require_user_verification=True,
            )
        except (WebAuthnException, ValueError, TypeError, KeyError) as exc:
            raise HTTPException(400, "通行密钥绑定验证失败，请重试") from exc
        if not database.add_passkey(verified.credential_id, verified.credential_public_key, verified.sign_count):
            raise HTTPException(409, "此通行密钥已绑定")
        return {"success": True}

    @app.post("/api/passkeys/login/options")
    async def passkey_login_options(request: Request, response: Response):
        check_passkey_request(request)
        # Discoverable credentials let iCloud Keychain select the passkey;
        # public responses do not disclose registered credential identifiers.
        options = generate_authentication_options(
            rp_id=resolved_settings.webauthn_rp_id,
            user_verification=UserVerificationRequirement.REQUIRED,
        )
        return save_ceremony(request, response, options, "login")

    @app.post("/api/passkeys/login/verify")
    async def passkey_login_verify(payload: PasskeyResponse, request: Request, response: Response):
        check_passkey_request(request)
        challenge = consume_ceremony(request, "login")
        try:
            credential = payload.credential
            saved = database.get_passkey(base64url_to_bytes(credential["rawId"]))
            if saved is None:
                raise ValueError("Unknown credential")
            user_handle = credential.get("response", {}).get("userHandle")
            if not user_handle or base64url_to_bytes(user_handle) != passkey_user_id:
                raise ValueError("Invalid user handle")
            verified = verify_authentication_response(
                credential=credential, expected_challenge=challenge,
                expected_rp_id=resolved_settings.webauthn_rp_id,
                expected_origin=resolved_settings.webauthn_origin,
                credential_public_key=saved["public_key"],
                credential_current_sign_count=saved["sign_count"],
                require_user_verification=True,
            )
        except (WebAuthnException, ValueError, TypeError, KeyError, AttributeError) as exc:
            raise HTTPException(400, "通行密钥验证失败，请重试或使用 PIN 登录") from exc
        if not database.update_passkey_counter(verified.credential_id, saved["sign_count"], verified.new_sign_count):
            raise HTTPException(400, "验证已过期，请重试")
        return issue_session(response)

    @app.get("/api/session", dependencies=[Depends(require_auth)])
    async def session():
        return {"authenticated": True}

    @app.get("/api/push/config", dependencies=[Depends(require_auth)])
    async def push_config():
        return {"enabled": notifications.enabled, "public_key": notifications.public_key}

    @app.put("/api/push/subscription", dependencies=[Depends(require_auth)])
    async def subscribe_push(payload: PushSubscription):
        if not notifications.enabled:
            raise HTTPException(status_code=503, detail="服务器尚未配置推送通知")
        if payload.application_server_key != notifications.public_key:
            raise HTTPException(status_code=409, detail="推送密钥已更新，请重新开启通知")
        try:
            await asyncio.to_thread(database.save_push_subscription, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from None
        return {"success": True}

    @app.delete("/api/push/subscription", dependencies=[Depends(require_auth)])
    async def unsubscribe_push(payload: PushEndpoint):
        await asyncio.to_thread(database.delete_push_subscription, payload.endpoint)
        return {"success": True}

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

    @app.get("/api/plugins", dependencies=[Depends(require_auth)])
    async def global_plugins():
        service = PluginService(database, resolved_settings)
        return {"items": await asyncio.to_thread(service.catalog), "definitions": service.definitions()}

    @app.post("/api/plugins", dependencies=[Depends(require_auth)], status_code=201)
    async def create_plugin(request: PluginCreate):
        service = PluginService(database, resolved_settings)
        try:
            instance_id = await asyncio.to_thread(service.create, request)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {"id": instance_id, "items": await asyncio.to_thread(service.catalog)}

    @app.put("/api/plugins/{instance_id}", dependencies=[Depends(require_auth)])
    async def save_plugin(instance_id: str, request: PluginUpdate):
        service = PluginService(database, resolved_settings)
        try:
            await asyncio.to_thread(service.save, instance_id, request)
        except ValidationError as exc:
            fields = ", ".join(".".join(map(str, e["loc"])) for e in exc.errors(include_input=False))
            raise HTTPException(422, f"请检查插件配置字段：{fields}") from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {"items": await asyncio.to_thread(service.catalog)}

    @app.delete("/api/plugins/{instance_id}", dependencies=[Depends(require_auth)])
    async def delete_plugin(instance_id: str):
        if not await asyncio.to_thread(database.delete_plugin, instance_id):
            raise HTTPException(404, "Plugin not found")
        return {"success": True}

    @app.get("/api/agents", dependencies=[Depends(require_auth)])
    async def agent_catalog():
        return {
            "default_provider": resolved_settings.default_provider,
            "providers": await providers.catalog(),
        }

    @app.get("/api/usage", dependencies=[Depends(require_auth)])
    async def account_usage(provider: str | None = None):
        provider_id = provider if provider is not None else resolved_settings.default_provider
        selected = providers.lookup(provider_id)
        if selected is None:
            raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")
        snapshot = await selected.account_usage()
        return snapshot if snapshot is not None else empty_usage(selected.id, selected.display_name)

    @app.get("/api/models", dependencies=[Depends(require_auth)])
    async def get_models(provider: str | None = None):
        provider_id = provider or resolved_settings.default_provider
        # Only the requested provider is refreshed: the other entries below
        # come from cache, so this list never waits on another CLI's probe.
        catalog = await providers.catalog(refresh=provider_id)
        selected = providers.get(provider_id)
        return {
            "provider": provider_id,
            # Ids paired with the provider's own display names, so adding a
            # model never requires a matching client release.
            "models": selected.model_catalog(),
            "providers": catalog,
        }

    @app.get("/api/workspace-roots", dependencies=[Depends(require_auth)])
    async def workspace_roots():
        return {
            "roots": [str(root) for root in resolved_settings.allowed_roots],
            "default_root": str(resolved_settings.default_workspace_root),
        }

    @app.get("/api/conversations", dependencies=[Depends(require_auth)])
    def list_conversations(include_archived: bool = False):
        return [
            asdict(item)
            for item in database.list_conversations(include_archived=include_archived)
        ]

    @app.post(
        "/api/conversations",
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_auth)],
    )
    def create_conversation(request: ConversationCreate):
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

    @app.post("/api/conversations/reorder", dependencies=[Depends(require_auth)])
    def reorder_conversations(request: ConversationReorder):
        try:
            ordered = database.reorder_conversations(request.conversation_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return [asdict(item) for item in ordered]

    @app.put(
        "/api/conversations/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    def update_conversation(conversation_id: int, request: ConversationUpdate):
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
        async with scheduler.lock:
            await coordinator.cancel(conversation_id)
            deleted = await asyncio.to_thread(database.delete_conversation, conversation_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {"status": "ok"}

    @app.get(
        "/api/history/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    def get_history(
        conversation_id: int,
        limit: int | None = Query(default=None, ge=1, le=200),
        before_id: int | None = Query(default=None, ge=1),
        after_id: int | None = Query(default=None, ge=0),
    ):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if before_id is not None and after_id is not None:
            raise HTTPException(status_code=422, detail="Use only one history cursor")
        if limit is not None:
            items, more, first_id = database.message_page(
                conversation_id, limit, before_id=before_id, after_id=after_id,
            )
            return {"items": [asdict(item) for item in items], "has_more": more, "first_id": first_id}
        return [asdict(item) for item in database.list_messages(conversation_id)]

    @app.delete(
        "/api/history/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    async def clear_history(conversation_id: int):
        if await asyncio.to_thread(database.get_conversation, conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        async with scheduler.lock:
            await coordinator.clear_history(conversation_id)
            await scheduler.changed(conversation_id)
        return {"status": "ok"}

    @app.patch(
        "/api/conversations/{conversation_id}/messages/{message_id}/feedback",
        dependencies=[Depends(require_auth)],
    )
    def set_message_feedback(
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
        conversation = await asyncio.to_thread(database.get_conversation, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            task = await coordinator.submit(
                conversation,
                content=SUMMARY_PROMPT,
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
    def list_summaries(conversation_id: int):
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return database.list_summary_checkpoints(conversation_id)

    @app.patch(
        "/api/conversations/{conversation_id}/summaries/{summary_id}",
        dependencies=[Depends(require_auth)],
    )
    def update_summary(
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
    def create_share(conversation_id: int, request: ShareCreate):
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
    def list_shares(conversation_id: int):
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
    def revoke_share(conversation_id: int, share_id: int):
        if not database.delete_share(conversation_id, share_id):
            raise HTTPException(status_code=404, detail="Share link not found")
        return {"status": "revoked"}

    @app.get(SHARE_API_PREFIX + "{token}")
    def read_shared_conversation(token: str, request: Request):
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
    def search(
        q: str = Query(min_length=1, max_length=256),
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        query = q.strip()
        if not query:
            raise HTTPException(status_code=422, detail="Search query is required")
        items = database.search(query, limit + 1, offset)
        return {"items": items[:limit], "has_more": len(items) > limit}

    @app.get("/api/tasks", dependencies=[Depends(require_auth)])
    async def list_tasks(limit: int = Query(default=100, ge=1, le=200)):
        return {"items": await coordinator.task_catalog(limit=limit)}

    @app.get("/api/schedules", dependencies=[Depends(require_auth)])
    async def all_schedules():
        return {"items": await asyncio.to_thread(database.list_schedules)}

    @app.get("/api/conversations/{conversation_id}/schedules", dependencies=[Depends(require_auth)])
    async def conversation_schedules(conversation_id: int):
        if await asyncio.to_thread(database.get_conversation, conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {"items": await asyncio.to_thread(database.list_schedules, conversation_id)}

    @app.post("/api/conversations/{conversation_id}/schedules", status_code=201,
              dependencies=[Depends(require_auth)])
    async def create_schedule(conversation_id: int, request: ScheduleCreate):
        async with scheduler.lock:
            conversation = await asyncio.to_thread(database.get_conversation, conversation_id)
            if conversation is None:
                raise HTTPException(status_code=404, detail="Conversation not found")
            try:
                resolved_settings.resolve_allowed_path(conversation.path)
                result = await asyncio.to_thread(database.create_schedule, conversation_id, **request.model_dump())
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            await scheduler.changed(conversation_id)
            return result

    @app.patch("/api/conversations/{conversation_id}/schedules/{schedule_id}",
               dependencies=[Depends(require_auth)])
    async def update_schedule(conversation_id: int, schedule_id: int, request: ScheduleUpdate):
        async with scheduler.lock:
            try:
                result = await asyncio.to_thread(database.update_schedule, conversation_id, schedule_id,
                                                request.model_dump(exclude_unset=True))
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if result is None:
                raise HTTPException(status_code=404, detail="Schedule not found")
            await scheduler.changed(conversation_id)
            return result

    @app.delete("/api/conversations/{conversation_id}/schedules/{schedule_id}",
                dependencies=[Depends(require_auth)])
    async def delete_schedule(conversation_id: int, schedule_id: int):
        async with scheduler.lock:
            if await asyncio.to_thread(database.get_schedule, conversation_id, schedule_id) is None:
                raise HTTPException(status_code=404, detail="Schedule not found")
            await coordinator.cancel_scheduled_queue(conversation_id, schedule_id)
            await asyncio.to_thread(database.delete_schedule, conversation_id, schedule_id)
            await scheduler.changed(conversation_id)
        return {"status": "ok"}

    @app.post("/api/conversations/{conversation_id}/schedules/{schedule_id}/run",
              dependencies=[Depends(require_auth)])
    async def run_schedule(conversation_id: int, schedule_id: int, request: ScheduleRunRequest):
        async with scheduler.lock:
            try:
                run_id = await asyncio.to_thread(database.create_schedule_run, conversation_id, schedule_id,
                                                request.request_id)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if run_id is None:
                raise HTTPException(status_code=404, detail="Schedule not found")
            result = await coordinator.submit_scheduled_run(run_id)
            await scheduler.changed(conversation_id)
            return result

    @app.get(
        "/api/conversations/{conversation_id}/tasks",
        dependencies=[Depends(require_auth)],
    )
    async def conversation_tasks(conversation_id: int):
        # Async on purpose: the queue and the running state live on the event
        # loop, so they are read here while only the SQLite parts go to a thread.
        if await asyncio.to_thread(database.get_conversation, conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {
            "items": await coordinator.task_catalog(conversation_id=conversation_id),
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
    def conversation_stats(conversation_id: int):
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
        conversation = await asyncio.to_thread(database.get_conversation, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            workspace = resolved_settings.resolve_allowed_path(conversation.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return await asyncio.to_thread(_workspace_git_status, workspace)

    @app.get(
        "/api/conversations/{conversation_id}/workspace-diff",
        dependencies=[Depends(require_auth)],
    )
    async def workspace_diff(conversation_id: int):
        """Read only tracked changes under the allowed project directory."""
        conversation = await asyncio.to_thread(database.get_conversation, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            workspace = resolved_settings.resolve_allowed_path(conversation.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        process = None
        limit = 256_000
        try:
            process = await asyncio.create_subprocess_exec(
                "git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv",
                "--no-color", "HEAD", "--", ".",
                cwd=workspace, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            # read(n) may return a short chunk; consume until EOF or the cap.
            async def collect():
                chunks = []
                size = 0
                while size <= limit:
                    chunk = await process.stdout.read(min(65536, limit + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                if size > limit:
                    if process.returncode is None:
                        process.kill()
                    # Drain the pipe after termination so wait cannot deadlock.
                    await process.communicate()
                else:
                    await process.wait()
                return b"".join(chunks)
            output = await asyncio.wait_for(collect(), timeout=8)
            truncated = len(output) > limit
            if process.returncode != 0 and not truncated:
                raise HTTPException(status_code=422, detail="无法读取差异，请确认目录是已有提交的 Git 仓库。")
            return {"diff": output[:limit].decode("utf-8", errors="replace"),
                    "truncated": truncated,
                    "scope": "当前项目目录中已跟踪文件相对 HEAD 的改动；不包含未跟踪文件。"}
        except (OSError, asyncio.TimeoutError) as exc:
            raise HTTPException(status_code=503, detail="差异读取失败或超时，请稍后重试。") from exc
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.communicate()

    @app.get(
        "/api/conversations/{conversation_id}/share-preview",
        dependencies=[Depends(require_auth)],
    )
    def share_preview(conversation_id: int, include_thoughts: bool = False):
        conversation = database.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return _build_share_snapshot(
            conversation, database.list_messages(conversation_id),
            include_thoughts=include_thoughts,
        )

    @app.get("/api/ls", dependencies=[Depends(require_auth)])
    def list_directory(
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
        conversation = await asyncio.to_thread(database.get_conversation, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            workspace = resolved_settings.resolve_allowed_path(conversation.path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not workspace.is_dir():
            raise HTTPException(status_code=400, detail="Conversation path must be a directory")

        generation = file_search_generations.get(conversation_id, 0) + 1
        file_search_generations[conversation_id] = generation
        async with file_search_slots:
            # The @-picker supersedes its search on every keystroke and only
            # reads the newest answer. One overtaken by a newer search for the
            # same project while it waited here is skipped rather than walked,
            # so the query on screen is not queued behind stale ones. (Client
            # disconnects cannot stand in for this: behind the HTTP middleware
            # `Request.is_disconnected()` never reports one.)
            if file_search_generations.get(conversation_id) != generation:
                return {"items": [], "truncated": False}
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
            conversation = await asyncio.to_thread(
                database.get_conversation, conversation_id
            )
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
                    latest_conversation = await asyncio.to_thread(
                        database.get_conversation, conversation_id
                    )
                    if latest_conversation is None:
                        raise ValueError("Conversation not found")
                    submitted = await coordinator.submit(
                        latest_conversation,
                        content=chat_message.content.strip(),
                        model=chat_message.model,
                        provider_id=chat_message.provider,
                        request_id=chat_message.request_id,
                    )
                    await hub.send(
                        websocket,
                        conversation_id,
                        {
                            "type": "submitted",
                            "request_id": chat_message.request_id,
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
                            "request_id": raw_message.get("request_id"),
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
