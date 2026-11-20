"""Host-side lifecycle for the local gateway.

The gateway itself never decides when to die. A CLI or GUI process that needs
the local gateway registers itself here on start and releases itself on exit.
The last live host sends the normal ``stop gateway`` request and waits for the
gateway process to disappear before that host exits (Unix-style shutdown).

Only hosts write this registry; the gateway never reads it. Entries carry
``(pid, start_time)`` so a recycled PID is not mistaken for a live host.
"""
from __future__ import annotations

import atexit
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

HOST_FILE = "gateway-hosts.json"
LOCK_FILE = "gateway-hosts.lock"

CLI = "cli"
GUI = "gui"
HOST_KINDS = (CLI, GUI)


def _home(home: Optional[str | Path] = None) -> Path:
    if home is not None:
        return Path(home)
    from hermes_constants import get_hermes_home

    return get_hermes_home()


def _paths(home: Optional[str | Path] = None) -> tuple[Path, Path]:
    root = _home(home)
    return root / HOST_FILE, root / LOCK_FILE


def process_start_time(pid: Optional[int] = None) -> Optional[float]:
    """Creation time of *pid* (default: this process), or None if unavailable."""
    try:
        import psutil

        return float(psutil.Process(pid or os.getpid()).create_time())
    except Exception:
        return None


def _pid_alive(pid: Any, start_time: Any = None) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        import psutil

        proc = psutil.Process(pid)
        if start_time is not None:
            try:
                if abs(float(proc.create_time()) - float(start_time)) > 2.0:
                    return False
            except (TypeError, ValueError):
                return False
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except Exception as exc:
        # A process owned by another user is still live; permission failures
        # must not prune it and stop the gateway under a surviving host.
        try:
            import psutil

            return isinstance(exc, psutil.AccessDenied)
        except Exception:
            return False


class _FileLock:
    """Small blocking advisory lock shared by CLI and GUI writers."""

    def __init__(self, path: Path):
        self.path = path
        self._handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+b")
        deadline = time.monotonic() + 5.0
        while True:
            try:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except ImportError:
                try:
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        handle.close()
                        raise
                    time.sleep(0.02)
            except OSError:
                if time.monotonic() >= deadline:
                    handle.close()
                    raise
                time.sleep(0.02)
        self._handle = handle
        return self

    def __exit__(self, exc_type, exc, tb):
        handle, self._handle = self._handle, None
        if handle is None:
            return False
        try:
            handle.seek(0)
            try:
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except (ImportError, OSError):
                pass
        finally:
            handle.close()
        return False


def _read(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [entry for entry in data if isinstance(entry, dict)]


def _write(path: Path, entries: list[dict[str, Any]]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _key(entry: dict[str, Any]) -> tuple[str, int]:
    return str(entry.get("kind", "")), int(entry.get("pid", 0))


def register_host(kind: str, *, pid: Optional[int] = None, start_time: Optional[float] = None,
                  home: Optional[str | Path] = None) -> None:
    """Record one live CLI/GUI host. Safe to call repeatedly for the same host."""
    if kind not in HOST_KINDS:
        raise ValueError(f"Unsupported gateway host kind: {kind}")
    pid = pid or os.getpid()
    start_time = start_time if start_time is not None else process_start_time(pid)
    path, lock = _paths(home)
    with _FileLock(lock):
        entries = _read(path)
        record = {"kind": kind, "pid": pid, "start_time": start_time, "registered_at": time.time()}
        entries = [e for e in entries if _key(e) != _key(record)]
        entries.append(record)
        _write(path, entries)


def unregister_host(kind: str, *, pid: Optional[int] = None,
                    home: Optional[str | Path] = None) -> bool:
    """Remove one host record. Returns True if a record was removed."""
    pid = pid or os.getpid()
    path, lock = _paths(home)
    with _FileLock(lock):
        entries = _read(path)
        kept = [e for e in entries if _key(e) != (kind, pid)]
        changed = len(kept) != len(entries)
        if changed:
            _write(path, kept)
        return changed


def live_hosts(*, home: Optional[str | Path] = None, prune: bool = True) -> list[dict[str, Any]]:
    """Host records whose PID is still alive (and matches its recorded start time)."""
    path, lock = _paths(home)
    with _FileLock(lock):
        entries = _read(path)
        live = [e for e in entries if _pid_alive(e.get("pid"), e.get("start_time"))]
        if prune and len(live) != len(entries):
            _write(path, live)
        return live


def has_live_hosts(*, home: Optional[str | Path] = None) -> bool:
    return bool(live_hosts(home=home))


def stop_gateway_and_wait(*, home: Optional[str | Path] = None, timeout: float = 30.0) -> bool:
    """Send the ordinary gateway stop and wait until its PID is gone.

    Returns True when no gateway owner remains. The caller (CLI/GUI) must only
    exit after this returns; the gateway makes no host-liveness decision.
    """
    target = _home(home)
    previous = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(target)
    try:
        from gateway.status import get_running_pid

        if get_running_pid() is None:
            return True
        from hermes_cli.gateway import stop_profile_gateway

        stop_profile_gateway()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if get_running_pid() is None:
                return True
            time.sleep(0.2)
        return get_running_pid() is None
    finally:
        if previous is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = previous


def begin_host(kind: str, *, pid: Optional[int] = None, home: Optional[str | Path] = None,
               start_gateway: bool = True, atexit_hook: bool = True) -> bool:
    """Register a host and, when asked, ensure the local gateway is running.

    Electron passes ``atexit_hook=False`` and calls :func:`end_host` from its
    own quit path so it can wait for the CLI's stop request before exiting.
    """
    from hermes_cli.gateway_runtime import ensure_gateway_runtime

    target = _home(home)
    register_host(kind, pid=pid, home=target)
    if start_gateway:
        ensure_gateway_runtime(target)
    if atexit_hook:
        atexit.register(end_host, kind, pid=pid, home=target)
    return True


def end_host(kind: str, *, pid: Optional[int] = None, home: Optional[str | Path] = None,
             timeout: float = 30.0) -> bool:
    """Release one host; the last host stops and waits for the gateway.

    Returns True when the gateway is confirmed stopped (or was never running).
    """
    target = _home(home)
    removed = unregister_host(kind, pid=pid, home=target)
    if not removed:
        return True
    if has_live_hosts(home=target):
        return True
    return stop_gateway_and_wait(home=target, timeout=timeout)
