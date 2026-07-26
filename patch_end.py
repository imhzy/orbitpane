with open('/root/agy_web_bridge/backend/main.py', 'r') as f:
    content = f.read()

content = content.replace('t_idx = lower_buf.find("</thought>")', 't_idx = lower_buf.find("</agy_thought>")')
content = content.replace('tk_idx = lower_buf.find("</think>")', 'tk_idx = -1')
content = content.replace('tag_len = 10 if t_idx != -1 else 8', 'tag_len = 14 if t_idx != -1 else 8')

with open('/root/agy_web_bridge/backend/main.py', 'w') as f:
    f.write(content)
