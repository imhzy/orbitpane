import sqlite3
import os
import re

DB_PATH = os.path.expanduser("~/agy_web_bridge/history.db")

def format_history(conv_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Get all messages except the last one (which is the current user message being processed)
    c.execute("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conv_id,))
    rows = c.fetchall()
    conn.close()
    
    if not rows:
        return ""
        
    history = "### PREVIOUS CONVERSATION HISTORY ###\n"
    for role, content in rows[:-1]: # Exclude the current message we just saved
        history += f"{role.upper()}: {content}\n\n"
    history += "### END OF HISTORY ###\n\n"
    return history

# Let's check how main.py run_agent_task looks
with open('/root/agy_web_bridge/backend/main.py', 'r') as f:
    content = f.read()

print("Original agent_msg assignment:")
match = re.search(r'agent_msg\s*=\s*user_msg.*', content)
if match:
    print(match.group(0))

