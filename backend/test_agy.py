import asyncio
import os
import time
import codecs

async def run():
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
    
    print("Running:", cmd)
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=clean_env
    )
    stdout_out, stderr_out = await process.communicate()
    print("Return code:", process.returncode)
    print("Stdout:", stdout_out.decode('utf-8'))
    print("Stderr:", stderr_out.decode('utf-8'))

asyncio.run(run())
