from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

from fastapi import WebSocket

from .agents.base import AgentEvent, AgentRequest, AgentResult, ProviderError
from .agents.registry import ProviderRegistry
from .database import Database
from .models import Conversation, Message
from .config import Settings

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

    @staticmethod
    def _encode(message: dict[str, object]) -> str:
        # The encoding Starlette's `send_json` would apply.
        return json.dumps(message, separators=(",", ":"), ensure_ascii=False)

    async def send(
        self,
        websocket: WebSocket,
        conversation_id: int,
        message: dict[str, object],
    ) -> bool:
        return await self._send_text(websocket, conversation_id, self._encode(message))

    async def _send_text(
        self, websocket: WebSocket, conversation_id: int, text: str
    ) -> bool:
        async with self._lock:
            if websocket not in self._connections.get(conversation_id, ()):
                return False
            send_lock = self._send_locks[websocket]
        try:
            async with send_lock:
                await websocket.send_text(text)
            return True
        except Exception:
            await self.disconnect(websocket, conversation_id)
            return False

    async def broadcast(self, conversation_id: int, message: dict[str, object]) -> None:
        async with self._lock:
            sockets = tuple(self._connections.get(conversation_id, ()))
        if not sockets:
            return
        # Stream events repeat the whole answer so far, so encoding one is real
        # work on the event loop: do it once, not once per open tab.
        text = self._encode(message)
        for websocket in sockets:
            await self._send_text(websocket, conversation_id, text)


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
    request_id: str | None = None
    schedule_id: int | None = None
    schedule_name: str = ""
    scheduled_for: str = ""
    compact_before: bool = False

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
            "schedule_id": self.schedule_id,
            "schedule_name": self.schedule_name,
            "scheduled_for": self.scheduled_for,
            "compact_before": self.compact_before,
        }


@dataclass(slots=True)
class TaskState:
    provider: str
    model: str
    run_id: str
    user_content: str
    request_id: str | None = None
    is_summary: bool = False
    summary_covered_through_id: int = 0
    input_chars: int = 0
    context_chars: int = 0
    start_time: float = field(default_factory=time.monotonic)
    last_activity_time: float = field(default_factory=time.monotonic)
    status_message: str = ""
    content: str = ""
    thought: str = ""
    sequence: int = 0
    duration: float | None = None
    schedule_id: int | None = None
    schedule_name: str = ""
    scheduled_for: str = ""
    compact_before: bool = False
    is_compacting: bool = False


