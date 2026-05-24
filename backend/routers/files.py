"""
File operations router.

FileService encapsulates all file system operations. An instance is created
per-request by the _file_service dependency and receives the shared thread
pool and rate limiter from app.state.

Design
------
- Heavy ops (directory walk, delete, search, subprocess) dispatch to the
  thread pool via FileService._dispatch() so the event loop is never blocked.
- Read/write use aiofiles for genuine async I/O without the thread pool.
- /run is gated by the server's token-bucket rate limiter inside FileService.run().
"""

import asyncio
import logging
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("codelab.files")


# ── Path safety ───────────────────────────────────────────────────────────────

if os.name == "nt":
    _BLOCKED: tuple[Path, ...] = (
        Path(os.environ.get("SystemRoot",         r"C:\Windows")),
        Path(os.environ.get("ProgramFiles",       r"C:\Program Files")),
        Path(os.environ.get("ProgramFiles(x86)",  r"C:\Program Files (x86)")),
    )
else:
    _BLOCKED: tuple[Path, ...] = (
        Path("/etc"), Path("/usr"), Path("/bin"), Path("/sbin"),
        Path("/lib"), Path("/sys"), Path("/proc"), Path("/dev"), Path("/boot"),
    )


def _guard(path: str) -> Path:
    """
    Resolve *path* to an absolute Path, collapse any '..' components, and
    reject paths that land inside OS-critical directories.
    Raises HTTPException(400) for unparseable paths, 403 for blocked ones.
    """
    try:
        p = Path(path).resolve()
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {exc}")
    for blocked in _BLOCKED:
        if p == blocked or p.is_relative_to(blocked):
            raise HTTPException(status_code=403, detail=f"Access to system path denied: {path}")
    return p


# ── FileService ───────────────────────────────────────────────────────────────

