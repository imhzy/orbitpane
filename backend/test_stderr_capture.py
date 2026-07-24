import asyncio
import os

async def test():
    class MockManager:
        async def broadcast(self, conv_id, msg):
            print("BROADCAST:", msg)
            
    manager = MockManager()
    
    cmd = ["bash", "-c", "echo 'hello stdout'; echo 'hello stderr' >&2; exit 1"]
    
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    stderr_output = []
    
    async def read_stderr():
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            stderr_output.append(line.decode('utf-8', errors='replace'))
            
    stderr_task = asyncio.create_task(read_stderr())
    
    # Normally read stdout
    while True:
        chunk = await process.stdout.read(512)
        if not chunk:
            break
        print("STDOUT:", chunk.decode())
        
    await process.wait()
    await stderr_task
    
    print("Return code:", process.returncode)
    if process.returncode != 0:
        error_msg = "".join(stderr_output)
        print("ERROR:", error_msg)

asyncio.run(test())
