"""
Raw TCP Status Server
======================
A lightweight diagnostic server that listens on a raw TCP socket
(not HTTP, not WebSocket) alongside the main FastAPI/Uvicorn process.

Why raw TCP?
  WebSocket and HTTP are application-layer protocols built on top of TCP.
  This server goes one level lower: it speaks directly over TCP using
  plain text lines, exactly like old-school SMTP, IRC, or Redis clients.

  socket.socket(AF_INET, SOCK_STREAM)  — raw TCP stream socket
  sock.bind(host, port)                — claim the port
  sock.listen(backlog)                 — kernel queues up to N pending connections
  sock.accept()                        — blocks until a client connects; returns
                                         (connection_socket, client_address)
  conn.recv(N)                         — read up to N bytes from the client
  conn.sendall(data)                   — write bytes back

Threading model:
  One "accept" daemon thread runs the accept loop.
  Each accepted client gets its own short-lived daemon thread so a slow
  or stuck client never blocks other clients.

Commands (send as plain text, end with \\n):
  PING      → PONG
  STATUS    → JSON with live metrics (uptime, WS connections, thread pool…)
  SESSIONS  → number of active collaboration sessions
  HELP      → list available commands
  QUIT      → gracefully close this connection

Test from terminal:
  # Windows (PowerShell)
  $s = [System.Net.Sockets.TcpClient]::new('127.0.0.1', 8001)
  $r = $s.GetStream()
  $w = [System.IO.StreamWriter]::new($r); $w.AutoFlush = $true
  $re = [System.IO.StreamReader]::new($r)
  $w.WriteLine('PING'); $re.ReadLine()

  # Linux / macOS / WSL
  nc 127.0.0.1 8001

  # Python
  import socket
  s = socket.create_connection(('127.0.0.1', 8001))
  s.sendall(b'STATUS\\n'); print(s.recv(4096).decode()); s.close()
"""

import json
import logging
import socket
import threading
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("codelab.tcp")

_COMMANDS   = ("PING", "STATUS", "SESSIONS", "HELP", "QUIT")
_RECV_SIZE  = 512      # bytes per recv() call — commands are short
_CLIENT_TIMEOUT = 30.0 # seconds before an idle client is dropped


