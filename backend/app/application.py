from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import asdict

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
from .models import ChatMessage, ConversationCreate, ConversationUpdate, LoginRequest
from .realtime import AgentBusyError, AgentCoordinator, ConnectionHub
from .security import (
    LoginRateLimiter,
    SESSION_COOKIE_NAME,
    TokenService,
    authenticate_websocket,
    require_auth,
)

logger = logging.getLogger(__name__)


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
        version="2.0.0",
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

    if resolved_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved_settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
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
                samesite="strict",
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

    @app.get("/api/conversations", dependencies=[Depends(require_auth)])
    async def list_conversations():
        return [asdict(item) for item in database.list_conversations()]

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
        return asdict(database.create_conversation(name, str(path), provider.id))

    @app.put(
        "/api/conversations/{conversation_id}",
        dependencies=[Depends(require_auth)],
    )
    async def update_conversation(conversation_id: int, request: ConversationUpdate):
        if coordinator.is_running(conversation_id):
            raise HTTPException(status_code=409, detail="Conversation is currently running")
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
        if request.provider is not None:
            providers.get(request.provider)
        conversation = database.update_conversation(
            conversation_id, name=name, path=path, provider=request.provider
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
        if coordinator.is_running(conversation_id):
            raise HTTPException(status_code=409, detail="Conversation is currently running")
        conversation = database.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            await coordinator.start(
                conversation,
                content="Please summarize the conversation history so far into a concise 'Current Context / State' document. This summary will be used as the sole memory for our future turns. Include key technical decisions, current progress, and pending tasks. Start directly with the summary content and reply in the same language as the conversation.",
                model=None,
                provider_id=None,
                is_summary=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"status": "ok"}

    @app.get("/api/ls", dependencies=[Depends(require_auth)])
    async def list_directory(
        path: str = Query(default="/root", min_length=1, max_length=4096),
        show_hidden: bool = False,
    ):
        try:
            directory = resolved_settings.resolve_allowed_path(path)
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
                if raw_message.get("action") == "interrupt":
                    await coordinator.interrupt(conversation_id)
                    continue
                try:
                    chat_message = ChatMessage.model_validate(raw_message)
                    await coordinator.start(
                        conversation,
                        content=chat_message.content.strip(),
                        model=chat_message.model,
                        provider_id=chat_message.provider,
                    )
                except AgentBusyError as exc:
                    await hub.send(
                        websocket,
                        conversation_id,
                        {
                            "type": "error",
                            "conversation_id": conversation_id,
                            "code": "busy",
                            "content": str(exc),
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
