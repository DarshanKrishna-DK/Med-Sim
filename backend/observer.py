"""Live faculty observer: a second browser joins a running consultation as an
Agora RTC *audience* member and RTM subscriber.

Endpoints
  POST /voice/observer/invite  {channel, caseId} -> {code, inviteUrl, expiresAt, link}
  POST /voice/observer/join    {code}            -> {appId, channel, uid, token, role, ...}

Security model
  * /voice/start registers every channel it creates (register_session). An
    invite can only be minted for a registered, unexpired channel, so a
    caller cannot point an observer at an arbitrary channel name.
  * Invite codes are random ids plus an HMAC tag keyed by a per-process
    secret (never the Agora app certificate), kept in memory with a 2 h
    expiry. A code names exactly one channel.
  * The observer token is built with Role_Subscriber: RTC join privilege
    only, no publish audio/video/data privileges (plus RTM login so the
    observer can read the transcript and send whispers/marks). The client
    also joins with client role "audience".
  * The student's "link" RTM identity (used to publish medsim.event and to
    receive whispers/marks after the voice call ends) is a separate uid.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from agora_token import RtcTokenBuilder, Role_Subscriber

router = APIRouter()

INVITE_TTL_S = 2 * 60 * 60
SESSION_TTL_S = 4 * 60 * 60
MAX_INVITES_PER_CHANNEL = 5
MAX_JOINS_PER_CODE = 12
OBSERVER_UID_MIN = 2_000_000
LINK_UID_MIN = 3_000_000
UID_SPAN = 900_000

_SECRET = secrets.token_bytes(32)
_lock = threading.Lock()


@dataclass
class _Session:
    uid: int
    case_id: str
    agent_uid: int
    created: float


@dataclass
class Invite:
    code: str
    channel: str
    case_id: str
    student_uid: int
    link_uid: int
    agent_uid: int
    created: float
    expires: float
    observer_uids: list[int] = field(default_factory=list)


_sessions: dict[str, _Session] = {}
_invites: dict[str, Invite] = {}


def _now() -> float:
    return time.time()


def _prune(now: float) -> None:
    for ch in [c for c, s in _sessions.items() if now - s.created > SESSION_TTL_S]:
        _sessions.pop(ch, None)
    for code in [c for c, i in _invites.items() if i.expires <= now]:
        _invites.pop(code, None)


def register_session(channel: str, uid: int, case_id: str, agent_uid: int) -> None:
    """Called by /voice/start for every channel it creates."""
    with _lock:
        now = _now()
        _prune(now)
        _sessions[channel] = _Session(uid=uid, case_id=case_id, agent_uid=agent_uid, created=now)


def reset_state() -> None:
    """Tests only."""
    with _lock:
        _sessions.clear()
        _invites.clear()


def _sign(raw: str) -> str:
    return hmac.new(_SECRET, raw.encode(), hashlib.sha256).hexdigest()[:10]


def _new_code() -> str:
    raw = secrets.token_urlsafe(9)  # 12 chars, 72 bits
    return f"{raw}.{_sign(raw)}"


def _valid_shape(code: str) -> bool:
    raw, sep, tag = code.partition(".")
    if not sep or not raw or len(code) > 64:
        return False
    return hmac.compare_digest(tag, _sign(raw))


def lookup_invite(code: str, now: Optional[float] = None) -> Optional[Invite]:
    now = _now() if now is None else now
    if not _valid_shape(code):
        return None
    with _lock:
        inv = _invites.get(code)
        if inv is None or inv.expires <= now:
            return None
        return inv


def _env() -> tuple[str, str]:
    import os

    app_id = os.environ.get("AGORA_APP_ID", "").strip()
    cert = os.environ.get("AGORA_APP_CERTIFICATE", "").strip()
    if not app_id or not cert:
        raise HTTPException(status_code=503, detail="Voice not configured: missing AGORA_APP_ID/AGORA_APP_CERTIFICATE")
    return app_id, cert


def audience_token(app_id: str, cert: str, channel: str, uid: int, ttl: int) -> str:
    """RTC join (no publish privileges) + RTM login for `uid`."""
    return RtcTokenBuilder.build_token_with_rtm(app_id, cert, channel, str(uid), Role_Subscriber, ttl, ttl)


def _origin(request: Request) -> str:
    origin = request.headers.get("origin", "").strip().rstrip("/")
    if origin.startswith(("http://", "https://")):
        return origin
    return str(request.base_url).rstrip("/")


class InviteRequest(BaseModel):
    channel: str = Field(min_length=1, max_length=64)
    caseId: str = Field(default="", max_length=64)


class LinkCreds(BaseModel):
    uid: int
    token: str


class InviteResponse(BaseModel):
    code: str
    inviteUrl: str
    expiresAt: int
    link: LinkCreds


@router.post("/voice/observer/invite", response_model=InviteResponse)
def observer_invite(req: InviteRequest, request: Request):
    app_id, cert = _env()
    now = _now()
    with _lock:
        _prune(now)
        sess = _sessions.get(req.channel)
        if sess is None:
            raise HTTPException(status_code=404, detail="No live voice session on that channel. Start voice first.")
        if req.caseId and sess.case_id and req.caseId != sess.case_id:
            raise HTTPException(status_code=400, detail="caseId does not match the session")
        live = [i for i in _invites.values() if i.channel == req.channel]
        if len(live) >= MAX_INVITES_PER_CHANNEL:
            raise HTTPException(status_code=429, detail="Too many observer invites for this session")
        code = _new_code()
        link_uid = LINK_UID_MIN + secrets.randbelow(UID_SPAN)
        inv = Invite(
            code=code,
            channel=req.channel,
            case_id=sess.case_id,
            student_uid=sess.uid,
            link_uid=link_uid,
            agent_uid=sess.agent_uid,
            created=now,
            expires=now + INVITE_TTL_S,
        )
        _invites[code] = inv
    link_token = audience_token(app_id, cert, inv.channel, link_uid, INVITE_TTL_S)
    return InviteResponse(
        code=code,
        inviteUrl=f"{_origin(request)}/?observe={code}",
        expiresAt=int(inv.expires * 1000),
        link=LinkCreds(uid=link_uid, token=link_token),
    )


class JoinRequest(BaseModel):
    code: str = Field(min_length=1, max_length=64)


class JoinResponse(BaseModel):
    appId: str
    channel: str
    uid: int
    token: str
    role: str
    caseId: str
    studentUid: int
    linkUid: int
    agentUid: int
    expiresAt: int


@router.post("/voice/observer/join", response_model=JoinResponse)
def observer_join(req: JoinRequest):
    app_id, cert = _env()
    now = _now()
    inv = lookup_invite(req.code.strip(), now)
    if inv is None:
        raise HTTPException(status_code=404, detail="Observer link is invalid or has expired")
    with _lock:
        if len(inv.observer_uids) >= MAX_JOINS_PER_CODE:
            raise HTTPException(status_code=429, detail="Observer link used too many times")
        taken = {inv.student_uid, inv.link_uid, inv.agent_uid, *inv.observer_uids}
        uid = OBSERVER_UID_MIN + secrets.randbelow(UID_SPAN)
        while uid in taken:
            uid = OBSERVER_UID_MIN + secrets.randbelow(UID_SPAN)
        inv.observer_uids.append(uid)
    ttl = max(60, int(inv.expires - now))
    return JoinResponse(
        appId=app_id,
        channel=inv.channel,
        uid=uid,
        token=audience_token(app_id, cert, inv.channel, uid, ttl),
        role="audience",
        caseId=inv.case_id,
        studentUid=inv.student_uid,
        linkUid=inv.link_uid,
        agentUid=inv.agent_uid,
        expiresAt=int(inv.expires * 1000),
    )
