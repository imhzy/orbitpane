import asyncio
import os
import time
import codecs

async def run():
    class MockManager:
        async def broadcast(self, conv_id, msg):
            print("BROADCAST:", msg)
            
    manager = MockManager()
    conv_id = 1
    
    user_msg = "看看git diff"
    working_dir = "/root/quantitative-trading-system"
    cli_conv_id = "agy-bridge-conv-7"
    cmd = [
        "agy", "-p", user_msg,
        "--conversation", cli_conv_id,
        "--add-dir", working_dir,
        "--dangerously-skip-permissions"
    ]
    clean_env = os.environ.copy()
    for k in list(clean_env.keys()):
        if k.startswith("ANTIGRAVITY_"):
            del clean_env[k]
    
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=clean_env
    )
    
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    buffer = ""
    in_thought = False
    response_content = ""
    response_thought = ""
    
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
                        
                    in_thought = True
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
                        # STUCK POINT?
                        print("STUCK ON PARTIAL:", repr(buffer))
                        break
                    else:
                        await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                        response_content += buffer
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
                        
                    in_thought = False
                    await manager.broadcast(conv_id, {"type": "thought_end"})
                    
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
                        print("STUCK ON THOUGHT PARTIAL:", repr(buffer))
                        break
                    else:
                        await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                        response_thought += buffer
                        buffer = ""
                        
    await process.wait()
    
    if buffer:
        if in_thought:
            await manager.broadcast(conv_id, {"type": "thought", "content": buffer})
            response_thought += buffer
        else:
            await manager.broadcast(conv_id, {"type": "token", "content": buffer})
            response_content += buffer
            
    print("\nCONTENT LEN:", len(response_content))

asyncio.run(run())
