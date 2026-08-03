"""Compatibility entry point used by PM2 and local development."""

import os

try:
    from .app.application import create_app
except ImportError:
    from app.application import create_app

app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("ORBITPANE_HOST", "127.0.0.1"),
        port=int(os.getenv("ORBITPANE_PORT", "8005")),
    )
