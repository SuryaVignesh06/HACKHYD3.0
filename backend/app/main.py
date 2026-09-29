"""FastAPI entry point: app instance, lifespan (database, memory and LLM clients), CORS and error handlers."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import init_db
from app.routers import context, demo, incidents, memory as memory_router, patterns, projects
from app.services.llm import LLMService
from app.services.memory import MemoryService, MemoryUnavailable

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("oncall")
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    imported = init_db()
    if imported:
        logger.info("Imported %d historical incidents into SQLite", imported)
    memory, llm = MemoryService(), LLMService()
    app.state.memory, app.state.llm = memory, llm
    yield
    await memory.close()
    await llm.close()


app = FastAPI(title="FRIDAY", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(MemoryUnavailable)
async def memory_unavailable(_: Request, exc: MemoryUnavailable) -> JSONResponse:
    return JSONResponse(status_code=503, content={"error": "memory_unavailable", "message": str(exc)})


@app.exception_handler(RequestValidationError)
async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(part) for part in first.get("loc", []) if part != "body")
    return JSONResponse(status_code=422, content={"error": "invalid_request",
                                                  "message": f"{field}: {first.get('msg', 'invalid value')}"})


@app.exception_handler(Exception)
async def unexpected(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error: %s", type(exc).__name__)
    return JSONResponse(status_code=500, content={"error": "internal_error",
                                                  "message": "Something went wrong on the server. Try again."})


app.include_router(incidents.router)
app.include_router(patterns.router)
app.include_router(projects.router)
app.include_router(context.router)
app.include_router(memory_router.router)
app.include_router(demo.router)
