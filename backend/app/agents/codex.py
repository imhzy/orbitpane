from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace

from ..config import Settings
from .base import (
    AgentEvent,
    AgentProvider,
    AgentRequest,
    AgentResult,
    EmitEvent,
    ModelCatalog,
    ModelCatalogCache,
    ModelCatalogStore,
    ProviderError,
    empty_output_error,
    humanize_model_id,
)
from .process import terminate_process

logger = logging.getLogger(__name__)


@dataclass
class _RecoveryState:
    thread_id: str = ""
    did_work: bool = False
    emitted_message: bool = False
    content: str = ""
    thoughts: list[str] = field(default_factory=list)


def _failure(message: str) -> ProviderError:
    """Only explicitly transient model/transport failures may resume a turn."""
    lowered = message.lower()
    if any(word in lowered for word in (
        "insufficient_quota", "usage limit", "usage_limit", "billing", "quota exceeded",
        "unauthorized", "authentication", "invalid api key",
    )):
        return ProviderError(message)
    if any(word in lowered for word in ("at capacity", "no capacity", "overloaded")):
        return ProviderError(message, code="provider_busy")
    if any(word in lowered for word in ("rate limit", "rate_limit", "too many requests")):
        return ProviderError(message, code="provider_rate_limited")
    if any(word in lowered for word in (
        "service unavailable", "temporarily unavailable", "connection reset",
        "stream disconnected", "connection closed before", "request timed out",
    )):
        return ProviderError(message, code="provider_unavailable")
    return ProviderError(message)


async def _output_lines(stream: asyncio.StreamReader) -> AsyncIterator[bytes]:
    """Frame JSONL without StreamReader.readline's 64 KiB record limit.

    Tool results may contain entire files in a single JSON record. Read bounded
    chunks and assemble records before decoding, preserving split UTF-8 bytes.
    """
    pending = bytearray()
    while chunk := await stream.read(64 * 1024):
        parts = chunk.split(b"\n")
        pending.extend(parts[0])
        for part in parts[1:]:
            yield bytes(pending)
            pending.clear()
            pending.extend(part)
    if pending:
        yield bytes(pending)

#: Joins a model slug to the reasoning effort it is pinned to: `gpt-5.5@high`.
#: Codex slugs never contain it, while a `-high` suffix would be ambiguous with
#: slugs such as `gpt-5.1-codex-max`.
EFFORT_SEPARATOR = "@"

# The value is spliced into a TOML `--config` override, and Codex accepts any
# string there without complaint, so anything else is not a level at all.
_EFFORT_PATTERN = re.compile(r"[a-z][a-z0-9_]*")
_EFFORT_LABELS = {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra High",
    "max": "Max",
    "ultra": "Ultra",
}


def split_reasoning_effort(model: str) -> tuple[str, str]:
    """Split `slug@effort` into its parts; a bare slug carries no effort."""
    slug, separator, effort = model.rpartition(EFFORT_SEPARATOR)
    if not separator or not slug or not _EFFORT_PATTERN.fullmatch(effort):
        return model, ""
    return slug, effort


def _effort_label(effort: str) -> str:
    return _EFFORT_LABELS.get(effort) or effort.replace("_", " ").title()


def humanize_codex_model(model: str) -> str:
    """Label for a Codex model id the CLI has not named, effort included."""
    slug, effort = split_reasoning_effort(model)
    label = humanize_model_id(slug)
    return f"{label} ({_effort_label(effort)})" if effort else label


def _reasoning_variants(slug: str, label: str, item: dict[str, object]) -> ModelCatalog:
    """One catalog entry per reasoning effort the model supports.

    Codex takes the effort as a separate setting rather than as part of the
    model id, so the picker would otherwise offer each model once, at whatever
    effort the server's `~/.codex/config.toml` last saved. Expanding them here
    gives the same one-list choice the Antigravity ids already encode, with no
    new field for the protocol or the client to carry.

    The bare slug stays first and keeps meaning "no override": conversations
    created before the expansion keep behaving exactly as they did.
    """
    levels = item.get("supported_reasoning_levels")
    efforts: list[str] = []
    for level in levels if isinstance(levels, list) else ():
        effort = level.get("effort") if isinstance(level, dict) else level
        if (
            isinstance(effort, str)
            and _EFFORT_PATTERN.fullmatch(effort)
            and effort not in efforts
        ):
            efforts.append(effort)
    if not efforts:
        return ((slug, label),)
    return ((slug, f"{label} (Default)"),) + tuple(
        (f"{slug}{EFFORT_SEPARATOR}{effort}", f"{label} ({_effort_label(effort)})")
        for effort in efforts
    )


