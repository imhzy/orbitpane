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
        self._send_locks: dict[WebSocket, asyncio.Lock] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, conversation_id: int) -> None:
        async with self._lock:
            self._connections.setdefault(conversation_id, set()).add(websocket)
            self._send_locks.setdefault(websocket, asyncio.Lock())

    async def disconnect(self, websocket: WebSocket, conversation_id: int) -> None:
        async with self._lock:
            sockets = self._connections.get(conversation_id)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._connections.pop(conversation_id, None)
            self._send_locks.pop(websocket, None)

    async def send(
        self,
        websocket: WebSocket,
        conversation_id: int,
        message: dict[str, object],
    ) -> bool:
        async with self._lock:
            if websocket not in self._connections.get(conversation_id, ()):
                return False
            send_lock = self._send_locks[websocket]
        try:
            async with send_lock:
                await websocket.send_json(message)
            return True
        except Exception:
            await self.disconnect(websocket, conversation_id)
            return False

    async def broadcast(self, conversation_id: int, message: dict[str, object]) -> None:
        async with self._lock:
            sockets = tuple(self._connections.get(conversation_id, ()))
        for websocket in sockets:
            await self.send(websocket, conversation_id, message)


@dataclass(slots=True)
class TaskState:
    provider: str
    model: str
    run_id: str
    user_content: str
    start_time: float = field(default_factory=time.monotonic)
    content: str = ""
    thought: str = ""
    sequence: int = 0
    duration: float | None = None


class AgentCoordinator:
    ELAPSED_UPDATE_INTERVAL_SECONDS = 0.25

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
            run_id = f"{conversation.id}-{uuid.uuid4().hex}"
            self.database.add_message(
                conversation.id,
                "user",
                content,
                provider=provider_name,
                run_id=run_id,
            )
            state = TaskState(
                provider=provider_name,
                model=selected_model,
                run_id=run_id,
                user_content=content,
            )
            self._states[conversation.id] = state
            request = AgentRequest(
                run_id=run_id,
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

    @staticmethod
    def _elapsed(state: TaskState) -> float:
        if state.duration is not None:
            return state.duration
        return round(time.monotonic() - state.start_time, 1)

    def _state_message(
        self,
        conversation_id: int,
        state: TaskState,
        event_type: str,
        **values: object,
    ) -> dict[str, object]:
        return {
            "type": event_type,
            "conversation_id": conversation_id,
            "run_id": state.run_id,
            "sequence": state.sequence,
            "elapsed": self._elapsed(state),
            "model": state.model,
            "provider": state.provider,
            **values,
        }

    async def _broadcast_elapsed(
        self, conversation_id: int, state: TaskState
    ) -> None:
        while True:
            await asyncio.sleep(self.ELAPSED_UPDATE_INTERVAL_SECONDS)
            await self.hub.broadcast(
                conversation_id,
                self._state_message(conversation_id, state, "elapsed"),
            )

    async def _execute(self, conversation_id, provider, request, state) -> None:
        await self.hub.broadcast(
            conversation_id,
            self._state_message(
                conversation_id,
                state,
                "start",
                status="Thinking...",
                user_content=state.user_content,
            ),
        )
        elapsed_task = asyncio.create_task(
            self._broadcast_elapsed(conversation_id, state),
            name=f"elapsed-{state.run_id}",
        )

        async def emit(event: AgentEvent) -> None:
            if event.type == "token":
                state.content += event.content
            elif event.type == "thought":
                state.thought += event.content
            state.sequence += 1
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    event.type,
                    content=event.content,
                    full_content=state.content,
                    full_thought=state.thought,
                ),
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
            state.duration = self._elapsed(state)
            self.database.add_message(
                conversation_id,
                "agent",
                result.content,
                thought=result.thought,
                duration=state.duration,
                model=state.model,
                provider=state.provider,
                run_id=state.run_id,
            )
        except asyncio.CancelledError:
            await provider.interrupt(conversation_id)
            raise
        except ProviderError as exc:
            logger.error("ProviderError occurred: %s", exc, exc_info=True)
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    "error",
                    code="provider_error",
                    content=str(exc),
                ),
            )
            state.duration = self._elapsed(state)
            if state.content and state.content.strip():
                self.database.add_message(
                    conversation_id,
                    "agent",
                    state.content,
                    thought=state.thought,
                    duration=state.duration,
                    model=state.model,
                    provider=state.provider,
                    run_id=state.run_id,
                )
        except Exception as exc:
            logger.exception("Unexpected error during agent execution for conversation %s: %s", conversation_id, exc)
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    "error",
                    code="internal_error",
                    content=f"Agent execution failed unexpectedly: {exc}",
                ),
            )
        finally:
            elapsed_task.cancel()
            await asyncio.gather(elapsed_task, return_exceptions=True)
            if state.duration is None:
                state.duration = self._elapsed(state)
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    "done",
                    duration=state.duration,
                    content=state.content,
                    thought=state.thought,
                ),
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
            "conversation_id": conversation_id,
            "run_id": state.run_id,
            "sequence": state.sequence,
            "content": state.content,
            "thought": state.thought,
            "in_thought": True,
            "elapsed": self._elapsed(state),
            "model": state.model,
            "provider": state.provider,
            "user_content": state.user_content,
        }

    async def shutdown(self) -> None:
        conversation_ids = tuple(self._tasks)
        await asyncio.gather(
            *(self.cancel(conversation_id) for conversation_id in conversation_ids),
            return_exceptions=True,
        )
