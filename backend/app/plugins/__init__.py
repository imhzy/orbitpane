"""Schema-driven project plugins, independent of agent providers and transports."""
from __future__ import annotations

import base64
import secrets
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from ..config import Settings
from ..database import Database


class PluginUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    name: str | None = Field(default=None, min_length=1, max_length=100)
    config: dict[str, Any] = Field(default_factory=dict, max_length=100)


class PluginCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    plugin_id: str
    name: str = Field(min_length=1, max_length=100)


class Plugin(Protocol):
    id: str
    name: str
    description: str
    config_model: type[BaseModel]
    input_model: type[BaseModel]
    secret_fields: tuple[str, ...]
    def execute(self, config: BaseModel, arguments: BaseModel) -> dict: ...


@dataclass
class PluginService:
    database: Database
    settings: Settings

    def _cipher(self) -> AESGCM:
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                   info=b"orbitpane plugin-config v1").derive(self.settings.auth_secret.encode())
        return AESGCM(key)

    def _seal(self, value: str, project: int | str, plugin: str, field: str) -> str:
        nonce = secrets.token_bytes(12)
        return base64.urlsafe_b64encode(nonce + self._cipher().encrypt(
            nonce, value.encode(), f"{project}:{plugin}:{field}".encode())).decode()

    def _open(self, value: str, project: int | str, plugin: str, field: str) -> str:
        try:
            raw = base64.urlsafe_b64decode(value)
            return self._cipher().decrypt(raw[:12], raw[12:], f"{project}:{plugin}:{field}".encode()).decode()
        except Exception:
            raise ValueError("插件密钥无法解密，请重新填写并保存") from None

    def definitions(self) -> list[dict]:
        return [dict(id=p.id, name=p.name, description=p.description) for p in PLUGINS.values()]

    def create(self, request: PluginCreate) -> str:
        if request.plugin_id not in PLUGINS:
            raise ValueError("未知插件类型")
        instance_id = uuid.uuid4().hex
        self.database.create_plugin(instance_id, request.plugin_id, request.name)
        return instance_id

    def catalog(self) -> list[dict]:
        items = []
        for saved in self.database.list_plugins():
            plugin = PLUGINS.get(saved["plugin_id"])
            if not plugin:
                continue
            item = dict(id=saved["id"], plugin_id=plugin.id, name=saved["name"],
                        description=plugin.description, enabled=saved["enabled"])
            config = dict(saved["config"])
            configured = [key for key in plugin.secret_fields if config.pop(key, None)]
            item.update(config=config, configured_secrets=configured,
                        secret_fields=plugin.secret_fields, schema=plugin.config_model.model_json_schema())
            items.append(item)
        return items

    def save(self, instance_id: str, update: PluginUpdate) -> None:
        instance = next((row for row in self.database.list_plugins() if row["id"] == instance_id), None)
        if not instance:
            raise ValueError("插件不存在")
        plugin_id = instance["plugin_id"]
        plugin = PLUGINS.get(plugin_id)
        if not plugin:
            raise ValueError("未知插件类型")
        project = instance["secret_scope"]
        saved = instance["config"]
        config = dict(saved)
        config.update(update.config)
        preserved = {key for key in plugin.secret_fields if key in saved and key not in update.config}
        if update.enabled:
            for key in preserved:
                config[key] = self._open(saved[key], project, plugin_id, key)
        # Disabled drafts may be incomplete, but never store unknown/invalid values.
        if update.enabled:
            config = plugin.config_model.model_validate(config).model_dump()
        else:
            unknown = config.keys() - plugin.config_model.model_fields.keys()
            if unknown:
                raise ValueError("包含未知配置字段")
            for key, value in config.items():
                if key not in preserved:
                    TypeAdapter(plugin.config_model.model_fields[key].rebuild_annotation()).validate_python(value, strict=True)
        for key in plugin.secret_fields:
            if not update.enabled and key in preserved:
                continue
            if config.get(key):
                config[key] = self._seal(config[key], project, plugin_id, key)
            else:
                config.pop(key, None)
        name = (update.name if update.name is not None else instance["name"]).strip()
        if not name:
            raise ValueError("插件名称不能为空")
        if not self.database.update_plugin(instance_id, name, update.enabled, config):
            raise ValueError("插件不存在")

    @staticmethod
    def tool_name(instance: dict) -> str:
        return f"{instance['plugin_id']}_{instance['id']}"

    def tools(self, project: int) -> list[dict]:
        if not self.database.get_conversation(project):
            return []
        return [dict(name=self.tool_name(row), description=f"{row['name']}：{PLUGINS[row['plugin_id']].description}",
                     inputSchema=PLUGINS[row['plugin_id']].input_model.model_json_schema(),
                     annotations={"readOnlyHint": False, "destructiveHint": True,
                                  "idempotentHint": False, "openWorldHint": True})
                for row in self.database.list_plugins()
                if row["enabled"] and row["plugin_id"] in PLUGINS]

    def call(self, project: int, name: str, arguments: dict) -> dict:
        instance = next((row for row in self.database.list_plugins() if self.tool_name(row) == name), None)
        if not self.database.get_conversation(project) or not instance or not instance["enabled"]:
            raise ValueError("插件已关闭、已删除或项目不存在")
        plugin = PLUGINS.get(instance["plugin_id"])
        if not plugin:
            raise ValueError("未知工具")
        config = instance["config"]
        for key in plugin.secret_fields:
            if key in config:
                config[key] = self._open(config[key], instance["secret_scope"], plugin.id, key)
        return plugin.execute(plugin.config_model.model_validate(config), plugin.input_model.model_validate(arguments))


from .mail import MailPlugin

PLUGINS: dict[str, Plugin] = {"send_email": MailPlugin()}
