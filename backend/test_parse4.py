import asyncio
import codecs

async def test_parse():
    class MockManager:
        async def broadcast(self, conv_id, msg):
            print("BROADCAST:", msg)
            
    manager = MockManager()
    conv_id = 1
    
    # Simulate text ending with just `<`
    raw_text = "文字<"
    
    response_content = ""
    in_thought = False
    buffer = ""
    
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    
    chunk_size = 512
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
                        print(f"[{i}] Stuck on partial: {repr(buffer)}")
                        break
                    else:
                        await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                        response_content += buffer
                        buffer = ""
            else:
                break
                
    final_chunk = decoder.decode(b'', final=True)
    if final_chunk:
        buffer += final_chunk
    if buffer:
        print("Final buffer before flush:", repr(buffer))
        # Backend uses: await manager.broadcast(conv_id, {"type": "token", "content": buffer}) if not in_thought
        await manager.broadcast(conv_id, {"type": "token", "content": buffer})
        
    print("\nFINAL:", response_content)

asyncio.run(test_parse())
