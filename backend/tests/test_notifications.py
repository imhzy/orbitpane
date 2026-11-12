from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

import httpx
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import ValidationError
from pywebpush import WebPushException

from backend.app.application import create_app
from backend.app.database import Database
from backend.app.models import PushSubscription
from backend.app.notifications import PushNotifications
from backend.app.application import ConnectionHub
from backend.app.realtime import AgentCoordinator
from backend.tests.helpers import test_settings
from backend.tests.test_realtime import BlockingProvider, FakeRegistry


def configured_settings(root):
    key = ec.generate_private_key(ec.SECP256R1())
    encoded = base64.urlsafe_b64encode(key.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )).decode().rstrip("=")
    return replace(test_settings(root), push_vapid_private_key=encoded,
                   push_vapid_subject="https://orbitpane.example.com")


def subscription(public_key, endpoint="https://web.push.apple.com/test-device"):
    return {"endpoint": endpoint, "application_server_key": public_key,
            "keys": {"p256dh": public_key,
                     "auth": base64.urlsafe_b64encode(b"0123456789abcdef").decode().rstrip("=")}}


class PushTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = configured_settings(Path(self.temp.name))
        self.db = Database(self.settings.database_path)
        self.db.migrate()
        self.push = PushNotifications(self.settings, self.db)
        self.sub = subscription(self.push.public_key)
        self.db.save_push_subscription(self.sub)
        self.conv = self.db.create_conversation("Private title", self.temp.name, "fake")

    def complete(self, run_id="run-1", status="completed"):
        self.db.create_run(run_id, self.conv.id, status="running", prompt="secret prompt",
                           model="test", provider="fake", is_summary=False)
        self.db.update_run(run_id, status=status)

    def pending(self):
        return self.db.pending_push_deliveries(self.push.public_key)

    def test_queue_survives_restart_and_deduplicates_completed_runs(self):
        self.complete()
        self.db = Database(self.settings.database_path)
        self.db.migrate()
        self.assertEqual(len(self.pending()), 1)
        self.db.update_run("run-1", status="completed")
        self.assertEqual(len(self.pending()), 1)
        self.db.finish_push_delivery("run-1", self.sub["endpoint"])
        self.db.update_run("run-1", status="completed")
        self.assertEqual(self.pending(), [])
        self.complete("failed", "failed")
        self.complete("interrupted", "interrupted")
        self.assertEqual(self.pending(), [])

    def test_unsubscribe_history_clear_and_delete_remove_pending_notifications(self):
        self.complete()
        self.db.delete_push_subscription(self.sub["endpoint"])
        self.assertEqual(self.pending(), [])
        self.db.save_push_subscription(self.sub)
        self.complete("second")
        self.db.clear_history(self.conv.id)
        self.assertEqual(self.pending(), [])
        self.complete("third")
        self.db.delete_conversation(self.conv.id)
        self.assertEqual(self.pending(), [])

    def test_multiple_devices_and_expired_queue(self):
        self.db.save_push_subscription(subscription(self.push.public_key, "https://fcm.googleapis.com/device"))
        self.complete()
        self.assertEqual(len(self.pending()), 2)
        with patch("backend.app.database.time.time", return_value=time.time() + 86401):
            self.assertEqual(self.pending(), [])

    def test_rotated_key_removes_old_subscriptions(self):
        self.complete()
        self.assertEqual(self.db.pending_push_deliveries("new-key"), [])
        self.complete("second")
        self.assertEqual(self.pending(), [])

    def test_delivery_is_private_encrypted_and_linked_to_conversation(self):
        self.complete()
        with patch("backend.app.notifications.webpush") as send:
            self.push.deliver(self.pending()[0])
        args = send.call_args.kwargs
        payload = json.loads(args["data"])
        self.assertEqual(payload["url"], f"/?id={self.conv.id}")
        self.assertEqual(payload["tag"], "orbitpane-run-1")
        self.assertNotIn("secret", args["data"])
        self.assertNotIn("Private title", args["data"])
        self.assertEqual(args["content_encoding"], "aes128gcm")
        self.assertEqual(args["requests_session"].max_redirects, 0)
        self.assertEqual(self.pending(), [])

    def test_real_webpush_encrypts_and_signs_without_network(self):
        self.complete()
        response = requests.Response()
        response.status_code = 201
        with patch("requests.Session.post", return_value=response) as post:
            self.push.deliver(self.pending()[0])
        self.assertTrue(post.called)
        args = post.call_args.kwargs
        self.assertIn("vapid", args["headers"]["authorization"].lower())
        self.assertNotIn("任务".encode(), args["data"])
        self.assertEqual(self.pending(), [])

    def test_expired_subscription_is_removed_and_transient_failure_retries(self):
        for code in (410, 404, 429, 503, 403):
            with self.subTest(status=code):
                self.db.save_push_subscription(self.sub)
                self.complete(f"run-{code}")
                response = requests.Response()
                response.status_code = code
                with patch("backend.app.notifications.webpush", side_effect=WebPushException("redacted", response=response)):
                    self.push.deliver(self.pending()[0])
                if code in (429, 503):
                    self.assertEqual(self.pending(), [])  # Backoff, not lost work.
                    with patch("backend.app.database.time.time", return_value=time.time() + 31):
                        pending = self.pending()
                    self.assertEqual(len(pending), 1)
                    self.assertEqual(pending[0]["attempts"], 1)
                self.db.delete_push_subscription(self.sub["endpoint"])

    def test_endpoint_and_encryption_key_validation(self):
        for endpoint in ("http://web.push.apple.com/a", "https://localhost/a",
                         "https://127.0.0.1/a", "https://web.push.apple.com.evil.test/a",
                         "https://web.push.apple.com@evil.test/a", "https://web.push.apple.com:444/a"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValidationError):
                PushSubscription(**subscription(self.push.public_key, endpoint))
        invalid = subscription(self.push.public_key)
        invalid["keys"]["p256dh"] = "A" * 87
        with self.assertRaises(ValidationError):
            PushSubscription(**invalid)


