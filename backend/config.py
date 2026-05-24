"""
Application configuration.

Settings.from_env() reads every environment variable once at startup and
returns a frozen, typed Settings object that is attached to app.state.
Routers never call os.getenv() directly — they read from request.app.state.settings.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("codelab.config")


@dataclass(frozen=True)
class Settings:
    """
    Immutable, typed application configuration.

    Construct via Settings.from_env() — never instantiate directly in
    production code so defaults and validation stay in one place.
    """

    # AI assistance panel — optional; routes return 503 when blank
    anthropic_api_key: str

    # HTTP server
    port: int
    cors_origins: list[str]

    # Token-bucket rate limit applied to /api/files/run
    run_rate: int
    run_per: float

    # Fallback path for the GitHub PAT when the system keyring is unavailable
    github_token_path: Path

    # AES-256-GCM encryption key (base64-encoded 32 bytes).
    # Leave blank to auto-generate at startup (key printed to log).
    encryption_key: str

    # Raw TCP status server port (set to 0 to disable)
    tcp_port: int

    # ── Factory ───────────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "Settings":
        """
        Read and validate all environment variables.
        Never raises — falls back to safe defaults and logs warnings.
        """
        # Port validation
        raw_port = os.getenv("PORT", "58483")
        try:
            port = int(raw_port)
            if not (1024 <= port <= 65535):
                raise ValueError("out of range")
        except ValueError:
            logger.error(
                "PORT=%r is not a valid port (1024–65535). Falling back to 58483.",
                raw_port,
            )
            port = 58483

        # CORS origins
        cors_raw = os.getenv("CORS_ORIGINS", "*").strip()
        cors_origins = (
            ["*"]
            if cors_raw == "*"
            else [o.strip() for o in cors_raw.split(",") if o.strip()]
        )

        # TCP port validation
        raw_tcp = os.getenv("TCP_PORT", "8001")
        try:
            tcp_port = int(raw_tcp)
            if tcp_port != 0 and not (1024 <= tcp_port <= 65535):
                raise ValueError("out of range")
        except ValueError:
            logger.error("TCP_PORT=%r invalid — falling back to 8001", raw_tcp)
            tcp_port = 8001

        return cls(
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
            port=port,
            cors_origins=cors_origins,
            run_rate=int(os.getenv("RUN_RATE", "10")),
            run_per=float(os.getenv("RUN_PER", "60")),
            github_token_path=Path.home() / ".codelab" / "github_token.json",
            encryption_key=os.getenv("ENCRYPTION_KEY", "").strip(),
            tcp_port=tcp_port,
        )

    # ── Computed properties ───────────────────────────────────────────────────

    @property
    def ai_configured(self) -> bool:
        """True when an Anthropic API key that looks valid is present."""
        return len(self.anthropic_api_key) > 10

    def status_report(self) -> dict[str, str]:
        """
        Human-readable subsystem status dict surfaced on the /api/ health
        endpoint. Values are strings so they can be logged and JSON-serialised
        without extra conversion.
        """
        return {
            "anthropic_api": (
                "configured"
                if self.ai_configured
                else "not configured — AI panel will return 503"
            ),
            "port": str(self.port),
            "github_token": (
                "stored"
                if self.github_token_path.exists()
                else "not stored — GitHub import/export will prompt for token"
            ),
            "encryption":  "key from env" if self.encryption_key else "auto-generated (set ENCRYPTION_KEY to persist)",
            "tcp_status":  f"port {self.tcp_port}" if self.tcp_port else "disabled",
        }
