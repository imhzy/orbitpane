from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from ..models import Message


@dataclass(frozen=True, slots=True)
class AgentRequest:
    run_id: str
    conversation_id: int
    working_directory: str
    prompt: str
    history: tuple[Message, ...]
    model: str
    permission_mode: str = "workspace"


@dataclass(frozen=True, slots=True)
class AgentEvent:
    type: str
    content: str = ""


@dataclass(frozen=True, slots=True)
class AgentResult:
    content: str
    thought: str = ""
    interrupted: bool = False


EmitEvent = Callable[[AgentEvent], Awaitable[None]]

_EFFORT_SUFFIXES = {
    "high": "High",
    "medium": "Medium",
    "low": "Low",
    "minimal": "Minimal",
    "thinking": "Thinking",
    "default": "Default",
}
_WORD_OVERRIDES = {
    "gpt": "GPT",
    "oss": "OSS",
    "gemini": "Gemini",
    "claude": "Claude",
    "codex": "Codex",
}


def humanize_model_id(model: str) -> str:
    """Best-effort label for a model id a provider gave us no name for.

    Providers that publish their own display names should use those; this is the
    fallback so a newly released model still reads sensibly in the UI instead of
    requiring a client release.
    """
    parts = [part for part in model.split("-") if part]
    if not parts:
        return model
    suffix = _EFFORT_SUFFIXES.get(parts[-1]) if len(parts) > 1 else None
    if suffix:
        parts.pop()

    words: list[str] = []
    version_run: list[str] = []
    for part in parts:
        if part.isdigit():
            # Consecutive numeric segments are a version: 4-6 -> "4.6".
            version_run.append(part)
            continue
        if version_run:
            words.append(".".join(version_run))
            version_run = []
        if part in _WORD_OVERRIDES:
            words.append(_WORD_OVERRIDES[part])
        elif any(character.isdigit() for character in part):
            # Parameter counts and sizes read better upper-cased: 120b -> 120B.
            words.append(part.upper())
        else:
            words.append(part.capitalize())
    if version_run:
        words.append(".".join(version_run))

    name = " ".join(words)
    # "GPT OSS" is a single product name, not two words.
    name = name.replace("GPT OSS", "GPT-OSS")
    return f"{name} ({suffix})" if suffix else name


class ProviderError(RuntimeError):
    pass


class AgentProvider(ABC):
    id: str
    display_name: str
    #: Badge colour family the client uses for this provider.
    tone: str = "default"

    @property
    @abstractmethod
    def models(self) -> tuple[str, ...]:
        raise NotImplementedError

    def model_display_name(self, model: str) -> str:
        """Label shown for a model id.

        Providers whose CLI publishes names should override this; otherwise the
        generic humanizer keeps new models readable without a client change.
        """
        return humanize_model_id(model)

    def model_catalog(self) -> list[dict[str, str]]:
        return [
            {"id": model, "display_name": self.model_display_name(model)}
            for model in self.models
        ]

    @property
    def available(self) -> bool:
        return True

    @abstractmethod
    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        raise NotImplementedError

    @abstractmethod
    async def interrupt(self, conversation_id: int) -> None:
        raise NotImplementedError

    def validate_model(self, model: str) -> str:
        if not self.models:
            raise ProviderError(f"Provider {self.id} has no configured models")
        if model not in self.models:
            return self.models[0]
        return model

    def describe(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.display_name,
            "tone": self.tone,
            "available": self.available,
            "models": self.model_catalog(),
        }
