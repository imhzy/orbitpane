from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def mailbox(value: str) -> str:
    import re
    if not re.fullmatch(r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+", value):
        raise ValueError("请输入有效的邮箱地址")
    return value


class MailConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    host: str = Field(title="SMTP 主机", min_length=1, max_length=253)
    port: int = Field(default=465, title="SMTP 端口", ge=1, le=65535)
    security: Literal["tls", "starttls"] = Field(default="tls", title="连接加密", description="465 通常使用 TLS，587 通常使用 STARTTLS")
    username: str = Field(title="SMTP 用户名", min_length=1, max_length=320)
    password: str = Field(title="SMTP 密码 / 授权码", min_length=1, max_length=4096, json_schema_extra={"writeOnly": True})
    from_address: str = Field(title="发件人邮箱", max_length=320)
    from_name: str = Field(default="OrbitPane", title="发件人名称", max_length=100)

    @field_validator("from_address")
    @classmethod
    def address(cls, value: str) -> str:
        return mailbox(value)

    @field_validator("host", "username", "from_name")
    @classmethod
    def single_line(cls, value: str) -> str:
        if any(c in value for c in "\r\n\x00"):
            raise ValueError("字段不能包含换行")
        return value


class MailArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    to: list[str] = Field(min_length=1, max_length=20, description="收件人邮箱列表")
    subject: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=100000, description="纯文本邮件正文")

    @field_validator("to")
    @classmethod
    def addresses(cls, values: list[str]) -> list[str]:
        return [mailbox(value) for value in values]

    @field_validator("subject")
    @classmethod
    def subject_line(cls, value: str) -> str:
        if any(c in value for c in "\r\n\x00"):
            raise ValueError("主题不能包含换行")
        return value


class MailPlugin:
    id = "send_email"
    name = "发送邮件"
    description = "通过项目配置的 SMTP 发送纯文本邮件。仅在用户要求发邮件时调用；发送有外部副作用，结果不确定时不要自动重试。"
    config_model = MailConfig
    input_model = MailArguments
    secret_fields = ("password",)

    def execute(self, config: MailConfig, arguments: MailArguments) -> dict:
        message = EmailMessage()
        message["From"] = formataddr((config.from_name, config.from_address))
        message["To"] = ", ".join(arguments.to)
        message["Subject"] = arguments.subject
        message["Message-ID"] = make_msgid()
        message.set_content(arguments.text)
        context = ssl.create_default_context()
        try:
            if config.security == "tls":
                client = smtplib.SMTP_SSL(config.host, config.port, timeout=30, context=context)
            else:
                client = smtplib.SMTP(config.host, config.port, timeout=30)
            with client:
                if config.security == "starttls":
                    client.starttls(context=context)
                client.login(config.username, config.password)
                refused = client.send_message(message)
            return {"status": "partially_accepted" if refused else "accepted", "message_id": message["Message-ID"],
                    "accepted": [address for address in arguments.to if address not in refused],
                    "rejected": list(refused)}
        except smtplib.SMTPAuthenticationError:
            raise ValueError("SMTP 认证失败，请检查用户名和授权码") from None
        except (OSError, smtplib.SMTPException):
            raise ValueError("SMTP 发送失败或结果未知，请检查邮件服务；不要自动重试以免重复发送") from None
