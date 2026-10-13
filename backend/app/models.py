from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import urlsplit
import base64
import binascii

from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class PushEndpoint(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        # A subscription is an outbound request destination. Only browser push
        # services are allowed, never arbitrary URLs supplied by a client.
        try:
            url = urlsplit(value)
            host = url.hostname or ""
            trusted = (
                host == "web.push.apple.com" or host.endswith(".push.apple.com")
                or host == "fcm.googleapis.com"
                or host == "updates.push.services.mozilla.com"
                or host.endswith(".notify.windows.com")
            )
            valid = (url.scheme == "https" and trusted and url.port in (None, 443)
                     and not url.username and not url.password and not url.fragment
                     and bool(url.path) and not any(c.isspace() for c in value))
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("Unsupported push service endpoint")
        return value


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+=*$")
    auth: str = Field(min_length=1, max_length=30, pattern=r"^[A-Za-z0-9_-]+=*$")

    @field_validator("p256dh", "auth")
    @classmethod
    def validate_key(cls, value: str, info) -> str:
        try:
            raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
            if info.field_name == "p256dh":
                if len(raw) != 65:
                    raise ValueError()
                ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
            elif len(raw) != 16:
                raise ValueError()
        except (ValueError, binascii.Error):
            raise ValueError("Invalid push encryption key") from None
        return value


class PushSubscription(PushEndpoint):
    keys: PushKeys
    application_server_key: str = Field(min_length=1, max_length=100)


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
    sort_order: int = 0


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
    schedule_id: int | None = None
    schedule_name: str = ""
    scheduled_for: str = ""
    is_error: bool = False
    error_code: str = ""


class LoginRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=256)


class PasskeyResponse(BaseModel):
    credential: dict


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


class ConversationReorder(BaseModel):
    conversation_ids: list[Annotated[int, Field(ge=1, strict=True)]] = Field(
        min_length=2, max_length=10_000
    )


class ChatMessage(BaseModel):
    request_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
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


class ShareCreate(BaseModel):
    """Options chosen when a conversation snapshot is published."""

    # The agent's internal reasoning quotes file paths, command output and tool
    # arguments the sender never typed and is unlikely to have re-read, so a
    # public copy only carries it when it was asked for explicitly.
    include_thoughts: bool = False
    #: None keeps the link working until it is revoked.
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


class MessageFeedbackUpdate(BaseModel):
    #: Empty string clears an existing rating.
    feedback: Literal["up", "down", ""]


class ScheduleSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["interval", "daily", "weekly"]
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=100)
    interval: int | None = Field(default=None, ge=1, le=525600, strict=True)
    unit: Literal["minutes", "hours"] | None = None
    times: list[str] = Field(default_factory=list, max_length=24)
    weekdays: list[Annotated[int, Field(ge=0, le=6, strict=True)]] = Field(
        default_factory=list, max_length=7
    )

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError("请选择有效的 IANA 时区，例如 Asia/Shanghai") from None
        return value

    @field_validator("times")
    @classmethod
    def valid_times(cls, values: list[str]) -> list[str]:
        import re

        if any(not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value) for value in values):
            raise ValueError("执行时间须为 HH:mm 格式")
        if len(set(values)) != len(values):
            raise ValueError("执行时间不能重复")
        return sorted(values)

    @model_validator(mode="after")
    def valid_rule(self):
        if self.kind == "interval":
            if self.interval is None or self.unit is None or self.times or self.weekdays:
                raise ValueError("间隔任务须指定间隔与单位")
            if self.unit == "hours" and self.interval > 8760:
                raise ValueError("间隔不能超过一年")
        else:
            if not self.times or self.interval is not None or self.unit is not None:
                raise ValueError("每日和每周任务须指定执行时间")
            if self.kind == "weekly" and not self.weekdays:
                raise ValueError("每周任务须选择至少一天")
            if self.kind == "daily" and self.weekdays:
                raise ValueError("每日任务无需指定星期")
        if len(set(self.weekdays)) != len(self.weekdays):
            raise ValueError("星期不能重复")
        self.weekdays = sorted(self.weekdays)
        return self


class ScheduleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=200_000)
    spec: ScheduleSpec
    compact_before: bool = False
    enabled: bool = True

    @field_validator("name", "prompt")
    @classmethod
    def nonempty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("任务名称和命令不能为空")
        return value


class ScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    prompt: str | None = Field(default=None, min_length=1, max_length=200_000)
    spec: ScheduleSpec | None = None
    compact_before: bool | None = None
    enabled: bool | None = None
    version: int | None = Field(default=None, ge=1)

    @field_validator("name", "prompt")
    @classmethod
    def nonempty_text(cls, value: str | None) -> str | None:
        return ScheduleCreate.nonempty_text(value) if value is not None else None

    @model_validator(mode="after")
    def no_null_updates(self):
        if any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("任务字段不能设为 null")
        return self


class ScheduleRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
