from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

import httpx

from backend.app.application import (
    SHARE_MAX_PER_CONVERSATION,
    ShareTokenLogFilter,
    create_app,
)
from backend.tests.helpers import test_settings


class ApplicationTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        settings = test_settings(self.root)
        self.app = create_app(settings)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://test",
        )

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)
        self.temp_dir.cleanup()

    async def login_headers(self) -> dict[str, str]:
        response = await self.client.post("/api/login", json={"pin": "test-pin"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("orbitpane_session", response.cookies)
        return {}

    async def test_protected_routes_require_authentication(self) -> None:
        response = await self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 401)

    async def test_create_and_list_conversation(self) -> None:
        headers = await self.login_headers()
        response = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={
                "name": "Test workspace",
                "path": str(self.workspace),
                "provider": "antigravity",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["provider"], "antigravity")
        # Omitting permission_mode must land on the sandboxed option.
        self.assertEqual(response.json()["permission_mode"], "workspace")

        listed = await self.client.get("/api/conversations", headers=headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()), 1)

    async def test_conversation_permission_mode_can_be_selected_and_updated(self) -> None:
        headers = await self.login_headers()
        created = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={
                "name": "Unrestricted workspace",
                "path": str(self.workspace),
                "provider": "antigravity",
                "permission_mode": "unrestricted",
            },
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["permission_mode"], "unrestricted")

        updated = await self.client.put(
            f"/api/conversations/{created.json()['id']}",
            headers=headers,
            json={"permission_mode": "workspace"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["permission_mode"], "workspace")

        invalid = await self.client.put(
            f"/api/conversations/{created.json()['id']}",
            headers=headers,
            json={"permission_mode": "invalid"},
        )
        self.assertEqual(invalid.status_code, 422)

    async def test_models_endpoint_returns_display_names(self) -> None:
        headers = await self.login_headers()
        response = await self.client.get("/api/models", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(
            payload["models"],
            [{"id": "test-model", "display_name": "Test Model"}],
        )
        self.assertEqual(payload["providers"][0]["tone"], "gemini")

    async def test_message_feedback_round_trip(self) -> None:
        headers = await self.login_headers()
        created = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={"name": "Feedback", "path": str(self.workspace)},
        )
        self.assertEqual(created.status_code, 201, created.text)
        conversation_id = created.json()["id"]
        message_id = self.app.state.database.add_message(
            conversation_id, "agent", "answer"
        )

        rated = await self.client.patch(
            f"/api/conversations/{conversation_id}/messages/{message_id}/feedback",
            headers=headers,
            json={"feedback": "down"},
        )
        self.assertEqual(rated.status_code, 200, rated.text)
        self.assertEqual(rated.json()["feedback"], "down")

        history = await self.client.get(
            f"/api/history/{conversation_id}", headers=headers
        )
        self.assertEqual(history.json()[0]["feedback"], "down")

        invalid = await self.client.patch(
            f"/api/conversations/{conversation_id}/messages/{message_id}/feedback",
            headers=headers,
            json={"feedback": "sideways"},
        )
        self.assertEqual(invalid.status_code, 422)

        missing = await self.client.patch(
            f"/api/conversations/{conversation_id}/messages/{message_id + 999}/feedback",
            headers=headers,
            json={"feedback": "up"},
        )
        self.assertEqual(missing.status_code, 404)

    async def test_workspace_cannot_escape_allowed_root(self) -> None:
        response = await self.client.get(
            "/api/ls",
            headers=await self.login_headers(),
            params={"path": "/"},
        )
        self.assertEqual(response.status_code, 400)

    async def test_conversation_file_search_is_scoped_and_ranked(self) -> None:
        source_dir = self.workspace / "frontend" / "src"
        source_dir.mkdir(parents=True)
        app_file = source_dir / "App.tsx"
        app_file.write_text("export default function App() {}", encoding="utf-8")
        (source_dir / "main.tsx").write_text("", encoding="utf-8")
        ignored_dir = self.workspace / "node_modules" / "app-package"
        ignored_dir.mkdir(parents=True)
        (ignored_dir / "app.js").write_text("", encoding="utf-8")

        headers = await self.login_headers()
        created = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={
                "name": "Search workspace",
                "path": str(self.workspace),
                "provider": "antigravity",
            },
        )
        self.assertEqual(created.status_code, 201, created.text)
        conversation_id = created.json()["id"]

        response = await self.client.get(
            f"/api/conversations/{conversation_id}/files",
            headers=headers,
            params={"q": "app"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        items = response.json()["items"]
        self.assertEqual(items[0]["name"], "App.tsx")
        self.assertEqual(items[0]["path"], str(app_file.resolve()))
        self.assertEqual(items[0]["relative_path"], "frontend/src/App.tsx")
        self.assertFalse(any("node_modules" in item["path"] for item in items))

    async def test_conversation_file_search_requires_existing_conversation(self) -> None:
        response = await self.client.get(
            "/api/conversations/999999/files",
            headers=await self.login_headers(),
            params={"q": "app"},
        )
        self.assertEqual(response.status_code, 404)

    async def _shared_conversation(self, **share_options: object) -> tuple[str, dict]:
        """Create a two-message project and publish a snapshot of it."""
        headers = await self.login_headers()
        created = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={
                "name": "Shared workspace",
                "path": str(self.workspace),
                "provider": "antigravity",
            },
        )
        self.assertEqual(created.status_code, 201, created.text)
        conversation_id = int(created.json()["id"])
        database = self.app.state.database
        database.add_message(conversation_id, "user", "第一个问题")
        database.add_message(
            conversation_id,
            "agent",
            "第一个回答",
            thought="internal reasoning about /etc/passwd",
            model="test-model",
        )

        response = await self.client.post(
            f"/api/conversations/{conversation_id}/shares",
            headers=headers,
            json=share_options,
        )
        self.assertEqual(response.status_code, 201, response.text)
        return str(conversation_id), response.json()

    async def test_share_link_is_readable_without_a_session(self) -> None:
        conversation_id, share = await self._shared_conversation()
        self.assertEqual(share["url_path"], f"/s/{share['token']}")
        self.assertEqual(share["message_count"], 2)
        self.assertIsNone(share["expires_at"])

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://test",
        ) as anonymous:
            # No cookie jar, no PIN: possession of the link is the whole grant.
            response = await anonymous.get(f"/api/shared/{share['token']}")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn("noindex", response.headers["X-Robots-Tag"])
            self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(response.headers["Cache-Control"], "no-store")

        snapshot = response.json()
        self.assertEqual(snapshot["title"], "Shared workspace")
        self.assertEqual(
            [message["content"] for message in snapshot["messages"]],
            ["第一个问题", "第一个回答"],
        )
        # The server's filesystem layout and the agent's reasoning are not part
        # of what was shared.
        self.assertNotIn("path", snapshot)
        self.assertNotIn("thought", snapshot["messages"][1])

        listed = await self.client.get(
            f"/api/conversations/{conversation_id}/shares",
            headers=await self.login_headers(),
        )
        self.assertEqual(listed.status_code, 200)
        items = listed.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["view_count"], 1)
        # The owner list is metadata only; the token exists in the URL alone.
        self.assertNotIn("token", items[0])

    async def test_share_snapshot_does_not_follow_later_turns(self) -> None:
        conversation_id, share = await self._shared_conversation()
        self.app.state.database.add_message(
            int(conversation_id), "user", "分享之后才说的话"
        )

        response = await self.client.get(f"/api/shared/{share['token']}")
        self.assertEqual(response.status_code, 200, response.text)
        contents = [message["content"] for message in response.json()["messages"]]
        self.assertNotIn("分享之后才说的话", contents)
        self.assertEqual(len(contents), 2)

    async def test_share_can_opt_into_agent_reasoning(self) -> None:
        _, share = await self._shared_conversation(include_thoughts=True)

        response = await self.client.get(f"/api/shared/{share['token']}")
        self.assertEqual(response.status_code, 200, response.text)
        snapshot = response.json()
        self.assertTrue(snapshot["include_thoughts"])
        self.assertEqual(
            snapshot["messages"][1]["thought"],
            "internal reasoning about /etc/passwd",
        )

    async def test_revoked_share_link_stops_resolving(self) -> None:
        conversation_id, share = await self._shared_conversation()
        headers = await self.login_headers()

        revoked = await self.client.delete(
            f"/api/conversations/{conversation_id}/shares/{share['id']}",
            headers=headers,
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)

        response = await self.client.get(f"/api/shared/{share['token']}")
        self.assertEqual(response.status_code, 404)
        repeated = await self.client.delete(
            f"/api/conversations/{conversation_id}/shares/{share['id']}",
            headers=headers,
        )
        self.assertEqual(repeated.status_code, 404)

    async def test_expired_share_link_is_gone_and_no_longer_stored(self) -> None:
        conversation_id, share = await self._shared_conversation(expires_in_days=1)
        self.assertIsNotNone(share["expires_at"])
        with self.app.state.database.connect() as connection:
            connection.execute(
                "UPDATE shares SET expires_at = ? WHERE id = ?",
                ("2020-01-01T00:00:00.000000Z", share["id"]),
            )

        response = await self.client.get(f"/api/shared/{share['token']}")
        self.assertEqual(response.status_code, 410)

        listed = await self.client.get(
            f"/api/conversations/{conversation_id}/shares",
            headers=await self.login_headers(),
        )
        self.assertEqual(listed.json()["items"], [])

    async def test_share_creation_requires_a_session(self) -> None:
        headers = await self.login_headers()
        created = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={
                "name": "Private workspace",
                "path": str(self.workspace),
                "provider": "antigravity",
            },
        )
        conversation_id = created.json()["id"]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://test",
        ) as anonymous:
            response = await anonymous.post(
                f"/api/conversations/{conversation_id}/shares", json={}
            )
        self.assertEqual(response.status_code, 401)

    async def test_empty_conversation_cannot_be_shared(self) -> None:
        headers = await self.login_headers()
        created = await self.client.post(
            "/api/conversations",
            headers=headers,
            json={
                "name": "Empty workspace",
                "path": str(self.workspace),
                "provider": "antigravity",
            },
        )
        response = await self.client.post(
            f"/api/conversations/{created.json()['id']}/shares",
            headers=headers,
            json={},
        )
        self.assertEqual(response.status_code, 422)

    async def test_unknown_share_tokens_are_indistinguishable(self) -> None:
        for token in ("not-a-real-token-value-000", "../../etc/passwd", "x"):
            response = await self.client.get(f"/api/shared/{token}")
            self.assertEqual(response.status_code, 404, token)

    async def test_deleting_a_project_takes_its_share_links_with_it(self) -> None:
        conversation_id, share = await self._shared_conversation()
        headers = await self.login_headers()

        deleted = await self.client.delete(
            f"/api/conversations/{conversation_id}", headers=headers
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)

        response = await self.client.get(f"/api/shared/{share['token']}")
        self.assertEqual(response.status_code, 404)
        # Not merely unreachable: the published copy is off the disk.
        database = self.app.state.database
        with database.connect() as connection:
            remaining = connection.execute("SELECT COUNT(*) FROM shares").fetchone()[0]
        self.assertEqual(remaining, 0)

    async def test_clearing_history_takes_its_share_links_with_it(self) -> None:
        conversation_id, share = await self._shared_conversation()
        headers = await self.login_headers()

        cleared = await self.client.delete(
            f"/api/history/{conversation_id}", headers=headers
        )
        self.assertEqual(cleared.status_code, 200, cleared.text)

        response = await self.client.get(f"/api/shared/{share['token']}")
        self.assertEqual(response.status_code, 404)
        listed = await self.client.get(
            f"/api/conversations/{conversation_id}/shares", headers=headers
        )
        self.assertEqual(listed.json()["items"], [])

    async def test_share_links_per_conversation_are_capped(self) -> None:
        conversation_id, _ = await self._shared_conversation()
        headers = await self.login_headers()

        for _ in range(SHARE_MAX_PER_CONVERSATION - 1):
            extra = await self.client.post(
                f"/api/conversations/{conversation_id}/shares", headers=headers, json={}
            )
            self.assertEqual(extra.status_code, 201, extra.text)

        refused = await self.client.post(
            f"/api/conversations/{conversation_id}/shares", headers=headers, json={}
        )
        self.assertEqual(refused.status_code, 409, refused.text)

    def test_share_tokens_are_redacted_from_the_access_log(self) -> None:
        record = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            __file__,
            0,
            '%s - "%s %s HTTP/%s" %d',
            ("1.2.3.4", "GET", "/api/shared/s3cr3t-token-value-here", "1.1", 200),
            None,
        )

        self.assertTrue(ShareTokenLogFilter().filter(record))

        self.assertNotIn("s3cr3t", record.getMessage())
        self.assertIn("/api/shared/<redacted>", record.getMessage())

    async def test_security_headers_are_present(self) -> None:
        response = await self.client.get("/api/health")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