def fetch_codex_models(command: str = "codex") -> ModelCatalog:
    """Read the (model id, display name) pairs exposed by the Codex CLI.

    Every reasoning effort a model supports becomes an entry of its own; see
    `_reasoning_variants`.
    """
    try:
        # Usually instant from the CLI's local cache, but when that expires the
        # CLI refetches over the network first and takes several seconds. This
        # runs in a worker thread, off every request path, so there is no reason
        # to give up before it answers.
        res = subprocess.run(
            [command, "debug", "models"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if res.returncode == 0 and res.stdout:
            data = json.loads(res.stdout)
            models: list[tuple[str, str]] = []
            seen: set[str] = set()
            for item in data.get("models", []):
                slug = item.get("slug")
                visibility = item.get("visibility")
                if (
                    slug
                    and slug not in {"codex-auto-review", "auto"}
                    and visibility in {None, "list"}
                    and slug not in seen
                ):
                    seen.add(slug)
                    label = (
                        item.get("display_name")
                        or item.get("title")
                        or item.get("name")
                        or humanize_model_id(slug)
                    )
                    models.extend(_reasoning_variants(slug, str(label), item))
            if models:
                return tuple(models)
    except Exception:
        pass
    return ()


class CodexCliProvider(AgentProvider):
    """Optional Codex adapter using the documented JSONL non-interactive interface."""

    id = "codex"
    display_name = "ChatGPT Codex"
    tone = "codex"
    _REASONING_SUMMARIES = frozenset({"auto", "concise", "detailed", "none"})
    RETRY_DELAYS = (5, 15, 30)
    RECOVERY_TIMEOUT = 120
    EXIT_TIMEOUT = 10
    _RETRYABLE_CODES = frozenset({"provider_busy", "provider_rate_limited", "provider_unavailable"})

    def __init__(self, settings: Settings, store: ModelCatalogStore | None = None):
        self.settings = settings
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._interrupted: set[int] = set()
        self._retry_stops: dict[int, asyncio.Event] = {}
        self._catalog = ModelCatalogCache(
            self.id,
            fetch=lambda: fetch_codex_models(self.settings.codex_command),
            fallback=lambda: self.settings.codex_models,
            store=store,
        )

    @property
    def _models_are_pinned(self) -> bool:
        """An explicit CODEX_MODELS overrides whatever the CLI reports."""
        return bool(os.getenv("CODEX_MODELS"))

    @property
    def models(self) -> tuple[str, ...]:
        if self._models_are_pinned:
            return self.settings.codex_models
        return self._catalog.models

    async def ensure_model_catalog(self) -> None:
        # A disabled provider is never selectable, so probing its CLI would be
        # a subprocess spawned for nothing on every catalog read.
        if not self.settings.codex_enabled or self._models_are_pinned:
            return
        await self._catalog.ensure_fresh()

    def model_display_name(self, model: str) -> str:
        if self._models_are_pinned:
            return humanize_codex_model(model)
        return self._catalog.display_name(model)

    def validate_model(self, model: str) -> str:
        if not self.models:
            raise ProviderError(f"Provider {self.id} has no configured models")
        if not model or model == "auto":
            return self.models[0]
        if model in self.models:
            return model
        slug, effort = split_reasoning_effort(model)
        if effort and slug in self.models:
            # The model is still offered, only not at this level: answer with
            # the same model at its default effort rather than another model.
            logger.warning(
                "Reasoning effort %r is not offered for %s; using its default",
                effort,
                slug,
            )
            return slug
        return self.models[0]

    @property
    def available(self) -> bool:
        if not self.settings.codex_enabled:
            return False
        if shutil.which(self.settings.codex_command) is None:
            return False
        if self._models_are_pinned or not self._catalog.has_probed:
            # No probe has run yet, so an empty catalog is absence of evidence
            # rather than evidence of absence — refusing here would reject a
            # project created in the seconds between a restart and the startup
            # prewarm landing. An empty catalog *after* a probe is real: the
            # CLI has nothing to offer, usually because it is not signed in.
            return True
        return bool(self.models)

    def _permission_args(self, permission_mode: str) -> list[str]:
        if permission_mode == "unrestricted":
            return ["--dangerously-bypass-approvals-and-sandbox"]
        sandbox = self.settings.codex_sandbox
        if sandbox not in {"read-only", "workspace-write"}:
            sandbox = "workspace-write"
        return ["--sandbox", sandbox]

    def _reasoning_args(self, effort: str = "") -> list[str]:
        summary = self.settings.codex_reasoning_summary
        if summary not in self._REASONING_SUMMARIES:
            summary = "detailed"
        # `hide_agent_reasoning` is a user-level Codex preference. OrbitPane has
        # an explicit, access-controlled execution timeline, so ensure summary
        # events reach the JSONL stream even if the interactive CLI hides them.
        args = [
            "--config",
            f'model_reasoning_summary="{summary}"',
            "--config",
            "hide_agent_reasoning=false",
        ]
        # Without an explicit effort Codex falls back to `model_reasoning_effort`
        # in config.toml — which its TUI rewrites whenever someone picks a level
        # there — and only then to the model's own default.
        if effort:
            args.extend(["--config", f'model_reasoning_effort="{effort}"'])
        return args

    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        if not self.available:
            raise ProviderError(
                "Codex provider is disabled or not configured; set CODEX_ENABLED=true"
            )
        slug, effort = split_reasoning_effort(self.validate_model(request.model))
        prompt = self._build_prompt(request)
        recovery = _RecoveryState()
        stop = asyncio.Event()
        self._retry_stops[request.conversation_id] = stop
        try:
            for attempt in range(len(self.RETRY_DELAYS) + 1):
                if stop.is_set():
                    return AgentResult(recovery.content, "".join(recovery.thoughts), interrupted=True)
                command = self._command(request, slug, effort)
                if recovery.thread_id:
                    command.extend([
                        "resume", recovery.thread_id,
                        "Continue the unfinished task from this session after a transient model "
                        "service failure. Inspect saved tool results and existing files first. "
                        "Do not repeat completed actions or external side effects. Complete only "
                        "the remaining work and provide the final answer in the user's language.",
                    ])
                else:
                    command.append(prompt)
                try:
                    result = await self._run_once(request, emit, command, recovery)
                    return replace(result, thought="".join(recovery.thoughts))
                except ProviderError as exc:
                    if stop.is_set():
                        return AgentResult(recovery.content, "".join(recovery.thoughts), interrupted=True)
                    if exc.code not in self._RETRYABLE_CODES:
                        raise
                    # Without a saved thread, replay is safe only before any
                    # agent/tool work. Never silently restart work from scratch.
                    if recovery.did_work and not recovery.thread_id:
                        raise ProviderError(
                            "模型服务暂时不可用，但缺少可恢复的会话标识；已保留进度，请稍后继续。",
                            code=exc.code, detail=str(exc),
                        ) from exc
                    if attempt == len(self.RETRY_DELAYS):
                        raise ProviderError(
                            "模型服务仍不可用，自动恢复已达上限；已保留进度，请稍后继续或切换模型。",
                            code=exc.code, detail=str(exc),
                        ) from exc
                    delay = self.RETRY_DELAYS[attempt]
                    await emit(AgentEvent(
                        "status", f"模型服务暂时繁忙，{delay} 秒后自动继续"
                        f"（第 {attempt + 1}/{len(self.RETRY_DELAYS)} 次恢复）…",
                    ))
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=delay)
                    except asyncio.TimeoutError:
                        pass
        finally:
            self._retry_stops.pop(request.conversation_id, None)
            self._interrupted.discard(request.conversation_id)

    def _command(self, request: AgentRequest, slug: str, effort: str) -> list[str]:
        command = [
            self.settings.codex_command,
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--model",
            slug,
        ]
        command.extend(self._reasoning_args(effort))
        command.extend(self._permission_args(request.permission_mode))
        return command

    async def _run_once(
        self, request: AgentRequest, emit: EmitEvent, command: list[str], recovery: _RecoveryState,
    ) -> AgentResult:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            cwd=request.working_directory,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self._processes[request.conversation_id] = process
        final_content = ""
        stderr_task = asyncio.create_task(process.stderr.read())  # type: ignore[union-attr]
        last_error = ""
        terminal_error = ""
        terminal_event = "eof"
        completed = False
        recovery_deadline: float | None = None

        seen_started: set[str] = set()
        seen_completed: set[str] = set()

        try:
            if request.conversation_id in self._interrupted:
                await terminate_process(process)
                return AgentResult(recovery.content, interrupted=True)
            assert process.stdout is not None
            lines = _output_lines(process.stdout)
            while True:
                try:
                    if recovery_deadline is None:
                        raw_line = await anext(lines)
                    else:
                        raw_line = await asyncio.wait_for(
                            anext(lines), timeout=max(0, recovery_deadline - time.monotonic()),
                        )
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    terminal_error = last_error
                    terminal_event = "recovery_timeout"
                    await terminate_process(process)
                    break
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                event_type = event.get("type", "")
                item = event.get("item") or {}
                item_type = item.get("type", "")
                if event_type == "thread.started":
                    # UUID validation also prevents a session id being treated
                    # as a CLI flag. Never use --last on a multi-project host.
                    try:
                        recovery.thread_id = str(uuid.UUID(str(event.get("thread_id", ""))))
                    except ValueError:
                        pass
                elif event_type == "error":
                    last_error = self._event_error(event)
                    if recovery_deadline is None:
                        recovery_deadline = time.monotonic() + self.RECOVERY_TIMEOUT
                    await emit(AgentEvent("status", "Codex 报告暂时异常，正在等待本轮恢复…"))
                    continue
                elif event_type == "turn.failed":
                    terminal_error = self._event_error(event)
                    terminal_event = event_type
                    break
                elif event_type == "turn.completed":
                    completed = True
                    terminal_event = event_type
                    await emit(AgentEvent("status", ""))
                    break
                if event_type.startswith("item.") and item_type != "error":
                    recovery.did_work = True
                    if recovery_deadline is not None:
                        recovery_deadline = None
                        await emit(AgentEvent("status", ""))
                if event_type == "item.completed" and item_type == "agent_message":
                    text = self._item_text(item.get("text", ""))
                    final_content = text
                    recovery.content = text
                    if text:
                        # Codex can emit progress commentary before its final
                        # response. Stream all of it, with readable boundaries,
                        # but follow the SDK contract and retain the latest agent
                        # message as the completed turn's final response.
                        streamed_text = f"\n\n{text}" if recovery.emitted_message else text
                        recovery.emitted_message = True
                        await emit(AgentEvent("token", streamed_text))
                elif event_type.startswith("item."):
                    thought = self._format_thought(event_type, item, seen_started, seen_completed)
                    if thought:
                        recovery.thoughts.append(thought)
                        await emit(AgentEvent("thought", thought))

            try:
                return_code = await asyncio.wait_for(process.wait(), timeout=self.EXIT_TIMEOUT)
                await asyncio.wait_for(asyncio.shield(stderr_task), timeout=self.EXIT_TIMEOUT)
            except asyncio.TimeoutError:
                await terminate_process(process)
                raise ProviderError("Codex 本轮结束后进程未正常退出")
            stderr = (await stderr_task).decode("utf-8", errors="replace").strip()
            interrupted = request.conversation_id in self._interrupted
            logger.info(
                "Codex run=%s thread=%s exit=%s terminal=%s error_notified=%s",
                request.run_id, recovery.thread_id, return_code, terminal_event, bool(last_error),
            )
            if not interrupted and (terminal_error or (last_error and not completed)):
                raise _failure(terminal_error or last_error)
            if return_code != 0 and not interrupted:
                raise _failure(
                    f"Codex exited with code {return_code}"
                    + (f": {stderr[-4000:]}" if stderr else "")
                )
            if not final_content.strip() and not interrupted:
                raise empty_output_error("Codex", stderr, request.permission_mode)
            if not completed and not interrupted:
                raise ProviderError("Codex 事件流提前结束，尚未确认任务完成")

            return AgentResult(
                content=(final_content or recovery.content) if interrupted else final_content,
                interrupted=interrupted,
            )
        finally:
            if process.returncode is None:
                await terminate_process(process)
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            self._processes.pop(request.conversation_id, None)

    @staticmethod
    def _event_error(event: dict) -> str:
        error = event.get("error")
        return str(event.get("message") or (
            error.get("message") if isinstance(error, dict) else error
        ) or "Codex run failed")

    async def interrupt(self, conversation_id: int) -> None:
        self._interrupted.add(conversation_id)
        if stop := self._retry_stops.get(conversation_id):
            stop.set()
        await terminate_process(self._processes.get(conversation_id))

    def _build_prompt(self, request: AgentRequest) -> str:
        history = "\n\n".join(
            f"{message.role.upper()}:\n{message.content}" for message in request.history
        )
        prompt = (
            f"Conversation history:\n{history}\n\n"
            f"NEW MESSAGE FROM USER:\n{request.prompt}"
        )
        max_chars = self.settings.history_max_chars
        if len(prompt) > max_chars:
            return "Earlier history was truncated.\n\n" + prompt[-max_chars:]
        return prompt

    def _format_thought(
        self,
        event_type: str,
        item: dict[str, object],
        seen_started: set[str],
        seen_completed: set[str],
    ) -> str:
        item_id = str(item.get("id") or "")
        item_type = str(item.get("type") or "")
        if not item_type or item_type == "agent_message":
            return ""

        is_start = event_type == "item.started"
        is_update = event_type == "item.updated"
        is_complete = event_type == "item.completed"

        # Reasoning items carry model-generated summaries on completion. Some
        # CLI releases first emit an empty started item with the same id; do not
        # let that placeholder suppress the completed summary.
        if item_type == "reasoning":
            if not is_complete:
                return ""
            if item_id and item_id in seen_completed:
                return ""
            if item_id:
                seen_completed.add(item_id)
            text = self._item_text(
                item.get("text")
                or item.get("summary")
                or item.get("content")
                or item.get("thinking")
                or item.get("detail")
                or ""
            ).strip()
            return f"\n▸ *Thought*:\n{text}\n" if text else ""

        if is_start:
            if item_id and item_id in seen_started:
                return ""
            text = ""
            if item_type == "command_execution":
                cmd = str(item.get("command") or "")
                text = f"\n● **Exec**: `{cmd}`\n" if cmd else ""
            elif item_type == "mcp_tool_call":
                server = item.get("server")
                name = item.get("name") or item.get("tool") or "tool"
                args = item.get("arguments") or item.get("args") or {}
                args_str = (
                    json.dumps(args, ensure_ascii=False, separators=(",", ":"))
                    if isinstance(args, dict)
                    else str(args)
                )
                prefix = f"{server}:" if server else ""
                text = f"\n● **{prefix}{name}**({args_str[:500]})\n"
            elif item_type == "web_search":
                query = str(item.get("query") or item.get("text") or "")
                text = f"\n● **Search**: {query}\n" if query else ""
            elif item_type == "file_change":
                text = self._format_file_changes(item)
            elif item_type in {"todo_list", "plan_update"}:
                text = self._format_plan(item)
            elif item_type == "error":
                message = self._item_text(item.get("message") or "").strip()
                text = f"\n● **Error**: {message}\n" if message else ""

            # A start item with no useful payload is only a placeholder. Marking
            # it as seen would hide richer fields delivered at completion.
            if text and item_id:
                seen_started.add(item_id)
            return text

        elif is_update:
            # Todo updates are meaningful progress events. Command updates carry
            # cumulative output and are rendered once at completion to avoid
            # duplicating large terminal transcripts.
            if item_type in {"todo_list", "plan_update"}:
                return self._format_plan(item)

        elif is_complete:
            if item_id and item_id in seen_completed:
                return ""
            if item_id:
                seen_completed.add(item_id)

            if item_type == "command_execution":
                output = str(item.get("aggregated_output") or item.get("output") or "").strip()
                cmd = str(item.get("command") or "")
                parts: list[str] = []
                if item_id not in seen_started and cmd:
                    parts.append(f"\n● **Exec**: `{cmd}`\n")
                if output:
                    snippet = output[:500] + ("..." if len(output) > 500 else "")
                    parts.append(f"```text\n{snippet}\n```\n")
                return "".join(parts)

            elif item_type == "file_change":
                return self._format_file_changes(item)

            elif item_type in {"todo_list", "plan_update"}:
                return self._format_plan(item) if item_id not in seen_started else ""

            elif item_type == "mcp_tool_call":
                parts: list[str] = []
                if item_id not in seen_started:
                    server = item.get("server")
                    name = item.get("name") or item.get("tool") or "tool"
                    prefix = f"{server}:" if server else ""
                    parts.append(f"\n● **{prefix}{name}**\n")
                error = item.get("error")
                if isinstance(error, dict):
                    message = self._item_text(error.get("message") or "").strip()
                    if message:
                        parts.append(f"**Error**: {message}\n")
                return "".join(parts)

            elif item_type == "web_search":
                query = str(item.get("query") or item.get("text") or "")
                if query and item_id not in seen_started:
                    return f"\n● **Search**: {query}\n"

            elif item_type == "error":
                message = self._item_text(item.get("message") or "").strip()
                return f"\n● **Error**: {message}\n" if message else ""

            elif item_id not in seen_started:
                text = self._item_text(
                    item.get("text")
                    or item.get("command")
                    or item.get("name")
                    or item.get("summary")
                    or ""
                )
                if text:
                    return f"\n● **{item_type}**: {text}\n"

        return ""

    @classmethod
    def _item_text(cls, value: object) -> str:
        """Normalize both Codex CLI strings and Responses-style text parts."""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(
                part for item in value if (part := cls._item_text(item))
            )
        if isinstance(value, dict):
            for key in ("text", "content", "summary", "value"):
                if key in value:
                    text = cls._item_text(value[key])
                    if text:
                        return text
        return "" if value is None else str(value)

    @classmethod
    def _format_plan(cls, item: dict[str, object]) -> str:
        raw_items = item.get("items")
        if isinstance(raw_items, list):
            lines: list[str] = []
            for raw_item in raw_items:
                if isinstance(raw_item, dict):
                    text = cls._item_text(raw_item.get("text") or "").strip()
                    if text:
                        marker = "x" if raw_item.get("completed") is True else " "
                        lines.append(f"- [{marker}] {text}")
                else:
                    text = cls._item_text(raw_item).strip()
                    if text:
                        lines.append(f"- [ ] {text}")
            plan = "\n".join(lines)
        else:
            plan = cls._item_text(item.get("text") or item.get("plan") or "").strip()
        return f"\n● **Plan**:\n{plan}\n" if plan else ""

    @classmethod
    def _format_file_changes(cls, item: dict[str, object]) -> str:
        raw_changes = item.get("changes")
        parts: list[str] = []
        if isinstance(raw_changes, list):
            for change in raw_changes:
                if not isinstance(change, dict):
                    continue
                path = cls._item_text(change.get("path") or "").strip()
                kind = cls._item_text(change.get("kind") or "change").strip()
                if path:
                    parts.append(f"\n● **File ({kind})**: {path}\n")
        else:
            path = cls._item_text(item.get("path") or "").strip()
            action = cls._item_text(item.get("action") or "change").strip()
            if path:
                parts.append(f"\n● **File ({action})**: {path}\n")
        return "".join(parts)
