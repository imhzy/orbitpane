from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import time

from ..config import Settings
from .base import (
    AgentEvent,
    AgentProvider,
    AgentRequest,
    AgentResult,
    EmitEvent,
    ProviderError,
    humanize_model_id,
)
from .process import terminate_process


def fetch_codex_models(command: str = "codex") -> tuple[tuple[str, str], ...]:
    """Read the (model slug, display name) pairs exposed by the Codex CLI."""
    try:
        res = subprocess.run(
            [command, "debug", "models"],
            capture_output=True,
            text=True,
            timeout=3,
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
                    models.append((slug, str(label)))
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
    _CACHE_TTL_SECONDS = 300

    def __init__(self, settings: Settings):
        self.settings = settings
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._interrupted: set[int] = set()
        self._cached_models: tuple[str, ...] | None = None
        self._cached_at: float = 0
        self._model_labels: dict[str, str] = {}

    @property
    def models(self) -> tuple[str, ...]:
        if os.getenv("CODEX_MODELS"):
            return self.settings.codex_models
        now = time.monotonic()
        if (
            self._cached_models is None
            or (now - self._cached_at) > self._CACHE_TTL_SECONDS
        ):
            fetched = fetch_codex_models(self.settings.codex_command)
            if fetched:
                self._model_labels = {model: label for model, label in fetched}
                self._cached_models = tuple(model for model, _ in fetched)
                self._cached_at = now
            elif self._cached_models is None:
                self._cached_models = self.settings.codex_models
                self._cached_at = now
            else:
                self._cached_at = now
        return self._cached_models

    def model_display_name(self, model: str) -> str:
        if not self._model_labels:
            _ = self.models
        return self._model_labels.get(model) or humanize_model_id(model)

    def validate_model(self, model: str) -> str:
        if not self.models:
            raise ProviderError(f"Provider {self.id} has no configured models")
        if not model or model == "auto" or model not in self.models:
            return self.models[0]
        return model

    @property
    def available(self) -> bool:
        return (
            self.settings.codex_enabled
            and bool(self.models)
            and shutil.which(self.settings.codex_command) is not None
        )

    def _permission_args(self, permission_mode: str) -> list[str]:
        if permission_mode == "unrestricted":
            return ["--dangerously-bypass-approvals-and-sandbox"]
        sandbox = self.settings.codex_sandbox
        if sandbox not in {"read-only", "workspace-write"}:
            sandbox = "workspace-write"
        return ["--sandbox", sandbox]

    def _reasoning_args(self) -> list[str]:
        summary = self.settings.codex_reasoning_summary
        if summary not in self._REASONING_SUMMARIES:
            summary = "detailed"
        # `hide_agent_reasoning` is a user-level Codex preference. OrbitPane has
        # an explicit, access-controlled execution timeline, so ensure summary
        # events reach the JSONL stream even if the interactive CLI hides them.
        return [
            "--config",
            f'model_reasoning_summary="{summary}"',
            "--config",
            "hide_agent_reasoning=false",
        ]

    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        if not self.available:
            raise ProviderError(
                "Codex provider is disabled or not configured; set CODEX_ENABLED=true"
            )
        model = self.validate_model(request.model)
        prompt = self._build_prompt(request)
        command = [
            self.settings.codex_command,
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--model",
            model,
        ]
        command.extend(self._reasoning_args())
        command.extend(self._permission_args(request.permission_mode))
        command.append(prompt)
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
        emitted_agent_message = False
        thought_parts: list[str] = []
        stderr_task = asyncio.create_task(process.stderr.read())  # type: ignore[union-attr]

        seen_started: set[str] = set()
        seen_completed: set[str] = set()

        try:
            assert process.stdout is not None
            while raw_line := await process.stdout.readline():
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                event_type = event.get("type", "")
                item = event.get("item") or {}
                item_type = item.get("type", "")
                if event_type == "item.completed" and item_type == "agent_message":
                    text = self._item_text(item.get("text", ""))
                    final_content = text
                    if text:
                        # Codex can emit progress commentary before its final
                        # response. Stream all of it, with readable boundaries,
                        # but follow the SDK contract and retain the latest agent
                        # message as the completed turn's final response.
                        streamed_text = f"\n\n{text}" if emitted_agent_message else text
                        emitted_agent_message = True
                        await emit(AgentEvent("token", streamed_text))
                elif event_type.startswith("item."):
                    thought = self._format_thought(event_type, item, seen_started, seen_completed)
                    if thought:
                        thought_parts.append(thought)
                        await emit(AgentEvent("thought", thought))
                elif event_type in {"turn.failed", "error"}:
                    raise ProviderError(
                        event.get("message")
                        or (event.get("error") or {}).get("message")
                        or "Codex run failed"
                    )

            return_code = await process.wait()
            stderr = (await stderr_task).decode("utf-8", errors="replace").strip()
            interrupted = request.conversation_id in self._interrupted
            if return_code != 0 and not interrupted:
                raise ProviderError(
                    f"Codex exited with code {return_code}"
                    + (f": {stderr[-4000:]}" if stderr else "")
                )
            if not final_content.strip() and not interrupted:
                raise ProviderError(
                    "Codex completed without generating text content."
                )

            return AgentResult(
                content=final_content,
                thought="".join(thought_parts),
                interrupted=interrupted,
            )
        finally:
            if process.returncode is None:
                await terminate_process(process)
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            self._processes.pop(request.conversation_id, None)
            self._interrupted.discard(request.conversation_id)

    async def interrupt(self, conversation_id: int) -> None:
        self._interrupted.add(conversation_id)
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
