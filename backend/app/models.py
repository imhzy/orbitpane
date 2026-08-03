from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field


@dataclass(frozen=True, slots=True)
class Conversation:
    id: int
    name: str
    path: str
    created_at: str
    provider: str = "antigravity"


@dataclass(frozen=True, slots=True)
class Message:
    role: str
    content: str
    thought: str
    timestamp: str
    model: str
    provider: str = "antigravity"
    duration: float = 0.0
    run_id: str = ""



class LoginRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=256)


class ConversationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    path: str = Field(default="/root", min_length=1, max_length=4096)
    provider: str = Field(default="antigravity", min_length=1, max_length=40)


class ConversationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    path: str | None = Field(default=None, min_length=1, max_length=4096)
    provider: str | None = Field(default=None, min_length=1, max_length=40)


class ChatMessage(BaseModel):
    content: str = Field(min_length=1, max_length=200_000)
    model: str | None = Field(default=None, max_length=120)
    provider: str | None = Field(default=None, max_length=40)
