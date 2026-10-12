from __future__ import annotations

import asyncio
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from backend.app.agents.base import AgentProvider, AgentResult, ProviderError, SUMMARY_PROMPT
from backend.app.application import create_app
from backend.app.database import Database
from backend.app.models import ScheduleSpec
from backend.app.realtime import AgentCoordinator
from backend.app.schedule_rules import next_fire_time, parse_time
from backend.app.scheduler import ScheduleService
from backend.tests.helpers import test_settings
from backend.tests.test_realtime import FakeRegistry, RecordingHub
from backend.tests.test_notifications import configured_settings, subscription
from backend.app.notifications import PushNotifications

NOW = datetime(2026, 10, 12, 0, 0, tzinfo=timezone.utc)
INTERVAL = {"kind": "interval", "interval": 1, "unit": "minutes"}


class RecurrenceTests(TestCase):
    def test_interval_preserves_phase_and_first_execution_waits(self):
        rule = ScheduleSpec.model_validate(INTERVAL)
        self.assertEqual(next_fire_time(rule, NOW), NOW + timedelta(minutes=1))
        self.assertEqual(next_fire_time(rule, NOW + timedelta(minutes=8, seconds=32), anchor=NOW), NOW + timedelta(minutes=9))
        self.assertEqual(next_fire_time(ScheduleSpec(kind="interval", interval=2, unit="hours"), NOW), NOW + timedelta(hours=2))

    def test_calendar_multiple_times_weekdays_and_timezone(self):
        rule = ScheduleSpec(kind="daily", times=["18:00", "09:00"])
        self.assertEqual(next_fire_time(rule, NOW), NOW + timedelta(hours=1))
        self.assertEqual(next_fire_time(rule, NOW + timedelta(hours=1)), NOW + timedelta(hours=10))
        weekly = ScheduleSpec(kind="weekly", times=["09:00"], weekdays=[2, 4])
        self.assertEqual(next_fire_time(weekly, NOW), NOW + timedelta(days=2, hours=1))
        self.assertEqual(next_fire_time(ScheduleSpec(kind="daily", timezone="UTC", times=["09:00"]), NOW), NOW + timedelta(hours=9))

    def test_dst_gaps_are_skipped_and_repeated_wall_time_runs_once(self):
        spring = ScheduleSpec(kind="daily", timezone="America/New_York", times=["02:30"])
        self.assertEqual(next_fire_time(spring, parse_time("2026-03-08T05:00:00Z")), parse_time("2026-03-09T06:30:00Z"))
        autumn = ScheduleSpec(kind="daily", timezone="America/New_York", times=["01:30"])
        first = next_fire_time(autumn, parse_time("2026-11-01T04:00:00Z"))
        self.assertEqual(first, parse_time("2026-11-01T05:30:00Z"))
        self.assertEqual(next_fire_time(autumn, first), parse_time("2026-11-02T06:30:00Z"))

    def test_invalid_rules_are_rejected(self):
        for spec in [
            {**INTERVAL, "interval": 0}, {**INTERVAL, "interval": True},
            {**INTERVAL, "timezone": "../../etc/passwd"}, {**INTERVAL, "unknown": True},
            {"kind": "weekly", "times": ["09:00"]},
            {"kind": "weekly", "times": ["09:00"], "weekdays": [7]},
            {"kind": "daily", "times": ["25:00"]}, {"kind": "daily", "times": ["09:00", "09:00"]},
            {"kind": "daily", "times": ["09:00"], "interval": 2},
        ]:
            with self.subTest(spec=spec), self.assertRaises(ValidationError):
                ScheduleSpec.model_validate(spec)


class ScheduleDatabaseTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Database(Path(self.temp.name) / "schedule.db")
        self.db.migrate()
        self.conv = self.db.create_conversation("Scheduled chat", self.temp.name, "fake")

    def schedule(self, **kwargs):
        return self.db.create_schedule(self.conv.id, name="Check", prompt="inspect", spec=INTERVAL,
                                       compact_before=False, enabled=True, now=NOW, **kwargs)

    def test_concurrent_claim_is_atomic_and_each_live_period_is_retained(self):
        item = self.schedule()
        due = NOW + timedelta(minutes=1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.db.claim_due_schedules(due), range(2)))
        self.assertEqual(sum(map(len, results)), 1)
        self.db.claim_due_schedules(due + timedelta(minutes=1))
        runs = self.db.list_runs(conversation_id=self.conv.id)
        self.assertEqual(len(runs), 2)
        self.assertEqual({record["schedule_id"] for record in runs}, {item["id"]})
        self.assertEqual(self.db.get_schedule(self.conv.id, item["id"])["pending_count"], 2)

    def test_startup_and_late_ticks_skip_without_replaying(self):
        item = self.schedule()
        self.assertEqual(self.db.claim_due_schedules(NOW + timedelta(minutes=8), skip_all=True), [])
        self.assertEqual(parse_time(self.db.get_schedule(self.conv.id, item["id"])["next_run_at"]), NOW + timedelta(minutes=9))
        self.assertEqual(self.db.claim_due_schedules(NOW + timedelta(minutes=10, seconds=15)), [])
        self.assertEqual(self.db.list_runs(), [])
        self.assertEqual(len(self.db.claim_due_schedules(NOW + timedelta(minutes=11))), 1)

    def test_pause_resume_version_and_manual_run_idempotency(self):
        item = self.schedule()
        run_id = self.db.create_schedule_run(self.conv.id, item["id"], "click")
        self.assertEqual(self.db.create_schedule_run(self.conv.id, item["id"], "click"), run_id)
        self.assertEqual(self.db.get_schedule(self.conv.id, item["id"])["next_run_at"], item["next_run_at"])
        paused = self.db.update_schedule(self.conv.id, item["id"], {"enabled": False, "version": 1}, now=NOW)
        self.assertIsNone(paused["next_run_at"])
        with self.assertRaises(ValueError):
            self.db.update_schedule(self.conv.id, item["id"], {"name": "stale", "version": 1})
        resumed = self.db.update_schedule(self.conv.id, item["id"], {"enabled": True}, now=NOW + timedelta(days=2))
        self.assertEqual(parse_time(resumed["next_run_at"]), NOW + timedelta(days=2, minutes=1))
        self.db.migrate()
        self.assertEqual(self.db.get_run(run_id)["status"], "interrupted")

    def test_deletion_retains_source_snapshot_clear_retains_rules_conversation_cascades(self):
        item = self.schedule()
        run_id = self.db.create_schedule_run(self.conv.id, item["id"], "click")
        self.db.add_message(self.conv.id, "user", "inspect", schedule_id=item["id"], schedule_name="Check", run_id=run_id)
        self.db.delete_schedule(self.conv.id, item["id"])
        self.assertIsNone(self.db.get_run(run_id)["schedule_id"])
        self.assertEqual(self.db.get_run(run_id)["schedule_name"], "Check")
        self.assertEqual(self.db.list_messages(self.conv.id)[0].schedule_name, "Check")
        kept = self.schedule()
        self.db.clear_history(self.conv.id)
        self.assertIsNotNone(self.db.get_schedule(self.conv.id, kept["id"]))
        self.assertEqual(self.db.list_runs(), [])
        self.db.delete_conversation(self.conv.id)
        self.assertEqual(self.db.list_schedules(), [])

    def test_scheduled_failure_push_is_private_and_deduplicated(self):
        settings = configured_settings(Path(self.temp.name))
        push = PushNotifications(settings, self.db)
        self.db.save_push_subscription(subscription(push.public_key))
        item = self.schedule()
        run_id = self.db.create_schedule_run(self.conv.id, item["id"], "click")
        self.db.update_run(run_id, status="failed", error="private command error")
        self.db.update_run(run_id, status="failed")
        pending = self.db.pending_push_deliveries(push.public_key)
        self.assertEqual(len(pending), 1)
        with patch("backend.app.notifications.webpush") as send:
            push.deliver(pending[0])
        payload = send.call_args.kwargs["data"]
        self.assertIn("定时任务失败", payload)
        self.assertNotIn("private command", payload)
        self.assertNotIn("Scheduled chat", payload)

    def test_editing_prompt_keeps_cadence_and_claim_keeps_its_original_snapshot(self):
        item = self.schedule()
        claimed = self.db.claim_due_schedules(NOW + timedelta(minutes=1))[0]
        before = self.db.get_schedule(self.conv.id, item["id"])
        updated = self.db.update_schedule(self.conv.id, item["id"],
            {"name": "Renamed", "prompt": "new command", "spec": item["spec"]},
            now=NOW + timedelta(minutes=1, seconds=20))
        self.assertEqual(updated["next_run_at"], before["next_run_at"])
        record = self.db.get_run(claimed["run_id"])
        self.assertEqual(record["prompt"], "inspect")
        self.assertEqual(record["schedule_name"], "Check")


