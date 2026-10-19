from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from backend.app.agents.antigravity import AntigravityProvider
from backend.app.agents.antigravity_usage import parse_antigravity_usage, read_antigravity_usage
from backend.tests.helpers import test_settings

REPORT = '''Gemini Models\tWeekly Limit Remaining\t76%\t2026-10-24T03:23:45Z
Gemini Models\tFive Hour Limit Remaining\t90%\t2026-10-19T08:17:22Z
Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-26T05:20:43Z
Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-19T10:20:43Z
Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-10-26T05:20:43Z
'''


class ParserTests(TestCase):
    def test_groups_and_windows_are_preserved_without_inventing_plan(self):
        result = parse_antigravity_usage(REPORT)
        windows = result['windows']
        self.assertEqual(result['provider'], 'antigravity')
        self.assertIsNone(result['plan'])
        self.assertIsNone(result['credits_balance'])
        self.assertEqual(len(windows), 5)
        self.assertEqual(len({w['id'] for w in windows}), 5)
        self.assertEqual(windows[0]['group'], 'Gemini Models')
        self.assertEqual(windows[0]['remaining_percent'], 76)
        self.assertEqual(windows[0]['used_percent'], 24)
        self.assertEqual(windows[0]['window_minutes'], 10080)
        self.assertEqual(windows[1]['window_minutes'], 300)
        self.assertEqual(windows[1]['label'], '5 小时')
        self.assertEqual(windows[4]['group'], 'Gemini 4 Argon')
        self.assertIsInstance(windows[0]['resets_at'], int)
        self.assertEqual(parse_antigravity_usage(REPORT + REPORT)['windows'], windows)

    def test_noise_unknown_windows_and_missing_reset(self):
        output = 'noise\nX\tSpecial limit\t12.5%\tunknown\nX\tBad limit\tNaN%\tunknown\n'
        window, = parse_antigravity_usage(output)['windows']
        self.assertEqual(window['label'], 'Special limit')
        self.assertIsNone(window['window_minutes'])
        self.assertIsNone(window['resets_at'])
        self.assertEqual(window['remaining_percent'], 12)
        for bad in ('', 'agent prose', 'X\tWeekly\t101%\tunknown', 'X\tWeekly\t-1%\tunknown'):
            with self.assertRaisesRegex(RuntimeError, '未返回可识别'):
                parse_antigravity_usage(bad)


class ProviderTests(IsolatedAsyncioTestCase):
    async def test_cache_single_flight_stale_and_expired(self):
        with tempfile.TemporaryDirectory() as folder:
            provider = AntigravityProvider(test_settings(Path(folder)))
            with patch('backend.app.agents.antigravity.read_antigravity_usage', new_callable=AsyncMock) as read:
                read.return_value = REPORT
                first, second = await asyncio.gather(provider.account_usage(), provider.account_usage())
                self.assertEqual(first, second)
                self.assertEqual(read.await_count, 1)
                provider._usage.succeeded_at = time.monotonic() - 50
                provider._usage.attempted_at -= 50
                read.side_effect = RuntimeError('network down')
                stale, same = await asyncio.gather(provider.account_usage(), provider.account_usage())
                self.assertEqual(stale, same)
                self.assertEqual(read.await_count, 2)
                self.assertTrue(stale['stale'])
                self.assertEqual(stale['windows'], first['windows'])
                self.assertFalse(first['stale'])
                provider._usage.succeeded_at = time.monotonic() - 601
                self.assertFalse((await provider.account_usage())['available'])

    async def test_standalone_query_uses_expected_env_and_reaps(self):
        process = AsyncMock()
        process.returncode = 0
        process.stdout.read.side_effect = [REPORT.encode(), b'']
        with patch('backend.app.agents.antigravity_usage.asyncio.create_subprocess_exec', return_value=process) as spawn, \
             patch('backend.app.agents.antigravity_usage.terminate_process', new_callable=AsyncMock) as cleanup, \
             patch.dict('os.environ', {'ANTIGRAVITY_FAKE': 'remove', 'HTTPS_PROXY': 'inherited'}):
            self.assertEqual(await read_antigravity_usage('custom-agy', 'http://localhost:1234'), REPORT)
        args = spawn.call_args
        self.assertEqual(args.args, ('custom-agy', '--sandbox', '--print', '/usage', '--print-timeout', '8s'))
        self.assertNotIn('ANTIGRAVITY_FAKE', args.kwargs['env'])
        self.assertEqual(args.kwargs['env']['https_proxy'], 'http://localhost:1234')
        self.assertTrue(args.kwargs['start_new_session'])
        cleanup.assert_awaited_once_with(process)

    async def test_failed_or_cancelled_queries_still_clean_up(self):
        for failure in (TimeoutError(), asyncio.CancelledError()):
            process = AsyncMock()
            process.stdout.read.side_effect = failure
            with patch('backend.app.agents.antigravity_usage.asyncio.create_subprocess_exec', return_value=process), \
                 patch('backend.app.agents.antigravity_usage.terminate_process', new_callable=AsyncMock) as cleanup:
                with self.assertRaises(asyncio.CancelledError if isinstance(failure, asyncio.CancelledError) else RuntimeError):
                    await read_antigravity_usage('agy')
                cleanup.assert_awaited_once_with(process)
