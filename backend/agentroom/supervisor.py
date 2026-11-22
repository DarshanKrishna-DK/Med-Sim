"""Starts the department workers, keeps them running, and never leaves one behind.

    await supervisor.start()   # from the API's lifespan
    supervisor.status()        # {"pharmacist": True, ...}
    await supervisor.stop()

Each worker gets its own BAND key, the model keys and what Python needs to run, and
nothing else. With BAND_WORKERS=compact all departments share one child process (for small
hosts) that holds the department keys and nothing else. Its stdin is a pipe held by this process: when this process goes away in
any manner, the pipe closes and the worker exits. Plain subprocess and threads are used
so this works on every asyncio event loop, Windows included.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

from . import config
from .protocol import ROLES, WORKER_ROLES

log = logging.getLogger("medsim.room.supervisor")

BACKEND_DIR = Path(__file__).resolve().parents[1]
POLL_S = 1.0
STOP_GRACE_S = 5.0
BACKOFF_MIN_S, BACKOFF_MAX_S = 2.0, 60.0
STABLE_S = 120.0  # a worker that ran this long starts again with the shortest backoff

# What a worker may see of our environment, besides its own BAND key.
ENV_ALLOW = frozenset({
    "GROQ_API_KEY", "GROQ_MODEL", "SARVAM_API_KEY", "SARVAM_MODEL", "BAND_REST_URL", "BAND_WS_URL", "LAB_TURNAROUND_S",
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "VIRTUAL_ENV", "PYTHONHOME", "LD_LIBRARY_PATH",
})


def worker_env(*roles: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() in ENV_ALLOW}
    for role in roles:
        env[ROLES[role].key_env] = config.api_key(role)
    # Render sets PORT; locally the API listens on BACKEND_PORT. The lab reads custom cases there.
    env["BACKEND_PORT"] = os.environ.get("BACKEND_PORT") or os.environ.get("PORT") or "8787"
    env.update(PYTHONUNBUFFERED="1", PYTHONUTF8="1", MALLOC_ARENA_MAX="2")
    return env


class _Worker:
    def __init__(self, *roles: str) -> None:
        self.roles = roles
        self.role = ",".join(roles)
        self.proc: Optional[subprocess.Popen[bytes]] = None
        self.ready_roles: set[str] = set()
        self.started_at = 0.0
        self.retry_at = 0.0
        self.backoff = BACKOFF_MIN_S
        self.restarts = 0

    def spawn(self) -> None:
        kw: dict[str, Any] = {}
        if os.name == "nt":
            kw["creationflags"] = subprocess.CREATE_NO_WINDOW
        self.ready_roles = set()
        self.started_at = time.monotonic()
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "agentroom.worker", "--role", self.role],
            cwd=str(BACKEND_DIR), env=worker_env(*self.roles), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL if os.environ.get("BAND_WORKER_QUIET") else None, close_fds=True, **kw)
        threading.Thread(target=self._read, args=(self.proc,), name=f"worker-{self.role}", daemon=True).start()

    def _read(self, proc: subprocess.Popen[bytes]) -> None:
        """Relay the worker's one-line JSON events to our log and notice when it is connected."""
        try:
            for raw in proc.stdout or ():
                line = raw.decode("utf-8", "replace").strip()
                try:
                    d = json.loads(line)
                    event, role = d.get("event"), d.get("role", self.roles[0])
                except (ValueError, AttributeError):
                    continue
                if event == "ready" and proc is self.proc:
                    self.ready_roles.add(role if role in self.roles else self.roles[0])
                elif event in ("stopping", "crash", "exit") and proc is self.proc:
                    self.ready_roles.discard(role)
                log.info("%s", line[:400])
        except (OSError, ValueError):
            pass

    @property
    def ready(self) -> bool:
        return self.ready_roles >= set(self.roles)

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def close_stdin(self) -> None:
        try:
            if self.proc is not None and self.proc.stdin is not None:
                self.proc.stdin.close()
        except OSError:
            pass

    def kill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                pass


_workers: dict[str, _Worker] = {}
_task: Optional[asyncio.Task] = None
_stopping = False


def _kill_all() -> None:
    for w in _workers.values():
        w.close_stdin()
        w.kill()


atexit.register(_kill_all)


async def start() -> None:
    """Spawn every department whose key is configured (BAND_WORKERS=spawn or compact)."""
    global _task, _stopping
    if _task is not None and not _task.done():
        return
    mode = config.workers_mode()
    if not config.enabled() or mode not in ("spawn", "compact"):
        return
    _stopping = False
    _workers.clear()
    roles = [r for r in WORKER_ROLES if config.api_key(r)]
    if mode == "compact" and roles:
        _workers["compact"] = _Worker(*roles)
    else:
        _workers.update((r, _Worker(r)) for r in roles)
    _task = asyncio.create_task(_supervise(), name="agentroom-supervisor")


async def _supervise() -> None:
    for w in _workers.values():
        if _stopping:
            return
        await _spawn(w)
        # One after the other: several interpreters importing at once is the memory and CPU peak.
        for _ in range(30):
            if w.ready or not w.alive or _stopping:
                break
            await asyncio.sleep(0.5)
    while not _stopping:
        now = time.monotonic()
        for w in _workers.values():
            if w.alive or _stopping:
                continue
            if w.proc is not None:
                w.close_stdin()
                code, w.proc, w.ready_roles = w.proc.returncode, None, set()
                if now - w.started_at > STABLE_S:
                    w.backoff = BACKOFF_MIN_S
                w.retry_at = now + w.backoff
                log.warning("%s worker exited (%s), restarting in %.0f s", w.role, code, w.backoff)
                w.backoff = min(BACKOFF_MAX_S, w.backoff * 2)
            elif now >= w.retry_at:
                w.restarts += 1
                await _spawn(w)
        await asyncio.sleep(POLL_S)


async def _spawn(w: _Worker) -> None:
    try:
        await asyncio.to_thread(w.spawn)
    except OSError as e:
        log.warning("%s worker could not start: %s", w.role, type(e).__name__)
        w.proc, w.retry_at = None, time.monotonic() + w.backoff
        w.backoff = min(BACKOFF_MAX_S, w.backoff * 2)


async def stop() -> None:
    """Ask every worker to finish, then make sure that it has."""
    global _task, _stopping
    _stopping = True
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _task = None
    for w in _workers.values():
        w.close_stdin()
    deadline = time.monotonic() + STOP_GRACE_S
    while any(w.alive for w in _workers.values()) and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
    for w in _workers.values():
        if w.alive:
            log.warning("%s worker did not exit, killing it", w.role)
            await asyncio.to_thread(w.kill)
        w.ready_roles = set()


def status() -> dict[str, bool]:
    """Which departments are connected. With external workers: those that are configured."""
    mode = config.workers_mode()
    if not config.enabled() or mode == "off":
        return {r: False for r in WORKER_ROLES}
    if mode == "external":
        return {r: bool(config.api_key(r)) for r in WORKER_ROLES}
    return {r: any(r in w.roles and w.alive and r in w.ready_roles for w in _workers.values()) for r in WORKER_ROLES}
