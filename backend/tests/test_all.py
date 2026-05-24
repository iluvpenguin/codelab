"""
CodeLab Backend Test Suite
=========================
Run from the backend/ directory:
    pip install pytest
    pytest tests/ -v

All tests use the `client` fixture from conftest.py, which starts the full
FastAPI app (including lifespan: thread pool, rate limiter, TCP collab server).
"""
import json
import os
import socket
import tempfile
import time

import pytest


# ── Health ────────────────────────────────────────────────────────────────────

class TestHealth:
    def test_health_ok(self, client):
        r = client.get("/api/")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert "uptime_seconds" in data
        assert "thread_pool" in data

    def test_health_has_version(self, client):
        r = client.get("/api/")
        assert "version" in r.json()

    def test_openapi_schema(self, client):
        r = client.get("/api/openapi.json")
        assert r.status_code == 200
        assert "paths" in r.json()


# ── Files ─────────────────────────────────────────────────────────────────────

class TestFiles:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()

    def test_list_directory(self, client):
        r = client.get(f"/api/files/list?path={self.tmpdir}")
        assert r.status_code == 200
        assert "nodes" in r.json()

    def test_list_nonexistent(self, client):
        r = client.get("/api/files/list?path=C:/nonexistent/path/abc123xyz")
        assert r.status_code == 404

    def test_write_and_read(self, client):
        path = os.path.join(self.tmpdir, "hello.py")
        w = client.post("/api/files/write", json={"path": path, "content": "print('hello')"})
        assert w.status_code == 200
        assert w.json()["path"].endswith("hello.py")
        r = client.get(f"/api/files/read?path={path}")
        assert r.status_code == 200
        assert r.json()["content"] == "print('hello')"

    def test_read_nonexistent(self, client):
        r = client.get("/api/files/read?path=C:/nonexistent/file123.py")
        assert r.status_code == 404

    def test_mkdir(self, client):
        new_dir = os.path.join(self.tmpdir, "subdir", "nested")
        r = client.post("/api/files/mkdir", json={"path": new_dir})
        assert r.status_code == 200
        assert os.path.isdir(new_dir)

    def test_delete_file(self, client):
        path = os.path.join(self.tmpdir, "todelete.txt")
        with open(path, "w") as f:
            f.write("bye")
        r = client.delete(f"/api/files/delete?path={path}")
        assert r.status_code == 200
        assert not os.path.exists(path)

    def test_delete_nonexistent(self, client):
        r = client.delete("/api/files/delete?path=C:/nonexistent/xyz123.txt")
        assert r.status_code == 404

    def test_write_overwrites(self, client):
        path = os.path.join(self.tmpdir, "overwrite.txt")
        client.post("/api/files/write", json={"path": path, "content": "first"})
        client.post("/api/files/write", json={"path": path, "content": "second"})
        r = client.get(f"/api/files/read?path={path}")
        assert r.json()["content"] == "second"

    def test_rename(self, client):
        src = os.path.join(self.tmpdir, "before.txt")
        dst = os.path.join(self.tmpdir, "after.txt")
        with open(src, "w") as f:
            f.write("data")
        r = client.post("/api/files/rename", json={"src": src, "dst": dst})
        assert r.status_code == 200
        assert not os.path.exists(src)
        assert os.path.exists(dst)

    def test_search(self, client):
        path = os.path.join(self.tmpdir, "searchme.py")
        with open(path, "w") as f:
            f.write("def hello_world():\n    pass\n")
        r = client.get(f"/api/files/search?root={self.tmpdir}&query=hello_world")
        assert r.status_code == 200
        assert len(r.json()["results"]) >= 1

    def test_run_command(self, client):
        r = client.post("/api/files/run", json={"command": "echo hello"})
        assert r.status_code == 200
        assert "hello" in r.text

    def test_run_command_with_cwd(self, client):
        r = client.post("/api/files/run", json={"command": "echo cwd_test", "cwd": self.tmpdir})
        assert r.status_code == 200
        assert "cwd_test" in r.text


# ── Encryption (AES-256-GCM) ──────────────────────────────────────────────────

