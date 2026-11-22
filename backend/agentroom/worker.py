"""One department in its own process:  python -m agentroom.worker --role pharmacist  (cwd: backend)

Several departments can share one process on a small host (BAND_WORKERS=compact):
    python -m agentroom.worker --role pharmacist,lab,radiology,examiner,teacher
They stay separate BAND participants, each with its own key, connection, adapter and memory.

Started by supervisor.py with an environment that holds only the BAND keys of its own
departments. Exits when its stdin closes, so it can never outlive the parent.
Logs one JSON line per event on stdout: no clinical text, no names, no secrets.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import threading

from .protocol import EXAMINER, LAB, PHARMACIST, RADIOLOGY, ROLES, TEACHER, WORKER_ROLES

# Two model families in the room: pharmacy, lab and the teacher prefer Groq, radiology and the
# examiner Sarvam. Each falls back to the other provider.
PREFERRED_LLM = {PHARMACIST: "groq", LAB: "groq", RADIOLOGY: "sarvam", EXAMINER: "sarvam", TEACHER: "groq"}
RETRY_MIN_S, RETRY_MAX_S = 2.0, 60.0


def make_adapter(role: str, owner: str):
    if role == PHARMACIST:
        from .pharmacist import PharmacistAdapter as cls
    elif role == LAB:
        from .lab import LabAdapter as cls
    elif role == RADIOLOGY:
        from .radiology import RadiologyAdapter as cls
    elif role == TEACHER:
        from .teacher import TeacherAdapter as cls
    else:
        from .examiner import ExaminerAdapter as cls
    return cls(owner)


def parse_roles(value: str) -> list[str]:
    roles = list(dict.fromkeys(r.strip() for r in value.split(",") if r.strip()))
    bad = [r for r in roles if r not in WORKER_ROLES]
    if bad or not roles:
        raise argparse.ArgumentTypeError(f"unknown department {', '.join(bad) or value!r}: choose from {', '.join(WORKER_ROLES)}")
    return roles


def watch_stdin(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    """Set `stop` when the parent's end of the pipe closes."""

    def read() -> None:
        try:
            while os.read(0, 256):
                pass
        except OSError:
            pass
        try:
            loop.call_soon_threadsafe(stop.set)
        except RuntimeError:
            os._exit(0)

    threading.Thread(target=read, name="parent-watch", daemon=True).start()


async def resolve_me(role: str, key: str) -> dict:
    from .client import BandClient

    c = BandClient(role, key)
    try:
        return await c.me()
    finally:
        await c.aclose()


async def serve(role: str, key: str, stop: asyncio.Event) -> int:
    """One department until the parent goes (0) or its connection ends (1)."""
    from .base import log_event, prefer_llm

    prefer_llm(PREFERRED_LLM[role])  # for this task and everything the SDK starts from it
    stop_task = asyncio.ensure_future(stop.wait())
    try:
        me_task = asyncio.ensure_future(resolve_me(role, key))
        await asyncio.wait({me_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
        if stop.is_set():
            me_task.cancel()
            return 0
        me = me_task.result()

        from band import Agent
        from band.runtime.sessionconfig import SessionConfig

        adapter = make_adapter(role, str(me.get("handle") or "").rpartition("/")[0])
        await asyncio.to_thread(adapter.warm)
        agent = Agent.create(
            adapter=adapter,
            agent_id=str(me["id"]),
            api_key=key,
            # Old rooms are probed less and less often; a room with traffic is checked every 45 s.
            session_config=SessionConfig(max_context_messages=40, idle_resync_seconds=45.0, idle_resync_max_seconds=900.0,
                                         max_cycle_seconds=45.0, report_turn_failures_to_room=False),
        )
        await agent.start()
        log_event(role, "ready", pid=os.getpid())
        forever = asyncio.ensure_future(agent.run_forever(install_signal_handlers=False))
        await asyncio.wait({forever, stop_task}, return_when=asyncio.FIRST_COMPLETED)
        failed = forever.done() and not stop.is_set()
        log_event(role, "stopping", reason="connection ended" if failed else "parent closed")
        try:
            await asyncio.wait_for(agent.stop(timeout=3.0), 8.0)
        except Exception as e:  # noqa: BLE001
            log_event(role, "stop_error", error=type(e).__name__)
        forever.cancel()
        return 1 if failed else 0
    finally:
        stop_task.cancel()


async def keep_serving(role: str, key: str, stop: asyncio.Event) -> int:
    """Compact mode: one department's trouble is its own; the others stay connected."""
    from .base import log_event

    loop = asyncio.get_running_loop()
    delay = RETRY_MIN_S
    while not stop.is_set():
        started = loop.time()
        try:
            await serve(role, key, stop)
        except Exception as e:  # noqa: BLE001
            log_event(role, "crash", error=type(e).__name__)
        if stop.is_set():
            break
        delay = RETRY_MIN_S if loop.time() - started > 120 else min(RETRY_MAX_S, delay * 2)
        try:
            await asyncio.wait_for(stop.wait(), delay)
        except asyncio.TimeoutError:
            pass
    return 0


async def run(roles: list[str]) -> int:
    from .base import log_event

    keys = {r: (os.environ.get(ROLES[r].key_env) or "").strip() for r in roles}
    for r in [r for r in roles if not keys[r]]:
        log_event(r, "exit", reason="no key")
    roles = [r for r in roles if keys[r]]
    if not roles:
        return 2
    stop = asyncio.Event()
    watch_stdin(asyncio.get_running_loop(), stop)
    if len(roles) == 1:
        return await serve(roles[0], keys[roles[0]], stop)
    codes = await asyncio.gather(*[keep_serving(r, keys[r], stop) for r in roles])
    return max(codes)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", required=True, type=parse_roles, help="one department, or several separated by commas")
    roles = ap.parse_args().role
    # The SDK and httpx log message ids and URLs, never bodies; keep only real problems.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")
    logging.getLogger("band.client.streaming").setLevel(logging.ERROR)  # warns about every presence event
    # Ctrl+C reaches the whole console group; the parent decides, through stdin.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    code = 1
    try:
        code = asyncio.run(run(roles))
    except Exception as e:  # noqa: BLE001
        from .base import log_event

        log_event(roles[0], "crash", error=type(e).__name__)
    sys.stdout.flush()
    os._exit(code)  # the stdin thread may still be blocked in read()


if __name__ == "__main__":
    main()