class FileService:
    """
    Async interface to file system operations.

    Instantiated per-request via Depends(_file_service).
    The rate_limiter reference is used only by .run() to enforce the
    /api/files/run execution quota.
    """

    MAX_DEPTH      = 5
    MAX_READ_BYTES = 20 * 1024 * 1024   # 20 MB
    RUN_TIMEOUT    = 30                  # seconds

    def __init__(self, executor: ThreadPoolExecutor, rate_limiter) -> None:
        self._executor     = executor
        self._rate_limiter = rate_limiter

    # ── Directory listing ─────────────────────────────────────────────────────

    async def list(self, path: str) -> dict:
        return await self._dispatch(self._sync_list, path)

    @staticmethod
    def _sync_list(root_path: str) -> dict:
        root = _guard(root_path)
        if not root.exists():
            raise HTTPException(status_code=404, detail=f"Path not found: {root_path}")
        if not root.is_dir():
            raise HTTPException(status_code=400, detail=f"Not a directory: {root_path}")

        nodes: list[dict] = []

        def walk(p: Path, depth: int) -> None:
            if depth > FileService.MAX_DEPTH:
                return
            try:
                entries = sorted(
                    p.iterdir(),
                    key=lambda x: (not x.is_dir(), x.name.lower()),
                )
            except PermissionError:
                return
            for entry in entries:
                if entry.name.startswith(".") and entry.name not in {
                    ".env", ".gitignore", ".gitattributes", ".editorconfig"
                }:
                    continue
                try:
                    stat = entry.stat()
                    nodes.append({
                        "name":     entry.name,
                        "path":     str(entry),
                        "type":     "directory" if entry.is_dir() else "file",
                        "depth":    depth,
                        "size":     stat.st_size if entry.is_file() else None,
                        "modified": stat.st_mtime,
                    })
                    if entry.is_dir():
                        walk(entry, depth + 1)
                except (PermissionError, OSError):
                    continue

        walk(root, 0)
        return {"nodes": nodes, "root": str(root)}

    # ── File read / write ─────────────────────────────────────────────────────

    async def read(self, path: str) -> dict:
        p = _guard(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"File not found: {path}")
        if not p.is_file():
            raise HTTPException(status_code=400, detail=f"Not a file: {path}")
        size = p.stat().st_size
        if size > self.MAX_READ_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({size // 1024} KB > {self.MAX_READ_BYTES // 1024} KB limit)",
            )
        try:
            async with aiofiles.open(p, mode="r", encoding="utf-8", errors="replace") as f:
                content = await f.read()
            return {"content": content, "size": size, "path": str(p)}
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    async def write(self, path: str, content: str) -> dict:
        p = _guard(path)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            async with aiofiles.open(p, mode="w", encoding="utf-8") as f:
                await f.write(content)
            return {"ok": True, "path": str(p), "size": len(content.encode())}
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    async def mkdir(self, path: str) -> dict:
        p = _guard(path)
        try:
            p.mkdir(parents=True, exist_ok=True)
            return {"ok": True, "path": str(p)}
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    async def rename(self, src: str, dst: str) -> dict:
        s, d = _guard(src), _guard(dst)
        if not s.exists():
            raise HTTPException(status_code=404, detail=f"Source not found: {src}")
        if d.exists():
            raise HTTPException(status_code=409, detail=f"Destination already exists: {dst}")
        try:
            d.parent.mkdir(parents=True, exist_ok=True)
            s.rename(d)
            return {"ok": True, "src": str(s), "dst": str(d)}
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    # ── Delete ────────────────────────────────────────────────────────────────

    async def delete(self, path: str) -> dict:
        return await self._dispatch(self._sync_delete, path)

    @staticmethod
    def _sync_delete(path: str) -> dict:
        p = _guard(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"Not found: {path}")
        try:
            if p.is_file() or p.is_symlink():
                p.unlink()
            else:
                shutil.rmtree(p)
            return {"ok": True, "deleted": path}
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    # ── Search ────────────────────────────────────────────────────────────────

    async def search(self, root: str, query: str, max_results: int) -> dict:
        return await self._dispatch(self._sync_search, root, query, max_results)

    @staticmethod
    def _sync_search(root: str, query: str, max_results: int) -> dict:
        root = str(_guard(root))
        q = query.lower()
        results: list[dict] = []

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".")
                and d not in {"node_modules", "__pycache__", "dist", "build"}
            ]
            for filename in filenames:
                if filename.startswith("."):
                    continue
                filepath = os.path.join(dirpath, filename)
                try:
                    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                        for lineno, line in enumerate(f, 1):
                            if q in line.lower():
                                results.append({
                                    "file":     filepath,
                                    "rel_path": os.path.relpath(filepath, root),
                                    "line":     lineno,
                                    "text":     line.rstrip()[:200],
                                })
                                if len(results) >= max_results:
                                    return {"results": results, "truncated": True, "query": query}
                except (PermissionError, OSError):
                    continue

        return {"results": results, "truncated": False, "query": query}

    # ── Command execution ─────────────────────────────────────────────────────

    async def run(self, command: str, cwd: Optional[str]) -> str:
        if not self._rate_limiter.allow():
            logger.warning("Rate limit hit on /run — rejected: %r", command[:80])
            raise HTTPException(
                status_code=429,
                detail=f"Too many run requests. Limit: {self._rate_limiter.rate} per {int(self._rate_limiter.per)}s.",
            )
        logger.info("Executing: %r (cwd=%r)", command[:120], cwd)
        return await self._dispatch(self._sync_run, command, cwd)

    @staticmethod
    def _sync_run(command: str, cwd: Optional[str]) -> str:
        effective_cwd: Optional[str] = None
        if cwd:
            cwd_path = Path(cwd)
            if cwd_path.is_dir():
                effective_cwd = str(cwd_path)
            else:
                return f"[Error] Working directory does not exist: {cwd}"
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=FileService.RUN_TIMEOUT,
                cwd=effective_cwd,
                encoding="utf-8",
                errors="replace",
            )
            parts = []
            if result.stdout:
                parts.append(result.stdout)
            if result.stderr:
                parts.append("[stderr]\n" + result.stderr)
            if result.returncode != 0:
                parts.append(f"[Exit code: {result.returncode}]")
            return "\n".join(parts) if parts else "(no output)"
        except subprocess.TimeoutExpired:
            return f"[Error] Command timed out after {FileService.RUN_TIMEOUT}s"
        except Exception as exc:
            return f"[Error] {exc}"

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _dispatch(self, fn, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn, *args)


# ── Dependency ────────────────────────────────────────────────────────────────

def _file_service(request: Request) -> FileService:
    return FileService(
        executor=request.app.state.thread_pool,
        rate_limiter=request.app.state.run_rate_limiter,
    )


# ── Request models ────────────────────────────────────────────────────────────

class WriteBody(BaseModel):
    path: str
    content: str


class MkdirBody(BaseModel):
    path: str


