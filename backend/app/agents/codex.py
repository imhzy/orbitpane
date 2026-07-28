from __future__ import annotations

import asyncio
import json
import shutil

from ..config import Settings
from .base import AgentEvent, AgentProvider, AgentRequest, AgentResult, EmitEvent, ProviderError
from .process import terminate_process


class CodexCliProvider(AgentProvider):
    """Optional Codex adapter using the documented JSONL non-interactive interface."""

    id = "codex"
    display_name = "OpenAI Codex"

    def __init__(self, settings: Settings):
        self.settings = settings
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._interrupted: set[int] = set()

    @property
    def models(self) -> tuple[str, ...]:
        return self.settings.codex_models

    @property
    def available(self) -> bool:
        return (
            self.settings.codex_enabled
            and bool(self.models)
            and shutil.which(self.settings.codex_command) is not None
        )

    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        if not self.available:
            raise ProviderError(
                "Codex provider is disabled or not configured; set CODEX_ENABLED=true "
                "and CODEX_MODELS"
            )
        self.validate_model(request.model)
        prompt = self._build_prompt(request)
        command = [
            self.settings.codex_command,
            "exec",
            "--json",
            "--ephemeral",
            "--sandbox",
            self.settings.codex_sandbox,
            "--model",
            request.model,
            prompt,
        ]
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=request.working_directory,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self._processes[request.conversation_id] = process
        content_parts: list[str] = []
        thought_parts: list[str] = []
        stderr_task = asyncio.create_task(process.stderr.read())  # type: ignore[union-attr]

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
                elif event_type.startswith("item.") and item_type in {
                    "reasoning",
                    "command_execution",
                    "mcp_tool_call",
                    "web_search",
                    "plan_update",
                }:
                    text = item.get("text") or item.get("command") or item.get("name") or ""
                    if text:
                        thought = f"\n● {item_type}: {text}\n"
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
            return AgentResult(
                content="".join(content_parts),
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
