"""Browser regressions. Run Vite on 127.0.0.1:5179, then run this file.
Requires the Python playwright package and its Chromium browser.
All API and WebSocket traffic is mocked; no real agent tasks are submitted.
"""
import asyncio
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:5179'


def message(i):
    return {'id': i, 'role': 'user' if i % 2 else 'agent',
            'content': f'Message {i} ' + ('long paragraph\n\n' * (1 + i % 5)), 'run_id': f'run-{(i+1)//2}'}


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1200, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        history_calls = []
        fail_history = False
        max_id = 2
        file_failed = True

        async def route_api(route):
            nonlocal fail_history, max_id
            url = urlparse(route.request.url)
            query = parse_qs(url.query)
            if '/history/' in url.path:
                history_calls.append(url.query)
                await asyncio.sleep(0.25)
                if fail_history:
                    await route.fulfill(status=503, json={'detail': 'temporarily unavailable'})
                    return
                after = int(query.get('after_id', ['0'])[0])
                before = int(query.get('before_id', [str(max_id+1)])[0])
                ids = [i for i in range(1, max_id+1) if after < i < before]
                limit = int(query.get('limit', ['60'])[0])
                selected = ids[:limit] if after else ids[-limit:]
                await route.fulfill(json={'items': [message(i) for i in selected], 'has_more': len(ids) > limit, 'first_id': 1})
            elif url.path == '/api/search':
                q = query['q'][0]
                offset = int(query.get('offset', ['0'])[0])
                await asyncio.sleep(0.5 if q == 'old' else 0.05)
                await route.fulfill(json={'items': [{'result_type': 'message', 'conversation_id': 1,
                    'message_id': i+1, 'title': q, 'snippet': f'context {q} context'} for i in range(offset, offset+20)],
                    'has_more': offset == 0})
            elif url.path == '/api/session':
                await route.fulfill(json={'authenticated': True})
            elif url.path == '/api/conversations':
                await route.fulfill(json=[{'id': cid, 'name': f'Browser workspace {cid}', 'path': '/tmp', 'provider': 'fake',
                    'preferred_model': 'test', 'permission_mode': 'workspace', 'is_archived': False, 'is_pinned': False, 'draft': ''} for cid in (1, 2)])
            elif url.path in ('/api/conversations/1', '/api/conversations/2'):
                await route.fulfill(json={'id': int(url.path.rsplit('/', 1)[1]), 'name': 'Browser workspace', 'path': '/tmp', 'provider': 'fake',
                    'preferred_model': 'test', 'permission_mode': 'workspace', 'is_archived': False, 'is_pinned': False,
                    'draft': '', **(route.request.post_data_json or {})})
            elif url.path == '/api/agents':
                await route.fulfill(json={'default_provider': 'fake', 'providers': [{'id': 'fake', 'display_name': 'Test agent',
                    'available': True, 'models': [{'id': 'test', 'display_name': 'Test'}]}]})
            elif url.path == '/api/models':
                await route.fulfill(json={'provider': 'fake', 'models': [{'id': 'test', 'display_name': 'Test'}]})
            elif url.path == '/api/workspace-roots':
                await route.fulfill(json={'roots': ['/tmp'], 'default_root': '/tmp'})
            elif url.path.endswith('/workspace-status'):
                await route.fulfill(json={'is_git': False, 'branch': '', 'files': [], 'counts': {}})
            elif url.path.endswith('/stats'):
                await route.fulfill(json={'message_count': max_id, 'duration': 0, 'input_chars': 0, 'output_chars': 0,
                    'context_chars': 0, 'summary_count': 0, 'context_limit': 10000})
            elif url.path.endswith('/files'):
                await route.fulfill(status=503 if file_failed else 200,
                    json={'detail': 'search unavailable'} if file_failed else {'items': [], 'truncated': True})
            else:
                await route.fulfill(json={'items': []})

        await page.route('**/api/**', route_api)
        await page.add_init_script('''
          class FakeSocket {
            static OPEN = 1; static CONNECTING = 0; static instances = [];
            readyState = 0; sent = [];
            constructor() { FakeSocket.instances.push(this); }
            send(text) { this.sent.push(JSON.parse(text)); }
            close() { this.readyState = 3; }
            open() { this.readyState = 1; this.onopen?.(); }
            receive(data) { this.onmessage?.({data: JSON.stringify(data)}); }
          }
          window.WebSocket = FakeSocket;
        ''')
        await page.goto(BASE + '/tests/browser.html')
        await page.wait_for_function('window.testApi')
        await page.evaluate('''() => {
          localStorage.setItem('orbitpane_history_1', JSON.stringify([{id:1, role:'user', content:'cached first'}]));
          void testApi.hook.loadHistory(1);
          void testApi.hook.loadHistory(1, true);
        }''')
        await page.get_by_text('cached first', exact=True).wait_for()
        assert await page.locator('#history-loading').inner_text() == 'true'
        await page.wait_for_function('testApi.hook.messages.length === 2 && !testApi.hook.isHistoryLoading')
        assert history_calls == ['limit=60&after_id=1'], history_calls
        print('PASS: cache first, request deduplication and incremental cursor')

        max_id = 135
        await page.evaluate('testApi.hook.loadHistory(1, true)')
        assert await page.evaluate('testApi.hook.messages.length') == 135
        assert history_calls[-3:] == ['limit=60&after_id=2', 'limit=60&after_id=62', 'limit=60&after_id=122']
        await page.locator('.chat-messages').evaluate('(el) => el.scrollTop = 1000')
        await page.wait_for_timeout(250)
        top = await page.locator('.chat-messages').evaluate('(el) => el.scrollTop')
        max_id = 136
        await page.evaluate('testApi.hook.loadHistory(1, true)')
        await page.wait_for_timeout(250)
        assert abs(await page.locator('.chat-messages').evaluate('(el) => el.scrollTop') - top) < 10
        fail_history = True
        await page.evaluate('testApi.hook.loadHistory(1, true)')
        assert '历史同步失败' in await page.locator('#history-error').inner_text()
        assert await page.evaluate('testApi.hook.messages.length') == 136
        fail_history = False
        print('PASS: multi-page delta, background refresh preserves scroll, failure retains history')

        await page.evaluate('''() => {
          testApi.active.current = {...testApi.active.current, id:2};
          return testApi.hook.loadHistory(2);
        }''')
        assert await page.evaluate('testApi.hook.messages.filter(m => m.id).length') == 60
        await page.evaluate('testApi.hook.loadOlderHistory()')
        assert await page.evaluate('testApi.hook.messages.filter(m => m.id).length') == 120
        await page.evaluate('testApi.hook.loadOlderHistory()')
        assert not await page.evaluate('testApi.hook.hasOlderHistory')
        print('PASS: initial history page and older pagination')

        await page.evaluate('''() => {
          const pending = [{request_id:'a', content:'same', model:'test', provider:'fake'},
            {request_id:'b', content:'same', model:'test', provider:'fake'}];
          testApi.hook.pendingSendMessagesRef.current.set(2, pending);
          testApi.hook.setMessages(pending.flatMap(p => [{role:'user', content:p.content, request_id:p.request_id, isOptimistic:true},
            {role:'agent', content:'', request_id:p.request_id, isOptimistic:true, isThinking:true}]));
          testApi.hook.connectWebSocket(testApi.active.current);
          WebSocket.instances.at(-1).open();
        }''')
        assert await page.evaluate('testApi.hook.pendingSendMessagesRef.current.get(2).length') == 2
        await page.evaluate('''WebSocket.instances.at(-1).receive({type:'submitted',request_id:'b',task:{run_id:'run-b',prompt:'same',status:'queued',position:1}})''')
        await page.wait_for_function("testApi.hook.messages.some(m => m.request_id === 'b' && m.run_id === 'run-b')")
        assert await page.evaluate('testApi.hook.pendingSendMessagesRef.current.get(2).map(m => m.request_id)') == ['a']
        await page.evaluate("WebSocket.instances.at(-1).receive({type:'error',request_id:'a',code:'invalid_request',content:'Rejected'})")
        await page.wait_for_function('testApi.hook.messages.some(m => m.deliveryFailed)')
        assert await page.evaluate("testApi.hook.messages.filter(m => m.request_id === 'b').length") == 2
        assert await page.evaluate('testApi.hook.pendingSendMessagesRef.current.get(2).length') == 0
        print('PASS: acknowledgement is per request; rejection preserves other messages and failed prompt')

        result = await page.evaluate('''() => {
          const initial = [{role:'user',content:'q',run_id:'r'}, {role:'agent',content:'',thought:'',run_id:'r'}];
          const events = [{type:'start',run_id:'r',sequence:0},
            ...Array.from({length:100}, (_,i) => ({type:i%3 ? 'token':'thought',run_id:'r',sequence:i+1,content:String(i)})),
            {type:'token',run_id:'r',sequence:2,content:'stale'}, {type:'done',run_id:'r',sequence:102}];
          const sequential = events.reduce((m,e) => testApi.applyRealtimeEvent(m,e), initial);
          return JSON.stringify(sequential) === JSON.stringify(testApi.applyRealtimeEvents(initial,events)) && initial[1].content === '';
        }''')
        assert result
        print('PASS: batched stream equals ordered event reduction without mutating input')

        await page.evaluate('(rows) => testApi.hook.setMessages(rows)', [message(i) for i in range(1, 501)])
        await page.wait_for_timeout(300)
        mounted = await page.locator('.message-row').count()
        assert mounted < 60, mounted
        await page.evaluate('testApi.setFocused(300)')
        await page.locator('[data-message-id="300"]').wait_for(state='attached')
        await page.locator('[data-message-id="300"]').evaluate("el => el.scrollIntoView({block:'center'})")
        await page.wait_for_timeout(300)
        assert await page.locator('[data-message-id="300"]').is_visible()
        await page.evaluate('testApi.setAll(true)')
        await page.wait_for_function("document.querySelectorAll('.message-row').length === 500")
        await page.evaluate('testApi.setAll(false)')
        await page.wait_for_function("document.querySelectorAll('.message-row').length < 60")
        print(f'PASS: 500-message virtualization ({mounted} mounted), search target and export expansion')

        await page.evaluate("testApi.setMode('markdown')")
        await page.evaluate("testApi.setContent('Streaming **partial')")
        await page.wait_for_timeout(180)
        assert 'Streaming' in await page.locator('body').inner_text()
        await page.evaluate('''() => {testApi.setContent('Final **complete**\\n\\n| A | B |\\n|---|---|\\n| 1 | 2 |\\n\\n```js\\nconst x = 1\\n```'); testApi.setStreaming(false)}''')
        await page.locator('strong').filter(has_text='complete').wait_for()
        assert await page.locator('table').count() == 1
        assert 'const x = 1' in await page.locator('body').inner_text()
        print('PASS: streamed Markdown updates and final tables/code render')

        await page.evaluate("testApi.setMode('file-error')")
        await page.get_by_role('button', name='重试', exact=True).wait_for()
        assert '没有找到' not in await page.locator('body').inner_text()
        await page.evaluate("testApi.setMode('file-truncated')")
        await page.get_by_text('仅显示部分结果', exact=False).wait_for()
        print('PASS: file search error and truncated states')

        await page.evaluate("testApi.setMode('search')")
        field = page.locator('.cmd-input')
        await field.fill('old')
        await page.wait_for_timeout(220)
        await field.fill('new')
        await page.wait_for_function("document.querySelectorAll('.cmd-conv-name').length === 20 && [...document.querySelectorAll('.cmd-conv-name')].every(el => el.textContent === 'new')")
        await page.wait_for_timeout(600)
        assert await page.locator('.cmd-conv-name').all_text_contents() == ['new'] * 20
        assert await page.locator('.cmd-search-snippet mark').count() == 20
        await page.get_by_role('button', name='加载更多结果').click()
        await page.wait_for_function("document.querySelectorAll('.cmd-search-snippet').length === 40")
        assert await page.get_by_role('button', name='加载更多结果').count() == 0
        print('PASS: stale search discarded, matched excerpt highlighted, second page reachable')
        # Exercise the actual App, including its scroll effects and composer.
        await page.goto(BASE + '/?id=1')
        await page.locator('.input-textarea').wait_for()
        await page.wait_for_function('WebSocket.instances.length > 0')
        await page.evaluate("() => {const socket=WebSocket.instances.at(-1); socket.open(); socket.receive({type:'ready'})}")
        try:
            await page.wait_for_function("document.querySelectorAll('.virtual-message').length >= 60", timeout=10000)
        except Exception:
            print('APP DIAGNOSTIC', await page.locator('body').inner_text(), errors, history_calls)
            raise
        await page.wait_for_timeout(400)
        viewport = page.locator('.chat-messages')
        await viewport.hover()
        await page.mouse.wheel(0, -1400)
        await page.wait_for_timeout(400)
        reading_top = await viewport.evaluate('el => el.scrollTop')
        max_id = 138
        await page.evaluate("WebSocket.instances.at(-1).receive({type:'done',run_id:'run-69',user_content:'Message 137',content:'Message 138',sequence:1,status:'completed'})")
        await page.wait_for_timeout(700)
        assert abs(await viewport.evaluate('el => el.scrollTop') - reading_top) < 20
        print('PASS: actual App preserves reading position when a task completes')

        await page.keyboard.press('Control+k')
        await page.locator('.cmd-input').fill('needle')
        await page.locator('.cmd-search-snippet').first.wait_for()
        await page.locator('.cmd-search-snippet').first.click()
        await page.locator('[data-message-id="1"]').wait_for(state='visible')
        await page.wait_for_timeout(400)
        await viewport.hover()
        await page.mouse.wheel(0, 900)
        await page.wait_for_timeout(400)
        search_reading_top = await viewport.evaluate('el => el.scrollTop')
        max_id = 140
        await page.evaluate("WebSocket.instances.at(-1).receive({type:'done',run_id:'run-70',user_content:'Message 139',content:'Message 140',sequence:1,status:'completed'})")
        await page.wait_for_timeout(600)
        assert abs(await viewport.evaluate('el => el.scrollTop') - search_reading_top) < 20
        print('PASS: search loads an older page; later messages do not repeat the jump')

        anchor = await viewport.evaluate("""el => {
          const top=el.getBoundingClientRect().top;
          const row=[...el.querySelectorAll('[data-virtual-message-id]')].find(row => row.getBoundingClientRect().bottom > top);
          return {id:row.dataset.virtualMessageId,offset:row.getBoundingClientRect().top-top};
        }""")
        await page.evaluate("() => {history.pushState({},'', '/?id=2'); dispatchEvent(new PopStateEvent('popstate'))}")
        await page.wait_for_timeout(500)
        await page.evaluate('history.back()')
        # Returning can require several history pages and virtual-row layout.
        # Wait for the visible outcome, not a machine-dependent fixed delay.
        await page.wait_for_function("""anchor => {
          const viewport = document.querySelector('.chat-messages');
          const row = viewport?.querySelector(`[data-virtual-message-id="${anchor.id}"]`);
          return row && Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset) < 20;
        }""", arg=anchor, timeout=10000)
        restored_offset = await viewport.evaluate("""(el,id) => {
          const row=el.querySelector(`[data-virtual-message-id="${id}"]`);
          return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
        }""", anchor['id'])
        assert restored_offset is not None and abs(restored_offset-anchor['offset']) < 20, (anchor, restored_offset)
        print('PASS: project switch restores the same message and offset across paginated history')

        textarea = page.locator('.input-textarea')
        await textarea.fill('multiline input\n' * 60)
        first_height = await textarea.evaluate('el => el.getBoundingClientRect().height')
        await page.wait_for_timeout(100)
        assert first_height == await textarea.evaluate('el => el.getBoundingClientRect().height')
        assert first_height <= 400
        await textarea.fill('@missing')
        await page.get_by_text('文件搜索失败', exact=False).wait_for()
        assert await page.get_by_text('没有找到“missing”').count() == 0
        file_failed = False
        await page.get_by_role('button', name='重试', exact=True).click()
        await page.get_by_text('仅显示部分结果', exact=False).wait_for()
        print('PASS: actual composer height stays stable; file retry reveals truncated results')
        assert not errors, errors
        await browser.close()
        print('All browser regressions passed')


asyncio.run(main())
