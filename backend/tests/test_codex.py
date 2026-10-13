from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from subprocess import CompletedProcess
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from backend.app.agents.codex import (
    CodexCliProvider,
    fetch_codex_models,
    split_reasoning_effort,
    _output_lines,
)
from backend.app.agents.base import AgentRequest, ProviderError
from backend.app.config import Settings


class CodexProviderTests(TestCase):
    def setUp(self) -> None:
        self.settings = Settings.from_env()
        self.provider = CodexCliProvider(self.settings)

    def test_permission_modes_map_to_cli_flags(self) -> None:
        self.assertEqual(
            self.provider._permission_args("workspace"),
            ["--sandbox", "workspace-write"],
        )
        self.assertEqual(
            self.provider._permission_args("unrestricted"),
            ["--dangerously-bypass-approvals-and-sandbox"],
        )

    def test_reasoning_summary_is_detailed_and_visible(self) -> None:
        provider = CodexCliProvider(
            replace(self.settings, codex_reasoning_summary="detailed")
        )
        self.assertEqual(
            provider._reasoning_args(),
            [
                "--config",
                'model_reasoning_summary="detailed"',
                "--config",
                "hide_agent_reasoning=false",
            ],
        )

    def test_invalid_reasoning_summary_falls_back_to_detailed(self) -> None:
        provider = CodexCliProvider(
            replace(self.settings, codex_reasoning_summary="unexpected")
        )
        self.assertIn(
            'model_reasoning_summary="detailed"',
            provider._reasoning_args(),
        )

    def test_fetch_models_uses_visible_cli_catalog(self) -> None:
        completed = CompletedProcess(
            args=["codex", "debug", "models"],
            returncode=0,
            stdout=json.dumps(
                {
                    "models": [
                        {
                            "slug": "gpt-visible",
                            "visibility": "list",
                            "display_name": "GPT Visible",
                        },
                        {"slug": "gpt-hidden", "visibility": "hide"},
                        {"slug": "gpt-compatible"},
                        {"slug": "gpt-visible", "visibility": "list"},
                    ]
                }
            ),
            stderr="",
        )
        with patch(
            "backend.app.agents.codex.subprocess.run",
            return_value=completed,
        ):
            models = fetch_codex_models("codex")

        # A published display name wins; entries without one are humanized.
        self.assertEqual(
            models,
            (
                ("gpt-visible", "GPT Visible"),
                ("gpt-compatible", "GPT Compatible"),
            ),
        )

    def test_fetch_models_offers_every_supported_reasoning_effort(self) -> None:
        completed = CompletedProcess(
            args=["codex", "debug", "models"],
            returncode=0,
            stdout=json.dumps(
                {
                    "models": [
                        {
                            "slug": "gpt-5.5",
                            "visibility": "list",
                            "display_name": "GPT-5.5",
                            "default_reasoning_level": "medium",
                            "supported_reasoning_levels": [
                                {"effort": "low", "description": "Fast"},
                                {"effort": "medium", "description": "Balanced"},
                                {"effort": "xhigh", "description": "Extra"},
                                {"effort": "xhigh", "description": "Duplicate"},
                                {"effort": 'high"injected', "description": "Bad"},
                                {"description": "No effort"},
                            ],
                        },
                    ]
                }
            ),
            stderr="",
        )
        with patch(
            "backend.app.agents.codex.subprocess.run",
            return_value=completed,
        ):
            models = fetch_codex_models("codex")

        # The bare slug stays first so existing conversations keep resolving to
        # it; only well-formed, distinct levels are offered.
        self.assertEqual(
            models,
            (
                ("gpt-5.5", "GPT-5.5 (Default)"),
                ("gpt-5.5@low", "GPT-5.5 (Low)"),
                ("gpt-5.5@medium", "GPT-5.5 (Medium)"),
                ("gpt-5.5@xhigh", "GPT-5.5 (Extra High)"),
            ),
        )

    def test_effort_is_split_only_from_an_explicit_suffix(self) -> None:
        cases = {
            "gpt-5.5@high": ("gpt-5.5", "high"),
            "gpt-5.5": ("gpt-5.5", ""),
            # A slug that merely ends in an effort word is still a bare slug.
            "gpt-5.1-codex-max": ("gpt-5.1-codex-max", ""),
            "gpt-5.5@": ("gpt-5.5@", ""),
            "@high": ("@high", ""),
            'gpt-5.5@high"': ('gpt-5.5@high"', ""),
        }
        for model, expected in cases.items():
            with self.subTest(model=model):
                self.assertEqual(split_reasoning_effort(model), expected)

    def test_reasoning_effort_is_only_overridden_when_pinned(self) -> None:
        self.assertNotIn(
            "model_reasoning_effort", " ".join(self.provider._reasoning_args())
        )
        self.assertEqual(
            self.provider._reasoning_args("xhigh")[-2:],
            ["--config", 'model_reasoning_effort="xhigh"'],
        )

    def test_withdrawn_effort_keeps_the_model(self) -> None:
        provider = CodexCliProvider(
            replace(
                self.settings,
                codex_models=("gpt-first", "gpt-5.5", "gpt-5.5@high"),
            )
        )
        self.assertEqual(provider.validate_model("gpt-5.5@high"), "gpt-5.5@high")
        # A level the catalog no longer lists falls back to the same model at
        # its default effort, not to a different model.
        with self.assertLogs("backend.app.agents.codex", "WARNING"):
            self.assertEqual(provider.validate_model("gpt-5.5@ultra"), "gpt-5.5")
        self.assertEqual(provider.validate_model("gpt-gone@high"), "gpt-first")
        self.assertEqual(provider.validate_model("auto"), "gpt-first")

    def test_pinned_models_name_their_effort(self) -> None:
        provider = CodexCliProvider(
            replace(self.settings, codex_models=("gpt-5.5", "gpt-5.5@xhigh"))
        )
        with patch.dict("os.environ", {"CODEX_MODELS": "gpt-5.5,gpt-5.5@xhigh"}):
            self.assertEqual(
                provider.model_catalog(),
                [
                    {"id": "gpt-5.5", "display_name": "GPT 5.5"},
                    {"id": "gpt-5.5@xhigh", "display_name": "GPT 5.5 (Extra High)"},
                ],
            )

    def test_format_thought_command_execution(self) -> None:
        seen_started: set[str] = set()
        seen_completed: set[str] = set()

        start_item = {
            "id": "item_1",
            "type": "command_execution",
            "command": "/bin/bash -lc 'ls /tmp'",
        }
        res_start = self.provider._format_thought(
            "item.started", start_item, seen_started, seen_completed
        )
        self.assertIn("**Exec**: `/bin/bash -lc 'ls /tmp'`", res_start)
        self.assertIn("item_1", seen_started)

        # Duplicate start event should return empty
        res_dup_start = self.provider._format_thought(
            "item.started", start_item, seen_started, seen_completed
        )
        self.assertEqual(res_dup_start, "")

        complete_item = {
            "id": "item_1",
            "type": "command_execution",
            "command": "/bin/bash -lc 'ls /tmp'",
            "aggregated_output": "file1.txt\nfile2.txt",
        }
        res_complete = self.provider._format_thought(
            "item.completed", complete_item, seen_started, seen_completed
        )
        self.assertIn("```text\nfile1.txt\nfile2.txt\n```", res_complete)
        self.assertIn("item_1", seen_completed)

        # Duplicate complete event should return empty
        res_dup_complete = self.provider._format_thought(
            "item.completed", complete_item, seen_started, seen_completed
        )
        self.assertEqual(res_dup_complete, "")

    def test_format_thought_mcp_tool_call(self) -> None:
        seen_started: set[str] = set()
        seen_completed: set[str] = set()

        item = {
            "id": "item_2",
            "type": "mcp_tool_call",
            "server": "filesystem",
            "name": "view_file",
            "arguments": {"path": "/tmp/test.py"},
        }
        res = self.provider._format_thought(
            "item.started", item, seen_started, seen_completed
        )
        self.assertIn("**filesystem:view_file**", res)
        self.assertIn("/tmp/test.py", res)

    def test_format_thought_reasoning(self) -> None:
        seen_started: set[str] = set()
        seen_completed: set[str] = set()

        item = {
            "id": "item_3",
            "type": "reasoning",
            "summary": "Analyzing the input query step by step.",
        }
        res = self.provider._format_thought(
            "item.completed", item, seen_started, seen_completed
        )
        self.assertIn("▸ *Thought*:", res)
        self.assertIn("Analyzing the input query step by step.", res)

    def test_empty_reasoning_start_does_not_hide_completed_summary(self) -> None:
        seen_started: set[str] = set()
        seen_completed: set[str] = set()
        item = {"id": "item_4", "type": "reasoning"}

        self.assertEqual(
            self.provider._format_thought(
                "item.started", item, seen_started, seen_completed
            ),
            "",
        )
        self.assertNotIn("item_4", seen_started)

        completed = {
            **item,
            "summary": [
                {"type": "summary_text", "text": "Inspecting the event stream."},
                {"type": "summary_text", "text": "Preparing the fix."},
            ],
        }
        result = self.provider._format_thought(
            "item.completed", completed, seen_started, seen_completed
        )
        self.assertIn("Inspecting the event stream.\nPreparing the fix.", result)

    def test_format_todo_updates_from_current_sdk_shape(self) -> None:
        result = self.provider._format_thought(
            "item.updated",
            {
                "id": "item_5",
                "type": "todo_list",
                "items": [
                    {"text": "Inspect events", "completed": True},
                    {"text": "Add compatibility", "completed": False},
                ],
            },
            set(),
            set(),
        )
        self.assertIn("● **Plan**:", result)
        self.assertIn("- [x] Inspect events", result)
        self.assertIn("- [ ] Add compatibility", result)

    def test_format_file_changes_from_current_sdk_shape(self) -> None:
        result = self.provider._format_thought(
            "item.completed",
            {
                "id": "item_6",
                "type": "file_change",
                "changes": [
                    {"path": "backend/app/agents/codex.py", "kind": "update"},
                    {"path": "backend/tests/test_codex.py", "kind": "add"},
                ],
            },
            set(),
            set(),
        )
        self.assertIn("**File (update)**: backend/app/agents/codex.py", result)
        self.assertIn("**File (add)**: backend/tests/test_codex.py", result)


