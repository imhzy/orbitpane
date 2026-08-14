from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import WebSocket

from .agents.base import AgentEvent, AgentRequest, ProviderError
from .agents.registry import ProviderRegistry
from .database import Database
from .models import Conversation

logger = logging.getLogger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
class QueueItem:
    run_id: str
    conversation: Conversation
    content: str
    model: str
    provider: str
    is_summary: bool = False
    covered_through_id: int = 0
    queued_at: str = field(default_factory=_utc_now)

    def as_dict(self, position: int) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "conversation_id": self.conversation.id,
            "conversation_name": self.conversation.name,
            "status": "queued",
            "prompt": self.content,
            "model": self.model,
            "provider": self.provider,
            "is_summary": self.is_summary,
            "queued_at": self.queued_at,
            "position": position,
        }


@dataclass(slots=True)
class TaskState:
    provider: str
    model: str
    run_id: str
    user_content: str
    is_summary: bool = False
    summary_covered_through_id: int = 0
    input_chars: int = 0
    context_chars: int = 0
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
        self._queues: dict[int, list[QueueItem]] = {}
        self._lock = asyncio.Lock()

    def _build_queue_item(
        self,
        conversation: Conversation,
        *,
        content: str,
        model: str | None,
        provider_id: str | None,
        is_summary: bool,
    ) -> QueueItem:
        content = content.strip()
        if not content:
            raise ValueError("Task content is required")
        provider_name = provider_id or conversation.provider
        provider = self.providers.get(provider_name)
        selected_model = provider.validate_model(
            model or conversation.preferred_model or provider.models[0]
        )
        return QueueItem(
            run_id=f"{conversation.id}-{uuid.uuid4().hex}",
            conversation=conversation,
            content=content,
            model=selected_model,
            provider=provider_name,
            is_summary=is_summary,
            covered_through_id=(
                self.database.max_message_id(conversation.id) if is_summary else 0
            ),
        )

    async def submit(
        self,
        conversation: Conversation,
        *,
        content: str,
        model: str | None,
        provider_id: str | None,
        is_summary: bool = False,
    ) -> dict[str, object]:
        item = self._build_queue_item(
            conversation,
            content=content,
            model=model,
            provider_id=provider_id,
            is_summary=is_summary,
        )
        async with self._lock:
            existing = self._tasks.get(conversation.id)
            is_busy = bool(existing and not existing.done())
            self.database.create_run(
                item.run_id,
                conversation.id,
                status="queued" if is_busy else "starting",
                prompt=content,
                model=item.model,
                provider=item.provider,
                is_summary=is_summary,
            )
            if is_busy:
                queue = self._queues.setdefault(conversation.id, [])
                queue.append(item)
                result = item.as_dict(len(queue))
            else:
                self._start_unlocked(item)
                result = {
                    **item.as_dict(0),
                    "status": "running",
                    "position": 0,
                }
        await self._broadcast_queue(conversation.id, item.run_id)
        return result

    async def start(
        self,
        conversation: Conversation,
        *,
        content: str,
        model: str | None,
        provider_id: str | None,
        is_summary: bool = False,
    ) -> None:
        """Start immediately, preserving the original busy-error contract.

        REST/WebSocket transports use ``submit`` so subsequent user requests are
        queued. Tests and internal callers can still require strict exclusivity.
        """
        item = self._build_queue_item(
            conversation,
            content=content,
            model=model,
            provider_id=provider_id,
            is_summary=is_summary,
        )
        async with self._lock:
            existing = self._tasks.get(conversation.id)
            if existing and not existing.done():
                raise AgentBusyError("Agent is already processing this conversation")
            self.database.create_run(
                item.run_id,
                conversation.id,
                status="starting",
                prompt=content,
                model=item.model,
                provider=item.provider,
                is_summary=is_summary,
            )
            self._start_unlocked(item)

    def _start_unlocked(self, item: QueueItem) -> None:
        conversation = item.conversation
        if item.is_summary:
            item.covered_through_id = self.database.max_message_id(conversation.id)
        history_all = tuple(self.database.list_messages(conversation.id))
        active_summary_message_id = self.database.active_summary_message_id(
            conversation.id
        )
        history = (
            tuple(
                message
                for message in history_all
                if message.id >= active_summary_message_id
            )
            if active_summary_message_id is not None
            else history_all
        )

        if not item.is_summary:
            self.database.add_message(
                conversation.id,
                "user",
                item.content,
                provider=item.provider,
                run_id=item.run_id,
                input_chars=len(item.content),
            )

        context_chars = sum(len(message.content) for message in history)
        state = TaskState(
            provider=item.provider,
            model=item.model,
            run_id=item.run_id,
            user_content=item.content,
            is_summary=item.is_summary,
            summary_covered_through_id=item.covered_through_id,
            input_chars=len(item.content),
            context_chars=context_chars,
        )
        self._states[conversation.id] = state

        augmented_prompt = self._augment_prompt(conversation.path, item.content)
        request = AgentRequest(
            run_id=item.run_id,
            conversation_id=conversation.id,
            working_directory=conversation.path,
            prompt=augmented_prompt,
            history=history,
            model=item.model,
            permission_mode=conversation.permission_mode,
        )
        provider = self.providers.get(item.provider)
        self.database.update_run(
            item.run_id,
            status="running",
            started_at=_utc_now(),
            input_chars=state.input_chars,
            context_chars=context_chars,
        )
        task = asyncio.create_task(
            self._execute(conversation.id, provider, request, state),
            name=f"agent-{conversation.id}-{request.run_id}",
        )
        self._tasks[conversation.id] = task

    @staticmethod
    def _augment_prompt(working_directory: str, content: str) -> str:
        try:
            workspace_dir = Path(working_directory)
            existing_rules = [
                filename
                for filename in (
                    ".cursor",
                    ".gemini",
                    ".claude",
                    ".cursorrules",
                    "README.md",
                    "AGENT.md",
                    "AGENTS.md",
                )
                if (workspace_dir / filename).is_file()
                or (workspace_dir / filename).is_dir()
            ]
            if existing_rules:
                rules_list = ", ".join(existing_rules)
                return (
                    "Note: The following project guideline/context files exist in "
                    f"the workspace directory: {rules_list}. Read the relevant files "
                    "before acting.\n\n=================================\n\n"
                    f"{content}"
                )
        except OSError as exc:
            logger.warning("Failed to inspect project rules: %s", exc)
        return content

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
            "input_chars": state.input_chars,
            "output_chars": len(state.content),
            "context_chars": state.context_chars,
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
        role = "summary" if state.is_summary else "agent"
        await self.hub.broadcast(
            conversation_id,
            self._state_message(
                conversation_id,
                state,
                "start",
                status="running",
                user_content=state.user_content,
                role=role,
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
                    role=role,
                    content=event.content,
                    full_content=state.content,
                    full_thought=state.thought,
                ),
            )

        final_status = "completed"
        error_message = ""
        try:
            result = await provider.run(request, emit)
            state.content = result.content
            state.thought = result.thought
            if not result.content.strip() and not result.interrupted:
                raise ProviderError(
                    "Agent completed without generating text output. This usually "
                    "occurs when a tool operation requires permission or failed."
                )
            state.duration = self._elapsed(state)
            if result.interrupted:
                final_status = "interrupted"
            if result.content.strip():
                message_id = self.database.add_message(
                    conversation_id,
                    role,
                    result.content,
                    thought=result.thought,
                    duration=state.duration,
                    model=state.model,
                    provider=state.provider,
                    run_id=state.run_id,
                    input_chars=state.input_chars,
                    output_chars=len(result.content),
                    context_chars=state.context_chars,
                )
                if state.is_summary:
                    self.database.create_summary_checkpoint(
                        conversation_id,
                        message_id,
                        state.summary_covered_through_id,
                        result.content,
                    )
        except asyncio.CancelledError:
            final_status = "interrupted"
            error_message = "任务已取消"
            await provider.interrupt(conversation_id)
            raise
        except ProviderError as exc:
            final_status = "failed"
            error_message = str(exc)
            logger.error("Provider error: %s", exc)
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
            if state.content.strip():
                self.database.add_message(
                    conversation_id,
                    "agent",
                    state.content,
                    thought=state.thought,
                    duration=state.duration,
                    model=state.model,
                    provider=state.provider,
                    run_id=state.run_id,
                    input_chars=state.input_chars,
                    output_chars=len(state.content),
                    context_chars=state.context_chars,
                )
        except Exception as exc:
            final_status = "failed"
            error_message = "Agent execution failed unexpectedly"
            logger.exception(
                "Unexpected error during agent execution for conversation %s: %s",
                conversation_id,
                exc,
            )
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    "error",
                    code="internal_error",
                    content=error_message,
                ),
            )
        finally:
            elapsed_task.cancel()
            await asyncio.gather(elapsed_task, return_exceptions=True)
            if state.duration is None:
                state.duration = self._elapsed(state)
            self.database.update_run(
                state.run_id,
                status=final_status,
                completed_at=_utc_now(),
                duration=state.duration,
                output_chars=len(state.content),
                error=error_message,
            )
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    "done",
                    status=final_status,
                    duration=state.duration,
                    content=state.content,
                    thought=state.thought,
                ),
            )
            async with self._lock:
                self._tasks.pop(conversation_id, None)
                self._states.pop(conversation_id, None)
                queue = self._queues.get(conversation_id, [])
                next_item = queue.pop(0) if queue else None
                if not queue:
                    self._queues.pop(conversation_id, None)
                if next_item is not None:
                    self._start_unlocked(next_item)
            await self._broadcast_queue(conversation_id, state.run_id)

    async def _broadcast_queue(
        self, conversation_id: int, run_id: str | None = None
    ) -> None:
        active_run_id = run_id or (
            self._states[conversation_id].run_id
            if conversation_id in self._states
            else ""
        )
        await self.hub.broadcast(
            conversation_id,
            {
                "type": "queue_changed",
                "conversation_id": conversation_id,
                "run_id": active_run_id,
                "queue": self.queue_items(conversation_id),
            },
        )

    def queue_items(self, conversation_id: int) -> list[dict[str, object]]:
        return [
            item.as_dict(index + 1)
            for index, item in enumerate(self._queues.get(conversation_id, ()))
        ]

    async def update_queued(
        self,
        conversation_id: int,
        run_id: str,
        *,
        content: str | None,
        model: str | None,
    ) -> dict[str, object] | None:
        async with self._lock:
            queue = self._queues.get(conversation_id, [])
            for index, item in enumerate(queue):
                if item.run_id != run_id:
                    continue
                if content is not None:
                    item.content = content
                if model is not None:
                    provider = self.providers.get(item.provider)
                    item.model = provider.validate_model(model)
                self.database.update_run(
                    run_id,
                    prompt=item.content,
                    model=item.model,
                )
                result = item.as_dict(index + 1)
                break
            else:
                return None
        await self._broadcast_queue(conversation_id)
        return result

    async def cancel_queued(self, conversation_id: int, run_id: str) -> bool:
        async with self._lock:
            queue = self._queues.get(conversation_id, [])
            next_queue = [item for item in queue if item.run_id != run_id]
            if len(next_queue) == len(queue):
                return False
            if next_queue:
                self._queues[conversation_id] = next_queue
            else:
                self._queues.pop(conversation_id, None)
            self.database.update_run(
                run_id,
                status="canceled",
                completed_at=_utc_now(),
                error="用户取消了排队任务",
            )
        await self._broadcast_queue(conversation_id)
        return True

    async def reorder_queue(
        self, conversation_id: int, run_ids: list[str]
    ) -> list[dict[str, object]]:
        async with self._lock:
            queue = self._queues.get(conversation_id, [])
            by_id = {item.run_id: item for item in queue}
            if set(run_ids) != set(by_id):
                raise ValueError("Queue order must include every queued run exactly once")
            self._queues[conversation_id] = [by_id[run_id] for run_id in run_ids]
        await self._broadcast_queue(conversation_id)
        return self.queue_items(conversation_id)

    async def interrupt(self, conversation_id: int) -> bool:
        async with self._lock:
            state = self._states.get(conversation_id)
        if state is None:
            return False
        provider = self.providers.get(state.provider)
        await provider.interrupt(conversation_id)
        return True

    async def cancel(self, conversation_id: int, reason: str = "工作区已删除") -> None:
        async with self._lock:
            queued = self._queues.pop(conversation_id, [])
        for item in queued:
            self.database.update_run(
                item.run_id,
                status="canceled",
                completed_at=_utc_now(),
                error=reason,
            )
        await self._broadcast_queue(conversation_id)
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
            "input_chars": state.input_chars,
            "output_chars": len(state.content),
            "context_chars": state.context_chars,
            "queue": self.queue_items(conversation_id),
        }

    def task_catalog(
        self, *, conversation_id: int | None = None, limit: int = 100
    ) -> list[dict[str, object]]:
        records = self.database.list_runs(conversation_id=conversation_id, limit=limit)
        queued = {
            item.run_id: item.as_dict(position)
            for queued_conversation_id, items in self._queues.items()
            if conversation_id is None or queued_conversation_id == conversation_id
            for position, item in enumerate(items, start=1)
        }
        return [
            {**record, **queued.get(str(record["run_id"]), {})}
            for record in records
        ]

    async def shutdown(self) -> None:
        conversation_ids = tuple(self._tasks)
        await asyncio.gather(
            *(self.cancel(conversation_id) for conversation_id in conversation_ids),
            return_exceptions=True,
        )
