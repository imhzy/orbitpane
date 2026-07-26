import re

with open('/root/agy_web_bridge/backend/main.py', 'r') as f:
    content = f.read()

# Replace agent_msg assignment
new_code = """
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
        if t_text:
            history_text += f"<agy_thought>\\n{t_text}\\n</agy_thought>\\n"
        history_text += f"{c_text}\\n\\n"
        
    history_text += "### END OF HISTORY ###\\n\\n"
    
    agent_msg = history_text + "NEW MESSAGE FROM USER:\\n" + user_msg + "\\n\\n(Please write your thinking process inside <agy_thought> and </agy_thought> tags before your final response.)"
"""

content = re.sub(r'agent_msg\s*=\s*user_msg\s*\+\s*".*?"\n', new_code + "\n", content)

# Replace <think> and <thought> parsing with <agy_thought>
# 309: t_idx = lower_buf.find("<thought>")
# 310: tk_idx = lower_buf.find("<think>")
content = content.replace('t_idx = lower_buf.find("<thought>")', 't_idx = lower_buf.find("<agy_thought>")')
content = content.replace('tk_idx = lower_buf.find("<think>")', 'tk_idx = -1')

# 314: tag_len = 9 if t_idx != -1 else 7
content = content.replace('tag_len = 9 if t_idx != -1 else 7', 'tag_len = 13 if t_idx != -1 else 7')

# 341: t_end_idx = lower_buf.find("</thought>")
# 342: tk_end_idx = lower_buf.find("</think>")
content = content.replace('t_end_idx = lower_buf.find("</thought>")', 't_end_idx = lower_buf.find("</agy_thought>")')
content = content.replace('tk_end_idx = lower_buf.find("</think>")', 'tk_end_idx = -1')

# 346: end_tag_len = 10 if t_end_idx != -1 else 8
content = content.replace('end_tag_len = 10 if t_end_idx != -1 else 8', 'end_tag_len = 14 if t_end_idx != -1 else 8')

with open('/root/agy_web_bridge/backend/main.py', 'w') as f:
    f.write(content)
