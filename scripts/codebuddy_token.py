#!/usr/bin/env python3
"""Print the CodeBuddy (CodeBuddy CN IDE) access token for Hermes' ``key_cmd``.

CodeBuddy CN has no static API key: the IDE signs in with an OAuth session and
refreshes it on its own. The session lives in the IDE's VS Code secret storage
(``state.vscdb`` + Electron ``safeStorage``, which is DPAPI on Windows), so the
only stable "credential" is the encrypted blob. This helper decrypts it and
prints ``{"access_token": ..., "expires_in": ...}`` — the JSON shape
``agent/command_token_source.py`` understands — so Hermes can call CodeBuddy's
OpenAI-compatible gateway (``https://copilot.tencent.com/v2``) through the
normal ``providers:`` entry.

The IDE keeps the token fresh, so re-reading the blob (Hermes caches for 15 min
or until ``expires_in`` runs out) always sees the current one. No refresh call
is made here on purpose: refreshing rotates the refresh token and would sign
the IDE out.

Usage (as a provider ``key_cmd``)::

    python C:/Users/<you>/grok/minAgent/scripts/codebuddy_token.py

Override the IDE data dir with ``CODEBUDDY_CN_HOME`` (defaults to
``%APPDATA%\\CodeBuddy CN``). Exits non-zero with a one-line error on stderr
when the session is missing or expired.
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import sqlite3
import sys
import time
from ctypes import wintypes
from pathlib import Path

STATE_DB = Path("User") / "globalStorage" / "state.vscdb"
# Every secret key the extension writes for the signed-in session, e.g.
# ``secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}``
SESSION_KEY_LIKE = "%accessToken%"


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _die(msg: str, code: int = 1) -> "NoReturn":  # type: ignore[name-defined]
    print(f"codebuddy_token: {msg}", file=sys.stderr)
    raise SystemExit(code)


def _ide_home() -> Path:
    override = os.environ.get("CODEBUDDY_CN_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "CodeBuddy CN"


def _dpapi_unprotect(data: bytes) -> bytes:
    """CryptUnprotectData for the current Windows user."""
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _safe_storage_key(home: Path) -> bytes:
    """AES-256 key Electron's safeStorage wraps with DPAPI (``os_crypt.encrypted_key``)."""
    local_state = home / "Local State"
    try:
        payload = json.loads(local_state.read_text(encoding="utf-8"))
    except FileNotFoundError:
        _die(f"no Electron 'Local State' under {home}; is the CodeBuddy CN IDE installed for this user?")
    except (OSError, ValueError) as exc:
        _die(f"cannot read {local_state}: {exc}")
    blob = payload.get("os_crypt", {}).get("encrypted_key", "")
    if not blob:
        _die(f"{local_state} has no os_crypt.encrypted_key (unsupported Electron build)")
    raw = base64.b64decode(blob)
    if not raw.startswith(b"DPAPI"):
        _die("os_crypt.encrypted_key is not DPAPI-wrapped; unsupported platform")
    return _dpapi_unprotect(raw[5:])


def _decrypt_secret(key: bytes, stored: bytes) -> bytes:
    """Decrypt one ``v10``-prefixed AES-256-GCM blob written by Electron safeStorage."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not stored.startswith(b"v10") or len(stored) < 15 + 16:
        _die("secret blob is not in the expected 'v10' AES-GCM format")
    return AESGCM(key).decrypt(stored[3:15], stored[15:], None)


def _session_payload(home: Path) -> dict:
    state_db = home / STATE_DB
    if not state_db.is_file():
        _die(f"no CodeBuddy IDE state database at {state_db}")
    key = _safe_storage_key(home)
    try:
        # Immutable open: the IDE holds a write lock on this file while running.
        con = sqlite3.connect(f"file:{state_db}?mode=ro&immutable=1", uri=True)
        rows = con.execute(
            "SELECT key, value FROM ItemTable WHERE key LIKE ?", (SESSION_KEY_LIKE,)
        ).fetchall()
    except sqlite3.Error as exc:
        _die(f"cannot read {state_db}: {exc}")
    finally:
        try:
            con.close()
        except Exception:
            pass
    if not rows:
        _die("no CodeBuddy sign-in session found — open CodeBuddy CN and log in first")
    # Several keys can match ("...accessTokencn", "...accessTokenintl"); prefer the CN one.
    rows.sort(key=lambda row: 0 if str(row[0]).endswith("cn") else 1)
    errors: list[str] = []
    for _stored_key, value in rows:
        try:
            raw = value if isinstance(value, bytes) else str(value).encode()
            envelope = json.loads(raw.decode("utf-8", "replace"))
            plain = _decrypt_secret(key, bytes(envelope["data"]))
            session = json.loads(plain)
            if isinstance(session.get("auth"), dict):
                return session["auth"]
            errors.append("decrypted session has no 'auth' block")
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 - report, then try the next key
            errors.append(f"{type(exc).__name__}: {exc}")
    _die("cannot decrypt the CodeBuddy session (" + "; ".join(errors) + ")")


def main() -> int:
    auth = _session_payload(_ide_home())
    token = str(auth.get("accessToken") or "").strip()
    if not token:
        _die("session has no accessToken — sign in to CodeBuddy CN again")
    expires_at_ms = auth.get("expiresAt")
    expires_in = None
    if isinstance(expires_at_ms, (int, float)) and expires_at_ms > 0:
        remaining = int(expires_at_ms / 1000 - time.time())
        if remaining <= 0:
            _die("CodeBuddy access token has expired — open CodeBuddy CN so it refreshes the session")
        expires_in = remaining
    print(json.dumps({"access_token": token, **({"expires_in": expires_in} if expires_in else {})}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
