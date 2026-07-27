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
    try:
        c.execute("ALTER TABLE messages ADD COLUMN model TEXT")
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
    c.execute("SELECT role, content, thought, timestamp, model FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conv_id,))
    rows = c.fetchall()
    conn.close()
    return [{"role": r[0], "content": r[1], "thought": r[2] if r[2] else "", "timestamp": r[3], "model": r[4] if len(r) > 4 and r[4] else ""} for r in rows]

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

def save_message(conv_id: int, role: str, content: str, thought: str = "", model: str = ""):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO messages (conversation_id, role, content, thought, model) VALUES (?, ?, ?, ?, ?)", (conv_id, role, content, thought, model))
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

async def tail_transcript(conv_id: int, log_path: str):
    import json
    import os
    import asyncio
    import time as _time
    
    debug_log = open("/tmp/tail_debug.log", "a")
    def dbg(msg):
        debug_log.write(f"[{_time.strftime('%H:%M:%S')}] conv={conv_id} {msg}\n")
        debug_log.flush()
    
    dbg(f"START tail_transcript, log_path={log_path}")
    
    # Wait for glog file (up to 10s)
    for _ in range(100):
        if os.path.exists(log_path):
            break
        await asyncio.sleep(0.1)
        
    if not os.path.exists(log_path):
        dbg("ABORT: glog file never appeared")
        debug_log.close()
        return
    
    dbg(f"glog file found: {log_path}")
        
    # Extract UUID from glog - time-based loop, not iteration-based
    uuid = None
    deadline = _time.time() + 30  # 30 second deadline
    with open(log_path, 'r') as f:
        while _time.time() < deadline:
            line = f.readline()
            if not line:
                await asyncio.sleep(0.2)
                continue
            if "Streaming conversation " in line:
                uuid = line.split("Streaming conversation ")[1].strip()
                dbg(f"Found UUID: {uuid}")
                break
                
    if not uuid:
        dbg("ABORT: UUID not found within deadline")
        debug_log.close()
        return
        
    transcript_path = f"/root/.gemini/antigravity-cli/brain/{uuid}/.system_generated/logs/transcript.jsonl"
    dbg(f"transcript_path={transcript_path}")
    
    # Wait for transcript file (up to 10s)
    for _ in range(100):
        if os.path.exists(transcript_path):
            break
        await asyncio.sleep(0.1)
        
    if not os.path.exists(transcript_path):
        dbg("ABORT: transcript.jsonl never appeared")
        debug_log.close()
        return
    
    dbg("transcript.jsonl found, spawning tail -f")
    
    process = await asyncio.create_subprocess_exec(
        "tail", "-n", "+1", "-f", transcript_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL
    )
    
    dbg("tail -f spawned, reading lines...")
    lines_read = 0
    thoughts_sent = 0
    
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                dbg(f"tail EOF after {lines_read} lines, {thoughts_sent} thoughts sent")
                break
            
            lines_read += 1
            
            try:
                data = json.loads(line)
                step_type = data.get("type")
                dbg(f"line {lines_read}: type={step_type}")
                
                if step_type in ["PLANNER_RESPONSE", "TOOL_RESPONSE", "BASH_COMMAND", "ACTION", "ERROR"]:
                    formatted_text = ""
                    
                    if step_type == "PLANNER_RESPONSE":
                        thought = data.get("thinking", "")
                        tool_calls = data.get("tool_calls", [])
                        
                        for tc in tool_calls:
                            tool_name = tc.get("name", "")
                            args = tc.get("args", {})
                            args_str = ", ".join([f"{k}={v}" for k, v in args.items()])
                            if len(args_str) > 50:
                                args_str = args_str[:47] + "..."
                            formatted_text += f"\n\n● **{tool_name}**({args_str})\n"
                            
                        if thought:
                            lines_list = thought.strip().split('\n')
                            first_line = lines_list[0] if lines_list else ""
                            formatted_text += f"▸ *Thought*: {first_line}\n"
                    
                    if formatted_text:
                        thoughts_sent += 1
                        dbg(f"BROADCASTING thought #{thoughts_sent}: {formatted_text[:80]}...")
                        await manager.broadcast(conv_id, {"type": "thought", "content": formatted_text})
            except json.JSONDecodeError as e:
                dbg(f"JSON parse error on line {lines_read}: {e}")
            except Exception as e:
                dbg(f"Error on line {lines_read}: {e}")
    except asyncio.CancelledError:
        dbg(f"CANCELLED after {lines_read} lines, {thoughts_sent} thoughts sent")
    finally:
        dbg(f"CLEANUP: {lines_read} lines read, {thoughts_sent} thoughts broadcast")
        debug_log.close()
        try:
            process.terminate()
        except Exception:
            pass

async def run_agent_task(conv_id: int, user_msg: str, working_dir: str, model: str = "gemini-3.6-flash-medium"):
    import time
    import codecs
    start_time = time.time()
    
    manager.task_state[conv_id] = {
        "start_time": start_time,
        "content": "",
        "thought": "",
        "in_thought": False,
        "interrupted": False,
        "model": model
    }

    await manager.broadcast(conv_id, {"type": "start", "status": "Thinking...", "elapsed": 0, "model": model})
    
    response_content = ""
    response_thought = ""
    in_thought = False
    buffer = ""
    
    
    # Fetch history
    import sqlite3
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT role, content, thought FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conv_id,))
    rows = c.fetchall()
    conn.close()
    
    history_text = "Here is the conversation history so far:\\n"
    for r, c_text, t_text in rows[:-1]: # Exclude the user message just saved
        history_text += f"{r.upper()}:\\n"
        history_text += f"{c_text}\\n\\n"
        
    history_text += "### END OF HISTORY ###\\n\\n"
    
    agent_msg = history_text + "NEW MESSAGE FROM USER:\\n" + user_msg

    
    try:
        cli_conv_id = f"agy-bridge-conv-{conv_id}"
        log_path = f"/tmp/agy-bridge-conv-{conv_id}.log"
        if os.path.exists(log_path):
            try:
                os.remove(log_path)
            except:
                pass
                
        cmd = [
            "agy", "-p", agent_msg,
            "--conversation", cli_conv_id,
            "--add-dir", working_dir,
            "--model", model,
            "--dangerously-skip-permissions",
            "--print-timeout", "24h",
            "--log-file", log_path
        ]
        
        # Clean up stale ANTIGRAVITY_* env vars inherited from PM2 start
        clean_env = os.environ.copy()
        for k in list(clean_env.keys()):
            if k.startswith("ANTIGRAVITY_"):
                del clean_env[k]
        
        clean_env["PYTHONUNBUFFERED"] = "1"
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=clean_env
        )
        
        if conv_id in manager.task_state:
            manager.task_state[conv_id]["process"] = process
        
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
        transcript_task = asyncio.create_task(tail_transcript(conv_id, log_path))
        
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
                await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                response_content += buffer
                if conv_id in manager.task_state:
                    manager.task_state[conv_id]["content"] = response_content
                buffer = ""
        
        await process.wait()
        await stderr_task
        if not transcript_task.done():
            transcript_task.cancel()
        
        is_interrupted = manager.task_state.get(conv_id, {}).get("interrupted", False)
        
        if buffer:
            if in_thought:
                await manager.broadcast(conv_id, {"type": "thought", "content": buffer})
                response_thought += buffer
            else:
                await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                response_content += buffer

        if is_interrupted:
            msg = "\n\n*[Generation interrupted by user]*"
            await manager.broadcast(conv_id, {"type": "token", "content": msg})
            response_content += msg
        elif process.returncode != 0 and process.returncode != -9 and process.returncode != -15:
            error_msg = f"Process exited with code {process.returncode}.\nStderr: " + "".join(stderr_output)
            if not response_content:
                response_content = error_msg
            else:
                response_content += "\n\n" + error_msg
            await manager.broadcast(conv_id, {"type": "error", "content": error_msg})
            # Also send as token so it appears in the chat log properly
            await manager.broadcast(conv_id, {"type": "token", "content": f"\n\n**Error:**\n```\n{error_msg}\n```"})

        duration = round(time.time() - start_time, 1)
        await manager.broadcast(conv_id, {"type": "done", "duration": duration})
        save_message(conv_id, "agent", response_content, response_thought, model)

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
                "elapsed": elapsed,
                "model": state.get("model", "")
            }))

    try:
        while True:
            raw_msg = await websocket.receive_text()
            
            try:
                msg_data = json.loads(raw_msg)
                action = msg_data.get("action")
                if action == "interrupt":
                    if conv_id in manager.task_state:
                        process = manager.task_state[conv_id].get("process")
                        if process:
                            manager.task_state[conv_id]["interrupted"] = True
                            try:
                                process.kill()
                            except:
                                pass
                    continue
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

