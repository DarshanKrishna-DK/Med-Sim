"""Mistake coach: POST /agent/coach/check and POST /agent/coach/explain.

"Nurse Asha" watches the trainee's encounter and flags real mistakes only
(allergy conflict, contraindication, dangerous dose, missed red flag,
prescribing before any history, a harmful or irrelevant test, anchoring on a
wrong diagnosis). Two cheap deterministic rules run first; everything else
goes to the OpenAI-compatible provider (Sarvam first, Groq fallback) in JSON
mode with a short timeout. Any failure degrades to "no alert": the coach is
advisory and must never block the encounter. Keys are never logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from llm_provider import chat, strip_think
from nurse import ALLERGY_CLASSES, _norm

log = logging.getLogger("medsim.coach")
router = APIRouter()

COACH_TIMEOUT_S = 8.0
EM_DASH = chr(0x2014)
SEVERITIES = ("info", "warning", "danger")


# ── request / response models ──────────────────────────────────────────────


class QA(BaseModel):
    question: str = ""
    answer: str = ""


class CoachPatient(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = ""
    age: Optional[float] = None
    gender: str = ""
    chiefComplaint: str = ""
    allergies: Optional[str] = None
    anamnesis: list[QA] = Field(default_factory=list)
    vitals: dict[str, Any] = Field(default_factory=dict)


class CoachEvent(BaseModel):
    kind: Literal["order", "prescription", "diagnosis", "utterance"]
    detail: str = ""


class EncounterSoFar(BaseModel):
    model_config = ConfigDict(extra="ignore")

    orderedTests: list[str] = Field(default_factory=list)
    prescriptions: list[str] = Field(default_factory=list)
    askedHistory: bool = False
    transcriptTail: list[str] = Field(default_factory=list)


class CoachCheckRequest(BaseModel):
    caseId: str = ""
    event: CoachEvent
    patient: CoachPatient = Field(default_factory=CoachPatient)
    correctDiagnosis: Optional[str] = None
    encounterSoFar: EncounterSoFar = Field(default_factory=EncounterSoFar)


class CoachAlert(BaseModel):
    id: str
    severity: Literal["info", "warning", "danger"]
    title: str
    short: str
    explanation: str
    suggestion: str = ""


class CoachCheckResponse(BaseModel):
    alert: Optional[CoachAlert] = None


class CoachExplainRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    alert: dict[str, Any] = Field(default_factory=dict)
    question: Optional[str] = None
    caseId: str = ""
    patient: CoachPatient = Field(default_factory=CoachPatient)


class CoachExplainResponse(BaseModel):
    answer: str


# ── text helpers ───────────────────────────────────────────────────────────


def _clean(text: Any) -> str:
    s = re.sub(r"\s*" + EM_DASH + r"\s*", ", ", str(text or "")).replace(chr(0x2013), "-")
    return re.sub(r"\s+", " ", s).strip()


def _words(text: Any, limit: int) -> str:
    parts = _clean(text).split(" ")
    if len(parts) <= limit:
        return " ".join(p for p in parts if p)
    return " ".join(parts[:limit]).rstrip(",;:") + "..."


def _new_id() -> str:
    return f"ca-{secrets.token_hex(5)}"


def make_alert(severity: str, title: str, short: str, explanation: str, suggestion: str = "") -> CoachAlert:
    return CoachAlert(
        id=_new_id(),
        severity=severity if severity in SEVERITIES else "warning",  # type: ignore[arg-type]
        title=_words(title, 6),
        short=_words(short, 18),
        explanation=_clean(explanation)[:700],
        suggestion=_words(suggestion, 30),
    )


def coerce_alert(raw: Any) -> Optional[CoachAlert]:
    """Turn model JSON into an alert, or None. Anything malformed is None."""
    if not isinstance(raw, dict):
        return None
    a = raw.get("alert", raw if "title" in raw else None)
    if not isinstance(a, dict):
        return None
    title, short, explanation = _clean(a.get("title")), _clean(a.get("short")), _clean(a.get("explanation"))
    if not title or not (short or explanation):
        return None
    sev = _clean(a.get("severity")).lower()
    return make_alert(
        sev if sev in SEVERITIES else "warning",
        title,
        short or explanation,
        explanation or short,
        a.get("suggestion") or "",
    )


def parse_model_json(text: str) -> Optional[dict[str, Any]]:
    text = strip_think(text or "")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except (ValueError, TypeError):
        return None
    return v if isinstance(v, dict) else None


# ── deterministic rules (no LLM) ───────────────────────────────────────────

_NEGATION = re.compile(r"\b(no|not|none|nkda|denies|deny|never)\b")


def _allergy_sentences(p: CoachPatient) -> list[str]:
    raw = [p.allergies or ""]
    raw += [qa.answer for qa in p.anamnesis if "allerg" in f"{qa.question} {qa.answer}".lower()]
    out: list[str] = []
    for chunk in raw:
        for sent in re.split(r"[.;\n]|\bbut\b", chunk or "", flags=re.IGNORECASE):
            s = _norm(sent)
            if s and not _NEGATION.search(s):
                out.append(s)
    return out


def allergy_conflict(p: CoachPatient, drug: str) -> Optional[str]:
    """Allergy class the drug falls into, if the patient's documented allergy covers it."""
    d = _norm(drug)
    if not d:
        return None
    for sent in _allergy_sentences(p):
        for cls, members in ALLERGY_CLASSES.items():
            if cls in sent or any(m in sent for m in members):
                if any(m in d for m in members):
                    return cls
    return None