class TestEncryption:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()

    def test_write_secure_creates_enc_file(self, client):
        path = os.path.join(self.tmpdir, "secret.txt")
        r = client.post("/api/files/write-secure", json={"path": path, "content": "top secret"})
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["enc_path"].endswith(".codelab.enc")
        assert data["cipher"] == "AES-256-GCM"
        assert os.path.exists(data["enc_path"])

    def test_read_secure_decrypts_correctly(self, client):
        path = os.path.join(self.tmpdir, "roundtrip.txt")
        plaintext = "Hello, AES-256-GCM!"
        client.post("/api/files/write-secure", json={"path": path, "content": plaintext})
        r = client.get(f"/api/files/read-secure?path={path}")
        assert r.status_code == 200
        assert r.json()["content"] == plaintext

    def test_read_secure_missing_file(self, client):
        path = os.path.join(self.tmpdir, "missing.txt")
        r = client.get(f"/api/files/read-secure?path={path}")
        assert r.status_code == 404

    def test_tampered_file_returns_422(self, client):
        path = os.path.join(self.tmpdir, "tamper.txt")
        r = client.post("/api/files/write-secure", json={"path": path, "content": "secret"})
        enc_path = r.json()["enc_path"]
        # Corrupt the ciphertext (flip some bytes in the middle)
        with open(enc_path, "rb") as f:
            data = bytearray(f.read())
        data[20] ^= 0xFF   # flip bits in ciphertext region
        with open(enc_path, "wb") as f:
            f.write(data)
        r2 = client.get(f"/api/files/read-secure?path={path}")
        assert r2.status_code == 422


# ── Git ───────────────────────────────────────────────────────────────────────

class TestGit:
    def setup_method(self):
        import git as gitlib
        self.tmpdir = tempfile.mkdtemp()
        self.repo = gitlib.Repo.init(self.tmpdir)
        self.repo.config_writer().set_value("user", "name", "Test").release()
        self.repo.config_writer().set_value("user", "email", "test@test.com").release()
        readme = os.path.join(self.tmpdir, "README.md")
        with open(readme, "w") as f:
            f.write("# Test")
        self.repo.index.add(["README.md"])
        self.repo.index.commit("Initial commit")

    def test_status(self, client):
        r = client.get(f"/api/git/status?repo={self.tmpdir}")
        assert r.status_code == 200
        data = r.json()
        assert "branch" in data
        assert "staged" in data

    def test_status_invalid_repo(self, client):
        r = client.get("/api/git/status?repo=C:/tmp/not-a-repo-xyz123")
        assert r.status_code == 400

    def test_log(self, client):
        r = client.get(f"/api/git/log?repo={self.tmpdir}&limit=10")
        assert r.status_code == 200
        assert len(r.json()["commits"]) >= 1

    def test_branches(self, client):
        r = client.get(f"/api/git/branches?repo={self.tmpdir}")
        assert r.status_code == 200
        assert "branches" in r.json()
        assert "active" in r.json()

    def test_commit(self, client):
        new_file = os.path.join(self.tmpdir, "new.py")
        with open(new_file, "w") as f:
            f.write("x = 1")
        r = client.post("/api/git/commit", json={
            "repo": self.tmpdir,
            "message": "Add new.py",
            "files": ["new.py"],
        })
        assert r.status_code == 200
        assert "sha" in r.json()

    def test_diff(self, client):
        r = client.get(f"/api/git/diff?repo={self.tmpdir}")
        assert r.status_code == 200
        assert "diff" in r.json()

    def test_checkout_new_branch(self, client):
        r = client.post("/api/git/checkout", json={
            "repo": self.tmpdir,
            "branch": "feature-test",
            "create": True,
        })
        assert r.status_code == 200
        assert r.json()["branch"] == "feature-test"


# ── Collab HTTP metadata endpoints ────────────────────────────────────────────

class TestCollabHTTP:
    def test_create_session_returns_code(self, client):
        r = client.post("/api/collab/session")
        assert r.status_code == 200
        data = r.json()
        assert "code" in data
        assert len(data["code"]) == 6

    def test_get_session_info(self, client):
        create = client.post("/api/collab/session")
        code = create.json()["code"]
        r = client.get(f"/api/collab/session/{code}")
        assert r.status_code == 200
        assert r.json()["code"] == code

    def test_get_session_not_found(self, client):
        r = client.get("/api/collab/session/ZZZZZZ")
        assert r.status_code == 404


# ── Collab TCP socket protocol ────────────────────────────────────────────────

def _tcp_send(sock: socket.socket, msg: dict) -> None:
    sock.sendall((json.dumps(msg) + "\n").encode("utf-8"))


def _tcp_recv_line(sock: socket.socket, timeout: float = 3.0) -> dict:
    """Read one newline-delimited JSON message from the socket."""
    sock.settimeout(timeout)
    buf = ""
    while True:
        chunk = sock.recv(4096).decode("utf-8")
        if not chunk:
            raise ConnectionError("Socket closed before full message received")
        buf += chunk
        if "\n" in buf:
            line, _ = buf.split("\n", 1)
            return json.loads(line.strip())


