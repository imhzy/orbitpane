"""Private stdio MCP endpoint. No HTTP listener or shared project credentials."""
from __future__ import annotations

import json
import os
import sys

from pydantic import ValidationError

from backend.app.config import Settings
from backend.app.database import Database
from backend.app.plugins import PluginService


def serve() -> None:
    service = None
    project = int(os.environ.get("ORBITPANE_PLUGIN_PROJECT", "0"))
    run_id = os.environ.get("ORBITPANE_PLUGIN_RUN", "")
    if project and run_id:
        settings = Settings.from_env()
        path = settings.resolve_allowed_path(str(settings.database_path))
        service = PluginService(Database(path), settings)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Invalid request")
            if "id" not in request:
                continue
            method = request.get("method")
            params = request.get("params") or {}
            active = bool(service and service.database.plugin_run_active(project, run_id))
            if method == "initialize":
                version = params.get("protocolVersion")
                result = {"protocolVersion": version if version in ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25") else "2025-11-25",
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "orbitpane-plugins", "version": "1.0.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": service.tools(project) if active else []}
            elif method == "tools/call":
                try:
                    if not active:
                        raise ValueError("项目任务已结束，工具调用不可用")
                    value = service.call(project, params.get("name", ""), params.get("arguments", {}))
                    result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": False}
                except ValidationError:
                    result = {"content": [{"type": "text", "text": "插件配置或工具参数无效，请检查字段"}], "isError": True}
                except ValueError as exc:
                    result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
                except Exception:
                    result = {"content": [{"type": "text", "text": "插件执行失败；请检查配置，不要自动重试发送"}], "isError": True}
            else:
                print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}), flush=True)
                continue
            response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except Exception:
            response = {"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None,
                        "error": {"code": -32600, "message": "Invalid request"}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    serve()
