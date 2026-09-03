from __future__ import annotations

import asyncio
import codecs
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from collections import deque
from pathlib import Path

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

logger = logging.getLogger(__name__)


def fetch_antigravity_models(command: str = "agy") -> tuple[tuple[str, str], ...]:
    """Read the (model id, display name) pairs exposed by the Antigravity CLI."""
    try:
        result = subprocess.run(
            [command, "models"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return ()

    if result.returncode != 0:
        return ()

    models: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        # `agy models` prints `<model-id>\t<display name>` on stdout. Status
        # messages go to stderr and any unexpected stdout line is ignored.
        if "\t" not in line:
            continue
        model, label = line.split("\t", 1)
        model = model.strip()
        label = label.strip()
        if model and model not in seen:
            seen.add(model)
            models.append((model, label or humanize_model_id(model)))
    return tuple(models)


class AntigravityProvider(AgentProvider):
    id = "antigravity"
    display_name = "Google Gemini"
    tone = "gemini"
    _COMPLETION_GRACE_SECONDS = 30
    _CACHE_TTL_SECONDS = 300

    CLI_MODEL_ALIASES = {
        "gemini-3.1-pro-high": "gemini-3.1-pro-low",
    }

    def __init__(self, settings: Settings):
        self.settings = settings
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._interrupted: set[int] = set()
        self._cached_models: tuple[str, ...] | None = None
        self._cached_at: float = 0
        self._model_labels: dict[str, str] = {}

    @property
    def models(self) -> tuple[str, ...]:
        now = time.monotonic()
        if (
            self._cached_models is None
            or (now - self._cached_at) > self._CACHE_TTL_SECONDS
        ):
            fetched = fetch_antigravity_models(self.settings.antigravity_command)
            if fetched:
                self._model_labels = {model: label for model, label in fetched}
                self._cached_models = tuple(model for model, _ in fetched)
                self._cached_at = now
            elif self._cached_models is None:
                # Fallback to environment variable if agy models fetch fails
                self._cached_models = self.settings.antigravity_models
                self._cached_at = now
            else:
                self._cached_at = now
        return self._cached_models

    def model_display_name(self, model: str) -> str:
        # Populate the label cache on first access if models were never read.
        if not self._model_labels:
            _ = self.models
        return self._model_labels.get(model) or humanize_model_id(model)

    @property
    def available(self) -> bool:
        return shutil.which(self.settings.antigravity_command) is not None

    @staticmethod
    def _permission_args(permission_mode: str) -> list[str]:
        if permission_mode == "unrestricted":
            return ["--dangerously-skip-permissions"]
        return ["--sandbox"]

    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        if not self.available:
            raise ProviderError(
                "Antigravity command not found: "
                f"{self.settings.antigravity_command}"
            )
        model = self.validate_model(request.model)
        cli_model = self.CLI_MODEL_ALIASES.get(model, model)
        prompt = self._build_prompt(request)
        log_dir = Path(tempfile.gettempdir()) / "orbitpane"
        log_dir.mkdir(mode=0o700, exist_ok=True)
        log_path = log_dir / f"{request.run_id}.log"

        command = [
            self.settings.antigravity_command,
            "-p",
            prompt,
            "--add-dir",
            request.working_directory,
            "--model",
            cli_model,
            "--print-timeout",
            "24h",
            "--log-file",
            str(log_path),
        ]
        command.extend(self._permission_args(request.permission_mode))

        environment = os.environ.copy()
        for key in tuple(environment):
            if key.startswith("ANTIGRAVITY_"):
                environment.pop(key, None)
        if self.settings.antigravity_proxy_url:
            for key in ("http_proxy", "https_proxy", "all_proxy"):
                environment[key] = self.settings.antigravity_proxy_url
        environment["PYTHONUNBUFFERED"] = "1"

        logger.error(f"Executing command: {command}")

        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=request.working_directory,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
            start_new_session=True,
        )
        self._processes[request.conversation_id] = process
        stderr_lines: deque[str] = deque(maxlen=200)
        thoughts: list[str] = []
        completion_event = asyncio.Event()
        completed_responses: list[str] = []
        stderr_task = asyncio.create_task(self._read_stderr(process, stderr_lines))
        transcript_task = asyncio.create_task(
            self._follow_transcript(
                log_path,
                emit,
                thoughts,
                completion_event,
                completed_responses,
            )
        )
        content_parts: list[str] = []
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        stopped_after_completion = False
        read_task: asyncio.Task[bytes] | None = None

        try:
            assert process.stdout is not None
            read_task = asyncio.create_task(process.stdout.read(1024))
            completion_started_at: float | None = None
            while True:
                if completion_event.is_set():
                    if completion_started_at is None:
                        completion_started_at = time.monotonic()
                else:
                    completion_started_at = None

                wait_timeout = 1.0
                if completion_started_at is not None:
                    remaining = self._COMPLETION_GRACE_SECONDS - (
                        time.monotonic() - completion_started_at
                    )
                    if remaining <= 0:
                        logger.warning(
                            "Antigravity process remained open %ds after model completion for "
                            "conversation %s; terminating process tree",
                            self._COMPLETION_GRACE_SECONDS,
                            request.conversation_id,
                        )
                        stopped_after_completion = True
                        await terminate_process(process)
                        break
                    wait_timeout = min(wait_timeout, remaining)

                assert read_task is not None
                done, _ = await asyncio.wait(
                    (read_task,),
                    timeout=wait_timeout,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if read_task not in done:
                    continue

                chunk_bytes = read_task.result()
                read_task = None
                if not chunk_bytes:
                    break
                chunk = decoder.decode(chunk_bytes, final=False)
                if chunk:
                    content_parts.append(chunk)
                    await emit(AgentEvent("token", chunk))
                read_task = asyncio.create_task(process.stdout.read(1024))

            if read_task is not None and not read_task.done():
                read_task.cancel()
                await asyncio.gather(read_task, return_exceptions=True)
                read_task = None

            final_chunk = decoder.decode(b"", final=True)
            if final_chunk:
                content_parts.append(final_chunk)
                await emit(AgentEvent("token", final_chunk))

            return_code = await process.wait()
            await stderr_task
            interrupted = request.conversation_id in self._interrupted
            if (
                return_code != 0
                and not interrupted
                and not stopped_after_completion
            ):
                detail = "".join(stderr_lines).strip()
                raise ProviderError(
                    f"Antigravity exited with code {return_code}"
                    + (f": {detail}" if detail else "")
                )
            if interrupted:
                marker = "\n\n*[Generation interrupted by user]*"
                content_parts.append(marker)
                await emit(AgentEvent("token", marker))

            final_content = "".join(content_parts)
            if (
                not final_content.strip()
                and completed_responses
                and not interrupted
            ):
                final_content = completed_responses[-1]
                await emit(AgentEvent("token", final_content))
            if not final_content.strip() and not interrupted:
                raise ProviderError(
                    "Antigravity completed without generating text content. "
                    "This usually occurs when a requested tool operation requires permissions or failed to complete."
                )

            return AgentResult(
                content=final_content,
                thought="".join(thoughts),
                interrupted=interrupted,
            )
        finally:
            if read_task is not None and not read_task.done():
                read_task.cancel()
                await asyncio.gather(read_task, return_exceptions=True)
            transcript_task.cancel()
            await asyncio.gather(transcript_task, return_exceptions=True)
            if process.returncode is None:
                await terminate_process(process)
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
            self._processes.pop(request.conversation_id, None)
            self._interrupted.discard(request.conversation_id)
            log_path.unlink(missing_ok=True)

    async def interrupt(self, conversation_id: int) -> None:
        self._interrupted.add(conversation_id)
        await terminate_process(self._processes.get(conversation_id))

    def _build_prompt(self, request: AgentRequest) -> str:
        sections = ["Here is the conversation history so far:"]
        for message in request.history:
            sections.append(f"{message.role.upper()}:\n{message.content}")
        sections.extend(("### END OF HISTORY ###", f"NEW MESSAGE FROM USER:\n{request.prompt}"))
        prompt = "\n\n".join(sections)
        max_chars = self.settings.history_max_chars
        if len(prompt) > max_chars:
            prompt = (
                "Earlier conversation history was truncated.\n\n"
                + prompt[-max_chars:]
            )
        return prompt

    @staticmethod
    async def _read_stderr(
        process: asyncio.subprocess.Process, lines: deque[str]
    ) -> None:
        assert process.stderr is not None
        while line := await process.stderr.readline():
            lines.append(line.decode("utf-8", errors="replace"))

    @staticmethod
    async def _follow_transcript(
        log_path: Path, emit: EmitEvent, thoughts: list[str],
        completion_event: asyncio.Event | None = None,
        completed_responses: list[str] | None = None,
    ) -> None:
        deadline = time.monotonic() + 30
        while not log_path.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        if not log_path.exists():
            return

        transcript_path: Path | None = None
        while time.monotonic() < deadline and transcript_path is None:
            with log_path.open("r", encoding="utf-8", errors="replace") as stream:
                for line in stream:
                    if "Streaming conversation " in line:
                        conversation_uuid = line.split("Streaming conversation ", 1)[1].strip()
                        transcript_path = (
                            Path.home()
                            / ".gemini/antigravity-cli/brain"
                            / conversation_uuid
                            / ".system_generated/logs/transcript_full.jsonl"
                        )
                        break
            await asyncio.sleep(0.15)
        if transcript_path is None:
            return

        while not transcript_path.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        if not transcript_path.exists():
            return

        with transcript_path.open("r", encoding="utf-8", errors="replace") as stream:
            while True:
                line = stream.readline()
                if not line:
                    await asyncio.sleep(0.15)
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if data.get("type") != "PLANNER_RESPONSE":
                    continue
                formatted: list[str] = []
                for tool_call in data.get("tool_calls", []):
                    name = tool_call.get("name", "tool")
                    args = json.dumps(
                        tool_call.get("args", {}),
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    formatted.append(f"\n\n● **{name}**({args[:500]})\n")
                if thinking := data.get("thinking"):
                    formatted.append(f"\n▸ *Thought*:\n{thinking}\n")
                text = "".join(formatted)
                if text:
                    thoughts.append(text)
                    await emit(AgentEvent("thought", text))
                if completion_event is not None:
                    has_tool_calls = bool(data.get("tool_calls"))
                    completed_content = data.get("content", "").strip()
                    if (
                        data.get("status") == "DONE"
                        and completed_content
                        and not has_tool_calls
                    ):
                        if completed_responses is not None:
                            completed_responses.append(completed_content)
                        completion_event.set()
                    elif has_tool_calls:
                        completion_event.clear()