class RenameBody(BaseModel):
    src: str
    dst: str


class RunBody(BaseModel):
    command: str
    cwd: Optional[str] = None


class WriteSecureBody(BaseModel):
    path: str
    content: str


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/list")
async def list_files(path: str, svc: FileService = Depends(_file_service)):
    """Return a flat tree of all files/directories under `path`."""
    return await svc.list(path)


@router.get("/read")
async def read_file(path: str, svc: FileService = Depends(_file_service)):
    """Read a file's content as UTF-8 text."""
    return await svc.read(path)


@router.post("/write")
async def write_file(body: WriteBody, svc: FileService = Depends(_file_service)):
    """Write (overwrite) a file. Creates parent directories as needed."""
    return await svc.write(body.path, body.content)


@router.post("/mkdir")
async def make_dir(body: MkdirBody, svc: FileService = Depends(_file_service)):
    """Create a directory tree."""
    return await svc.mkdir(body.path)


@router.post("/rename")
async def rename_path(body: RenameBody, svc: FileService = Depends(_file_service)):
    """Rename or move a file or directory."""
    return await svc.rename(body.src, body.dst)


@router.delete("/delete")
async def delete_path(path: str, svc: FileService = Depends(_file_service)):
    """Delete a file or directory tree."""
    return await svc.delete(path)


@router.get("/search")
async def search_files(
    root: str,
    query: str,
    svc: FileService = Depends(_file_service),
    max_results: int = 200,
):
    """Case-insensitive full-text search across all files under `root`."""
    if not query.strip():
        raise HTTPException(status_code=400, detail="query must not be empty")
    return await svc.search(root, query, max_results)


@router.post("/run")
async def run_command(
    body: RunBody,
    svc: FileService = Depends(_file_service),
) -> PlainTextResponse:
    """Execute a shell command and return combined stdout/stderr. Rate-limited."""
    output = await svc.run(body.command, body.cwd)
    return PlainTextResponse(output)


# ── Encrypted file endpoints (AES-256-GCM) ────────────────────────────────────

@router.post("/write-secure")
async def write_secure(body: WriteSecureBody, request: Request):
    """
    Encrypt *content* with AES-256-GCM and write the ciphertext to disk.

    The file is saved with a '.codelab.enc' suffix appended to the given path.
    Wire format on disk:  12-byte nonce | ciphertext | 16-byte GCM auth tag.
    The original path is never written — only the encrypted blob.
    """
    from crypto import EncryptionService, InvalidTag  # noqa: F401

    enc: EncryptionService = request.app.state.encryption
    p = _guard(body.path)
    enc_path = p.with_suffix(p.suffix + ".codelab.enc")
    try:
        blob = enc.encrypt_text(body.content)          # AES-256-GCM encrypt
        enc_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(enc_path, mode="wb") as f:
            await f.write(blob)
        logger.info("Encrypted file written: %s (%d bytes)", enc_path, len(blob))
        return {
            "ok":       True,
            "enc_path": str(enc_path),
            "bytes":    len(blob),
            "cipher":   "AES-256-GCM",
        }
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {body.path}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/read-secure")
async def read_secure(path: str, request: Request):
    """
    Read and decrypt an AES-256-GCM encrypted file.

    *path* should be the original path (without the '.codelab.enc' suffix);
    the endpoint appends the suffix automatically.
    Returns the decrypted plaintext as UTF-8.
    Raises 422 if the file has been tampered with (GCM auth tag mismatch).
    """
    from crypto import EncryptionService, InvalidTag

    enc: EncryptionService = request.app.state.encryption
    p = _guard(path)
    enc_path = p.with_suffix(p.suffix + ".codelab.enc")

    if not enc_path.exists():
        raise HTTPException(status_code=404, detail=f"Encrypted file not found: {enc_path}")

    try:
        async with aiofiles.open(enc_path, mode="rb") as f:
            blob = await f.read()
        plaintext = enc.decrypt_text(blob)             # AES-256-GCM decrypt + verify tag
        logger.info("Encrypted file decrypted: %s", enc_path)
        return {"content": plaintext, "enc_path": str(enc_path), "cipher": "AES-256-GCM"}
    except InvalidTag:
        logger.warning("Tampered or wrong-key file: %s", enc_path)
        raise HTTPException(
            status_code=422,
            detail="Decryption failed — file may have been tampered with or key is wrong.",
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
