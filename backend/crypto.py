"""
AES-256-GCM Encryption Service
================================
Provides symmetric authenticated encryption for sensitive files stored on disk.

Algorithm: AES-256-GCM
  - AES   — Advanced Encryption Standard (block cipher)
  - 256   — 256-bit key (32 bytes), the strongest AES variant
  - GCM   — Galois/Counter Mode: provides BOTH confidentiality AND integrity.
            Any bit-flip in the ciphertext is detected on decryption (raises
            InvalidTag) — unlike older modes like CBC which only hide data.

Wire format written to disk:
  ┌────────────────┬──────────────────────────────────────────┐
  │  12-byte nonce │  ciphertext  (N bytes)  +  16-byte tag   │
  └────────────────┴──────────────────────────────────────────┘
  The nonce is randomly generated per call so identical plaintexts
  always produce different ciphertexts (semantic security).

Key management:
  The 32-byte key is loaded from the ENCRYPTION_KEY env var (base64).
  If absent, a temporary key is generated at startup and logged so the
  operator can copy it into .env to survive restarts.

Usage:
  svc = EncryptionService.from_env()

  # Encrypt file content before writing to disk
  blob = svc.encrypt_text("secret content")
  Path("notes.codelab.enc").write_bytes(blob)

  # Decrypt when reading
  blob  = Path("notes.codelab.enc").read_bytes()
  plain = svc.decrypt_text(blob)
"""

import base64
import logging
import os

from cryptography.exceptions import InvalidTag  # noqa: F401 — re-exported for callers
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger("codelab.crypto")

_KEY_BYTES   = 32   # 256-bit key
_NONCE_BYTES = 12   # 96-bit nonce — NIST SP 800-38D recommended size for GCM
_TAG_BYTES   = 16   # GCM authentication tag (appended by AESGCM automatically)


class EncryptionService:
    """
    AES-256-GCM symmetric encryption / decryption.

    One instance is created at server startup and attached to
    app.state.encryption so every router can reach it without
    importing a global.
    """

    def __init__(self, key: bytes) -> None:
        if len(key) != _KEY_BYTES:
            raise ValueError(
                f"AES-256 key must be exactly {_KEY_BYTES} bytes, got {len(key)}"
            )
        self._aesgcm = AESGCM(key)
        self._key    = key

    # ── Factory ───────────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "EncryptionService":
        """
        Build an EncryptionService from the ENCRYPTION_KEY env var.

        ENCRYPTION_KEY must be a base64-encoded 32-byte string.
        If the variable is absent a fresh random key is generated and its
        base64 value is logged at WARNING level so the operator can persist
        it in .env.
        """
        raw = os.getenv("ENCRYPTION_KEY", "").strip()
        if raw:
            try:
                key = base64.b64decode(raw)
                logger.info("AES-256-GCM key loaded from ENCRYPTION_KEY (%d bytes)", len(key))
            except Exception as exc:
                logger.error(
                    "ENCRYPTION_KEY is not valid base64 (%s) -- generating a new key", exc
                )
                key = os.urandom(_KEY_BYTES)
        else:
            key = os.urandom(_KEY_BYTES)
            logger.warning(
                "ENCRYPTION_KEY not set -- generated a temporary key: %s"
                " -- add ENCRYPTION_KEY=<value> to .env to persist across restarts.",
                base64.b64encode(key).decode(),
            )
        return cls(key)

    # ── Core encrypt / decrypt ────────────────────────────────────────────────

    def encrypt(self, plaintext: bytes) -> bytes:
        """
        Encrypt *plaintext* with AES-256-GCM.

        Returns:  nonce (12 B)  ||  ciphertext  ||  auth tag (16 B)

        A fresh random nonce is generated on every call, so calling
        encrypt() twice with the same plaintext produces different output.
        """
        nonce      = os.urandom(_NONCE_BYTES)          # cryptographically random
        ciphertext = self._aesgcm.encrypt(nonce, plaintext, None)  # aad=None (positional)
        return nonce + ciphertext                       # prepend nonce for storage

    def decrypt(self, data: bytes) -> bytes:
        """
        Decrypt *data* produced by :meth:`encrypt`.

        Raises:
          InvalidTag  — ciphertext was tampered with, or the key is wrong.
          ValueError  — data is too short to contain even the nonce.
        """
        if len(data) < _NONCE_BYTES + _TAG_BYTES:
            raise ValueError(
                f"Encrypted blob too short ({len(data)} B); "
                f"minimum is {_NONCE_BYTES + _TAG_BYTES} B"
            )
        nonce      = data[:_NONCE_BYTES]
        ciphertext = data[_NONCE_BYTES:]
        return self._aesgcm.decrypt(nonce, ciphertext, None)   # aad=None (positional)

    # ── Convenience text wrappers ─────────────────────────────────────────────

    def encrypt_text(self, text: str) -> bytes:
        """Encode *text* as UTF-8 then encrypt.  Returns raw bytes for disk."""
        return self.encrypt(text.encode("utf-8"))

    def decrypt_text(self, data: bytes) -> str:
        """Decrypt *data* and decode the result as UTF-8."""
        return self.decrypt(data).decode("utf-8")

    # ── Introspection ─────────────────────────────────────────────────────────

    @property
    def key_b64(self) -> str:
        """Base64 representation of the active key — safe to store in .env."""
        return base64.b64encode(self._key).decode()

    def __repr__(self) -> str:
        return f"<EncryptionService AES-256-GCM key={self.key_b64[:8]}…>"