class TestCollabTCP:
    """
    Direct TCP socket tests for the collaboration server (port 8002).

    These tests connect a raw socket to the TCP collab server that was
    started by the app lifespan, verify the JSON protocol, and disconnect.
    """

    PORT = 8002

    def _connect(self) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.connect(("127.0.0.1", self.PORT))
        return sock

    def test_create_session(self, client):
        """Create a session — server should reply with type=welcome and a 6-char code."""
        with self._connect() as sock:
            _tcp_send(sock, {"type": "create", "name": "Alice"})
            msg = _tcp_recv_line(sock)
        assert msg["type"] == "welcome"
        assert len(msg["code"]) == 6
        assert msg["name"] == "Alice"
        assert "Alice" in msg["participants"]
        assert "file_state" in msg

    def test_join_session(self, client):
        """
        Create a session with one socket, then join it with a second socket.
        Both should receive correct welcome/presence messages.
        """
        with self._connect() as host_sock:
            _tcp_send(host_sock, {"type": "create", "name": "Host"})
            welcome = _tcp_recv_line(host_sock)
            code = welcome["code"]

            with self._connect() as guest_sock:
                _tcp_send(guest_sock, {"type": "join", "code": code, "name": "Guest"})
                guest_welcome = _tcp_recv_line(guest_sock)

                assert guest_welcome["type"] == "welcome"
                assert guest_welcome["code"] == code
                assert "Guest" in guest_welcome["participants"]
                assert "Host" in guest_welcome["participants"]

                # Host should receive a presence/join event
                host_sock.settimeout(3.0)
                presence = _tcp_recv_line(host_sock)
                assert presence["type"] == "presence"
                assert presence["event"] == "join"
                assert "Guest" in presence["participants"]

    def test_join_nonexistent_session(self, client):
        """Joining a bad code should return type=error."""
        with self._connect() as sock:
            _tcp_send(sock, {"type": "join", "code": "ZZZZZZ", "name": "Bob"})
            msg = _tcp_recv_line(sock)
        assert msg["type"] == "error"

    def test_edit_broadcast(self, client):
        """An edit from host should be broadcast to the guest."""
        with self._connect() as host_sock:
            _tcp_send(host_sock, {"type": "create", "name": "Host"})
            code = _tcp_recv_line(host_sock)["code"]

            with self._connect() as guest_sock:
                _tcp_send(guest_sock, {"type": "join", "code": code, "name": "Guest"})
                _tcp_recv_line(guest_sock)           # welcome
                _tcp_recv_line(host_sock)            # presence:join

                # Host sends an edit
                _tcp_send(host_sock, {"type": "edit", "path": "main.py", "content": "x = 1"})

                # Guest should receive it
                edit_msg = _tcp_recv_line(guest_sock)
                assert edit_msg["type"] == "edit"
                assert edit_msg["from"] == "Host"
                assert edit_msg["path"] == "main.py"
                assert edit_msg["content"] == "x = 1"

    def test_command_before_session_returns_error(self, client):
        """Sending 'edit' before create/join should return type=error."""
        with self._connect() as sock:
            _tcp_send(sock, {"type": "edit", "path": "x.py", "content": "y"})
            msg = _tcp_recv_line(sock)
        assert msg["type"] == "error"

    def test_leave_closes_session(self, client):
        """After the only participant sends leave, session should disappear."""
        with self._connect() as sock:
            _tcp_send(sock, {"type": "create", "name": "Solo"})
            welcome = _tcp_recv_line(sock)
            code = welcome["code"]
            _tcp_send(sock, {"type": "leave"})
            # Socket closes server-side; allow a moment for cleanup
            time.sleep(0.1)

        # Confirm the session is gone by trying to join it
        with self._connect() as sock2:
            _tcp_send(sock2, {"type": "join", "code": code, "name": "Late"})
            err = _tcp_recv_line(sock2)
        assert err["type"] == "error"

    def test_sync_request(self, client):
        """sync_request should return a sync message with file_state."""
        with self._connect() as host:
            _tcp_send(host, {"type": "create", "name": "H"})
            code = _tcp_recv_line(host)["code"]
            # Push a file
            _tcp_send(host, {"type": "open_file", "path": "a.py", "content": "hello"})
            time.sleep(0.05)

            with self._connect() as guest:
                _tcp_send(guest, {"type": "join", "code": code, "name": "G"})
                _tcp_recv_line(guest)               # welcome (has file_state already)
                _tcp_recv_line(host)                # presence

                # Ask for a fresh sync
                _tcp_send(guest, {"type": "sync_request"})
                sync = _tcp_recv_line(guest)
        assert sync["type"] == "sync"
        assert "a.py" in sync["file_state"]
        assert sync["file_state"]["a.py"] == "hello"
