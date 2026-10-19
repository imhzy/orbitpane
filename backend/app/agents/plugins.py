"""Agent-side MCP launch configuration; project scope comes from the running task."""
import asyncio
import json
import sys

from ..config import PROJECT_ROOT, Settings
from ..database import Database
from ..plugins import PluginService
from .base import AgentRequest, ProviderError

_registration_lock = asyncio.Lock()
_registered: set[str] = set()


def enabled(settings: Settings, request: AgentRequest) -> bool:
    path = settings.resolve_allowed_path(str(settings.database_path), must_exist=False)
    if not path.exists():
        return False
    return bool(PluginService(Database(path), settings).tools(request.conversation_id))


def launch(settings: Settings) -> tuple[str, list[str]]:
    root = settings.resolve_allowed_path(str(PROJECT_ROOT))
    executable = sys.executable
    return executable, ["-c", f"import sys; sys.path.insert(0, {str(root)!r}); from backend.app.plugins.stdio import serve; serve()"]


def environment(settings: Settings, request: AgentRequest) -> dict[str, str]:
    return {"ORBITPANE_PLUGIN_PROJECT": str(request.conversation_id),
            "ORBITPANE_PLUGIN_RUN": request.run_id,
            "ORBITPANE_DATABASE_PATH": str(settings.database_path),
            "ORBITPANE_AUTH_SECRET": settings.auth_secret,
            "ORBITPANE_ALLOWED_ROOTS": ",".join(map(str, settings.allowed_roots))}


def codex_args(settings: Settings, request: AgentRequest) -> list[str]:
    if not enabled(settings, request):
        return []
    command, args = launch(settings)
    # Only names of inherited variables appear in argv; never secret values.
    return ["-c", "mcp_servers.orbitpane.command=" + json.dumps(command),
            "-c", "mcp_servers.orbitpane.args=" + json.dumps(args),
            "-c", "mcp_servers.orbitpane.env_vars=" + json.dumps(list(environment(settings, request)))]


async def prepare_antigravity(settings: Settings, request: AgentRequest) -> dict[str, str]:
    if not await asyncio.to_thread(enabled, settings, request):
        return {}
    # This CLI only supports persistent MCP registration. The bridge advertises
    # no tools outside an OrbitPane task, and checks task/project scope each call.
    async with _registration_lock:
        if settings.antigravity_command not in _registered:
            command, args = launch(settings)
            process = await asyncio.create_subprocess_exec(
                settings.antigravity_command, "mcp", "add", "orbitpane-project-plugins", command, *args,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            await process.communicate()
            if process.returncode:
                raise ProviderError("无法注册项目插件 MCP 服务")
            _registered.add(settings.antigravity_command)
    return environment(settings, request)
