"""/agent/room/*: the browser's side of the BAND room (see docs/band/CONTRACT.md)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import academic, desk, siderooms  # noqa: F401  (they register their side room kinds)
from .client import BandError
from .hub import ENCOUNTER_ID, Encounter, hub

log = logging.getLogger("medsim.room.routes")
router = APIRouter()


class QA(BaseModel):
    question: str = Field("", max_length=600)
    answer: str = Field("", max_length=2000)


class RoomPatient(BaseModel):
    name: str = Field("", max_length=120)
    age: Optional[float] = Field(None, ge=0, le=130)
    gender: str = Field("", max_length=16)
    chiefComplaint: str = Field("", max_length=2000)
    allergies: Optional[str] = Field(None, max_length=2000)
    anamnesis: list[QA] = Field(default_factory=list, max_length=60)


class OpenBody(BaseModel):
    encounterId: str = Field(max_length=120)
    caseId: str = Field(max_length=120)
    lang: str = Field("en", max_length=10)
    osce: bool = False
    patient: RoomPatient
    doctorName: Optional[str] = Field(None, max_length=120)


class AskBody(BaseModel):
    target: str = Field(max_length=20)
    utterance: str = Field(min_length=1, max_length=1500)
    lang: Optional[str] = Field(None, max_length=10)


class AnswerBody(BaseModel):
    ref: str = Field(max_length=40)
    text: str = Field(min_length=1, max_length=1500)
    lang: Optional[str] = Field(None, max_length=10)


class InviteBody(BaseModel):
    reason: Optional[str] = Field(None, max_length=600)


class SayBody(BaseModel):
    text: str = Field(min_length=1, max_length=1500)


class RefBody(BaseModel):
    ref: str = Field(max_length=40)
    reason: Optional[str] = Field(None, max_length=600)


class CloseBody(BaseModel):
    summary: dict[str, Any] = Field(default_factory=dict)


def _enc(encounter_id: str, *, open_only: bool = True) -> Encounter:
    if not hub.enabled:
        raise HTTPException(status_code=503, detail="the agent room is not configured")
    enc = hub.active(encounter_id) if open_only else hub.get(encounter_id)
    if enc is None or (open_only and enc.side is not None):
        raise HTTPException(status_code=404, detail="unknown encounter")
    return enc


def _checked(out: dict[str, Any]) -> dict[str, Any]:
    if not out.get("ok"):
        raise HTTPException(status_code=409, detail=str(out.get("error") or "not possible now"))
    return out


async def _band(coro: Any) -> Any:
    """A BAND outage is a clean 502, never a 500."""
    try:
        return await asyncio.wait_for(coro, timeout=25.0)
    except (BandError, asyncio.TimeoutError) as e:
        log.warning("BAND call failed: %s", e if isinstance(e, BandError) else "timeout")
        raise HTTPException(status_code=502, detail="the agent room is not reachable right now") from e


@router.get("/agent/room/status")
async def room_status():
    return await hub.status()


@router.post("/agent/room/open")
async def room_open(b: OpenBody):
    if not ENCOUNTER_ID.fullmatch(b.encounterId):
        raise HTTPException(status_code=422, detail="bad encounterId")
    ok = hub.open(b.encounterId, b.caseId, b.lang, b.osce, b.patient.model_dump(), b.doctorName or "")
    if not ok:
        return {"enabled": False, "reason": (await hub.status()).get("reason") or "the agent room is not configured"}
    return {"enabled": True}


@router.get("/agent/room/{encounter_id}/stream")
async def room_stream(encounter_id: str, request: Request, after: int = 0):
    enc = _enc(encounter_id, open_only=False)
    last = request.headers.get("last-event-id", "")
    if last.isdigit():
        after = max(after, int(last))
    return StreamingResponse(hub.stream(enc, max(0, after)), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive",
                                      "X-Accel-Buffering": "no"})


@router.post("/agent/room/{encounter_id}/ask")
async def room_ask(encounter_id: str, b: AskBody):
    enc = _enc(encounter_id)
    r = hub.ask(enc, b.target, b.utterance, b.lang)
    if r is None:
        raise HTTPException(status_code=422, detail="target must be pharmacist, lab or radiology")
    return {"ref": r.ref}


@router.post("/agent/room/{encounter_id}/answer")
async def room_answer(encounter_id: str, b: AnswerBody):
    if not hub.answer(_enc(encounter_id), b.ref, b.text, b.lang):
        raise HTTPException(status_code=409, detail="nothing is waiting for this answer")
    return {"ok": True}


@router.post("/agent/room/{encounter_id}/faculty/invite")
async def room_invite(encounter_id: str, b: InviteBody):
    out = await _band(hub.invite_faculty(_enc(encounter_id), b.reason or ""))
    return {"url": out["url"]}


@router.post("/agent/room/{encounter_id}/faculty/say")
async def room_say(encounter_id: str, b: SayBody):
    return {"ok": await _band(hub.faculty_say(_enc(encounter_id), b.text))}


@router.post("/agent/room/{encounter_id}/override")
async def room_override(encounter_id: str, b: RefBody):
    return _checked(await _band(hub.request_override(_enc(encounter_id), b.ref, b.reason or "")))


@router.post("/agent/room/{encounter_id}/cancel")
async def room_cancel(encounter_id: str, b: RefBody):
    return _checked(hub.cancel(_enc(encounter_id), b.ref, b.reason or "cancelled by the doctor"))


@router.post("/agent/room/{encounter_id}/retry")
async def room_retry(encounter_id: str, b: RefBody):
    return _checked(hub.retry(_enc(encounter_id), b.ref))


@router.post("/agent/room/{encounter_id}/close")
async def room_close(encounter_id: str, b: CloseBody):
    enc = _enc(encounter_id, open_only=False)
    if enc.side is not None:
        raise HTTPException(status_code=404, detail="unknown encounter")
    ref = hub.close(enc, b.summary)
    return {"ref": ref} if ref else {}


# ── side rooms (siderooms.py) ──────────────────────────────────────────────


class SideOpenBody(BaseModel):
    kind: str = Field(max_length=40)
    refId: str = Field(max_length=80)
    title: str = Field("", max_length=120)
    lang: str = Field("en", max_length=10)
    context: dict[str, Any] = Field(default_factory=dict)
    roomId: str = Field("", max_length=64)  # take an earlier room up again (after a server restart)


class SideActBody(BaseModel):
    action: str = Field(max_length=40)
    data: dict[str, Any] = Field(default_factory=dict)


def _small(d: dict[str, Any], limit: int = 24_000) -> dict[str, Any]:
    if len(json.dumps(d, ensure_ascii=False)) > limit:
        raise HTTPException(status_code=413, detail="too much data")
    return d


@router.post("/agent/room/side/open")
async def side_open(b: SideOpenBody):
    kind = siderooms.KINDS.get(b.kind)
    if kind is not None and not siderooms.available(kind.owner):
        return {"enabled": False, "reason": "the agent room is not configured"}
    try:
        side = await _band(siderooms.open_http(b.kind, b.refId, title=b.title, lang=b.lang, context=_small(b.context), room_id=b.roomId))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if side is None:
        return {"enabled": False, "reason": "the agent room is not configured"}
    return {"enabled": True, "id": side.id, "side": side.state}


def _side(side_id: str) -> siderooms.SideRoom:
    side = siderooms.by_id(side_id)
    if side is None:
        raise HTTPException(status_code=404, detail="unknown side room")
    return side


@router.get("/agent/room/side/{side_id}")
async def side_state(side_id: str):
    return {"enabled": True, "id": side_id, "side": _side(side_id).state}


@router.post("/agent/room/side/{side_id}/act")
async def side_act(side_id: str, b: SideActBody):
    side = _side(side_id)
    act = side.kind.actions.get(b.action)
    if act is None:
        raise HTTPException(status_code=404, detail="unknown action")
    try:
        out = await _band(act(side, _small(b.data)))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True, "id": side_id, "side": side.state, **(out if isinstance(out, dict) else {})}
