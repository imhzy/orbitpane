import asyncio

async def test_parse():
    class MockManager:
        async def broadcast(self, conv_id, msg):
            print("BROADCAST:", msg)
            
    manager = MockManager()
    conv_id = 1
    
    raw_text = """这是内容
```diff
diff --git a/test.py b/test.py
--- a/test.py
+++ b/test.py
```
这是结尾"""
    
    response_content = ""
    buffer = raw_text
    
    while buffer:
        lower_buf = buffer.lower()
        t_idx = lower_buf.find("<thought>")
        tk_idx = lower_buf.find("<think>")
        
        possible_partial = False
        for tag in ["<thought>", "<think>"]:
            for i in range(1, len(tag)):
                if lower_buf.endswith(tag[:i]):
                    possible_partial = True
                    break
            if possible_partial:
                break
        
        print("Buffer:", repr(buffer))
        print("Possible partial:", possible_partial)
        if possible_partial:
            break
        else:
            await manager.broadcast(conv_id, {"type": "token", "content": buffer})
            response_content += buffer
            buffer = ""

asyncio.run(test_parse())
