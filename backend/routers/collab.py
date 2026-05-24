"""
Collaboration router — HTTP metadata endpoints only.

Architecture
------------
Real-time collaboration is handled by TCPCollabServer (port 8002, tcp_collab.py).
This module only provides:
  POST /api/collab/session        — (legacy, unused by frontend)
  GET  /api/collab/session/{code} — session metadata lookup

CollabSessionManager is kept because the server lifespan uses it for the
periodic cleanup task.  The TCP server manages its own session registry.

Sessions live only in memory — ephemeral by design for a local desktop IDE.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("codelab.collab")

_MAX_PARTICIPANTS = 20


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── CollabSessionManager ──────────────────────────────────────────────────────

class CollabSessionManager:
    """
    In-memory registry of active collaboration sessions.

    A session is a dict:
        {
            "code":         str,            # 6-char invite code
            "created_at":   str,            # ISO timestamp
            "participants": dict,           # key → display name
            "file_state":   dict[str, str], # path → content snapshot
        }

    The manager is the single owner of all session state.  Routers receive
    it via Depends() so it can be replaced with a stub in tests.
    """

    MAX_PARTICIPANTS = _MAX_PARTICIPANTS

    def __init__(self) -> None:
        self._sessions: dict[str, dict] = {}

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def create(self) -> dict:
        """Create a new session and return it."""
        code = self._unique_code()
        session = {
            "code":         code,
            "created_at":   _now_iso(),
            "participants": {},
            "file_state":   {},
            "root_path":    "",
        }
        self._sessions[code] = session
        logger.info("Collaboration session created: %s", code)
        return session

    def get(self, code: str) -> Optional[dict]:
        """Return the session for *code* (case-insensitive), or None."""
        return self._sessions.get(code.upper())

    def is_full(self, session: dict) -> bool:
        return len(session["participants"]) >= self.MAX_PARTICIPANTS

    # ── Maintenance ───────────────────────────────────────────────────────────

    def cleanup_empty(self) -> int:
        """
        Remove sessions that have no participants (e.g. host closed the app
        without disconnecting).  Returns the number of sessions removed.
        Called periodically by the server's background cleanup task.
        """
        empty = [code for code, s in self._sessions.items() if not s["participants"]]
        for code in empty:
            del self._sessions[code]
        return len(empty)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _unique_code(self) -> str:
        code = uuid.uuid4().hex[:6].upper()
        while code in self._sessions:
            code = uuid.uuid4().hex[:6].upper()
        return code


# ── Dependency ────────────────────────────────────────────────────────────────

def _get_manager(request: Request) -> CollabSessionManager:
    return request.app.state.session_manager


# ── Response models ───────────────────────────────────────────────────────────

class CreateSessionResponse(BaseModel):
    code: str
    created_at: str


class SessionInfoResponse(BaseModel):
    code: str
    participants: list
    created_at: str
    file_count: int


# ── HTTP routes ───────────────────────────────────────────────────────────────

@router.post("/session", response_model=CreateSessionResponse)
async def create_session(manager: CollabSessionManager = Depends(_get_manager)):
    """Create a new collaboration session. Returns a 6-character invite code."""
    session = manager.create()
    return CreateSessionResponse(code=session["code"], created_at=session["created_at"])


@router.get("/session/{code}", response_model=SessionInfoResponse)
async def get_session(
    code: str,
    manager: CollabSessionManager = Depends(_get_manager),
):
    """Return metadata for a session without connecting to it."""
    session = manager.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found or has expired")
    return SessionInfoResponse(
        code=session["code"],
        participants=list(session["participants"].values()),
        created_at=session["created_at"],
        file_count=len(session["file_state"]),
    )


# NOTE: Real-time collaboration is handled entirely by the raw TCP server
# (TCPCollabServer on port 8002, see tcp_collab.py).  There is no WebSocket
# endpoint here.  The HTTP routes above are kept for session metadata lookups.
