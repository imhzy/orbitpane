import os
import pty
import time
import subprocess
import fcntl

def main():
    start_time = time.time()
    
    master, slave = pty.openpty()
    
    clean_env = os.environ.copy()
    clean_env["NO_COLOR"] = "1"
    clean_env["TERM"] = "dumb"
    
    process = subprocess.Popen(
        ["agy", "-p", "tell me a 50 word story", "--model", "Gemini 3.6 Flash (High)"],
        stdout=slave,
        stderr=slave,
        env=clean_env
    )
    os.close(slave)
    
    # Set master to non-blocking
    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    
    while process.poll() is None:
        try:
            chunk = os.read(master, 512)
            if chunk:
                print(f"[{time.time() - start_time:.2f}s] got: {chunk.decode(errors='replace')!r}")
        except BlockingIOError:
            time.sleep(0.1)
            
    # Read remaining
    while True:
        try:
            chunk = os.read(master, 512)
            if not chunk:
                break
            print(f"[{time.time() - start_time:.2f}s] got: {chunk.decode(errors='replace')!r}")
        except BlockingIOError:
            break

main()
