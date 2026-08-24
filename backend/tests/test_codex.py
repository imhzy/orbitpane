from __future__ import annotations

import json
from dataclasses import replace
from subprocess import CompletedProcess
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from backend.app.agents.codex import CodexCliProvider, fetch_codex_models
from backend.app.agents.base import AgentRequest
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

    async def read(self) -> bytes:
        return self._content


class _FakeProcess:
    def __init__(self, events: list[dict[str, object]]) -> None:
        self.stdout = _FakeStream(
            [(json.dumps(event) + "\n").encode() for event in events]
        )
        self.stderr = _FakeStream()
        self.returncode: int | None = None

    async def wait(self) -> int:
        self.returncode = 0
        return 0


class CodexRunTests(IsolatedAsyncioTestCase):
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
