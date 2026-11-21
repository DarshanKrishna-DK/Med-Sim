"""Real-time voice: Agora Conversational AI Engine + Murf Falcon TTS.

Endpoints
  POST /voice/start    create channel, mint tokens, start the ConvoAI agent
  POST /voice/stop     leave (idempotent)
  POST /voice/speak    make the agent say a line (farewell)
  POST /voice/context  replace the agent's LLM system messages (update API)
  POST /voice/tts      Murf Falcon MP3 (in-room nurse voice)

Verified against docs.agora.io OpenAPI (rest-api.en.yaml):
  join   POST /v2/projects/{appid}/join
  leave  POST /v2/projects/{appid}/agents/{id}/leave
  speak  POST /v2/projects/{appid}/agents/{id}/speak  {text, priority, interruptable}
  update POST /v2/projects/{appid}/agents/{id}/update {properties:{llm:{system_messages}}}
Murf docs: Agora tts params {api_key, voiceId, locale, model, sample_rate};
Murf HTTP stream: POST https://global.api.murf.ai/v1/speech/stream, header api-key.

Secrets are read from the environment per call and never logged/returned.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import logging
import os
import secrets
import time
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from agora_token import RtcTokenBuilder, Role_Publisher
from llm_provider import require_provider
import observer
import llm_proxy
import lang as langmod
import viva

log = logging.getLogger("medsim.voice")
router = APIRouter()

AGORA_API = "https://api.agora.io/api/conversational-ai-agent/v2/projects"
MURF_STREAM_URL = "https://global.api.murf.ai/v1/speech/stream"
AGENT_UID = 900001
TOKEN_TTL_S = 7200 * 2  # >=2h: short tokens dropped long sessions
AGENT_IDLE_TIMEOUT_S = 45  # was 120; see build_join_body

# Verified via GET https://api.murf.ai/v1/speech/voices?model=falcon-2.1
# (header `api-key`; NOT available on global.api.murf.ai). Override via env.
DEFAULT_VOICES = {"M": "en-IN-aarav", "F": "en-IN-priya", "nurse": "en-IN-anisha"}

# Indian English Falcon voices (listed live from the voices API, 2026-11-20).
# Patients get a stable voice per case so two patients rarely sound alike.
# Per-language pools (hi-IN / kn-IN support) live in lang.py.
PATIENT_VOICE_POOLS = langmod.PATIENT_VOICE_POOLS["en"]


def _client_factory() -> httpx.AsyncClient:
    """Indirection so tests can inject a mock transport."""
    return httpx.AsyncClient(timeout=20.0)


def _require_env(*names: str) -> dict[str, str]:
    missing = [n for n in names if not os.environ.get(n, "").strip()]
    if missing:
        raise HTTPException(status_code=503, detail=f"Voice not configured: missing {', '.join(missing)}")
    return {n: os.environ[n].strip() for n in names}


def voice_health() -> dict[str, Any]:
    def has(n: str) -> bool:
        return bool(os.environ.get(n, "").strip())

    return {
        "transport": "agora",
        "agora_configured": has("AGORA_APP_ID") and has("AGORA_APP_CERTIFICATE"),
        "agora_convoai_configured": has("AGORA_CUSTOMER_ID") and has("AGORA_CUSTOMER_SECRET"),
        "murf_configured": has("MURF_API_KEY"),
    }


def _voice_for(kind: str, case_id: str | None = None, lang: str | None = "en") -> str:
    """Murf voice id. English honours the MURF_* env overrides; hi/kn always pick
    from voices that list the locale (an override could lack hi-IN/kn-IN support)."""
    lg = langmod.norm_lang(lang)
    if case_id == viva.VIVA_CASE_ID:
        return viva.examiner_voice(lg)
    if lg == "en":
        env = {"M": "MURF_VOICE_MALE", "F": "MURF_VOICE_FEMALE", "nurse": "MURF_NURSE_VOICE"}[kind]
        override = os.environ.get(env, "").strip()
        if override:
            return override
    if kind == "nurse":
        return langmod.nurse_voice(lg)
    if case_id:
        return langmod.pick_patient_voice(lg, kind, case_id)
    return DEFAULT_VOICES[kind] if lg == "en" else langmod.pick_patient_voice(lg, kind, None)


def _basic_auth() -> str:
    e = _require_env("AGORA_CUSTOMER_ID", "AGORA_CUSTOMER_SECRET")
    raw = f"{e['AGORA_CUSTOMER_ID']}:{e['AGORA_CUSTOMER_SECRET']}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def _agora_headers() -> dict[str, str]:
    return {"Authorization": _basic_auth(), "Content-Type": "application/json"}


def _rtc_rtm_token(app_id: str, cert: str, channel: str, uid: int) -> str:
    return RtcTokenBuilder.build_token_with_rtm(
        app_id, cert, channel, str(uid), Role_Publisher, TOKEN_TTL_S, TOKEN_TTL_S
    )


FAILURE_MESSAGE = "Sorry doctor, I didn't catch that. Could you say it again?"

# Noise-robust turn detection (field names per Agora /join reference).
TURN_DETECTION = {
    "mode": "default",
    "config": {
        "speech_threshold": 0.6,
        "start_of_speech": {
            "mode": "vad",
            "vad_config": {"interrupt_duration_ms": 240, "prefix_padding_ms": 800},
        },
        "end_of_speech": {"mode": "vad", "vad_config": {"silence_duration_ms": 640}},
    },
}


# Agora "talking while waiting" fillers (properties.filler_words, join reference).
# Static only: generated fillers need a BYOK OpenAI/Groq/xAI LLM, ours is custom/Sarvam.
# Phrases per language live in lang.py (FILLERS).
FILLER_PHRASES = langmod.FILLERS["en"]
FILLER_WAIT_MS = 1100


def filler_block(lang: str | None = "en", case_id: str | None = None) -> dict[str, Any]:
    phrases = viva.examiner_fillers(lang) if case_id == viva.VIVA_CASE_ID else langmod.fillers(lang)
    return {
        "enable": True,
        "trigger": {"fixed_time_config": {"response_wait_ms": FILLER_WAIT_MS}},
        "content": {
            "mode": "static",
            "static_config": {"phrases": phrases, "selection_rule": "shuffle"},
        },
    }


def _llm_block(system_prompt: str, greeting: str, *, probe: bool = False, lang: str | None = "en") -> dict[str, Any]:
    """PATIENT_LLM_PROVIDER = sarvam (default) | groq | managed (Agora-managed
    OpenAI, no key needed). sarvam/groq fall back to the other if unconfigured.

    When a verified public URL exists, Agora calls our /llm proxy (which cleans
    blank noise turns and holds the real key) with a per-agent bearer token."""
    if (os.environ.get("PATIENT_LLM_PROVIDER") or "").strip().lower() == "managed":
        return {
            "credential_mode": "managed",
            "vendor": "openai",
            "style": "openai",
            "url": "https://api.openai.com/v1/chat/completions",
            "system_messages": [{"role": "system", "content": system_prompt}],
            "greeting_message": greeting,
            "failure_message": langmod.failure_message(lang),
            "max_history": 32,
            "params": {"model": "gpt-4.1-mini", "max_tokens": 300},
        }
    prov = require_provider()
    common = {
        "style": "openai",
        "system_messages": [{"role": "system", "content": system_prompt}],
        "greeting_message": greeting,
        "failure_message": langmod.failure_message(lang),
        "max_history": 32,
        "params": {"model": prov["model"], "max_tokens": 300, "temperature": 0.7},
    }
    pub = llm_proxy.public_url()
    if pub:
        return {
            "vendor": "custom",
            "url": pub + llm_proxy.PROXY_PATH,
            "api_key": "probe" if probe else llm_proxy.mint_token(),
            **common,
        }
    return {"url": prov["url"], "api_key": prov["api_key"], **common}


async def _agora_call(method: str, path: str, body: Optional[dict] = None) -> httpx.Response:
    app_id = _require_env("AGORA_APP_ID")["AGORA_APP_ID"]
    url = f"{AGORA_API}/{app_id}{path}"
    try:
        async with _client_factory() as c:
            return await c.request(method, url, json=body, headers=_agora_headers())
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Agora request failed: {type(e).__name__}")


def _agora_fail(r: httpx.Response, what: str) -> HTTPException:
    return HTTPException(status_code=502, detail=f"Agora {what} failed ({r.status_code}): {r.text[:800]}")


AVATAR_UID = 900002
# Murf sample_rate each avatar vendor needs (Agora avatar docs). Anam accepts
# 16/24/48k and we ask it for 24k, so Murf stays at 24k for anam and liveavatar.
AVATAR_SAMPLE_RATES = {"anam": 24000, "liveavatar": 24000, "heygen": 24000, "akool": 16000}
AVATAR_DEFAULT_CASES = {"teacher"}  # one avatar (Anam free tier): the Teacher Portal only


def avatar_config() -> Optional[dict[str, str]]:
    """Avatar settings from env, or None when not configured (feature off)."""
    vendor = os.environ.get("AVATAR_VENDOR", "").strip().lower()
    key = os.environ.get("AVATAR_API_KEY", "").strip()
    if not vendor or not key:
        return None
    return {
        "vendor": vendor,
        "api_key": key,
        "avatar_id": os.environ.get("AVATAR_ID", "").strip(),
        "quality": os.environ.get("AVATAR_QUALITY", "").strip() or "high",
    }


def want_avatar(req: "VoiceStartRequest") -> bool:
    if avatar_config() is None:
        return False
    if req.avatar is None:
        return req.caseId in AVATAR_DEFAULT_CASES
    return req.avatar


def avatar_block(cfg: dict[str, str], avatar_token: str) -> dict[str, Any]:
    params: dict[str, Any] = {
        "api_key": cfg["api_key"],
        "agora_uid": str(AVATAR_UID),
        "agora_token": avatar_token,
    }
    if cfg["avatar_id"]:
        params["avatar_id"] = cfg["avatar_id"]
    vendor = cfg["vendor"]
    if vendor in ("anam", "liveavatar", "heygen"):
        params["quality"] = cfg["quality"]
    if vendor == "anam":
        params["sample_rate"] = AVATAR_SAMPLE_RATES["anam"]
    return {"enable": True, "vendor": vendor, "params": params}


class VoiceStartRequest(BaseModel):
    caseId: str
    systemPrompt: str
    initialLine: str
    gender: Literal["M", "F"] = "M"
    locale: Optional[str] = None
    avatar: Optional[bool] = None


class VoiceStartResponse(BaseModel):
    appId: str
    channel: str
    uid: int
    token: str
    agentUid: int
    agentId: str
    avatarUid: Optional[int] = None
    avatarError: Optional[str] = None


def build_join_body(
    req: VoiceStartRequest,
    channel: str,
    user_uid: int,
    agent_token: str,
    murf_key: str,
    avatar_token: Optional[str] = None,
    *,
    voice_kind: Optional[str] = None,
    idle_timeout: int = AGENT_IDLE_TIMEOUT_S,
) -> dict[str, Any]:
    """Agora /join body. voice_kind overrides req.gender for the Murf voice
    ('nurse' for Asha's follow-up call); idle_timeout is the post-leave linger."""
    lang = langmod.norm_lang(req.locale)
    locale = langmod.locale_for(lang)
    sarvam_key = os.environ.get("SARVAM_API_KEY", "").strip()
    asr: dict[str, Any] = (
        {"vendor": "sarvam", "params": {"api_key": sarvam_key, "language": "unknown"}}
        if sarvam_key and os.environ.get("VOICE_ASR", "sarvam").lower() == "sarvam"
        else {"vendor": "ares", "language": locale}
    )
    cfg = avatar_config() if avatar_token else None
    body = {
        "name": f"medsim-{secrets.token_hex(6)}",
        "properties": {
            "channel": channel,
            "token": agent_token,
            "agent_rtc_uid": str(AGENT_UID),
            "remote_rtc_uids": [str(user_uid)],
            # Seconds the agent lingers after the doctor leaves the channel. Kept
            # short so a crashed tab or lost /voice/stop burns few ConvoAI minutes.
            "idle_timeout": idle_timeout,
            "advanced_features": {"enable_rtm": True},
            "parameters": {"data_channel": "rtm", "enable_error_message": True, "enable_metrics": True},
            "asr": asr,
            "llm": _llm_block(req.systemPrompt, req.initialLine, lang=lang),
            "turn_detection": copy.deepcopy(TURN_DETECTION),
            "filler_words": filler_block(lang, req.caseId),
            "tts": {
                "vendor": "murf",
                "params": {
                    "api_key": murf_key,
                    "base_url": "wss://global.api.murf.ai/v1/speech/stream-input",
                    "voiceId": _voice_for(voice_kind or req.gender, req.caseId, lang),
                    "model": os.environ.get("MURF_AGORA_MODEL", "").strip() or "FALCON",
                    "locale": locale,
                    "rate": 0,
                    "pitch": 0,
                    "sample_rate": AVATAR_SAMPLE_RATES.get(cfg["vendor"], 24000) if cfg else 24000,
                },
            },
        },
    }
    if cfg and avatar_token:
        body["properties"]["avatar"] = avatar_block(cfg, avatar_token)
    return body


async def start_agent_session(
    req: VoiceStartRequest,
    *,
    voice_kind: Optional[str] = None,
    channel_prefix: str = "medsim",
    idle_timeout: int = AGENT_IDLE_TIMEOUT_S,
    translate_greeting: bool = True,
) -> VoiceStartResponse:
    """Mint RTC+RTM tokens, start one ConvoAI agent and return the session.
    Shared by /voice/start (patient persona) and the follow-up call (Asha)."""
    env = _require_env(
        "AGORA_APP_ID", "AGORA_APP_CERTIFICATE", "AGORA_CUSTOMER_ID", "AGORA_CUSTOMER_SECRET", "MURF_API_KEY"
    )
    _llm_block("", "", probe=True)  # fail fast (503) if no LLM configured
    app_id, cert = env["AGORA_APP_ID"], env["AGORA_APP_CERTIFICATE"]
    safe_case = "".join(ch for ch in req.caseId if ch.isalnum() or ch in "-_")[:24] or "case"
    channel = f"{channel_prefix}-{safe_case}-{secrets.token_hex(4)}"
    user_uid = secrets.randbelow(900000) + 100000
    user_token = _rtc_rtm_token(app_id, cert, channel, user_uid)
    agent_token = _rtc_rtm_token(app_id, cert, channel, AGENT_UID)

    # hi/kn: the opening line arrives in English (case chief complaint); speak it in the session language.
    if translate_greeting and langmod.norm_lang(req.locale) != "en":
        req = req.model_copy(update={"initialLine": await langmod.translate_line(req.initialLine, req.locale)})
    avatar_token = _rtc_rtm_token(app_id, cert, channel, AVATAR_UID) if want_avatar(req) else None
    body = build_join_body(
        req, channel, user_uid, agent_token, env["MURF_API_KEY"], avatar_token, voice_kind=voice_kind, idle_timeout=idle_timeout
    )
    r = await _agora_call("POST", "/join", body)
    avatar_error: Optional[str] = None
    if avatar_token and 400 <= r.status_code < 500:
        # The avatar is optional polish: retry without it so the call still works.
        avatar_error = f"Agora rejected the avatar ({r.status_code}): {r.text[:200]}"
        log.warning(avatar_error)
        body = build_join_body(
            req, channel, user_uid, agent_token, env["MURF_API_KEY"], None, voice_kind=voice_kind, idle_timeout=idle_timeout
        )
        r = await _agora_call("POST", "/join", body)
    if 400 <= r.status_code < 500 and "filler" in r.text.lower():
        # Fillers are polish: never let them block the call.
        log.warning("Agora rejected filler_words (%s); retrying join without it", r.status_code)
        body["properties"].pop("filler_words", None)
        r = await _agora_call("POST", "/join", body)
    if r.status_code != 200:
        raise _agora_fail(r, "join")
    try:
        agent_id = r.json()["agent_id"]
    except Exception:  # noqa: BLE001
        raise _agora_fail(r, "join (no agent_id)")
    observer.register_session(channel, user_uid, req.caseId, AGENT_UID)
    return VoiceStartResponse(
        appId=app_id, channel=channel, uid=user_uid, token=user_token, agentUid=AGENT_UID, agentId=agent_id,
        avatarUid=AVATAR_UID if avatar_token and not avatar_error else None, avatarError=avatar_error,
    )


@router.post("/voice/start", response_model=VoiceStartResponse, response_model_exclude_none=True)
async def voice_start(req: VoiceStartRequest):
    return await start_agent_session(req)


async def leave_agent(agent_id: str) -> bool:
    """Stop an agent. True when it stopped or was already gone (idempotent)."""
    r = await _agora_call("POST", f"/agents/{agent_id}/leave")
    if r.status_code == 200:
        return True
    t = r.text.lower()
    if r.status_code in (404, 410) or any(k in t for k in ("not found", "not exist", "invalidrequestbody", "shutting down", "conflict")):
        return True
    raise _agora_fail(r, "leave")


async def speak_line(agent_id: str, text: str, priority: str = "INTERRUPT", interruptable: bool = True) -> None:
    r = await _agora_call(
        "POST",
        f"/agents/{agent_id}/speak",
        {"text": text.encode()[:500].decode(errors="ignore"), "priority": priority, "interruptable": interruptable},
    )
    if r.status_code != 200:
        raise _agora_fail(r, "speak")


class AgentRef(BaseModel):
    agentId: str


@router.post("/voice/stop")
async def voice_stop(request: Request):
    # navigator.sendBeacon posts text/plain; accept JSON text under any content type.
    try:
        req = AgentRef.model_validate_json(await request.body())
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=422, detail="body must be JSON {agentId}")
    r = await _agora_call("POST", f"/agents/{req.agentId}/leave")
    if r.status_code == 200:
        return {"ok": True}
    # Already gone / unknown id => treat as stopped (idempotent).
    if r.status_code in (404, 410) or "not found" in r.text.lower() or "not exist" in r.text.lower() or "invalidrequestbody" in r.text.lower() or "shutting down" in r.text.lower() or "conflict" in r.text.lower():
        return {"ok": True, "alreadyStopped": True}
    raise _agora_fail(r, "leave")


