from __future__ import annotations

from pathlib import Path

from backend.app.config import Settings


def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        environment="test",
        database_path=tmp_path / "history.db",
        allowed_roots=(tmp_path.resolve(),),
        cors_origins=(),
        auth_pin="test-pin",
        auth_secret="test-secret-with-enough-entropy",
        auth_ttl_seconds=3600,
        history_max_chars=10_000,
        default_provider="antigravity",
        antigravity_command="true",
        antigravity_models=("test-model",),
        antigravity_proxy_url=None,
        antigravity_skip_permissions=False,
        codex_enabled=False,
        codex_command="codex",
        codex_models=(),
        codex_sandbox="workspace-write",
    )
