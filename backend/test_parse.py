import asyncio

async def test_parse():
    class MockManager:
        async def broadcast(self, conv_id, msg):
            print("BROADCAST:", msg)
            
    manager = MockManager()
    conv_id = 1
    
    # 模拟从 agy 收到的原始文本
    raw_text = """这是当前工作区中 `test_sub_get_speed.py` 文件的 `git diff` 输出，主要新增了对订阅和轮询两种方式领先时间（以毫秒计算的平均快慢程度）的统计和输出：

```diff
diff --git a/test_sub_get_speed.py b/test_sub_get_speed.py
index a3e66c5..8ff575b 100644
--- a/test_sub_get_speed.py
+++ b/test_sub_get_speed.py
@@ -14,6 +14,8 @@ lock = threading.Lock()
"""
    
    response_content = ""
    response_thought = ""
    in_thought = False
    buffer = ""
    
    # 模拟 512 字节的读取
    chunk_size = 512
    import codecs
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    
    raw_bytes = raw_text.encode('utf-8')
    for i in range(0, len(raw_bytes), chunk_size):
        chunk_bytes = raw_bytes[i:i+chunk_size]
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
                        
                    in_thought = True
                    await manager.broadcast(conv_id, {"type": "thought_start"})
                    
                    buffer = buffer[idx + tag_len:]
                else:
                    possible_partial = False
                    for tag in ["<thought>", "<think>"]:
                        for j in range(1, len(tag)):
                            if lower_buf.endswith(tag[:j]):
                                possible_partial = True
                                break
                        if possible_partial:
                            break
                    
                    if possible_partial:
                        break
                    else:
                        await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                        response_content += buffer
                        buffer = ""
            else:
                pass # 省略 thought 结束逻辑，这里不会进入

    final_chunk = decoder.decode(b'', final=True)
    if final_chunk:
        buffer += final_chunk
    if buffer:
        await manager.broadcast(conv_id, {"type": "token", "content": buffer})

asyncio.run(test_parse())
