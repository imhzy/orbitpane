import asyncio
import os

async def run():
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    process = await asyncio.create_subprocess_exec(
        "agy", "-p", "Please output your thinking process then reply 'hello'",
        "--model", "gemini-3.6-flash-medium",
        "--dangerously-skip-permissions",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env
    )
    while True:
        chunk = await process.stdout.read(10)
        if not chunk:
            break
        print(f"chunk: {chunk}")
    await process.wait()

asyncio.run(run())
