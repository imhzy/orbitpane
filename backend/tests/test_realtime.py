from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase

from backend.app.agents.base import (
    AgentEvent,
    AgentProvider,
    AgentRequest,
    AgentResult,
    EmitEvent,
)
from backend.app.database import Database
from backend.app.realtime import AgentBusyError, AgentCoordinator, ConnectionHub


class BlockingProvider(AgentProvider):
    id = "fake"
    display_name = "Fake"
    models = ("test-model",)

    def __init__(self) -> None:
        self.release = asyncio.Event()

    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        await self.release.wait()
        await emit(AgentEvent("token", "done"))
        return AgentResult(content="done")

    async def interrupt(self, conversation_id: int) -> None:
        self.release.set()


class FakeRegistry:
    def __init__(self, provider: AgentProvider) -> None:
        self.provider = provider

    def get(self, provider_id: str) -> AgentProvider:
        return self.provider


class RecordingHub(ConnectionHub):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[tuple[int, dict[str, object]]] = []

    async def broadcast(
        self, conversation_id: int, message: dict[str, object]
    ) -> None:
        self.messages.append((conversation_id, message))


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    async def send_text(self, text: str) -> None:
        self.messages.append(json.loads(text))


class AgentCoordinatorTests(IsolatedAsyncioTestCase):
    async def wait_until_finished(
        self, coordinator: AgentCoordinator, conversation_id: int
    ) -> None:
        for _ in range(200):
            if not coordinator.is_running(conversation_id):
                return
            await asyncio.sleep(0.01)
        self.fail("Agent task did not finish")

    async def test_submission_retries_are_idempotent_running_queued_and_completed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(Path(temp_dir) / "retry.db")
            database.migrate()
            conversation = database.create_conversation("Retry", temp_dir, "fake")
            provider = BlockingProvider()
            coordinator = AgentCoordinator(database, FakeRegistry(provider), RecordingHub())
            async def submit(request_id: str, content: str = "same prompt"):
                return await coordinator.submit(conversation, content=content,
                    model="test-model", provider_id="fake", request_id=request_id)
            try:
                first, retry = await asyncio.gather(submit("one"), submit("one"))
                self.assertEqual(first["run_id"], retry["run_id"])
                queued = await submit("two")
                queued_retry = await submit("two")
                self.assertEqual(queued["run_id"], queued_retry["run_id"])
                self.assertEqual(queued_retry["position"], 1)
                self.assertEqual(len(database.list_runs()), 2)
                with self.assertRaises(ValueError):
                    await submit("one", "different content")
                provider.release.set()
                await self.wait_until_finished(coordinator, conversation.id)
                final = await submit("one")
                self.assertEqual(final["run_id"], first["run_id"])
                self.assertEqual(len(database.list_messages(conversation.id)), 4)
                # Persistence still deduplicates after coordinator replacement.
                restarted = AgentCoordinator(database, FakeRegistry(provider), RecordingHub())
                replay = await restarted.submit(conversation, content="same prompt",
                    model="test-model", provider_id="fake", request_id="one")
                self.assertEqual(replay["run_id"], first["run_id"])
                self.assertFalse(restarted.is_running(conversation.id))
                await restarted.shutdown()
            finally:
                provider.release.set()
                await coordinator.shutdown()

    async def test_busy_message_is_not_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(
                Path(temp_dir) / "orbitpane-test.db",
            )
            database.migrate()
            conversation = database.create_conversation("Test", temp_dir, "fake")
            provider = BlockingProvider()
            coordinator = AgentCoordinator(
                database,
                FakeRegistry(provider),  # type: ignore[arg-type]
                ConnectionHub(),
            )

            await coordinator.start(
                conversation,
                content="first",
                model="test-model",
                provider_id="fake",
            )
            with self.assertRaises(AgentBusyError):
                await coordinator.start(
                    conversation,
                    content="second",
                    model="test-model",
                    provider_id="fake",
                )
            self.assertEqual(
                [message.content for message in database.list_messages(conversation.id)],
                ["first"],
            )

            provider.release.set()
            await self.wait_until_finished(coordinator, conversation.id)
            self.assertEqual(
                [message.content for message in database.list_messages(conversation.id)],
                ["first", "done"],
            )

    async def test_connection_hub_isolates_conversations(self) -> None:
        hub = ConnectionHub()
        first_socket = FakeWebSocket()
        second_socket = FakeWebSocket()
        await hub.connect(first_socket, 1)  # type: ignore[arg-type]
        await hub.connect(second_socket, 2)  # type: ignore[arg-type]

        await hub.broadcast(1, {"type": "thought", "conversation_id": 1})

        self.assertEqual(
            first_socket.messages,
            [{"type": "thought", "conversation_id": 1}],
        )
        self.assertEqual(second_socket.messages, [])

    async def test_submit_queues_edits_reorders_and_cancels_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(Path(temp_dir) / "orbitpane-test.db")
            database.migrate()
            conversation = database.create_conversation("Test", temp_dir, "fake")
            provider = BlockingProvider()
            hub = RecordingHub()
            coordinator = AgentCoordinator(
                database,
                FakeRegistry(provider),  # type: ignore[arg-type]
                hub,
            )

            first = await coordinator.submit(
                conversation,
                content="first",
                model="test-model",
                provider_id="fake",
            )
            second = await coordinator.submit(
                conversation,
                content="second",
                model="test-model",
                provider_id="fake",
            )
            third = await coordinator.submit(
                conversation,
                content="third",
                model="test-model",
                provider_id="fake",
            )

            self.assertEqual(first["status"], "running")
            self.assertEqual(second["position"], 1)
            self.assertEqual(third["position"], 2)
            self.assertFalse(await coordinator.cancel_queued(
                conversation.id, str(first["run_id"])
            ))
            await coordinator.reorder_queue(
                conversation.id,
                [str(third["run_id"]), str(second["run_id"])],
            )
            edited = await coordinator.update_queued(
                conversation.id,
                str(second["run_id"]),
                content="second edited",
                model="test-model",
            )
            self.assertIsNotNone(edited)
            self.assertEqual(edited["position"], 2)  # type: ignore[index]
            self.assertTrue(
                await coordinator.cancel_queued(
                    conversation.id, str(third["run_id"])
                )
            )
            self.assertEqual(
                [item["prompt"] for item in coordinator.queue_items(conversation.id)],
                ["second edited"],
            )
            cancellation = hub.messages[-1][1]
            self.assertEqual(cancellation["type"], "queue_changed")
            self.assertEqual(cancellation["canceled_run_id"], third["run_id"])
            self.assertEqual(cancellation["queue"][0]["run_id"], second["run_id"])
            self.assertEqual(cancellation["queue"][0]["position"], 1)
            self.assertFalse(await coordinator.cancel_queued(
                conversation.id, str(third["run_id"])
            ))
            queued_catalog = [
                item
                for item in await coordinator.task_catalog(
                    conversation_id=conversation.id
                )
                if item["status"] == "queued"
            ]
            self.assertEqual(queued_catalog[0]["position"], 1)
            self.assertEqual(queued_catalog[0]["prompt"], "second edited")

            provider.release.set()
            await self.wait_until_finished(coordinator, conversation.id)
            self.assertEqual(
                [message.content for message in database.list_messages(conversation.id)],
                ["first", "done", "second edited", "done"],
            )
            runs = {run["run_id"]: run for run in database.list_runs(limit=10)}
            self.assertEqual(runs[str(first["run_id"])]["status"], "completed")
            self.assertEqual(runs[str(second["run_id"])]["status"], "completed")
            self.assertEqual(runs[str(third["run_id"])]["status"], "canceled")
            self.assertTrue(any(message["type"] == "queue_changed" for _, message in hub.messages))

    async def test_clear_history_drops_queue_messages_and_run_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(Path(temp_dir) / "orbitpane-test.db")
            database.migrate()
            conversation = database.create_conversation("Test", temp_dir, "fake")
            provider = BlockingProvider()
            hub = RecordingHub()
            coordinator = AgentCoordinator(
                database,
                FakeRegistry(provider),  # type: ignore[arg-type]
                hub,
            )

            await coordinator.submit(
                conversation,
                content="first",
                model="test-model",
                provider_id="fake",
            )
            await coordinator.submit(
                conversation,
                content="queued",
                model="test-model",
                provider_id="fake",
            )
            self.assertEqual(len(coordinator.queue_items(conversation.id)), 1)

            await coordinator.clear_history(conversation.id)
            await self.wait_until_finished(coordinator, conversation.id)

            self.assertEqual(coordinator.queue_items(conversation.id), [])
            self.assertEqual(database.list_messages(conversation.id), [])
            self.assertEqual(
                database.list_runs(conversation_id=conversation.id), []
            )
            self.assertEqual(
                await coordinator.task_catalog(conversation_id=conversation.id), []
            )
            self.assertTrue(
                any(
                    message["type"] == "history_cleared"
                    for _, message in hub.messages
                )
            )

    async def test_elapsed_time_and_stream_identity_are_server_authoritative(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(
                Path(temp_dir) / "orbitpane-test.db",
            )
            database.migrate()
            conversation = database.create_conversation("Test", temp_dir, "fake")
            provider = BlockingProvider()
            hub = RecordingHub()
            coordinator = AgentCoordinator(
                database,
                FakeRegistry(provider),  # type: ignore[arg-type]
                hub,
            )
            coordinator.ELAPSED_UPDATE_INTERVAL_SECONDS = 0.01

            await coordinator.start(
                conversation,
                content="measure me",
                model="test-model",
                provider_id="fake",
            )
            await asyncio.sleep(0.12)

            sync_message = coordinator.sync_message(conversation.id)
            self.assertIsNotNone(sync_message)
            assert sync_message is not None
            self.assertGreaterEqual(float(sync_message["elapsed"]), 0.1)
            run_id = str(sync_message["run_id"])
            self.assertTrue(run_id.startswith(f"{conversation.id}-"))
            self.assertEqual(sync_message["conversation_id"], conversation.id)

            elapsed_events = [
                message
                for event_conversation_id, message in hub.messages
                if event_conversation_id == conversation.id
                and message["type"] == "elapsed"
            ]
            self.assertTrue(elapsed_events)
            self.assertTrue(
                all(message["run_id"] == run_id for message in elapsed_events)
            )

            provider.release.set()
            await self.wait_until_finished(coordinator, conversation.id)

            stored_messages = database.list_messages(conversation.id)
            self.assertEqual([message.run_id for message in stored_messages], [run_id, run_id])
            self.assertGreaterEqual(stored_messages[-1].duration, 0.1)

            done_events = [
                message for _, message in hub.messages if message["type"] == "done"
            ]
            self.assertEqual(len(done_events), 1)
            self.assertEqual(done_events[0]["conversation_id"], conversation.id)
            self.assertEqual(done_events[0]["run_id"], run_id)
            self.assertEqual(done_events[0]["content"], "done")
            self.assertEqual(done_events[0]["duration"], stored_messages[-1].duration)
            token_events = [
                message for _, message in hub.messages if message["type"] == "token"
            ]
            self.assertEqual(token_events[0]["sequence"], 1)
            self.assertEqual(token_events[0]["full_content"], "done")
            self.assertTrue(
                all(
                    message["conversation_id"] == conversation.id
                    and message["run_id"] == run_id
                    for _, message in hub.messages
                )
            )

            event_count = len(hub.messages)
            await asyncio.sleep(0.03)
            self.assertEqual(len(hub.messages), event_count)

    async def test_task_health_status_and_activity_tracking(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(Path(temp_dir) / "orbitpane-test.db")
            database.migrate()
            conversation = database.create_conversation("Test", temp_dir, "fake")
            provider = BlockingProvider()
            hub = RecordingHub()
            coordinator = AgentCoordinator(
                database,
                FakeRegistry(provider),  # type: ignore[arg-type]
                hub,
            )
            from backend.app.realtime import TaskState
            state = TaskState(
                provider="fake",
                model="test-model",
                run_id="run-1",
                user_content="hello",
            )
            self.assertEqual(coordinator._health_status(state), "active")
            msg = coordinator._state_message(1, state, "elapsed")
            self.assertEqual(msg["health_status"], "active")
            self.assertIn("inactive_seconds", msg)

            state.last_activity_time -= 50
            self.assertEqual(coordinator._health_status(state), "slow")

            state.last_activity_time -= 80
            self.assertEqual(coordinator._health_status(state), "stalled")

            state.status_message = "模型重试中..."
            self.assertEqual(coordinator._health_status(state), "retrying")


class AugmentPromptTests(TestCase):
    def test_unrestricted_projects_are_pointed_at_their_guideline_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "README.md").write_text("hello", encoding="utf-8")

            prompt = AgentCoordinator._augment_prompt(temp_dir, "hi", "unrestricted")

            self.assertIn("README.md", prompt)
            self.assertTrue(prompt.endswith("hi"))

    def test_restricted_projects_are_not_told_to_read_anything(self) -> None:
        """The note forces a tool call that a sandboxed print-mode run cannot
        get approved, which turned every prompt in the project into an empty
        answer. Leave the decision to the agent when permissions are limited."""
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "README.md").write_text("hello", encoding="utf-8")

            self.assertEqual(
                AgentCoordinator._augment_prompt(temp_dir, "hi", "workspace"),
                "hi",
            )

    def test_workspace_without_guideline_files_is_left_alone(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                AgentCoordinator._augment_prompt(temp_dir, "hi", "unrestricted"),
                "hi",
            )
