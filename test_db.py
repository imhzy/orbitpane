import sqlite3
import os

DB_PATH = os.path.expanduser("~/agy_web_bridge/history.db")
conn = sqlite3.connect(DB_PATH)
c = conn.cursor()
c.execute("SELECT conversation_id, role, content FROM messages LIMIT 10")
for row in c.fetchall():
    print(row)
conn.close()
