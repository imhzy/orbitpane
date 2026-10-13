"""Schedule management and transcript regressions against Vite on port 5179.

All HTTP/WebSocket traffic is mocked; these tests never execute real agents.
"""
import asyncio
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_helpers import assert_menu_visible, choose_option

BASE = 'http://127.0.0.1:5179'


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 960}, service_workers='block')
        errors, schedules, requests, history = [], [], [], []
        run_calls = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        conversation = {'id': 1, 'name': 'Schedule workspace', 'path': '/tmp/workspace', 'provider': 'fake',
                        'preferred_model': 'test', 'permission_mode': 'workspace', 'draft': '', 'is_archived': False, 'is_pinned': False}

        async def route_api(route):
            path = urlparse(route.request.url).path
            method = route.request.method
            body = route.request.post_data_json if method in ('POST', 'PATCH', 'PUT') else None
            data = {'items': []}
            if path == '/api/session': data = {'authenticated': True}
            elif path == '/api/conversations': data = [conversation]
            elif path == '/api/conversations/1': data = {**conversation, **(body or {})}
            elif path == '/api/agents': data = {'default_provider': 'fake', 'providers': [{'id': 'fake', 'name': 'Agent', 'tone': 'default', 'available': True, 'models': [{'id': 'test', 'display_name': 'Test'}]}]}
            elif path == '/api/models': data = {'provider': 'fake', 'models': [{'id': 'test', 'display_name': 'Test'}]}
            elif path == '/api/workspace-roots': data = {'roots': ['/tmp'], 'default_root': '/tmp'}
            elif path == '/api/push/config': data = {'enabled': False, 'public_key': ''}
            elif path == '/api/history/1': data = {'items': history, 'first_id': history[0]['id'] if history else 0, 'has_more': False}
            elif path.endswith('/stats'): data = {'message_count': len(history), 'duration': 0, 'input_chars': 0, 'output_chars': 0, 'context_chars': 0, 'summary_count': 0}
            elif path.endswith('/workspace-status'): data = {'is_git': False, 'branch': '', 'files': [], 'counts': {}}
            elif path == '/api/conversations/1/schedules':
                if method == 'POST':
                    requests.append(body)
                    data = {'id': len(schedules) + 1, 'conversation_id': 1, 'conversation_name': conversation['name'],
                            'enabled': True, 'version': 1, 'next_run_at': '2026-10-13T01:00:00Z', 'pending_count': 0,
                            'last_status': None, 'last_error': None, 'last_run_at': None, **body}
                    schedules.append(data)
                else: data = {'items': schedules}
            elif path.startswith('/api/conversations/1/schedules/'):
                schedule_id = int(path.split('/')[5])
                item = next(item for item in schedules if item['id'] == schedule_id)
                if path.endswith('/run'):
                    run_calls.append(body)
                    item.update(last_status='queued', pending_count=1, last_run_at='2026-10-12T01:00:00Z')
                    data = {'run_id': 'scheduled-run', 'status': 'queued', 'position': 1, 'prompt': item['prompt'],
                            'schedule_id': item['id'], 'schedule_name': item['name'], 'scheduled_for': '2026-10-12T01:00:00Z'}
                elif method == 'PATCH':
                    requests.append(body)
                    item.update(body)
                    item['version'] += 1
                    if 'enabled' in body: item['next_run_at'] = '2026-10-13T01:00:00Z' if body['enabled'] else None
                    data = item
                elif method == 'DELETE': schedules.remove(item); data = {'status': 'ok'}
            await route.fulfill(json=data)

        await page.route('**/api/**', route_api)
        socket_stub = '''
          window.createdSockets = [];
          class FakeSocket {
            static OPEN = 1; static CONNECTING = 0; readyState = 0;
            constructor() { window.createdSockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 20); }
            send() {}
            close() { this.readyState = 3; }
            receive(data) { this.onmessage?.({data: JSON.stringify(data)}); }
          }
          window.WebSocket = FakeSocket;
        '''
        await page.add_init_script(socket_stub)
        await page.goto(BASE + '/?id=1&panel=schedules')
        await expect(page.get_by_role('tab', name='定时', exact=True)).to_have_attribute('aria-selected', 'true')
        await page.get_by_role('button', name='创建第一个任务').click()
        await page.get_by_label('任务名称', exact=True).fill('Weekly review')
        await page.get_by_label('Agent 命令', exact=True).fill('Review recent changes')
        await page.get_by_label('间隔', exact=True).fill('1')
        await expect(page.get_by_role('button', name='减少间隔', exact=True)).to_be_disabled()
        await page.get_by_role('button', name='增加间隔', exact=True).click()
        await expect(page.get_by_label('间隔', exact=True)).to_have_value('2')
        await page.get_by_role('button', name='减少间隔', exact=True).click()
        await expect(page.get_by_label('间隔', exact=True)).to_have_value('1')
        await choose_option(page, '执行周期', '每周定时')
        await page.get_by_role('button', name='选择执行时间 1', exact=True).click()
        await expect(page.get_by_role('dialog', name='选择执行时间 1', exact=True)).to_be_visible()
        await choose_option(page, '执行时间 1小时', '17')
        await choose_option(page, '执行时间 1分钟', '45')
        await page.get_by_role('button', name='完成', exact=True).click()
        await expect(page.get_by_label('执行时间 1', exact=True)).to_have_value('17:45')
        await expect(page.get_by_label('执行时间 1', exact=True)).to_be_focused()
        await page.get_by_role('button', name='选择执行时间 1', exact=True).click()
        await page.get_by_role('combobox', name='执行时间 1小时', exact=True).click()
        await page.keyboard.press('Escape')
        await expect(page.get_by_role('dialog', name='选择执行时间 1', exact=True)).to_be_visible()
        await page.keyboard.press('Escape')
        await expect(page.get_by_role('dialog', name='选择执行时间 1', exact=True)).to_have_count(0)
        await expect(page.locator('.workspace-inspector')).to_be_visible()
        await page.get_by_label('执行时间 1', exact=True).fill('09:15')
        await page.get_by_role('button', name='添加时间', exact=True).click()
        await page.get_by_label('执行时间 2', exact=True).fill('18:30')
        await page.get_by_label('周二', exact=True).uncheck()
        await page.get_by_label('周四', exact=True).uncheck()
        await page.get_by_label('周五', exact=True).uncheck()
        await page.get_by_label('时区', exact=True).fill('Europe/Paris')
        await expect(page.get_by_label('时区', exact=True)).to_have_value('Europe/Paris')
        await page.get_by_label('时区', exact=True).fill('New_York')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await expect(page.get_by_label('时区', exact=True)).to_have_value('America/New_York')
        assert await page.locator('select, datalist, input[type=time]').count() == 0
        assert await page.get_by_label('周一', exact=True).evaluate("element => getComputedStyle(element).appearance === 'none'")
        await page.get_by_label('执行前压缩上下文', exact=False).check()
        await page.get_by_role('button', name='保存任务', exact=True).click()
        await expect(page.locator('.schedule-card')).to_have_count(1)
        assert requests[0] == {'name': 'Weekly review', 'prompt': 'Review recent changes',
            'compact_before': True, 'spec': {'kind': 'weekly', 'timezone': 'America/New_York', 'times': ['09:15', '18:30'], 'weekdays': [0, 2]}}
        await expect(page.locator('.schedule-rule')).to_contain_text('周一、周三')
        await page.screenshot(path='/tmp/orbitpane-schedules-desktop.png')
        print('PASS: custom number/time/timezone controls, layered Escape, styled checkboxes and weekly schedule persistence')

        await page.get_by_role('button', name='编辑', exact=True).click()
        await choose_option(page, '执行周期', '固定间隔')
        await page.get_by_label('间隔', exact=True).fill('2')
        await choose_option(page, '单位', '小时')
        await page.get_by_role('button', name='保存任务', exact=True).click()
        await expect(page.locator('.schedule-rule')).to_contain_text('每 2 小时')
        assert requests[-1]['spec']['times'] == [] and requests[-1]['spec']['weekdays'] == []
        assert requests[-1]['version'] == 1
        await page.get_by_role('button', name='暂停', exact=True).click()
        await expect(page.locator('.schedule-status')).to_have_text('已暂停')
        await page.get_by_role('button', name='立即执行', exact=True).click()
        await expect(page.locator('.schedule-details')).to_contain_text('1 次')
        assert run_calls[0]['request_id']
        await page.get_by_role('button', name='恢复', exact=True).click()
        await expect(page.locator('.schedule-status')).to_have_text('已启用')
        print('PASS: interval editing, optimistic version, pause/resume and run-now queue feedback')

        history.extend([
            {'id': 1, 'role': 'user', 'content': 'Review recent changes', 'run_id': 'finished',
             'schedule_id': 1, 'schedule_name': 'Weekly review', 'scheduled_for': '2026-10-12T01:00:00Z'},
            {'id': 2, 'role': 'agent', 'content': 'Review finished.', 'run_id': 'finished', 'model': 'test',
             'schedule_id': 1, 'schedule_name': 'Weekly review', 'scheduled_for': '2026-10-12T01:00:00Z'},
        ])
        await page.reload()
        await expect(page.locator('.scheduled-message')).to_have_count(2)
        await expect(page.locator('.chat-message-list .schedule-message-badge')).to_have_count(2)
        queue = {'type': 'queue_changed', 'queue': [{'run_id': 'queued-schedule', 'prompt': 'Review recent changes', 'status': 'queued',
            'position': 1, 'schedule_id': 1, 'schedule_name': 'Weekly review', 'scheduled_for': '2026-10-12T02:00:00Z'}]}
        await page.evaluate('(event) => createdSockets.at(-1).receive(event)', queue)
        await expect(page.locator('.queued-task-banner')).to_have_count(1)
        await expect(page.locator('.scheduled-message')).to_have_count(4)
        await page.evaluate("createdSockets.at(-1).receive({type:'queue_changed',queue:[]})")
        await expect(page.locator('.queued-task-banner')).to_have_count(0)
        await expect(page.locator('.scheduled-message')).to_have_count(2)
        history.append({'id': 3, 'role': 'system', 'content': 'Compression failed', 'is_error': True, 'error_code': 'compaction_failed',
                        'run_id': 'failure', 'schedule_name': 'Weekly review', 'schedule_id': 1})
        await page.evaluate("createdSockets.at(-1).receive({type:'schedules_changed'})")
        await expect(page.locator('.system-error')).to_contain_text('上下文压缩失败，定时命令未执行')
        await expect(page.locator('.system-error')).to_contain_text('Weekly review')
        print('PASS: persisted scheduled bubbles, live queue creation/cancellation, failure history synchronization')

        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.goto(BASE + '/?id=1&panel=schedules')
        await expect(page.locator('.workspace-inspector')).to_be_visible()
        await page.get_by_role('button', name='新增', exact=True).click()
        await page.get_by_label('任务名称', exact=True).fill('Daily check')
        await page.get_by_label('Agent 命令', exact=True).fill('Check the project')
        await page.get_by_role('combobox', name='执行周期', exact=True).click()
        await assert_menu_visible(page, '执行周期')
        await page.screenshot(path='/tmp/orbitpane-themed-schedule-menu-mobile.png', animations='disabled')
        await page.get_by_role('option', name='每天定时', exact=True).click()
        await page.get_by_role('button', name='选择执行时间 1', exact=True).click()
        await page.get_by_role('combobox', name='执行时间 1分钟', exact=True).click()
        await assert_menu_visible(page, '执行时间 1分钟')
        await page.get_by_role('option', name='30', exact=True).click()
        await page.get_by_role('button', name='完成', exact=True).click()
        await page.get_by_label('执行时间 1', exact=True).fill('0800')
        await expect(page.get_by_label('执行时间 1', exact=True)).to_have_value('08:00')
        await page.get_by_label('时区', exact=True).fill('Asia/Shanghai')
        assert await page.get_by_label('任务名称', exact=True).evaluate("element => parseFloat(getComputedStyle(element).fontSize) >= 16")
        await page.screenshot(path='/tmp/orbitpane-schedules-mobile-form.png')
        await page.get_by_role('button', name='保存任务', exact=True).click()
        await expect(page.locator('.schedule-card')).to_have_count(2)
        assert requests[-1]['spec'] == {'kind': 'daily', 'timezone': 'Asia/Shanghai', 'times': ['08:00'], 'weekdays': []}
        assert not requests[-1]['compact_before']
        assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        await page.screenshot(path='/tmp/orbitpane-schedules-mobile.png')
        await page.get_by_role('button', name='删除定时任务 Daily check', exact=True).click()
        await page.get_by_role('button', name='删除', exact=True).click()
        await expect(page.locator('.schedule-card')).to_have_count(1)
        await page.locator('.inspector-mobile-close').click()
        await page.get_by_role('button', name='会话操作', exact=True).click()
        await page.get_by_role('menuitem', name='定时任务', exact=True).click()
        await expect(page.get_by_role('tab', name='定时', exact=True)).to_have_attribute('aria-selected', 'true')
        print('PASS: mobile daily creation, multiple schedules, deletion and action-menu navigation without horizontal overflow')

        touch = await browser.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
        touch.on('pageerror', lambda error: errors.append(str(error)))
        await touch.route('**/api/**', route_api)
        await touch.add_init_script(socket_stub)
        await touch.goto(BASE + '/?id=1&panel=schedules')
        await touch.get_by_role('button', name='新增', exact=True).tap()
        await touch.get_by_role('combobox', name='执行周期', exact=True).tap()
        await touch.get_by_role('option', name='每周定时', exact=True).tap()
        await touch.get_by_role('button', name='选择执行时间 1', exact=True).tap()
        await touch.get_by_role('combobox', name='执行时间 1小时', exact=True).tap()
        await touch.get_by_role('option', name='22', exact=True).tap()
        await touch.get_by_role('combobox', name='执行时间 1分钟', exact=True).tap()
        await assert_menu_visible(touch, '执行时间 1分钟')
        await touch.get_by_role('option', name='59', exact=True).tap()
        await touch.get_by_role('button', name='完成', exact=True).tap()
        await expect(touch.get_by_label('执行时间 1', exact=True)).to_have_value('22:59')
        await touch.get_by_label('周六', exact=True).tap()
        await expect(touch.get_by_label('周六', exact=True)).to_be_checked()
        await touch.get_by_role('button', name='时区选项', exact=True).tap()
        await touch.get_by_role('option', name='Asia/Tokyo', exact=True).tap()
        await expect(touch.get_by_role('combobox', name='时区', exact=True)).to_have_value('Asia/Tokyo')
        print('PASS: touch taps select periods, scroll long time menus, check weekdays and choose timezone suggestions')
        assert not errors, errors
        await browser.close()


asyncio.run(main())
