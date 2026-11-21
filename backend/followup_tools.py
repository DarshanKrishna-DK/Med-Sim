"""Asha acts during the live follow-up call.

Agora "tools run inside your custom LLM endpoint" pattern: Agora's ConvoAI
engine calls our /llm proxy; for a follow-up-call token (llm_proxy token meta
kind "followup") the proxy hands the turn here. We call the provider
non-streaming with Asha's tools, execute any tool calls server-side (at most
2 rounds, each LLM call and each tool bounded to 8 s), then stream the final
assistant text back as OpenAI SSE chunks so Agora / Murf speaks it.

Tools
  escalate_red_flag(symptom, severity)  alert the doctor now + FHIR Flag + call history
  reschedule_call(when_text, in_days?, starts_in_minutes?)  Google Calendar + reminder
  log_symptom(symptom, adherence?)  structured notes on the call

Idempotent per call: one escalation per symptom, one booking per slot.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi.responses import Response, StreamingResponse

import lang as langmod
import llm_proxy
from llm_provider import chat, strip_think

log = logging.getLogger("medsim.followup_tools")

MAX_ROUNDS = 2
STEP_TIMEOUT_S = 8.0
MAX_TOOL_CALLS_PER_ROUND = 4

TOOLS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "escalate_red_flag",
        "description": "Alert the doctor NOW about a red-flag symptom the patient reported (chest pain, trouble breathing, "
                       "allergic reaction, heavy bleeding, fainting, thoughts of self harm). Call it once per symptom.",
        "parameters": {"type": "object", "properties": {
            "symptom": {"type": "string", "description": "The red flag in a few English words, e.g. 'chest pain since morning'"},
            "severity": {"type": "string", "enum": ["urgent", "emergency"]},
        }, "required": ["symptom", "severity"]},
    }},
    {"type": "function", "function": {
        "name": "reschedule_call",
        "description": "Move this follow-up call to another time the patient asked for. Books it in the calendar and "
                       "sends them a reminder with the same call link.",
        "parameters": {"type": "object", "properties": {
            "when_text": {"type": "string", "description": "What the patient said, e.g. 'tomorrow morning'"},
            "in_days": {"type": "integer", "minimum": 0, "maximum": 60, "description": "Days from today"},
            "starts_in_minutes": {"type": "integer", "minimum": 1, "maximum": 1440,
                                  "description": "Use instead of in_days for a time later today, e.g. 30"},
        }, "required": ["when_text"]},
    }},
    {"type": "function", "function": {
        "name": "log_symptom",
        "description": "Note a symptom or side effect the patient mentioned, for the doctor's report.",
        "parameters": {"type": "object", "properties": {
            "symptom": {"type": "string"},
            "adherence": {"type": "string", "enum": ["good", "partial", "poor"]},
        }, "required": ["symptom"]},
    }},
]

FILLERS = {
    "escalate_red_flag": {
        "en": "One moment, I'm letting your doctor know.",
        "hi": "एक पल, मैं आपके डॉक्टर को बता रही हूँ।",
    },
    "reschedule_call": {
        "en": "One moment, I'm moving your call.",
        "hi": "एक पल, मैं आपकी कॉल का समय बदल रही हूँ।",
    },
}

FALLBACK = {
    "en": "Sorry, I could not finish that just now. I have noted it for your doctor.",
    "hi": "माफ़ कीजिए, अभी यह पूरा नहीं हो पाया। मैंने इसे आपके डॉक्टर के लिए नोट कर लिया है।",
}
EMERGENCY_FALLBACK = {
    "en": "I have let your doctor know. Please go to the nearest emergency department now, or call 108 for an ambulance.",
    "hi": "मैंने आपके डॉक्टर को बता दिया है। कृपया अभी नज़दीकी इमरजेंसी में जाइए, या एम्बुलेंस के लिए 108 पर कॉल कीजिए।",
}

# Calls whose record is not in followup_call._history yet (race with /start).
_orphans: dict[str, dict[str, list]] = {}
_bg: set[asyncio.Future] = set()


def _pick(table: dict[str, str], lang: str) -> str:
    return table.get(lang) or table["en"]


def _clip(value: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:n]


def _key(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


# ---------------------------------------------------------------- call state

def _ctx(meta: dict[str, Any]) -> dict[str, Any]:
    import followup_call
    from integrations import followup_calls

    token = str(meta.get("callToken") or "")
    call_id = str(meta.get("callId") or "")
    snap = followup_calls.get_call(token) or {}
    call = followup_call.find_call(token, call_id)
    if call is not None:
        actions = call.setdefault("actions", followup_call.new_actions())
        orphan = _orphans.pop(call_id, None)
        if orphan:  # actions taken before the call record existed
            for k, v in orphan.items():
                actions.setdefault(k, []).extend(v)
    else:
        actions = _orphans.setdefault(call_id, followup_call.new_actions())
        while len(_orphans) > 200:
            _orphans.pop(next(iter(_orphans)))
    return {"token": token, "callId": call_id, "snap": snap, "actions": actions,
            "lang": langmod.norm_lang(snap.get("lang"))}


def _now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- tools

async def escalate_red_flag(ctx: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    from integrations import fhir, notify

    symptom = _clip(args.get("symptom"), 160) or "unspecified red flag"
    severity = str(args.get("severity") or "").lower()
    if severity not in ("urgent", "emergency"):
        severity = "emergency"
    k = _key(symptom)
    for f in ctx["actions"]["redFlags"]:
        if _key(f["symptom"]) == k:
            return {"ok": True, "alreadyEscalated": True, "doctorNotified": f.get("doctorNotified")}
    rec = {"symptom": symptom, "severity": severity, "at": _now_ms(), "doctorNotified": None, "fhir": None}
    ctx["actions"]["redFlags"].append(rec)  # recorded first: a concurrent retry dedupes on it
    snap = ctx["snap"]
    name = _clip(snap.get("patientName"), 60) or "a patient"
    text = f"RED FLAG from {name}'s follow-up call: {symptom}. Asha advised emergency care / 108."
    dest = (os.environ.get("DOCTOR_ALERT_DEST") or "").strip() or _clip(snap.get("contact"), 120)

    async def deliver() -> None:
        async def alert() -> None:
            if not dest:
                rec["doctorNotified"] = False
                return
            res = await notify.send_to_patient("auto", dest, text)
            rec["doctorNotified"] = bool(res.get("ok"))

        async def flag() -> None:
            case = {"id": snap.get("caseId", ""), "name": snap.get("patientName") or "Synthetic Patient",
                    "age": snap.get("age"), "gender": snap.get("gender", "")}
            rec["fhir"] = await fhir.record_flag(case, text)

        await asyncio.gather(alert(), flag(), return_exceptions=True)

    # Shielded: a slow channel never loses the alert, it only stops us waiting for it.
    task = asyncio.ensure_future(deliver())
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=STEP_TIMEOUT_S - 1.0)
    except asyncio.TimeoutError:
        return {"ok": True, "doctorNotified": "pending"}
    return {"ok": True, "doctorNotified": bool(rec["doctorNotified"]), "fhirRecorded": bool(rec["fhir"])}


def _int_or_none(v: Any, lo: int, hi: int) -> Optional[int]:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return None


async def reschedule_call(ctx: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    from integrations import calendar_invite, call_reminders, gcal_script, notify

    when_text = _clip(args.get("when_text"), 80)
    mins = _int_or_none(args.get("starts_in_minutes"), 1, 1440)
    days = _int_or_none(args.get("in_days"), 0, 60)
    if mins is None and days is None:
        if not when_text:
            return {"ok": False, "error": "say when: in_days or starts_in_minutes"}
        days = 1
    slot = f"m{mins}" if mins is not None else f"d{days}"
    for r in ctx["actions"]["reschedules"]:
        if r.get("slot") == slot:
            return {"ok": True, "alreadyBooked": True, "startText": r.get("startText")}
    snap = ctx["snap"]
    if not snap:
        return {"ok": False, "error": "call link expired"}
    name = _clip(snap.get("patientName"), 60) or "Patient"
    reason = _clip(snap.get("reason"), 120) or "follow-up call"
    path = f"/call/{ctx['token']}"
    call_url = notify.absolute_url(path) or path
    start_at = datetime.now(timezone.utc) + timedelta(minutes=mins) if mins is not None else None
    cal = calendar_invite.make_follow_up(snap.get("caseId", "case"), name, days or 0, reason,
                                         call_url=call_url, start_at=start_at)
    start = datetime.fromisoformat(cal["start"])
    contact = _clip(snap.get("contact"), 120)
    booked = await gcal_script.book_event(cal["title"], cal.get("description", ""), start,
                                          minutes=cal.get("minutes", 20),
                                          guest_email=contact if "@" in contact else None)
    reminders = call_reminders.schedule(contact, name, call_url, start, None, reason) if contact else []
    rec = {"slot": slot, "whenText": when_text, "startText": cal.get("startText"), "at": _now_ms(),
           "booked": bool(booked and booked.get("ok")), "reminders": len(reminders)}
    ctx["actions"]["reschedules"].append(rec)
    return {"ok": True, "startText": rec["startText"], "calendarBooked": rec["booked"],
            "reminderScheduled": bool(reminders)}


async def log_symptom(ctx: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    symptom = _clip(args.get("symptom"), 160)
    if not symptom:
        return {"ok": False, "error": "symptom is required"}
    adherence = str(args.get("adherence") or "").lower()
    adherence = adherence if adherence in ("good", "partial", "poor") else None
    if not any(_key(s["symptom"]) == _key(symptom) for s in ctx["actions"]["symptoms"]):
        ctx["actions"]["symptoms"].append({"symptom": symptom, "adherence": adherence, "at": _now_ms()})
        del ctx["actions"]["symptoms"][:-20]
    return {"ok": True, "logged": symptom}


_IMPL = {"escalate_red_flag": escalate_red_flag, "reschedule_call": reschedule_call, "log_symptom": log_symptom}


def _last_user(messages: list[dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            return _clip(m.get("content"), 160)
    return ""


async def run_tool(ctx: dict[str, Any], name: str, raw_args: Any, messages: list[dict[str, Any]]) -> dict[str, Any]:
    fn = _IMPL.get(name)
    if not fn:
        return {"ok": False, "error": f"unknown tool {name}"}
    try:
        args = raw_args if isinstance(raw_args, dict) else json.loads(raw_args or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be an object")
    except (ValueError, TypeError):
        if name != "escalate_red_flag":
            return {"ok": False, "error": "malformed arguments"}
        # Safety first: a garbled escalation still alerts the doctor with the patient's words.
        args = {"symptom": _last_user(messages) or "unspecified red flag", "severity": "emergency"}
    try:
        return await asyncio.wait_for(fn(ctx, args), timeout=STEP_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timed out"}
    except Exception as e:  # noqa: BLE001
        log.warning("follow-up tool %s failed: %s", name, type(e).__name__)
        return {"ok": False, "error": type(e).__name__}


# ---------------------------------------------------------------- turn

def _actions_note(actions: dict[str, list]) -> Optional[dict[str, str]]:
    bits = []
    if actions["redFlags"]:
        bits.append("doctor already alerted about: " + "; ".join(f["symptom"] for f in actions["redFlags"]))
    if actions["reschedules"]:
        bits.append("call already moved to: " + "; ".join(str(r.get("startText")) for r in actions["reschedules"]))
    if not bits:
        return None
    return {"role": "system", "content": "Actions already taken in this call (do not repeat them): " + ". ".join(bits) + "."}


async def _llm(messages: list[dict[str, Any]], payload: dict[str, Any], stick_to: Optional[str]) -> tuple[dict[str, Any], str]:
    client = llm_proxy._client_factory()
    try:
        return await asyncio.wait_for(
            chat(messages, tools=TOOLS, max_tokens=int(payload.get("max_tokens") or 300),
                 temperature=float(payload.get("temperature") or 0.5), client=client, stick_to=stick_to),
            timeout=STEP_TIMEOUT_S,
        )
    finally:
        await client.aclose()


async def run_turn(payload: dict[str, Any], meta: dict[str, Any], emit_filler=None) -> str:
    """One Asha turn with tools. Returns the final text to speak (never raises)."""
    ctx = _ctx(meta)
    lang = ctx["lang"]
    messages = llm_proxy.sanitize_messages(payload.get("messages"))
    note = _actions_note(ctx["actions"])
    if note:
        messages.append(note)
    provider: Optional[str] = None
    escalated = False
    filler_sent = False
    for _round in range(MAX_ROUNDS):
        try:
            msg, provider = await _llm(messages, payload, provider)
        except Exception as e:  # noqa: BLE001 - HTTPException (502/503), timeouts, bad bodies
            log.warning("follow-up LLM round failed: %s", type(e).__name__)
            return _pick(EMERGENCY_FALLBACK if escalated else FALLBACK, lang)
        calls = [c for c in (msg.get("tool_calls") or []) if isinstance(c, dict)][:MAX_TOOL_CALLS_PER_ROUND]
        text = strip_think(str(msg.get("content") or ""))
        if not calls:
            return text or _pick(EMERGENCY_FALLBACK if escalated else FALLBACK, lang)
        names = [str((c.get("function") or {}).get("name") or "") for c in calls]
        if emit_filler and not filler_sent:
            tool = "escalate_red_flag" if "escalate_red_flag" in names else "reschedule_call" if "reschedule_call" in names else None
            line = FILLERS.get(tool or "", {}).get(lang)
            if line:
                await emit_filler(line)
                filler_sent = True
        results = await asyncio.gather(*[
            run_tool(ctx, n, (c.get("function") or {}).get("arguments"), messages) for n, c in zip(names, calls)
        ])
        escalated = escalated or "escalate_red_flag" in names
        messages.append({"role": "assistant", "content": text or None, "tool_calls": [
            {"id": c.get("id") or f"call_{i}", "type": "function",
             "function": {"name": n, "arguments": (c.get("function") or {}).get("arguments") or "{}"}}
            for i, (n, c) in enumerate(zip(names, calls))]})
        for i, (c, res) in enumerate(zip(calls, results)):
            messages.append({"role": "tool", "tool_call_id": c.get("id") or f"call_{i}",
                             "content": json.dumps(res, ensure_ascii=False)})
    # Rounds used up while the model still wanted tools: speak a safe line.
    return _pick(EMERGENCY_FALLBACK if escalated else FALLBACK, lang)


async def handle(payload: dict[str, Any], meta: dict[str, Any], model: str) -> Response:
    """Proxy entry point for follow-up-call tokens."""
    cid = "chatcmpl-asha-" + secrets.token_hex(6)
    if payload.get("stream", True) is False:
        return llm_proxy.completion_json(cid, model, await run_turn(payload, meta))

    async def gen():
        queue: asyncio.Queue = asyncio.Queue()

        async def filler(line: str) -> None:
            await queue.put(line + " ")

        async def work() -> None:
            try:
                await queue.put(await run_turn(payload, meta, filler))
            finally:
                await queue.put(None)

        # Held in _bg so the tools finish even if Agora drops the stream mid-turn.
        task = asyncio.ensure_future(work())
        _bg.add(task)
        task.add_done_callback(_bg.discard)
        yield llm_proxy.sse_chunk(cid, model, {"role": "assistant", "content": ""})
        while (piece := await queue.get()) is not None:
            if piece:
                yield llm_proxy.sse_chunk(cid, model, {"content": piece})
        yield llm_proxy.sse_chunk(cid, model, {}, "stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
