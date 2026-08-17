from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from subprocess import DEVNULL, CompletedProcess
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from backend.app.agents.antigravity import (
    AntigravityProvider,
    fetch_antigravity_models,
)
from backend.app.agents.base import AgentEvent, AgentRequest
from backend.tests.helpers import test_settings


class AntigravityModelCatalogTests(TestCase):
    def test_permission_modes_map_to_cli_flags(self) -> None:
        self.assertEqual(AntigravityProvider._permission_args("workspace"), ["--sandbox"])
        self.assertEqual(
            AntigravityProvider._permission_args("unrestricted"),
            ["--dangerously-skip-permissions"],
        )

    def test_fetch_models_parses_cli_output(self) -> None:
        completed = CompletedProcess(
            args=["agy", "models"],
            returncode=0,
            stdout=(
                "gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n"
                "unexpected status line\n"
                "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n"
                "gemini-3.6-flash-high\tDuplicate\n"
            ),
            stderr="Fetching available models...\n",
        )
        with patch(
            "backend.app.agents.antigravity.subprocess.run",
            return_value=completed,
        ) as run_mock:
            models = fetch_antigravity_models("agy")

        # The display name the CLI already prints is kept instead of being
        # discarded and re-derived on the client.
        self.assertEqual(
            models,
            (
                ("gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"),
                ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
            ),
        )
        run_mock.assert_called_once_with(
            ["agy", "models"],
            stdin=DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_provider_caches_cli_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    return_value=(("live-model", "Live Model"),),
                ) as fetch_mock,
            ):
                self.assertEqual(provider.models, ("live-model",))
                self.assertEqual(provider.models, ("live-model",))
                self.assertEqual(
                    provider.model_catalog(),
                    [{"id": "live-model", "display_name": "Live Model"}],
                )

        fetch_mock.assert_called_once_with("true")

    def test_model_catalog_falls_back_to_humanized_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    return_value=(),
                ),
            ):
                # Settings fall back to ("test-model",) with no CLI labels.
                self.assertEqual(
                    provider.model_catalog(),
                    [{"id": "test-model", "display_name": "Test Model"}],
                )


class AntigravityProviderTests(IsolatedAsyncioTestCase):
    async def test_follow_transcript_captures_completed_response(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            conversation_id = "conversation-id"
            log_path = root / "antigravity.log"
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
                    AntigravityProvider._follow_transcript(
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
            provider = AntigravityProvider(test_settings(root))
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
                    "backend.app.agents.antigravity.asyncio.create_subprocess_exec",
                    return_value=process,
                ),
                patch.object(
                    AntigravityProvider,
                    "_follow_transcript",
                    side_effect=follow_transcript,
                ),
                patch(
                    "backend.app.agents.antigravity.terminate_process",
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
