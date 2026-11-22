"""Radiologist Vikram: imaging, and the two questions that come before it.

Every request is vetted by fixed rules: pregnancy before ionising pelvic or abdominal
imaging or contrast, kidney function before contrast. He asks and waits; the answer
decides. Reports leave exactly as stored, urgent findings flagged by fixed patterns.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from typing import Any, Optional

from . import analytes
from . import dept_lines  # noqa: F401 - adds the theatre and reading room lines
from . import dept_phrases as phrases
from . import secondread
from .answers import go_ahead, yes_no
from .base import LAB, NURSE, RADIOLOGY, DepartmentAdapter, Pending, Records, Room, Turn, llm_answer, text_lang, two_sentences
from .lab import human_line, spoken_results, turnaround_s
from .protocol import Handoff

LAB_WAIT_S = 12.0
QUESTION_WAIT_S = 600.0
READ_BACK_WAIT_S = 45.0  # a critical finding is called again once if nobody reads it back
CONTRAST_HOLD_EGFR = 30
CONTRAST_CARE_EGFR = 45

# Ionising studies whose beam includes the abdomen or pelvis.
PELVIC_IONISING = frozenset({"kub", "xr-spine", "xr-pelvis", "ct-abdomen"})
ALWAYS_CONTRAST = frozenset({"ct-angio"})
USUALLY_CONTRAST = frozenset({"ct-abdomen"})
MAYBE_CONTRAST = frozenset({"ct-chest", "ct-head", "ct-cspine"})
_PLAIN = re.compile(r"non[- ]?contrast|without contrast|plain|\bKUB\b|stone|calcul|colic|low[- ]dose", re.I)
_WITH = re.compile(r"(?<!non-)(?<!non )(?<!without )\bcontrast|\bCECT\b|angiogra", re.I)

# Findings that are telephoned through. Denied findings do not count.
URGENT = re.compile(
    r"tension pneumothorax|large pneumothorax|(?<!recurrent )(?<!residual )\bpneumothorax(?! pocket)|mediastinal shift|midline shift|"
    r"ha?emorrhage|acute (?:re-?)?bleed|extradural|aortic dissection|pulmonary embol|free air|pneumoperitoneum|perforation|"
    r"cord compression|cauda equina compression|fetal demise|no fetal cardiac activity|"
    r"ectopic|no IUP|torsion|reduced blood flow to (?:the )?(?:right |left )?testis|tamponade|small[- ]bowel obstruction|"
    r"acute infarct|diffusion restriction|ruptur|filling defect|herniation of (?:the )?(?:brain|tonsils)|\bgas gangrene|"
    r"liver abscess|tubo-ovarian (?:complex|abscess)", re.I)

SYSTEM = (
    "You are Vikram, the radiologist of a teaching hospital in India, answering a doctor at the bedside in a SYNTHETIC "
    "training simulator. <record> holds only the imaging reports you have issued in this encounter. Explain those reports "
    "and what the study can or cannot show. Do not prescribe, and do not discuss a study that is not in the record."
)


def uses_contrast(test_id: str, indication: str, name: str) -> bool:
    if test_id in ALWAYS_CONTRAST:
        return True
    if test_id in USUALLY_CONTRAST:
        return not _PLAIN.search(indication)
    return test_id in MAYBE_CONTRAST and bool(_WITH.search(indication)) and not _PLAIN.search(indication)


class RadiologyAdapter(DepartmentAdapter):
    role = RADIOLOGY
    handles = frozenset({("request", "run_imaging"), ("request", "ask"), ("request", "second_read"), ("ack", "critical_finding")})

    def __init__(self, owner: str = "", lab_wait: float = LAB_WAIT_S, **kw: Any) -> None:
        super().__init__(owner, **kw)
        self.lab_wait = lab_wait
        self._records: Optional[Records] = None
        self._reads: Optional[secondread.Reads] = None

    @property
    def records(self) -> Records:
        if self._records is None:
            self._records = Records(("imaging",), extra=("pocus",))
        return self._records

    @property
    def reads(self) -> secondread.Reads:
        if self._reads is None:
            self._reads = secondread.Reads()
        return self._reads

    def warm(self) -> None:
        self.records.names

    @staticmethod
    def issued(room: Room) -> dict[str, dict[str, Any]]:
        return room.data.setdefault("issued", {})

    async def restore(self, room: Room, h: Handoff) -> None:
        if h.kind == "result" and h.action == "run_imaging":
            for r in h.data.get("results") or []:
                if isinstance(r, dict) and r.get("testId"):
                    self.issued(room)[str(r["testId"])] = r

    async def handle(self, turn: Turn, h: Handoff) -> None:
        if h.action == "ask":
            await self.answer(turn, h)
            return
        if h.action == "second_read":
            await self.second_read(turn, h)
            return
        if h.action == "critical_finding":
            await self.read_back(turn, h)
            return
        known, unknown, names = self.records.wanted(h.data.get("tests"))
        p = h.data.get("patient") if isinstance(h.data.get("patient"), dict) else {}
        try:
            age: Optional[float] = float(p.get("age"))
        except (TypeError, ValueError):
            age = None
        indication = str(h.data.get("indication") or "")[:400]
        st: dict[str, Any] = {
            "ref": h.ref, "caseId": str(h.data.get("caseId") or "")[:80], "known": known, "unknown": unknown, "names": names,
            "contrast": [t for t in known if uses_contrast(t, indication, names[t])],
            "pelvic": [t for t in known if t in PELVIC_IONISING],
            "pregnancy": str(h.data.get("pregnancy") or "unknown").lower(),
            "fertile": str(p.get("gender") or "").upper().startswith("F") and (age is None or 12 <= age <= 50),
            "asked": 0, "notes": [], "cleared": False, "requester": turn.sender_id,
        }
        await self.vet(turn, st)

    # ── vetting: each step either returns after asking someone, or falls through ─
    def _risky(self, st: dict[str, Any]) -> list[str]:
        return [t for t in st["known"] if t in st["pelvic"] or t in st["contrast"]]

    def _label(self, st: dict[str, Any], tests: list[str], lang: str) -> str:
        return phrases.join([phrases.short_test(st["names"][t]) for t in tests[:2]], lang)

    async def _ask_doctor(self, turn: Turn, st: dict[str, Any], question: str, spoken: str, step: str) -> bool:
        st["step"] = step
        return await turn.ask_department(
            NURSE, question,
            Handoff(kind="query", action="safety_question", ref=st["ref"], enc=turn.enc, lang=turn.lang, spoken=spoken,
                    data={"question": question, "about": st["ref"]}),
            requester=st["requester"], state=st, timeout=QUESTION_WAIT_S, target_id=st["requester"])

    async def vet(self, turn: Turn, st: dict[str, Any]) -> None:
        risky = self._risky(st)
        if not st["asked"]:
            turn.tool("vet_request", "Vetting the imaging request", tests=st["known"])
        if risky and st["fertile"] and st["pregnancy"] != "no" and not st["cleared"]:
            label = self._label(st, risky, turn.lang)
            en = self._label(st, risky, "en")
            st["asked"] += 1
            if st["pregnancy"] == "yes":
                turn.thought("Patient is pregnant, asking whether to go ahead")
                if await self._ask_doctor(turn, st, f"The patient is pregnant. Should I go ahead with {en}, or defer it?",
                                          phrases.say("img_q_pregnant", turn.lang, t=label), "go"):
                    return
            else:
                turn.thought("Pregnancy status is unknown, asking before radiation or contrast")
                key = "img_q_pregnancy" if st["asked"] == 1 else "img_q_pregnancy_again"
                q = f"Could the patient be pregnant? I need to know before {en}." if st["asked"] == 1 else \
                    f"I still need a clear yes or no on pregnancy before {en}. A urine pregnancy test would settle it."
                if await self._ask_doctor(turn, st, q, phrases.say(key, turn.lang, t=label), "pregnancy"):
                    return
            await self.defer(turn, st, risky, "pregnancy status could not be settled")
            return
        if st["contrast"] and not st.get("renalAsked"):
            st["renalAsked"] = True
            turn.thought("Contrast study, asking the laboratory for kidney function")
            if await turn.ask_department(
                    LAB, "Please send the kidney function on record before contrast.",
                    Handoff(kind="query", action="renal_function", ref=st["ref"], enc=turn.enc, lang=turn.lang, data={"caseId": st["caseId"]}),
                    requester=st["requester"], state=st, timeout=self.lab_wait):
                return
            st["notes"].append("Kidney function was not available before contrast.")
        turn.tool_done("Request cleared")
        await self.report(turn, st)

    async def resume(self, turn: Turn, p: Pending, h: Handoff) -> None:
        st = p.state
        turn.sender_id = p.requester
        if h.action == "renal_function":
            d = h.data
            try:
                egfr: Optional[float] = float(d.get("egfr"))
            except (TypeError, ValueError):
                egfr = None
            turn.tool_done("Kidney function received", bool(d.get("available")))
            if (egfr is not None and egfr < CONTRAST_HOLD_EGFR) or d.get("acuteRise"):
                label = self._label(st, st["contrast"], turn.lang)
                value = f"{egfr:g}" if egfr is not None else str(d.get("creatinine") or "")
                st["asked"] += 1
                st["egfr"] = value
                if await self._ask_doctor(turn, st, f"{d.get('text', '')} Should I go ahead with contrast for {self._label(st, st['contrast'], 'en')}, or defer it?".strip(),
                                          phrases.say("img_q_contrast", turn.lang, v=value, t=label), "contrast"):
                    return
                await self.defer(turn, st, st["contrast"], "contrast risk with this kidney function")
                return
            if not d.get("available") or (egfr is None and not d.get("normal")):
                st["notes"].append("No kidney function on record before contrast.")
            elif egfr is not None and egfr < CONTRAST_CARE_EGFR:
                st["notes"].append(f"eGFR {egfr:g}: contrast given with hydration, recheck creatinine in 48 hours.")
            await self.report(turn, st)
            return
        answer = str(h.data.get("answer") or "")[:500]
        if st.get("step") == "pregnancy":
            said = yes_no(answer)
            if said == "no":
                st["pregnancy"] = "no"
            elif said == "yes":
                st["pregnancy"] = "yes"
            elif st["asked"] >= 2:
                await self.defer(turn, st, self._risky(st), "pregnancy has not been ruled out")
                return
            await self.vet(turn, st)
            return
        decision = go_ahead(answer)
        tests = self._risky(st) if st.get("step") == "go" else st["contrast"]
        if decision == "go":
            st["notes"].append("Done on the doctor's decision after the safety question.")
            st["cleared"] = True
            if st.get("step") == "contrast":
                await self.report(turn, st)
            else:
                await self.vet(turn, st)
        else:
            await self.defer(turn, st, tests, "pregnant patient" if st.get("step") == "go" else "contrast risk with this kidney function")

    async def on_wait_timeout(self, turn: Turn, p: Pending) -> None:
        st = p.state
        if p.action == "critical_finding":
            if not st.get("again"):
                turn.thought("No read-back yet, calling the critical finding again")
                await self._call(turn, p.ref, st["labels"], st["study"], again=True)
            return
        if p.action == "renal_function":
            turn.thought("No answer from the laboratory, going on without it")
            st["notes"].append("The laboratory did not answer on kidney function before contrast.")
            await self.report(turn, st)
            return
        tests = st["contrast"] if st.get("step") == "contrast" else self._risky(st)
        await self.defer(turn, st, tests, "the safety question was not answered")

    # ── reading room: second read ────────────────────────────────────────────
    async def second_read(self, turn: Turn, h: Handoff) -> None:
        """His own reading of the film against the student's report. The request never carries the answer."""
        film_id = str(h.data.get("filmId") or "")[:64]
        film = self.reads.get(film_id)
        if film is None:
            await turn.reply("I do not have that film.", "ack", "second_read", h.ref, data={"status": "rejected", "reason": "unknown film"})
            return
        turn.tool("read_film", f"Reading {film['study']} independently", filmId=film_id)
        r = await secondread.read(film_id, film, str(h.data.get("report") or ""), str(h.data.get("diagnosis") or ""))
        turn.tool_done("Agrees with the report" if r.agrees else f"Discrepancy, {len(r.missed)} finding(s) not in the report", r.agrees)
        top = next((f["label"] for f in r.missed if f["critical"]), "")
        if r.agrees:
            spoken = phrases.say("sr_agree", turn.lang)
            text = "Second read: I agree with the report." + (f" For completeness: {'; '.join(f['label'] for f in r.missed[:2])}." if r.missed else "")
        else:
            spoken = (phrases.say("sr_discrepancy", turn.lang, v=phrases.speakable(top, 110)) if top
                      else phrases.say("sr_diagnosis", turn.lang, v=phrases.speakable(r.diagnosis, 110)))
            parts = ["Second read: DISCREPANCY."]
            if r.missed:
                parts.append("Not in the report: " + "; ".join(f["label"] + (" (critical)" if f["critical"] else "") for f in r.missed[:4]) + ".")
            if not r.diagnosis_agrees:
                parts.append(f"My diagnosis: {r.diagnosis}.")
            text = " ".join(parts)
        await turn.reply(text, "result", "second_read", h.ref, spoken=spoken,
                         data={"filmId": film_id, "study": r.study, "outcome": "agree" if r.agrees else "discrepancy",
                               "missed": [{k: f[k] for k in ("id", "label", "critical")} for f in r.missed],
                               "diagnosisAgrees": r.diagnosis_agrees, "diagnosis": r.diagnosis, "calling": bool(r.to_call)})
        if r.to_call:
            await self._call(turn, h.ref, [f["label"] for f in r.to_call[:3]], r.study)

    async def _call(self, turn: Turn, ref: str, labels: list[str], study: str, again: bool = False) -> None:
        """A missed critical finding goes to the nurse by name, and stays open until she reads it back."""
        v = "; ".join(labels)
        self.file_pending(Pending(room_id=turn.room_id, ref=ref, action="critical_finding", expect=NURSE, requester=turn.sender_id,
                                  lang=turn.lang, enc=turn.enc, tools=turn.tools,
                                  state={"labels": labels, "study": study, "again": again}), READ_BACK_WAIT_S)
        await turn.reply(f"CRITICAL FINDING on {study}: {v}. Please tell the treating team now and read it back to me.", "note", "critical_finding", ref,
                         spoken=phrases.say("cf_note", turn.lang, v=phrases.speakable(labels[0], 110)),
                         data={"findings": labels, "study": study, "calledAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "again": again})

    async def read_back(self, turn: Turn, h: Handoff) -> None:
        p = self._pending.get((turn.room_id, h.ref, "critical_finding"))
        if p is None:
            await turn.no_reply("no critical finding is open")
            return
        if not secondread.read_back_ok(p.state["labels"], str(h.data.get("readBack") or "")):
            turn.thought("The read-back does not match")
            self.take_pending(turn.room_id, h.ref, "critical_finding")
            if p.state.get("again"):
                await turn.no_reply("read-back did not match")
                return
            turn.sender_id = p.requester
            await self._call(turn, h.ref, p.state["labels"], p.state["study"], again=True)
            return
        self.take_pending(turn.room_id, h.ref, "critical_finding")
        turn.tool_done("Read-back matches, critical finding communicated")
        await turn.reply("Read-back correct. Critical finding communicated.", "ack", "critical_finding", h.ref,
                         data={"status": "closed", "closedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")})

    # ── results ──────────────────────────────────────────────────────────────
    async def defer(self, turn: Turn, st: dict[str, Any], tests: list[str], why: str) -> None:
        """The unsafe studies are not done; anything else in the order still is."""
        st["deferred"] = list(tests)
        st["why"] = why
        turn.tool_done(f"Deferred: {why}", False)
        await self.report(turn, st)

    async def report(self, turn: Turn, st: dict[str, Any]) -> None:
        deferred: list[str] = st.get("deferred") or []
        todo = [t for t in st["known"] if t not in deferred]
        names, unknown = st["names"], list(st["unknown"])
        case = await self.records.case(st["caseId"]) if todo else None
        if todo and case is None:
            unknown, todo = todo + unknown, []
        results: list[dict[str, Any]] = []
        if todo:
            turn.tool("acquire_images", "Acquiring images", tests=todo)
            wait = turnaround_s(len(todo))
            if wait:
                await asyncio.sleep(wait)
            for tid in todo:
                text, abnormal = self.records.report(case[2], tid)
                urgent = abnormal and analytes.positive(text, URGENT.pattern)
                results.append({"testId": tid, "name": names[tid], "result": text, "abnormal": abnormal, "critical": urgent})
                self.issued(turn.room)[tid] = results[-1]
            turn.tool_done(f"{len(results)} study(ies) reported")
        ranked = sorted(results, key=lambda r: (not r["critical"], not r["abnormal"]))
        impression = "; ".join(phrases.speakable(r["result"], 220) for r in ranked[:3])
        if st["notes"]:
            impression = f"{impression}. {' '.join(st['notes'])}".strip(". ") + "."
        data: dict[str, Any] = {"results": results, "unknown": unknown, "impression": impression[:700]}
        text = human_line(results, [names[u] for u in unknown])
        if st["notes"]:
            text += " " + " ".join(st["notes"])
        spoken = spoken_results(results, [phrases.short_test(names[u]) for u in unknown], turn.lang, "img_critical") if results or unknown else ""
        if deferred:
            data["deferred"] = deferred
            data["unknown"] = unknown + [t for t in deferred if t not in unknown]
            data["deferredReason"] = st.get("why", "")
            line = phrases.say("img_deferred", turn.lang, t=self._label(st, deferred, turn.lang))
            # Never more than two sentences: the deferral is the one that has to be heard.
            spoken = f"{re.split(r'(?<=[.!?।])\s+', spoken)[0]} {re.split(r'(?<=[.।])\s+', line)[0]}".strip() if results else line
            text = (text + " " if results else "") + f"Deferred, not done: {self._label(st, deferred, 'en')} ({st.get('why', '')})."
        await turn.reply(text, "result", "run_imaging", st["ref"], spoken=spoken, data=data, to=st["requester"])

    # ── questions ────────────────────────────────────────────────────────────
    async def _answer_text(self, room: Room, question: str, lang: str) -> str:
        issued = list(self.issued(room).values())
        if not issued:
            return phrases.say("lab_ask_none", lang)
        out = await llm_answer(SYSTEM, {"issuedReports": [
            {"study": r.get("name"), "report": str(r.get("result"))[:600], "abnormal": r.get("abnormal"), "urgent": r.get("critical")}
            for r in issued[-8:]]}, question, lang, female=False)
        return out or spoken_results(issued[-3:], [], lang, "img_critical")

    async def answer(self, turn: Turn, h: Handoff) -> None:
        text = two_sentences(await self._answer_text(turn.room, str(h.data.get("question") or ""), turn.lang))
        await turn.reply(text, "answer", "ask", h.ref, spoken=text, data={"text": text})

    async def on_human(self, turn: Turn, text: str) -> None:
        if not text:
            await turn.no_reply("empty message")
            return
        await turn.send(await self._answer_text(turn.room, text, text_lang(text)), None, turn.sender_id)
