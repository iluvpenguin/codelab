"""
pytest configuration / shared fixtures.
"""
import base64
import os
import sys

# ── Environment must be set BEFORE server is imported ─────────────────────────
# ANTHROPIC_API_KEY: dummy value — AI endpoints are not exercised by the test suite.
os.environ.setdefault("ANTHROPIC_API_KEY",  "test-key-not-real")
# ENCRYPTION_KEY: generate a fresh random key per test run so no real key
# ever needs to be hard-coded here or committed to version control.
os.environ.setdefault("ENCRYPTION_KEY", base64.b64encode(os.urandom(32)).decode())
os.environ.setdefault("TCP_PORT",           "0")   # Disable diagnostic TCP server during tests
os.environ.setdefault("CORS_ORIGINS",       "*")
os.environ.setdefault("RUN_RATE",           "100")
os.environ.setdefault("RUN_PER",            "60")
os.environ.setdefault("PORT",               "58484")  # avoid clashing with live dev server

# Make backend importable when pytest is run from the tests/ subdir
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi.testclient import TestClient
from server import app


@pytest.fixture(scope="module")
def client():
    """
    Session-scoped FastAPI test client.

    Uses the context-manager form so that the app lifespan runs:
      - ThreadPoolExecutor is created
      - Rate limiter is created
      - TCPCollabServer starts (port 8002)
      - Encryption key is loaded

    Yields the TestClient for the duration of the module, then shuts down.
    """
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
