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


class AgentCoordinatorTests(IsolatedAsyncioTestCase):
    async def test_busy_message_is_not_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(Path(temp_dir) / "history.db")
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
            for _ in range(100):
                if not coordinator.is_running(conversation.id):
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(
                [message.content for message in database.list_messages(conversation.id)],
                ["first", "done"],
            )

