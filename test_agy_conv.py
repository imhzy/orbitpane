import asyncio
import os

async def run():
    cli_conv_id = "test-conv-1"
    
    # 1. First message
    cmd1 = ["agy", "-p", "My secret code is 42", "--conversation", cli_conv_id, "--dangerously-skip-permissions"]
    print("Running:", cmd1)
    p1 = await asyncio.create_subprocess_exec(*cmd1, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out1, err1 = await p1.communicate()
    print("Out1:", out1.decode())
    
    # 2. Second message
    cmd2 = ["agy", "-p", "What is my secret code?", "--conversation", cli_conv_id, "--dangerously-skip-permissions"]
    print("Running:", cmd2)
    p2 = await asyncio.create_subprocess_exec(*cmd2, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out2, err2 = await p2.communicate()
    print("Out2:", out2.decode())

asyncio.run(run())
