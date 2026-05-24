"""
GitHub import / export router.

Scope
-----
GitHub is used ONLY as a transport for importing and exporting projects:

  Import  →  git clone a repository URL to a local path
  Export  →  push a local project to a (new or existing) GitHub remote

Nothing in this router lists user repositories, shows user profiles, or
creates any UI around GitHub as a platform.  All of that is the user's
responsibility on github.com.

Authentication
--------------
The user provides a Personal Access Token (PAT) once.  We store it locally
in ~/.codelab/github_token.json (user's own machine, not a server).

Credential security
-------------------
Credentials are NEVER embedded in git URLs.  Instead we use git's
per-call credential helper mechanism:

  - On clone / push we write a temporary helper script / env var that
    answers git's credential prompt once, then discard it.
  - After clone we reset the stored remote URL to the clean https:// form
    so credentials are not persisted in .git/config.

All git operations run in the shared thread pool (blocking I/O).
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional
from urllib.request import Request as UrlRequest, urlopen
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("codelab.github")

TOKEN_FILE = Path.home() / ".codelab" / "github_token.json"
GITHUB_API = "https://api.github.com"

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
    try:
        p = Path(path).resolve()
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {exc}")
    for blocked in _BLOCKED:
        if p == blocked or p.is_relative_to(blocked):
            raise HTTPException(status_code=403, detail=f"Access to system path denied: {path}")
    return p

_KEYRING_SERVICE = "codelab-desktop"
_KEYRING_USER    = "github_token"

# ── Token storage (keyring with JSON file fallback) ───────────────────────────

def _save_token(token: str, user: dict) -> None:
    payload = json.dumps({"token": token, "user": user})
    try:
        import keyring
        keyring.set_password(_KEYRING_SERVICE, _KEYRING_USER, payload)
        # Remove old plaintext file if it exists
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink(missing_ok=True)
        return
    except Exception:
        pass
    # Fallback: plaintext file (keyring backend unavailable)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(payload, encoding="utf-8")


def _load_token() -> Optional[dict]:
    try:
        import keyring
        payload = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USER)
        if payload:
            return json.loads(payload)
    except Exception:
        pass
    # Fallback: plaintext file
    try:
        if TOKEN_FILE.exists():
            return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _delete_token() -> None:
    try:
        import keyring
        keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USER)
    except Exception:
        pass
    try:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
    except Exception:
        pass


# ── GitHub API helper (stdlib only — no httpx) ────────────────────────────────

def _github_get(path: str, token: str) -> dict:
    """
    Make a single authenticated GET request to the GitHub API.
    Uses urllib from the standard library — no extra dependencies.
    """
    url = f"{GITHUB_API}{path}"
    req = UrlRequest(
        url,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "CodeLab-Desktop/2.0",
        },
    )
    try:
        with urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raise HTTPException(
            status_code=exc.code,
            detail=f"GitHub API error {exc.code}: {exc.reason}",
        )
    except URLError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach GitHub API: {exc.reason}",
        )


def _github_post(path: str, token: str, payload: dict) -> dict:
    """POST to the GitHub API.  Used only for repo creation during export."""
    import json as _json
    url = f"{GITHUB_API}{path}"
    data = _json.dumps(payload).encode("utf-8")
    req = UrlRequest(
        url,
        data=data,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "CodeLab-Desktop/2.0",
        },
    )
    try:
        with urlopen(req, timeout=15) as resp:
            return _json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("message", exc.reason)
        except Exception:
            detail = exc.reason
        raise HTTPException(status_code=exc.code, detail=f"GitHub: {detail}")
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach GitHub API: {exc.reason}")


# ── Credential helpers ────────────────────────────────────────────────────────

def _make_askpass(token: str) -> str:
    """
    Create a temporary GIT_ASKPASS script that answers git's password prompt
    with the token.  Returns the path to the script.

    On Windows we write a .bat file; on POSIX a shell script.
    Caller is responsible for deleting it.
    """
    if sys.platform == "win32":
        fd, path = tempfile.mkstemp(suffix=".bat")
        with os.fdopen(fd, "w") as f:
            f.write(f"@echo off\necho {token}\n")
    else:
        fd, path = tempfile.mkstemp(suffix=".sh")
        with os.fdopen(fd, "w") as f:
            f.write(f"#!/bin/sh\necho '{token}'\n")
        os.chmod(path, 0o700)
    return path


def _git_env_with_auth(token: str, askpass_path: str) -> dict:
    """Build an env dict that makes git use our ASKPASS script."""
    env = os.environ.copy()
    env["GIT_ASKPASS"] = askpass_path
    env["GIT_TERMINAL_PROMPT"] = "0"   # never hang waiting for interactive input
    env["GIT_USERNAME"] = "oauth2"     # GitHub accepts oauth2 as username with a PAT
    return env


# ── Sync git operations (run in thread pool) ──────────────────────────────────

def _sync_clone(clone_url: str, dest: str, token: Optional[str]) -> dict:
    """
    Clone a repository.  If a token is provided, injects credentials via
    GIT_ASKPASS so they are never stored in .git/config.
    After clone, the remote URL in .git/config is reset to the clean form.
    """
    _guard(dest)   # reject system paths; dest may not exist yet — that's fine
    askpass = None
    try:
        env = None
        if token:
            askpass = _make_askpass(token)
            env = _git_env_with_auth(token, askpass)

        result = subprocess.run(
            ["git", "clone", "--progress", clone_url, dest],
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "git clone failed").strip()
            raise HTTPException(status_code=500, detail=err)

        # Reset remote URL to clean form (no credentials)
        clean_url = clone_url.split("@")[-1] if "@" in clone_url else clone_url
        if not clean_url.startswith("https://"):
            clean_url = "https://" + clean_url
        subprocess.run(
            ["git", "-C", dest, "remote", "set-url", "origin", clone_url],
            capture_output=True,
        )

        return {"ok": True, "dest": dest, "url": clone_url}

    finally:
        if askpass and Path(askpass).exists():
            Path(askpass).unlink(missing_ok=True)


def _sync_push_to_remote(local_path: str, remote_url: str, branch: str, token: Optional[str]) -> dict:
    """Push to a remote URL using ASKPASS for auth. Never stores credentials."""
    p = _guard(local_path)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {local_path}")
    askpass = None
    try:
        env = None
        if token:
            askpass = _make_askpass(token)
            env = _git_env_with_auth(token, askpass)

        result = subprocess.run(
            ["git", "-C", local_path, "push", remote_url, f"{branch}:{branch}", "--set-upstream"],
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "git push failed").strip()
            raise HTTPException(status_code=500, detail=err)

        return {"ok": True, "pushed": True}

    finally:
        if askpass and Path(askpass).exists():
            Path(askpass).unlink(missing_ok=True)


def _sync_export(
    local_path: str,
    repo_name: str,
    description: str,
    private: bool,
    token: str,
    username: str,
    branch: str,
) -> dict:
    """
    Export a local project to GitHub:
      1. Create the repo on GitHub via API
      2. git init (if not already a repo)
      3. Add remote
      4. git add + commit
      5. git push via ASKPASS (no credentials in URLs/config)
    """
    p = _guard(local_path)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {local_path}")
    # 1. Create repo on GitHub
    repo_data = _github_post(
        "/user/repos",
        token,
        {
            "name": repo_name,
            "description": description,
            "private": private,
            "auto_init": False,
        },
    )
    remote_url = repo_data["clone_url"]

    # 2–5. Local git operations
    local = Path(local_path)
    askpass = _make_askpass(token)
    try:
        env = _git_env_with_auth(token, askpass)

        def run(cmd: list) -> subprocess.CompletedProcess:
            return subprocess.run(
                cmd, cwd=str(local), capture_output=True, text=True, env=env
            )

        # Init if needed — try modern -b flag first, fall back for older git
        if not (local / ".git").exists():
            r = run(["git", "init", "-b", branch])
            if r.returncode != 0:
                run(["git", "init"])   # older git — default branch name doesn't matter here

        run(["git", "add", "."])
        # Commit only if there's something to commit
        status = run(["git", "status", "--porcelain"])
        if status.stdout.strip():
            run(["git", "commit", "-m", "Initial commit from CodeLab"])

        # Set remote (remove old origin if present)
        run(["git", "remote", "remove", "origin"])
        run(["git", "remote", "add", "origin", remote_url])

        push = run(["git", "push", "-u", "origin", branch])
        if push.returncode != 0:
            err = (push.stderr or push.stdout or "git push failed").strip()
            raise HTTPException(status_code=500, detail=err)

        # After export, store clean URL without credentials
        run(["git", "remote", "set-url", "origin", remote_url])

        return {
            "ok": True,
            "repo_url": repo_data["html_url"],
            "clone_url": remote_url,
        }
    finally:
        Path(askpass).unlink(missing_ok=True)


# ── Request models ────────────────────────────────────────────────────────────

class TokenBody(BaseModel):
    token: str


class CloneBody(BaseModel):
    url: str
    dest: str
    token: Optional[str] = None   # optional for public repos


class ExportBody(BaseModel):
    token: str
    local_path: str
    name: str          # repo name — matches GitHubPanel.jsx field
    description: str = ""
    private: bool = False
    branch: str = "main"


class PushBody(BaseModel):
    token: str
    local_path: str
    repo_url: str
    branch: str = "main"


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/auth/status")
async def auth_status():
    """Return stored auth state. Desktop-only: token is returned to the local frontend."""
    data = _load_token()
    if data and data.get("token"):
        return {
            "authenticated": True,
            "user": data.get("user", {}),
            "token": data.get("token", ""),
        }
    return {"authenticated": False}


@router.post("/auth/login")
async def login(body: TokenBody, request: Request):
    """
    Validate a Personal Access Token against the GitHub API and store it.
    One API call — to verify the token is valid and retrieve the username.
    """
    loop = asyncio.get_running_loop()
    # Run the validation in the thread pool (urllib is blocking)
    try:
        user = await loop.run_in_executor(
            request.app.state.thread_pool,
            _github_get,
            "/user",
            body.token,
        )
    except HTTPException as exc:
        if exc.status_code == 401:
            raise HTTPException(status_code=401, detail="Invalid GitHub token")
        raise

    _save_token(body.token, user)
    logger.info("GitHub token stored for user: %s", user.get("login", ""))
    return {"ok": True, "user": user}


@router.post("/auth/logout")
async def logout():
    """Remove the stored GitHub token."""
    _delete_token()
    logger.info("GitHub token removed")
    return {"ok": True}


@router.get("/repos")
async def list_repos(request: Request, token: Optional[str] = None):
    """
    List the authenticated user's repositories (up to 100, sorted by last push).
    Uses the provided token or falls back to the stored token.
    """
    t = token or ""
    if not t:
        data = _load_token()
        t = data.get("token", "") if data else ""
    if not t:
        raise HTTPException(status_code=401, detail="No GitHub token available")

    loop = asyncio.get_running_loop()
    raw = await loop.run_in_executor(
        request.app.state.thread_pool,
        _github_get,
        "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator",
        t,
    )
    repos = [
        {
            "name":        r.get("name", ""),
            "full_name":   r.get("full_name", ""),
            "description": r.get("description") or "",
            "private":     r.get("private", False),
            "clone_url":   r.get("clone_url", ""),
            "html_url":    r.get("html_url", ""),
            "language":    r.get("language") or "",
            "stars":       r.get("stargazers_count", 0),
            "forks":       r.get("forks_count", 0),
            "pushed_at":   r.get("pushed_at", ""),
        }
        for r in (raw if isinstance(raw, list) else [])
    ]
    return {"repos": repos, "count": len(repos)}


@router.get("/clone")
async def clone_repo(url: str, dest: str, request: Request):
    """
    Import: clone a GitHub repository to a local path.
    Uses the stored token for private repos; works without token for public repos.
    """
    token_data = _load_token()
    token = token_data["token"] if token_data else None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        request.app.state.thread_pool,
        _sync_clone,
        url,
        dest,
        token,
    )


@router.post("/repo/create-and-push")
async def export_project(body: ExportBody, request: Request):
    """
    Export: create a new GitHub repository and push the local project to it.
    This is the only place we call the GitHub API to create a resource.
    """
    # Validate token first (fast, in-band, uses stored username if available)
    loop = asyncio.get_running_loop()
    try:
        user = await loop.run_in_executor(
            request.app.state.thread_pool,
            _github_get,
            "/user",
            body.token,
        )
    except HTTPException as exc:
        if exc.status_code == 401:
            raise HTTPException(status_code=401, detail="Invalid GitHub token")
        raise

    username = user.get("login", "")
    return await loop.run_in_executor(
        request.app.state.thread_pool,
        _sync_export,
        body.local_path,
        body.name,
        body.description,
        body.private,
        body.token,
        username,
        body.branch,
    )


@router.post("/repo/push")
async def push_to_existing(body: PushBody, request: Request):
    """Push the local project to an existing GitHub remote."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        request.app.state.thread_pool,
        _sync_push_to_remote,
        body.local_path,
        body.repo_url,
        body.branch,
        body.token,
    )
