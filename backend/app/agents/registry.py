from __future__ import annotations

from .antigravity import AntigravityProvider
from .base import AgentProvider, ProviderError
from .codex import CodexCliProvider
from ..config import Settings


class ProviderRegistry:
    def __init__(self, settings: Settings):
        providers: tuple[AgentProvider, ...] = (
            AntigravityProvider(settings),
            CodexCliProvider(settings),
        )
        self._providers = {provider.id: provider for provider in providers}

    def get(self, provider_id: str) -> AgentProvider:
        provider = self._providers.get(provider_id)
        if provider is None:
            raise ProviderError(f"Unknown provider: {provider_id}")
        if not provider.available:
            raise ProviderError(f"Provider is not available: {provider_id}")
        return provider

    def exists(self, provider_id: str) -> bool:
        return provider_id in self._providers

    def catalog(self) -> list[dict[str, object]]:
        return [provider.describe() for provider in self._providers.values()]