def rule_alert(req: CoachCheckRequest) -> Optional[CoachAlert]:
    ev = req.event
    if ev.kind == "prescription":
        cls = allergy_conflict(req.patient, ev.detail)
        if cls:
            return make_alert(
                "danger",
                "Allergy conflict",
                f"{_words(ev.detail, 6)} conflicts with a documented {cls} allergy.",
                f"The patient has a documented {cls} allergy and {_words(ev.detail, 6)} belongs to that drug class. "
                "Always check allergies before prescribing, because cross-reactivity within a class can cause "
                "anaphylaxis. Cancel it and choose an agent from a different class.",
                "Stop this drug and pick a safe alternative from another class.",
            )
        if not req.encounterSoFar.askedHistory:
            return make_alert(
                "warning",
                "Prescribing before history",
                "You prescribed before taking any history from the patient.",
                "Treatment should follow an assessment. Without a history you do not know the allergies, current "
                "medicines, pregnancy status or red flags that change what is safe to give. Ask a focused history "
                "first, then prescribe.",
                "Ask about allergies, current medicines and the main symptom before prescribing.",
            )
    return None


def needs_llm(req: CoachCheckRequest) -> bool:
    ev = req.event
    if not _clean(ev.detail):
        return False
    if ev.kind == "diagnosis" and req.correctDiagnosis and _norm(ev.detail) == _norm(req.correctDiagnosis):
        return False  # correct diagnosis, nothing to flag
    return True


# ── LLM check ──────────────────────────────────────────────────────────────

CHECK_SYSTEM = (
    "You are Nurse Asha, a senior nurse educator quietly watching a trainee doctor in a SYNTHETIC clinical "
    "training simulation. Decide whether the trainee's LATEST EVENT is a real clinical mistake.\n"
    "Be conservative: most events are fine and the right answer is usually {\"alert\": null}. Only flag clear "
    "problems of these kinds: allergy conflict, contraindication or dangerous interaction, dangerous dose, a "
    "missed or ignored red flag, prescribing before any history, ordering a test that is irrelevant to the "
    "complaint or harmful, or anchoring on a wrong diagnosis that the findings do not support. Never flag style, "
    "reasonable extra tests, normal questions or small talk.\n"
    "For a diagnosis event that does not match the correct diagnosis, say which findings do not fit; you may "
    "name the better diagnosis.\n"
    "Reply with JSON only, one of:\n"
    "{\"alert\": null}\n"
    "{\"alert\": {\"severity\": \"info\"|\"warning\"|\"danger\", \"title\": \"max 6 words\", "
    "\"short\": \"max 18 words\", \"explanation\": \"2-4 sentences, warm teaching tone, cite the principle\", "
    "\"suggestion\": \"one concrete next step\"}}\n"
    "Use danger only for things that could seriously harm the patient. Plain words, no markdown, no em dashes."
)


