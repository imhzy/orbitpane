from __future__ import annotations

import asyncio
import codecs
import json
import os
import shutil
import tempfile
import time
from collections import deque
from pathlib import Path

from ..config import Settings
from .base import AgentEvent, AgentProvider, AgentRequest, AgentResult, EmitEvent, ProviderError
from .process import terminate_process


class AgyProvider(AgentProvider):
    id = "agy"
    display_name = "Google Antigravity"

    def __init__(self, settings: Settings):
        self.settings = settings
        self._processes: dict[int, asyncio.subprocess.Process] = {}
        self._interrupted: set[int] = set()

    @property
    def models(self) -> tuple[str, ...]:
        return self.settings.agy_models

    @property
    def available(self) -> bool:
        return shutil.which(self.settings.agy_command) is not None

    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        if not self.available:
            raise ProviderError(f"AGY command not found: {self.settings.agy_command}")
        self.validate_model(request.model)
        prompt = self._build_prompt(request)
        log_dir = Path(tempfile.gettempdir()) / "agy-web-bridge"
        log_dir.mkdir(mode=0o700, exist_ok=True)
        log_path = log_dir / f"{request.run_id}.log"

        command = [
            self.settings.agy_command,
            "-p",
            prompt,
            "--add-dir",
            request.working_directory,
            "--model",
            request.model,
            "--print-timeout",
            "24h",
            "--log-file",
            str(log_path),
        ]
        if self.settings.agy_skip_permissions:
            command.append("--dangerously-skip-permissions")

        environment = os.environ.copy()
        for key in tuple(environment):
            if key.startswith("ANTIGRAVITY_"):
                environment.pop(key, None)
        if self.settings.agy_proxy_url:
            for key in ("http_proxy", "https_proxy", "all_proxy"):
                environment[key] = self.settings.agy_proxy_url
        environment["PYTHONUNBUFFERED"] = "1"

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
        stderr_task = asyncio.create_task(self._read_stderr(process, stderr_lines))
        transcript_task = asyncio.create_task(
            self._follow_transcript(log_path, emit, thoughts)
        )
        content_parts: list[str] = []
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

        try:
            assert process.stdout is not None
            while chunk_bytes := await process.stdout.read(1024):
                chunk = decoder.decode(chunk_bytes, final=False)
                if chunk:
                    content_parts.append(chunk)
                    await emit(AgentEvent("token", chunk))
            final_chunk = decoder.decode(b"", final=True)
            if final_chunk:
                content_parts.append(final_chunk)
                await emit(AgentEvent("token", final_chunk))

            return_code = await process.wait()
            await stderr_task
            interrupted = request.conversation_id in self._interrupted
            if return_code != 0 and not interrupted:
                detail = "".join(stderr_lines).strip()
                raise ProviderError(
                    f"AGY exited with code {return_code}"
                    + (f": {detail}" if detail else "")
                )
            if interrupted:
                marker = "\n\n*[Generation interrupted by user]*"
                content_parts.append(marker)
                await emit(AgentEvent("token", marker))
            return AgentResult(
                content="".join(content_parts),
                thought="".join(thoughts),
                interrupted=interrupted,
            )
        finally:
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
        log_path: Path, emit: EmitEvent, thoughts: list[str]
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