class TCPStatusServer:
    """
    Raw TCP diagnostic server.

    Lifecycle
    ---------
    server = TCPStatusServer(host='127.0.0.1', port=8001)
    server.start(app.state)   # call from lifespan, after state is populated
    ...
    server.stop()             # call from lifespan shutdown block
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 8001) -> None:
        self._host  = host
        self._port  = port
        self._sock: Optional[socket.socket] = None
        self._running = False
        self._accept_thread: Optional[threading.Thread] = None
        self._app_state = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self, app_state) -> None:
        """
        Create the TCP socket, bind it, and start the accept loop thread.

        Must be called *after* app.state has been populated so STATUS
        can report live metrics.
        """
        self._app_state = app_state
        self._running   = True

        # AF_INET  = IPv4
        # SOCK_STREAM = TCP (reliable, ordered, connection-oriented)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

        # SO_REUSEADDR lets us reclaim the port immediately after a restart
        # without waiting for the OS TIME_WAIT period.
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

        self._sock.bind((self._host, self._port))
        self._sock.listen(10)        # kernel queues up to 10 un-accepted connections

        # 1-second timeout so the accept loop can check _running periodically
        self._sock.settimeout(1.0)

        self._accept_thread = threading.Thread(
            target=self._accept_loop,
            name="tcp-status-accept",
            daemon=True,   # thread dies automatically when the main process exits
        )
        self._accept_thread.start()

        logger.info(
            "TCP status server listening on %s:%d",
            self._host, self._port,
        )

    def stop(self) -> None:
        """Signal the accept loop to exit and close the listening socket."""
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
        logger.info("TCP status server stopped")

    # ── Accept loop ───────────────────────────────────────────────────────────

    def _accept_loop(self) -> None:
        """
        Runs in the accept thread.
        Blocks on accept(), spawns a handler thread per client, repeats.
        """
        while self._running:
            try:
                conn, addr = self._sock.accept()  # blocks up to 1 second (timeout)
            except socket.timeout:
                continue   # check _running, then go back to waiting
            except OSError:
                break      # socket closed by .stop()

            threading.Thread(
                target=self._handle_client,
                args=(conn, addr),
                name=f"tcp-client-{addr[0]}:{addr[1]}",
                daemon=True,
            ).start()

    # ── Per-client handler ────────────────────────────────────────────────────

    def _handle_client(self, conn: socket.socket, addr: tuple) -> None:
        """
        Runs in a dedicated thread for one connected client.

        Reads newline-delimited commands, dispatches each, sends reply.
        Exits when client disconnects, sends QUIT, or times out.
        """
        logger.debug("TCP client connected from %s:%d", *addr)
        try:
            with conn:
                conn.settimeout(_CLIENT_TIMEOUT)
                # Greeting
                conn.sendall(
                    b"CodeLab TCP Status Server ready. Type HELP for commands.\n"
                )
                buf = ""
                while True:
                    chunk = conn.recv(_RECV_SIZE)
                    if not chunk:
                        break   # client closed the connection

                    buf += chunk.decode("utf-8", errors="replace")

                    # Process every complete line in the buffer
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        cmd = line.strip().upper()
                        if not cmd:
                            continue
                        reply = self._dispatch(cmd)
                        conn.sendall(reply.encode("utf-8") + b"\n")
                        if cmd == "QUIT":
                            return

        except (ConnectionResetError, BrokenPipeError, socket.timeout, ConnectionAbortedError):
            pass   # client vanished or closed abruptly — nothing to do
        finally:
            logger.debug("TCP client disconnected from %s:%d", *addr)

    # ── Command dispatch ──────────────────────────────────────────────────────

    def _dispatch(self, cmd: str) -> str:
        """Map a command string to its reply string."""

        if cmd == "PING":
            return "PONG"

        if cmd == "STATUS":
            return self._status_json()

        if cmd == "SESSIONS":
            # Report from the TCP collab server (raw TCP, port 8002)
            tcp_collab = getattr(self._app_state, "tcp_collab", None)
            count = tcp_collab.session_count if tcp_collab is not None else -1
            return f"active_collab_sessions={count}"

        if cmd == "HELP":
            return "Available commands: " + ", ".join(_COMMANDS)

        if cmd == "QUIT":
            return "BYE"

        return f"UNKNOWN COMMAND: {cmd!r}  (type HELP)"

    def _status_json(self) -> str:
        """Build a JSON status snapshot from live app state."""
        state    = self._app_state
        up_since: Optional[datetime] = getattr(state, "start_time", None)
        uptime   = (
            round((datetime.now(timezone.utc) - up_since).total_seconds(), 1)
            if up_since else -1
        )
        pool = getattr(state, "thread_pool", None)
        try:
            pending = pool._work_queue.qsize() if pool else -1
        except Exception:
            pending = -1

        rl = getattr(state, "run_rate_limiter", None)

        return json.dumps({
            "service":        "CodeLab Desktop API",
            "status":         "running",
            "uptime_seconds": uptime,
            "ws_connections": getattr(state, "ws_connections", 0),
            "thread_pool": {
                "max_workers":   getattr(pool, "_max_workers", -1) if pool else -1,
                "pending_tasks": pending,
            },
            "rate_limiter": {
                "rate": getattr(rl, "rate", -1),
                "per":  getattr(rl, "per",  -1),
            },
            "encryption": "AES-256-GCM active",
        }, indent=2)

    # ── Repr ──────────────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        status = "running" if self._running else "stopped"
        return f"<TCPStatusServer {self._host}:{self._port} [{status}]>"
