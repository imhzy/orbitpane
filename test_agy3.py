import asyncio
import os

async def run():
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    process = await asyncio.create_subprocess_exec(
        "agy", "-p", "Please write a long thinking process before replying.",
        "--model", "gemini-3.1-pro-high",
        "--dangerously-skip-permissions",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env
    )
    import time
    start = time.time()
    while True:
        chunk = await process.stdout.read(10)
        if not chunk:
            break
        print(f"[{time.time()-start:.2f}s] chunk: {chunk}")
    await process.wait()

asyncio.run(run())
