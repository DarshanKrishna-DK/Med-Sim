"""Agentic charge nurse: POST /agent/nurse/act.

An OpenAI-compatible tool-use loop (Sarvam first, Groq fallback) that turns the
doctor's spoken orders into executed actions. Tools run server-side against the
request payload only; nothing is fabricated beyond tool output.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from llm_provider import chat, strip_think
import lang as langmod

log = logging.getLogger("medsim.nurse")
router = APIRouter()
MAX_ITERATIONS = 6


# ── request / response models ──────────────────────────────────────────────


class QA(BaseModel):
    question: str = ""
    answer: str = ""


class TestResultIn(BaseModel):
    testId: str
    result: str = ""
    abnormal: bool = False


class PatientIn(BaseModel):
    name: str = ""
    age: Optional[float] = None
    gender: str = ""
    chiefComplaint: str = ""
    allergies: Optional[str] = None
    anamnesis: list[QA] = Field(default_factory=list)
    vitals: dict[str, Any] = Field(default_factory=dict)
    testResults: list[TestResultIn] = Field(default_factory=list)


class CatalogTest(BaseModel):
    id: str
    name: str
    category: str = ""


class CatalogMed(BaseModel):
    id: str
    name: str
    dosing: Optional[str] = None


class Catalog(BaseModel):
    tests: list[CatalogTest] = Field(default_factory=list)
    medications: list[CatalogMed] = Field(default_factory=list)


class NurseActRequest(BaseModel):
    caseId: str
    utterance: str
    patient: PatientIn
    catalog: Catalog
    alreadyOrdered: list[str] = Field(default_factory=list)
    alreadyPrescribed: list[str] = Field(default_factory=list)
    lang: Optional[str] = None


# ── tool executors (pure, no network) ──────────────────────────────────────

# Drug-class keywords so "penicillin allergy" blocks amoxicillin etc.
ALLERGY_CLASSES: dict[str, list[str]] = {
    "penicillin": ["penicillin", "amoxicillin", "ampicillin", "piperacillin", "flucloxacillin", "augmentin", "co-amoxiclav", "cloxacillin"],
    "sulfa": ["sulfa", "sulfamethoxazole", "trimethoprim", "cotrimoxazole", "co-trimoxazole", "bactrim"],
    "nsaid": ["nsaid", "ibuprofen", "diclofenac", "naproxen", "ketorolac", "aspirin"],
    "aspirin": ["aspirin", "nsaid", "ibuprofen", "diclofenac", "naproxen"],
    "cephalosporin": ["cephalosporin", "cefuroxime", "ceftriaxone", "cefalexin", "cephalexin", "cefixime", "cefazolin"],
    "macrolide": ["macrolide", "azithromycin", "clarithromycin", "erythromycin"],
    "fluoroquinolone": ["quinolone", "ciprofloxacin", "levofloxacin", "moxifloxacin"],
    "codeine": ["codeine", "opioid", "morphine", "tramadol"],
    "morphine": ["morphine", "opioid", "codeine"],
}

# (substance in current meds, substance being prescribed, warning)
INTERACTIONS: list[tuple[list[str], list[str], str]] = [
    (["warfarin", "apixaban", "rivaroxaban", "heparin", "enoxaparin"], ["ibuprofen", "diclofenac", "naproxen", "aspirin", "ketorolac"], "NSAID/aspirin with an anticoagulant raises bleeding risk"),
    (["ibuprofen", "diclofenac", "naproxen", "aspirin", "ketorolac"], ["warfarin", "apixaban", "rivaroxaban", "heparin", "enoxaparin"], "anticoagulant with NSAID/aspirin raises bleeding risk"),
    (["clopidogrel", "aspirin"], ["warfarin", "apixaban", "rivaroxaban", "heparin", "enoxaparin"], "dual antithrombotic therapy raises bleeding risk"),
    (["morphine", "tramadol", "codeine", "fentanyl"], ["diazepam", "lorazepam", "midazolam", "alprazolam"], "opioid + benzodiazepine: respiratory depression risk"),
    (["lisinopril", "enalapril", "ramipril", "losartan", "spironolactone"], ["spironolactone", "potassium", "lisinopril", "enalapril", "ramipril", "losartan"], "ACEi/ARB with potassium-sparing agent: hyperkalaemia risk"),
]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


class NurseState:
    def __init__(self, req: NurseActRequest):
        self.req = req
        self.tests = {t.id: t for t in req.catalog.tests}
        self.meds = {m.id: m for m in req.catalog.medications}
        self.results = {r.testId: r for r in req.patient.testResults}
        self.ordered: list[str] = list(req.alreadyOrdered)
        self.prescribed: list[str] = list(req.alreadyPrescribed)
        self.new_tests: list[str] = []
        self.new_rx: list[dict[str, str]] = []
        self.follow_up: Optional[dict[str, Any]] = None

    # --- helpers
    def _allergy_text(self) -> str:
        parts = [self.req.patient.allergies or ""]
        for qa in self.req.patient.anamnesis:
            blob = f"{qa.question} {qa.answer}"
            if "allerg" in blob.lower():
                parts.append(qa.answer)
        return _norm(" ".join(parts))

    def _med_words(self, med_id: str) -> set[str]:
        m = self.meds.get(med_id)
        words = {_norm(med_id), *(_norm(m.name).split() if m else [])}
        words.add(_norm(m.name) if m else "")
        return {w for w in words if w}

    def _warnings(self, med_id: str) -> tuple[list[str], list[str]]:
        """Returns (hard_conflicts, soft_warnings)."""
        hard: list[str] = []
        soft: list[str] = []
        allergy = self._allergy_text()
        words = self._med_words(med_id)
        if allergy and allergy not in ("none", "no", "nkda", "no known allergies"):
            for cls, members in ALLERGY_CLASSES.items():
                if cls in allergy or any(m in allergy for m in members):
                    if any(m in w or w in m for m in members for w in words):
                        hard.append(f"documented allergy ({cls} class) conflicts with {self.meds[med_id].name if med_id in self.meds else med_id}")
                        break
            else:
                if any(w and w in allergy for w in words):
                    hard.append(f"documented allergy mentions {med_id}")
        current = [_norm(p) for p in self.prescribed]
        anam = _norm(" ".join(qa.answer for qa in self.req.patient.anamnesis if "medic" in qa.question.lower()))
        for have, adding, msg in INTERACTIONS:
            if any(w in a for w in words for a in adding):
                if any(h in c for h in have for c in current) or any(h in anam for h in have):
                    soft.append(msg)
        if med_id in self.prescribed:
            soft.append("already prescribed this encounter")
        return hard, soft

    # --- tools
    def find_in_catalog(self, query: str, kind: str = "test") -> dict[str, Any]:
        q = _norm(query)
        qtok = set(q.split())
        pool: list[tuple[str, str, str]]
        if kind == "medication":
            pool = [(m.id, m.name, m.dosing or "") for m in self.meds.values()]
        else:
            pool = [(t.id, t.name, t.category) for t in self.tests.values()]
        scored = []
        for id_, name, extra in pool:
            hay = _norm(f"{id_} {name} {extra}")
            score = 0
            if q and (q in hay):
                score += 3
            score += len(qtok & set(hay.split()))
            if score:
                scored.append((score, id_, name, extra))
        scored.sort(key=lambda x: -x[0])
        matches = [{"id": i, "name": n, "info": e} for _, i, n, e in scored[:5]]
        return {"ok": bool(matches), "kind": kind, "matches": matches}

    def order_test(self, testId: str) -> dict[str, Any]:
        if testId not in self.tests:
            return {"ok": False, "error": f"unknown testId '{testId}'; use find_in_catalog first"}
        t = self.tests[testId]
        dup = testId in self.ordered
        if not dup:
            self.ordered.append(testId)
            self.new_tests.append(testId)
        r = self.results.get(testId)
        return {
            "ok": True,
            "testId": testId,
            "name": t.name,
            "alreadyOrdered": dup,
            "result": r.result if r and r.result else "Within normal limits",
            "abnormal": bool(r.abnormal) if r else False,
        }

    def check_allergies_and_interactions(self, medicationId: str) -> dict[str, Any]:
        if medicationId not in self.meds:
            return {"ok": False, "error": f"unknown medicationId '{medicationId}'; use find_in_catalog first"}
        hard, soft = self._warnings(medicationId)
        return {"ok": True, "medicationId": medicationId, "safe": not hard, "hardConflicts": hard, "warnings": soft}

    def prescribe(self, medicationId: str, dose: str = "", duration: str = "") -> dict[str, Any]:
        if medicationId not in self.meds:
            return {"ok": False, "error": f"unknown medicationId '{medicationId}'; use find_in_catalog first"}
        hard, soft = self._warnings(medicationId)
        if hard:
            return {"ok": False, "refused": True, "reason": "; ".join(hard), "suggestion": "choose a non-conflicting alternative"}
        if medicationId in self.prescribed:
            return {"ok": True, "alreadyPrescribed": True, "warnings": soft}
        m = self.meds[medicationId]
        dose = dose or (m.dosing or "standard dose")
        duration = duration or "as directed"
        self.prescribed.append(medicationId)
        self.new_rx.append({"medicationId": medicationId, "dose": dose, "duration": duration})
        return {"ok": True, "medicationId": medicationId, "name": m.name, "dose": dose, "duration": duration, "warnings": soft}

    def schedule_follow_up(self, inDays: Any, reason: str = "") -> dict[str, Any]:
        try:
            days = max(0, min(365, int(inDays)))
        except (TypeError, ValueError):
            return {"ok": False, "error": "inDays must be an integer"}
        self.follow_up = {"inDays": days, "reason": reason or "follow-up"}
        return {"ok": True, **self.follow_up}

    def execute(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        fn = {
            "find_in_catalog": self.find_in_catalog,
            "order_test": self.order_test,
            "check_allergies_and_interactions": self.check_allergies_and_interactions,
            "prescribe": self.prescribe,
            "schedule_follow_up": self.schedule_follow_up,
        }.get(tool)
        if not fn:
            return {"ok": False, "error": f"unknown tool '{tool}'"}
        try:
            return fn(**args)
        except TypeError as e:
            return {"ok": False, "error": f"bad arguments: {e}"}


def summarize(tool: str, args: dict[str, Any], res: dict[str, Any]) -> str:
    if not res.get("ok"):
        if res.get("refused"):
            return f"Refused {args.get('medicationId')}: {res.get('reason')}"
        return f"{tool} failed: {res.get('error', 'unknown error')}"
    if tool == "find_in_catalog":
        return "Found: " + (", ".join(m["id"] for m in res["matches"]) or "nothing")
    if tool == "order_test":
        return f"Ordered {res['name']}: {res['result']}" + (" (abnormal)" if res["abnormal"] else "")
    if tool == "check_allergies_and_interactions":
        return "Safe" if res["safe"] and not res["warnings"] else "; ".join(res["hardConflicts"] + res["warnings"]) or "Safe"
    if tool == "prescribe":
        return f"Prescribed {res.get('name', args.get('medicationId'))} {res.get('dose', '')} x {res.get('duration', '')}".strip()
    if tool == "schedule_follow_up":
        return f"Follow-up in {res['inDays']} days: {res['reason']}"
    return "ok"


TOOL_SPECS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "find_in_catalog",
        "description": "Search the clinic catalog for a test or medication by free text. Always use this to resolve ids.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "kind": {"type": "string", "enum": ["test", "medication"]}},
            "required": ["query", "kind"]}}},
    {"type": "function", "function": {
        "name": "order_test",
        "description": "Order a lab/imaging test by catalog id; returns the result and abnormal flag.",
        "parameters": {"type": "object", "properties": {"testId": {"type": "string"}}, "required": ["testId"]}}},
    {"type": "function", "function": {
        "name": "check_allergies_and_interactions",
        "description": "Check a medication against the patient's allergies, history and current prescriptions.",
        "parameters": {"type": "object", "properties": {"medicationId": {"type": "string"}}, "required": ["medicationId"]}}},
    {"type": "function", "function": {
        "name": "prescribe",
        "description": "Prescribe a medication. Refused if there is a hard allergy conflict.",
        "parameters": {"type": "object", "properties": {
            "medicationId": {"type": "string"}, "dose": {"type": "string"}, "duration": {"type": "string"}},
            "required": ["medicationId", "dose", "duration"]}}},
    {"type": "function", "function": {
        "name": "schedule_follow_up",
        "description": "Schedule a follow-up visit.",
        "parameters": {"type": "object", "properties": {
            "inDays": {"type": "integer"}, "reason": {"type": "string"}}, "required": ["inDays", "reason"]}}},
]

SYSTEM_PROMPT = (
    "You are the charge nurse of a clinic, executing the doctor's spoken orders for one patient. "
    "Be fast and literal.\n"
    "- If the doctor's words contain NO clinical order (small talk, questions to the patient, thinking aloud), "
    "call NO tools and reply with exactly: NO_ORDER\n"
    "- Otherwise: first write one short plan sentence, then call tools. Resolve every test/medication id with "
    "find_in_catalog, order tests with order_test, run check_allergies_and_interactions before prescribe, then prescribe "
    "or schedule_follow_up. If a tool fails or a drug is refused for allergy, adapt: say so and (only if the doctor "
    "named a class or indication) pick a safe alternative from the catalog; otherwise just hold it.\n"
    "- Never invent results, ids, or doses beyond tool outputs and the catalog.\n"
    "- Dose: pass the doctor's spoken dose and frequency to prescribe exactly as said (e.g. '75 mg once daily'). "
    "If the only catalog product has a different strength than the doctor asked for, still prescribe it but keep the "
    "doctor's dose in the dose field, and say the difference out loud in your final sentence "
    "(e.g. 'aspirin is stocked as 100 mg, prescribed 75 mg daily as you asked, please confirm').\n"
    "- Finish with a short spoken confirmation, max 30 words, in the warm natural voice of an experienced Indian charge "
    "nurse talking to the doctor. Use contractions, say doses and numbers as words, and use commas and '...' for "
    "natural pauses. Never start with 'Done -', never use lists or markdown. Say what you did, flag anything held or "
    "different, and end with a short check-in sometimes. Example: 'Okay doctor, done. I've sent the troponin and the "
    "ECG... and aspirin is on, seventy-five milligrams once a day. Anything else?' Another: 'Okay doctor, CBC is sent, "
    "but I've held the amoxicillin... she's allergic to penicillin.'"
)


def _patient_brief(req: NurseActRequest, st: NurseState) -> str:
    p = req.patient
    return json.dumps({
        "patient": {"name": p.name, "age": p.age, "gender": p.gender, "chiefComplaint": p.chiefComplaint,
                    "allergies": p.allergies or "not recorded", "vitals": p.vitals,
                    "anamnesis": [qa.model_dump() for qa in p.anamnesis][:20]},
        "alreadyOrdered": st.ordered, "alreadyPrescribed": st.prescribed,
        "catalogSize": {"tests": len(st.tests), "medications": len(st.meds)},
    })


def _parse_json(text: str) -> Optional[dict[str, Any]]:
    text = strip_think(text)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else None
    except json.JSONDecodeError:
        return None


async def _run_native(st: NurseState, messages: list[dict[str, Any]], steps: list[dict[str, Any]]) -> tuple[str, str]:
    """Native function calling. Returns (plan, final_text)."""
    plan = ""
    provider: Optional[str] = None
    for _ in range(MAX_ITERATIONS):
        msg, provider = await chat(messages, tools=TOOL_SPECS, max_tokens=500, temperature=0.1, stick_to=provider)
        content = strip_think(msg.get("content") or "")
        calls = msg.get("tool_calls") or []
        if not calls:
            return plan, content
        if not plan and content:
            plan = content
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for call in calls:
            fn = call.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError:
                args = {}
            res = st.execute(name, args)
            steps.append({"tool": name, "args": args, "ok": bool(res.get("ok")), "summary": summarize(name, args, res), "result": res})
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(res)})
    # iteration cap: ask for the closing sentence without tools
    msg, _ = await chat(messages + [{"role": "user", "content": "Give the one-sentence spoken confirmation now."}], max_tokens=120, stick_to=provider)
    return plan, strip_think(msg.get("content") or "")


async def _run_json_plan(st: NurseState, req: NurseActRequest, steps: list[dict[str, Any]]) -> tuple[str, str]:
    """Fallback when native tool calling is unavailable: ask for a JSON plan."""
    names = {s["function"]["name"]: list(s["function"]["parameters"]["properties"]) for s in TOOL_SPECS}
    sys_msg = (
        "You are a clinic charge nurse. Reply with JSON only: "
        '{"intent":"order"|"none","plan":"one sentence","calls":[{"tool":"...","args":{...}}]}. '
        f"Tools and arg names: {json.dumps(names)}. Resolve ids from the catalog list given; "
        "check_allergies_and_interactions must precede prescribe. intent none => calls [].\n"
        f"Catalog tests: {json.dumps([t.model_dump() for t in st.tests.values()])}\n"
        f"Catalog medications: {json.dumps([m.model_dump() for m in st.meds.values()])}\n"
        f"Patient: {_patient_brief(req, st)}"
    )
    msg, prov = await chat(
        [{"role": "system", "content": sys_msg}, {"role": "user", "content": req.utterance}],
        json_mode=True, max_tokens=500, temperature=0.1,
    )
    plan_obj = _parse_json(msg.get("content") or "") or {}
    if plan_obj.get("intent") == "none" or not plan_obj.get("calls"):
        return "", "NO_ORDER"
    for c in plan_obj["calls"][:8]:
        name, args = c.get("tool", ""), c.get("args") or {}
        res = st.execute(name, args if isinstance(args, dict) else {})
        steps.append({"tool": name, "args": args, "ok": bool(res.get("ok")), "summary": summarize(name, args, res), "result": res})
    msg2, _ = await chat(
        [{"role": "system", "content": langmod.with_language("Write a short spoken confirmation (max 30 words, no markdown, no 'Done -' prefix) as a warm Indian charge nurse talking to the doctor: contractions, numbers as words, commas and '...' for pauses, e.g. 'Okay doctor, I've sent the troponin and ECG... anything else?'. Mention anything refused or abnormal. Use only the facts given.", req.lang, female=True, role="nurse")},
         {"role": "user", "content": json.dumps([{"tool": s["tool"], "summary": s["summary"]} for s in steps])}],
        max_tokens=120, stick_to=prov,
    )
    return str(plan_obj.get("plan", "")), strip_think(msg2.get("content") or "")


def _fallback_confirmation(st: NurseState, steps: list[dict[str, Any]], lang: Optional[str] = None) -> str:
    bits = []
    if st.new_tests:
        bits.append(", ".join(st.tests[t].name for t in st.new_tests) + " ordered")
    if st.new_rx:
        bits.append(", ".join(st.meds[r["medicationId"]].name for r in st.new_rx) + " prescribed")
    refused = [s["summary"] for s in steps if s["tool"] == "prescribe" and not s["ok"]]
    if refused:
        bits.append("held: " + "; ".join(refused))
    if st.follow_up:
        bits.append(f"follow-up in {st.follow_up['inDays']} days")
    lg = langmod.norm_lang(lang)
    if lg == "hi":
        return "ठीक है डॉक्टर, आपका ऑर्डर हो गया। और कुछ?" if bits else "डॉक्टर, मैं वह ऑर्डर पूरा नहीं कर पाई।"
    if lg == "kn":
        return "ಸರಿ ಡಾಕ್ಟರ್, ನಿಮ್ಮ ಆರ್ಡರ್ ಆಯಿತು. ಇನ್ನೇನಾದರೂ?" if bits else "ಡಾಕ್ಟರ್, ಆ ಆರ್ಡರ್ ಮುಗಿಸಲು ಆಗಲಿಲ್ಲ."
    return ("Okay doctor, " + ", ".join(bits) + ". Anything else?") if bits else "I couldn't complete that order."


@router.post("/agent/nurse/act")
async def nurse_act(req: NurseActRequest):
    run_id = "run_" + secrets.token_hex(6)
    st = NurseState(req)
    steps: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": langmod.with_language(
            SYSTEM_PROMPT + "\nContext: " + _patient_brief(req, st), req.lang, female=True, role="nurse")},
        {"role": "user", "content": req.utterance},
    ]
    from fastapi import HTTPException

    try:
        plan, final = await _run_native(st, messages, steps)
    except HTTPException as e:
        if e.status_code == 503:
            raise
        log.warning("native tool calling failed (%s); using JSON-plan fallback", e.detail[:120])
        steps.clear()
        st = NurseState(req)
        plan, final = await _run_json_plan(st, req, steps)

    if not steps:
        return {"runId": run_id, "intent": "none", "plan": "", "steps": [],
                "applied": {"orderedTestIds": [], "prescriptions": []}, "spokenConfirmation": ""}
    spoken = final if final and "NO_ORDER" not in final else _fallback_confirmation(st, steps, req.lang)
    applied: dict[str, Any] = {"orderedTestIds": st.new_tests, "prescriptions": st.new_rx}
    if st.follow_up:
        applied["followUp"] = st.follow_up
    return {
        "runId": run_id, "intent": "order",
        "plan": plan or "; ".join(s["summary"] for s in steps[:3]),
        "steps": steps, "applied": applied, "spokenConfirmation": spoken[:400],
    }
