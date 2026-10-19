from __future__ import annotations

import asyncio
import logging

from .antigravity import AntigravityProvider
from .base import AgentProvider, ModelCatalogStore, ProviderError
from .codex import CodexCliProvider
from ..config import Settings

logger = logging.getLogger(__name__)


class ProviderRegistry:
    def __init__(self, settings: Settings, store: ModelCatalogStore | None = None):
        providers: tuple[AgentProvider, ...] = (
            AntigravityProvider(settings, store),
            CodexCliProvider(settings, store),
        )
        self._providers = {provider.id: provider for provider in providers}

    def get(self, provider_id: str) -> AgentProvider:
        provider = self._providers.get(provider_id)
        if provider is None:
            raise ProviderError(f"Unknown provider: {provider_id}")
        if not provider.available:
            raise ProviderError(f"Provider is not available: {provider_id}")
        return provider

    def lookup(self, provider_id: str) -> AgentProvider | None:
        """Inspect capabilities even when execution is disabled."""
        return self._providers.get(provider_id)

    def exists(self, provider_id: str) -> bool:
        return provider_id in self._providers

    async def catalog(self, *, refresh: str | None = None) -> list[dict[str, object]]:
        """Every provider's description, with model lists brought up to date.

        Refreshing is what makes this awaitable: a provider discovers its
        models by shelling out to its CLI, and that probe belongs in a worker
        thread rather than on the event loop, where it would stall every other
        request in flight. `describe` itself only reads the cache.

        `refresh` limits the refresh to one provider, so a caller that only
        needs one list never waits on another provider's probe — a Codex
        project's model picker used to sit behind Antigravity's network round
        trip. The others are still described, from whatever they have cached.
        """
        await self.refresh(only=refresh)
        return [provider.describe() for provider in self._providers.values()]

    async def refresh(self, *, only: str | None = None) -> None:
        """Bring every provider's model list (or just `only`'s) up to date."""
        await asyncio.gather(
            *(
                provider.ensure_model_catalog()
                for provider in self._providers.values()
                if only is None or provider.id == only
            )
        )

    async def prewarm(self) -> None:
        """Fill the model caches at startup so no request pays for the probe.

        Failures are logged and dropped: a CLI that is missing or logged out
        must not keep the server from starting, and every provider falls back
        to its configured model list until the probe succeeds.
        """
        try:
            await self.refresh()
        except Exception:
            logger.exception("Provider model prewarm failed")
