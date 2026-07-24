import os
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)
os.environ.pop("all_proxy", None)

import websocket
import json
import time

ws = websocket.WebSocket()
ws.connect("ws://127.0.0.1:8005/api/chat")
ws.send(json.dumps({"conversation_id": 6}))
ws.send("hello pm2 test")

while True:
    try:
        ws.settimeout(5.0)
        res = ws.recv()
        print("RECV:", res)
        if json.loads(res).get("type") == "done":
            break
    except Exception as e:
        print("Exception:", e)
        break

ws.close()
