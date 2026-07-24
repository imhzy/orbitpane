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

app = FastAPI(root_path="/agy")

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
def list_directory(path: str = "/root"):
    try:
        items = []
        for name in os.listdir(path):
            full_path = os.path.join(path, name)
            is_dir = os.path.isdir(full_path)
            items.append({
                "name": name,
                "path": full_path,
                "is_dir": is_dir
            })
        items.sort(key=lambda x: (not x["is_dir"], x["name"]))
        return {"items": items}
    except Exception as e:
        return {"error": str(e)}

def save_message(conv_id: int, role: str, content: str, thought: str = ""):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO messages (conversation_id, role, content, thought) VALUES (?, ?, ?, ?)", (conv_id, role, content, thought))
    conn.commit()
    conn.close()

@app.websocket("/api/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    config_msg = await websocket.receive_text()
    try:
        config_data = json.loads(config_msg)
        conv_id = config_data.get("conversation_id")
    except:
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

    try:
        while True:
            user_msg = await websocket.receive_text()
            
            save_message(conv_id, "user", user_msg)
            
            import time
            import codecs
            start_time = time.time()
            
            # Signal thinking phase start
            await websocket.send_text(json.dumps({"type": "start", "status": "Thinking..."}))
            
            response_content = ""
            response_thought = ""
            in_thought = False
            buffer = ""
            
            try:
                cli_conv_id = f"agy-bridge-conv-{conv_id}"
                cmd = [
                    "agy", "-p", user_msg,
                    "--conversation", cli_conv_id,
                    "--add-dir", working_dir,
                    "--dangerously-skip-permissions"
                ]
                
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
                
                while True:
                    chunk_bytes = await process.stdout.read(512)
                    if not chunk_bytes:
                        # Flush the decoder
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
                                match_idx = t_idx if t_idx != -1 else tk_idx
                                tag_len = 9 if t_idx != -1 else 7
                                
                                pre_text = buffer[:match_idx]
                                if pre_text:
                                    await websocket.send_text(json.dumps({"type": "token", "content": pre_text}))
                                    response_content += pre_text
                                
                                in_thought = True
                                buffer = buffer[match_idx + tag_len:]
                            else:
                                # Check for partial start tag
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
                                    await websocket.send_text(json.dumps({"type": "token", "content": buffer}))
                                    response_content += buffer
                                    buffer = ""
                        else:
                            t_end = lower_buf.find("</thought>")
                            tk_end = lower_buf.find("</think>")
                            
                            if t_end != -1 or tk_end != -1:
                                end_idx = t_end if t_end != -1 else tk_end
                                tag_len = 10 if t_end != -1 else 8
                                
                                thought_text = buffer[:end_idx]
                                if thought_text:
                                    await websocket.send_text(json.dumps({"type": "thought", "content": thought_text}))
                                    response_thought += thought_text
                                
                                in_thought = False
                                buffer = buffer[end_idx + tag_len:]
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
                                    await websocket.send_text(json.dumps({"type": "thought", "content": buffer}))
                                    response_thought += buffer
                                    buffer = ""
                
                await process.wait()
                
                if buffer:
                    if in_thought:
                        await websocket.send_text(json.dumps({"type": "thought", "content": buffer}))
                        response_thought += buffer
                    else:
                        await websocket.send_text(json.dumps({"type": "token", "content": buffer}))
                        response_content += buffer

                duration = round(time.time() - start_time, 1)
                await websocket.send_text(json.dumps({"type": "done", "duration": duration}))
                save_message(conv_id, "agent", response_content, response_thought)

            except Exception as ex:
                error_msg = str(ex)
                await websocket.send_text(json.dumps({"type": "error", "content": error_msg}))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.send_text(json.dumps({"type": "error", "content": str(e)}))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8005, reload=False)