class PushApplicationTests(IsolatedAsyncioTestCase):
    async def test_push_routes_require_auth_and_validate_keys(self):
        with tempfile.TemporaryDirectory() as root:
            app = create_app(configured_settings(Path(root)))
            app.state.database.migrate()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                sub = subscription(app.state.notifications.public_key)
                for method, path, body in (("GET", "/api/push/config", None),
                                           ("PUT", "/api/push/subscription", sub),
                                           ("DELETE", "/api/push/subscription", {"endpoint": sub["endpoint"]})):
                    self.assertEqual((await client.request(method, path, json=body)).status_code, 401)
                await client.post("/api/login", json={"pin": "test-pin"})
                config = await client.get("/api/push/config")
                self.assertTrue(config.json()["enabled"])
                self.assertNotIn(app.state.settings.push_vapid_private_key, config.text)
                for _ in range(2):
                    self.assertEqual((await client.put("/api/push/subscription", json=sub)).status_code, 200)
                self.assertEqual((await client.put("/api/push/subscription", json={**sub, "application_server_key": "old"})).status_code, 409)
                self.assertEqual((await client.put("/api/push/subscription", json={**sub, "endpoint": "https://127.0.0.1/private"})).status_code, 422)
                self.assertEqual((await client.request("DELETE", "/api/push/subscription", json={"endpoint": sub["endpoint"]})).status_code, 200)

    async def test_successful_task_enqueues_without_any_websocket_client(self):
        with tempfile.TemporaryDirectory() as root:
            settings = configured_settings(Path(root))
            db = Database(settings.database_path)
            db.migrate()
            push = PushNotifications(settings, db)
            db.save_push_subscription(subscription(push.public_key))
            conv = db.create_conversation("Test", root, "fake")
            provider = BlockingProvider()
            coordinator = AgentCoordinator(db, FakeRegistry(provider), ConnectionHub())
            try:
                submitted = await coordinator.submit(conv, content="task", model="test-model", provider_id="fake", request_id="retry-me")
                provider.release.set()
                for _ in range(200):
                    if not coordinator.is_running(conv.id):
                        break
                    await asyncio.sleep(.01)
                self.assertEqual(db.get_run(submitted["run_id"])["status"], "completed")
                await coordinator.submit(conv, content="task", model="test-model", provider_id="fake", request_id="retry-me")
                self.assertEqual(len(db.pending_push_deliveries(push.public_key)), 1)
            finally:
                await coordinator.shutdown()