class VoiceSpeakRequest(BaseModel):
    agentId: str
    text: str
    priority: Literal["INTERRUPT", "APPEND", "IGNORE"] = "INTERRUPT"
    interruptable: bool = True


@router.post("/voice/speak")
async def voice_speak(req: VoiceSpeakRequest):
    r = await _agora_call(
        "POST",
        f"/agents/{req.agentId}/speak",
        {"text": req.text.encode()[:500].decode(errors="ignore"), "priority": req.priority, "interruptable": req.interruptable},
    )
    if r.status_code != 200:
        raise _agora_fail(r, "speak")
    return {"ok": True}


class VoiceContextRequest(BaseModel):
    agentId: str
    systemPrompt: str


@router.post("/voice/context")
async def voice_context(req: VoiceContextRequest):
    """Best effort: the update API documents `properties.llm.system_messages`
    as runtime-updatable. Fails with 502 (Agora body) if the engine rejects it;
    the frontend should treat that as non-fatal."""
    r = await _agora_call(
        "POST",
        f"/agents/{req.agentId}/update",
        {"properties": {"llm": {"system_messages": [{"role": "system", "content": req.systemPrompt}]}}},
    )
    if r.status_code != 200:
        raise _agora_fail(r, "update")
    return {"ok": True}


class VoiceTtsRequest(BaseModel):
    text: str
    voice: Literal["nurse", "M", "F"] = "nurse"
    locale: Optional[str] = None
    # Backup voice engine: pass the case id + speaker gender to get the same
    # pooled Murf voice the Agora path (/voice/start) would use for this case.
    caseId: Optional[str] = None
    gender: Optional[Literal["M", "F"]] = None


