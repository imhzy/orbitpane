import requests
import json
import asyncio
import websockets

async def test():
    # 1. create conv
    res = requests.post('http://127.0.0.1:8005/api/conversations', json={'name':'test', 'path':'/root/agy_web_bridge'})
    conv_id = res.json()['id']
    print(f"Created conv {conv_id}")
    
    # 2. Add some history directly
    import sqlite3
    conn = sqlite3.connect('/root/agy_web_bridge/history.db')
    conn.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'hi')", (conv_id,))
    conn.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'agent', 'hello')", (conv_id,))
    conn.commit()
    conn.close()
    
    # 3. Simulate refresh
    hist = requests.get(f'http://127.0.0.1:8005/api/history/{conv_id}').json()
    print("History loaded:", hist)
    
    # 4. Connect WS and ask a question
    async with websockets.connect('ws://127.0.0.1:8005/api/chat') as ws:
        await ws.send(json.dumps({'conversation_id': conv_id}))
        await ws.send(json.dumps({'content': 'tell me a joke', 'model': 'gemini-3.6-flash-low'}))
        
        while True:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                print("WS received:", msg[:100])
                if '"type": "done"' in msg:
                    break
            except asyncio.TimeoutError:
                break
                
    # 5. Check history again
    hist2 = requests.get(f'http://127.0.0.1:8005/api/history/{conv_id}').json()
    print("Final history length:", len(hist2))
    for m in hist2:
        print(f" - {m['role']}: {m['content'][:30]}")

asyncio.run(test())
