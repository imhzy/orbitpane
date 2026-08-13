from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

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
    ConversationCreate,
    ConversationUpdate,
    LoginRequest,
    QueueReorder,
    QueueUpdate,
    SummaryUpdate,
)
from .realtime import AgentCoordinator, ConnectionHub
from .security import (
    LoginRateLimiter,
    SESSION_COOKIE_NAME,
    TokenService,
    authenticate_websocket,
    require_auth,
)

logger = logging.getLogger(__name__)

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

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        database.migrate()
        yield
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
    app.state.login_limiter = LoginRateLimiter()
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
            "models": list(selected.models),
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
        if coordinator.is_running(conversation_id):
            raise HTTPException(status_code=409, detail="Conversation is currently running")
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        database.clear_messages(conversation_id)
        return {"status": "ok"}

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
