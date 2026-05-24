"""
CodeLab Desktop — Backend Server
=================================
A production-grade FastAPI server for the CodeLab Desktop IDE.

Architecture
------------
  Async event loop (FastAPI/Uvicorn)
    HTTP routes, WebSocket handlers, streaming responses

  ThreadPoolExecutor  (app.state.thread_pool)
    All blocking I/O: git operations, file system, subprocess execution.
    Never block the event loop directly — use run_in_executor.

  TokenBucketRateLimiter  (app.state.run_rate_limiter)
    Thread-safe token-bucket applied to /api/files/run.

  Settings  (app.state.settings)
    Immutable, typed config object read once from .env at startup.

  CollabSessionManager  (app.state.session_manager)
    In-memory collaboration session registry, shared across all WS connections.
"""

import asyncio
import logging
import os
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Callable

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ── .env loading ──────────────────────────────────────────────────────────────
# Works both in development and when bundled by PyInstaller.

if getattr(sys, "frozen", False):
    _BASE_DIR = os.path.dirname(sys.executable)
else:
    _BASE_DIR = os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(_BASE_DIR, ".env"))

# ── Configuration ─────────────────────────────────────────────────────────────
# Read once at import time so CORS middleware (which runs before lifespan)
# can use the same Settings object that gets attached to app.state.

from config import Settings  # noqa: E402

_SETTINGS = Settings.from_env()

# ── Logging ───────────────────────────────────────────────────────────────────

class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = "-"  # type: ignore[attr-defined]
        return True


