"""Follow-up calendar events for the charge nurse's schedule_follow_up tool.

Tier 1 (always on, no credentials): an RFC 5545 .ics served from an unguessable,
expiring URL plus a Google Calendar "add event" link.
Tier 2 (optional): server-side insert through the Google Calendar API v3 using a
service account (RS256 JWT signed here in pure Python, no extra dependency).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

try:
    from zoneinfo import ZoneInfo

    IST = ZoneInfo("Asia/Kolkata")
except Exception:  # tzdata missing (Windows)
    IST = timezone(timedelta(hours=5, minutes=30), "IST")

TTL_SECONDS = 24 * 3600
MAX_ENTRIES = 500

_store: "OrderedDict[str, tuple[float, str]]" = OrderedDict()

router = APIRouter()


# ---------------------------------------------------------------- ICS

def _esc(text: str) -> str:
    return (
        str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
        .replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n")
    )


def _fold(line: str) -> str:
    """Fold to <= 75 octets per physical line without splitting UTF-8 chars."""
    if len(line.encode("utf-8")) <= 75:
        return line
    parts, cur, limit = [], b"", 75
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > limit:
            parts.append(cur.decode("utf-8"))
            cur, limit = b"", 74  # continuation lines start with one space
        cur += b
    parts.append(cur.decode("utf-8"))
    return "\r\n ".join(parts)


def _as_ist(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=IST)
    return dt.astimezone(IST)


def build_rrule(recurrence: dict | None) -> str | None:
    """Normalise {freq, count, interval} into an RFC 5545 RRULE line (without folding)."""
    if not recurrence:
        return None
    freq = str(recurrence.get("freq", "")).upper()
    if freq not in ("DAILY", "WEEKLY", "MONTHLY"):
        return None
    try:
        count = max(1, min(52, int(recurrence.get("count", 1))))
        interval = max(1, min(12, int(recurrence.get("interval", 1) or 1)))
    except (TypeError, ValueError):
        return None
    return f"RRULE:FREQ={freq};COUNT={count};INTERVAL={interval}"


def build_ics(uid: str, title: str, description: str, start: datetime,
              minutes: int = 15, location: str = "MedSim Clinic",
              rrule: str | None = None, url: str | None = None) -> str:
    s = _as_ist(start)
    e = s + timedelta(minutes=minutes)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    f = "%Y%m%dT%H%M%S"
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MedSim//Follow-up//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VTIMEZONE",
        "TZID:Asia/Kolkata",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0530",
        "TZOFFSETTO:+0530",
        "TZNAME:IST",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        f"UID:{_esc(uid)}",
        f"DTSTAMP:{stamp}",
        f"DTSTART;TZID=Asia/Kolkata:{s.strftime(f)}",
        f"DTEND;TZID=Asia/Kolkata:{e.strftime(f)}",
        f"SUMMARY:{_esc(title)}",
        f"DESCRIPTION:{_esc(description)}",
        f"LOCATION:{_esc(location)}",
        *([rrule] if rrule else []),
        *([f"URL:{url}"] if url else []),
        "STATUS:CONFIRMED",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        f"DESCRIPTION:{_esc(title)}",
        "TRIGGER:-P1D",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


def google_calendar_link(title: str, details: str, start: datetime,
                         end: datetime, location: str = "MedSim Clinic",
                         rrule: str | None = None) -> str:
    def utc(d: datetime) -> str:
        d = d.replace(tzinfo=IST) if d.tzinfo is None else d
        return d.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    params = {"action": "TEMPLATE", "text": title, "dates": f"{utc(start)}/{utc(end)}",
              "details": details, "location": location}
    if rrule:
        params["recur"] = rrule
    q = urlencode(params, quote_via=quote)
    return "https://calendar.google.com/calendar/render?" + q


# ---------------------------------------------------------------- store

def _purge(now: float) -> None:
    for k in [k for k, (exp, _) in _store.items() if exp <= now]:
        _store.pop(k, None)


def store_ics(ics: str) -> str:
    now = time.time()
    _purge(now)
    token = secrets.token_urlsafe(16)
    _store[token] = (now + TTL_SECONDS, ics)
    while len(_store) > MAX_ENTRIES:
        _store.popitem(last=False)
    return token


def get_ics(token: str) -> str | None:
    item = _store.get(token)
    if not item:
        return None
    if item[0] <= time.time():
        _store.pop(token, None)
        return None
    return item[1]


@router.get("/rx/calendar/{token}.ics")
def download_ics(token: str) -> Response:
    ics = get_ics(token)
    if ics is None:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(
        content=ics.encode("utf-8"),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="medsim-follow-up.ics"',
                 "Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------- scheduling

def pick_start(in_days: int, now: datetime | None = None) -> datetime:
    today = _as_ist(now or datetime.now(timezone.utc))
    d = today + timedelta(days=max(0, int(in_days)))
    d = d.replace(hour=10, minute=0, second=0, microsecond=0)
    if d.weekday() == 6:  # Sunday -> Monday
        d += timedelta(days=1)
    return d


def _start_text(d: datetime) -> str:
    h = d.hour % 12 or 12
    ampm = "am" if d.hour < 12 else "pm"
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}, {h}:{d.minute:02d} {ampm}"


def make_follow_up(case_id: str, patient_name: str, in_days: int, reason: str,
                   clinic: str = "MedSim Clinic", now: datetime | None = None,
                   recurrence: dict | None = None, call_url: str | None = None) -> dict:
    start = pick_start(in_days, now)
    rrule = build_rrule(recurrence)
    minutes = 20 if call_url else 15
    title = f"Follow-up: {reason}"
    kind = "call" if call_url else "visit"
    desc = f"Follow-up {kind} for {patient_name} at {clinic}. Reason: {reason}. Simulated visit (MedSim)."
    if call_url:
        desc += f" Join your Asha follow-up call: {call_url}"
    uid = f"{secrets.token_hex(8)}-{case_id}@medsim"
    token = store_ics(build_ics(uid, title, desc, start, minutes, clinic, rrule=rrule, url=call_url))
    return {
        "ok": True,
        "start": start.isoformat(),
        "startText": _start_text(start),
        "icsPath": f"/rx/calendar/{token}.ics",
        "googleCalendarUrl": google_calendar_link(
            title, desc, start, start + timedelta(minutes=minutes), clinic, rrule=rrule),
        "title": title,
        "description": desc,
        "minutes": minutes,
        "rrule": rrule,
    }


# ---------------------------------------------------------------- tier 2

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _der(data: bytes, pos: int = 0):
    """Return (tag, value_bytes, next_pos) for one DER element."""
    tag, ln = data[pos], data[pos + 1]
    pos += 2
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(data[pos:pos + n], "big")
        pos += n
    return tag, data[pos:pos + ln], pos + ln


def _rsa_key_from_pem(pem: str) -> tuple[int, int]:
    """Return (n, d) from a PKCS#8 or PKCS#1 RSA private key PEM."""
    body = "".join(x for x in pem.strip().splitlines() if not x.startswith("-----"))
    _, seq, _ = _der(base64.b64decode(body))
    _, _, pos = _der(seq)  # version
    tag, _, after = _der(seq, pos)
    if tag == 0x30:  # PKCS#8: AlgorithmIdentifier, then OCTET STRING holding RSAPrivateKey
        _, octets, _ = _der(seq, after)
        _, seq, _ = _der(octets)
        _, _, pos = _der(seq)  # version
    ints = []
    for _ in range(3):  # n, e, d
        _, v, pos = _der(seq, pos)
        ints.append(int.from_bytes(v, "big"))
    return ints[0], ints[2]


