"""Persistent recurring triggers feeding the existing conversation queue."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from .database import Database
from .realtime import AgentCoordinator, ConnectionHub

logger = logging.getLogger(__name__)


class ScheduleService:
    POLL_SECONDS = 1.0

    def __init__(self, database: Database, coordinator: AgentCoordinator, hub: ConnectionHub):
        self.database = database
        self.coordinator = coordinator
        self.hub = hub
        # Management, deletion/reset and triggering share this lock so a new
        # trigger cannot slip between cancellation and a conversation wipe.
        self.lock = asyncio.Lock()

    async def prepare(self) -> None:
        async with self.lock:
            await asyncio.to_thread(self.database.claim_due_schedules, datetime.now(timezone.utc), skip_all=True)

    async def changed(self, conversation_id: int) -> None:
        await self.hub.broadcast(conversation_id, {"type": "schedules_changed", "conversation_id": conversation_id})

    async def tick(self, now: datetime | None = None) -> None:
        async with self.lock:
            claimed = await asyncio.to_thread(self.database.claim_due_schedules, now or datetime.now(timezone.utc))
            # Claims survive transient dispatch failures. Retrying a queued
            # record is safe: the coordinator recognizes attached run ids.
            pending = await asyncio.to_thread(self.database.pending_schedule_runs)
            known = self.coordinator.attached_run_ids()
            changed = {int(item["conversation_id"]) for item in claimed}
            for record in pending:
                if record["run_id"] in known:
                    continue
                await self.coordinator.submit_scheduled_run(str(record["run_id"]))
                changed.add(int(record["conversation_id"]))
            for conversation_id in changed:
                await self.changed(conversation_id)

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Schedule polling failed; retrying on the next tick")
            await asyncio.sleep(self.POLL_SECONDS)
