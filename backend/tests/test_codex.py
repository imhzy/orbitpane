from __future__ import annotations

import json
from subprocess import CompletedProcess
from unittest import TestCase
from unittest.mock import patch

from backend.app.agents.codex import CodexCliProvider, fetch_codex_models
from backend.app.config import Settings


class CodexProviderTests(TestCase):
    def setUp(self) -> None:
        self.settings = Settings.from_env()
        self.provider = CodexCliProvider(self.settings)

    def test_fetch_models_uses_visible_cli_catalog(self) -> None:
        completed = CompletedProcess(
            args=["codex", "debug", "models"],
            returncode=0,
            stdout=json.dumps(
                {
                    "models": [
                        {"slug": "gpt-visible", "visibility": "list"},
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

        self.assertEqual(models, ("gpt-visible", "gpt-compatible"))

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
