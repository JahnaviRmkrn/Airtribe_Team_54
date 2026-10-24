"""Organizer app - Team 54, AI Builders Day.

FastAPI backend that mocks Person A's API and serves the frontend.
Run: uvicorn main:app --reload
"""

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from routers import api

app = FastAPI(title="Organizer App API (mock)", version="0.1.0")

app.include_router(api.router, prefix="/api")


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
