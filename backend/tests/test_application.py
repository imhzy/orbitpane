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
        self.app = create_app(test_settings(self.root))
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
        self.assertIn("agy_session", response.cookies)
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
                "provider": "agy",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["provider"], "agy")

        listed = await self.client.get("/api/conversations", headers=headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()), 1)

    async def test_workspace_cannot_escape_allowed_root(self) -> None:
        response = await self.client.get(
            "/api/ls",
            headers=await self.login_headers(),
            params={"path": "/"},
        )
        self.assertEqual(response.status_code, 400)

    async def test_security_headers_are_present(self) -> None:
        response = await self.client.get("/api/health")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
