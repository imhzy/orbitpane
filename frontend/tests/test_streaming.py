"""Run against Vite at 127.0.0.1:5179. All backend/agent traffic is mocked."""
import asyncio
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        row = dict(id=2, role='agent', run_id='run', content='disk partial', thought='',
                   run_status='running', execution_steps=[dict(id='tool', kind='exec', title='Run tests',
                   status='running', content='pytest')])
        requests = []

        async def route_api(route):
            url = urlparse(route.request.url)
            if url.path == '/api/history/1':
                after = int(parse_qs(url.query).get('after_id', ['0'])[0])
                requests.append(after)
                rows = [dict(id=1, role='user', run_id='run', content='Do the work'), dict(row)]
                await route.fulfill(json=dict(items=[m for m in rows if m['id'] > after], has_more=False, first_id=1))
            else:
                await route.fulfill(json={'items': []})

        await page.route('**/api/**', route_api)
        await page.add_init_script('''
          class FakeSocket {
            static OPEN=1; static CONNECTING=0; static instances=[];
            readyState=0; sent=[];
            constructor() { FakeSocket.instances.push(this); }
            send(text) { this.sent.push(JSON.parse(text)); }
            close() { this.readyState=3; }
            open() { this.readyState=1; this.onopen?.(); }
            receive(data) { this.onmessage?.({data:JSON.stringify(data)}); }
          }
          window.WebSocket=FakeSocket;
        ''')
        await page.goto('http://127.0.0.1:5179/tests/browser.html')
        await page.wait_for_function('window.testApi')
        await page.evaluate('testApi.hook.loadHistory(1)')
        await page.evaluate('''() => {
          testApi.hook.connectWebSocket(testApi.active.current);
          const ws=WebSocket.instances.at(-1); ws.open();
          ws.receive({protocol:2,type:'sync_state',run_id:'run',sequence:2,content:'live partial',thought:'',
            execution_steps:[{id:'tool',kind:'exec',title:'Run tests',status:'running',content:'pytest'}]});
          ws.receive({protocol:2,type:'token',run_id:'run',sequence:3,content:' plus'});
          ws.receive({protocol:2,type:'token',run_id:'run',sequence:3,content:' plus'});
        }''')
        await page.wait_for_function("testApi.hook.messages.at(-1).content === 'live partial plus'")
        # Refresh must update mutable row 2, while preserving newer socket output.
        await page.evaluate('testApi.hook.loadHistory(1,true)')
        assert requests[-1] == 1
        assert await page.evaluate('testApi.hook.messages.at(-1).content') == 'live partial plus'
        assert await page.evaluate('testApi.hook.messages.at(-1).isThinking')
        await page.evaluate('''() => {
          const ws=WebSocket.instances.at(-1);
          ws.receive({protocol:2,type:'token',run_id:'run',sequence:5,content:'unsafe delta'});
          ws.receive({protocol:2,type:'token',run_id:'run',sequence:6,content:'also unsafe'});
        }''')
        assert await page.evaluate("WebSocket.instances.at(-1).sent.filter(m=>m.action==='sync').length") == 1
        assert await page.evaluate('testApi.hook.messages.at(-1).content') == 'live partial plus'
        await page.evaluate('''() => {
          const ws=WebSocket.instances.at(-1);
          ws.receive({protocol:2,type:'sync_state',run_id:'run',sequence:6,content:'recovered full',thought:'',
            execution_steps:[{id:'tool',kind:'exec',title:'Run tests',status:'failed',content:'tests failed'}]});
        }''')
        await page.get_by_text('失败', exact=True).wait_for()
        row.update(content='final answer', run_status='completed')
        row['execution_steps'][0].update(status='failed', content='tests failed')
        await page.evaluate('''() => WebSocket.instances.at(-1).receive({protocol:2,type:'done',run_id:'run',sequence:6,
          content:'final answer',thought:'',status:'completed',
          execution_steps:[{id:'tool',kind:'exec',title:'Run tests',status:'failed',content:'tests failed'}]})''')
        await page.wait_for_function("testApi.hook.messages.at(-1).run_status === 'completed' && !testApi.hook.messages.at(-1).isThinking")
        await page.evaluate('testApi.hook.loadHistory(1,true)')
        assert await page.evaluate('testApi.hook.messages.length') == 2
        assert await page.evaluate('testApi.hook.messages.at(-1).id') == 2
        # Reload after a crash: the same saved row is now interrupted, not spinning.
        row.update(content='saved before crash', run_status='interrupted')
        row['execution_steps'][0]['status'] = 'interrupted'
        await page.evaluate('localStorage.clear()')
        await page.reload()
        await page.wait_for_function('window.testApi')
        await page.evaluate('testApi.hook.loadHistory(1)')
        await page.get_by_text('任务已中断，已保留最近保存的进度。可以发送消息继续。', exact=True).wait_for()
        assert await page.evaluate('testApi.hook.messages.at(-1).isThinking') is False
        # Summary runs use the same reply identity when disk and stream meet.
        row.update(role='summary', run_status='running')
        await page.evaluate('localStorage.clear()')
        await page.reload()
        await page.wait_for_function('window.testApi')
        await page.evaluate('testApi.hook.loadHistory(1)')
        await page.evaluate('''() => {
          testApi.hook.connectWebSocket(testApi.active.current);
          const ws=WebSocket.instances.at(-1); ws.open();
          ws.receive({protocol:2,type:'sync_state',role:'summary',run_id:'run',sequence:4,
            content:'summary in progress',thought:'',execution_steps:[]});
        }''')
        await page.wait_for_function("testApi.hook.messages.at(-1).content === 'summary in progress'")
        await page.evaluate('testApi.hook.loadHistory(1,true)')
        assert await page.evaluate('testApi.hook.messages.length') == 2
        assert await page.evaluate('testApi.hook.messages.at(-1).role') == 'summary'
        assert not errors, errors
        await browser.close()
        print('Streaming, checkpoint refresh, structured timeline and restart checks passed')


asyncio.run(main())
