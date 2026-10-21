"""Usage settings integration against Vite on port 5179 (mocked APIs)."""
import asyncio
from itertools import product
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--no-sandbox'])
        for width, provider_id in product((1440, 390), ("codex", "antigravity")):
            provider_name = "ChatGPT Codex" if provider_id == "codex" else "Google Gemini"
            heading = "ChatGPT Codex · Plus" if provider_id == "codex" else "Google Gemini"
            window_count = 2 if provider_id == "codex" else 5
            page = await browser.new_page(viewport={'width': width, 'height': 900}, service_workers='block')
            errors = []
            calls = []
            remaining = 72
            page.on('pageerror', lambda error: errors.append(str(error)))
            async def route_api(route):
                path = urlparse(route.request.url).path
                if path == '/api/session':
                    data = {'authenticated': True}
                elif path == '/api/agents':
                    data = {'default_provider': provider_id, 'providers': [{'id': provider_id, 'name': provider_name,
                        'tone': 'codex', 'available': True, 'models': [{'id': 'test', 'display_name': 'Test'}]}]}
                elif path == '/api/models':
                    data = {'provider': provider_id, 'models': [{'id': 'test', 'display_name': 'Test'}]}
                elif path == '/api/conversations':
                    data = [{'id': 1, 'name': 'Usage project', 'path': '/tmp/project', 'provider': provider_id,
                        'preferred_model': 'test', 'permission_mode': 'workspace', 'draft': '', 'is_archived': False}]
                elif path == '/api/conversations/1':
                    data = {'id': 1, 'name': 'Usage project', 'path': '/tmp/project', 'provider': provider_id,
                        'preferred_model': 'test', 'permission_mode': 'workspace', 'draft': '', 'is_archived': False,
                        **(route.request.post_data_json or {})}
                elif path == '/api/usage':
                    calls.append(route.request.url)
                    data = {'provider': provider_id, 'provider_name': provider_name, 'available': True, 'plan': 'Plus' if provider_id == 'codex' else None,
                        'windows': [dict(id='primary', label='5 小时', used_percent=100-remaining,
                            remaining_percent=remaining, window_minutes=300, resets_at=1999999999),
                            dict(id='secondary', label='7 天', used_percent=9, remaining_percent=91,
                            window_minutes=10080, resets_at=1999999999)], 'credits_balance': None,
                        'limit_reached': None, 'fetched_at': '2026-10-19T00:00:00Z', 'stale': False, 'error': None}
                    if provider_id == 'antigravity':
                        for window in data['windows']:
                            window['group'] = 'Gemini Models'
                        data['windows'] += [dict(id=key, group=group, label=label,
                            used_percent=0, remaining_percent=100, window_minutes=minutes,
                            resets_at=1999999999) for key, group, label, minutes in (
                            ('claude-weekly', 'Claude and GPT models', '7 天', 10080),
                            ('claude-short', 'Claude and GPT models', '5 小时', 300),
                            ('argon-weekly', 'Gemini 4 Argon', '7 天', 10080))]
                elif path.endswith('/stats'):
                    data = dict(message_count=0, duration=0, input_chars=0, output_chars=0, context_chars=0, summary_count=0)
                elif path.endswith('/workspace-status'):
                    data = dict(is_git=False, branch='', files=[], counts={})
                elif path == '/api/workspace-roots':
                    data = dict(roots=['/tmp'], default_root='/tmp')
                else:
                    data = {'items': [], 'has_more': False}
                await route.fulfill(json=data)
            await page.route('**/api/**', route_api)
            await page.add_init_script('''class FakeSocket {
                static OPEN=1; static CONNECTING=0; readyState=0;
                constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.()},30)}
                send(){} close(){this.readyState=3}
            }; window.WebSocket=FakeSocket;''')
            await page.goto('http://127.0.0.1:5179/?id=1&settings=usage')
            card = page.get_by_role('region', name='账号用量')
            await expect(card).to_be_visible()
            await expect(card).to_contain_text(heading)
            assert await card.evaluate('(el) => parseFloat(getComputedStyle(el).paddingLeft) >= 16 && parseFloat(getComputedStyle(el).paddingTop) >= 16')
            assert await page.locator('.settings-group-content').first.evaluate('(el) => parseFloat(getComputedStyle(el).paddingLeft) >= 16')
            await expect(card.get_by_role('progressbar')).to_have_count(window_count)
            await expect(card.get_by_role('progressbar').first).to_have_attribute('aria-valuenow', '72')
            assert len([url for url in calls if f'provider={provider_id}' in url]) == 1, calls
            remaining = 12
            await card.get_by_role('button', name='刷新用量').click()
            await expect(card.get_by_role('progressbar').first).to_have_attribute('aria-valuenow', '12')
            await expect(card.locator('.usage-window').first).to_have_class('usage-window low')
            assert len([url for url in calls if f'provider={provider_id}' in url]) == 2
            assert await card.evaluate('(el) => {const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth}')
            await page.screenshot(path=f'/tmp/orbitpane-usage-{provider_id}-{width}.png')
            await page.goto('http://127.0.0.1:5179/?id=1&settings=ai')
            group = page.locator('.settings-group').filter(has=page.get_by_role('heading', name='Agent 状态', exact=True))
            settings_card = group.get_by_role('region', name='账号用量')
            await expect(settings_card).to_contain_text(heading)
            await expect(settings_card.get_by_role('progressbar')).to_have_count(window_count)
            if provider_id == 'antigravity':
                await expect(settings_card.locator('.usage-group-title')).to_have_text(['Gemini Models', 'Claude and GPT models', 'Gemini 4 Argon'])
            assert await settings_card.evaluate('(el) => parseFloat(getComputedStyle(el).paddingLeft) >= 16')
            await settings_card.scroll_into_view_if_needed()
            await expect(settings_card).to_be_visible()
            assert await settings_card.evaluate('(el) => {const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth}')
            await page.screenshot(path=f'/tmp/orbitpane-settings-usage-{provider_id}-{width}.png')
            assert not errors, errors
            await page.close()
        await browser.close()
    print('Usage desktop/mobile, shared refresh, quota rendering and accessibility checks passed')


asyncio.run(main())
