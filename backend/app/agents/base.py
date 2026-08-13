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
    permission_mode: str = "unrestricted"


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


class ProviderError(RuntimeError):
    pass


class AgentProvider(ABC):
    id: str
    display_name: str

    @property
    @abstractmethod
    def models(self) -> tuple[str, ...]:
        raise NotImplementedError

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
            "available": self.available,
            "models": list(self.models),
        }
