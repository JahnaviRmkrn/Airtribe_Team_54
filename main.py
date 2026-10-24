"""Moup - Team 54, AI Builders Day.

FastAPI backend that mocks Person A's API and serves the frontend.
Run: uvicorn main:app --reload
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def _load_dotenv(path: str = ".env") -> None:
    """Tiny .env loader (KEY=VALUE lines) so we don't need python-dotenv."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

from routers import api, rooms, voice  # noqa: E402  (env must be loaded first)

app = FastAPI(title="Moup API (mock)", version="0.2.0")

app.include_router(api.router, prefix="/api")
app.include_router(voice.router, prefix="/api", tags=["voice"])
app.include_router(rooms.router, prefix="/api", tags=["rooms"])


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse("static/index.html")


@app.get("/m/{token}", include_in_schema=False)
def meetup_room(token: str):
    """Guest room - token is resolved client-side via /api/rooms/{token}."""
    return FileResponse("static/room.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
