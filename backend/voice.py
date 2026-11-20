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
import llm_proxy

log = logging.getLogger("medsim.voice")
router = APIRouter()

AGORA_API = "https://api.agora.io/api/conversational-ai-agent/v2/projects"
MURF_STREAM_URL = "https://global.api.murf.ai/v1/speech/stream"
AGENT_UID = 900001
TOKEN_TTL_S = 7200 * 2  # >=2h: short tokens dropped long sessions

# Verified via GET https://api.murf.ai/v1/speech/voices?model=falcon-2.1
# (header `api-key`; NOT available on global.api.murf.ai). Override via env.
DEFAULT_VOICES = {"M": "en-IN-aarav", "F": "en-IN-priya", "nurse": "en-IN-anisha"}

# Indian English Falcon voices (listed live from the voices API, 2026-11-20).
# Patients get a stable voice per case so two patients rarely sound alike.
PATIENT_VOICE_POOLS = {
    "M": ["en-IN-aarav", "en-IN-nikhil", "en-IN-samar", "en-IN-abhinav", "en-IN-eashwar"],
    "F": ["en-IN-priya", "en-IN-pooja", "en-IN-anusha", "en-IN-isha", "en-IN-arohi", "en-IN-alia"],
}


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


def _voice_for(kind: str, case_id: str | None = None) -> str:
    env = {"M": "MURF_VOICE_MALE", "F": "MURF_VOICE_FEMALE", "nurse": "MURF_NURSE_VOICE"}[kind]
    override = os.environ.get(env, "").strip()
    if override:
        return override
    pool = PATIENT_VOICE_POOLS.get(kind)
    if pool and case_id:
        # Stable across runs (unlike hash(), which is salted per process).
        idx = int(hashlib.sha1(case_id.encode()).hexdigest(), 16) % len(pool)
        return pool[idx]
    return DEFAULT_VOICES[kind]


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


def _llm_block(system_prompt: str, greeting: str, *, probe: bool = False) -> dict[str, Any]:
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
            "failure_message": FAILURE_MESSAGE,
            "max_history": 32,
            "params": {"model": "gpt-4.1-mini", "max_tokens": 300},
        }
    prov = require_provider()
    common = {
        "style": "openai",
        "system_messages": [{"role": "system", "content": system_prompt}],
        "greeting_message": greeting,
        "failure_message": FAILURE_MESSAGE,
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


class VoiceStartRequest(BaseModel):
    caseId: str
    systemPrompt: str
    initialLine: str
    gender: Literal["M", "F"] = "M"
    locale: Optional[str] = None


class VoiceStartResponse(BaseModel):
    appId: str
    channel: str
    uid: int
    token: str
    agentUid: int
    agentId: str


def build_join_body(
    req: VoiceStartRequest, channel: str, user_uid: int, agent_token: str, murf_key: str
) -> dict[str, Any]:
    locale = req.locale or "en-IN"
    sarvam_key = os.environ.get("SARVAM_API_KEY", "").strip()
    asr: dict[str, Any] = (
        {"vendor": "sarvam", "params": {"api_key": sarvam_key, "language": "unknown"}}
        if sarvam_key and os.environ.get("VOICE_ASR", "sarvam").lower() == "sarvam"
        else {"vendor": "ares", "language": locale}
    )
    return {
        "name": f"medsim-{secrets.token_hex(6)}",
        "properties": {
            "channel": channel,
            "token": agent_token,
            "agent_rtc_uid": str(AGENT_UID),
            "remote_rtc_uids": [str(user_uid)],
            "idle_timeout": 120,
            "advanced_features": {"enable_rtm": True},
            "parameters": {"data_channel": "rtm", "enable_error_message": True},
            "asr": asr,
            "llm": _llm_block(req.systemPrompt, req.initialLine),
            "turn_detection": copy.deepcopy(TURN_DETECTION),
            "tts": {
                "vendor": "murf",
                "params": {
                    "api_key": murf_key,
                    "base_url": "wss://global.api.murf.ai/v1/speech/stream-input",
                    "voiceId": _voice_for(req.gender, req.caseId),
                    "model": os.environ.get("MURF_AGORA_MODEL", "").strip() or "FALCON",
                    "locale": locale,
                    "rate": 0,
                    "pitch": 0,
                    "sample_rate": 24000,
                },
            },
        },
    }


@router.post("/voice/start", response_model=VoiceStartResponse)
async def voice_start(req: VoiceStartRequest):
    env = _require_env(
        "AGORA_APP_ID", "AGORA_APP_CERTIFICATE", "AGORA_CUSTOMER_ID", "AGORA_CUSTOMER_SECRET", "MURF_API_KEY"
    )
    _llm_block("", "", probe=True)  # fail fast (503) if no LLM configured
    app_id, cert = env["AGORA_APP_ID"], env["AGORA_APP_CERTIFICATE"]
    safe_case = "".join(ch for ch in req.caseId if ch.isalnum() or ch in "-_")[:24] or "case"
    channel = f"medsim-{safe_case}-{secrets.token_hex(4)}"
    user_uid = secrets.randbelow(900000) + 100000
    user_token = _rtc_rtm_token(app_id, cert, channel, user_uid)
    agent_token = _rtc_rtm_token(app_id, cert, channel, AGENT_UID)

    body = build_join_body(req, channel, user_uid, agent_token, env["MURF_API_KEY"])
    r = await _agora_call("POST", "/join", body)
    if r.status_code != 200:
        raise _agora_fail(r, "join")
    try:
        agent_id = r.json()["agent_id"]
    except Exception:  # noqa: BLE001
        raise _agora_fail(r, "join (no agent_id)")
    return VoiceStartResponse(
        appId=app_id, channel=channel, uid=user_uid, token=user_token, agentUid=AGENT_UID, agentId=agent_id
    )


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


@router.post("/voice/tts")
async def voice_tts(req: VoiceTtsRequest):
    key = _require_env("MURF_API_KEY")["MURF_API_KEY"]
    body = {
        "text": req.text[:600],
        "voiceId": _voice_for(req.voice),
        "model": "falcon-2.1",
        "format": "MP3",
        "sampleRate": 24000,
        "locale": "en-US" if req.voice == "nurse" else "en-IN",
    }
    try:
        async with _client_factory() as c:
            r = await c.post(MURF_STREAM_URL, json=body, headers={"api-key": key})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Murf request failed: {type(e).__name__}")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Murf TTS failed ({r.status_code}): {r.text[:300]}")
    return Response(content=r.content, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
