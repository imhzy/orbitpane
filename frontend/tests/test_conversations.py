"""Conversation interactions against Vite on 127.0.0.1:5179.

API/WebSocket traffic is mocked; no agent tasks or production data are changed.
Requires Python Playwright and Chromium.
"""
import asyncio
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

BASE = 'http://127.0.0.1:5179'


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--no-sandbox'])
        providers = [
            {'id': 'google-adapter', 'name': 'Google Gemini', 'tone': 'gemini', 'available': True,
             'models': [{'id': 'test', 'display_name': 'Test'}]},
            {'id': 'openai-adapter', 'name': 'ChatGPT Codex', 'tone': 'codex', 'available': True,
             'models': [{'id': 'test', 'display_name': 'Test'}]},
        ]
        conversations = [{
            'id': cid, 'name': f'Space {cid}', 'path': '/tmp/projects',
            'provider': providers[cid % 2]['id'], 'created_at': '2026-01-01T00:00:00Z',
            'preferred_model': 'test', 'permission_mode': 'workspace', 'draft': '',
            'is_pinned': cid >= 9, 'is_archived': False, 'sort_order': -cid,
        } for cid in range(1, 11)]
        name_writes = []
        order_writes = []
        fail_order = False
        errors = []

        def ordered():
            return sorted(conversations, key=lambda item: (not item['is_pinned'], item['sort_order'], -item['id']))

        async def route_api(route):
            path = urlparse(route.request.url).path
            if path == '/api/session':
                data = {'authenticated': True}
            elif path == '/api/agents':
                data = {'default_provider': providers[0]['id'], 'providers': providers}
            elif path == '/api/models':
                data = {'provider': providers[0]['id'], 'models': providers[0]['models']}
            elif path == '/api/workspace-roots':
                data = {'roots': ['/tmp'], 'default_root': '/tmp'}
            elif path == '/api/conversations':
                data = ordered()
            elif path == '/api/conversations/reorder':
                ids = route.request.post_data_json['conversation_ids']
                order_writes.append(ids)
                await asyncio.sleep(.25)
                if fail_order:
                    await route.fulfill(status=503, json={'detail': 'temporary failure'})
                    return
                requested = iter(ids)
                order = [next(requested) if item['id'] in ids else item['id'] for item in ordered()]
                for item in conversations:
                    item['sort_order'] = order.index(item['id'])
                data = ordered()
            elif path.startswith('/api/conversations/') and path.rsplit('/', 1)[1].isdigit():
                item = next(item for item in conversations if item['id'] == int(path.rsplit('/', 1)[1]))
                values = route.request.post_data_json
                if 'name' in values:
                    name_writes.append(values['name'])
                await asyncio.sleep(.15)
                item.update(values)
                data = item
            elif path.endswith('/stats'):
                data = {'message_count': 0, 'duration': 0, 'input_chars': 0, 'output_chars': 0,
                        'context_chars': 0, 'summary_count': 0}
            elif path.endswith('/workspace-status'):
                data = {'is_git': False, 'branch': '', 'files': [], 'counts': {}}
            elif path == '/api/push/config':
                data = {'enabled': False, 'public_key': ''}
            else:
                data = {'items': [], 'has_more': False}
            await route.fulfill(json=data)

        async def setup(page):
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.route('**/api/**', route_api)
            await page.add_init_script('''
              class FakeSocket {
                static OPEN = 1; static CONNECTING = 0;
                readyState = 0;
                constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 30); }
                send() {} close() { this.readyState = 3; }
              }
              window.WebSocket = FakeSocket;
            ''')

        async def ids(page):
            return await page.locator('.sortable-conversation').evaluate_all('(rows) => rows.map(row => Number(row.dataset.conversationId))')

        async def wait_order(page, expected):
            try:
                await page.wait_for_function('expected => JSON.stringify([...document.querySelectorAll(".sortable-conversation")].map(row => Number(row.dataset.conversationId))) === JSON.stringify(expected)', arg=expected, timeout=5000)
            except Exception:
                print('ORDER DIAGNOSTIC', await ids(page), order_writes, errors)
                await page.screenshot(path='/tmp/orbitpane-conversation-order-failure.png')
                raise
            await page.wait_for_function('!document.querySelector(".sidebar-sort-hint")?.textContent.includes("正在保存")')

        async def keyboard_move(page, cid, direction='ArrowDown', finish='Space'):
            handle = page.locator(f'[data-conversation-id="{cid}"] .conversation-drag-handle')
            await handle.focus()
            await page.keyboard.press('Space')
            await page.locator('.conversation-drag-overlay').wait_for()
            await page.keyboard.press(direction)
            await page.wait_for_timeout(100)
            await page.keyboard.press(finish)
            return handle

        async def open_menu(page, cid):
            row = page.locator(f'[data-conversation-id="{cid}"]')
            await row.hover()
            await row.locator('.project-menu-trigger').click()

        page = await browser.new_page(viewport={'width': 1440, 'height': 960}, service_workers='block')
        await setup(page)
        await page.goto(BASE + '/?id=8')
        await page.locator('.active-conv-title-text').wait_for()
        await page.locator('.active-conv-title-text').click()
        editor = page.locator('.conv-title-input')
        await expect(editor).to_have_count(1)
        await expect(editor).to_be_focused()
        await editor.fill('Desktop rename')
        await editor.press('Enter')
        await expect(page.locator('.active-conv-title-text')).to_have_text('Desktop rename')
        await expect(page.locator('[data-conversation-id="8"] .item-title')).to_have_text('Desktop rename')
        await page.wait_for_timeout(250)
        assert name_writes == ['Desktop rename'], name_writes
        await page.get_by_role('button', name='重命名项目 Desktop rename', exact=True).focus()
        await page.keyboard.press('Enter')
        await editor.fill('Cancelled')
        await editor.press('Escape')
        await expect(editor).to_have_count(0)
        assert name_writes == ['Desktop rename']
        await page.locator('.active-conv-title-text').click()
        await editor.fill('中文项目')
        await editor.evaluate("el => el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 229, isComposing: true, bubbles: true}))")
        await expect(editor).to_have_count(1)
        await editor.press('Tab')
        await expect(page.locator('.active-conv-title-text')).to_have_text('中文项目')
        await page.wait_for_timeout(250)
        assert name_writes == ['Desktop rename', '中文项目']
        await open_menu(page, 8)
        await page.get_by_role('menuitem', name='重命名项目', exact=True).click()
        await expect(editor).to_have_count(1)
        await expect(editor).to_be_focused()
        assert await editor.evaluate("el => Boolean(el.closest('.drawer'))")
        await editor.fill('Sidebar rename')
        await editor.press('Enter')
        await expect(page.locator('.active-conv-title-text')).to_have_text('Sidebar rename')
        print('PASS: one focused rename input, keyboard entry, Escape, IME and blur save')

        await page.wait_for_function("[...document.querySelectorAll('.provider-logo')].every(img => img.complete && img.naturalWidth > 0)")
        assert await page.locator('.drawer .provider-logo-gemini').count() == 5
        assert await page.locator('.drawer .provider-logo-codex').count() == 5
        await page.screenshot(path='/tmp/orbitpane-conversations-desktop.png')
        await page.evaluate("document.documentElement.dataset.theme = 'light'")
        await page.screenshot(path='/tmp/orbitpane-conversations-light.png')
        assert await page.locator('.provider-logo-codex').first.evaluate("el => getComputedStyle(el).filter") == 'none'
        await page.evaluate("document.documentElement.dataset.theme = 'dark'")
        print('PASS: provider marks follow catalog tone and load in both themes')

        handle = page.locator('[data-conversation-id="8"] .conversation-drag-handle')
        source = await handle.bounding_box()
        target = await page.locator('[data-conversation-id="3"]').bounding_box()
        await page.mouse.move(source['x'] + source['width'] / 2, source['y'] + source['height'] / 2)
        await page.mouse.down()
        await page.mouse.move(source['x'] + source['width'] / 2, source['y'] + source['height'] / 2 + 10, steps=3)
        await page.locator('.conversation-drag-overlay').wait_for()
        await page.mouse.move(source['x'] + source['width'] / 2, target['y'] + target['height'] / 2, steps=16)
        await page.mouse.up()
        await wait_order(page, [10, 9, 7, 6, 5, 4, 3, 8, 2, 1])
        assert 'id=8' in page.url
        handle = await keyboard_move(page, 7)
        await wait_order(page, [10, 9, 6, 7, 5, 4, 3, 8, 2, 1])
        assert await handle.evaluate('el => el === document.activeElement')
        count = len(order_writes)
        await keyboard_move(page, 7, finish='Escape')
        await page.wait_for_timeout(100)
        assert len(order_writes) == count
        await keyboard_move(page, 10)
        await wait_order(page, [9, 10, 6, 7, 5, 4, 3, 8, 2, 1])
        await keyboard_move(page, 10, direction='ArrowUp')
        await wait_order(page, [10, 9, 6, 7, 5, 4, 3, 8, 2, 1])
        await open_menu(page, 5)
        await page.get_by_role('menuitem', name='上移', exact=True).click()
        expected = [10, 9, 6, 5, 7, 4, 3, 8, 2, 1]
        await wait_order(page, expected)
        await page.reload()
        await wait_order(page, expected)
        print('PASS: mouse drag, keyboard sorting/cancel, menu alternative and reload persistence')

        fail_order = True
        await keyboard_move(page, 6)
        await page.get_by_text('排序保存失败，已恢复原顺序', exact=True).wait_for()
        await wait_order(page, expected)
        fail_order = False
        await page.locator('.sidebar-search-input').fill('Space')
        assert await page.locator('.conversation-drag-handle[aria-disabled="false"]').count() == 0
        await page.locator('.sidebar-search-input').fill('')
        print('PASS: failed save restores order; search prevents hidden-row surprises')

        mobile = await browser.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
        await setup(mobile)
        await mobile.goto(BASE + '/?id=8')
        await mobile.locator('.active-conv-title-text').tap()
        editor = mobile.locator('.conv-title-input')
        await expect(editor).to_be_focused()
        await editor.fill('Mobile rename')
        await editor.press('Enter')
        await expect(mobile.locator('.active-conv-title-text')).to_have_text('Mobile rename')
        await mobile.set_viewport_size({'width': 320, 'height': 844})
        assert await mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await expect(mobile.locator('.conv-title-trigger')).to_be_visible()
        await mobile.set_viewport_size({'width': 390, 'height': 844})
        await mobile.screenshot(path='/tmp/orbitpane-conversations-mobile-header.png')
        assert await mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await mobile.get_by_role('button', name='返回项目列表', exact=True).tap()
        await mobile.get_by_role('button', name='展开项目菜单', exact=True).tap()
        await mobile.locator('.drawer').wait_for(state='visible')
        await mobile.wait_for_timeout(400)
        handle = mobile.locator('[data-conversation-id="6"] .conversation-drag-handle')
        source = await handle.bounding_box()
        assert source['width'] >= 44 and source['height'] >= 44
        target = await mobile.locator('[data-conversation-id="7"]').bounding_box()
        cdp = await mobile.context.new_cdp_session(mobile)
        x = source['x'] + source['width'] / 2
        y = source['y'] + source['height'] / 2
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        await mobile.wait_for_timeout(270)
        await mobile.locator('.conversation-drag-overlay').wait_for()
        destination = target['y'] + target['height'] / 2
        for step in range(1, 13):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y + (destination - y) * step / 12}]})
            await mobile.wait_for_timeout(15)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        expected = [10, 9, 5, 7, 6, 4, 3, 8, 2, 1]
        await wait_order(mobile, expected)
        assert await mobile.locator('.drawer').evaluate('el => el.getBoundingClientRect().left >= -1')
        await mobile.screenshot(path='/tmp/orbitpane-conversations-mobile-list.png')
        row = mobile.locator('[data-conversation-id="7"]')
        await row.locator('.project-menu-trigger').tap()
        await mobile.get_by_role('menuitem', name='下移', exact=True).tap()
        await wait_order(mobile, [10, 9, 5, 6, 7, 4, 3, 8, 2, 1])
        await row.locator('.project-menu-trigger').tap()
        await mobile.get_by_role('menuitem', name='重命名项目', exact=True).tap()
        await expect(editor).to_have_count(1)
        await expect(editor).to_be_focused()
        await editor.fill('Phone sidebar')
        await editor.press('Enter')
        await expect(row.locator('.item-title')).to_have_text('Phone sidebar')
        await mobile.locator('.project-actions-backdrop').wait_for(state='detached')
        await mobile.locator('.project-actions-sheet').wait_for(state='detached')
        print('PASS: phone title edit, long-press handle, 44px targets, drawer isolation and menu controls')

        # A list-body swipe must stay a native scroll; it must not select a
        # project, open the long-press menu, or change ordering.
        scroll_area = mobile.locator('.drawer-content').first
        await scroll_area.evaluate('el => el.scrollTop = 0')
        writes_before_scroll = len(order_writes)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 145, 'y': 580}]})
        for step in range(1, 11):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': 145, 'y': 580 - 22 * step}]})
            await mobile.wait_for_timeout(20)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        await mobile.wait_for_timeout(400)
        scroll_info = await scroll_area.evaluate('el => ({top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight})')
        assert scroll_info['top'] > 80, scroll_info
        assert len(order_writes) == writes_before_scroll
        assert 'id=' not in mobile.url
        assert await mobile.locator('.project-actions-sheet').count() == 0

        # Holding the handle near the scroller edge reaches rows below the
        # viewport. Touch cancellation leaves the saved order intact.
        await scroll_area.evaluate('el => el.scrollTop = 0')
        handle = mobile.locator('[data-conversation-id="6"] .conversation-drag-handle')
        source = await handle.bounding_box()
        x = source['x'] + source['width'] / 2
        y = source['y'] + source['height'] / 2
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        await mobile.wait_for_timeout(270)
        await mobile.locator('.conversation-drag-overlay').wait_for()
        scroller_box = await scroll_area.bounding_box()
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': scroller_box['y'] + scroller_box['height'] - 8}]})
        await mobile.wait_for_timeout(500)
        assert await scroll_area.evaluate('el => el.scrollTop') > 20
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchCancel', 'touchPoints': []})
        await mobile.locator('.conversation-drag-overlay').wait_for(state='detached')
        assert len(order_writes) == writes_before_scroll
        assert await mobile.locator('.drawer').evaluate('el => el.getBoundingClientRect().left >= -1')
        await keyboard_move(mobile, 6, finish='Escape')
        await mobile.locator('.conversation-drag-overlay').wait_for(state='detached')
        assert await mobile.locator('.drawer').evaluate('el => el.getBoundingClientRect().left >= -1')
        assert len(order_writes) == writes_before_scroll
        print('PASS: native phone scrolling, edge auto-scroll and touch/keyboard cancellation keep the drawer open')
        assert not errors, errors
        await browser.close()
        print('All conversation browser regressions passed')


asyncio.run(main())
