from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess

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

    def __init__(self, settings: Settings):
        self.settings = settings
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._interrupted: set[int] = set()
        self._cached_models: tuple[str, ...] | None = None
        self._model_labels: dict[str, str] = {}

    @property
    def models(self) -> tuple[str, ...]:
        if os.getenv("CODEX_MODELS"):
            return self.settings.codex_models
        if self._cached_models is None:
            fetched = fetch_codex_models(self.settings.codex_command)
            if fetched:
                self._model_labels = {model: label for model, label in fetched}
                self._cached_models = tuple(model for model, _ in fetched)
            else:
                self._cached_models = self.settings.codex_models
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
        content_parts: list[str] = []
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
                    text = item.get("text", "")
                    if text:
                        content_parts.append(text)
                        await emit(AgentEvent("token", text))
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
            final_content = "".join(content_parts)
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
        is_complete = event_type == "item.completed"

        if is_start:
            if item_id and item_id in seen_started:
                return ""
            if item_id:
                seen_started.add(item_id)

            if item_type == "command_execution":
                cmd = str(item.get("command") or "")
                return f"\n● **Exec**: `{cmd}`\n" if cmd else ""
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
                return f"\n● **{prefix}{name}**({args_str[:500]})\n"
            elif item_type == "web_search":
                query = str(item.get("query") or item.get("text") or "")
                return f"\n● **Search**: {query}\n" if query else ""
            elif item_type == "file_change":
                action = str(item.get("action") or "change")
                path = str(item.get("path") or "")
                return f"\n● **File ({action})**: {path}\n" if path else ""
            elif item_type in {"todo_list", "plan_update"}:
                text = str(item.get("text") or item.get("plan") or "")
                return f"\n● **Plan**: {text}\n" if text else ""
            elif item_type == "reasoning":
                text = (
                    item.get("text")
                    or item.get("summary")
                    or item.get("content")
                    or item.get("thinking")
                    or item.get("detail")
                    or ""
                )
                if isinstance(text, list):
                    text = "\n".join(str(part) for part in text)
                text_str = str(text).strip()
                return f"\n▸ *Thought*:\n{text_str}\n" if text_str else ""

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

            elif item_type == "reasoning":
                text = (
                    item.get("text")
                    or item.get("summary")
                    or item.get("content")
                    or item.get("thinking")
                    or item.get("detail")
                    or ""
                )
                if isinstance(text, list):
                    text = "\n".join(str(part) for part in text)
                text_str = str(text).strip()
                if text_str and item_id not in seen_started:
                    return f"\n▸ *Thought*:\n{text_str}\n"

            elif item_id not in seen_started:
                text = str(
                    item.get("text")
                    or item.get("command")
                    or item.get("name")
                    or item.get("summary")
                    or ""
                )
                if text:
                    return f"\n● **{item_type}**: {text}\n"

        return ""
