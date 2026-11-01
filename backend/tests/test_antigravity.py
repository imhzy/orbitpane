from __future__ import annotations

import asyncio
import json
import tempfile
from dataclasses import replace
from pathlib import Path
from subprocess import DEVNULL, CompletedProcess
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from backend.app.agents.antigravity import (
    AntigravityProvider,
    fetch_antigravity_models,
)
from backend.app.agents.base import AgentEvent, AgentRequest, ProviderError
from backend.app.agents.registry import ProviderRegistry
from backend.app.database import Database
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

    async def test_background_query_waits_for_notification_and_new_final_answer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            log_path = root / "agent.log"
            log_path.write_text("Streaming conversation test\n")
            transcript = root / ".gemini/antigravity-cli/brain/test/.system_generated/logs/transcript_full.jsonl"
            transcript.parent.mkdir(parents=True)
            transcript.touch()
            completion = asyncio.Event()
            responses: list[str] = []
            pending: set[str] = set()
            seen = asyncio.Queue()

            async def emit(event):
                await seen.put(event)

            async def append_and_wait(*records):
                with transcript.open("a") as stream:
                    for record in records:
                        stream.write(json.dumps(record) + "\n")
                    stream.write(json.dumps({"type": "PLANNER_RESPONSE", "thinking": "barrier"}) + "\n")
                await asyncio.wait_for(seen.get(), 2)

            with patch.object(Path, "home", return_value=root):
                follower = asyncio.create_task(AntigravityProvider._follow_transcript(
                    log_path, emit, [], completion, responses, pending,
                ))
                try:
                    await append_and_wait(
                        {"type": "GENERIC", "status": "RUNNING", "content":
                         "Tool is running as a background task with task id: test/task-14"},
                        {"type": "GENERIC", "status": "DONE", "content":
                         "Task: test/task-14\nStatus: RUNNING\n"},
                        {"type": "PLANNER_RESPONSE", "status": "DONE", "content": "I am waiting"},
                    )
                    self.assertEqual(pending, {"test/task-14"})
                    self.assertFalse(completion.is_set())
                    self.assertEqual(responses, [])
                    await append_and_wait({"type": "SYSTEM_MESSAGE", "source": "SYSTEM", "content":
                        '[Message] sender=test/task-14 content=Task id "test/task-14" finished with result:\nQuery data'})
                    self.assertEqual(pending, set())
                    self.assertFalse(completion.is_set())
                    self.assertEqual(responses, [])
                    # A JSONL write split across reads must not lose the final answer.
                    record = json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "content": "Actual analysis"})
                    with transcript.open("a") as stream:
                        stream.write(record[:20])
                    await asyncio.sleep(0.3)
                    with transcript.open("a") as stream:
                        stream.write(record[20:] + "\n")
                    await asyncio.wait_for(completion.wait(), 2)
                    self.assertEqual(responses, ["Actual analysis"])
                finally:
                    follower.cancel()
                    await asyncio.gather(follower, return_exceptions=True)

    def test_background_task_status_tracks_multiple_tasks_and_terminal_results(self) -> None:
        pending = {"test/task-1", "test/task-2"}
        update = AntigravityProvider._update_background_tasks
        update({"type": "GENERIC", "status": "DONE", "content": "Task: test/task-1\nStatus: RUNNING"}, pending)
        self.assertEqual(len(pending), 2)
        update({"type": "GENERIC", "content": "Task: test/task-1\nStatus: DONE"}, pending)
        self.assertEqual(pending, {"test/task-2"})
        update({"type": "SYSTEM_MESSAGE", "source": "SYSTEM", "content":
                '[Message] content=Task id "test/task-2" was canceled with result:'}, pending)
        self.assertEqual(pending, set())
        for status in ("FAILED", "CANCELED", "ERROR"):
            pending.add("test/task-3")
            update({"type": "GENERIC", "content": f"Task: test/task-3\nStatus: {status}"}, pending)
            self.assertEqual(pending, set())

    async def test_follow_log_detects_retry_and_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            log_path = root / "antigravity.log"
            log_path.write_text(
                "Run: attempt 1 failed (UNAVAILABLE (code 503): No capacity available for model on the server), retrying in 4s\n",
                encoding="utf-8",
            )
            emitted: list[AgentEvent] = []

            async def emit(event: AgentEvent) -> None:
                emitted.append(event)

            task = asyncio.create_task(AntigravityProvider._follow_log(log_path, emit))
            for _ in range(50):
                if emitted:
                    break
                await asyncio.sleep(0.02)

            self.assertTrue(len(emitted) >= 1)
            self.assertEqual(emitted[0].type, "status")
            self.assertIn("503", emitted[0].content)

            # Test recovery
            with log_path.open("a", encoding="utf-8") as f:
                f.write("URL: streamGenerateContent?alt=sse\n")

            for _ in range(50):
                if len(emitted) >= 2:
                    break
                await asyncio.sleep(0.02)

            self.assertEqual(len(emitted), 2)
            self.assertEqual(emitted[1].type, "status")
            self.assertEqual(emitted[1].content, "")

            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_run_reports_the_cli_reason_for_an_empty_answer(self) -> None:
        """Exit 0 with no stdout: stderr holds the only explanation there is."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            provider = AntigravityProvider(test_settings(root))
            stdout = asyncio.StreamReader()
            stdout.feed_eof()
            stderr = asyncio.StreamReader()
            stderr.feed_data(
                b'jetski: no output produced - a tool required the "command" '
                b"permission that headless mode cannot prompt for, so it was "
                b"auto-denied.\n"
            )
            stderr.feed_eof()
            process = SimpleNamespace(
                pid=123,
                stdout=stdout,
                stderr=stderr,
                returncode=0,
            )

            async def wait() -> int:
                return 0

            process.wait = wait

            async def follow_transcript(*args, **kwargs) -> None:
                await asyncio.Future()

            async def emit(event: AgentEvent) -> None:
                return None

            request = AgentRequest(
                run_id="test-run",
                conversation_id=1,
                working_directory=str(root),
                prompt="hi",
                history=(),
                model="test-model",
                permission_mode="workspace",
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
            ):
                with self.assertRaises(ProviderError) as raised:
                    await provider.run(request, emit)

            self.assertEqual(raised.exception.code, "permission_required")
            self.assertIn("auto-denied", str(raised.exception))
            self.assertIn("完全访问", str(raised.exception))

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
                pending_tasks: set[str],
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

    async def test_run_keeps_process_alive_while_background_query_is_pending(
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
                pending_tasks: set[str],
            ) -> None:
                pending_tasks.add("test/task-14")
                # Longer than both the completion grace and the run-loop poll.
                await asyncio.sleep(1.2)
                self.assertIsNone(process.returncode)
                pending_tasks.clear()
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


class AntigravityModelRefreshTests(IsolatedAsyncioTestCase):
    """The model list is discovered off the event loop, and only once."""

    async def test_reading_models_never_probes_the_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                ) as fetch_mock,
            ):
                # Until a refresh lands, the configured list stands in — and
                # reading it must not shell out, because every read happens on
                # the event loop while requests are in flight.
                self.assertEqual(provider.models, ("test-model",))
                self.assertEqual(provider.model_display_name("test-model"), "Test Model")
                fetch_mock.assert_not_called()

    async def test_refresh_populates_the_catalog_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    return_value=(("live-model", "Live Model"),),
                ) as fetch_mock,
            ):
                await provider.ensure_model_catalog()
                await provider.ensure_model_catalog()
                self.assertEqual(provider.models, ("live-model",))
                self.assertEqual(
                    provider.model_catalog(),
                    [{"id": "live-model", "display_name": "Live Model"}],
                )

        fetch_mock.assert_called_once_with("true")

    async def test_concurrent_refreshes_share_one_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    return_value=(("live-model", "Live Model"),),
                ) as fetch_mock,
            ):
                await asyncio.gather(*(provider.ensure_model_catalog() for _ in range(5)))

        self.assertEqual(fetch_mock.call_count, 1)

    async def test_stale_catalog_is_served_while_it_refreshes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            provider._catalog._ttl_seconds = 0
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    side_effect=[
                        (("model-v1", "Model V1"),),
                        (("model-v2", "Model V2"),),
                    ],
                ),
            ):
                await provider.ensure_model_catalog()
                self.assertEqual(provider.models, ("model-v1",))

                # Stale now, so this returns immediately with the old list and
                # replaces it in the background — no request ever waits.
                await provider.ensure_model_catalog()
                self.assertEqual(provider.models, ("model-v1",))
                await provider._catalog._refresh_task
                self.assertEqual(provider.models, ("model-v2",))

    async def test_failed_probe_keeps_the_previous_list(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            provider = AntigravityProvider(test_settings(Path(temp_dir)))
            provider._catalog._ttl_seconds = 0
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    side_effect=[(("model-v1", "Model V1"),), ()],
                ),
            ):
                await provider.ensure_model_catalog()
                await provider.ensure_model_catalog()
                await provider._catalog._refresh_task
                self.assertEqual(provider.models, ("model-v1",))


class RememberedCatalogTests(IsolatedAsyncioTestCase):
    """A restart must not make the model picker wait on a network probe."""

    def _database(self, directory: str) -> Database:
        database = Database(Path(directory) / "orbitpane-test.db")
        database.migrate()
        return database

    async def test_remembered_catalog_is_served_without_waiting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = self._database(temp_dir)
            database.save_model_catalog("antigravity", (("model-v1", "Model V1"),))
            provider = AntigravityProvider(test_settings(Path(temp_dir)), database)
            probe_started = asyncio.Event()
            release_probe = asyncio.Event()
            loop = asyncio.get_running_loop()

            def slow_probe(_command: str) -> tuple[tuple[str, str], ...]:
                loop.call_soon_threadsafe(probe_started.set)
                asyncio.run_coroutine_threadsafe(release_probe.wait(), loop).result()
                return (("model-v2", "Model V2"),)

            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    side_effect=slow_probe,
                ),
            ):
                # The probe is held open for the whole read: this can only
                # return if nothing waits on it.
                await asyncio.wait_for(provider.ensure_model_catalog(), timeout=2)
                self.assertEqual(provider.models, ("model-v1",))
                self.assertEqual(provider.model_display_name("model-v1"), "Model V1")

                await asyncio.wait_for(probe_started.wait(), timeout=2)
                release_probe.set()
                await provider._catalog._refresh_task
                self.assertEqual(provider.models, ("model-v2",))

            # What the probe found is what the next start serves.
            self.assertEqual(
                database.load_model_catalog("antigravity"), (("model-v2", "Model V2"),)
            )

    async def test_first_probe_is_remembered_and_empty_ones_are_not(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = self._database(temp_dir)
            provider = AntigravityProvider(test_settings(Path(temp_dir)), database)
            provider._catalog._ttl_seconds = 0
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    side_effect=[(("live-model", "Live Model"),), ()],
                ),
            ):
                # Nothing remembered yet, so the very first read waits.
                await provider.ensure_model_catalog()
                self.assertEqual(provider.models, ("live-model",))
                await provider.ensure_model_catalog()
                await provider._catalog._refresh_task

            # A failed probe neither empties the picker nor the memory of it.
            self.assertEqual(provider.models, ("live-model",))
            self.assertEqual(
                database.load_model_catalog("antigravity"),
                (("live-model", "Live Model"),),
            )

    async def test_unreadable_memory_falls_back_to_probing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Never migrated: the table is missing, as on a broken database.
            database = Database(Path(temp_dir) / "orbitpane-test.db")
            provider = AntigravityProvider(test_settings(Path(temp_dir)), database)
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                    return_value=(("live-model", "Live Model"),),
                ),
                self.assertLogs("backend.app.agents.base", "ERROR"),
            ):
                await provider.ensure_model_catalog()
            self.assertEqual(provider.models, ("live-model",))

    def test_malformed_rows_read_as_nothing_remembered(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = self._database(temp_dir)
            with database.connect() as connection:
                connection.executemany(
                    "INSERT INTO model_catalogs(provider, models) VALUES (?, ?)",
                    [
                        ("broken", "not json"),
                        ("scalar", "42"),
                        ("mixed", json.dumps([["ok", "OK"], ["no-label"], [1, 2], "x"])),
                    ],
                )
            self.assertEqual(database.load_model_catalog("broken"), ())
            self.assertEqual(database.load_model_catalog("scalar"), ())
            self.assertEqual(database.load_model_catalog("mixed"), (("ok", "OK"),))
            self.assertEqual(database.load_model_catalog("absent"), ())


class ProviderRegistryRefreshTests(IsolatedAsyncioTestCase):
    async def test_one_providers_list_never_waits_on_another_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            settings = replace(
                test_settings(Path(temp_dir)), codex_enabled=True, codex_models=()
            )
            registry = ProviderRegistry(settings)
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "backend.app.agents.antigravity.fetch_antigravity_models",
                ) as antigravity_probe,
                patch(
                    "backend.app.agents.codex.fetch_codex_models",
                    return_value=(("gpt-test", "GPT Test"),),
                ) as codex_probe,
                patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"),
            ):
                catalog = await registry.catalog(refresh="codex")

        codex_probe.assert_called_once()
        antigravity_probe.assert_not_called()
        by_id = {entry["id"]: entry for entry in catalog}
        self.assertEqual(
            [model["id"] for model in by_id["codex"]["models"]], ["gpt-test"]  # type: ignore[index]
        )
        # Still described, from what it had: the configured list.
        self.assertEqual(
            [model["id"] for model in by_id["antigravity"]["models"]],  # type: ignore[index]
            ["test-model"],
        )
