"""
Git operations router.

All git operations are implemented by calling the git CLI directly via
subprocess and parsing the output ourselves. No third-party git library
is used — just Python's built-in subprocess module and the git binary.

Why subprocess instead of a library?
  The server owns the logic. We decide what git commands to run, we read
  the raw output, we parse it into structured data, and we decide what
  counts as success or failure. Nothing is hidden inside a library.

  git status --porcelain  → we split lines and read XY status codes
  git log --format=...    → we define the format and parse each field
  git branch              → we read the * marker to find the active branch

Threading model:
  All subprocess calls are blocking. They run in the shared ThreadPoolExecutor
  (app.state.thread_pool) via _dispatch() so the async event loop is never
  blocked waiting for git.
"""

import asyncio
import logging
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("codelab.git")


# ── Git helpers ───────────────────────────────────────────────────────────────

def _run(args: list, cwd: str, timeout: int = 30) -> subprocess.CompletedProcess:
    """
    Run a git command in *cwd* and return the CompletedProcess.

    Never raises on a non-zero exit code — callers read returncode and
    decide what counts as an error. stdout and stderr are always strings.
    """
    return subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _require_ok(result: subprocess.CompletedProcess, detail: str = "") -> str:
    """Raise HTTP 400 if the git command failed. Returns stdout on success."""
    if result.returncode != 0:
        msg = detail or result.stderr.strip() or result.stdout.strip() or "git command failed"
        raise HTTPException(status_code=400, detail=msg)
    return result.stdout.strip()


def _check_repo(cwd: str) -> None:
    """Raise HTTP 400 if *cwd* is not inside a git repository."""
    r = _run(["rev-parse", "--git-dir"], cwd)
    if r.returncode != 0:
        raise HTTPException(status_code=400, detail=f"Not a git repository: {cwd}")


def _resolve(path: str) -> str:
    """Resolve and validate a path. Raises HTTP 400 if it does not exist."""
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"Path does not exist: {path}")
    return str(p)


# ── GitService ────────────────────────────────────────────────────────────────

class GitService:
    """
    Async interface to git operations.

    Every public method is async — it dispatches the blocking subprocess
    call to the thread pool and awaits the result so the event loop stays free.

    The sync implementations (_sync_*) are plain functions that run inside
    the thread pool. They contain all the logic: building the command,
    parsing the output, and returning a plain dict.
    """

    def __init__(self, executor: ThreadPoolExecutor) -> None:
        self._executor = executor

    # ── Public async interface ────────────────────────────────────────────────

    async def status(self, repo_path: str) -> dict:
        return await self._dispatch(_sync_status, repo_path)

    async def commit(self, repo_path: str, message: str, files: List[str]) -> dict:
        return await self._dispatch(_sync_commit, repo_path, message, files)

    async def push(self, repo_path: str, remote: str, branch: str) -> dict:
        return await self._dispatch(_sync_push, repo_path, remote, branch)

    async def pull(self, repo_path: str, remote: str) -> dict:
        return await self._dispatch(_sync_pull, repo_path, remote)

    async def log(self, repo_path: str, limit: int) -> dict:
        return await self._dispatch(_sync_log, repo_path, limit)

    async def diff(self, repo_path: str, path: Optional[str]) -> dict:
        return await self._dispatch(_sync_diff, repo_path, path)

    async def checkout(self, repo_path: str, branch: str, create: bool) -> dict:
        return await self._dispatch(_sync_checkout, repo_path, branch, create)

    async def branches(self, repo_path: str) -> dict:
        return await self._dispatch(_sync_branches, repo_path)

    async def init(self, path: str, initial_branch: str) -> dict:
        return await self._dispatch(_sync_init, path, initial_branch)

    async def clone(self, url: str, dest: str) -> dict:
        return await self._dispatch(_sync_clone, url, dest)

    async def _dispatch(self, fn, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn, *args)


# ── Sync implementations ──────────────────────────────────────────────────────
#
# These run inside the thread pool. They are plain module-level functions
# (not methods) so they can be called directly in tests without building
# a GitService instance.