_handler = logging.StreamHandler(sys.stdout)
_handler.addFilter(_RequestIdFilter())
_handler.setFormatter(
    logging.Formatter(
        fmt="%(asctime)s  %(levelname)-8s  [%(request_id)s]  %(name)s — %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
)

logging.root.setLevel(logging.INFO)
logging.root.handlers = [_handler]
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
logging.getLogger("git").setLevel(logging.WARNING)

logger = logging.getLogger("codelab.server")

# ── Thread pool ───────────────────────────────────────────────────────────────
# Shared across the entire process. All blocking I/O (git, file system,
# subprocess) dispatches here via run_in_executor.

_CPU = os.cpu_count() or 1
_THREAD_POOL = ThreadPoolExecutor(
    max_workers=min(32, _CPU + 8),
    thread_name_prefix="codelab-worker",
)


# ── Rate limiter — token bucket ───────────────────────────────────────────────

class TokenBucketRateLimiter:
    """
    Thread-safe token-bucket rate limiter.

    Tokens refill continuously at rate/per tokens per second up to a
    maximum of `rate`. Each successful .allow() consumes one token.
    The internal lock makes concurrent /run calls safe.
    """

    def __init__(self, rate: int, per: float) -> None:
        self._rate = rate
        self._per = per
        self._tokens = float(rate)
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last
            self._tokens = min(
                float(self._rate),
                self._tokens + elapsed * (self._rate / self._per),
            )
            self._last = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False

    @property
    def rate(self) -> int:
        return self._rate

    @property
    def per(self) -> float:
        return self._per


# ── Lifespan ──────────────────────────────────────────────────────────────────

async def _session_cleanup_loop(manager) -> None:
    """
    Background task: purge collaboration sessions that have no participants.
    Runs every 5 minutes to reclaim memory from sessions whose host closed the
    app without explicitly disconnecting.
    """
    while True:
        await asyncio.sleep(300)
        removed = manager.cleanup_empty()
        if removed:
            logger.info("Session cleanup: removed %d idle session(s)", removed)


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Runs once at startup (before requests) and once at shutdown."""
    from routers.collab import CollabSessionManager  # local import avoids circularity
    from crypto import EncryptionService             # AES-256-GCM
    from tcp_server import TCPStatusServer           # raw TCP diagnostics
    from tcp_collab import TCPCollabServer           # raw TCP collaboration (port 8002)

    t0 = time.monotonic()

    rate_limiter = TokenBucketRateLimiter(
        rate=_SETTINGS.run_rate,
        per=_SETTINGS.run_per,
    )

    # Attach shared resources to app.state so every router can reach them
    # via request.app.state.<name> without importing module-level globals.
    session_manager    = CollabSessionManager()
    cleanup_task       = asyncio.create_task(_session_cleanup_loop(session_manager))
    encryption         = EncryptionService.from_env()
    tcp_server         = TCPStatusServer(port=_SETTINGS.tcp_port)
    tcp_collab_server  = TCPCollabServer(host="127.0.0.1", port=8002)

    application.state.settings         = _SETTINGS
    application.state.thread_pool      = _THREAD_POOL
    application.state.run_rate_limiter = rate_limiter
    application.state.session_manager  = session_manager
    application.state.encryption       = encryption
    application.state.start_time       = datetime.now(timezone.utc)
    application.state.ws_connections   = 0
    application.state.tcp_collab       = tcp_collab_server

    # Start raw TCP status server (skip if tcp_port == 0)
    if _SETTINGS.tcp_port:
        tcp_server.start(application.state)

    # Start raw TCP collaboration server (always on port 8002)
    tcp_collab_server.start()

    cfg = _SETTINGS.status_report()

    logger.info("╔═══════════════════════════════════════════╗")
    logger.info("║       CodeLab Desktop Server v%s         ║", application.version)
    logger.info("╠═══════════════════════════════════════════╣")
    logger.info("║  Python %-10s  PID %-18d ║", sys.version.split()[0], os.getpid())
    logger.info("║  Thread pool: %-27s ║", f"{_THREAD_POOL._max_workers} workers")
    logger.info(
        "║  Run rate limit: %-24s ║",
        f"{_SETTINGS.run_rate} exec / {int(_SETTINGS.run_per)}s",
    )
    for key, val in cfg.items():
        short = val[:30] + "…" if len(val) > 31 else val
        logger.info("║  %-12s  %-27s ║", key + ":", short)
    logger.info("║  Ready in %-31s ║", f"{(time.monotonic() - t0) * 1000:.1f} ms")
    logger.info("╚═══════════════════════════════════════════╝")

    yield  # ← server is live

    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    tcp_collab_server.stop()
    if _SETTINGS.tcp_port:
        tcp_server.stop()
    logger.info("CodeLab Desktop Server shutting down…")
    _THREAD_POOL.shutdown(wait=True, cancel_futures=False)
    logger.info("Thread pool drained. Goodbye.")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="CodeLab Desktop API",
    version="2.0.0",
    description=(
        "Backend for the CodeLab Desktop IDE. "
        "Handles file operations, git, GitHub import/export, "
        "real-time collaboration, and AI assistance."
    ),
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ── CORS ──────────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=_SETTINGS.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request ID + Access Log middleware ────────────────────────────────────────

@app.middleware("http")
async def request_id_and_logging(request: Request, call_next: Callable) -> Response:
    req_id = (request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]).strip()
    request.state.request_id = req_id

    class _Filter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            record.request_id = req_id  # type: ignore[attr-defined]
            return True

    _filter = _Filter()
    for h in logging.root.handlers:
        h.addFilter(_filter)

    t0 = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        duration_ms = (time.perf_counter() - t0) * 1000
        for h in logging.root.handlers:
            h.removeFilter(_filter)
        logger.info(
            "%s %s → %d  (%.1f ms)",
            request.method,
            request.url.path,
            status_code,
            duration_ms,
        )
        if "response" in dir():
            response.headers["X-Request-ID"] = req_id  # type: ignore[possibly-undefined]


# ── Global exception handlers ─────────────────────────────────────────────────

@app.exception_handler(HTTPException)
async def _http_exc(request: Request, exc: HTTPException) -> JSONResponse:
    req_id = getattr(request.state, "request_id", "-")
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": "http_error", "detail": exc.detail, "request_id": req_id},
        headers={"X-Request-ID": req_id},
    )


@app.exception_handler(Exception)
async def _generic_exc(request: Request, exc: Exception) -> JSONResponse:
    req_id = getattr(request.state, "request_id", "-")
    logger.exception(
        "Unhandled exception on %s %s  [req=%s]",
        request.method,
        request.url.path,
        req_id,
    )
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_server_error",
            "detail": "An unexpected error occurred. Check server logs.",
            "request_id": req_id,
        },
        headers={"X-Request-ID": req_id},
    )


# ── Routers ───────────────────────────────────────────────────────────────────

from routers import ai_assist, collab, files, git_ops, github_api  # noqa: E402

app.include_router(files.router,      prefix="/api/files",  tags=["Files"])
app.include_router(git_ops.router,    prefix="/api/git",    tags=["Git"])
app.include_router(github_api.router, prefix="/api/github", tags=["GitHub"])
app.include_router(collab.router,     prefix="/api/collab", tags=["Collaboration"])
app.include_router(ai_assist.router,  prefix="/api/ai",     tags=["AI"])


# ── Health endpoint ───────────────────────────────────────────────────────────

@app.get("/api/", tags=["Health"], summary="Server health and diagnostics")
async def health(request: Request) -> dict:
    """
    Returns server health, uptime, thread pool stats, active WebSocket
    connections, and the status of each configured subsystem.
    """
    state = request.app.state
    up_since: datetime = state.start_time
    uptime_s = (datetime.now(timezone.utc) - up_since).total_seconds()
    pool: ThreadPoolExecutor = state.thread_pool

    try:
        pending = pool._work_queue.qsize()  # type: ignore[attr-defined]
    except Exception:
        pending = -1

    return {
        "status": "ok",
        "service": "CodeLab Desktop API",
        "version": app.version,
        "uptime_seconds": round(uptime_s, 1),
        "up_since": up_since.isoformat(),
        "pid": os.getpid(),
        "thread_pool": {
            "max_workers": pool._max_workers,  # type: ignore[attr-defined]
            "pending_tasks": pending,
        },
        "rate_limiter": {
            "endpoint": "/api/files/run",
            "limit": f"{state.run_rate_limiter.rate} per {int(state.run_rate_limiter.per)}s",
        },
        "websocket_connections": state.ws_connections,
        "config": state.settings.status_report(),
    }


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=_SETTINGS.port,
        reload=False,
        log_level="warning",
        access_log=False,
        lifespan="on",
    )
