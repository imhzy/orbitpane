from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

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

    async def send_json(self, message: dict[str, object]) -> None:
        self.messages.append(message)


class AgentCoordinatorTests(IsolatedAsyncioTestCase):
    async def wait_until_finished(
        self, coordinator: AgentCoordinator, conversation_id: int
    ) -> None:
        for _ in range(200):
            if not coordinator.is_running(conversation_id):
                return
            await asyncio.sleep(0.01)
        self.fail("Agent task did not finish")

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
            queued_catalog = [
                item
                for item in coordinator.task_catalog(conversation_id=conversation.id)
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
