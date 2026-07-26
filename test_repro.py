import sqlite3
import os

DB_PATH = os.path.expanduser("~/agy_web_bridge/history.db")
conn = sqlite3.connect(DB_PATH)
c = conn.cursor()
c.execute("SELECT COUNT(*) FROM messages")
print("Total messages:", c.fetchone()[0])
conn.close()
