from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _paths(value: str | None) -> tuple[Path, ...]:
    raw_paths = _csv(value) or ("/root",)
    return tuple(Path(item).expanduser().resolve() for item in raw_paths)


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str
    database_path: Path
    allowed_roots: tuple[Path, ...]
    cors_origins: tuple[str, ...]
    auth_pin: str
    auth_secret: str
    auth_ttl_seconds: int
    history_max_chars: int
    default_provider: str
    agy_command: str
    agy_models: tuple[str, ...]
    agy_proxy_url: str | None
    agy_skip_permissions: bool
    codex_enabled: bool
    codex_command: str
    codex_models: tuple[str, ...]
    codex_sandbox: str

    @classmethod
    def from_env(cls) -> "Settings":
        environment = os.getenv("AGY_ENV", "development").strip().lower()
        auth_pin = os.getenv("AGY_PIN", "0524" if environment == "development" else "")
        auth_secret = os.getenv("AGY_AUTH_SECRET", "")

        if environment == "production" and (not auth_pin or not auth_secret):
            raise RuntimeError(
                "AGY_PIN and AGY_AUTH_SECRET are required when AGY_ENV=production"
            )
        if not auth_secret:
            auth_secret = secrets.token_urlsafe(32)
            logger.warning(
                "AGY_AUTH_SECRET is not configured; login sessions will be invalidated "
                "when the backend restarts"
            )
        if environment == "development" and auth_pin == "0524":
            logger.warning("Using the development-only default PIN; set AGY_PIN before deployment")

        return cls(
            environment=environment,
            database_path=Path(
                os.getenv("AGY_DATABASE_PATH", str(PROJECT_ROOT / "history.db"))
            ).expanduser().resolve(),
            allowed_roots=_paths(os.getenv("AGY_ALLOWED_ROOTS")),
            cors_origins=_csv(os.getenv("AGY_CORS_ORIGINS")),
            auth_pin=auth_pin,
            auth_secret=auth_secret,
            auth_ttl_seconds=int(os.getenv("AGY_AUTH_TTL_SECONDS", "43200")),
            history_max_chars=int(os.getenv("AGY_HISTORY_MAX_CHARS", "120000")),
            default_provider=os.getenv("AGY_DEFAULT_PROVIDER", "agy").strip(),
            agy_command=os.getenv("AGY_COMMAND", "agy").strip(),
            agy_models=_csv(os.getenv("AGY_MODELS"))
            or (
                "gemini-3.6-flash-high",
                "gemini-3.6-flash-medium",
                "gemini-3.6-flash-low",
                "gemini-3.5-flash-high",
                "gemini-3.5-flash-medium",
                "gemini-3.5-flash-low",
                "gemini-3.1-pro-high",
                "gemini-3.1-pro-low",
                "claude-sonnet-4-6",
                "claude-opus-4-6-thinking",
                "gpt-oss-120b-medium",
            ),
            agy_proxy_url=os.getenv("AGY_PROXY_URL") or None,
            agy_skip_permissions=_as_bool(
                os.getenv("AGY_DANGEROUS_SKIP_PERMISSIONS"), default=False
            ),
            codex_enabled=_as_bool(os.getenv("CODEX_ENABLED"), default=False),
            codex_command=os.getenv("CODEX_COMMAND", "codex").strip(),
            codex_models=_csv(os.getenv("CODEX_MODELS"))
            or (
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
            ),
            codex_sandbox=os.getenv("CODEX_SANDBOX", "workspace-write").strip(),
        )

    def resolve_allowed_path(self, raw_path: str, *, must_exist: bool = True) -> Path:
        try:
            path = Path(raw_path).expanduser().resolve(strict=must_exist)
        except (OSError, RuntimeError) as exc:
            raise ValueError("Path does not exist or cannot be resolved") from exc

        if not any(path == root or root in path.parents for root in self.allowed_roots):
            raise ValueError("Path is outside the configured workspace roots")
        return path

