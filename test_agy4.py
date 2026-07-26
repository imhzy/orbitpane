import asyncio
import os
import time

async def run():
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    process = await asyncio.create_subprocess_exec(
        "agy", "-p", "Please count from 1 to 20 slowly.",
        "--model", "gemini-3.6-flash-medium",
        "--dangerously-skip-permissions",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env
    )
    start = time.time()
    while True:
        chunk = await process.stdout.read(10)
        if not chunk:
            break
        print(f"[{time.time()-start:.2f}s] {chunk}")
    await process.wait()

asyncio.run(run())
