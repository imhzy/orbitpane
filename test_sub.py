import asyncio
import os
import sys

os.environ["http_proxy"] = "http://127.0.0.1:55134"
os.environ["https_proxy"] = "http://127.0.0.1:55134"
os.environ["all_proxy"] = "http://127.0.0.1:55134"

async def main():
    cmd = [
        "agy", "-p", "hello",
        "--conversation", "agy-bridge-conv-test",
        "--add-dir", "/root/agy_web_bridge",
        "--dangerously-skip-permissions",
        "--model", "gemini-3.6-flash-high"
    ]
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await process.communicate()
    print("STDOUT:", stdout.decode())
    print("STDERR:", stderr.decode())
    print("EXIT CODE:", process.returncode)

asyncio.run(main())