def _check_user(req: CoachCheckRequest) -> str:
    p = req.patient
    return json.dumps(
        {
            "latestEvent": req.event.model_dump(),
            "patient": {
                "name": p.name, "age": p.age, "gender": p.gender, "chiefComplaint": p.chiefComplaint,
                "allergies": p.allergies or "not recorded", "vitals": p.vitals,
                "anamnesis": [qa.model_dump() for qa in p.anamnesis][:24],
            },
            "correctDiagnosis": req.correctDiagnosis or "unknown",
            "encounterSoFar": {
                "orderedTests": req.encounterSoFar.orderedTests[-20:],
                "prescriptions": req.encounterSoFar.prescriptions[-12:],
                "askedHistory": req.encounterSoFar.askedHistory,
                "transcriptTail": [_words(t, 60) for t in req.encounterSoFar.transcriptTail[-10:]],
            },
        },
        default=str,
    )[:12000]


async def _llm(messages: list[dict[str, Any]], *, json_mode: bool, max_tokens: int) -> Optional[str]:
    """One bounded LLM call. Returns content, or None on any failure/timeout."""
    try:
        msg, _ = await asyncio.wait_for(
            chat(messages, json_mode=json_mode, max_tokens=max_tokens, temperature=0.1),
            timeout=COACH_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        log.warning("coach LLM timed out after %.0fs", COACH_TIMEOUT_S)
        return None
    except HTTPException as e:
        log.warning("coach LLM unavailable (HTTP %s)", e.status_code)
        return None
    except Exception as e:  # noqa: BLE001
        log.warning("coach LLM failed: %s", type(e).__name__)
        return None
    return (msg or {}).get("content") or ""


@router.post("/agent/coach/check", response_model=CoachCheckResponse)
async def coach_check(req: CoachCheckRequest) -> CoachCheckResponse:
    hit = rule_alert(req)
    if hit:
        return CoachCheckResponse(alert=hit)
    if not needs_llm(req):
        return CoachCheckResponse(alert=None)
    content = await _llm(
        [{"role": "system", "content": CHECK_SYSTEM}, {"role": "user", "content": _check_user(req)}],
        json_mode=True,
        max_tokens=500,
    )
    if content is None:
        return CoachCheckResponse(alert=None)
    return CoachCheckResponse(alert=coerce_alert(parse_model_json(content)))


# ── explain / follow-up ────────────────────────────────────────────────────

EXPLAIN_SYSTEM = (
    "You are Nurse Asha, a warm, experienced Indian senior nurse educator in a SYNTHETIC clinical training "
    "simulation. The trainee doctor is asking about an alert you raised. Answer in at most 80 words, spoken "
    "style: short plain sentences you would say out loud, no lists, no markdown, no em dashes. Explain the "
    "principle and what to do next. Stay on the topic of the alert and this patient."
)


def _fallback_answer(alert: dict[str, Any]) -> str:
    base = " ".join(x for x in (_clean(alert.get("explanation")), _clean(alert.get("suggestion"))) if x)
    return _words(base or "I flagged this because it could put the patient at risk. Let's review it together.", 80)


@router.post("/agent/coach/explain", response_model=CoachExplainResponse)
async def coach_explain(req: CoachExplainRequest) -> CoachExplainResponse:
    a = req.alert or {}
    question = _clean(req.question) or "Why is that wrong?"
    p = req.patient
    user = json.dumps(
        {
            "alert": {k: _clean(a.get(k)) for k in ("severity", "title", "short", "explanation", "suggestion")},
            "patient": {"name": p.name, "age": p.age, "gender": p.gender, "chiefComplaint": p.chiefComplaint,
                        "allergies": p.allergies or "not recorded"},
            "question": _words(question, 60),
        },
        default=str,
    )[:6000]
    content = await _llm(
        [{"role": "system", "content": EXPLAIN_SYSTEM}, {"role": "user", "content": user}],
        json_mode=False,
        max_tokens=300,
    )
    answer = _words(strip_think(content or ""), 80) if content else ""
    return CoachExplainResponse(answer=answer or _fallback_answer(a))