def tts_voice_and_locale(req: VoiceTtsRequest) -> tuple[str, str]:
    """(Murf voiceId, locale) for a /voice/tts request. With caseId the voice
    matches build_join_body's pick for the same case, gender and language."""
    lang = langmod.norm_lang(req.locale)
    if req.caseId and req.voice != "nurse" or req.gender:
        kind = req.gender or (req.voice if req.voice in ("M", "F") else "M")
        return _voice_for(kind, req.caseId or None, lang), langmod.locale_for(lang)
    voice_id = _voice_for(req.voice, None, lang)
    locale = ("en-US" if req.voice == "nurse" else "en-IN") if lang == "en" else langmod.locale_for(lang)
    return voice_id, locale


@router.post("/voice/tts")
async def voice_tts(req: VoiceTtsRequest):
    key = _require_env("MURF_API_KEY")["MURF_API_KEY"]
    voice_id, locale = tts_voice_and_locale(req)
    body = {
        "text": req.text[:600],
        "voiceId": voice_id,
        "model": "falcon-2.1",
        "format": "MP3",
        "sampleRate": 24000,
        "locale": locale,
    }
    try:
        async with _client_factory() as c:
            r = await c.post(MURF_STREAM_URL, json=body, headers={"api-key": key})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Murf request failed: {type(e).__name__}")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Murf TTS failed ({r.status_code}): {r.text[:300]}")
    return Response(content=r.content, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
