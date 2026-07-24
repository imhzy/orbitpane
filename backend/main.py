import os
import asyncio
import sqlite3
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any

# Set up proxies for Antigravity SDK
os.environ["http_proxy"] = "http://127.0.0.1:55134"
os.environ["https_proxy"] = "http://127.0.0.1:55134"
os.environ["all_proxy"] = "http://127.0.0.1:55134"

from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

app = FastAPI()

@app.get("/api/models")
def get_models():
    # Return static list of models to avoid subprocess hangs within PM2 environment
    models = [
        "gemini-3.6-flash-high",
        "gemini-3.6-flash-medium",
        "gemini-3.6-flash-low",
        "gemini-3.5-flash-high",
        "gemini-3.5-flash-medium",
        "gemini-3.5-flash-low",
        "gemini-3.1-pro-high",
        "gemini-3.1-pro-low",
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
        "gpt-oss-120b-medium"
    ]
    return {"models": models}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = os.path.expanduser("~/agy_web_bridge/history.db")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT,
            content TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            conversation_id INTEGER,
            thought TEXT
        )
    ''')
    try:
        c.execute("ALTER TABLE messages ADD COLUMN conversation_id INTEGER")
    except:
        pass
    try:
        c.execute("ALTER TABLE messages ADD COLUMN thought TEXT")
    except:
        pass
    conn.commit()
    conn.close()

init_db()

class ConversationCreate(BaseModel):
    name: str
    path: str

class ConversationUpdate(BaseModel):
    name: str | None = None
    path: str | None = None

class LoginRequest(BaseModel):
    pin: str

@app.post("/api/login")
def login(req: LoginRequest):
    from fastapi import HTTPException
    expected_pin = os.environ.get("AGY_PIN", "0524")
    if req.pin == expected_pin:
        return {"success": True, "token": "agy-auth-token-123"}
    raise HTTPException(status_code=401, detail="Invalid PIN")

@app.get("/api/conversations")
def get_conversations():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, name, path, created_at FROM conversations ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    return [{"id": r[0], "name": r[1], "path": r[2], "created_at": r[3]} for r in rows]

@app.post("/api/conversations")
def create_conversation(conv: ConversationCreate):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO conversations (name, path) VALUES (?, ?)", (conv.name, conv.path))
    conv_id = c.lastrowid
    conn.commit()
    conn.close()
    return {"id": conv_id, "name": conv.name, "path": conv.path}

@app.put("/api/conversations/{conv_id}")
def update_conversation(conv_id: int, conv: ConversationUpdate):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    if conv.name is not None and conv.path is not None:
        c.execute("UPDATE conversations SET name = ?, path = ? WHERE id = ?", (conv.name, conv.path, conv_id))
    elif conv.name is not None:
        c.execute("UPDATE conversations SET name = ? WHERE id = ?", (conv.name, conv_id))
    elif conv.path is not None:
        c.execute("UPDATE conversations SET path = ? WHERE id = ?", (conv.path, conv_id))
    conn.commit()
    conn.close()
    return {"status": "ok", "id": conv_id}

@app.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    c.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
    conn.commit()
    conn.close()
    return {"status": "ok"}

@app.get("/api/history/{conv_id}")
def get_history(conv_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT role, content, thought, timestamp FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conv_id,))
    rows = c.fetchall()
    conn.close()
    return [{"role": r[0], "content": r[1], "thought": r[2] if r[2] else "", "timestamp": r[3]} for r in rows]

@app.delete("/api/history/{conv_id}")
def clear_history(conv_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
    conn.commit()
    conn.close()
    return {"status": "ok"}

@app.get("/api/ls")
def list_directory(path: str = "/root", show_hidden: bool = False):
    try:
        if not os.path.exists(path):
            return {"error": "Path does not exist", "items": []}
        
        items = []
        for name in os.listdir(path):
            if not show_hidden and name.startswith(".") and name not in [".antigravity", ".cursor"]:
                continue
            full_path = os.path.join(path, name)
            is_dir = os.path.isdir(full_path)
            size = 0
            mtime = 0
            try:
                st = os.stat(full_path)
                size = st.st_size
                mtime = int(st.st_mtime)
            except:
                pass
            
            items.append({
                "name": name,
                "path": full_path,
                "is_dir": is_dir,
                "size": size,
                "mtime": mtime
            })
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        return {"items": items, "current_path": os.path.abspath(path)}
    except Exception as e:
        return {"error": str(e), "items": []}

def save_message(conv_id: int, role: str, content: str, thought: str = ""):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO messages (conversation_id, role, content, thought) VALUES (?, ?, ?, ?)", (conv_id, role, content, thought))
    conn.commit()
    conn.close()

class ConversationManager:
    def __init__(self):
        self.active_connections: Dict[int, List[WebSocket]] = {}
        self.running_tasks: Dict[int, asyncio.Task] = {}
        self.task_state: Dict[int, Dict[str, Any]] = {}

    async def connect(self, websocket: WebSocket, conv_id: int):
        await websocket.accept()
        if conv_id not in self.active_connections:
            self.active_connections[conv_id] = []
        self.active_connections[conv_id].append(websocket)

    def disconnect(self, websocket: WebSocket, conv_id: int):
        if conv_id in self.active_connections:
            if websocket in self.active_connections[conv_id]:
                self.active_connections[conv_id].remove(websocket)
            if not self.active_connections[conv_id]:
                del self.active_connections[conv_id]

    async def broadcast(self, conv_id: int, message: dict):
        if conv_id in self.active_connections:
            dead_sockets = []
            for ws in self.active_connections[conv_id]:
                try:
                    await ws.send_text(json.dumps(message))
                except Exception:
                    dead_sockets.append(ws)
            for ws in dead_sockets:
                self.disconnect(ws, conv_id)

manager = ConversationManager()

async def run_agent_task(conv_id: int, user_msg: str, working_dir: str, model: str = "gemini-3.6-flash-medium"):
    import time
    import codecs
    start_time = time.time()
    
    manager.task_state[conv_id] = {
        "start_time": start_time,
        "content": "",
        "thought": "",
        "in_thought": False
    }

    await manager.broadcast(conv_id, {"type": "start", "status": "Thinking...", "elapsed": 0})
    
    response_content = ""
    response_thought = ""
    in_thought = False
    buffer = ""
    
    agent_msg = user_msg + "\n\n(Please write your thinking process inside <think> and </think> tags before your final response.)"
    
    try:
        cli_conv_id = f"agy-bridge-conv-{conv_id}"
        cmd = [
            "agy", "-p", agent_msg,
            "--conversation", cli_conv_id,
            "--add-dir", working_dir,
            "--model", model,
            "--dangerously-skip-permissions",
            "--print-timeout", "24h"
        ]
        
        # Clean up stale ANTIGRAVITY_* env vars inherited from PM2 start
        clean_env = os.environ.copy()
        for k in list(clean_env.keys()):
            if k.startswith("ANTIGRAVITY_"):
                del clean_env[k]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=clean_env
        )
        
        stderr_output = []
        async def read_stderr():
            while True:
                try:
                    line = await process.stderr.readline()
                    if not line:
                        break
                    stderr_output.append(line.decode('utf-8', errors='replace'))
                except Exception:
                    break
                    
        stderr_task = asyncio.create_task(read_stderr())
        
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        
        while True:
            chunk_bytes = await process.stdout.read(512)
            if not chunk_bytes:
                final_chunk = decoder.decode(b'', final=True)
                if final_chunk:
                    buffer += final_chunk
                break
            
            chunk = decoder.decode(chunk_bytes, final=False)
            buffer += chunk
            
            while buffer:
                lower_buf = buffer.lower()
                if not in_thought:
                    t_idx = lower_buf.find("<thought>")
                    tk_idx = lower_buf.find("<think>")
                    
                    if t_idx != -1 or tk_idx != -1:
                        idx = t_idx if t_idx != -1 else tk_idx
                        tag_len = 9 if t_idx != -1 else 7
                        
                        pre_text = buffer[:idx]
                        if pre_text:
                            await manager.broadcast(conv_id, {"type": "token", "content": pre_text})
                            response_content += pre_text
                            if conv_id in manager.task_state:
                                manager.task_state[conv_id]["content"] = response_content
                            
                        in_thought = True
                        if conv_id in manager.task_state:
                            manager.task_state[conv_id]["in_thought"] = True
                        await manager.broadcast(conv_id, {"type": "thought_start"})
                        
                        buffer = buffer[idx + tag_len:]
                    else:
                        possible_partial = False
                        for tag in ["<thought>", "<think>"]:
                            for i in range(1, len(tag)):
                                if lower_buf.endswith(tag[:i]):
                                    possible_partial = True
                                    break
                            if possible_partial:
                                break
                        
                        if possible_partial:
                            break
                        else:
                            await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                            response_content += buffer
                            if conv_id in manager.task_state:
                                manager.task_state[conv_id]["content"] = response_content
                            buffer = ""
                else:
                    t_idx = lower_buf.find("</thought>")
                    tk_idx = lower_buf.find("</think>")
                    
                    if t_idx != -1 or tk_idx != -1:
                        idx = t_idx if t_idx != -1 else tk_idx
                        tag_len = 10 if t_idx != -1 else 8
                        
                        thought_text = buffer[:idx]
                        if thought_text:
                            await manager.broadcast(conv_id, {"type": "thought", "content": thought_text})
                            response_thought += thought_text
                            if conv_id in manager.task_state:
                                manager.task_state[conv_id]["thought"] = response_thought
                            
                        in_thought = False
                        if conv_id in manager.task_state:
                            manager.task_state[conv_id]["in_thought"] = False
                        await manager.broadcast(conv_id, {"type": "thought_done"})
                        
                        buffer = buffer[idx + tag_len:]
                    else:
                        possible_partial = False
                        for tag in ["</thought>", "</think>"]:
                            for i in range(1, len(tag)):
                                if lower_buf.endswith(tag[:i]):
                                    possible_partial = True
                                    break
                            if possible_partial:
                                break
                        
                        if possible_partial:
                            break
                        else:
                            await manager.broadcast(conv_id, {"type": "thought", "content": buffer})
                            response_thought += buffer
                            if conv_id in manager.task_state:
                                manager.task_state[conv_id]["thought"] = response_thought
                            buffer = ""
        
        await process.wait()
        await stderr_task
        
        if buffer:
            if in_thought:
                await manager.broadcast(conv_id, {"type": "thought", "content": buffer})
                response_thought += buffer
            else:
                await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                response_content += buffer

        if process.returncode != 0:
            error_msg = f"Process exited with code {process.returncode}.\nStderr: " + "".join(stderr_output)
            if not response_content:
                response_content = error_msg
            else:
                response_content += "\n\n" + error_msg
            await manager.broadcast(conv_id, {"type": "token", "content": f"\n\n**Error:**\n```\n{error_msg}\n```"})

        duration = round(time.time() - start_time, 1)
        await manager.broadcast(conv_id, {"type": "done", "duration": duration})
        save_message(conv_id, "agent", response_content, response_thought)

    except Exception as ex:
        error_msg = str(ex)
        await manager.broadcast(conv_id, {"type": "error", "content": error_msg})
    finally:
        if conv_id in manager.running_tasks:
            del manager.running_tasks[conv_id]

@app.websocket("/api/chat")
async def websocket_endpoint(websocket: WebSocket):
    # Wait for the config message before accepting properly in manager, or accept here and wait.
    await websocket.accept()
    
    try:
        config_msg = await websocket.receive_text()
        config_data = json.loads(config_msg)
        conv_id = config_data.get("conversation_id")
    except Exception:
        await websocket.close()
        return

    # Fetch path for this conversation
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT path FROM conversations WHERE id = ?", (conv_id,))
    row = c.fetchone()
    conn.close()

    if not row:
        await websocket.send_text(json.dumps({"type": "error", "content": "Conversation not found"}))
        await websocket.close()
        return

    working_dir = row[0]
    
    # Register with manager (we already accepted, so manager.connect shouldn't accept again, let's adjust manager.connect or do it manually)
    if conv_id not in manager.active_connections:
        manager.active_connections[conv_id] = []
    manager.active_connections[conv_id].append(websocket)

    # Sync state if agent is currently running
    if conv_id in manager.running_tasks and not manager.running_tasks[conv_id].done():
        state = manager.task_state.get(conv_id)
        if state:
            import time
            elapsed = round(time.time() - state["start_time"], 1)
            await websocket.send_text(json.dumps({
                "type": "sync_state",
                "content": state["content"],
                "thought": state["thought"],
                "in_thought": state["in_thought"],
                "elapsed": elapsed
            }))

    try:
        while True:
            raw_msg = await websocket.receive_text()
            
            try:
                msg_data = json.loads(raw_msg)
                user_msg = msg_data.get("content", "")
                model = msg_data.get("model", "gemini-3.6-flash-medium")
            except:
                user_msg = raw_msg
                model = "gemini-3.6-flash-medium"
            
            save_message(conv_id, "user", user_msg)
            
            # Start background task if not already running
            if conv_id not in manager.running_tasks or manager.running_tasks[conv_id].done():
                task = asyncio.create_task(run_agent_task(conv_id, user_msg, working_dir, model))
                manager.running_tasks[conv_id] = task
            else:
                await websocket.send_text(json.dumps({"type": "error", "content": "Agent is already thinking. Please wait."}))

    except WebSocketDisconnect:
        manager.disconnect(websocket, conv_id)
    except Exception as e:
        manager.disconnect(websocket, conv_id)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8005, reload=False)

