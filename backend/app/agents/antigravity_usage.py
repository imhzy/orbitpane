"""Antigravity's standalone /usage command reports tab-separated quota rows."""
from __future__ import annotations

import asyncio
import hashlib
import math
import os
import re
from datetime import datetime, timezone

from .process import terminate_process
from .usage import empty_usage


def parse_antigravity_usage(output: str) -> dict[str, object]:
    windows = []
    seen = set()
    for line in output.splitlines():
        fields = [field.strip() for field in line.split('\t')]
        if len(fields) != 4:
            continue
        group, name, percent, reset_text = fields
        if not group or not name or not re.fullmatch(r'\d+(?:\.\d+)?%', percent):
            continue
        remaining = float(percent[:-1])
        if not math.isfinite(remaining) or not 0 <= remaining <= 100:
            continue
        remaining = int(remaining)
        # Infer durations only from explicit CLI window names, never from a plan
        # or the time left until reset (which is not a window duration).
        lower = name.lower()
        if 'weekly' in lower:
            minutes, label = 10080, '7 天'
        elif 'five hour' in lower or 'five-hour' in lower:
            minutes, label = 300, '5 小时'
        else:
            minutes, label = None, name
        reset = None
        try:
            parsed = datetime.fromisoformat(reset_text.replace('Z', '+00:00'))
            if parsed.tzinfo is not None:
                reset = int(parsed.timestamp())
        except (ValueError, OverflowError, OSError):
            pass
        # Same durations in different groups must remain distinct.
        identity = hashlib.sha256(f'{group}\0{name}'.encode()).hexdigest()[:20]
        if identity in seen:
            continue
        seen.add(identity)
        windows.append(dict(id=identity, group=group, label=label,
            used_percent=100 - remaining, remaining_percent=remaining,
            window_minutes=minutes, resets_at=reset))
    if not windows:
        # Incompatible CLI output is a failed read, not an empty successful quota.
        raise RuntimeError('Antigravity CLI 未返回可识别的用量，请确认 CLI 已登录且支持 /usage')
    result = empty_usage('antigravity', 'Google Gemini')
    result.update(available=True, windows=windows,
                  fetched_at=datetime.now(timezone.utc).isoformat())
    return result


async def read_antigravity_usage(command: str, proxy_url: str | None = None) -> str:
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith('ANTIGRAVITY_')}
    if proxy_url:
        for key in ('http_proxy', 'https_proxy', 'all_proxy'):
            environment[key] = proxy_url
    process = None
    try:
        # Leave room for process-group cleanup within the frontend's 15s budget.
        async with asyncio.timeout(10):
            process = await asyncio.create_subprocess_exec(
                command, '--sandbox', '--print', '/usage', '--print-timeout', '8s',
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env=environment, start_new_session=True)
            # Cap a malformed report; never parse agent prose or log credentials.
            chunks = bytearray()
            while chunk := await process.stdout.read(65536):
                chunks.extend(chunk)
                if len(chunks) > 1024 * 1024:
                    raise RuntimeError('Antigravity 用量响应过大')
            await process.wait()
            if process.returncode != 0:
                raise RuntimeError('无法读取 Antigravity 用量，请检查 CLI 登录状态和网络')
            return chunks.decode('utf-8', errors='replace')
    except TimeoutError as exc:
        raise RuntimeError('读取 Antigravity 用量超时') from exc
    finally:
        await terminate_process(process)
