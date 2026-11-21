"""Patient notifications: prescription + Murf voice-prescription link + follow-up date.

Channels (all free tier, all env-gated, none ever raises):
  whatsapp  Twilio WhatsApp sandbox   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
  sms       Twilio trial SMS          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM
  email     SMTP over SSL (Gmail)     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM

Also hosts the MP3 in memory (24h, 200 entries) at GET /rx/audio/{token}.mp3. Those paths are
public on purpose (the patient phone opens them); the token is unguessable.
Phone numbers, emails and secrets are never logged unmasked.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from llm_proxy import public_url

log = logging.getLogger("medsim.notify")
router = APIRouter()

AUDIO_TTL_S = 24 * 3600
AUDIO_MAX = 200
RATE_MAX = 5
RATE_WINDOW_S = 3600
SMTP_TIMEOUT_S = 10
MAX_BODY = 1200
DISCLAIMER = "This is a training simulation, not medical advice."
DEFAULT_WA_FROM = "+14155238886"
TWILIO_URL = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"

_lock = threading.Lock()
_audio: dict[str, tuple[float, bytes]] = {}
_sends: dict[str, list[float]] = {}


# ------------------------------------------------------------------ audio hosting


def store_audio(mp3: bytes) -> str:
    """Keep the MP3 in memory and return its public path '/rx/audio/<token>.mp3'."""
    now = time.time()
    token = secrets.token_urlsafe(16)
    with _lock:
        for k in [k for k, (t, _) in _audio.items() if now - t > AUDIO_TTL_S]:
            del _audio[k]
        while len(_audio) >= AUDIO_MAX:
            del _audio[min(_audio, key=lambda k: _audio[k][0])]
        _audio[token] = (now, bytes(mp3))
    return f"/rx/audio/{token}.mp3"


@router.get("/rx/audio/{token}.mp3")
async def rx_audio_file(token: str) -> Response:
    with _lock:
        item = _audio.get(token)
        if item and time.time() - item[0] > AUDIO_TTL_S:
            del _audio[token]
            item = None
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(content=item[1], media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=3600"})


def absolute_url(path: str) -> Optional[str]:
    """Absolute link for a path, or None when no public base URL is reachable."""
    base = public_url()
    return f"{base.rstrip('/')}{path}" if base else None


# ------------------------------------------------------------------ message


def compose_message(
    patient_name: str,
    doctor_name: str,
    meds: list[dict],
    follow_up: Optional[dict],
    audio_url: Optional[str],
    calendar_url: Optional[str],
    lang: str = "en",
) -> str:
    items = []
    for i, m in enumerate(meds or [], 1):
        bits = [str(m.get("name", "")).strip(), str(m.get("dose", "")).strip(), str(m.get("duration", "")).strip()]
        items.append(f"{i}) " + ", ".join(b for b in bits if b))
    parts = [f"MedSim Clinic: Hello {(patient_name or 'there').strip()}."]
    parts.append(f"Your prescription from {(doctor_name or 'your doctor').strip()}: " + ("; ".join(items) or "none") + ".")
    if audio_url:
        label = "Listen in your language" if (lang or "en") != "en" else "Listen to your prescription"
        parts.append(f"{label}: {audio_url}.")
    if follow_up and (follow_up.get("startText") or follow_up.get("reason")):
        when = str(follow_up.get("startText") or "soon").strip()
        reason = str(follow_up.get("reason") or "").strip()
        parts.append(f"Follow-up: {when}" + (f" ({reason})" if reason else "") + ".")
        if calendar_url:
            parts.append(f"Add to calendar: {calendar_url}.")
    text = " ".join(parts)
    room = MAX_BODY - len(DISCLAIMER) - 1
    if len(text) > room:
        text = text[: room - 3].rstrip() + "..."
    return f"{text} {DISCLAIMER}".replace(chr(0x2014), "-")


# ------------------------------------------------------------------ validation / masking

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_phone(raw: str) -> Optional[str]:
    """E.164 or None. 10 bare digits are assumed to be Indian (+91)."""
    s = re.sub(r"[\s\-().]", "", (raw or "").strip())
    if s.startswith("whatsapp:"):
        s = s[9:]
    if s.startswith("00"):
        s = "+" + s[2:]
    if s.startswith("+"):
        return s if re.fullmatch(r"\+\d{8,15}", s) else None
    if re.fullmatch(r"\d{10}", s):
        return "+91" + s
    return None


def is_email(raw: str) -> bool:
    return bool(_EMAIL_RE.match((raw or "").strip()))


def mask(dest: str) -> str:
    d = (dest or "").strip()
    if is_telegram(d):
        return "Telegram chat"
    if "@" in d:
        user, _, dom = d.partition("@")
        return f"{user[:1]}***@{dom}"
    if len(d) > 6:
        return d[:3] + "*" * (len(d) - 7) + d[-4:]
    return "***"


# ------------------------------------------------------------------ config


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _twilio_ready() -> bool:
    return bool(_env("TWILIO_ACCOUNT_SID") and _env("TWILIO_AUTH_TOKEN"))


def _smtp_ready() -> bool:
    return bool(_env("SMTP_USER") and _env("SMTP_PASSWORD"))


def _telegram_ready() -> bool:
    return bool(_env("TELEGRAM_BOT_TOKEN"))


def is_telegram(dest: str) -> bool:
    """'telegram' (the latest chat that pressed Start), '@username', or 'tg:<chat id>'."""
    d = (dest or "").strip().lower()
    return d in ("telegram", "tg") or d.startswith("tg:") or bool(re.fullmatch(r"@[a-z0-9_]{4,32}", d))


def configured_channels() -> list[str]:
    out = []
    if _telegram_ready():
        out.append("telegram")
    if _twilio_ready():
        out.append("whatsapp")
        if _env("TWILIO_SMS_FROM"):
            out.append("sms")
    if _smtp_ready():
        out.append("email")
    return out


def _client_factory() -> httpx.AsyncClient:
    """Indirection so tests can inject a mock transport."""
    return httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))


def _rate_ok(key: str) -> bool:
    now = time.time()
    with _lock:
        hits = [t for t in _sends.get(key, []) if now - t < RATE_WINDOW_S]
        if len(hits) >= RATE_MAX:
            _sends[key] = hits
            return False
        hits.append(now)
        _sends[key] = hits
    return True


def _fail(channel: str, to: str, error: str) -> dict[str, Any]:
    return {"ok": False, "channel": channel, "to": mask(to), "error": error}


# ------------------------------------------------------------------ channels


async def _send_twilio(channel: str, number: str, message: str, audio_url: Optional[str]) -> dict[str, Any]:
    sid, token = _env("TWILIO_ACCOUNT_SID"), _env("TWILIO_AUTH_TOKEN")
    if not (sid and token):
        return _fail(channel, number, "Twilio is not configured (set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)")
    if channel == "whatsapp":
        frm = "whatsapp:" + (_env("TWILIO_WHATSAPP_FROM") or DEFAULT_WA_FROM).removeprefix("whatsapp:")
        form = {"From": frm, "To": "whatsapp:" + number, "Body": message}
        if audio_url and audio_url.startswith("https://"):
            form["MediaUrl"] = audio_url
    else:
        frm = _env("TWILIO_SMS_FROM")
        if not frm:
            return _fail(channel, number, "SMS is not configured (set TWILIO_SMS_FROM)")
        form = {"From": frm, "To": number, "Body": message}
    try:
        async with _client_factory() as c:
            r = await c.post(TWILIO_URL.format(sid=sid), data=form, auth=(sid, token))
    except httpx.HTTPError as e:
        return _fail(channel, number, f"Twilio request failed: {type(e).__name__}")
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = {}
    if r.status_code >= 300:
        msg = str(data.get("message") or "")[:200] if isinstance(data, dict) else ""
        return _fail(channel, number, f"Twilio error {r.status_code}" + (f": {msg}" if msg else ""))
    return {"ok": True, "channel": channel, "to": mask(number), "sid": data.get("sid") if isinstance(data, dict) else None}


def _smtp_send(msg: EmailMessage) -> None:
    host = _env("SMTP_HOST") or "smtp.gmail.com"
    port = int(_env("SMTP_PORT") or 465)
    with smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_S, context=ssl.create_default_context()) as s:
        s.login(_env("SMTP_USER"), _env("SMTP_PASSWORD"))
        s.send_message(msg)


async def _send_email(addr: str, message: str, mp3: Optional[bytes], ics: Optional[bytes]) -> dict[str, Any]:
    if not _smtp_ready():
        return _fail("email", addr, "Email is not configured (set SMTP_USER and SMTP_PASSWORD)")
    msg = EmailMessage()
    msg["Subject"] = "Your MedSim prescription"
    msg["From"] = _env("SMTP_FROM") or _env("SMTP_USER")
    msg["To"] = addr
    msg["Message-ID"] = f"<{secrets.token_hex(12)}@medsim.local>"
    msg.set_content(message)
    if mp3:
        msg.add_attachment(mp3, maintype="audio", subtype="mpeg", filename="prescription.mp3")
    if ics:
        msg.add_attachment(ics, maintype="text", subtype="calendar", filename="follow-up.ics")
    try:
        await asyncio.wait_for(asyncio.to_thread(_smtp_send, msg), timeout=SMTP_TIMEOUT_S + 5)
    except Exception as e:  # noqa: BLE001
        return _fail("email", addr, f"Email send failed: {type(e).__name__}")
    return {"ok": True, "channel": "email", "to": mask(addr), "messageId": msg["Message-ID"]}


# ------------------------------------------------------------------ telegram

_TG_API = "https://api.telegram.org"
_tg_chats: dict[str, int] = {}


def _tg_url(method: str) -> str:
    return f"{_TG_API}/bot{_env('TELEGRAM_BOT_TOKEN')}/{method}"


async def telegram_bot_info() -> Optional[dict[str, Any]]:
    """{username, link} for the configured bot, or None."""
    if not _telegram_ready():
        return None
    try:
        async with _client_factory() as c:
            r = await c.get(_tg_url("getMe"))
        u = (r.json() or {}).get("result") or {}
        name = u.get("username")
        return {"username": name, "link": f"https://t.me/{name}?start=medsim"} if name else None
    except Exception as e:  # noqa: BLE001
        log.warning("telegram getMe failed: %s", type(e).__name__)
        return None


async def _tg_resolve_chat(c: httpx.AsyncClient, dest: str) -> Optional[int]:
    d = dest.strip().lower()
    if d.startswith("tg:"):
        try:
            return int(d[3:])
        except ValueError:
            return None
    r = await c.get(_tg_url("getUpdates"), params={"limit": 100, "timeout": 0})
    updates = (r.json() or {}).get("result") or []
    for u in reversed(updates):
        msg = u.get("message") or u.get("edited_message") or {}
        chat = msg.get("chat") or {}
        if not chat.get("id"):
            continue
        uname = "@" + str(chat.get("username") or "").lower()
        _tg_chats[uname] = chat["id"]
        if d in ("telegram", "tg") or d == uname:
            return chat["id"]
    return _tg_chats.get(d)


async def _send_telegram(dest: str, message: str, mp3: Optional[bytes], ics: Optional[bytes]) -> dict[str, Any]:
    async with _client_factory() as c:
        chat_id = await _tg_resolve_chat(c, dest)
        if not chat_id:
            return _fail("telegram", dest, "No Telegram chat yet: open the bot link on the phone and press Start, then retry")
        r = await c.post(_tg_url("sendMessage"), json={"chat_id": chat_id, "text": message})
        body = r.json() if r.content else {}
        if not body.get("ok"):
            return _fail("telegram", dest, f"Telegram error: {str(body.get('description') or r.status_code)[:120]}")
        sent = {"ok": True, "channel": "telegram", "to": mask(dest), "messageId": str(body["result"]["message_id"])}
        if mp3:
            a = await c.post(_tg_url("sendAudio"), data={"chat_id": str(chat_id), "title": "Your prescription (MedSim)",
                                                          "performer": "MedSim Clinic"},
                             files={"audio": ("prescription.mp3", mp3, "audio/mpeg")})
            sent["audioSent"] = bool(a.content and a.json().get("ok"))
        if ics:
            d = await c.post(_tg_url("sendDocument"), data={"chat_id": str(chat_id), "caption": "Follow-up: add to your calendar"},
                             files={"document": ("follow-up.ics", ics, "text/calendar")})
            sent["inviteSent"] = bool(d.content and d.json().get("ok"))
        return sent


# ------------------------------------------------------------------ public entry


async def send_to_patient(
    channel: str,
    to: str,
    message: str,
    audio_url: Optional[str] = None,
    mp3: Optional[bytes] = None,
    ics: Optional[bytes] = None,
) -> dict[str, Any]:
    ch = (channel or "auto").strip().lower()
    dest = (to or "").strip()
    try:
        phone = normalize_phone(dest)
        email_ok = is_email(dest)
        if ch == "auto" and is_telegram(dest) and _telegram_ready():
            ch = "telegram"
        if ch == "telegram":
            if not _telegram_ready():
                return _fail(ch, dest, "Telegram is not configured (set TELEGRAM_BOT_TOKEN)")
            tdest = dest if is_telegram(dest) else "telegram"
            if not _rate_ok("tg:" + tdest.lower()):
                return _fail(ch, tdest, f"Rate limit: at most {RATE_MAX} messages per destination per hour")
            res = await _send_telegram(tdest, message, mp3, ics)
            log.info("notify telegram ok=%s", res.get("ok"))
            return res
        if ch == "auto":
            if phone and _twilio_ready():
                ch = "whatsapp"
            elif email_ok and _smtp_ready():
                ch = "email"
            else:
                have = ", ".join(configured_channels()) or "none"
                return _fail("auto", dest, f"No configured channel fits this destination (configured: {have})")
        if ch not in ("whatsapp", "sms", "email"):
            return _fail(ch, dest, "Unknown channel (use telegram, whatsapp, sms, email or auto)")
        if ch == "email":
            if not email_ok:
                return _fail(ch, dest, "Invalid email address")
            key, target = dest.lower(), dest
        else:
            if not phone:
                return _fail(ch, dest, "Invalid phone number (use E.164 like +919876543210)")
            key, target = phone, phone
        if not _rate_ok(key):
            return _fail(ch, target, f"Rate limit: at most {RATE_MAX} messages per destination per hour")
        if ch == "email":
            res = await _send_email(target, message, mp3, ics)
        else:
            res = await _send_twilio(ch, target, message, audio_url)
        log.info("notify %s to %s ok=%s", ch, mask(target), res.get("ok"))
        return res
    except Exception as e:  # noqa: BLE001
        return _fail(ch, dest, f"Unexpected error: {type(e).__name__}")
