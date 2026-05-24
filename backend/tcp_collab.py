"""
TCP Collaboration Server
========================
Full real-time collaboration over raw TCP sockets — no WebSocket.

Protocol: newline-delimited JSON (one JSON object per line, ending with \\n).

Client → Server:
  {"type": "create",       "name": "Alice"}
  {"type": "join",         "code": "A3F2BC", "name": "Bob"}
  {"type": "edit",         "path": "...", "content": "...", "cursor": {...}}
  {"type": "cursor",       "path": "...", "line": N, "col": N}
  {"type": "chat",         "text": "..."}
  {"type": "file_tree",    "rootPath": "..."}
  {"type": "open_file",    "path": "...", "content": "..."}
  {"type": "sync_request"}
  {"type": "leave"}

Server → Client:
  {"type": "welcome",  "code": "...", "name": "...", "participants": [...], "file_state": {...}, "root_path": "..."}
  {"type": "edit",     "from": "...", "path": "...", "content": "..."}
  {"type": "cursor",   "from": "...", "path": "...", "line": N, "col": N}
  {"type": "presence", "event": "join"|"leave", "name": "...", "participants": [...]}
  {"type": "sync",     "file_state": {...}, "root_path": "..."}
  {"type": "error",    "detail": "..."}

Threading model:
  One accept-loop daemon thread.
  Each connected client gets its own daemon thread.
  A single threading.Lock protects the _sessions registry.
"""

import json
import logging
import socket
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("codelab.tcp_collab")

