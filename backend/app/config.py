from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def load_dotenv(path: Path | None = None) -> None:
    """Load `KEY=VALUE` pairs from a .env file into the process environment.

    Real environment variables always win, so a systemd unit or a PM2 ecosystem
    file keeps precedence over a developer's local .env. Implemented here rather
    than pulling in python-dotenv: the format we need is a dozen lines and the
    runtime dependency list stays at three packages.
    """
    env_path = path or PROJECT_ROOT / ".env"
    try:
        content = env_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, separator, value = line.partition("=")
        if not separator:
            continue
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


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
    antigravity_command: str
    antigravity_models: tuple[str, ...]
    antigravity_proxy_url: str | None
    codex_enabled: bool
    codex_command: str
    codex_models: tuple[str, ...]
    codex_sandbox: str

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        environment = os.getenv("ORBITPANE_ENV", "development").strip().lower()
        auth_pin = os.getenv("ORBITPANE_PIN", "")
        auth_secret = os.getenv("ORBITPANE_AUTH_SECRET", "")

        if environment == "production" and (not auth_pin or not auth_secret):
            raise RuntimeError(
                "ORBITPANE_PIN and ORBITPANE_AUTH_SECRET are required when "
                "ORBITPANE_ENV=production"
            )
        if not auth_secret:
            auth_secret = secrets.token_urlsafe(32)
            logger.warning(
                "ORBITPANE_AUTH_SECRET is not configured; login sessions will be "
                "invalidated when the backend restarts"
            )
        if not auth_pin:
            auth_pin = secrets.token_urlsafe(16)
            logger.warning(
                "ORBITPANE_PIN is not configured; a process-local development PIN "
                "was generated"
            )

        return cls(
            environment=environment,
            database_path=Path(
                os.getenv("ORBITPANE_DATABASE_PATH", str(PROJECT_ROOT / "history.db"))
            ).expanduser().resolve(),
            allowed_roots=_paths(os.getenv("ORBITPANE_ALLOWED_ROOTS")),
            cors_origins=_csv(os.getenv("ORBITPANE_CORS_ORIGINS")),
            auth_pin=auth_pin,
            auth_secret=auth_secret,
            auth_ttl_seconds=int(os.getenv("ORBITPANE_AUTH_TTL_SECONDS", "43200")),
            history_max_chars=int(os.getenv("ORBITPANE_HISTORY_MAX_CHARS", "120000")),
            default_provider=os.getenv(
                "ORBITPANE_DEFAULT_PROVIDER", "antigravity"
            ).strip(),
            antigravity_command=os.getenv(
                "ORBITPANE_ANTIGRAVITY_COMMAND", "antigravity"
            ).strip(),
            antigravity_models=_csv(os.getenv("ORBITPANE_ANTIGRAVITY_MODELS"))
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
            antigravity_proxy_url=(
                os.getenv("ORBITPANE_ANTIGRAVITY_PROXY_URL") or None
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

    @property
    def default_workspace_root(self) -> Path:
        return self.allowed_roots[0]

    def resolve_allowed_path(self, raw_path: str, *, must_exist: bool = True) -> Path:
        try:
            path = Path(raw_path).expanduser().resolve(strict=must_exist)
        except (OSError, RuntimeError) as exc:
            raise ValueError("Path does not exist or cannot be resolved") from exc

        if not any(path == root or root in path.parents for root in self.allowed_roots):
            raise ValueError("Path is outside the configured workspace roots")
        return path