class TestProvider(AgentProvider):
    id = "fake"
    display_name = "Fake"
    models = ("test-model",)

    def __init__(self):
        self.calls = []
        self.release = asyncio.Event()
        self.fail_compaction = False

    async def run(self, request, emit):
        self.calls.append(request)
        if request.prompt == "manual":
            await self.release.wait()
        if request.prompt == SUMMARY_PROMPT:
            if self.fail_compaction:
                raise ProviderError("compression unavailable")
            return AgentResult("compressed memory")
        return AgentResult("reply to " + request.prompt)

    async def interrupt(self, conversation_id):
        self.release.set()


class ScheduleExecutionTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = test_settings(self.root)
        self.db = Database(self.settings.database_path)
        self.db.migrate()
        self.conv = self.db.create_conversation("Chat", self.temp.name, "fake")
        self.provider = TestProvider()
        self.hub = RecordingHub()
        self.coordinator = AgentCoordinator(self.db, FakeRegistry(self.provider), self.hub, self.settings)
        self.scheduler = ScheduleService(self.db, self.coordinator, self.hub)

    async def asyncTearDown(self):
        self.provider.release.set()
        await self.coordinator.shutdown()
        self.temp.cleanup()

    def schedule(self, prompt="scheduled", compact=False):
        return self.db.create_schedule(self.conv.id, name="Check", prompt=prompt, spec=INTERVAL,
            compact_before=compact, enabled=True, now=NOW)

    async def finished(self):
        for _ in range(200):
            if not self.coordinator.is_running(self.conv.id):
                return
            await asyncio.sleep(.01)
        self.fail("queue did not finish")

    async def manual(self):
        await self.coordinator.submit(self.conv, content="manual", model=None, provider_id=None)
        await asyncio.sleep(.01)

    async def test_every_trigger_queues_with_manual_chat_and_keeps_source(self):
        await self.manual()
        first = self.schedule()
        self.db.create_schedule(self.conv.id, name="Other", prompt="other", spec={**INTERVAL, "interval": 2},
            compact_before=False, enabled=True, now=NOW)
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        await self.scheduler.tick(NOW + timedelta(minutes=2))
        await self.scheduler.tick(NOW + timedelta(minutes=2))
        self.assertEqual([q["prompt"] for q in self.coordinator.queue_items(self.conv.id)], ["scheduled", "scheduled", "other"])
        self.provider.release.set()
        await self.finished()
        self.assertEqual([r.prompt for r in self.provider.calls], ["manual", "scheduled", "scheduled", "other"])
        scheduled = [m for m in self.db.list_messages(self.conv.id) if m.schedule_id == first["id"]]
        self.assertEqual([m.role for m in scheduled], ["user", "agent", "user", "agent"])
        self.assertTrue(all(m.schedule_name == "Check" and m.scheduled_for for m in scheduled))
        self.assertTrue(all(r.permission_mode == "workspace" for r in self.provider.calls))

    async def test_compaction_uses_context_at_execution_and_keeps_history(self):
        await self.manual()
        item = self.schedule(compact=True)
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        self.assertEqual(len(self.provider.calls), 1)
        self.provider.release.set()
        await self.finished()
        self.assertEqual([r.prompt for r in self.provider.calls], ["manual", SUMMARY_PROMPT, "scheduled"])
        self.assertEqual([m.content for m in self.provider.calls[1].history], ["manual", "reply to manual"])
        self.assertEqual([m.content for m in self.provider.calls[2].history], ["compressed memory"])
        messages = self.db.list_messages(self.conv.id)
        self.assertEqual([m.role for m in messages], ["user", "agent", "summary", "user", "agent"])
        self.assertEqual(self.db.get_schedule(self.conv.id, item["id"])["last_status"], "completed")
        self.assertIsNotNone(self.db.get_conversation(self.conv.id).active_summary_id)
        self.assertTrue(any(event.get("health_status") == "compacting" for _, event in self.hub.messages))

    async def test_failed_compaction_stops_command_and_next_queued_task_runs(self):
        self.db.add_message(self.conv.id, "user", "memory")
        self.provider.fail_compaction = True
        item = self.schedule(compact=True)
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        await self.coordinator.submit(self.conv, content="next", model=None, provider_id=None)
        await self.finished()
        self.assertNotIn("scheduled", [r.prompt for r in self.provider.calls])
        self.assertIn("next", [r.prompt for r in self.provider.calls])
        self.assertEqual(self.db.get_schedule(self.conv.id, item["id"])["last_status"], "failed")
        failures = [m for m in self.db.list_messages(self.conv.id) if m.is_error]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].error_code, "compaction_failed")
        self.assertIsNone(self.db.get_conversation(self.conv.id).active_summary_id)

    async def test_deleted_queued_schedule_never_starts(self):
        await self.manual()
        item = self.schedule()
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        await self.coordinator.cancel_scheduled_queue(self.conv.id, item["id"])
        self.db.delete_schedule(self.conv.id, item["id"])
        self.provider.release.set()
        await self.finished()
        self.assertEqual([r.prompt for r in self.provider.calls], ["manual"])
        self.assertIn("canceled", [r["status"] for r in self.db.list_runs()])

    async def test_invalid_workspace_fails_persistently_instead_of_running(self):
        item = self.schedule()
        self.db.update_conversation(self.conv.id, path="/not-allowed")
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.db.get_schedule(self.conv.id, item["id"])["last_status"], "failed")
        self.assertTrue(self.db.list_messages(self.conv.id)[-1].is_error)

    async def test_reorder_cannot_duplicate_a_scheduled_command(self):
        await self.manual()
        self.schedule()
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        run_id = self.coordinator.queue_items(self.conv.id)[0]["run_id"]
        with self.assertRaises(ValueError):
            await self.coordinator.reorder_queue(self.conv.id, [run_id, run_id])
        self.assertEqual(len(self.coordinator.queue_items(self.conv.id)), 1)

    async def test_checkpoint_write_failure_rolls_back_summary_and_stops_command(self):
        self.db.add_message(self.conv.id, "user", "memory")
        with self.db.connect() as connection:
            connection.executescript("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON summary_checkpoints "
                                   "BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END;")
        self.schedule(compact=True)
        await self.scheduler.tick(NOW + timedelta(minutes=1))
        await self.finished()
        self.assertEqual([request.prompt for request in self.provider.calls], [SUMMARY_PROMPT])
        self.assertFalse(any(message.role == "summary" for message in self.db.list_messages(self.conv.id)))
        self.assertIsNone(self.db.get_conversation(self.conv.id).active_summary_id)
        self.assertEqual(self.db.list_messages(self.conv.id)[-1].error_code, "compaction_failed")

    async def test_background_poller_executes_without_any_browser_connection(self):
        await self.scheduler.prepare()
        self.db.create_schedule(self.conv.id, name="Background", prompt="background", spec=INTERVAL,
            compact_before=False, enabled=True, now=datetime.now(timezone.utc) - timedelta(seconds=59.95))
        self.scheduler.POLL_SECONDS = .01
        worker = asyncio.create_task(self.scheduler.run())
        try:
            for _ in range(200):
                if self.db.list_schedules()[0]["last_status"] == "completed":
                    break
                await asyncio.sleep(.01)
            else:
                self.fail("background schedule did not execute")
            self.assertEqual([request.prompt for request in self.provider.calls], ["background"])
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)


