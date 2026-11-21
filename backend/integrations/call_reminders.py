"""Scheduled Asha check-in calls: at each occurrence of a follow-up call, the
patient gets a message ("Nurse Asha is ready for your check-in, tap to join")
on the same channel as their prescription (Telegram, WhatsApp, SMS or email).

In-memory, single process (the Render web service stays up). A background
loop started from the app lifespan fires due reminders every 15 seconds.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

log = logging.getLogger("medsim.reminders")

TICK_S = 15.0
MAX_PENDING = 500
_lock = threading.Lock()
_pending: list[dict[str, Any]] = []
_sent: list[dict[str, Any]] = []
_task: Optional[asyncio.Task] = None

_STEP = {"daily": timedelta(days=1), "weekly": timedelta(weeks=1)}


def occurrences(start: datetime, recurrence: Optional[dict[str, Any]]) -> list[datetime]:
    """Every start time of the series (capped at 12)."""
    if not recurrence:
        return [start]
    freq = str(recurrence.get("freq", "")).lower()
    count = max(1, min(12, int(recurrence.get("count") or 1)))
    interval = max(1, min(4, int(recurrence.get("interval") or 1)))
    out = []
    for i in range(count):
        if freq == "monthly":
            m = start.month - 1 + i * interval
            year, month = start.year + m // 12, m % 12 + 1
            try:
                out.append(start.replace(year=year, month=month))
            except ValueError:  # 31st in a short month: use the 28th
                out.append(start.replace(year=year, month=month, day=28))
        else:
            out.append(start + _STEP.get(freq, timedelta(weeks=1)) * interval * i)
    return out


def schedule(contact: str, patient_name: str, call_url: str, start: datetime,
             recurrence: Optional[dict[str, Any]] = None, reason: str = "") -> list[str]:
    """Queue one reminder per occurrence. Returns their ISO times."""
    if not contact or not call_url.startswith("http"):
        return []
    times = occurrences(start, recurrence)
    with _lock:
        for i, at in enumerate(times):
            _pending.append({"at": at.astimezone(timezone.utc), "contact": contact, "name": patient_name,
                             "url": call_url, "reason": reason, "n": i + 1, "of": len(times)})
        _pending.sort(key=lambda r: r["at"])
        del _pending[MAX_PENDING:]
    return [t.isoformat() for t in times]


def message(r: dict[str, Any]) -> str:
    from integrations import notify

    part = f" ({r['n']} of {r['of']})" if r["of"] > 1 else ""
    why = f" about your {r['reason']}" if r.get("reason") else ""
    return (f"MedSim Clinic: Hello {r['name'] or 'there'}. Nurse Asha is ready for your check-in call{part}{why}. "
            f"Join your Asha follow-up call: {r['url']}. It takes about 3 minutes, in your language. "
            f"{notify.DISCLAIMER}")


async def fire_due(now: Optional[datetime] = None) -> int:
    from integrations import notify

    now = now or datetime.now(timezone.utc)
    with _lock:
        due = [r for r in _pending if r["at"] <= now]
        for r in due:
            _pending.remove(r)
    for r in due:
        res = await notify.send_to_patient("auto", r["contact"], message(r))
        log.info("call reminder %s/%s ok=%s", r["n"], r["of"], res.get("ok"))
        with _lock:
            _sent.append({**r, "ok": bool(res.get("ok")), "channel": res.get("channel")})
            del _sent[:-100]
    return len(due)


def pending() -> list[dict[str, Any]]:
    with _lock:
        return [{"at": r["at"].isoformat(), "n": r["n"], "of": r["of"]} for r in _pending]


async def _loop() -> None:
    while True:
        try:
            await fire_due()
        except Exception as e:  # noqa: BLE001
            log.warning("reminder tick failed: %s", type(e).__name__)
        await asyncio.sleep(TICK_S)


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_loop())


def stop() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None
