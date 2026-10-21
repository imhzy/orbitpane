"""Workbench navigation, panels, context and sharing. Vite must run on :5179.
All service traffic is mocked; no production data or agents are touched.
"""
import asyncio
from urllib.parse import urlparse
from pathlib import Path
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        sessions = [dict(id=i, name=f'Session {i}', path='/tmp/repo', provider='fake', preferred_model='test', permission_mode='workspace', draft='', is_archived=False, is_pinned=False, created_at='2026-10-20T00:00:00Z', sort_order=i) for i in (1,2)]
        task_status = 'completed'
        messages = [dict(id=1, role='user', content='Review these changes'), dict(id=2, role='agent', content='Completed review.\n\n```python\nprint("hello")\n```')]
        async def route_api(route):
            path = urlparse(route.request.url).path
            if path == '/api/session': data = {'authenticated': True}
            elif path == '/api/conversations':
                if route.request.method == 'POST':
                    data = dict(sessions[0], **route.request.post_data_json)
                    data['id'] = len(sessions)+1
                    sessions.append(data)
                else: data = sessions
            elif path in ['/api/conversations/1', '/api/conversations/2', '/api/conversations/3']:
                data = dict(sessions[int(path.rsplit('/',1)[1])-1], **(route.request.post_data_json or {}))
            elif path == '/api/agents': data = {'default_provider':'fake','providers':[{'id':'fake','name':'Test Agent','available':True,'models':[{'id':'test','display_name':'Test'}]}]}
            elif path == '/api/models': data = {'provider':'fake','models':[{'id':'test','display_name':'Test'}]}
            elif path == '/api/workspace-roots': data = {'roots':['/tmp'],'default_root':'/tmp'}
            elif '/history/' in path: data = {'items': messages, 'has_more':False}
            elif path.endswith('/workspace-status'): data = {'is_git':True,'branch':'main','files':[{'path':'app.py','status':'modified','code':' M'}],'counts':{'modified':1}}
            elif path.endswith('/workspace-diff'): data = {'diff':'--- a/app.py\n+++ b/app.py\n-old\n+new','truncated':False,'scope':'Tracked changes'}
            elif path.endswith('/stats'): data = {'message_count':2,'duration':4,'input_chars':20,'output_chars':50,'context_chars':70,'summary_count':0}
            elif path.endswith('/tasks'): data = {'items':[{'run_id':'one','conversation_id':1,'conversation_name':'Session 1','status':task_status,'prompt':'Review changes','model':'test','duration':4,'error':'','queued_at':'2026-10-20T00:00:00Z'}]}
            elif path.endswith('/share-preview'): data = {'version':1,'title':'Session 1','messages':messages,'include_thoughts':False}
            elif path.endswith('/shares'): data = {'items':[]}
            elif path.endswith('/files'): data = {'items':[{'name':'app.py','path':'/tmp/repo/app.py','relative_path':'app.py'}],'truncated':False}
            elif path == '/api/ls': data = {'items':[],'current_path':'/tmp'}
            else: data = {'items':[],'available':False,'error':'Unavailable','windows':[]}
            await route.fulfill(json=data)
        await page.route('**/api/**', route_api)
        await page.add_init_script('''class Socket extends EventTarget {
          static OPEN=1; static CLOSED=3; readyState=1;
          constructor(){super();setTimeout(()=>this.onopen?.(new Event('open')),20)}
          send(){} close(){this.readyState=3} }
          window.WebSocket=Socket;''')
        await page.goto('http://127.0.0.1:5179/?id=1')
        await expect(page.get_by_role('navigation',name='项目内会话')).to_be_visible()
        await expect(page.get_by_role('button',name='展开文件差异')).to_be_visible()
        handle = page.get_by_role('separator',name='任务面板宽度')
        await handle.focus()
        await page.keyboard.press('ArrowLeft')
        await expect(handle).to_have_attribute('aria-valuenow','356')
        await page.get_by_role('button',name='关闭任务面板',exact=True).click()
        await expect(page.locator('.workspace-inspector')).to_be_hidden()
        await page.get_by_role('button',name='打开任务与上下文面板',exact=True).click()
        await expect(page.locator('.workspace-inspector')).to_be_visible()
        await page.get_by_role('tab',name='进展与结果').click()
        await page.get_by_role('button',name='展开文件差异').click()
        await expect(page.get_by_role('dialog',name='项目文件差异')).to_contain_text('+new')
        await page.keyboard.press('Escape')
        await page.get_by_role('button',name='展开代码',exact=True).click()
        await expect(page.get_by_role('dialog',name='python 代码')).to_be_visible()
        await page.keyboard.press('Escape')
        composer = page.get_by_role('textbox', name='消息输入框')
        await composer.fill('@app')
        await page.get_by_role('option').filter(has_text='app.py').click()
        await expect(page.locator('.composer-references')).to_contain_text('/tmp/repo/app.py')
        await page.get_by_role('button', name='移除引用 /tmp/repo/app.py').click()
        await expect(page.locator('.composer-references')).to_have_count(0)
        await composer.fill('')
        await page.get_by_role('button',name='新会话',exact=True).click()
        await expect(page.get_by_role('navigation',name='项目内会话').get_by_role('button')).to_have_count(3)
        await page.get_by_role('button',name='会话操作',exact=True).click()
        await page.get_by_role('menuitem',name='分享',exact=True).click()
        await expect(page.get_by_role('button',name='7 天',exact=True)).to_have_attribute('aria-pressed','true')
        await page.get_by_role('button',name='预览接收者可见内容').click()
        await expect(page.get_by_role('dialog',name='分享内容预览')).to_contain_text('Completed review')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await page.locator('.global-navigation').get_by_role('button',name='工作台',exact=True).click()
        await expect(page.get_by_role('heading',name='工作台')).to_be_visible()
        await expect(page.locator('.home-activity')).to_have_count(0)
        await expect(page.locator('.sidebar-task-status')).to_contain_text(['已完成'])
        for task_status, label in [('running', '执行中'), ('queued', '排队中'), ('failed', '已失败'), ('completed', '已完成')]:
            await page.evaluate("window.dispatchEvent(new Event('orbitpane-task-change'))")
            await expect(page.locator('.sidebar-task-status')).to_contain_text([label])
        await page.screenshot(path='/tmp/orbitpane-home.png')
        sidebar_before = await page.locator('.drawer').bounding_box()
        await page.locator('.home-start').get_by_role('button',name='打开项目',exact=True).click()
        await expect(page.locator('.create-project-dialog')).to_have_attribute('aria-modal','true')
        await page.wait_for_timeout(500)
        bounds = await page.locator('.create-project-dialog').bounding_box()
        assert bounds['width'] >= 600, bounds
        await page.screenshot(path='/tmp/orbitpane-create.png')
        await page.keyboard.press('Escape')
        await expect(page.locator('.drawer')).to_be_visible()
        assert await page.locator('.drawer').bounding_box() == sidebar_before
        await page.locator('.home-start button').click()
        await page.get_by_label('会话名称',exact=True).fill('Unsaved')
        await page.get_by_role('button',name='关闭打开项目窗口').click()
        await page.get_by_role('button',name='放弃',exact=True).click()
        await expect(page.locator('.create-project-dialog')).to_have_count(0)
        await expect(page.locator('.drawer')).to_be_visible()
        await expect(page.locator('.global-navigation button')).to_have_count(1)
        await page.get_by_role('button',name='设置',exact=True).click()
        await page.get_by_role('button',name='账户额度',exact=True).click()
        await expect(page.get_by_role('heading',name='提供方账户额度')).to_be_visible()
        await expect(page.get_by_text('费用与统计范围',exact=True)).to_have_count(0)
        await expect(page.get_by_text('当前部署未接入',exact=False)).to_have_count(0)
        await page.keyboard.press('Escape')
        await page.get_by_role('button',name='展开 / 收起导航').click()
        await expect(page.locator('.drawer')).to_have_count(0)
        await page.locator('.home-start button').click()
        await expect(page.locator('.create-project-dialog')).to_be_visible()
        await page.keyboard.press('Escape')
        await expect(page.locator('.drawer')).to_have_count(0)
        await page.set_viewport_size({'width':390,'height':844})
        await page.locator('.home-start button').click()
        await expect(page.locator('.create-project-dialog')).to_be_visible()
        assert await page.locator('.create-project-dialog').evaluate('(el) => el.getBoundingClientRect().right <= innerWidth')
        await page.screenshot(path='/tmp/orbitpane-create-mobile.png')
        await page.get_by_role('button',name='关闭打开项目窗口').click()
        await expect(page.locator('.create-project-dialog')).to_have_count(0)
        await page.goto('http://127.0.0.1:5179/?id=1')
        for width in (1440, 1280, 1024, 820, 390, 320):
            await page.set_viewport_size({'width':width,'height':900})
            await page.wait_for_timeout(300)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
            await expect(page.get_by_role('button',name='发送消息',exact=True)).to_be_visible()
        await page.get_by_role('button',name='消息操作',exact=True).last.click()
        await expect(page.get_by_role('menuitem',name='复制内容',exact=True)).to_be_visible()
        await page.keyboard.press('Escape')
        await expect(page.locator('.message-actions-sheet')).to_have_count(0)
        await page.set_viewport_size({'width':390,'height':844})
        await page.screenshot(path='/tmp/orbitpane-mobile.png')
        await page.set_viewport_size({'width':1440,'height':1000})
        await page.screenshot(path='/tmp/orbitpane-desktop.png')
        assert not errors, errors
        await browser.close()
        print('Workbench browser checks passed')

if __name__ == '__main__': asyncio.run(main())
