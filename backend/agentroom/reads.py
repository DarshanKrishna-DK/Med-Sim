"""The reading room's side room: a second read, and the critical finding nobody reported.

After the student's report is marked (radiology.py, untouched), Nurse Asha hands it to
Radiologist Vikram. He reads the film himself and agrees or not. If a critical finding
was missed he calls it to Asha by name; she reads it back, he confirms. Every step of
that chain is shown with its time, and nothing is added that nobody said.

Side room kind "second_read" (owner: nurse). One room per submitted report.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from typing import Any

from . import bedside, client as band_client, siderooms
from .protocol import NURSE, RADIOLOGY, Handoff
from .siderooms import Kind, Reply, SideRoom

KIND = "second_read"
READ_TIMEOUT_S = 40.0
FILM = re.compile(r"rad-[a-z0-9-]{2,40}")


def _clip(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def check(ref_id: str, context: dict[str, Any]) -> dict[str, Any]:
    film = str(context.get("filmId") or "")
    if not FILM.fullmatch(film):
        raise ValueError("unknown film")
    diagnosis = _clip(context.get("diagnosis"), 200)
    if not diagnosis:
        raise ValueError("no diagnosis")
    # Only the film, the student's words and their diagnosis. Never the marks, never the answer.
    return {"filmId": film, "report": _clip(context.get("report"), 4000), "diagnosis": diagnosis}


def _step(side: SideRoom, who: str, what: str, **more: Any) -> None:
    chain = [*(side.state.get("chain") or []), {"at": _now(), "who": who, "what": _clip(what, 300)}]
    side.update(chain=chain[-12:], **more)


def _ours(side: SideRoom, ref: str) -> bool:
    """A ref this room asked under; after a server restart, one found in its own transcript."""
    if ref and ref == side.memory.get("ref"):
        return True
    mine = side.sent.get(ref)
    return mine is not None and mine.action == "second_read" and mine.kind == "request"


async def flow(side: SideRoom, context: dict[str, Any]) -> None:
    if side.enc.room_id:
        # Taken up again after a restart: he has been asked already, the transcript tells the rest.
        _step(side, NURSE, "Room opened again", status="waiting", read=None)
        side.expect(READ_TIMEOUT_S)
        return
    ref = side.ref("read")
    side.memory["ref"] = ref
    _step(side, NURSE, "Report sent for a second read", status="waiting", read=None)
    r = await side.request(
        RADIOLOGY, "second_read",
        f"Second read please. The student's diagnosis: {context['diagnosis']}. Their report: {context['report'] or 'nothing was described.'}",
        {"filmId": context["filmId"], "report": context["report"], "diagnosis": context["diagnosis"]},
        ref=ref, timeout=READ_TIMEOUT_S, label="Second read", why="Adding radiology: the report needs a second read")
    settle(side, r)


def settle(side: SideRoom, r: Reply) -> None:
    outcome = str(r.data.get("outcome") or "") if r.ok and r.kind == "result" else ""
    if outcome not in ("agree", "discrepancy"):
        _step(side, RADIOLOGY, "No second read: radiology has not replied", status="no_reply", final=False)
        return
    missed = [{"label": _clip(bedside.clean_spoken(m.get("label")), 200), "critical": bool(m.get("critical"))}
              for m in r.data.get("missed") or [] if isinstance(m, dict)][:8] if isinstance(r.data.get("missed"), list) else []
    calling = r.data.get("calling") is True
    read = {"outcome": outcome, "by": r.name or "Radiologist Vikram", "missed": missed, "diagnosisAgrees": r.data.get("diagnosisAgrees") is True,
            "diagnosis": _clip(bedside.clean_spoken(r.data.get("diagnosis")), 160), "text": _clip(bedside.clean_spoken(r.text, 500), 400),
            "spoken": r.spoken}
    already = side.state.get("status") in ("calling", "acknowledged", "closed")  # the call came in first
    status = side.state["status"] if already else "calling" if calling else outcome
    _step(side, RADIOLOGY, "Second read: agrees" if outcome == "agree" else "Second read: discrepancy", status=status, read=read,
          final=not calling and not already)


async def listen(side: SideRoom, r: Reply) -> None:
    """A late read, the critical call, and the confirmation of the read-back."""
    if r.role != RADIOLOGY or r.handoff is None or not _ours(side, r.ref):
        return
    if r.kind == "result" and r.handoff.action == "second_read":
        if (side.state.get("read") or None) is None:
            side.set_delegation(r.ref, "done", r.text)
            settle(side, r)
        return
    if r.handoff.action != "critical_finding":
        return
    if r.kind == "note":
        await _acknowledge(side, r)
    elif r.kind == "ack" and r.data.get("status") == "closed":
        side.memory["confirmed"] = True
        _close(side)


def _close(side: SideRoom) -> None:
    """His confirmation can beat the response to Asha's own post: it counts once she is on record."""
    if side.memory.get("confirmed") and side.state.get("status") == "acknowledged":
        _step(side, RADIOLOGY, "Read-back confirmed, loop closed", status="closed", final=True)


async def _acknowledge(side: SideRoom, r: Reply) -> None:
    for _ in range(40):  # the read itself arrives just before the call; keep the chain in that order
        if side.state.get("read") is not None or not side.running():
            break
        await asyncio.sleep(0.05)
    findings = [_clip(bedside.clean_spoken(f), 200) for f in r.data.get("findings") or [] if isinstance(f, str)][:3] \
        if isinstance(r.data.get("findings"), list) else []
    if not findings or side.memory.get("acks", 0) >= 3:
        return
    side.memory["acks"] = side.memory.get("acks", 0) + 1
    what = "; ".join(findings)
    _step(side, RADIOLOGY, f"Called Nurse Asha: {what}", status="calling", critical=findings)
    try:
        await side.post(RADIOLOGY, f"Read back: {what}. I am telling the treating team now.",
                        Handoff("ack", "critical_finding", r.ref, data={"readBack": what, "acknowledgedAt": _now()}))
    except band_client.BandError:
        _step(side, NURSE, "The acknowledgement could not be sent", status="calling")
        return
    _step(side, NURSE, f"Acknowledged and read back: {what}", status="acknowledged")
    _close(side)


siderooms.register(Kind(KIND, owner=NURSE, title="Second read", flow=flow, check=check, listener=listen))
