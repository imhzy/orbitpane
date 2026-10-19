"""Provider-neutral account usage response."""
import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any


def empty_usage(provider: str, name: str, error: str | None = None) -> dict[str, Any]:
    return dict(provider=provider, provider_name=name, available=False, plan=None,
                windows=[], credits_balance=None, limit_reached=None,
                fetched_at=None, stale=False, error=error)


class UsageCache:
    """Serialize refreshes, cool down failures, and retain bounded stale data."""

    def __init__(self, provider: str, name: str):
        self.provider = provider
        self.name = name
        self.lock = asyncio.Lock()
        self.snapshot = None
        self.succeeded_at = float('-inf')
        self.attempted_at = float('-inf')
        self.error = None

    async def read(self, fetch: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
        async with self.lock:
            now = time.monotonic()
            if self.snapshot is not None and now - self.succeeded_at < 45:
                return self.snapshot
            if now - self.attempted_at >= 15:
                try:
                    self.snapshot = await fetch()
                    self.succeeded_at = time.monotonic()
                    self.error = None
                    return self.snapshot
                except Exception as exc:
                    self.error = str(exc) or f'无法读取 {self.name} 用量'
                finally:
                    self.attempted_at = time.monotonic()
            if self.snapshot is not None and time.monotonic() - self.succeeded_at < 600:
                return {**self.snapshot, 'stale': True, 'error': self.error}
            return empty_usage(self.provider, self.name, self.error)