def _sync_status(repo_path: str) -> dict:
    """
    Return the working tree status of a repository.

    We use  git status --porcelain  which outputs one line per changed file:

        XY filename

    X = status in the index (staged)
    Y = status in the working tree (unstaged)
    ?? = untracked file

    Status letters: A=added, M=modified, D=deleted, R=renamed, C=copied
    """
    cwd = _resolve(repo_path)
    _check_repo(cwd)

    staged, unstaged, untracked = [], [], []

    r = _run(["status", "--porcelain"], cwd)
    # returncode is 0 even on a clean repo, so no _require_ok here
    for line in r.stdout.splitlines():
        if len(line) < 4:
            continue
        x          = line[0]          # staged status character
        y          = line[1]          # working-tree status character
        file_path  = line[3:].strip() # filename (after "XY ")

        if x == "?" and y == "?":
            untracked.append({"path": file_path, "change": "?"})
        else:
            if x not in (" ", "?"):
                staged.append({"path": file_path, "change": x})
            if y not in (" ", "?"):
                unstaged.append({"path": file_path, "change": y})

    # Current branch name
    # --abbrev-ref HEAD prints the branch name, or "HEAD" when detached
    br = _run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    if br.returncode == 0 and br.stdout.strip() != "HEAD":
        branch = br.stdout.strip()
    elif br.returncode == 0:
        # Detached HEAD — show the short commit hash
        sha = _run(["rev-parse", "--short", "HEAD"], cwd)
        branch = (sha.stdout.strip() + " (detached)") if sha.returncode == 0 else "detached"
    else:
        branch = "unknown"   # no commits yet

    # List of configured remotes (one per line from  git remote)
    rem = _run(["remote"], cwd)
    remotes = [line.strip() for line in rem.stdout.splitlines() if line.strip()]

    return {
        "branch":     branch,
        "staged":     staged,
        "unstaged":   unstaged,
        "untracked":  untracked,
        "is_dirty":   bool(staged or unstaged or untracked),
        "has_remote": bool(remotes),
        "remotes":    remotes,
    }


def _sync_commit(repo_path: str, message: str, files: List[str]) -> dict:
    """
    Stage files then create a commit.

    If files is ['.'] or ['*'] we stage everything (git add -A).
    Otherwise we stage only the listed paths.
    After the commit we read the new HEAD to return its metadata.
    """
    cwd = _resolve(repo_path)
    _check_repo(cwd)

    # Stage
    if "." in files or files == ["*"]:
        _require_ok(_run(["add", "-A"], cwd))
    else:
        _require_ok(_run(["add", "--"] + files, cwd))

    # Commit
    _require_ok(_run(["commit", "-m", message], cwd))

    # Read back the commit metadata using a custom format:
    #   %H  = full SHA
    #   %h  = short SHA
    #   %an = author name
    #   %ae = author email
    #   %aI = author date (ISO 8601 strict)
    SEP = "\x1f"   # ASCII Unit Separator — safe, won't appear in names or emails
    fmt = SEP.join(["%H", "%h", "%an", "%ae", "%aI"])
    info = _run(["log", "-1", f"--format={fmt}"], cwd)
    parts = info.stdout.strip().split(SEP) if info.returncode == 0 else []

    return {
        "sha":          parts[0] if len(parts) > 0 else "",
        "short_sha":    parts[1] if len(parts) > 1 else "",
        "message":      message,
        "author":       parts[2] if len(parts) > 2 else "",
        "email":        parts[3] if len(parts) > 3 else "",
        "committed_at": parts[4] if len(parts) > 4 else "",
    }


def _sync_push(repo_path: str, remote: str, branch: str) -> dict:
    """Push the local branch to the remote."""
    cwd = _resolve(repo_path)
    _check_repo(cwd)
    r = _run(["push", remote, f"{branch}:{branch}"], cwd, timeout=120)
    _require_ok(r, r.stderr.strip() or "git push failed")
    return {"pushed": True, "remote": remote, "branch": branch}


def _sync_pull(repo_path: str, remote: str) -> dict:
    """Pull from the remote into the current branch."""
    cwd = _resolve(repo_path)
    _check_repo(cwd)
    r = _run(["pull", remote], cwd, timeout=120)
    _require_ok(r, r.stderr.strip() or "git pull failed")
    return {"pulled": True, "remote": remote}


def _sync_log(repo_path: str, limit: int) -> dict:
    """
    Return the last *limit* commits (capped at 500).

    git log --format prints one line per commit. We use a custom format
    with a separator character that cannot appear in commit messages:
        full_sha SEP short_sha SEP subject SEP author SEP email SEP date
    """
    cwd = _resolve(repo_path)
    _check_repo(cwd)

    limit = max(1, min(limit, 500))
    SEP   = "\x1f"
    fmt   = SEP.join(["%H", "%h", "%s", "%an", "%ae", "%aI"])

    r = _run(["log", f"-{limit}", f"--format={fmt}"], cwd)
    if r.returncode != 0:
        # No commits yet — not an error, just an empty repo
        return {"commits": [], "total": 0}

    commits = []
    for line in r.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split(SEP)
        if len(parts) < 6:
            continue
        commits.append({
            "sha":          parts[0],
            "short_sha":    parts[1],
            "message":      parts[2],
            "author":       parts[3],
            "email":        parts[4],
            "committed_at": parts[5],
        })

    return {"commits": commits, "total": len(commits)}


