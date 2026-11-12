from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase

from backend.app.agents.base import AgentEvent, AgentRequest, AgentResult, ExecutionStep, ProviderError
from backend.app.agents.context import build_context, estimate_tokens
from backend.app.agents.codex import CodexCliProvider
from backend.app.application import ConnectionHub
from backend.app.database import Database
from backend.app.models import Message
from backend.app.realtime import AgentCoordinator
from backend.tests.test_realtime import BlockingProvider, FakeRegistry, RecordingHub


def message(role, content):
    return Message(1, role, content, "", "", "")


class ContextTests(TestCase):
    def request(self, history=(), prompt="Keep the current request intact"):
        return AgentRequest("run", 1, "/tmp", prompt, tuple(history), "fake")

    def test_keeps_summary_and_recent_whole_turns(self):
        history = [message("summary", "Never publish. Pending: fix tests."),
                   message("user", "Old prompt " + "x" * 1200), message("agent", "Old response"),
                   message("user", "Recent prompt"), message("agent", "Recent response")]
        text = build_context(self.request(history), 1000)
        self.assertIn("Never publish", text)
        self.assertIn("Recent prompt", text)
        self.assertIn("Recent response", text)
        self.assertNotIn("Old response", text)
        self.assertTrue(text.endswith("Keep the current request intact"))
        self.assertLessEqual(len(text), 800)
        self.assertLessEqual(estimate_tokens(text), int(1000 / 3 * .8))

    def test_oversized_current_request_is_rejected_without_truncation(self):
        with self.assertRaises(ProviderError) as caught:
            build_context(self.request(prompt="约束" * 1000), 1000)
        self.assertEqual(caught.exception.code, "context_limit")

    def test_multilingual_budget_and_contiguous_tail(self):
        history = [message("user", "small old"), message("agent", "old answer"),
                   message("user", "大" * 500), message("agent", "oversized turn"),
                   message("user", "new"), message("agent", "answer")]
        text = build_context(self.request(history), 1000)
        self.assertNotIn("small old", text)
        self.assertNotIn("oversized turn", text)
        self.assertIn("new", text)

    def test_codex_step_identity_status_and_error_result(self):
        start = CodexCliProvider._execution_step("item.started", {
            "id": "item_1", "type": "command_execution", "command": "false"}, "attempt")
        end = CodexCliProvider._execution_step("item.completed", {
            "id": "item_1", "type": "command_execution", "exit_code": 1,
            "aggregated_output": "failed output"}, "attempt")
        self.assertEqual(start.id, end.id)
        self.assertEqual(start.status, "running")
        self.assertEqual(end.status, "failed")
        self.assertIn("failed output", end.content)


class ProgressTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Database(Path(self.temp.name) / "progress.db")
        self.db.migrate()
        self.conv = self.db.create_conversation("Test", self.temp.name, "fake")

    def create_run(self):
        self.db.create_run("run", self.conv.id, status="running", prompt="task",
                           model="test-model", provider="fake", is_summary=False)

    def save(self, sequence=1, **overrides):
        values = dict(sequence=sequence, content="partial", thought="thought", duration=2,
                      execution_steps=[dict(id="tool", kind="tool", title="Tool", status="running", content="args")],
                      session_id="native-session")
        values.update(overrides)
        return self.db.save_run_progress("run", **values)

    async def test_restart_restores_progress_without_reexecuting(self):
        self.create_run()
        first = self.save()
        self.assertEqual(first, self.save(2, content="newer"))
        self.assertIsNone(self.save(1, content="stale"))
        self.db.migrate()
        row = self.db.list_messages(self.conv.id)[0]
        self.assertEqual(row.content, "newer")
        self.assertEqual(row.run_status, "interrupted")
        self.assertEqual(row.execution_steps[0]["status"], "interrupted")
        self.assertEqual(self.db.get_run("run")["session_id"], "native-session")
        self.assertEqual(self.db.get_run("run")["status"], "interrupted")
        self.save(3, content="late writer")
        self.assertEqual(self.db.list_messages(self.conv.id)[0].content, "newer")
        self.db.clear_history(self.conv.id)
        self.assertIsNone(self.save(4))
        self.assertEqual(self.db.list_messages(self.conv.id), [])

    async def test_terminal_checkpoint_commits_run_status_and_fences_late_writers(self):
        self.create_run()
        self.save(1)
        self.save(2, content="final", run_status="completed")
        self.assertEqual(self.db.get_run("run")["status"], "completed")
        self.save(3, content="late checkpoint")
        self.db.migrate()
        row = self.db.list_messages(self.conv.id)[0]
        self.assertEqual(row.content, "final")
        self.assertEqual(row.run_status, "completed")
        self.assertEqual(self.db.get_run("run")["status"], "completed")

    async def test_checkpoints_and_completion_share_one_row(self):
        class StreamingProvider(BlockingProvider):
            async def run(inner, request, emit):
                await emit(AgentEvent("session", "native-session"))
                await emit(AgentEvent("step", step=ExecutionStep("one", "exec", "Command", "running", "test")))
                await emit(AgentEvent("token", "partial"))
                await inner.release.wait()
                await emit(AgentEvent("step", step=ExecutionStep("one", "exec", "Command", "completed", "done")))
                return AgentResult("final", "thought")

        provider = StreamingProvider()
        hub = RecordingHub()
        coordinator = AgentCoordinator(self.db, FakeRegistry(provider), hub)
        try:
            submitted = await coordinator.submit(self.conv, content="task", model="test-model", provider_id="fake")
            for _ in range(200):
                rows = self.db.list_messages(self.conv.id)
                if len(rows) == 2 and rows[-1].content == "partial":
                    break
                await asyncio.sleep(.01)
            self.assertEqual(rows[-1].content, "partial")
            self.assertEqual(rows[-1].execution_steps[0]["status"], "running")
            saved_id = rows[-1].id
            snapshot = coordinator.sync_message(self.conv.id)
            self.assertEqual(snapshot["content"], "partial")
            self.assertEqual(len(snapshot["execution_steps"]), 1)
            provider.release.set()
            await coordinator._tasks[self.conv.id]
            rows = self.db.list_messages(self.conv.id)
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[-1].id, saved_id)
            self.assertEqual(rows[-1].content, "final")
            self.assertEqual(rows[-1].run_status, "completed")
            self.assertEqual(rows[-1].execution_steps[0]["status"], "completed")
            self.assertEqual(self.db.get_run(submitted["run_id"])["session_id"], "native-session")
            self.assertTrue(all("full_content" not in event for _, event in hub.messages))
            self.assertEqual(hub.messages[-2][1]["type"], "done")
        finally:
            provider.release.set()
            await coordinator.shutdown()

    async def test_slow_socket_cannot_block_other_clients_or_generation(self):
        class Socket:
            def __init__(self, slow=False):
                self.slow = slow
                self.messages = []
                self.closed = asyncio.Event()

            async def send_text(self, text):
                if self.slow:
                    await asyncio.Event().wait()
                self.messages.append(text)

            async def close(self, code):
                self.closed.set()

        hub = ConnectionHub()
        hub.SEND_TIMEOUT = .05
        slow, fast = Socket(True), Socket()
        await hub.connect(slow, self.conv.id)
        await hub.connect(fast, self.conv.id)
        try:
            await asyncio.wait_for(hub.broadcast(self.conv.id, {"type": "token", "content": "hello"}), .02)
            await asyncio.wait_for(hub._connections[self.conv.id][fast].queue.join(), .03)
            self.assertEqual(len(fast.messages), 1)
            await asyncio.wait_for(slow.closed.wait(), .3)
            self.assertNotIn(slow, hub._connections[self.conv.id])
        finally:
            await hub.shutdown()

    async def test_queue_overflow_closes_even_before_writer_starts(self):
        class Socket:
            async def send_text(self, text):
                await asyncio.Event().wait()

            async def close(self, code):
                self.closed = code

        hub = ConnectionHub()
        socket = Socket()
        await hub.connect(socket, self.conv.id)
        for _ in range(129):
            await hub.broadcast(self.conv.id, {"type": "token"})
        await hub.shutdown()
        self.assertEqual(socket.closed, 1013)
