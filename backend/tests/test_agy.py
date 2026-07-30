from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from backend.app.agents.agy import AgyProvider
from backend.app.agents.base import AgentEvent, AgentRequest
from backend.tests.helpers import test_settings


class AgyProviderTests(IsolatedAsyncioTestCase):
    async def test_follow_transcript_captures_completed_response(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            conversation_id = "conversation-id"
            log_path = root / "agy.log"
            log_path.write_text(
                f"Streaming conversation {conversation_id}\n",
                encoding="utf-8",
            )
            transcript_path = (
                root
                / ".gemini/antigravity-cli/brain"
                / conversation_id
                / ".system_generated/logs/transcript_full.jsonl"
            )
            transcript_path.parent.mkdir(parents=True)
            transcript_path.write_text(
                json.dumps(
                    {
                        "type": "PLANNER_RESPONSE",
                        "status": "DONE",
                        "content": "Recovered final answer",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            emitted: list[AgentEvent] = []

            async def emit(event: AgentEvent) -> None:
                emitted.append(event)

            thoughts: list[str] = []
            completion_event = asyncio.Event()
            completed_responses: list[str] = []
            with patch.object(Path, "home", return_value=root):
                task = asyncio.create_task(
                    AgyProvider._follow_transcript(
                        log_path,
                        emit,
                        thoughts,
                        completion_event,
                        completed_responses,
                    )
                )
                await asyncio.wait_for(completion_event.wait(), timeout=1)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

            self.assertEqual(completed_responses, ["Recovered final answer"])
            self.assertEqual(emitted, [])

    async def test_run_recovers_completed_response_when_stdout_remains_open(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            provider = AgyProvider(test_settings(root))
            provider._COMPLETION_GRACE_SECONDS = 0.01
            stdout = asyncio.StreamReader()
            stderr = asyncio.StreamReader()
            stderr.feed_eof()
            process_done = asyncio.Event()
            process = SimpleNamespace(
                pid=123,
                stdout=stdout,
                stderr=stderr,
                returncode=None,
            )

            async def wait() -> int:
                await process_done.wait()
                return process.returncode

            process.wait = wait

            async def follow_transcript(
                log_path: Path,
                emit,
                thoughts: list[str],
                completion_event: asyncio.Event,
                completed_responses: list[str],
            ) -> None:
                completed_responses.append("Recovered final answer")
                completion_event.set()
                await asyncio.Future()

            async def terminate(stuck_process) -> None:
                stuck_process.returncode = -15
                stdout.feed_eof()
                process_done.set()

            emitted: list[AgentEvent] = []

            async def emit(event: AgentEvent) -> None:
                emitted.append(event)

            request = AgentRequest(
                run_id="test-run",
                conversation_id=1,
                working_directory=str(root),
                prompt="Analyze",
                history=(),
                model="test-model",
            )
            with (
                patch(
                    "backend.app.agents.agy.asyncio.create_subprocess_exec",
                    return_value=process,
                ),
                patch.object(
                    AgyProvider,
                    "_follow_transcript",
                    side_effect=follow_transcript,
                ),
                patch(
                    "backend.app.agents.agy.terminate_process",
                    side_effect=terminate,
                ) as terminate_mock,
            ):
                result = await provider.run(request, emit)

            self.assertEqual(result.content, "Recovered final answer")
            self.assertEqual(
                [event.content for event in emitted if event.type == "token"],
                ["Recovered final answer"],
            )
            terminate_mock.assert_awaited_once_with(process)
