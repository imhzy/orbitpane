import asyncio
import websockets
import json
import sqlite3
import requests

async def test():
    # Fetch history
    history = requests.get('http://127.0.0.1:8005/api/history/10').json()
    print("History length:", len(history))
    
    async with websockets.connect('ws://127.0.0.1:8005/api/chat') as ws:
        await ws.send(json.dumps({"conversation_id": 10}))
        
        await ws.send(json.dumps({"content": "Hello", "model": "gemini-3.6-flash-medium"}))
        
        # Read a few messages
        for i in range(5):
            msg = await ws.recv()
            print(msg)

asyncio.run(test())