class _FakeStream:
    def __init__(self, lines: list[bytes] | None = None, content: bytes = b"") -> None:
        self._lines = list(lines or [])
        self._content = content

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""

    async def read(self, n: int = -1) -> bytes:
        if self._lines:
            self._content += b"".join(self._lines)
            self._lines.clear()
        if n < 0:
            content, self._content = self._content, b""
        else:
            content, self._content = self._content[:n], self._content[n:]
        return content


class _FakeProcess:
    def __init__(self, events: list[dict[str, object]], exit_code: int = 0) -> None:
        self.stdout = _FakeStream(
            [(json.dumps(event) + "\n").encode() for event in events]
        )
        self.stderr = _FakeStream()
        self.returncode: int | None = None
        self.exit_code = exit_code

    async def wait(self) -> int:
        self.returncode = self.exit_code
        return self.exit_code


class CodexRunTests(IsolatedAsyncioTestCase):
    async def test_large_jsonl_records_preserve_utf8_and_final_unterminated_line(self) -> None:
        stream = asyncio.StreamReader()
        records = [b"small", ("长输出" * 100000).encode(), b"last"]
        stream.feed_data(b"\n".join(records))
        stream.feed_eof()
        self.assertEqual([line async for line in _output_lines(stream)], records)

    async def test_run_accepts_large_tool_output_and_continues_to_final(self) -> None:
        provider = CodexCliProvider(replace(
            Settings.from_env(), codex_enabled=True, codex_models=("gpt-test",),
        ))
        process = _FakeProcess([])
        process.stdout = asyncio.StreamReader()
        for event in [
            {"type": "item.completed", "item": {
                "id": "tool", "type": "command_execution", "command": "cat file",
                "aggregated_output": "x" * 200000,
            }},
            {"type": "item.completed", "item": {
                "id": "final", "type": "agent_message", "text": "Done.",
            }},
            {"type": "turn.completed"},
        ]:
            process.stdout.feed_data((json.dumps(event) + "\n").encode())
        process.stdout.feed_eof()
        request = AgentRequest(run_id="large", conversation_id=1,
                               working_directory="/tmp", prompt="test",
                               history=(), model="gpt-test")
        with (
            patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"),
            patch("backend.app.agents.codex.asyncio.create_subprocess_exec",
                  AsyncMock(return_value=process)),
        ):
            result = await provider.run(request, AsyncMock())
        self.assertEqual(result.content, "Done.")
        self.assertFalse(provider._processes)

    async def test_run_streams_commentary_but_keeps_latest_message_as_final(self) -> None:
        settings = replace(
            Settings.from_env(),
            codex_enabled=True,
            codex_models=("gpt-test",),
            codex_reasoning_summary="detailed",
        )
        provider = CodexCliProvider(settings)
        process = _FakeProcess(
            [
                {
                    "type": "item.completed",
                    "item": {
                        "id": "item_0",
                        "type": "agent_message",
                        "text": "I will inspect this.",
                    },
                },
                {
                    "type": "item.completed",
                    "item": {
                        "id": "item_1",
                        "type": "reasoning",
                        "text": "Checking compatibility.",
                    },
                },
                {
                    "type": "item.completed",
                    "item": {
                        "id": "item_2",
                        "type": "agent_message",
                        "text": "Final answer.",
                    },
                },
                {"type": "turn.completed", "usage": {}},
            ]
        )
        emitted: list[tuple[str, str]] = []

        async def emit(event) -> None:
            emitted.append((event.type, event.content))

        request = AgentRequest(
            run_id="run-1",
            conversation_id=1,
            working_directory="/tmp",
            prompt="test",
            history=(),
            model="gpt-test",
        )
        create_process = AsyncMock(return_value=process)
        with (
            patch("backend.app.agents.codex.fetch_codex_models", return_value=()),
            patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"),
            patch(
                "backend.app.agents.codex.asyncio.create_subprocess_exec",
                create_process,
            ),
        ):
            result = await provider.run(request, emit)

        self.assertEqual(result.content, "Final answer.")
        self.assertIn("Checking compatibility.", result.thought)
        self.assertEqual(
            [content for event_type, content in emitted if event_type == "token"],
            ["I will inspect this.", "\n\nFinal answer."],
        )
        command = create_process.await_args.args
        self.assertIn('model_reasoning_summary="detailed"', command)
        # A bare model leaves the effort to Codex's own configuration.
        self.assertFalse(any("model_reasoning_effort" in arg for arg in command))

    async def test_run_pins_the_reasoning_effort_of_the_selected_entry(self) -> None:
        settings = replace(
            Settings.from_env(),
            codex_enabled=True,
            codex_models=("gpt-test", "gpt-test@xhigh"),
        )
        provider = CodexCliProvider(settings)
        process = _FakeProcess(
            [
                {
                    "type": "item.completed",
                    "item": {"id": "item_0", "type": "agent_message", "text": "Done."},
                },
                {"type": "turn.completed"},
            ]
        )

        async def emit(_event) -> None:
            return None

        request = AgentRequest(
            run_id="run-1",
            conversation_id=1,
            working_directory="/tmp",
            prompt="test",
            history=(),
            model="gpt-test@xhigh",
        )
        create_process = AsyncMock(return_value=process)
        with (
            patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"),
            patch(
                "backend.app.agents.codex.asyncio.create_subprocess_exec",
                create_process,
            ),
        ):
            await provider.run(request, emit)

        command = list(create_process.await_args.args)
        # Codex receives the real slug; the effort travels as its own setting.
        self.assertEqual(command[command.index("--model") + 1], "gpt-test")
        self.assertIn('model_reasoning_effort="xhigh"', command)
        self.assertNotIn("gpt-test@xhigh", command)


