import asyncio
import time

async def main():
    start_time = time.time()
    process = await asyncio.create_subprocess_exec(
        "agy", "-p", "NEW MESSAGE FROM USER:\\ntell me a long story\\n\\n(Please write your thinking process inside <agy_thought> and </agy_thought> tags before your final response.)", "--model", "Gemini 3.6 Flash (High)",
        stdout=asyncio.subprocess.PIPE
    )
    
    while True:
        chunk = await process.stdout.read(10)
        if not chunk:
            break
        print(f"[{time.time() - start_time:.2f}s] got {len(chunk)} bytes")

asyncio.run(main())
