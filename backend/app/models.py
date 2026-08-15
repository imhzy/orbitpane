from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field


@dataclass(frozen=True, slots=True)
class Conversation:
    id: int
    name: str
    path: str
    created_at: str
    provider: str = "antigravity"
    is_pinned: bool = False
    is_archived: bool = False
    preferred_model: str = ""
    permission_mode: str = "workspace"
    draft: str = ""
    active_summary_id: int | None = None


@dataclass(frozen=True, slots=True)
class Message:
    id: int
    role: str
    content: str
    thought: str
    timestamp: str
    model: str
    provider: str = "antigravity"
    duration: float = 0.0
    run_id: str = ""
    input_chars: int = 0
    output_chars: int = 0
    context_chars: int = 0
    feedback: str = ""


class LoginRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=256)


class ConversationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=4096)
    provider: str = Field(default="antigravity", min_length=1, max_length=40)
    preferred_model: str = Field(default="", max_length=120)
    # Sandboxed by default: unrestricted skips approvals entirely, so it has to
    # be an explicit choice rather than something a client can omit into.
    permission_mode: Literal["workspace", "unrestricted"] = "workspace"


class ConversationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    path: str | None = Field(default=None, min_length=1, max_length=4096)
    provider: str | None = Field(default=None, min_length=1, max_length=40)
    is_pinned: bool | None = None
    is_archived: bool | None = None
    preferred_model: str | None = Field(default=None, max_length=120)
    permission_mode: Literal["workspace", "unrestricted"] | None = None
    draft: str | None = Field(default=None, max_length=200_000)


class ChatMessage(BaseModel):
    content: str = Field(min_length=1, max_length=200_000)
    model: str | None = Field(default=None, max_length=120)
    provider: str | None = Field(default=None, max_length=40)


class QueueUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=200_000)
    model: str | None = Field(default=None, max_length=120)


class QueueReorder(BaseModel):
    run_ids: list[str] = Field(max_length=100)


class SummaryUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    content: str | None = Field(default=None, min_length=1, max_length=200_000)
    active: bool | None = None


class MessageFeedbackUpdate(BaseModel):
    #: Empty string clears an existing rating.
    feedback: Literal["up", "down", ""]