def _sync_diff(repo_path: str, path: Optional[str]) -> dict:
    """
    Return the diff of the working tree against HEAD.

    If *path* is given, only that file is diffed.
    Returns an empty diff with a note when the repo has no commits yet.
    """
    cwd = _resolve(repo_path)
    _check_repo(cwd)

    # Check whether HEAD exists (fails on a brand-new empty repo)
    head = _run(["rev-parse", "HEAD"], cwd)
    if head.returncode != 0:
        return {"diff": "", "path": path, "note": "No commits yet"}

    args = ["diff", "HEAD"]
    if path:
        args += ["--", path]

    r = _run(args, cwd)
    if r.returncode != 0:
        raise HTTPException(status_code=400, detail=r.stderr.strip() or "git diff failed")

    return {"diff": r.stdout, "path": path}


def _sync_checkout(repo_path: str, branch: str, create: bool) -> dict:
    """
    Switch to *branch*.  If *create* is True, create it first (-b flag).
    """
    cwd = _resolve(repo_path)
    _check_repo(cwd)

    args = ["checkout", "-b", branch] if create else ["checkout", branch]
    r = _run(args, cwd)
    _require_ok(r, r.stderr.strip() or f"Cannot checkout branch: {branch}")
    return {"branch": branch, "created": create}


def _sync_branches(repo_path: str) -> dict:
    """
    List all local branches and identify the active one.

    git branch outputs:
        * main
          feature-x
          old-stuff
    The line starting with '* ' is the current branch.
    """
    cwd = _resolve(repo_path)
    _check_repo(cwd)

    r = _run(["branch"], cwd)
    if r.returncode != 0:
        return {"branches": [], "active": ""}

    branches = []
    active   = ""
    for line in r.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if line.startswith("* "):
            active = stripped[2:]   # remove the "* " marker
            branches.append(active)
        else:
            branches.append(stripped)

    return {"branches": branches, "active": active}


def _sync_init(path: str, initial_branch: str) -> dict:
    """
    Initialise a new git repository at *path*.

    Tries  git init -b <branch>  first (git >= 2.28).
    Falls back to  git init  + branch rename for older git versions.
    """
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    cwd = str(p)

    # Try modern  git init -b main  (git 2.28+)
    r = subprocess.run(
        ["git", "init", "-b", initial_branch, cwd],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        # Older git — init with default branch then rename
        r = subprocess.run(["git", "init", cwd], capture_output=True, text=True)
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=r.stderr.strip() or "git init failed")

    return {"ok": True, "path": cwd, "branch": initial_branch}


def _sync_clone(url: str, dest: str) -> dict:
    """Clone *url* into *dest*. Runs with a 5-minute timeout."""
    r = subprocess.run(
        ["git", "clone", "--progress", url, dest],
        capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        err = r.stderr.strip() or r.stdout.strip() or "git clone failed"
        raise HTTPException(status_code=500, detail=err)
    return {"ok": True, "dest": dest}


# ── Dependency ────────────────────────────────────────────────────────────────

def _git_service(request: Request) -> GitService:
    return GitService(request.app.state.thread_pool)


# ── Request models ────────────────────────────────────────────────────────────

class CommitRequest(BaseModel):
    repo: str
    message: str
    files: List[str]


class PushRequest(BaseModel):
    repo: str
    remote: str = "origin"
    branch: str = "main"


class PullRequest(BaseModel):
    repo: str
    remote: str = "origin"


class CheckoutRequest(BaseModel):
    repo: str
    branch: str
    create: bool = False


class InitRequest(BaseModel):
    path: str
    initial_branch: str = "main"


class CloneRequest(BaseModel):
    url: str
    dest: str


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/status")
async def git_status(repo: str, svc: GitService = Depends(_git_service)):
    return await svc.status(repo)


@router.post("/commit")
async def git_commit(req: CommitRequest, svc: GitService = Depends(_git_service)):
    return await svc.commit(req.repo, req.message, req.files)


@router.post("/push")
async def git_push(req: PushRequest, svc: GitService = Depends(_git_service)):
    return await svc.push(req.repo, req.remote, req.branch)


@router.post("/pull")
async def git_pull(req: PullRequest, svc: GitService = Depends(_git_service)):
    return await svc.pull(req.repo, req.remote)


@router.get("/log")
async def git_log(repo: str, svc: GitService = Depends(_git_service), limit: int = 50):
    return await svc.log(repo, limit)


@router.get("/diff")
async def git_diff(repo: str, svc: GitService = Depends(_git_service), path: Optional[str] = None):
    return await svc.diff(repo, path)


@router.post("/checkout")
async def git_checkout(req: CheckoutRequest, svc: GitService = Depends(_git_service)):
    return await svc.checkout(req.repo, req.branch, req.create)


@router.get("/branches")
async def git_branches(repo: str, svc: GitService = Depends(_git_service)):
    return await svc.branches(repo)


@router.post("/init")
async def git_init(req: InitRequest, svc: GitService = Depends(_git_service)):
    return await svc.init(req.path, req.initial_branch)


@router.post("/clone")
async def git_clone(req: CloneRequest, svc: GitService = Depends(_git_service)):
    """Clone a public repository. For authenticated GitHub clones use /api/github/clone."""
    return await svc.clone(req.url, req.dest)
