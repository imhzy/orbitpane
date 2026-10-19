from __future__ import annotations

import asyncio
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from backend.app.agents.codex import CodexCliProvider
from backend.app.agents.codex_usage import parse_codex_rate_limits, read_codex_rate_limits
from backend.tests.helpers import test_settings

PAYLOAD = {'rateLimits': {'primary': {'usedPercent': 80, 'windowDurationMins': 60}},
           'rateLimitsByLimitId': {'codex': {'planType': 'plus',
            'primary': {'usedPercent': 28, 'windowDurationMins': 300, 'resetsAt': 1788000000},
            'secondary': {'usedPercent': 9, 'windowDurationMins': 10080, 'resetsAt': 1788500000},
            'credits': {'balance': '42.50'}}}}


class UsageParserTests(TestCase):
    def test_codex_bucket_wins(self):
        result = parse_codex_rate_limits(PAYLOAD)
        self.assertEqual(result['plan'], 'Plus')
        self.assertEqual([(w['label'], w['remaining_percent']) for w in result['windows']],
                         [('5 小时', 72), ('7 天', 91)])
        self.assertEqual(result['credits_balance'], '42.50')
        self.assertEqual(result['windows'][0]['resets_at'], 1788000000)

    def test_plan_never_creates_windows(self):
        for plan in ('pro', 'prolite'):
            result = parse_codex_rate_limits({'rateLimits': {'planType': plan}})
            self.assertEqual(result['plan'], 'Pro')
            self.assertEqual(result['windows'], [])
            self.assertTrue(result['available'])

    def test_other_bucket_and_malformed_values(self):
        self.assertEqual(parse_codex_rate_limits({'rateLimits': {
            'limitId': 'other', 'primary': {'usedPercent': 10}}})['windows'], [])
        for used in (None, True, 'bad', float('inf')):
            self.assertEqual(parse_codex_rate_limits({'rateLimits': {
                'primary': {'usedPercent': used}}})['windows'], [])
        result = parse_codex_rate_limits({'rateLimits': {'primary': {
            'usedPercent': 120, 'windowDurationMins': True, 'resetsAt': False}}})
        self.assertEqual(result['windows'][0], dict(id='primary', label='短周期',
            used_percent=120, remaining_percent=0, window_minutes=None, resets_at=None))


class UsageAsyncTests(IsolatedAsyncioTestCase):
    async def test_cache_failure_cooldown_and_expiry(self):
        with tempfile.TemporaryDirectory() as folder:
            provider = CodexCliProvider(replace(test_settings(Path(folder)), codex_enabled=True))
            with patch('backend.app.agents.codex.shutil.which', return_value='/bin/codex'), \
                 patch('backend.app.agents.codex.read_codex_rate_limits', new_callable=AsyncMock) as read:
                read.return_value = PAYLOAD
                first, second = await asyncio.gather(provider.account_usage(), provider.account_usage())
                self.assertEqual(first, second)
                self.assertEqual(read.await_count, 1)
                provider._usage.succeeded_at = time.monotonic() - 50
                provider._usage.attempted_at -= 50
                read.side_effect = RuntimeError('network down')
                stale, again = await asyncio.gather(provider.account_usage(), provider.account_usage())
                self.assertEqual(read.await_count, 2)
                self.assertEqual(stale, again)
                self.assertEqual(stale['windows'], first['windows'])
                self.assertTrue(stale['stale'])
                self.assertEqual(stale['error'], 'network down')
                self.assertFalse(first['stale'])
                provider._usage.succeeded_at = time.monotonic() - 601
                self.assertFalse((await provider.account_usage())['available'])

    async def test_protocol_filters_noise_and_reaps_process(self):
        process = AsyncMock()
        process.pid = 123456789
        process.stdin.write = lambda _: None
        process.stdout.readline.side_effect = [b'garbage\n', b'[]\n', b'{"id":9}\n',
            b'{"id":1,"result":{}}\n', b'{"id":2,"result":{"rateLimits":{}}}\n']
        with patch('backend.app.agents.codex_usage.asyncio.create_subprocess_exec', return_value=process) as spawn, \
             patch('backend.app.agents.codex_usage.os.killpg') as kill:
            result = await read_codex_rate_limits('custom-codex')
        self.assertEqual(result, {'rateLimits': {}})
        self.assertEqual(spawn.call_args.args, ('custom-codex', 'app-server', '--stdio'))
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])
        kill.assert_called_once()
        process.wait.assert_awaited_once()

    async def test_eof_still_reaps(self):
        process = AsyncMock()
        process.pid = 123456789
        process.stdin.write = lambda _: None
        process.stdout.readline.return_value = b''
        with patch('backend.app.agents.codex_usage.asyncio.create_subprocess_exec', return_value=process), \
             patch('backend.app.agents.codex_usage.os.killpg'):
            with self.assertRaisesRegex(RuntimeError, 'closed stdout'):
                await read_codex_rate_limits('codex')
        process.wait.assert_awaited_once()
