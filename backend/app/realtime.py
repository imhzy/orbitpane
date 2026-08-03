from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

logger = logging.getLogger(__name__)

from .agents.base import AgentEvent, AgentRequest, ProviderError
from .agents.registry import ProviderRegistry
from .database import Database
from .models import Conversation


class AgentBusyError(RuntimeError):
    pass


class ConnectionHub:
    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, conversation_id: int) -> None:
        async with self._lock:
            self._connections.setdefault(conversation_id, set()).add(websocket)

    async def disconnect(self, websocket: WebSocket, conversation_id: int) -> None:
        async with self._lock:
            sockets = self._connections.get(conversation_id)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._connections.pop(conversation_id, None)

    async def broadcast(self, conversation_id: int, message: dict[str, object]) -> None:
        async with self._lock:
            sockets = tuple(self._connections.get(conversation_id, ()))
        dead: list[WebSocket] = []
        for websocket in sockets:
            try:
                await websocket.send_json(message)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            await self.disconnect(websocket, conversation_id)


@dataclass(slots=True)
class TaskState:
    provider: str
    model: str
    start_time: float = field(default_factory=time.monotonic)
    content: str = ""
    thought: str = ""


class AgentCoordinator:
    def __init__(
        self, database: Database, providers: ProviderRegistry, hub: ConnectionHub
    ) -> None:
        self.database = database
        self.providers = providers
        self.hub = hub
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._states: dict[int, TaskState] = {}
        self._lock = asyncio.Lock()

    async def start(
        self,
        conversation: Conversation,
        *,
        content: str,
        model: str | None,
        provider_id: str | None,
    ) -> None:
        provider_name = provider_id or conversation.provider
        provider = self.providers.get(provider_name)
        selected_model = provider.validate_model(model or provider.models[0])

        async with self._lock:
            existing = self._tasks.get(conversation.id)
            if existing and not existing.done():
                raise AgentBusyError("Agent is already processing this conversation")

            history = tuple(self.database.list_messages(conversation.id))
            self.database.add_message(
                conversation.id,
                "user",
                content,
                provider=provider_name,
            )
            state = TaskState(provider=provider_name, model=selected_model)
            self._states[conversation.id] = state
            request = AgentRequest(
                run_id=f"{conversation.id}-{uuid.uuid4().hex}",
                conversation_id=conversation.id,
                working_directory=conversation.path,
                prompt=content,
                history=history,
                model=selected_model,
            )
            task = asyncio.create_task(
                self._execute(conversation.id, provider, request, state),
                name=f"agent-{conversation.id}-{request.run_id}",
            )
            self._tasks[conversation.id] = task

    async def _execute(self, conversation_id, provider, request, state) -> None:
        await self.hub.broadcast(
            conversation_id,
            {
                "type": "start",
                "status": "Thinking...",
                "elapsed": 0,
                "model": state.model,
                "provider": state.provider,
            },
        )

        async def emit(event: AgentEvent) -> None:
            if event.type == "token":
                state.content += event.content
            elif event.type == "thought":
                state.thought += event.content
            await self.hub.broadcast(
                conversation_id, {"type": event.type, "content": event.content}
            )

        try:
            result = await provider.run(request, emit)
            state.content = result.content
            state.thought = result.thought
            if not result.content.strip() and not result.interrupted:
                raise ProviderError(
                    "Agent completed without generating text output. "
                    "This usually occurs when a requested tool operation requires permissions or failed to complete."
                )
            duration = round(time.monotonic() - state.start_time, 1)
            self.database.add_message(
                conversation_id,
                "agent",
                result.content,
                thought=result.thought,
                duration=duration,
                model=state.model,
                provider=state.provider,
            )
        except asyncio.CancelledError:
            await provider.interrupt(conversation_id)
            raise
        except ProviderError as exc:
            import logging
            logging.getLogger(__name__).error("ProviderError occurred: %s", exc, exc_info=True)
            await self.hub.broadcast(
                conversation_id,
                {"type": "error", "code": "provider_error", "content": str(exc)},
            )
            duration = round(time.monotonic() - state.start_time, 1)
            if state.content and state.content.strip():
                self.database.add_message(
                    conversation_id,
                    "agent",
                    state.content,
                    thought=state.thought,
                    duration=duration,
                    model=state.model,
                    provider=state.provider,
                )
        except Exception as exc:
            logger.exception("Unexpected error during agent execution for conversation %s: %s", conversation_id, exc)
            await self.hub.broadcast(
                conversation_id,
                {
                    "type": "error",
                    "code": "internal_error",
                    "content": f"Agent execution failed unexpectedly: {exc}",
                },
            )
        finally:
            duration = round(time.monotonic() - state.start_time, 1)
            await self.hub.broadcast(
                conversation_id, {"type": "done", "duration": duration}
            )
            async with self._lock:
                self._tasks.pop(conversation_id, None)
                self._states.pop(conversation_id, None)

    async def interrupt(self, conversation_id: int) -> bool:
        async with self._lock:
            state = self._states.get(conversation_id)
        if state is None:
            return False
        provider = self.providers.get(state.provider)
        await provider.interrupt(conversation_id)
        return True

    async def cancel(self, conversation_id: int) -> None:
        await self.interrupt(conversation_id)
        async with self._lock:
            task = self._tasks.get(conversation_id)
        if task and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=5)
            except asyncio.TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    def is_running(self, conversation_id: int) -> bool:
        task = self._tasks.get(conversation_id)
        return bool(task and not task.done())

    def sync_message(self, conversation_id: int) -> dict[str, object] | None:
        state = self._states.get(conversation_id)
        if state is None:
            return None
        return {
            "type": "sync_state",
            "content": state.content,
            "thought": state.thought,
            "in_thought": True,
            "elapsed": round(time.monotonic() - state.start_time, 1),
            "model": state.model,
            "provider": state.provider,
        }

    async def shutdown(self) -> None:
        conversation_ids = tuple(self._tasks)
        await asyncio.gather(
            *(self.cancel(conversation_id) for conversation_id in conversation_ids),
            return_exceptions=True,
        )
