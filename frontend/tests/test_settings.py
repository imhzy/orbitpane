"""Settings/navigation regressions against Vite on 127.0.0.1:5179.

All API and agent traffic is mocked. Requires Python Playwright and Chromium.
"""
import asyncio
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright, expect
from browser_helpers import assert_menu_visible, choose_option

BASE = 'http://127.0.0.1:5179'


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 960}, service_workers='block')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        providers = [
            {'id': 'first', 'name': 'First Agent', 'tone': 'default', 'available': True,
             'models': [{'id': 'fast', 'display_name': 'Fast'}, {'id': 'deep', 'display_name': 'Deep'}]},
            {'id': 'second', 'name': 'Second Agent', 'tone': 'default', 'available': True,
             'models': [{'id': 'second-fast', 'display_name': 'Second Fast'}, {'id': 'second-deep', 'display_name': 'Second Deep'}]},
            {'id': 'unavailable', 'name': 'Unavailable Agent', 'tone': 'default', 'available': False, 'models': []},
        ]
        conversations = [
            {'id': 1, 'name': 'OrbitPane', 'path': '/tmp/orbitpane', 'provider': 'first',
             'preferred_model': 'fast', 'permission_mode': 'workspace', 'is_pinned': False, 'is_archived': False, 'draft': ''},
            {'id': 2, 'name': 'Archived project', 'path': '/tmp/archive', 'provider': 'first',
             'preferred_model': 'deep', 'permission_mode': 'workspace', 'is_pinned': False, 'is_archived': True, 'draft': ''},
        ]
        plugins = []
        plugin_schema = {'properties': {'username': {'type': 'string', 'title': 'SMTP 用户名'},
                                        'password': {'type': 'string', 'title': 'SMTP 密码 / 授权码'}},
                         'required': ['username', 'password']}
        created = []
        long_root = '/root/projects/' + 'long-workspace-directory/' * 8
        task_failure = False
        task_status = None

        async def route_api(route):
            nonlocal task_failure, task_status
            url = urlparse(route.request.url)
            query = parse_qs(url.query)
            path = url.path
            if path == '/api/session':
                data = {'authenticated': True}
            elif path == '/api/plugins':
                if route.request.method == 'POST':
                    payload = route.request.post_data_json
                    plugins.append({'id': str(len(plugins) + 1), **payload, 'enabled': False,
                                    'description': '发送邮件', 'config': {}, 'configured_secrets': [],
                                    'secret_fields': ['password'], 'schema': plugin_schema})
                data = {'items': plugins, 'definitions': [{'id': 'send_email', 'name': '发送邮件'}]}
            elif path.startswith('/api/plugins/'):
                plugin = next(item for item in plugins if item['id'] == path.rsplit('/', 1)[1])
                payload = route.request.post_data_json
                config = payload['config'].copy()
                if config.pop('password', None):
                    plugin['configured_secrets'] = ['password']
                plugin.update(name=payload['name'], enabled=payload['enabled'], config=config)
                data = {'items': plugins}
            elif path.endswith('/plugins'):
                data = {'items': [{key: value for key, value in plugin.items() if key not in ('config', 'schema', 'secret_fields', 'configured_secrets')} for plugin in plugins]}
            elif path == '/api/usage':
                data = {'available': False, 'error': '', 'windows': [], 'provider': 'first', 'plan': None}
            elif path == '/api/agents':
                data = {'default_provider': 'first', 'providers': providers}
            elif path == '/api/models':
                provider = next((item for item in providers if item['id'] == query.get('provider', ['first'])[0]), providers[0])
                data = {'provider': provider['id'], 'models': provider['models']}
            elif path == '/api/workspace-roots':
                data = {'roots': ['/tmp', '/root/projects', long_root], 'default_root': '/tmp'}
            elif path == '/api/ls':
                data = {'items': [], 'current_path': query.get('path', ['/tmp'])[0]}
            elif path == '/api/push/config':
                data = {'enabled': False, 'public_key': ''}
            elif path == '/api/conversations':
                if route.request.method == 'POST':
                    payload = route.request.post_data_json
                    created.append(payload)
                    data = {'id': 3, 'is_archived': False, 'is_pinned': False, 'draft': '', **payload}
                    conversations.append(data)
                else:
                    data = conversations
            elif path.startswith('/api/conversations/') and path.rsplit('/', 1)[1].isdigit():
                conversation = next(item for item in conversations if item['id'] == int(path.rsplit('/', 1)[1]))
                if route.request.method == 'PUT':
                    conversation.update(route.request.post_data_json)
                data = conversation
            elif '/history/' in path:
                data = {'items': [{'id': 1, 'role': 'user', 'content': 'Review the project'},
                                  {'id': 2, 'role': 'agent', 'content': 'Project reviewed.', 'model': 'fast'}], 'has_more': False}
            elif path.endswith('/tasks') or path == '/api/tasks':
                if task_failure and path.endswith('/1/tasks'):
                    await route.fulfill(status=503, json={'detail': 'temporarily unavailable'})
                    return
                data = {'items': [{'run_id': 'active-run', 'conversation_id': 1, 'status': task_status}] if task_status else []}
            elif path.endswith('/stats'):
                data = {'message_count': 2, 'duration': 1, 'input_chars': 30, 'output_chars': 40,
                        'context_chars': 70, 'summary_count': 0, 'context_limit': 120000}
            elif path.endswith('/workspace-status'):
                data = {'is_git': False, 'branch': '', 'files': [], 'counts': {}}
            else:
                data = {'items': []}
            await route.fulfill(json=data)

        await page.route('**/api/**', route_api)
        await page.add_init_script('''
          window.createdSockets = [];
          class FakeSocket {
            static OPEN = 1; static CONNECTING = 0;
            readyState = 0;
            constructor() { window.createdSockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 30); }
            send() {}
            close() { this.readyState = 3; }
          }
          window.WebSocket = FakeSocket;
        ''')
        await page.goto(BASE + '/?id=1')
        await page.get_by_label('消息输入框').wait_for()
        await expect(page.locator('.composer-model-selector')).to_have_count(1)
        await expect(page.locator('.chat-header .model-selector-container')).to_have_count(0)
        await page.screenshot(path='/tmp/orbitpane-workbench-desktop.png')
        await page.locator('.sidebar-settings-btn').click()
        await page.get_by_role('heading', name='通用', exact=True).wait_for()
        await page.get_by_role('radio', name='浅色', exact=True).click()
        assert await page.locator('html').get_attribute('data-theme') == 'light'
        await page.get_by_role('radio', name='跟随系统', exact=True).click()
        await page.emulate_media(color_scheme='dark')
        await expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        await page.screenshot(path='/tmp/orbitpane-settings-desktop.png')
        await page.reload()
        await page.get_by_role('radio', name='跟随系统', exact=True).wait_for()
        await expect(page.get_by_role('radio', name='跟随系统', exact=True)).to_have_attribute('aria-checked', 'true')
        print('PASS: theme/system changes persist across reloads and settings have a direct URL')

        await page.get_by_role('button', name='Agent 插件', exact=True).click()
        await page.get_by_role('heading', name='Agent 插件', exact=True).wait_for()
        for name in ('工作邮箱', '个人邮箱'):
            await page.get_by_label('名称', exact=True).fill(name)
            await page.get_by_role('button', name='添加插件', exact=True).click()
            await page.get_by_role('heading', name=name, exact=True).first.wait_for()
        form = page.locator('.project-plugin-form').filter(has=page.get_by_role('heading', name='工作邮箱', exact=True))
        await form.get_by_label('SMTP 用户名', exact=True).fill('work@example.com')
        await form.get_by_label('SMTP 密码 / 授权码', exact=True).fill('test-secret')
        await form.get_by_role('switch').click()
        await form.get_by_role('button', name='保存插件设置', exact=True).click()
        await expect(form.get_by_role('status')).to_contain_text('已保存并全局启用')
        await expect(form.get_by_label('SMTP 密码 / 授权码', exact=True)).to_have_value('')
        await page.reload()
        await page.get_by_role('heading', name='Agent 插件', exact=True).wait_for()
        await expect(page.locator('.project-plugin-form')).to_have_count(2)
        await expect(page.get_by_role('switch', name='启用工作邮箱')).to_have_attribute('aria-checked', 'true')
        await expect(page.get_by_role('switch', name='启用个人邮箱')).to_have_attribute('aria-checked', 'false')
        await page.screenshot(path='/tmp/orbitpane-global-plugins.png')
        print('PASS: global plugins page creates multiple instances and persists config without echoing secrets')


        await page.get_by_role('button', name='返回工作台', exact=True).click()
        await page.locator('.settings-page').wait_for(state='detached')
        await page.get_by_label('消息输入框').fill('Keep this unsent draft')
        socket_count = await page.evaluate('window.createdSockets.length')
        await page.keyboard.press('Control+,')
        await page.get_by_role('button', name='AI 与工作区', exact=True).click()
        agent = page.get_by_role('combobox', name='默认 Agent', exact=True)
        await agent.focus()
        await page.keyboard.press('ArrowDown')
        await assert_menu_visible(page, '默认 Agent')
        await expect(page.get_by_role('option', name='Unavailable Agent（不可用）', exact=True)).to_have_attribute('aria-disabled', 'true')
        await page.get_by_role('option', name='Unavailable Agent（不可用）', exact=True).click(force=True)
        await expect(agent).to_have_attribute('aria-expanded', 'true')
        await expect(agent).to_contain_text('服务器默认')
        await page.screenshot(path='/tmp/orbitpane-themed-settings-menu-dark.png', animations='disabled')
        await page.keyboard.press('Escape')
        await expect(agent).to_be_focused()
        await expect(agent).to_have_attribute('aria-expanded', 'false')
        await expect(page.locator('.settings-page')).to_be_visible()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await expect(agent).to_contain_text('Second Agent')
        assert await page.locator('select, datalist').count() == 0
        await expect(page.get_by_label('默认模型')).to_be_enabled()
        await choose_option(page, '默认模型', 'Second Deep')
        await choose_option(page, '默认工作区', '/root/projects')
        await page.get_by_role('combobox', name='默认工作区', exact=True).click()
        await page.keyboard.press('End')
        await assert_menu_visible(page, '默认工作区')
        await page.emulate_media(color_scheme='light')
        await expect(page.locator('html')).to_have_attribute('data-theme', 'light')
        await expect(agent).to_have_css('background-color', 'rgb(254, 254, 253)')
        await expect(agent).to_have_css('color', 'rgb(37, 31, 24)')
        await page.screenshot(path='/tmp/orbitpane-themed-settings-menu-light.png', animations='disabled')
        await page.keyboard.press('Escape')
        await page.emulate_media(color_scheme='dark')
        assert conversations[0]['provider'] == 'first' and conversations[0]['preferred_model'] == 'fast'
        await page.get_by_role('button', name='返回工作台', exact=True).click()
        await page.locator('.settings-page').wait_for(state='detached')
        await expect(page.locator('.composer-model-selector .model-selector-text')).to_have_text('Fast')
        await expect(page.get_by_label('消息输入框')).to_have_value('Keep this unsent draft')
        assert await page.evaluate('window.createdSockets.length') == socket_count
        await page.locator('.sidebar-project-heading').get_by_role('button', name='打开项目', exact=True).click()
        await page.get_by_label('会话名称', exact=True).fill('New defaults')
        await expect(page.get_by_label('项目路径', exact=True)).to_have_value('/root/projects')
        await expect(page.get_by_label('选择 Agent')).to_have_count(0)
        await page.get_by_role('button', name='运行配置', exact=False).click()
        await choose_option(page, '选择 Agent', 'First Agent')
        await choose_option(page, '选择 Agent', 'Second Agent')
        await page.get_by_role('button', name='创建会话并打开项目', exact=True).click()
        await page.wait_for_function("new URLSearchParams(location.search).get('id') === '3'")
        assert created == [{'name': 'New defaults', 'path': '/root/projects', 'provider': 'second',
                            'permission_mode': 'workspace', 'preferred_model': 'second-deep'}], created
        print('PASS: themed menus escape clipping, skip unavailable options and support keyboard selection; defaults apply only to new projects')

        await page.goto(BASE + '/?id=1&settings=project&settings-project=1')
        await page.get_by_role('heading', name='会话设置', exact=True).wait_for()
        unrestricted = page.get_by_role('radio', name='完全访问', exact=False)
        await expect(unrestricted).to_be_enabled()
        await unrestricted.click()
        await page.get_by_role('heading', name='开启完全访问', exact=True).wait_for()
        await expect(page.get_by_role('button', name='取消', exact=True)).to_be_focused()
        await page.keyboard.press('Tab')
        await expect(page.get_by_role('button', name='开启完全访问', exact=True)).to_be_focused()
        await page.keyboard.press('Tab')
        await expect(page.get_by_role('button', name='取消', exact=True)).to_be_focused()
        await page.keyboard.press('Shift+Tab')
        await expect(page.get_by_role('button', name='开启完全访问', exact=True)).to_be_focused()
        await page.keyboard.press('Control+,')
        await page.keyboard.press('Control+Shift+j')
        await expect(page.locator('.settings-content-header h1')).to_have_text('会话设置')
        await expect(page.get_by_role('button', name='开启完全访问', exact=True)).to_be_focused()
        await page.keyboard.press('Escape')
        await page.locator('.confirm-overlay').wait_for(state='detached')
        await expect(page.locator('.settings-page')).to_be_visible()
        assert conversations[0]['permission_mode'] == 'workspace'
        await unrestricted.click()
        await page.get_by_role('button', name='开启完全访问', exact=True).click()
        await expect(unrestricted).to_have_attribute('aria-checked', 'true')
        assert conversations[0]['permission_mode'] == 'unrestricted'
        task_failure = True
        await page.reload()
        await page.get_by_text('无法确认任务状态，暂时不能修改权限。').wait_for()
        await expect(page.get_by_role('radio', name='完全访问', exact=False)).to_be_disabled()
        task_failure = False
        await page.get_by_role('button', name='重试', exact=True).click()
        await expect(page.get_by_role('radio', name='受限工作区', exact=False)).to_be_enabled()
        await page.get_by_role('radio', name='受限工作区', exact=False).click()
        for task_status in ['queued', 'running']:
            await page.reload()
            await page.get_by_text('任务运行或排队时不能修改权限。').wait_for()
            await expect(page.get_by_role('radio', name='完全访问', exact=False)).to_be_disabled()
        task_status = None
        await page.get_by_role('button', name='刷新状态', exact=True).click()
        await expect(page.get_by_role('radio', name='完全访问', exact=False)).to_be_enabled()
        print('PASS: permission dialogs cycle keyboard focus; active tasks and failed status checks lock permission changes')

        await page.get_by_role('button', name='数据管理', exact=True).click()
        await page.get_by_text('Archived project', exact=True).wait_for()
        await page.get_by_role('button', name='恢复', exact=True).click()
        await page.get_by_text('暂无已归档会话', exact=True).wait_for()
        assert conversations[1]['is_archived'] is False
        await page.get_by_role('button', name='返回工作台', exact=True).click()
        await page.locator('.settings-page').wait_for(state='detached')
        await page.locator('.sidebar-settings-btn').click()
        await page.get_by_role('button', name='通知', exact=True).click()
        await page.go_back()
        await page.locator('.settings-page').wait_for(state='detached')
        await page.go_forward()
        await page.get_by_role('heading', name='通知', exact=True).wait_for()
        await page.keyboard.press('Tab')
        assert await page.evaluate("document.querySelector('.settings-page').contains(document.activeElement)")
        print('PASS: archive restoration, browser back/forward and keyboard focus stay within their scope')

        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.get_by_role('button', name='通用', exact=True).click()
        for toast in await page.get_by_role('button', name='关闭提示', exact=True).all():
            await toast.click()
        await page.locator('.toast').wait_for(state='detached')
        await page.screenshot(path='/tmp/orbitpane-settings-mobile.png')
        for section in ['AI 与工作区', '通知', '数据管理', '安全', '关于', '会话设置']:
            await page.get_by_role('button', name=section, exact=True).click()
            await page.get_by_role('heading', name=section, exact=True).wait_for()
            assert await page.locator('.settings-content').evaluate('el => el.scrollWidth <= el.clientWidth + 1'), section
            if section == 'AI 与工作区':
                await page.get_by_role('combobox', name='默认 Agent', exact=True).click()
                await assert_menu_visible(page, '默认 Agent')
                await page.screenshot(path='/tmp/orbitpane-themed-settings-menu-mobile.png', animations='disabled')
                await page.keyboard.press('Escape')
                await expect(page.locator('.settings-page')).to_be_visible()
        await page.get_by_role('button', name='返回工作台', exact=True).click()
        await page.locator('.settings-page').wait_for(state='detached')
        await page.screenshot(path='/tmp/orbitpane-workbench-mobile.png')
        await page.get_by_label('展开 / 收起导航', exact=True).click()
        await page.get_by_label('会话操作 OrbitPane', exact=True).click()
        menu = page.locator('.project-actions-sheet')
        await expect(menu.get_by_role('menuitem', name='会话设置', exact=True)).to_be_focused()
        for _ in range(6):
            await page.keyboard.press('Tab')
            assert await menu.evaluate('el => el.contains(document.activeElement)')
        await page.keyboard.press('Escape')
        await menu.wait_for(state='detached')
        await expect(page.get_by_label('会话操作 OrbitPane', exact=True)).to_be_focused()
        await page.get_by_label('会话操作 OrbitPane', exact=True).click()
        await page.locator('.project-actions-sheet').get_by_role('menuitem', name='会话设置', exact=True).click()
        await page.get_by_role('heading', name='会话设置', exact=True).wait_for()
        await page.keyboard.press('Escape')
        await page.locator('.settings-page').wait_for(state='detached')

        await page.set_viewport_size({'width': 900, 'height': 960})
        item = page.locator('.list-item').filter(has_text='OrbitPane').first
        await item.dispatch_event('pointerdown', {'pointerType': 'touch', 'clientX': 160, 'clientY': 270})
        popover = page.get_by_role('menu', name='会话操作', exact=True)
        await popover.wait_for()
        bounds = await popover.bounding_box()
        assert bounds and bounds['x'] >= 8 and bounds['y'] >= 8, bounds
        await item.dispatch_event('pointerup', {'pointerType': 'touch'})
        await page.keyboard.press('Escape')
        await popover.wait_for(state='detached')

        for conversation in conversations:
            conversation['is_archived'] = True
        await page.goto(BASE)
        await page.get_by_role('heading', name='工作台', exact=True).wait_for()
        await page.get_by_role('button', name='管理已归档会话', exact=True).click()
        await page.get_by_role('heading', name='数据管理', exact=True).wait_for()
        await page.locator('.settings-archive-row').filter(has_text='OrbitPane').get_by_role('button', name='恢复', exact=True).click()
        await page.get_by_role('button', name='返回工作台', exact=True).click()
        await page.locator('.settings-page').wait_for(state='detached')
        await expect(page.get_by_role('region', name='工作台', exact=True)).to_be_visible()
        assert conversations[0]['is_archived'] is False
        assert not errors, errors
        print('PASS: mobile settings fit; project sheets trap and restore focus; tablet long-press menus stay anchored')
        print('PASS: all-archived projects show a useful home state and a working restoration entry')
        await browser.close()


asyncio.run(main())