_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def rs256_sign(message: bytes, pem: str) -> bytes:
    n, d = _rsa_key_from_pem(pem)
    k = (n.bit_length() + 7) // 8
    t = _SHA256_PREFIX + hashlib.sha256(message).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return pow(int.from_bytes(em, "big"), d, n).to_bytes(k, "big")


def _load_service_account() -> dict | None:
    raw = (os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON") or "").strip()
    if not raw:
        return None
    try:
        if not raw.startswith("{"):
            with open(raw, encoding="utf-8") as fh:
                raw = fh.read()
        info = json.loads(raw)
        if info.get("client_email") and info.get("private_key"):
            return info
    except Exception:
        pass
    return None


_token_cache: dict = {"token": None, "exp": 0.0}


async def _access_token(client, info: dict) -> str | None:
    if _token_cache["token"] and _token_cache["exp"] > time.time() + 60:
        return _token_cache["token"]
    now = int(time.time())
    head = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64(json.dumps({
        "iss": info["client_email"],
        "scope": "https://www.googleapis.com/auth/calendar.events",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now, "exp": now + 3600,
    }).encode())
    signing_input = f"{head}.{claims}"
    sig = await asyncio.to_thread(rs256_sign, signing_input.encode(), info["private_key"])
    r = await client.post("https://oauth2.googleapis.com/token", data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": f"{signing_input}.{_b64(sig)}",
    })
    if r.status_code != 200:
        return None
    body = r.json()
    _token_cache["token"] = body.get("access_token")
    _token_cache["exp"] = time.time() + int(body.get("expires_in", 3600))
    return _token_cache["token"]


async def book_google_event(title: str, description: str, start: datetime,
                            minutes: int = 15, location: str = "MedSim Clinic") -> dict | None:
    """Insert the event into GOOGLE_CALENDAR_ID. Returns {"id", "htmlLink"} or None. Never raises."""
    try:
        cal_id = (os.environ.get("GOOGLE_CALENDAR_ID") or "").strip()
        info = _load_service_account() if cal_id else None
        if not info:
            return None
        import httpx

        s = _as_ist(start)
        e = s + timedelta(minutes=minutes)
        body = {
            "summary": title, "description": description, "location": location,
            "start": {"dateTime": s.isoformat(), "timeZone": "Asia/Kolkata"},
            "end": {"dateTime": e.isoformat(), "timeZone": "Asia/Kolkata"},
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 1440}]},
        }
        async with httpx.AsyncClient(timeout=8.0) as client:
            token = await _access_token(client, info)
            if not token:
                return None
            r = await client.post(
                f"https://www.googleapis.com/calendar/v3/calendars/{quote(cal_id, safe='')}/events",
                headers={"Authorization": f"Bearer {token}"}, json=body)
            if r.status_code not in (200, 201):
                return None
            data = r.json()
            return {"id": data.get("id"), "htmlLink": data.get("htmlLink")}
    except Exception:
        return None