class ScheduleAPITests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(test_settings(Path(self.temp.name)))
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.db = self.app.state.database
        self.conv = self.db.create_conversation("Existing", self.temp.name, "antigravity")
        self.base = f"/api/conversations/{self.conv.id}/schedules"
        self.body = {"name": "Weekly", "prompt": "inspect", "spec": {"kind": "weekly", "times": ["09:00", "18:00"], "weekdays": [0, 2], "timezone": "Asia/Shanghai"}}

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)
        self.temp.cleanup()

    async def login(self):
        self.assertEqual((await self.client.post("/api/login", json={"pin": "test-pin"})).status_code, 200)

    async def test_every_schedule_route_requires_auth(self):
        for method, url, payload in [
            ("GET", "/api/schedules", None), ("GET", self.base, None), ("POST", self.base, self.body),
            ("PATCH", self.base + "/1", {"enabled": False}), ("DELETE", self.base + "/1", None),
            ("POST", self.base + "/1/run", {"request_id": "one"}),
        ]:
            response = await self.client.request(method, url, json=payload)
            self.assertEqual(response.status_code, 401, response.text)

    async def test_crud_multiple_tasks_validation_and_conversation_ownership(self):
        await self.login()
        response = await self.client.post(self.base, json=self.body)
        self.assertEqual(response.status_code, 201, response.text)
        item = response.json()
        self.assertFalse(item["compact_before"])
        self.assertEqual((await self.client.post(self.base, json={**self.body, "spec": INTERVAL})).status_code, 201)
        self.assertEqual(len((await self.client.get(self.base)).json()["items"]), 2)
        updated = await self.client.patch(f"{self.base}/{item['id']}", json={"enabled": False, "compact_before": True, "version": 1})
        self.assertEqual(updated.status_code, 200)
        self.assertIsNone(updated.json()["next_run_at"])
        self.assertEqual((await self.client.patch(f"{self.base}/{item['id']}", json={"name": "stale", "version": 1})).status_code, 409)
        for payload in [{"prompt": "  "}, {"enabled": None}, {"spec": {"kind": "weekly", "times": ["09:00"]}}]:
            self.assertEqual((await self.client.patch(f"{self.base}/{item['id']}", json=payload)).status_code, 422)
        other = self.db.create_conversation("Other", self.temp.name, "antigravity")
        self.assertEqual((await self.client.delete(f"/api/conversations/{other.id}/schedules/{item['id']}")).status_code, 404)
        self.assertEqual((await self.client.delete(f"{self.base}/{item['id']}")).status_code, 200)
        self.assertEqual((await self.client.get("/api/conversations/999/schedules")).status_code, 404)

    async def test_run_now_is_idempotent_and_uses_current_chat_permissions(self):
        await self.login()
        item = (await self.client.post(self.base, json=self.body)).json()
        provider = TestProvider()
        self.app.state.providers._providers["antigravity"] = provider
        url = f"{self.base}/{item['id']}/run"
        first = await self.client.post(url, json={"request_id": "one"})
        self.assertEqual(first.status_code, 200, first.text)
        second = await self.client.post(url, json={"request_id": "one"})
        self.assertEqual(first.json()["run_id"], second.json()["run_id"])
        for _ in range(100):
            if not self.app.state.coordinator.is_running(self.conv.id): break
            await asyncio.sleep(.01)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0].permission_mode, "workspace")
        self.assertEqual(len(self.db.list_messages(self.conv.id)), 2)
        await self.client.delete(f"/api/conversations/{self.conv.id}")
        self.assertEqual((await self.client.get("/api/schedules")).json()["items"], [])
