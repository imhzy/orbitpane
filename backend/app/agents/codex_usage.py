"""Read account limits through Codex's authenticated app-server protocol."""
from __future__ import annotations

import asyncio
import json
import os
import signal
from datetime import datetime, timezone
from typing import Any

from .usage import empty_usage

PLANS = {name: label for name, label in (
    ('free', 'Free'), ('go', 'Go'), ('plus', 'Plus'), ('pro', 'Pro'),
    ('prolite', 'Pro'), ('team', 'Team'), ('business', 'Business'),
    ('enterprise', 'Enterprise'), ('edu', 'Edu'), ('edu_plus', 'Edu Plus'),
    ('edu_pro', 'Edu Pro'),
)}


def parse_codex_rate_limits(payload: dict) -> dict[str, Any]:
    buckets = payload.get('rateLimitsByLimitId')
    snapshot = buckets.get('codex') if isinstance(buckets, dict) else None
    if not isinstance(snapshot, dict):
        snapshot = payload.get('rateLimits')
        if not isinstance(snapshot, dict) or snapshot.get('limitId') not in (None, 'codex'):
            snapshot = {}
    result = empty_usage('codex', 'ChatGPT Codex')
    plan = snapshot.get('planType')
    plan = plan.strip() if isinstance(plan, str) else ''
    result.update(available=True, plan=PLANS.get(plan, plan.replace('_', ' ').title()) or None,
                  fetched_at=datetime.now(timezone.utc).isoformat())
    for key, fallback in (('primary', '短周期'), ('secondary', '长周期')):
        window = snapshot.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get('usedPercent')
        if isinstance(used, bool) or used is None:
            continue
        try:
            used = int(used)
        except (TypeError, ValueError, OverflowError):
            continue
        minutes = window.get('windowDurationMins')
        minutes = minutes if type(minutes) is int else None
        reset = window.get('resetsAt')
        reset = reset if type(reset) is int else None
        label = fallback
        if minutes is not None and minutes > 0:
            label = (f'{minutes // 1440} 天' if minutes % 1440 == 0 else
                     f'{minutes // 60} 小时' if minutes % 60 == 0 else f'{minutes} 分钟')
        result['windows'].append(dict(id=key, label=label, used_percent=used,
            remaining_percent=min(100, max(0, 100 - used)), window_minutes=minutes,
            resets_at=reset))
    credits = snapshot.get('credits')
    result['credits_balance'] = credits.get('balance') if isinstance(credits, dict) else None
    result['limit_reached'] = snapshot.get('rateLimitReachedType')
    return result


async def read_codex_rate_limits(command: str) -> dict:
    # Inherit the same credentials, CODEX_HOME and networking as conversation runs.
    env = os.environ.copy()
    process = None
    try:
        async with asyncio.timeout(12):
            process = await asyncio.create_subprocess_exec(
                command, 'app-server', '--stdio', stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True, env=env, limit=1024 * 1024,
            )

            async def send(message: dict) -> None:
                process.stdin.write((json.dumps(message) + '\n').encode())
                await process.stdin.drain()

            async def receive(request_id: int) -> dict:
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        raise RuntimeError('Codex app-server closed stdout')
                    try:
                        message = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(message, dict) or type(message.get('id')) is not int or message['id'] != request_id:
                        continue
                    if 'error' in message:
                        error = message['error']
                        error = error.get('message') if isinstance(error, dict) else error
                        raise RuntimeError(str(error) if error else 'Codex usage request failed')
                    result = message.get('result')
                    if not isinstance(result, dict):
                        raise RuntimeError('Invalid Codex usage response')
                    return result

            await send(dict(id=1, method='initialize', params=dict(clientInfo=dict(
                name='orbitpane', title='OrbitPane', version='2.1.0'))))
            await receive(1)
            await send(dict(method='initialized', params={}))
            await send(dict(id=2, method='account/rateLimits/read'))
            return await receive(2)
    except TimeoutError as exc:
        raise RuntimeError('Timed out waiting for Codex app-server') from exc
    finally:
        if process is not None:
            # Reap the session even on timeout/cancellation; never leave a CLI behind.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), 0.5)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(process.wait(), 0.5)
