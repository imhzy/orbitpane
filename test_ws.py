import asyncio
import websockets
import json

async def test():
    uri = "ws://127.0.0.1:8005/api/chat"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"conversation_id": 6}))
        await ws.send("hello test debug")
        while True:
            try:
                res = await asyncio.wait_for(ws.recv(), timeout=15.0)
                print("RECV:", res)
                if json.loads(res).get("type") == "done":
                    break
            except Exception as e:
                print("Error or timeout:", e)
                break

asyncio.run(test())
