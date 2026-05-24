"""
AI assistance router — Claude-powered code assistant.

Startup behaviour
-----------------
On server start, _check_api_key() is called once.  If the key is missing or
looks malformed, a clear warning is logged and the module-level flag
_AI_AVAILABLE is set to False.  Every route checks this flag and returns
503 immediately rather than crashing inside the stream generator.

Error handling
--------------
anthropic.AuthenticationError  → 401 (bad key)
anthropic.RateLimitError       → 429 (quota exceeded)
anthropic.APIStatusError       → mirrors the upstream status code
anthropic.APIConnectionError   → 502 (can't reach Anthropic)
Any other exception            → 500 (unexpected)
"""

import logging
import os
from typing import Generator, Optional

import anthropic
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("codelab.ai")

MODEL = "claude-sonnet-4-5"

# Token budget: refuse requests whose context would exceed this.
# Keeps costs predictable and prevents accidental huge payloads.
_MAX_CONTEXT_CHARS = 80_000   # ≈ 20k tokens

SYSTEM_PROMPT = """\
You are a senior software engineer and expert code assistant embedded in CodeLab Desktop.

Guidelines:
- Provide clear, concise, production-quality code suggestions.
- Explain your reasoning briefly before showing code.
- When fixing bugs, identify the root cause first.
- Format code blocks with the correct language tag.
- Prefer modern idioms and language best practices.
- Keep answers focused and actionable — no filler text.
- If context is insufficient to answer confidently, say so and ask for clarification.

Never refuse a legitimate coding request.\
"""

# ── Startup key check ─────────────────────────────────────────────────────────

_AI_AVAILABLE: bool = False
_ANTHROPIC_CLIENT: Optional[anthropic.Anthropic] = None


def _check_api_key() -> None:
    """
    Called once at import time (and thus at server startup via server.py).
    Sets _AI_AVAILABLE and initialises _ANTHROPIC_CLIENT if the key is present.
    """
    global _AI_AVAILABLE, _ANTHROPIC_CLIENT
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()

    if not key:
        logger.warning(
            "ANTHROPIC_API_KEY is not set. "
            "POST /api/ai/ask will return 503 until it is configured."
        )
        _AI_AVAILABLE = False
        return

    # Basic sanity check — Anthropic keys start with "sk-ant-"
    if not key.startswith("sk-ant-"):
        logger.warning(
            "ANTHROPIC_API_KEY does not look like a valid Anthropic key "
            "(expected prefix 'sk-ant-'). AI panel may not work."
        )

    try:
        _ANTHROPIC_CLIENT = anthropic.Anthropic(api_key=key)
        _AI_AVAILABLE = True
        logger.info("Anthropic client initialised (model: %s)", MODEL)
    except Exception as exc:
        logger.error("Failed to initialise Anthropic client: %s", exc)
        _AI_AVAILABLE = False


_check_api_key()


# ── Models ────────────────────────────────────────────────────────────────────

class AskRequest(BaseModel):
    question: str
    file: Optional[str] = None        # current file path (for context label)
    selection: Optional[str] = None   # selected code in editor
    language: Optional[str] = None    # detected language


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post("/ask")
async def ask_ai(req: AskRequest) -> StreamingResponse:
    """
    Stream a response from Claude.
    The client should read the response body as a text stream.
    """
    if not _AI_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail=(
                "AI assistance is not configured. "
                "Set ANTHROPIC_API_KEY in the backend .env file and restart the server."
            ),
        )

    # Build the user message, respecting the context size budget
    parts: list[str] = []
    if req.file:
        parts.append(f"**File:** `{req.file}`")
    if req.language:
        parts.append(f"**Language:** {req.language}")
    if req.selection:
        lang = req.language or ""
        parts.append(f"**Selected code:**\n```{lang}\n{req.selection}\n```")
    parts.append(f"**Question:** {req.question}")

    user_message = "\n\n".join(parts)

    if len(user_message) > _MAX_CONTEXT_CHARS:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Request context is too large ({len(user_message):,} chars). "
                f"Maximum is {_MAX_CONTEXT_CHARS:,} chars. "
                "Try selecting a smaller code snippet."
            ),
        )

    def _stream() -> Generator[str, None, None]:
        """Generator that streams text chunks from Claude."""
        assert _ANTHROPIC_CLIENT is not None  # guarded by _AI_AVAILABLE check

        try:
            with _ANTHROPIC_CLIENT.messages.stream(
                model=MODEL,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            ) as stream:
                for chunk in stream.text_stream:
                    yield chunk

        except anthropic.AuthenticationError:
            logger.error("Anthropic authentication failed — check ANTHROPIC_API_KEY")
            yield "\n\n[Error: Authentication failed. Check your API key in .env]"

        except anthropic.RateLimitError:
            logger.warning("Anthropic rate limit hit")
            yield "\n\n[Error: Rate limit reached. Please wait a moment and try again]"

        except anthropic.APIStatusError as exc:
            logger.error("Anthropic API error %d: %s", exc.status_code, exc.message)
            yield f"\n\n[Error: Anthropic API returned status {exc.status_code}]"

        except anthropic.APIConnectionError as exc:
            logger.error("Could not reach Anthropic API: %s", exc)
            yield "\n\n[Error: Could not reach the Anthropic API. Check your network connection]"

        except Exception as exc:
            logger.exception("Unexpected error during AI stream")
            yield "\n\n[Error: An unexpected error occurred. Check server logs]"

    return StreamingResponse(_stream(), media_type="text/plain")