_MAX_MSG_BYTES  = 512 * 1024   # 512 KB per message
_MAX_PARTICIPANTS = 20
_RECV_SIZE      = 4096          # bytes per recv() call
_CLIENT_TIMEOUT = 300.0         # 5 minutes idle before drop


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TCPCollabServer:
    """
    Raw TCP collaboration server.

    Session registry
    ----------------
    _sessions: dict[code, {
        "code":         str,
        "created_at":   str,
        "participants": dict[socket, str],   # conn -> display name
        "file_state":   dict[str, str],      # path -> content snapshot
        "root_path":    str,
    }]

    All access to _sessions goes through self._lock.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 8002) -> None:
        self._host    = host
        self._port    = port
        self._sock: Optional[socket.socket] = None
        self._running = False
        self._accept_thread: Optional[threading.Thread] = None
        self._lock    = threading.Lock()
        self._sessions: dict[str, dict] = {}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Bind, listen, and start the accept-loop daemon thread."""
        self._running = True

        # AF_INET = IPv4,  SOCK_STREAM = TCP
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self._host, self._port))
        self._sock.listen(20)
        self._sock.settimeout(1.0)   # accept() unblocks every second to check _running

        self._accept_thread = threading.Thread(
            target=self._accept_loop,
            name="tcp-collab-accept",
            daemon=True,
        )
        self._accept_thread.start()
        logger.info("TCP collab server listening on %s:%d", self._host, self._port)

    def stop(self) -> None:
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
        logger.info("TCP collab server stopped")

    # ── Accept loop ───────────────────────────────────────────────────────────

    def _accept_loop(self) -> None:
        while self._running:
            try:
                conn, addr = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(
                target=self._handle_client,
                args=(conn, addr),
                name=f"tcp-collab-{addr[1]}",
                daemon=True,
            ).start()

    # ── Per-client handler ────────────────────────────────────────────────────

    def _handle_client(self, conn: socket.socket, addr: tuple) -> None:
        """
        Runs in a dedicated thread for each connected client.
        Reads newline-delimited JSON, dispatches commands, sends replies.
        """
        logger.debug("Collab client connected: %s:%d", *addr)
        session = None
        name    = "Anonymous"

        try:
            conn.settimeout(_CLIENT_TIMEOUT)
            buf = ""

            while True:
                chunk = conn.recv(_RECV_SIZE)
                if not chunk:
                    break   # client closed connection cleanly

                buf += chunk.decode("utf-8", errors="replace")

                # Process every complete line in the buffer
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    if len(line.encode("utf-8")) > _MAX_MSG_BYTES:
                        self._send(conn, {"type": "error", "detail": "Message too large"})
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    result = self._dispatch(conn, msg, session, name)
                    if result is not None:
                        session, name = result

                    if msg.get("type") == "leave":
                        return   # clean exit

        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, socket.timeout):
            pass
        finally:
            if session is not None:
                self._on_leave(conn, session, name)
            logger.debug("Collab client disconnected: %s:%d", *addr)

    # ── Command dispatch ──────────────────────────────────────────────────────

    def _dispatch(self, conn, msg: dict, session, name: str):
        """
        Route an incoming message to the correct handler.
        Returns (session, name) if join/create succeeded, else None.
        """
        t = msg.get("type", "")

        # ── Session establishment (must come first) ───────────────────────────
        if t == "create":
            name    = str(msg.get("name", "Anonymous"))[:50]
            session = self._do_create(conn, name)
            return session, name

        if t == "join":
            name    = str(msg.get("name", "Anonymous"))[:50]
            code    = str(msg.get("code", "")).strip().upper()
            session = self._do_join(conn, code, name)
            return session, name

        # ── Must be in a session for anything below ───────────────────────────
        if session is None:
            self._send(conn, {"type": "error",
                               "detail": "Send 'create' or 'join' before other commands."})
            return None

        if t == "edit":
            path    = msg.get("path", "")
            content = msg.get("content", "")
            with self._lock:
                if path:
                    session["file_state"][path] = content
            self._broadcast(session, {
                "type": "edit", "from": name,
                "path": path, "content": content,
                "cursor": msg.get("cursor"),
                "timestamp": _now_iso(),
            }, exclude=conn)

        elif t == "cursor":
            self._broadcast(session, {
                "type": "cursor", "from": name,
                "path": msg.get("path", ""),
                "line": msg.get("line", 0),
                "col":  msg.get("col",  0),
                "timestamp": _now_iso(),
            }, exclude=conn)

        elif t == "chat":
            self._broadcast(session, {
                "type": "chat", "from": name,
                "text": str(msg.get("text", ""))[:2000],
                "timestamp": _now_iso(),
            })

        elif t == "file_tree":
            root = msg.get("rootPath", "")
            with self._lock:
                session["root_path"] = root
            self._broadcast(session, {
                "type": "file_tree", "from": name,
                "rootPath": root, "timestamp": _now_iso(),
            }, exclude=conn)

        elif t == "open_file":
            fpath   = msg.get("path", "")
            content = msg.get("content", "")
            with self._lock:
                if fpath:
                    session["file_state"][fpath] = content
            self._broadcast(session, {
                "type": "open_file", "from": name,
                "path": fpath, "content": content,
                "timestamp": _now_iso(),
            }, exclude=conn)

        elif t == "sync_request":
            with self._lock:
                fs = dict(session["file_state"])
                rp = session["root_path"]
            self._send(conn, {
                "type": "sync", "file_state": fs,
                "root_path": rp, "timestamp": _now_iso(),
            })

        return None

    # ── Session management ────────────────────────────────────────────────────

    def _do_create(self, conn: socket.socket, name: str) -> dict:
        """Create a new session, add this client as first participant."""
        code = self._unique_code()
        session = {
            "code":         code,
            "created_at":   _now_iso(),
            "participants": {conn: name},
            "file_state":   {},
            "root_path":    "",
        }
        with self._lock:
            self._sessions[code] = session
        logger.info("TCP collab session created: %s by '%s'", code, name)

        # Send welcome to creator
        self._send(conn, {
            "type":         "welcome",
            "code":         code,
            "name":         name,
            "participants": [name],
            "file_state":   {},
            "root_path":    "",
            "timestamp":    _now_iso(),
        })
        return session

    def _do_join(self, conn: socket.socket, code: str, name: str) -> Optional[dict]:
        """Add client to an existing session."""
        with self._lock:
            session = self._sessions.get(code)
            if not session:
                self._send(conn, {"type": "error", "detail": f"Session '{code}' not found."})
                return None
            if len(session["participants"]) >= _MAX_PARTICIPANTS:
                self._send(conn, {"type": "error", "detail": "Session is full."})
                return None
            session["participants"][conn] = name
            participants = list(session["participants"].values())
            fs = dict(session["file_state"])
            rp = session["root_path"]

        logger.info("'%s' joined session %s (%d participants)", name, code, len(participants))

        # Welcome the new participant (sends current file state for sync)
        self._send(conn, {
            "type":         "welcome",
            "code":         code,
            "name":         name,
            "participants": participants,
            "file_state":   fs,
            "root_path":    rp,
            "timestamp":    _now_iso(),
        })
        # Notify everyone else
        self._broadcast(session, {
            "type":         "presence",
            "event":        "join",
            "name":         name,
            "participants": participants,
            "timestamp":    _now_iso(),
        }, exclude=conn)
        return session

    def _on_leave(self, conn: socket.socket, session: dict, name: str) -> None:
        """Remove client from session; delete session when empty."""
        with self._lock:
            session["participants"].pop(conn, None)
            remaining = list(session["participants"].values())
            if not session["participants"]:
                self._sessions.pop(session["code"], None)
                logger.info("Session %s closed (all participants left)", session["code"])

        logger.info("'%s' left session %s (%d remaining)", name, session["code"], len(remaining))
        self._broadcast(session, {
            "type":         "presence",
            "event":        "leave",
            "name":         name,
            "participants": remaining,
            "timestamp":    _now_iso(),
        })

    # ── Network helpers ───────────────────────────────────────────────────────

    def _send(self, conn: socket.socket, msg: dict) -> None:
        """Send one JSON message to a single client (newline-terminated)."""
        try:
            conn.sendall((json.dumps(msg) + "\n").encode("utf-8"))
        except (OSError, BrokenPipeError):
            pass

    def _broadcast(self, session: dict, msg: dict, exclude=None) -> None:
        """Send one JSON message to all participants except *exclude*."""
        text = (json.dumps(msg) + "\n").encode("utf-8")
        dead = []
        with self._lock:
            conns = list(session["participants"].keys())
        for c in conns:
            if c is exclude:
                continue
            try:
                c.sendall(text)
            except (OSError, BrokenPipeError):
                dead.append(c)
        if dead:
            with self._lock:
                for c in dead:
                    session["participants"].pop(c, None)

    # ── Utilities ─────────────────────────────────────────────────────────────

    def _unique_code(self) -> str:
        code = uuid.uuid4().hex[:6].upper()
        with self._lock:
            while code in self._sessions:
                code = uuid.uuid4().hex[:6].upper()
        return code

    def cleanup_empty(self) -> int:
        with self._lock:
            empty = [c for c, s in self._sessions.items() if not s["participants"]]
            for c in empty:
                del self._sessions[c]
        return len(empty)

    @property
    def session_count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def __repr__(self) -> str:
        status = "running" if self._running else "stopped"
        return f"<TCPCollabServer {self._host}:{self._port} [{status}] sessions={self.session_count}>"
