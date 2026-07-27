import asyncio
import os
import time

async def main():
    start_time = time.time()
    
    master, slave = os.openpty()
    
    clean_env = os.environ.copy()
    clean_env["NO_COLOR"] = "1"
    clean_env["TERM"] = "dumb"
    
    process = await asyncio.create_subprocess_exec(
        "agy", "-p", "tell me a 50 word story", "--model", "Gemini 3.6 Flash (High)",
        stdout=slave,
        stderr=slave,
        env=clean_env
    )
    os.close(slave)
    
    # Read from master
    reader, _ = await asyncio.open_unix_connection(fileno=master)
    
    while True:
        try:
            chunk = await asyncio.wait_for(reader.read(512), timeout=1.0)
            if not chunk:
                break
            print(f"[{time.time() - start_time:.2f}s] got: {chunk.decode(errors='replace')}")
        except asyncio.TimeoutError:
            if process.returncode is not None:
                break
        except Exception as e:
            print("Error", e)
            break

asyncio.run(main())