class CodexRecoveryTests(IsolatedAsyncioTestCase):
    THREAD_ID = "12345678-1234-1234-1234-123456789abc"
    CAPACITY = "Selected model is at capacity. Please try a different model."

    def setUp(self) -> None:
        self.provider = CodexCliProvider(replace(
            Settings.from_env(), codex_enabled=True, codex_models=("gpt-test",),
        ))
        self.provider.RETRY_DELAYS = (0, 0, 0)
        self.request = AgentRequest("recovery", 41, "/tmp", "original task", (), "gpt-test")
        self.emit = AsyncMock()
        self.create = AsyncMock()
        self.terminate = AsyncMock(side_effect=self._terminate)
        for name, value in (
            ("shutil.which", lambda _: "/bin/codex"),
            ("asyncio.create_subprocess_exec", self.create),
            ("terminate_process", self.terminate),
        ):
            patcher = patch(f"backend.app.agents.codex.{name}", value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def _terminate(self, process) -> None:
        if process is not None:
            process.returncode = -15
            if isinstance(process.stdout, asyncio.StreamReader):
                process.stdout.feed_eof()

    def _success(self) -> _FakeProcess:
        return _FakeProcess([
            {"type": "item.completed", "item": {
                "type": "agent_message", "text": "Final answer.",
            }},
            {"type": "turn.completed"},
        ])

    def _failed(self, message: str | None = None, *, thread: bool = True, work: bool = True):
        events = []
        if thread:
            events.append({"type": "thread.started", "thread_id": self.THREAD_ID})
        if work:
            events.extend([
                {"type": "item.completed", "item": {
                    "id": "tool", "type": "command_execution", "command": "fetch data",
                    "aggregated_output": "saved data.json",
                }},
                {"type": "item.completed", "item": {
                    "type": "agent_message", "text": "Data downloaded.",
                }},
            ])
        events.append({"type": "turn.failed", "error": {"message": message or self.CAPACITY}})
        return _FakeProcess(events, exit_code=1)

    async def test_error_does_not_kill_running_cli_and_completion_clears_status(self):
        process = self._success()
        stream = asyncio.StreamReader()
        process.stdout = stream
        stream.feed_data((json.dumps({"type": "error", "message": self.CAPACITY}) + "\n").encode())
        self.create.return_value = process
        notified = asyncio.Event()

        async def emit(event):
            if event.type == "status" and event.content:
                notified.set()
            await self.emit(event)

        task = asyncio.create_task(self.provider.run(self.request, emit))
        try:
            await asyncio.wait_for(notified.wait(), 1)
            self.assertFalse(task.done())
            self.terminate.assert_not_awaited()
            stream.feed_data(await self._success().stdout.read())
            stream.feed_eof()
            result = await asyncio.wait_for(task, 1)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(result.content, "Final answer.")
        self.create.assert_awaited_once()
        self.terminate.assert_not_awaited()
        self.assertEqual(self.emit.await_args.args[0].content, "")

    async def test_terminal_capacity_failure_resumes_exact_thread_and_keeps_progress(self):
        self.create.side_effect = [self._failed(), self._success()]
        result = await self.provider.run(self.request, self.emit)
        self.assertEqual(result.content, "Final answer.")
        self.assertIn("saved data.json", result.thought)
        first, second = [call.args for call in self.create.await_args_list]
        self.assertNotIn("--ephemeral", first)
        self.assertEqual(second[second.index("resume") + 1], self.THREAD_ID)
        self.assertNotIn("--last", second)
        self.assertIn("Do not repeat completed actions", second[-1])
        self.assertIn("--sandbox", second)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", second)
        self.assertTrue(any(call.args[0].type == "status" and "自动继续" in call.args[0].content
                            for call in self.emit.await_args_list))
        self.assertFalse(self.provider._processes)
        self.assertFalse(self.provider._retry_stops)

    async def test_repeated_capacity_failures_stop_after_three_retries(self):
        self.create.side_effect = [self._failed() for _ in range(4)]
        with self.assertRaises(ProviderError) as caught:
            await self.provider.run(self.request, self.emit)
        self.assertEqual(caught.exception.code, "provider_busy")
        self.assertIn("上限", str(caught.exception))
        self.assertEqual(self.create.await_count, 4)

    async def test_permanent_errors_and_changed_errors_are_not_retried(self):
        for message in ("Unauthorized", "Usage limit exceeded", "insufficient_quota",
                        "Invalid model", "Billing quota exceeded; rate limit"):
            with self.subTest(message=message):
                self.create.reset_mock()
                self.create.side_effect = [self._failed(), self._failed(message)]
                with self.assertRaises(ProviderError) as caught:
                    await self.provider.run(self.request, self.emit)
                self.assertEqual(str(caught.exception), message)
                self.assertEqual(self.create.await_count, 2)

    async def test_rate_limit_and_stream_disconnect_can_resume(self):
        for message in ("Rate limit exceeded", "stream disconnected before completion"):
            with self.subTest(message=message):
                self.create.side_effect = [self._failed(message), self._success()]
                result = await self.provider.run(self.request, self.emit)
                self.assertEqual(result.content, "Final answer.")

    async def test_no_thread_after_work_never_replays_original_task(self):
        self.create.return_value = self._failed(thread=False)
        with self.assertRaises(ProviderError) as caught:
            await self.provider.run(self.request, self.emit)
        self.assertIn("会话标识", str(caught.exception))
        self.create.assert_awaited_once()

    async def test_failure_before_any_work_can_retry_original_request(self):
        self.create.side_effect = [self._failed(thread=False, work=False), self._success()]
        await self.provider.run(self.request, self.emit)
        self.assertEqual(self.create.await_args_list[0].args, self.create.await_args_list[1].args)

    async def test_error_then_eof_is_not_success_even_with_partial_answer(self):
        # A CLI may close without a turn.failed event and even exit zero.
        events = [
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Working…"}},
            {"type": "error", "message": self.CAPACITY},
        ]
        process = _FakeProcess(events)
        self.create.return_value = process
        with self.assertRaises(ProviderError):
            await self.provider.run(self.request, self.emit)
        self.create.assert_awaited_once()

    async def test_partial_answer_without_completed_event_is_not_success(self):
        self.create.return_value = _FakeProcess([
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Working…"}},
        ])
        with self.assertRaisesRegex(ProviderError, "尚未确认任务完成"):
            await self.provider.run(self.request, self.emit)

    async def test_interrupt_during_backoff_wakes_immediately_and_never_restarts(self):
        self.provider.RETRY_DELAYS = (60,)
        self.create.return_value = self._failed()

        async def emit(event):
            if event.type == "status" and "自动继续" in event.content:
                await self.provider.interrupt(self.request.conversation_id)

        result = await asyncio.wait_for(self.provider.run(self.request, emit), 1)
        self.assertTrue(result.interrupted)
        self.assertEqual(result.content, "Data downloaded.")
        self.create.assert_awaited_once()
        self.assertFalse(self.provider._interrupted)
        self.assertFalse(self.provider._retry_stops)

    async def test_interrupt_while_cli_is_recovering_does_not_retry(self):
        process = _FakeProcess([])
        process.stdout = asyncio.StreamReader()
        process.stdout.feed_data((json.dumps({"type": "error", "message": self.CAPACITY}) + "\n").encode())
        self.create.return_value = process

        async def emit(event):
            if event.type == "status" and event.content:
                await self.provider.interrupt(self.request.conversation_id)

        result = await asyncio.wait_for(self.provider.run(self.request, emit), 1)
        self.assertTrue(result.interrupted)
        self.create.assert_awaited_once()
        self.assertFalse(self.provider._interrupted)

    async def test_interrupt_while_child_is_starting_stops_new_process(self):
        process = _FakeProcess([])

        async def spawn(*args, **kwargs):
            await self.provider.interrupt(self.request.conversation_id)
            return process

        self.create.side_effect = spawn
        result = await asyncio.wait_for(self.provider.run(self.request, self.emit), 1)
        self.assertTrue(result.interrupted)
        self.terminate.assert_awaited_with(process)
        self.create.assert_awaited_once()

    async def test_unresolved_error_has_bounded_wait(self):
        self.provider.RECOVERY_TIMEOUT = 0.01
        self.provider.RETRY_DELAYS = ()
        process = _FakeProcess([])
        process.stdout = asyncio.StreamReader()
        process.stdout.feed_data((json.dumps({"type": "error", "message": self.CAPACITY}) + "\n").encode())
        self.create.return_value = process
        with self.assertRaises(ProviderError) as caught:
            await asyncio.wait_for(self.provider.run(self.request, self.emit), 1)
        self.assertEqual(caught.exception.code, "provider_busy")
        self.terminate.assert_awaited()

    async def test_cancellation_cleans_up_live_process(self):
        process = _FakeProcess([])
        process.stdout = asyncio.StreamReader()
        self.create.return_value = process
        task = asyncio.create_task(self.provider.run(self.request, self.emit))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.terminate.assert_awaited_with(process)
        self.assertFalse(self.provider._processes)
        self.assertFalse(self.provider._retry_stops)


class CodexAvailabilityTests(IsolatedAsyncioTestCase):
    """Availability must not depend on a probe that has not run yet."""

    def _provider(self) -> CodexCliProvider:
        return CodexCliProvider(
            replace(Settings.from_env(), codex_enabled=True, codex_models=())
        )

    async def test_available_before_the_first_probe(self) -> None:
        provider = self._provider()
        with patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"):
            # A project created in the window between a restart and the startup
            # prewarm landing must not be rejected.
            self.assertTrue(provider.available)

    async def test_unavailable_once_a_probe_reports_no_models(self) -> None:
        provider = self._provider()
        with (
            patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"),
            patch("backend.app.agents.codex.fetch_codex_models", return_value=()),
        ):
            await provider.ensure_model_catalog()
            self.assertFalse(provider.available)

    async def test_available_once_a_probe_reports_models(self) -> None:
        provider = self._provider()
        with (
            patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"),
            patch(
                "backend.app.agents.codex.fetch_codex_models",
                return_value=(("gpt-test", "GPT Test"),),
            ),
        ):
            await provider.ensure_model_catalog()
            self.assertTrue(provider.available)
            self.assertEqual(provider.models, ("gpt-test",))

    async def test_disabled_provider_stays_unavailable(self) -> None:
        provider = CodexCliProvider(replace(Settings.from_env(), codex_enabled=False))
        with patch("backend.app.agents.codex.shutil.which", return_value="/bin/codex"):
            self.assertFalse(provider.available)
