"""Agentic charge nurse: POST /agent/nurse/act.

An OpenAI-compatible tool-use loop (Sarvam first, Groq fallback) that turns the
doctor's spoken orders into executed actions. Tools run server-side against the
request payload only; nothing is fabricated beyond tool output.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from llm_provider import chat, strip_think
import drugterms
import lang as langmod

log = logging.getLogger("medsim.nurse")
router = APIRouter()
MAX_ITERATIONS = 6
# The same order from the same encounter within this window is one run (double
# voice finals, a retried request): the first run's answer is returned.
DEDUPE_S = 4.0


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
    # Real-world delivery (send_to_patient): the patient's phone or email for this
    # demo encounter, and the doctor's display name for the message.
    contact: Optional[str] = None
    doctorName: Optional[str] = None
    # Everything already on the chart, so "send it to the patient" can include
    # prescriptions and the follow-up from earlier orders.
    prescriptionsSoFar: list[dict[str, Any]] = Field(default_factory=list)
    followUpSoFar: Optional[dict[str, Any]] = None
    # Logbook (log_case) and referral (refer_patient) context.
    student: Optional[str] = None
    university: Optional[str] = None
    specialty: Optional[str] = None
    caseName: Optional[str] = None
    diagnosis: Optional[str] = None
    skills: list[str] = Field(default_factory=list)
    # BAND agent room: with a registered encounter, orders are delegated to the departments.
    encounterId: Optional[str] = None
    osce: bool = False


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


def _clean_recurrence(rec: Any) -> Optional[dict[str, Any]]:
    """Validate and clamp {freq, count, interval}; None when absent or unusable."""
    if not isinstance(rec, dict):
        return None
    freq = str(rec.get("freq", "")).upper()
    if freq not in ("DAILY", "WEEKLY", "MONTHLY"):
        return None
    try:
        count = max(1, min(12, int(rec.get("count", 1))))
        interval = max(1, min(4, int(rec.get("interval", 1) or 1)))
    except (TypeError, ValueError):
        return None
    return {"freq": freq, "count": count, "interval": interval}


def _safe_follow_up(fu: Any) -> Optional[dict[str, Any]]:
    """The client's followUpSoFar, reduced to what the server can rebuild links from.
    callUrl, googleCalendarUrl, startText, icsPath and booked are never trusted."""
    if not isinstance(fu, dict) or fu.get("inDays") is None:
        return None
    try:
        days = max(0, min(365, int(fu["inDays"])))
    except (TypeError, ValueError):
        return None
    out: dict[str, Any] = {"inDays": days, "reason": re.sub(r"\s+", " ", str(fu.get("reason") or "follow-up")).strip()[:160]}
    rec = _clean_recurrence(fu.get("recurrence"))
    if rec:
        out["recurrence"] = rec
    mode = str(fu.get("mode") or "").lower()
    if mode in ("visit", "call"):
        out["mode"] = mode
    return out


def _clip(value: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:n]


def _clip_rx(rx: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [{"name": _clip(r.get("name"), 80), "dose": _clip(r.get("dose"), 80), "duration": _clip(r.get("duration"), 80)}
            for r in rx if isinstance(r, dict)][:12]


def _call_snapshot(req: "NurseActRequest", rx: list[dict[str, Any]], reason: Any, lang: str) -> dict[str, Any]:
    """Snapshot for the Asha call registry, with every client-supplied field clipped."""
    p = req.patient
    return {"caseId": _clip(req.caseId, 80), "patientName": _clip(p.name, 80), "age": p.age, "gender": _clip(p.gender, 16),
            "chiefComplaint": _clip(p.chiefComplaint, 200), "prescriptions": _clip_rx(rx),
            "reason": _clip(reason, 160), "lang": lang}


_norm = drugterms.norm  # keeps native-script letters


class NurseState:
    def __init__(self, req: NurseActRequest, room: Any = None):
        self.req = req
        # The encounter in the agent room (agentroom.hub.Encounter), or None for the legacy single agent.
        self.room = room
        self.osce = bool(req.osce or (room is not None and room.osce))
        self.stopped: list[str] = []
        self.cancelled: list[str] = []
        self.room_tests: list[str] = []
        self.room_rx: list[dict[str, Any]] = []
        self.pending: list[dict[str, Any]] = []
        self._done: dict[str, dict[str, Any]] = {}
        self.tests = {t.id: t for t in req.catalog.tests}
        self.meds = {m.id: m for m in req.catalog.medications}
        self.results = {r.testId: r for r in req.patient.testResults}
        self.ordered: list[str] = list(req.alreadyOrdered)
        self.prescribed: list[str] = list(req.alreadyPrescribed)
        self.new_tests: list[str] = []
        self.new_rx: list[dict[str, str]] = []
        self.follow_up: Optional[dict[str, Any]] = None
        # Hard conflicts found by the real drug databases (NIH RxClass, openFDA).
        self.ext_hard: dict[str, list[str]] = {}
        # Asha follow-up call tokens created in this run (snapshots refreshed at the end).
        self.call_tokens: list[str] = []
        # A Telegram contact ('telegram' / '@user') resolved to a stable 'tg:<chat id>'.
        self.resolved_contact: Optional[str] = None
        # Call links whose reminders went out to an unresolved Telegram contact.
        self.unresolved_reminder_urls: list[str] = []

    # --- helpers
    def _allergy_text(self) -> str:
        """Only what states an allergy ("No allergy to penicillin" is none), with drug names in English."""
        return drugterms.expand(self._allergy_note())

    def _allergy_note(self) -> str:
        return drugterms.allergy_note(self.req.patient.allergies, [(qa.question, qa.answer) for qa in self.req.patient.anamnesis])

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
        if allergy:
            for cls, members in ALLERGY_CLASSES.items():
                if cls in allergy or any(m in allergy for m in members):
                    if any(m in w or (len(w) >= 4 and w in m) for m in members for w in words):
                        hard.append(f"documented allergy ({cls} class) conflicts with {self.meds[med_id].name if med_id in self.meds else med_id}")
                        break
            else:
                if any(len(w) >= 4 and w in allergy for w in words):
                    hard.append(f"documented allergy mentions {med_id}")
        current = [_norm(p) for p in self.prescribed]
        anam = drugterms.expand(" ".join(qa.answer for qa in self.req.patient.anamnesis if "medic" in qa.question.lower()))
        for have, adding, msg in INTERACTIONS:
            if any(w in a for w in words for a in adding):
                if any(h in c for h in have for c in current) or any(h in anam for h in have):
                    soft.append(msg)
        if med_id in self.prescribed:
            soft.append("already prescribed this encounter")
        for h in self.ext_hard.get(med_id, []):
            if h not in hard:
                hard.append(h)
        return hard, soft

    # --- tools
    def find_in_catalog(self, query: str, kind: str = "test") -> dict[str, Any]:
        q = _norm(query)
        qtok = set(q.split())
        aliases = [c for c in drugterms.canonical_terms(query) if c != q] if kind == "medication" else []
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
            if any(a in hay for a in aliases):  # brand, short stem or native script
                score += 3
            elif kind == "medication" and not score and drugterms.mentions_drug(query, id_, name):
                score += 2
            if score:
                scored.append((score, id_, name, extra))
        scored.sort(key=lambda x: -x[0])
        matches = [{"id": i, "name": n, "info": e} for _, i, n, e in scored[:5]]
        if not matches:
            where = "medication" if kind == "medication" else "test"
            return {"ok": False, "kind": kind, "matches": [],
                    "error": f"no {where} matching '{query.strip()}' is stocked in the catalogue"}
        return {"ok": True, "kind": kind, "matches": matches}

    def order_test(self, testId: str) -> dict[str, Any]:
        if testId not in self.tests:
            return {"ok": False, "error": f"unknown testId '{testId}'; use find_in_catalog first"}
        t = self.tests[testId]
        if self.room is not None:
            return self._order_in_room(t)
        dup = testId in self.ordered
        if not dup:
            self.ordered.append(testId)
            self.new_tests.append(testId)
        r = self.results.get(testId)
        out: dict[str, Any] = {"ok": True, "testId": testId, "name": t.name, "alreadyOrdered": dup}
        if r and r.result:
            out.update(result=r.result, abnormal=bool(r.abnormal))
        else:
            # Nothing was reported to us: a missing result is never a normal result.
            out.update(result="", abnormal=False, resultPending=True,
                       note="No result supplied. Say the test is ordered and the result will be on the chart; never call it normal.")
        return out

    def _department(self, t: CatalogTest) -> str:
        return "radiology" if t.category == "imaging" else "lab"

    def _order_in_room(self, t: CatalogTest) -> dict[str, Any]:
        """Queue the test for its department; the request goes out after the tool loop."""
        from agentroom.hub import hub

        out: dict[str, Any] = {"ok": True, "testId": t.id, "name": t.name, "department": self._department(t)}
        if t.id in self.room_tests:
            return {**out, "alreadyOrdered": True, "resultPending": True}
        back = self.room.results.get(t.id)
        if back:
            return {**out, "alreadyOrdered": True, "result": back["result"], "abnormal": back["abnormal"]}
        ref = next((r for r in reversed(self.room.refs.values()) if t.id in r.test_ids and r.status != "cancelled"), None)
        if ref is not None and t.id not in ref.resulted:
            if ref.status in ("timeout", "failed"):
                hub.retry(self.room, ref.ref)
                self._note_pending(ref)
                return {**out, "resent": True, "resultPending": True, "note": f"Asked {out['department']} again; the result is pending."}
            return {**out, "alreadyOrdered": True, "resultPending": True, "note": "Already with the department; the result is pending."}
        self.room_tests.append(t.id)
        if t.id not in self.ordered:
            self.ordered.append(t.id)
        self.new_tests.append(t.id)
        return {**out, "alreadyOrdered": False, "resultPending": True,
                "note": f"Sent to {out['department']}; the result is pending. Do not state or guess any result."}

    def check_allergies_and_interactions(self, medicationId: str) -> dict[str, Any]:
        if medicationId not in self.meds:
            return {"ok": False, "error": f"unknown medicationId '{medicationId}'; use find_in_catalog first"}
        hard, soft = self._warnings(medicationId)
        return {"ok": True, "medicationId": medicationId, "safe": not hard, "hardConflicts": hard, "warnings": soft}

    def prescribe(self, medicationId: str, dose: str = "", duration: str = "") -> dict[str, Any]:
        if medicationId not in self.meds:
            return {"ok": False, "error": f"unknown medicationId '{medicationId}'; use find_in_catalog first"}
        hard, soft = self._warnings(medicationId)
        if hard and self.room is None:
            out: dict[str, Any] = {"ok": False, "refused": True, "reason": "; ".join(hard)}
            if not self.osce:
                out["suggestion"] = "choose a non-conflicting alternative"
            return out
        if medicationId in self.prescribed:
            return {"ok": True, "alreadyPrescribed": True, "warnings": soft}
        m = self.meds[medicationId]
        substitute = not self._named_by_doctor(medicationId, m.name)
        if substitute and self.osce:
            return {"ok": False, "error": "exam: the doctor has not named this drug. Ask which drug and dose they want; suggest nothing."}
        if substitute:
            # Safety: a drug the doctor did NOT name (e.g. doxycycline offered
            # instead of a held amoxicillin) must never inherit the dose the
            # doctor spoke for the original drug. Use the catalogue's standard
            # dosing for the substitute instead.
            dose = m.dosing or "standard dose"
        dose = dose or (m.dosing or "standard dose")
        duration = duration or "as directed"
        if self.room is not None:
            return self._verify_in_room(m, dose, duration, hard, substitute)
        self.prescribed.append(medicationId)
        self.new_rx.append({"medicationId": medicationId, "dose": dose, "duration": duration})
        out = {"ok": True, "medicationId": medicationId, "name": m.name, "dose": dose, "duration": duration, "warnings": soft}
        if substitute:
            out["substitute"] = True
            out["note"] = "Not the drug the doctor named; standard catalogue dose used. Tell the doctor and ask them to confirm."
        return out

    def _verify_in_room(self, m: CatalogMed, dose: str, duration: str, hard: list[str], substitute: bool) -> dict[str, Any]:
        """Queue the drug for the pharmacist. It is on nobody's prescription until they release it."""
        from agentroom.hub import OPEN, hub

        base: dict[str, Any] = {"medicationId": m.id, "name": m.name, "dose": dose, "duration": duration}
        held = hub.rx_ref(self.room, m.id, ("held",))
        if held is not None:
            return {"ok": False, "held": True, **base, "reason": held.summary,
                    "note": "Pharmacy is holding this drug; it is not on the prescription. "
                            "Only faculty can release it: use request_override if the doctor wants that."}
        if any(x["medicationId"] == m.id for x in self.room_rx) or hub.rx_ref(self.room, m.id, OPEN) is not None:
            return {"ok": True, "alreadyPending": True, "pendingVerification": True, **base,
                    "note": "Already with pharmacy for verification; not on the prescription yet."}
        stuck = hub.rx_ref(self.room, m.id, ("timeout", "failed"))
        if stuck is not None:
            hub.retry(self.room, stuck.ref)
            self._note_pending(stuck)
            return {"ok": True, "resent": True, "pendingVerification": True, **base, "note": "Sent to pharmacy again for verification."}
        self.room_rx.append({**base, "hard": hard})
        out = {"ok": True, "pendingVerification": True, **base,
               "note": "Sent to pharmacy for verification. It is NOT prescribed or given yet; say you are checking with pharmacy."}
        if substitute:
            out["substitute"] = True
            out["note"] += " Not the drug the doctor named; standard catalogue dose used. Tell the doctor and ask them to confirm."
        return out

    def _note_pending(self, r: Any) -> None:
        if any(x["ref"] == r.ref for x in self.pending):
            return
        item: dict[str, Any] = {"ref": r.ref, "action": r.action, "target": r.target, "label": r.label}
        if r.medication_id:
            item["medicationId"] = r.medication_id
        if r.tests:
            item["testIds"] = list(r.test_ids)
        self.pending.append(item)

    def flush_room(self) -> None:
        """Send this run's orders: one message per department for tests, one per drug to pharmacy."""
        if self.room is None:
            return
        rx, tests = self.room_rx, self.room_tests
        self.room_rx, self.room_tests = [], []
        try:
            from agentroom.hub import hub

            for x in rx:
                self._note_pending(hub.delegate_rx(self.room, x["medicationId"], x["name"], x["dose"], x["duration"], x["hard"]))
            if tests:
                for r in hub.delegate_tests(self.room, [{"testId": t, "name": self.tests[t].name, "category": self.tests[t].category}
                                                        for t in tests if t in self.tests]):
                    self._note_pending(r)
        except Exception as e:  # noqa: BLE001 - the room never breaks the nurse
            log.warning("orders could not be delegated: %s", type(e).__name__)

    def stop_medication(self, medicationId: str, reason: str = "") -> dict[str, Any]:
        """Take a drug off the prescription (or call back one that pharmacy is checking or holding)."""
        if medicationId not in self.meds:
            return {"ok": False, "error": f"unknown medicationId '{medicationId}'; use find_in_catalog first"}
        name = self.meds[medicationId].name
        was = ""
        if any(x["medicationId"] == medicationId for x in self.room_rx):
            self.room_rx = [x for x in self.room_rx if x["medicationId"] != medicationId]
            was = "cancelled"
        if self.room is not None:
            from agentroom.hub import hub

            was = hub.stop_medication(self.room, medicationId, _clip(reason, 120)) or was
        on_chart = medicationId in self.req.alreadyPrescribed or any(
            str(r.get("medicationId")) == medicationId for r in self.req.prescriptionsSoFar if isinstance(r, dict))
        if medicationId in self.prescribed:
            self.prescribed.remove(medicationId)
            was = was or "stopped"
        self.new_rx = [r for r in self.new_rx if r["medicationId"] != medicationId]
        if (on_chart or was == "stopped") and medicationId not in self.stopped:
            self.stopped.append(medicationId)
            was = "stopped"
        if not was:
            return {"ok": False, "error": f"{name} is not on this patient's prescription, so there is nothing to stop"}
        return {"ok": True, "medicationId": medicationId, "name": name, "was": was}

    def cancel_test(self, testId: str) -> dict[str, Any]:
        """Cancel a test that has no result yet."""
        if testId not in self.tests:
            return {"ok": False, "error": f"unknown testId '{testId}'; use find_in_catalog first"}
        name = self.tests[testId].name
        if testId not in self.ordered:
            return {"ok": False, "error": f"{name} was not ordered, so there is nothing to cancel"}
        r = self.results.get(testId)
        if (r and r.result) or (self.room is not None and testId in self.room.results):
            return {"ok": False, "error": f"{name} already has a result; it stays on the chart"}
        if testId in self.room_tests:
            self.room_tests.remove(testId)
        elif self.room is not None:
            from agentroom.hub import hub

            hub.cancel_test(self.room, testId)
        self.ordered.remove(testId)
        if testId in self.new_tests:
            self.new_tests.remove(testId)
        if testId not in self.cancelled:
            self.cancelled.append(testId)
        return {"ok": True, "testId": testId, "name": name}

    # --- agent room tools (only offered in room mode)
    async def ask_department(self, department: str = "", question: str = "") -> dict[str, Any]:
        from agentroom.hub import hub

        role = {"pharmacy": "pharmacist", "pharmacist": "pharmacist", "lab": "lab", "laboratory": "lab",
                "radiology": "radiology", "radiologist": "radiology"}.get(str(department).strip().lower(), "")
        r = hub.ask(self.room, role, question) if role and str(question).strip() else None
        if r is None:
            return {"ok": False, "error": "department must be pharmacist, lab or radiology, with a question"}
        self._note_pending(r)
        return {"ok": True, "department": role, "note": "Question sent; they will answer out loud. Do not answer it yourself."}

    async def invite_faculty(self, reason: str = "") -> dict[str, Any]:
        from agentroom.hub import hub

        out = await asyncio.wait_for(hub.invite_faculty(self.room, reason), timeout=9.0)
        return {"ok": True, "name": out["name"], "url": out["url"], "note": "Faculty has been asked to join. Do not speak for them."}

    async def request_override(self, medicationId: str = "", reason: str = "") -> dict[str, Any]:
        from agentroom.hub import hub

        r = hub.rx_ref(self.room, medicationId, ("held",))
        if r is None:
            held = [x for x in self.room.refs.values() if x.action == "verify_rx" and x.status == "held"]
            r = held[0] if len(held) == 1 and not medicationId else None
        if r is None:
            return {"ok": False, "error": "that drug is not on hold"}
        out = await asyncio.wait_for(hub.request_override(self.room, r.ref, reason), timeout=9.0)
        if out.get("ok"):
            out.update(medicationId=r.medication_id, name=r.medication, note="Faculty has been asked; the drug stays on hold until they decide.")
        return out

    async def message_faculty(self, text: str = "") -> dict[str, Any]:
        from agentroom.hub import hub

        if not await asyncio.wait_for(hub.faculty_say(self.room, text), timeout=9.0):
            return {"ok": False, "error": "nothing to say"}
        return {"ok": True, "note": "Passed on to faculty; their reply will be spoken when it comes."}

    def _named_by_doctor(self, medication_id: str, name: str) -> bool:
        """True if the doctor's words mention this drug: name, stem, Indian brand or native script."""
        return drugterms.mentions_drug(self.req.utterance or "", medication_id, name)

    def schedule_follow_up(self, inDays: Any, reason: str = "", recurrence: Any = None, mode: Any = None,
                           startsInMinutes: Any = None) -> dict[str, Any]:
        try:
            days = max(0, min(365, int(inDays)))
        except (TypeError, ValueError):
            return {"ok": False, "error": "inDays must be an integer"}
        self.follow_up = {"inDays": days, "reason": reason or "follow-up"}
        rec = _clean_recurrence(recurrence)
        if rec:
            self.follow_up["recurrence"] = rec
        m = str(mode or "").lower()
        if m in ("visit", "call"):
            self.follow_up["mode"] = m
        try:
            mins = int(startsInMinutes) if startsInMinutes not in (None, "") else 0
        except (TypeError, ValueError):
            mins = 0
        if 0 < mins <= 1440:
            # "check-in call in 5 minutes": a call today at an exact time.
            self.follow_up["startsInMinutes"] = mins
            self.follow_up["mode"] = "call"
        return {"ok": True, **self.follow_up}

    # --- real-world tools (network; never raise)
    async def aexecute(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        # Real-world side effects happen once per run, however often the model repeats the call.
        key = ""
        if tool in ("send_to_patient", "log_case", "refer_patient", "schedule_follow_up", "ask_department",
                    "invite_faculty", "request_override", "message_faculty"):
            key = f"{tool}:{json.dumps(args, sort_keys=True, default=str)}"
            if key in self._done:
                return {**self._done[key], "alreadyDone": True}
        res = await self._aexecute(tool, args)
        if key and res.get("ok"):
            self._done[key] = dict(res)
        return res

    async def _aexecute(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        if tool in ROOM_TOOLS:
            if self.room is None:
                return {"ok": False, "error": f"unknown tool '{tool}'"}
            try:
                return await getattr(self, tool)(**args)
            except TypeError as e:
                return {"ok": False, "error": f"bad arguments: {e}"}
            except Exception as e:  # noqa: BLE001 - BAND being down never fails the run
                log.warning("%s failed: %s", tool, type(e).__name__)
                return {"ok": False, "error": "the agent room is not reachable right now"}
        if tool in ("send_to_patient", "log_case", "refer_patient"):
            try:
                return await getattr(self, tool)(**args)
            except TypeError as e:
                return {"ok": False, "error": f"bad arguments: {e}"}
            except Exception as e:  # noqa: BLE001 - one bad tool never fails the whole run
                log.warning("send_to_patient failed: %s", type(e).__name__)
                return {"ok": False, "error": f"sending failed ({type(e).__name__})"}
        res = self.execute(tool, args)
        try:
            if tool == "check_allergies_and_interactions" and res.get("ok") and self.room is None:
                await self._real_drug_check(str(args.get("medicationId", "")), res)
            elif tool == "schedule_follow_up" and res.get("ok"):
                await self._calendar(res)
        except Exception as e:  # noqa: BLE001 - keep the local result
            log.warning("%s real-world step failed: %s", tool, type(e).__name__)
        return res

    async def _real_drug_check(self, med_id: str, res: dict[str, Any]) -> None:
        from integrations import drugsafety

        m = self.meds.get(med_id)
        if not m:
            return
        allergies = self._allergy_text()  # negations dropped, names in English
        current = [self.meds[p].name for p in self.prescribed if p in self.meds] + [
            qa.answer for qa in self.req.patient.anamnesis if "medic" in qa.question.lower()]
        try:
            ext = await asyncio.wait_for(drugsafety.check_drug(m.name, allergies, current), timeout=7.0)
        except Exception as e:  # noqa: BLE001
            log.warning("real drug check failed: %s", type(e).__name__)
            ext = None
        if not ext or not ext.get("ok"):
            res["realCheck"] = {"ok": False, "note": "public drug databases unreachable; checked the clinic catalogue only"}
            return
        conflict = None if not allergies or drugsafety.is_negated_allergy(allergies) else ext.get("allergyConflict")
        if conflict:
            msg = f"NIH RxClass: {conflict}"
            self.ext_hard.setdefault(med_id, []).append(msg)
            if msg not in res["hardConflicts"]:
                res["hardConflicts"].append(msg)
            res["safe"] = False
        for it in (ext.get("interactions") or [])[:2]:
            res["warnings"].append(f"FDA label, with {it.get('with')}: {it.get('excerpt')}")
        res["realCheck"] = {
            "ok": True,
            "drug": ext.get("drug"),
            "rxcui": ext.get("rxcui"),
            "classes": (ext.get("classes") or [])[:4],
            "boxedWarning": ext.get("boxedWarning"),
            "sources": ext.get("sources") or [],
        }

    async def _calendar(self, res: dict[str, Any]) -> None:
        from datetime import datetime
        from integrations import calendar_invite, followup_calls, gcal_script, notify

        rec = res.get("recurrence")
        # Every follow-up carries a link to a live Agora voice check-in with Asha
        # (adherence, side effects, red flags) that reports back to the doctor.
        is_call = True
        call_url: Optional[str] = None
        if is_call:
            try:
                rx = [{"medicationId": r["medicationId"],
                       "name": self.meds[r["medicationId"]].name if r["medicationId"] in self.meds else r["medicationId"],
                       "dose": r.get("dose", ""), "duration": r.get("duration", "")} for r in self.new_rx]
                for r in self.req.prescriptionsSoFar:
                    if isinstance(r, dict):
                        rx.append({k: str(r.get(k, "")) for k in ("medicationId", "name", "dose", "duration")})
                token = followup_calls.register_call({
                    **_call_snapshot(self.req, rx, res.get("reason", ""), langmod.norm_lang(self.req.lang)),
                    "contact": _clip((self.req.contact or "").strip(), 80)})
                self.call_tokens.append(token)
                path = f"/call/{token}"
                call_url = notify.absolute_url(path) or path
            except Exception as e:  # noqa: BLE001
                log.warning("follow-up call link failed: %s", type(e).__name__)
        try:
            from datetime import timedelta, timezone

            mins = res.get("startsInMinutes")
            cal = calendar_invite.make_follow_up(
                self.req.caseId, self.req.patient.name, res["inDays"], res["reason"],
                recurrence=rec, call_url=call_url,
                start_at=datetime.now(timezone.utc) + timedelta(minutes=int(mins)) if mins else None)
        except Exception as e:  # noqa: BLE001
            log.warning("calendar invite failed: %s", type(e).__name__)
            return
        res["calendar"] = {
            "startText": cal.get("startText"),
            "googleCalendarUrl": cal.get("googleCalendarUrl"),
            "icsUrl": notify.absolute_url(cal["icsPath"]) or cal["icsPath"],
        }
        if call_url:
            res["calendar"]["callUrl"] = call_url
        if self.follow_up is not None:
            self.follow_up.update(startText=cal.get("startText"), googleCalendarUrl=cal.get("googleCalendarUrl"),
                                  icsPath=cal["icsPath"], start=cal.get("start"))
            if call_url:
                self.follow_up["callUrl"] = call_url
        contact = (self.req.contact or "").strip()
        reminder_to = contact
        if contact and notify.is_telegram(contact):
            # 'telegram' / '@user' resolve to the chat id now, so a later Start from
            # someone else never redirects this patient's reminders.
            reminder_to = self.resolved_contact or await notify.resolve_telegram(contact) or contact
            if reminder_to.startswith("tg:"):
                self.resolved_contact = reminder_to
        try:
            booked = await asyncio.wait_for(gcal_script.book_event(
                cal["title"], cal.get("description", ""), datetime.fromisoformat(cal["start"]),
                minutes=cal.get("minutes", 20), recurrence=rec,
                guest_email=contact if "@" in contact else None), timeout=15.0)
        except Exception as e:  # noqa: BLE001
            log.warning("google calendar booking failed: %s", type(e).__name__)
            booked = None
        if booked and booked.get("ok"):
            res["calendar"]["booked"] = {
                "ok": True, "htmlLink": booked.get("htmlLink"),
                "recurring": bool(rec), "seriesId": booked.get("seriesId")}
            if self.follow_up is not None:
                self.follow_up["booked"] = True
        # At each call time the patient is messaged "Asha is ready, tap to join".
        if call_url and contact:
            from integrations import call_reminders

            times = call_reminders.schedule(reminder_to, self.req.patient.name, call_url,
                                            datetime.fromisoformat(cal["start"]), rec, res.get("reason", ""))
            if times:
                res["calendar"]["reminders"] = len(times)
                if not reminder_to.lower().startswith("tg:") and notify.is_telegram(reminder_to):
                    self.unresolved_reminder_urls.append(call_url)

    def _med_names(self, ids: list[str]) -> list[str]:
        return [self.meds[i].name if i in self.meds else i for i in ids]

    def _all_prescription_names(self) -> list[str]:
        names: list[str] = []
        for mid in list(self.prescribed):
            n = self.meds[mid].name if mid in self.meds else mid
            if n not in names:
                names.append(n)
        for rx in self.req.prescriptionsSoFar:
            n = str(rx.get("name") or "") or (self.meds[str(rx.get("medicationId"))].name
                                              if str(rx.get("medicationId")) in self.meds else str(rx.get("medicationId", "")))
            if n and n not in names:
                names.append(n)
        return names

    async def log_case(self, diagnosis: str = "", notes: str = "") -> dict[str, Any]:
        """Append this encounter to the student's CBME clinical logbook (Google Sheet)."""
        import logbook

        r = self.req
        lreq = logbook.LogbookRequest(
            caseId=r.caseId, caseName=r.caseName or "", specialty=r.specialty or "",
            patientName=r.patient.name, diagnosis=(diagnosis or r.diagnosis or "").strip(),
            skills=list(r.skills), tests=[self.tests[t].name if t in self.tests else t for t in self.ordered],
            prescriptions=self._all_prescription_names(),
            student=r.student or r.doctorName or "", university=r.university or "", notes=notes or "")
        out = await logbook.log_row(logbook.build_row(lreq))
        if out.get("ok"):
            out["case"] = lreq.caseName or lreq.caseId
        return out

    async def refer_patient(self, specialty: str = "", urgency: str = "routine", reason: str = "",
                            workingDiagnosis: str = "") -> dict[str, Any]:
        """FHIR referral ServiceRequest, SBAR letter (Doc/PDF) and a Murf voice handover."""
        import referral

        if not str(specialty or "").strip():
            return {"ok": False, "error": "which specialty should the patient be referred to?"}
        p = self.req.patient
        abnormal = [f"{self.tests[tid].name if tid in self.tests else tid}: {r.result}"
                    for tid, r in self.results.items() if r.abnormal and tid in self.ordered]
        ctx = {
            "caseId": self.req.caseId, "name": p.name, "age": p.age, "gender": p.gender,
            "complaint": p.chiefComplaint, "vitals": p.vitals, "allergies": p.allergies,
            "specialty": str(specialty).strip()[:80], "urgency": urgency, "reason": reason,
            "diagnosis": (workingDiagnosis or self.req.diagnosis or "").strip(),
            "abnormal": abnormal, "tests": [self.tests[t].name if t in self.tests else t for t in self.ordered],
            "prescriptions": self._all_prescription_names(),
        }
        return await referral.make_referral(ctx)

    async def send_to_patient(self, channel: str = "auto") -> dict[str, Any]:
        from integrations import calendar_invite, notify
        import rx_audio

        to = (self.req.contact or "").strip()
        if not to:
            return {"ok": False, "error": "no patient phone or email on file; add it in the Plan tab first"}
        meds: list[dict[str, str]] = []
        for rx in list(self.req.prescriptionsSoFar) + self.new_rx:
            mid = str(rx.get("medicationId", ""))
            if mid in self.stopped or self._with_pharmacy(mid):
                continue  # stopped, held or still being verified: never sent to a patient
            name = self.meds[mid].name if mid in self.meds else str(rx.get("name") or mid)
            if name and all(x["name"] != name for x in meds):
                meds.append({"name": name, "dose": str(rx.get("dose", "")), "duration": str(rx.get("duration", ""))})
        if not meds and self.room is not None and (self.room_rx or any(
                r.action == "verify_rx" and r.status in ("sent", "working", "waiting", "held") for r in self.room.refs.values())):
            return {"ok": False, "error": "pharmacy has not released the prescription yet, so nothing was sent; ask again after they do"}
        if not meds:
            return {"ok": False, "error": "nothing prescribed yet, so there is nothing to send"}
        # This run's follow-up was built server-side; one from the chart is rebuilt
        # from inDays/reason so no client-supplied link reaches the patient.
        fu = dict(self.follow_up) if self.follow_up else _safe_follow_up(self.req.followUpSoFar)
        if fu and not fu.get("icsPath") and fu.get("inDays") is not None:
            try:
                cal = calendar_invite.make_follow_up(self.req.caseId, self.req.patient.name, int(fu["inDays"]),
                                                     str(fu.get("reason") or "follow-up"), recurrence=fu.get("recurrence"))
                fu.update(startText=cal.get("startText"), googleCalendarUrl=cal.get("googleCalendarUrl"), icsPath=cal["icsPath"])
            except Exception:  # noqa: BLE001
                pass
        lang = langmod.norm_lang(self.req.lang)
        # Murf voice prescription in the patient's language, hosted for the phone.
        mp3: Optional[bytes] = None
        audio_url: Optional[str] = None
        try:
            rq = rx_audio.RxAudioRequest(
                caseId=self.req.caseId[:80],
                patient=rx_audio.RxPatient(name=self.req.patient.name[:80]),
                prescriptions=[rx_audio.RxItem(name=m["name"][:80], dose=m["dose"][:80], duration=m["duration"][:60]) for m in meds[:12]],
                followUp=rx_audio.RxFollowUp(inDays=fu.get("inDays"), reason=str(fu.get("reason") or "")[:160]) if fu else None,
                lang=lang,
            )
            script = await rx_audio.generate_script(rq, lang)
            mp3, _voice, _locale = await rx_audio.synthesize(script, lang)
            audio_url = notify.absolute_url(notify.store_audio(mp3))
        except Exception as e:  # noqa: BLE001
            log.warning("voice prescription for send failed: %s", type(e).__name__)
        ics: Optional[bytes] = None
        if fu and fu.get("icsPath") and not fu.get("booked"):  # booked straight into the calendar: no invite file
            token = fu["icsPath"].rsplit("/", 1)[-1].removesuffix(".ics")
            text = calendar_invite.get_ics(token)
            ics = text.encode() if text else None
        message = notify.compose_message(
            self.req.patient.name, self.req.doctorName or "your doctor", meds,
            {"startText": fu.get("startText"), "reason": fu.get("reason")} if fu else None,
            audio_url, None if (fu or {}).get("booked") else (fu or {}).get("googleCalendarUrl"), lang)
        if fu and fu.get("booked"):
            # Already booked straight into the calendar: no "add to calendar" step.
            message = message.replace(notify.DISCLAIMER, f"It is already booked in your Google Calendar. {notify.DISCLAIMER}", 1)
        call_url = (fu or {}).get("callUrl")
        if fu and not call_url:
            from integrations import followup_calls

            token = followup_calls.register_call({**_call_snapshot(self.req, meds, fu.get("reason"), lang),
                                                  "contact": _clip(to, 80)})
            call_url = notify.absolute_url(f"/call/{token}") or f"/call/{token}"
        if call_url and call_url.startswith("http"):
            message = message.replace(notify.DISCLAIMER, f"Join your Asha follow-up call: {call_url}. {notify.DISCLAIMER}", 1)
        # The doctor may say "WhatsApp" when only Telegram or email is set up:
        # deliver through whatever is configured and fits the contact.
        if channel not in notify.configured_channels():
            channel = "auto"
        if channel == "auto" and notify.is_telegram(to):
            channel = "telegram"
        out = await notify.send_to_patient(channel, to, message, audio_url, mp3, ics)
        resolved = out.get("resolvedTo")
        if out.get("ok") and isinstance(resolved, str) and resolved.startswith("tg:"):
            # Later reminders go to this exact chat, not "the latest chat that pressed Start".
            self.resolved_contact = resolved
            if self.unresolved_reminder_urls:
                from integrations import call_reminders

                for url in self.unresolved_reminder_urls:
                    call_reminders.retarget(url, resolved)
                self.unresolved_reminder_urls.clear()
        out["audioUrl"] = audio_url
        out["medications"] = [m["name"] for m in meds]
        out["message"] = message
        if call_url:
            out["callUrl"] = call_url
        if fu:
            out["followUp"] = fu.get("startText")
        return out

    def _with_pharmacy(self, med_id: str) -> bool:
        """In room mode: verified or held by pharmacy, so not on the prescription."""
        if self.room is None or not med_id:
            return False
        mine = [r for r in self.room.refs.values() if r.action == "verify_rx" and r.medication_id == med_id]
        return any(r.status in ("sent", "working", "waiting", "held") for r in mine) and not any(r.active for r in mine)

    def execute(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        fn = {
            "find_in_catalog": self.find_in_catalog,
            "order_test": self.order_test,
            "check_allergies_and_interactions": self.check_allergies_and_interactions,
            "prescribe": self.prescribe,
            "schedule_follow_up": self.schedule_follow_up,
            "stop_medication": self.stop_medication,
            "cancel_test": self.cancel_test,
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
        if res.get("held"):
            return f"{res.get('name')} is on hold by pharmacy: {res.get('reason')}"
        return f"{tool} failed: {res.get('error', 'unknown error')}"
    if tool == "find_in_catalog":
        return "Found: " + (", ".join(m["id"] for m in res["matches"]) or "nothing")
    if tool == "order_test":
        if res.get("department"):
            if res.get("result"):
                return f"{res['name']} is already back: {res['result']}" + (" (abnormal)" if res.get("abnormal") else "")
            return f"{res['name']} " + ("is already with" if res.get("alreadyOrdered") else "sent to") + f" {res['department']}: result pending"
        if res.get("resultPending"):
            return f"Ordered {res['name']}: result pending, see chart"
        return f"Ordered {res['name']}: {res['result']}" + (" (abnormal)" if res["abnormal"] else "")
    if tool == "check_allergies_and_interactions":
        return "Safe" if res["safe"] and not res["warnings"] else "; ".join(res["hardConflicts"] + res["warnings"]) or "Safe"
    if tool == "prescribe" and res.get("pendingVerification"):
        if res.get("alreadyPending"):
            return f"{res.get('name')} is already with pharmacy for verification"
        return f"Sent {res.get('name')} {res.get('dose', '')} x {res.get('duration', '')} to pharmacy for verification"
    if tool == "stop_medication":
        return f"Stopped {res['name']}" if res.get("was") == "stopped" else f"Cancelled the {res['name']} order"
    if tool == "cancel_test":
        return f"Cancelled {res['name']}"
    if tool == "ask_department":
        return f"Asked {res.get('department')}"
    if tool == "invite_faculty":
        return f"Invited {res.get('name')} (faculty)"
    if tool == "request_override":
        return f"Asked faculty to review the hold on {res.get('name')}"
    if tool == "message_faculty":
        return "Passed the doctor's words to faculty"
    if tool == "prescribe":
        return f"Prescribed {res.get('name', args.get('medicationId'))} {res.get('dose', '')} x {res.get('duration', '')}".strip()
    if tool == "schedule_follow_up":
        cal = res.get("calendar") or {}
        when = cal.get("startText")
        rec = res.get("recurrence")
        mins = res.get("startsInMinutes")
        text = (f"Check-in call in {mins} minutes: {res['reason']}" if mins
                else f"Follow-up in {res['inDays']} days: {res['reason']}")
        if rec:
            unit = {"DAILY": "day", "WEEKLY": "week", "MONTHLY": "month"}[rec["freq"]]
            every = "" if rec["interval"] == 1 else f"{rec['interval']} "
            text += f", repeating every {every}{unit}{'s' if rec['interval'] > 1 else ''} x {rec['count']}"
        if res.get("mode") == "call" or rec:
            text += " (remote call with Nurse Asha)"
        if when:
            text += f" ({when}, " + ("added to Google Calendar" if (cal.get("booked") or {}).get("ok") else "calendar invite ready") + ")"
        if cal.get("reminders"):
            n = cal["reminders"]
            text += f"; the patient gets a join reminder at {'each call' if n > 1 else 'call time'}"
        return text
    if tool == "send_to_patient":
        return f"Sent to the patient by {res.get('channel')} ({res.get('to')}): " + ", ".join(res.get("medications") or [])
    if tool == "log_case":
        return "Logged to your CBME clinical logbook" + (f": {res['case']}" if res.get("case") else "")
    if tool == "refer_patient":
        bits = [b for b, ok in (("FHIR ServiceRequest", res.get("fhir")), ("referral PDF", res.get("pdfUrl")),
                                ("voice handover", res.get("audioUrl"))) if ok]
        text = f"Referred to {res.get('specialty')} ({res.get('urgency')})"
        if bits:
            text += ": " + ", ".join(bits)
        if (res.get("delivered") or {}).get("ok"):
            text += "; sent to the consultant"
        return text
    if tool == "record_to_ehr":
        return "Saved to the FHIR health record: " + ", ".join(f"{r['resourceType']}/{r['id']}" for r in res.get("records", []))
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
        "description": "Schedule a follow-up and put it in the doctor's Google Calendar. Use recurrence for repeating check-ins "
                       "(e.g. weekly for a month) and mode call for a remote voice call with Nurse Asha instead of a clinic visit. "
                       "For a call later today ('check-in call in 5 minutes') set inDays 0 and startsInMinutes.",
        "parameters": {"type": "object", "properties": {
            "inDays": {"type": "integer"}, "reason": {"type": "string"},
            "recurrence": {"type": "object", "properties": {
                "freq": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                "count": {"type": "integer", "minimum": 1, "maximum": 12},
                "interval": {"type": "integer", "minimum": 1, "maximum": 4}}, "required": ["freq", "count"]},
            "mode": {"type": "string", "enum": ["visit", "call"]},
            "startsInMinutes": {"type": "integer", "minimum": 1, "maximum": 1440,
                                "description": "Only for a call later today, e.g. 'check-in call in 5 minutes' -> 5 (set inDays 0)."}},
            "required": ["inDays", "reason"]}}},
    {"type": "function", "function": {
        "name": "send_to_patient",
        "description": "Send the patient their prescription (with a Murf voice-prescription audio link in their language) "
                       "and the follow-up date with a calendar invite, by Telegram, WhatsApp, SMS or email to the contact on file (use auto unless the doctor names a channel). "
                       "Only when the doctor asks to send, share, message, Telegram, WhatsApp or email it to the patient.",
        "parameters": {"type": "object", "properties": {
            "channel": {"type": "string", "enum": ["auto", "telegram", "whatsapp", "sms", "email"]}}, "required": ["channel"]}}},
    {"type": "function", "function": {
        "name": "stop_medication",
        "description": "Stop or remove a medication that was prescribed (or cancel one still being checked). "
                       "Only when the doctor says stop, remove, cancel or don't give it.",
        "parameters": {"type": "object", "properties": {
            "medicationId": {"type": "string"}, "reason": {"type": "string"}}, "required": ["medicationId"]}}},
    {"type": "function", "function": {
        "name": "cancel_test",
        "description": "Cancel a test that was ordered and has no result yet. Only when the doctor says cancel it or don't do it.",
        "parameters": {"type": "object", "properties": {"testId": {"type": "string"}}, "required": ["testId"]}}},
    {"type": "function", "function": {
        "name": "log_case",
        "description": "Log this case in the doctor's NMC CBME clinical logbook (a Google Sheet): specialty, diagnosis, skills, tests, "
                       "prescriptions. Only when the doctor asks to log, record or add this case to their logbook.",
        "parameters": {"type": "object", "properties": {
            "diagnosis": {"type": "string", "description": "Working or final diagnosis if the doctor stated one"},
            "notes": {"type": "string"}}, "required": []}}},
    {"type": "function", "function": {
        "name": "refer_patient",
        "description": "Refer the patient to a specialty: writes a FHIR referral ServiceRequest, an SBAR referral letter (Google Doc and PDF) "
                       "and a short Murf voice handover. Only when the doctor asks to refer, or hand over, the patient to a specialist or consultant.",
        "parameters": {"type": "object", "properties": {
            "specialty": {"type": "string", "description": "e.g. cardiology"},
            "urgency": {"type": "string", "enum": ["routine", "urgent", "emergency"]},
            "reason": {"type": "string"},
            "workingDiagnosis": {"type": "string", "description": "Only if the doctor stated one"}},
            "required": ["specialty", "urgency", "reason"]}}},
]

# Extra tools when the encounter has a BAND agent room.
ROOM_TOOLS = ("ask_department", "invite_faculty", "request_override", "message_faculty")
ROOM_TOOL_SPECS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "ask_department",
        "description": "Put the doctor's question to a department (not an order). They answer out loud themselves.",
        "parameters": {"type": "object", "properties": {
            "department": {"type": "string", "enum": ["pharmacist", "lab", "radiology"]},
            "question": {"type": "string", "description": "The doctor's question, in English"}},
            "required": ["department", "question"]}}},
    {"type": "function", "function": {
        "name": "invite_faculty",
        "description": "Bring the human faculty member (senior, consultant, professor) into the room. "
                       "Only when the doctor asks for senior help or supervision.",
        "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}},
    {"type": "function", "function": {
        "name": "request_override",
        "description": "Ask the human faculty member to release a drug that pharmacy is holding. Only when the doctor wants the held drug anyway.",
        "parameters": {"type": "object", "properties": {
            "medicationId": {"type": "string"}, "reason": {"type": "string", "description": "The doctor's reason"}},
            "required": ["medicationId", "reason"]}}},
    {"type": "function", "function": {
        "name": "message_faculty",
        "description": "Pass the doctor's words to the faculty member (a reply to their question, or a message for them).",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}},
]

LOOKUP_PROMPT = (
    "- Context.likelyCatalog lists catalogue ids that already match the doctor's words. If the one you need is there, use that id "
    "directly and do not call find_in_catalog. Ignore entries the doctor did not mean. Put every call this order needs in ONE turn."
)
ROOM_PROMPT = (
    "\nTEAM MODE (overrides anything above): you do not run tests or dispense drugs yourself, you delegate. "
    "order_test sends the test to the laboratory or radiology and the result comes later; prescribe sends the drug to the "
    "clinical pharmacist, who releases or holds it. The pharmacist does the allergy, interaction and dose checks, so "
    "check_allergies_and_interactions is not available: call prescribe directly.\n"
    "- Never state, guess or imply a test result, and never say a drug is prescribed, started, given, added or 'on' before "
    "pharmacy has released it. Say things like 'CBC is sent to the lab' and 'I'm checking amoxicillin with pharmacy'.\n"
    "- Questions meant for a department ('ask pharmacy if...', 'what does radiology think') go to ask_department; never answer them yourself.\n"
    "- If the doctor asks for a senior, consultant, faculty or professor, call invite_faculty. If they want a held drug anyway, call "
    "request_override with their reason. Only a human can release a hold. Words for the faculty member go through message_faculty.\n"
    "- stop_medication and cancel_test work for pending orders too. To ask a silent department again, call order_test or prescribe again.\n"
    "- Example: 'Okay doctor, CBC is off to the lab, and I'm checking co-amoxiclav with pharmacy... I'll tell you what they say.'"
)
OSCE_PROMPT = (
    "\nEXAM: this is an assessed examination. Carry out exactly what the doctor orders. Never suggest, substitute or recommend a drug, "
    "test or diagnosis, never hint or teach, and never explain why something may be wrong. If the order is vague, ask which one they want."
)

SYSTEM_PROMPT = (
    "You are the charge nurse of a clinic, executing the doctor's spoken orders for one patient. "
    "Be fast, and understand intent however the doctor says it.\n"
    "- Infer intent from loose language: partial sentences, abbreviations (CBC, FBC, 'bloods', 'sugar' = blood glucose, "
    "ECG/EKG, CXR or 'x ray' = chest X-ray, LFT, KFT/RFT, TSH, 'urine' = urinalysis), Hinglish ('ek ECG kara do', "
    "'paracetamol de do', 'sugar check karo', 'drip laga do'), indirect requests ('she needs an antibiotic', "
    "'get her sugar checked', 'let's put him on fluids', 'sort out the pain') and misrecognised speech "
    "('see bc' = CBC, 'amoxy' = amoxicillin, 'para' = paracetamol). Pick the most plausible clinical reading.\n"
    "- The doctor may mix English, Hindi, Kannada, Tamil, Telugu or other Indian languages in one sentence, in Roman "
    "letters or native script ('ಒಂದು ECG ಮಾಡಿಸಿ', 'ಪ್ಯಾರಸಿಟಮಾಲ್ ಕೊಡಿ', 'एक CBC करवा दो', 'sugar test maadi'). "
    "Translate the intent yourself and act on it; tool arguments stay in English catalog terms.\n"
    "- Vague drug requests ('an antibiotic', 'something for the pain', 'something for acidity'): choose the best "
    "catalog match for this patient's complaint and allergies, and say which one you chose and its dose.\n"
    "- Only when a request is truly ambiguous (no sensible catalog match) do the parts you can, and ask ONE short "
    "clarifying question in your spoken confirmation. Never say you did not understand, and never silently do nothing.\n"
    "- If the doctor's words contain NO clinical order (small talk, questions to the patient, thinking aloud), "
    "call NO tools and reply with exactly: NO_ORDER\n"
    "- Otherwise: first write one short plan sentence, then call tools. Resolve every test/medication id with "
    "find_in_catalog, order tests with order_test, run check_allergies_and_interactions before prescribe, then prescribe "
    "or schedule_follow_up. check_allergies_and_interactions also queries real public drug databases (NIH RxNorm/RxClass "
    "and openFDA labels): if it reports a source-backed conflict, hold the drug and name the source briefly (e.g. "
    "'the FDA label warns...'). For repeating follow-ups (\'weekly check-in calls for a month\', \'every 2 weeks, 3 times\') pass recurrence "
    "{freq, count, interval}; for phone, video or remote check-ins pass mode call (a remote voice call with Nurse Asha), "
    "otherwise mode visit. Follow-ups are added to the doctor's Google Calendar automatically. "
    "If the doctor asks to send, share, WhatsApp, SMS or email the prescription or follow-up "
    "to the patient, call send_to_patient (after any prescribe or schedule_follow_up in the same request). "
    "If the doctor says to stop, remove or cancel a drug or a test, resolve its id and call stop_medication or cancel_test. "
    "If the doctor asks to log or record the case in their logbook, call log_case (after any orders in the same request). "
    "If the doctor asks to refer the patient to a specialist, call refer_patient with the specialty, urgency (routine unless they say urgent or emergency) "
    "and a short reason; the letter and voice handover are created for you. If a tool fails or a drug is refused for allergy, adapt: say so and (only if the doctor "
    "named a class or indication) pick a safe alternative from the catalog; otherwise just hold it.\n"
    "- Never invent results, ids, or doses beyond tool outputs and the catalog. A result marked pending is not a normal result: "
    "say it is ordered and will be on the chart.\n"
    "- Dose: pass the doctor's spoken dose and frequency to prescribe exactly as said (e.g. '75 mg once daily'). "
    "If the only catalog product has a different strength than the doctor asked for, still prescribe it but keep the "
    "doctor's dose in the dose field, and say the difference out loud in your final sentence "
    "(e.g. 'aspirin is stocked as 100 mg, prescribed 75 mg daily as you asked, please confirm').\n"
    "- Substitutes: NEVER give an alternative drug the dose the doctor said for a different drug. If you offer or "
    "prescribe a substitute (e.g. a macrolide instead of a held penicillin), the server uses that drug's own standard "
    "dose; say the substitute's name and its dose, and ask the doctor to confirm.\n"
    "- Finish with a short spoken confirmation, max 25 words, in the warm natural voice of an experienced Indian charge "
    "nurse talking to the doctor. Sound human: fillers like 'okay', 'right', 'sure doctor' are fine. Use contractions, say doses and numbers as words, and use commas and '...' for "
    "natural pauses. Never start with 'Done -', never use lists or markdown. Say what you did, flag anything held or "
    "different, and end with a short check-in sometimes. Example: 'Okay doctor, done. I've sent the troponin and the "
    "ECG... and aspirin is on, seventy-five milligrams once a day. Anything else?' Another: 'Okay doctor, CBC is sent, "
    "but I've held the amoxicillin... she's allergic to penicillin.'"
)


_WORD = re.compile(r"[^\W_]+(?:-[^\W_]+)*", re.UNICODE)
_COMMON = frozenset("the and for with test tests level blood serum panel count profile x ray scan please start give send get "
                    "times time day days week weeks mg ml daily once twice after before check ka ke ki ko aur ek do".split())


def likely_catalog(st: NurseState, utterance: str) -> dict[str, list[dict[str, str]]]:
    """Catalogue entries the utterance plainly names, so the model can order without a
    lookup round (about 2 s on a voice turn). Only a hint: every id is still validated."""
    words = [w for w in _norm(utterance).split()][:60]
    joined = f" {' '.join(words)} "
    tests: list[tuple[int, CatalogTest]] = []
    for t in st.tests.values():
        idw, name = _norm(t.id), _norm(t.name)
        keys = [w for w in _WORD.findall(name) if len(w) > 2 and w not in _COMMON]
        score = 4 if f" {idw} " in joined or f" {name} " in joined else 0
        score += 2 * bool(keys and f" {keys[0]} " in joined) + sum(f" {k} " in joined for k in keys[1:])
        if score >= 2:
            tests.append((score, t))
    tests.sort(key=lambda x: -x[0])
    meds = [m for m in st.meds.values() if drugterms.mentions_drug(utterance, m.id, m.name)]
    return {"tests": [{"id": t.id, "name": t.name} for _, t in tests[:8]],
            "medications": [{"id": m.id, "name": m.name, "dosing": m.dosing or ""} for m in meds[:6]]}


def _patient_brief(req: NurseActRequest, st: NurseState) -> str:
    p = req.patient
    extra: dict[str, Any] = {}
    if st.room is not None:
        rx = [r for r in st.room.refs.values() if r.action == "verify_rx"]
        extra = {
            "pendingWithPharmacy": [r.medication_id for r in rx if r.status in ("sent", "working", "waiting", "timeout", "failed")],
            "heldByPharmacy": [{"medicationId": r.medication_id, "reason": "" if st.osce else r.summary,
                                "overrideRequested": r.override_requested} for r in rx if r.status == "held"],
            "pendingTests": [t for r in st.room.refs.values() if r.tests and r.status in ("sent", "working", "waiting", "timeout", "failed")
                             for t in r.test_ids if t not in r.resulted],
            "facultyInRoom": bool(st.room.humans()), "facultyAwaitsReply": st.room.awaiting_faculty,
        }
    return json.dumps({
        **extra,
        "patient": {"name": p.name, "age": p.age, "gender": p.gender, "chiefComplaint": p.chiefComplaint,
                    "allergies": p.allergies or "not recorded", "vitals": p.vitals,
                    "anamnesis": [qa.model_dump() for qa in p.anamnesis][:20]},
        "alreadyOrdered": st.ordered, "alreadyPrescribed": st.prescribed,
        "catalogSize": {"tests": len(st.tests), "medications": len(st.meds)},
        "likelyCatalog": likely_catalog(st, req.utterance),
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


def _tool_specs(st: NurseState) -> list[dict[str, Any]]:
    if st.room is None:
        return TOOL_SPECS
    # The pharmacist does the checking in room mode.
    return [t for t in TOOL_SPECS if t["function"]["name"] != "check_allergies_and_interactions"] + ROOM_TOOL_SPECS


async def _run_native(st: NurseState, messages: list[dict[str, Any]], steps: list[dict[str, Any]]) -> tuple[str, str]:
    """Native function calling. Returns (plan, final_text)."""
    plan = ""
    provider: Optional[str] = None
    for _ in range(MAX_ITERATIONS):
        msg, provider = await chat(messages, tools=_tool_specs(st), max_tokens=500, temperature=0.1, stick_to=provider)
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
            res = await st.aexecute(name, args)
            steps.append({"tool": name, "args": args, "ok": bool(res.get("ok")), "summary": summarize(name, args, res), "result": res})
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(res)})
    # iteration cap: ask for the closing sentence without tools
    msg, _ = await chat(messages + [{"role": "user", "content": "Give the one-sentence spoken confirmation now."}], max_tokens=120, stick_to=provider)
    return plan, strip_think(msg.get("content") or "")


async def _run_json_plan(st: NurseState, req: NurseActRequest, steps: list[dict[str, Any]]) -> tuple[str, str]:
    """Fallback when native tool calling is unavailable: ask for a JSON plan."""
    names = {s["function"]["name"]: list(s["function"]["parameters"]["properties"]) for s in _tool_specs(st)}
    sys_msg = (
        "You are a clinic charge nurse. Reply with JSON only: "
        '{"intent":"order"|"none"|"clarify","plan":"one sentence","question":"only for clarify: one short question to the doctor",'
        '"calls":[{"tool":"...","args":{...}}]}. '
        f"Tools and arg names: {json.dumps(names)}. Resolve ids from the catalog list given; "
        "check_allergies_and_interactions must precede prescribe. intent none => calls [].\n"
        + (ROOM_PROMPT + "\n" if st.room is not None else "") + (OSCE_PROMPT + "\n" if st.osce else "") +
        ""
        f"Catalog tests: {json.dumps([t.model_dump() for t in st.tests.values()])}\n"
        f"Catalog medications: {json.dumps([m.model_dump() for m in st.meds.values()])}\n"
        f"Patient: {_patient_brief(req, st)}"
    )
    msg, prov = await chat(
        [{"role": "system", "content": sys_msg}, {"role": "user", "content": req.utterance}],
        json_mode=True, max_tokens=500, temperature=0.1,
    )
    plan_obj = _parse_json(msg.get("content") or "") or {}
    calls = plan_obj.get("calls")
    calls = [c for c in calls if isinstance(c, dict)] if isinstance(calls, list) else []
    if plan_obj.get("intent") == "clarify" and not calls and str(plan_obj.get("question") or "").strip():
        return "", str(plan_obj["question"]).strip()
    if plan_obj.get("intent") == "none" or not calls:
        return "", "NO_ORDER"
    for c in calls[:8]:
        name, args = str(c.get("tool") or ""), c.get("args")
        args = args if isinstance(args, dict) else {}
        res = await st.aexecute(name, args)
        steps.append({"tool": name, "args": args, "ok": bool(res.get("ok")), "summary": summarize(name, args, res), "result": res})
    msg2, _ = await chat(
        [{"role": "system", "content": langmod.with_language("Write a short spoken confirmation (max 30 words, no markdown, no 'Done -' prefix) as a warm Indian charge nurse talking to the doctor: contractions, numbers as words, commas and '...' for pauses, e.g. 'Okay doctor, I've sent the troponin and ECG... anything else?'. Mention anything refused or abnormal. Use only the facts given. A pending result is not normal, and a drug sent to pharmacy is not prescribed yet: say you are checking with pharmacy.", req.lang, female=True, role="nurse")},
         {"role": "user", "content": json.dumps([{"tool": s["tool"], "summary": s["summary"]} for s in steps])}],
        max_tokens=120, stick_to=prov,
    )
    return str(plan_obj.get("plan", "")), strip_think(msg2.get("content") or "")


NURSE_FALLBACK = {
    "ta": ("சரி டாக்டர், உங்கள் ஆர்டர் ஆகிவிட்டது. வேறு ஏதாவது?", "டாக்டர், அந்த ஆர்டரை முடிக்க முடியவில்லை."),
    "te": ("సరే డాక్టర్, మీ ఆర్డర్ అయింది. ఇంకేమైనా?", "డాక్టర్, ఆ ఆర్డర్ పూర్తి చేయలేకపోయాను."),
    "mr": ("ठीक आहे डॉक्टर, तुमची ऑर्डर झाली. आणखी काही?", "डॉक्टर, ती ऑर्डर पूर्ण करता आली नाही."),
    "bn": ("ঠিক আছে ডাক্তারবাবু, আপনার অর্ডার হয়ে গেছে। আর কিছু?", "ডাক্তারবাবু, ওই অর্ডারটা শেষ করতে পারলাম না।"),
}


def _room_confirmation(st: NurseState, lang: Optional[str]) -> str:
    """Safe spoken line for delegated orders, in the session language ('' when nothing was delegated)."""
    if st.room is None or not st.pending:
        return ""
    from agentroom import bedside

    lg = langmod.norm_lang(lang)
    out = []
    for role in ("lab", "radiology"):
        items = [x["label"] for x in st.pending if x["target"] == role and x.get("testIds")]
        if items:
            out.append(bedside.line("sent_tests", lg, items=", ".join(items), dept=bedside.department(role, lg)))
    rx = [x["label"] for x in st.pending if x.get("medicationId")]
    if rx:
        out.append(bedside.line("sent_rx", lg, items=", ".join(rx)))
    return " ".join(out)


_SAYS_PHARMACY = re.compile("pharmac|verif|check|फार्म|चेक|ಫಾರ್ಮ|ಚೆಕ್|ஃபார்ம|பார்ம|சரிபார்|ఫార్మ|చెక్|ফার্ম|যাচাই", re.IGNORECASE)
_CLAIMS_DRUG = re.compile(
    r"\b(?:have|has|i've|is|are|it's|been)\s+(?:\w+\s+)?(?:prescribed|started|given|added|on board)\b|\b(?:i|we) (?:prescribed|started|gave|added)\b"
    r"|\bis on\b(?! hold)", re.IGNORECASE)
_CLAIMS_RESULT = re.compile(
    r"\b(?:is|are|was|were|came back|looks?|shows?|showing)\s+(?:all\s+|quite\s+|within\s+)?(?:normal|fine|negative|positive|raised|elevated|high|low|abnormal|clear)\b",
    re.IGNORECASE)


def _safe_room_line(st: NurseState, text: str, lang: Optional[str]) -> str:
    """Asha may not announce a verdict or a result the departments have not given yet."""
    if st.room is None or not st.pending:
        return text
    rx = any(x.get("medicationId") for x in st.pending)
    tests = any(x.get("testIds") for x in st.pending)
    bad = (rx and (not _SAYS_PHARMACY.search(text) or _CLAIMS_DRUG.search(text))) or (tests and _CLAIMS_RESULT.search(text))
    return _room_confirmation(st, lang) if bad else text


def _fallback_confirmation(st: NurseState, steps: list[dict[str, Any]], lang: Optional[str] = None) -> str:
    bits = []
    room_line = _room_confirmation(st, lang) if getattr(st, "room", None) is not None else ""
    if room_line:
        return room_line
    if getattr(st, "room", None) is not None:
        done = [s["summary"] for s in steps if s["ok"] and s["tool"] not in ("find_in_catalog", "record_to_ehr")]
        if done and langmod.norm_lang(lang) == "en":
            return "Okay doctor, " + "; ".join(done)[:240] + "."
        bits += done
    if st.new_tests:
        bits.append(", ".join(st.tests[t].name for t in st.new_tests) + " ordered")
    if st.new_rx:
        bits.append(", ".join(st.meds[r["medicationId"]].name for r in st.new_rx) + " prescribed")
    refused = [s["summary"] for s in steps if s["tool"] == "prescribe" and not s["ok"]]
    if refused:
        bits.append("held: " + "; ".join(refused))
    if st.follow_up:
        bits.append(f"follow-up in {st.follow_up['inDays']} days")
    for s in steps:
        if s["ok"] and s["tool"] in ("stop_medication", "cancel_test") and s["summary"] not in bits:
            bits.append(s["summary"][:1].lower() + s["summary"][1:])
    lg = langmod.norm_lang(lang)
    if lg == "hi":
        return "ठीक है डॉक्टर, आपका ऑर्डर हो गया। और कुछ?" if bits else "डॉक्टर, मैं वह ऑर्डर पूरा नहीं कर पाई।"
    if lg == "kn":
        return "ಸರಿ ಡಾಕ್ಟರ್, ನಿಮ್ಮ ಆರ್ಡರ್ ಆಯಿತು. ಇನ್ನೇನಾದರೂ?" if bits else "ಡಾಕ್ಟರ್, ಆ ಆರ್ಡರ್ ಮುಗಿಸಲು ಆಗಲಿಲ್ಲ."
    if lg in NURSE_FALLBACK:
        ok, fail = NURSE_FALLBACK[lg]
        return ok if bits else fail
    return ("Okay doctor, " + ", ".join(bits) + ". Anything else?") if bits else "I couldn't complete that order."


def _refresh_call_snapshots(st: NurseState) -> None:
    """A follow-up booked before the prescription in the same order still shows
    the final medicines on Asha's call page."""
    if not st.call_tokens:
        return
    from integrations import followup_calls

    rx = [{"name": st.meds[r["medicationId"]].name if r["medicationId"] in st.meds else r["medicationId"],
           "dose": r.get("dose", ""), "duration": r.get("duration", "")} for r in st.new_rx]
    for r in st.req.prescriptionsSoFar:
        if not isinstance(r, dict):
            continue
        mid = str(r.get("medicationId", ""))
        name = st.meds[mid].name if mid in st.meds else str(r.get("name") or mid)
        if name and all(x["name"] != name for x in rx):
            rx.append({"name": name, "dose": str(r.get("dose", "")), "duration": str(r.get("duration", ""))})
    for tok in st.call_tokens:
        followup_calls.update_call(tok, prescriptions=_clip_rx(rx))


async def _record_to_ehr(req: NurseActRequest, st: NurseState, steps: list[dict[str, Any]]) -> None:
    """Write this run's orders to a real FHIR R4 server (public HAPI test server by default)."""
    if not (st.new_tests or st.new_rx or st.follow_up):
        return
    from integrations import fhir

    p = req.patient
    case = {"id": req.caseId, "name": p.name, "age": p.age, "gender": p.gender}
    tests = [(t, st.tests[t].name) for t in st.new_tests if t in st.tests]
    meds = [{"name": st.meds[r["medicationId"]].name if r["medicationId"] in st.meds else r["medicationId"],
             "dose": r["dose"], "duration": r["duration"]} for r in st.new_rx]
    try:
        records = await asyncio.wait_for(fhir.record_batch(case, tests, meds, st.follow_up), timeout=8.0)
    except Exception as e:  # noqa: BLE001
        log.warning("FHIR write failed: %s", type(e).__name__)
        records = []
    res = {"ok": bool(records), "records": records or []}
    if not records:
        res["error"] = "FHIR server unreachable; the order is on the local chart only"
    steps.append({"tool": "record_to_ehr", "args": {"server": "HL7 FHIR R4"}, "ok": bool(records),
                  "summary": summarize("record_to_ehr", {}, res), "result": res})


# (encounter, utterance) -> (started, the run). Bounded by DEDUPE_S and MAX_RECENT.
_recent: dict[tuple[str, str], tuple[float, "asyncio.Task[dict[str, Any]]"]] = {}
MAX_RECENT = 200


@router.post("/agent/nurse/act")
async def nurse_act(req: NurseActRequest):
    if not req.encounterId:
        return await _act(req)
    now = time.monotonic()
    for k in [k for k, (t, _) in _recent.items() if now - t > DEDUPE_S][: MAX_RECENT]:
        _recent.pop(k, None)
    key = (req.encounterId[:120], re.sub(r"\s+", " ", req.utterance).strip().lower()[:400])
    hit = _recent.get(key)
    if hit is not None and hit[1].get_loop() is asyncio.get_running_loop():
        return await asyncio.shield(hit[1])
    task = asyncio.ensure_future(_act(req))
    _recent[key] = (now, task)
    return await asyncio.shield(task)


def _room_for(req: NurseActRequest) -> Any:
    """The encounter's agent room, or None for the legacy single agent. Never raises."""
    if not req.encounterId:
        return None
    try:
        from agentroom.hub import hub

        room = hub.active(req.encounterId)
        if room is None:
            return None
        room.osce = bool(room.osce or req.osce)
        if req.lang:
            room.lang = langmod.norm_lang(req.lang)
        names = {m.id: m.name for m in req.catalog.medications}
        current = {str(r.get("medicationId")): {"medicationId": str(r.get("medicationId")), "dose": str(r.get("dose") or ""),
                                                "name": names.get(str(r.get("medicationId")), str(r.get("medicationId")))}
                   for r in req.prescriptionsSoFar if isinstance(r, dict) and r.get("medicationId")}
        for mid in req.alreadyPrescribed:
            current.setdefault(mid, {"medicationId": mid, "name": names.get(mid, mid), "dose": ""})
        hub.set_chart(room, list(current.values()), names)
        hub.doctor_acted(room)
        return room
    except Exception as e:  # noqa: BLE001
        log.warning("agent room unavailable: %s", type(e).__name__)
        return None


def _addressed(req: NurseActRequest) -> bool:
    try:
        import llm_proxy

        return llm_proxy.addressed_to_nurse([{"role": "user", "content": req.utterance}])
    except Exception:  # noqa: BLE001
        return False


def _applied(st: NurseState) -> dict[str, Any]:
    out: dict[str, Any] = {"orderedTestIds": st.new_tests, "prescriptions": st.new_rx,
                           "cancelledTestIds": st.cancelled, "stoppedMedicationIds": st.stopped}
    if st.follow_up:
        out["followUp"] = st.follow_up
    return out


async def _act(req: NurseActRequest) -> dict[str, Any]:
    run_id = "run_" + secrets.token_hex(6)
    room = _room_for(req)
    st = NurseState(req, room)
    steps: list[dict[str, Any]] = []
    system = SYSTEM_PROMPT + "\n" + LOOKUP_PROMPT + (ROOM_PROMPT if room is not None else "") + (OSCE_PROMPT if st.osce else "")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": langmod.with_language(
            system + "\nContext: " + _patient_brief(req, st), req.lang, female=True, role="nurse")},
        {"role": "user", "content": req.utterance},
    ]
    from fastapi import HTTPException

    try:
        plan, final = await _run_native(st, messages, steps)
    except HTTPException as e:
        if e.status_code == 503:
            raise
        if steps:
            # Tools already ran (orders, sends): never replay them through the JSON plan.
            log.warning("native tool calling failed mid-run (%s); keeping %d steps", str(e.detail)[:120], len(steps))
            plan, final = "", ""
        else:
            log.warning("native tool calling failed (%s); using JSON-plan fallback", str(e.detail)[:120])
            st = NurseState(req, room)
            try:
                plan, final = await _run_json_plan(st, req, steps)
            except HTTPException as e2:
                if e2.status_code == 503:
                    raise
                log.warning("JSON-plan fallback failed too (%s)", str(e2.detail)[:120])
                plan, final = "", ""
            except Exception as e2:  # noqa: BLE001
                log.warning("JSON-plan fallback failed too (%s)", type(e2).__name__)
                plan, final = "", ""
            if not steps and not final:
                return {"runId": run_id, "intent": "none", "plan": "", "steps": [], "applied": _applied(st), "pending": [],
                        "spokenConfirmation": _fallback_confirmation(st, [], req.lang), "error": "nurse unavailable"}
    finally:
        st.flush_room()  # whatever the model already decided goes out, even if its closing line failed

    if not steps:
        # No tool ran. A question back to the doctor must be heard, not dropped.
        ask = re.sub(r"[*_`#]+", "", final or "").strip()
        clarify = bool(ask) and "NO_ORDER" not in ask and ("?" in ask or _addressed(req))
        return {"runId": run_id, "intent": "clarify" if clarify else "none", "plan": "", "steps": [], "applied": _applied(st),
                "pending": [], "spokenConfirmation": ask[:400] if clarify else ""}
    _refresh_call_snapshots(st)
    await _record_to_ehr(req, st, steps)
    spoken = final if final and "NO_ORDER" not in final else _fallback_confirmation(st, steps, req.lang)
    spoken = _safe_room_line(st, spoken, req.lang)
    return {
        "runId": run_id, "intent": "order",
        "plan": plan or "; ".join(s["summary"] for s in steps[:3]),
        "steps": steps, "applied": _applied(st), "pending": st.pending, "spokenConfirmation": spoken[:400],
    }


@router.get("/agent/notify/status")
async def notify_status():
    """Which delivery channels are configured, and the Telegram bot's Start link."""
    from integrations import notify

    return {"channels": notify.configured_channels(), "telegram": await notify.telegram_bot_info()}


@router.get("/agent/followup-call/{token}")
async def followup_call(token: str):
    """Case snapshot for the remote Asha follow-up call page."""
    from fastapi import HTTPException
    from integrations import followup_calls

    snap = followup_calls.get_call(token)
    if snap is None:
        raise HTTPException(status_code=404, detail="Not found")
    return snap
