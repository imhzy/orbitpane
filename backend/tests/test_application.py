from __future__ import annotations

import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

import httpx

from backend.app.application import create_app
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
        self.assertEqual(response.json()["permission_mode"], "unrestricted")

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

    async def test_security_headers_are_present(self) -> None:
        response = await self.client.get("/api/health")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
