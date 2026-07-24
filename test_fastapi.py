import asyncio
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

with client.websocket_connect("/api/chat") as websocket:
    websocket.send_json({"conversation_id": 6})
    websocket.send_text("hello testing 123")
    while True:
        try:
            data = websocket.receive_json()
            print("RECV:", data)
            if data.get("type") == "done":
                break
        except Exception as e:
            print("Error:", e)
            break
