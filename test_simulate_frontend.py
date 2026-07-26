import asyncio
import websockets
import json
import requests
import time

async def simulate():
    # 1. create conv
    res = requests.post('http://127.0.0.1:8005/api/conversations', json={'name':'test', 'path':'/root/agy_web_bridge'}, proxies={"http": None, "https": None})
    conv_id = res.json()['id']
    print(f"Created conv {conv_id}")
    
    async with websockets.connect('ws://127.0.0.1:8005/api/chat') as ws:
        await ws.send(json.dumps({'conversation_id': conv_id}))
        await ws.send(json.dumps({'content': 'My favorite color is blue.', 'model': 'gemini-3.6-flash-medium'}))
        
        while True:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=20.0)
                data = json.loads(msg)
                if data.get('type') == 'token':
                    print(data['content'], end='', flush=True)
                if data.get('type') == 'done':
                    print()
                    break
            except asyncio.TimeoutError:
                break
                
    # 2. Reconnect and ask a second question referencing the first
    async with websockets.connect('ws://127.0.0.1:8005/api/chat') as ws:
        await ws.send(json.dumps({'conversation_id': conv_id}))
        await ws.send(json.dumps({'content': 'What is my favorite color?', 'model': 'gemini-3.6-flash-medium'}))
        
        while True:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=20.0)
                data = json.loads(msg)
                if data.get('type') == 'token':
                    print(data['content'], end='', flush=True)
                if data.get('type') == 'done':
                    print()
                    break
            except asyncio.TimeoutError:
                break
                
asyncio.run(simulate())