class AgentCoordinator:
    ELAPSED_UPDATE_INTERVAL_SECONDS = 0.25

    def __init__(
        self, database: Database, providers: ProviderRegistry, hub: ConnectionHub,
        settings: Settings | None = None,
    ) -> None:
        self.database = database
        self.providers = providers
        self.hub = hub
        self.settings = settings
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._states: dict[int, TaskState] = {}
        self._queues: dict[int, list[QueueItem]] = {}
        self._starting: set[int] = set()
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
        # A summary's covered range is fixed when it starts, not when queued:
        # `_prepare_run` reads it then.
        return QueueItem(
            run_id=f"{conversation.id}-{uuid.uuid4().hex}",
            conversation=conversation,
            content=content,
            model=selected_model,
            provider=provider_name,
            is_summary=is_summary,
        )

    async def submit(
        self,
        conversation: Conversation,
        *,
        content: str,
        model: str | None,
        provider_id: str | None,
        is_summary: bool = False,
        request_id: str | None = None,
    ) -> dict[str, object]:
        async with self._lock:
            # The deterministic key survives lost acknowledgements and server
            # restarts. A retry returns the stored run, never executes it again.
            run_id = (f"{conversation.id}-{uuid.uuid5(uuid.NAMESPACE_URL, request_id).hex}"
                      if request_id else None)
            if run_id:
                previous = await asyncio.to_thread(self.database.get_run, run_id)
                if previous:
                    if (previous["prompt"].strip() != content.strip()
                            or (model and previous["model"] != model)
                            or (provider_id and previous["provider"] != provider_id)):
                        raise ValueError("Request ID already belongs to another message")
                    queue = self._queues.get(conversation.id, [])
                    previous["position"] = next(
                        (i + 1 for i, queued in enumerate(queue) if queued.run_id == run_id), 0
                    )
                    return previous
            item = self._build_queue_item(
                conversation, content=content, model=model,
                provider_id=provider_id, is_summary=is_summary,
            )
            if run_id:
                item.run_id = run_id
                item.request_id = request_id
            existing = self._tasks.get(conversation.id)
            is_busy = bool(existing and not existing.done())
            await asyncio.to_thread(
                self.database.create_run,
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
                await self._start_locked(item)
                result = {
                    **item.as_dict(0),
                    "status": "running",
                    "position": 0,
                }
        await self._broadcast_queue(conversation.id, item.run_id)
        return result

    async def submit_scheduled_run(self, run_id: str) -> dict[str, object]:
        """Attach an atomically claimed, persisted trigger to the ordinary FIFO."""
        async with self._lock:
            record = await asyncio.to_thread(self.database.get_run, run_id)
            if record is None:
                raise ValueError("定时执行记录不存在")
            conversation_id = int(record["conversation_id"])
            live = self._states.get(conversation_id)
            if (record["status"] != "queued" or (live and live.run_id == run_id)
                    or any(item.run_id == run_id for item in self._queues.get(conversation_id, []))):
                return record
            try:
                conversation = await asyncio.to_thread(self.database.get_conversation, conversation_id)
                if conversation is None:
                    raise ValueError("聊天已删除")
                item = self._build_queue_item(conversation, content=str(record["prompt"]),
                    model=str(record["model"]) or None, provider_id=str(record["provider"]), is_summary=False)
                item.run_id = run_id
                item.queued_at = str(record["queued_at"])
                item.schedule_id = record["schedule_id"]
                item.schedule_name = str(record["schedule_name"])
                item.scheduled_for = str(record["scheduled_for"])
                item.compact_before = bool(record["compact_before"])
                await asyncio.to_thread(self.database.update_run, run_id, model=item.model)
                existing = self._tasks.get(conversation_id)
                if existing and not existing.done():
                    queue = self._queues.setdefault(conversation_id, [])
                    queue.append(item)
                    result = item.as_dict(len(queue))
                else:
                    await self._start_locked(item)
                    result = {**item.as_dict(0), "status": "running"}
            except Exception as exc:
                if conversation_id not in self._tasks:
                    self._states.pop(conversation_id, None)
                await self._fail_to_start(record, exc)
                result = {**record, "status": "failed", "error": str(exc)}
        await self._broadcast_queue(conversation_id, run_id)
        return result

    async def _fail_to_start(self, record: dict, exc: Exception) -> None:
        conversation_id = int(record["conversation_id"])
        message = f"定时任务未能开始：{exc}" if record.get("schedule_name") else f"任务未能开始：{exc}"
        await asyncio.to_thread(self.database.update_run, str(record["run_id"]),
            status="failed", completed_at=_utc_now(), error=message)
        if record.get("schedule_name"):
            await asyncio.to_thread(self.database.record_scheduled_failure,
                                    str(record["run_id"]), message, "schedule_failed")
        await self.hub.broadcast(conversation_id, {"type": "schedules_changed", "conversation_id": conversation_id})

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
            await asyncio.to_thread(
                self.database.create_run,
                item.run_id,
                conversation.id,
                status="starting",
                prompt=content,
                model=item.model,
                provider=item.provider,
                is_summary=is_summary,
            )
            await self._start_locked(item)

    def _prepare_run(self, item: QueueItem) -> tuple[tuple[Message, ...], str]:
        """Everything a run needs from disk before it starts, in one thread hop.

        Runs in a worker thread: SQLite waits up to its busy timeout for a
        competing writer, and on the event loop that wait would stall every
        request and every stream in the process, not just this one.
        """
        conversation = item.conversation
        if self.settings is not None:
            workspace = self.settings.resolve_allowed_path(conversation.path)
            if not workspace.is_dir():
                raise ValueError("工作目录不存在")
            conversation = replace(conversation, path=str(workspace))
            item.conversation = conversation
        if item.is_summary:
            item.covered_through_id = self.database.max_message_id(conversation.id)
        elif item.compact_before:
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

        if not item.is_summary and not item.compact_before:
            self.database.add_message(
                conversation.id,
                "user",
                item.content,
                provider=item.provider,
                run_id=item.run_id,
                input_chars=len(item.content),
                schedule_id=item.schedule_id,
                schedule_name=item.schedule_name,
                scheduled_for=item.scheduled_for,
            )
        augmented_prompt = self._augment_prompt(
            conversation.path, item.content, conversation.permission_mode
        )
        return history, augmented_prompt

    async def _start_locked(self, item: QueueItem) -> None:
        """Start `item` now. The caller holds `self._lock`."""
        conversation = item.conversation
        self._starting.add(conversation.id)
        try:
            history, augmented_prompt = await asyncio.to_thread(self._prepare_run, item)
            conversation = item.conversation

            context_chars = sum(len(message.content) for message in history)
            state = TaskState(
                provider=item.provider,
                model=item.model,
                run_id=item.run_id,
                user_content=item.content,
                request_id=item.request_id,
                is_summary=item.is_summary,
                summary_covered_through_id=item.covered_through_id,
                input_chars=len(item.content),
                context_chars=context_chars,
                schedule_id=item.schedule_id,
                schedule_name=item.schedule_name,
                scheduled_for=item.scheduled_for,
                compact_before=item.compact_before,
            )
            self._states[conversation.id] = state

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
            await asyncio.to_thread(
                self.database.update_run,
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
        finally:
            self._starting.discard(conversation.id)

    @staticmethod
    def _augment_prompt(
        working_directory: str, content: str, permission_mode: str
    ) -> str:
        # Telling the agent to read the guideline files forces a tool call
        # before it can answer anything at all. Under a restricted permission
        # mode that call is auto-denied — print mode has no way to ask — so the
        # note turns every prompt in the project into a guaranteed empty
        # answer. Leave the choice to the agent there.
        if permission_mode != "unrestricted":
            return content
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

    @staticmethod
    def _health_status(state: TaskState) -> str:
        if state.is_compacting:
            return "compacting"
        if state.status_message:
            return "retrying"
        inactive = time.monotonic() - state.last_activity_time
        if inactive >= 120.0:
            return "stalled"
        if inactive >= 45.0:
            return "slow"
        return "active"

    def _state_message(
        self,
        conversation_id: int,
        state: TaskState,
        event_type: str,
        **values: object,
    ) -> dict[str, object]:
        inactive_seconds = max(0.0, round(time.monotonic() - state.last_activity_time, 1))
        return {
            "type": event_type,
            "conversation_id": conversation_id,
            "run_id": state.run_id,
            "request_id": state.request_id,
            "sequence": state.sequence,
            "elapsed": self._elapsed(state),
            "inactive_seconds": inactive_seconds,
            "health_status": self._health_status(state),
            "status_message": state.status_message,
            "model": state.model,
            "provider": state.provider,
            "input_chars": state.input_chars,
            "output_chars": len(state.content),
            "context_chars": state.context_chars,
            **self._schedule_values(state),
            **values,
        }

    @staticmethod
    def _schedule_values(state: TaskState) -> dict[str, object]:
        return {"schedule_id": state.schedule_id, "schedule_name": state.schedule_name,
                "scheduled_for": state.scheduled_for}

    async def _compact_before_run(self, provider, request: AgentRequest, state: TaskState) -> AgentRequest:
        if request.history:
            state.is_compacting = True
            state.status_message = "正在压缩上下文，完成后执行定时命令"
            state.sequence += 1
            await self.hub.broadcast(request.conversation_id,
                self._state_message(request.conversation_id, state, "status"))
            started = time.monotonic()

            async def compact_emit(event: AgentEvent) -> None:
                # Keep the heartbeat alive without mixing the checkpoint's
                # text/thoughts into the scheduled command's reply.
                state.last_activity_time = time.monotonic()

            try:
                async with asyncio.timeout(300):
                    result = await provider.compact(replace(request, run_id=request.run_id + "-compact"), compact_emit)
                if result.interrupted or not result.content.strip():
                    raise ProviderError("上下文压缩未完成")
                checkpoint = await asyncio.to_thread(self.database.save_compaction_checkpoint, state.run_id,
                    content=result.content, thought=result.thought, duration=time.monotonic() - started,
                    covered_through_id=state.summary_covered_through_id)
            except Exception as exc:
                raise ProviderError("上下文压缩失败，本次定时命令未执行。",
                                    code="compaction_failed", detail=str(exc)) from exc
            request = replace(request, history=(checkpoint,))
            state.context_chars = len(checkpoint.content)
            await asyncio.to_thread(self.database.update_run, state.run_id, context_chars=state.context_chars)
            await self.hub.broadcast(request.conversation_id,
                {"type": "checkpoint_created", "conversation_id": request.conversation_id})
        await asyncio.to_thread(self.database.add_message, request.conversation_id, "user", state.user_content,
            provider=state.provider, run_id=state.run_id, input_chars=state.input_chars,
            **self._schedule_values(state))
        state.status_message = ""
        state.is_compacting = False
        state.sequence += 1
        await self.hub.broadcast(request.conversation_id,
            self._state_message(request.conversation_id, state, "status"))
        return request

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
            state.last_activity_time = time.monotonic()
            if event.type == "token":
                state.content += event.content
                state.status_message = ""
            elif event.type == "thought":
                state.thought += event.content
                state.status_message = ""
            elif event.type == "status":
                state.status_message = event.content
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
        error_code = "schedule_failed"
        try:
            if state.compact_before:
                request = await self._compact_before_run(provider, request, state)
            result = await provider.run(request, emit)
            state.content = result.content
            state.thought = result.thought
            if not result.content.strip() and not result.interrupted:
                # Backstop for an adapter that returns empty content instead of
                # raising; the providers themselves explain the case in detail.
                raise ProviderError("Agent 执行结束但没有输出任何内容。")
            state.duration = self._elapsed(state)
            if result.interrupted:
                final_status = "interrupted"
            if result.content.strip():
                await asyncio.to_thread(
                    self._persist_answer, conversation_id, role, state, result
                )
        except asyncio.CancelledError:
            final_status = "interrupted"
            error_message = "任务已取消"
            await provider.interrupt(conversation_id)
            raise
        except ProviderError as exc:
            final_status = "failed"
            error_message = str(exc)
            error_code = exc.code
            logger.error("Provider error: %s", exc)
            await self.hub.broadcast(
                conversation_id,
                self._state_message(
                    conversation_id,
                    state,
                    "error",
                    code=exc.code,
                    content=exc.summary,
                    detail=exc.detail,
                ),
            )
            state.duration = self._elapsed(state)
            if state.content.strip():
                await asyncio.to_thread(
                    self.database.add_message,
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
                    **self._schedule_values(state),
                )
        except Exception as exc:
            final_status = "failed"
            error_message = "Agent execution failed unexpectedly"
            error_code = "internal_error"
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
            await asyncio.to_thread(
                self.database.update_run,
                state.run_id,
                status=final_status,
                completed_at=_utc_now(),
                duration=state.duration,
                output_chars=len(state.content),
                error=error_message,
            )
            if final_status == "failed" and state.schedule_name:
                await asyncio.to_thread(self.database.record_scheduled_failure,
                                        state.run_id, error_message, error_code)
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
                await self._start_next_locked(conversation_id)
            await self._broadcast_queue(conversation_id, state.run_id)

    async def _start_next_locked(self, conversation_id: int) -> None:
        queue = self._queues.get(conversation_id, [])
        while queue:
            next_item = queue.pop(0)
            try:
                await self._start_locked(next_item)
                break
            except Exception as exc:
                self._states.pop(conversation_id, None)
                record = await asyncio.to_thread(self.database.get_run, next_item.run_id)
                if record:
                    await self._fail_to_start(record, exc)
        if not queue:
            self._queues.pop(conversation_id, None)

    def _persist_answer(
        self, conversation_id: int, role: str, state: TaskState, result: AgentResult
    ) -> None:
        """Store a finished answer (and its checkpoint); runs in a worker thread."""
        message_id = self.database.add_message(
            conversation_id,
            role,
            result.content,
            thought=result.thought,
            duration=state.duration or 0.0,
            model=state.model,
            provider=state.provider,
            run_id=state.run_id,
            input_chars=state.input_chars,
            output_chars=len(result.content),
            context_chars=state.context_chars,
            **self._schedule_values(state),
        )
        if state.is_summary:
            self.database.create_summary_checkpoint(
                conversation_id,
                message_id,
                state.summary_covered_through_id,
                result.content,
            )

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

    def attached_run_ids(self) -> set[str]:
        return {state.run_id for state in self._states.values()} | {
            item.run_id for queue in self._queues.values() for item in queue
        }

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
                await asyncio.to_thread(
                    self.database.update_run,
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
            await asyncio.to_thread(
                self.database.update_run,
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
            if len(run_ids) != len(queue) or set(run_ids) != set(by_id):
                raise ValueError("Queue order must include every queued run exactly once")
            self._queues[conversation_id] = [by_id[run_id] for run_id in run_ids]
        await self._broadcast_queue(conversation_id)
        return self.queue_items(conversation_id)

    async def cancel_scheduled_queue(self, conversation_id: int, schedule_id: int) -> None:
        for item in tuple(self._queues.get(conversation_id, [])):
            if item.schedule_id == schedule_id:
                await self.cancel_queued(conversation_id, item.run_id)

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
        if queued:
            completed_at = _utc_now()

            def mark_canceled() -> None:
                for item in queued:
                    self.database.update_run(
                        item.run_id,
                        status="canceled",
                        completed_at=completed_at,
                        error=reason,
                    )

            await asyncio.to_thread(mark_canceled)
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

    async def clear_history(
        self, conversation_id: int, reason: str = "历史记录已清空"
    ) -> None:
        """Reset a conversation: stop the running task, drop the whole queue.

        Cancelling first guarantees no task can persist a message or a run
        record after the wipe, and the final broadcast lets every connected
        client discard the transient turns it is still rendering.
        """
        await self.cancel(conversation_id, reason=reason)
        await asyncio.to_thread(self.database.clear_history, conversation_id)
        await self.hub.broadcast(
            conversation_id,
            {
                "type": "history_cleared",
                "conversation_id": conversation_id,
                "queue": [],
            },
        )

    def is_running(self, conversation_id: int) -> bool:
        task = self._tasks.get(conversation_id)
        return (
            bool(task and not task.done())
            or conversation_id in self._starting
            or bool(self._queues.get(conversation_id))
        )

    def sync_message(self, conversation_id: int) -> dict[str, object] | None:
        state = self._states.get(conversation_id)
        if state is None:
            return None
        inactive_seconds = max(0.0, round(time.monotonic() - state.last_activity_time, 1))
        return {
            "type": "sync_state",
            "conversation_id": conversation_id,
            "run_id": state.run_id,
            "request_id": state.request_id,
            "sequence": state.sequence,
            "content": state.content,
            "thought": state.thought,
            "in_thought": True,
            "elapsed": self._elapsed(state),
            "inactive_seconds": inactive_seconds,
            "health_status": self._health_status(state),
            "status_message": state.status_message,
            "model": state.model,
            "provider": state.provider,
            "user_content": state.user_content,
            "input_chars": state.input_chars,
            "output_chars": len(state.content),
            "context_chars": state.context_chars,
            "queue": self.queue_items(conversation_id),
            **self._schedule_values(state),
        }

    async def task_catalog(
        self, *, conversation_id: int | None = None, limit: int = 100
    ) -> list[dict[str, object]]:
        """Run records merged with the live queue.

        The records come from a worker thread; the queue is read back here on
        the event loop, which is the only place it is ever mutated — reading it
        from a threadpool route raced with the loop.
        """
        records = await asyncio.to_thread(
            self.database.list_runs, conversation_id=conversation_id, limit=limit
        )
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
