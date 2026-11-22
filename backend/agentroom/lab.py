"""Lab Officer Dev: the laboratory and bedside studies.

He owns the laboratory's slice of data/lis.json and nothing else: no drugs, no
allergies, no imaging. Values leave exactly as stored. Critical flags come from the
fixed table in analytes.py.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

from . import analytes
from . import dept_phrases as phrases
from .base import LAB, PHARMACIST, DepartmentAdapter, Records, Room, Turn, llm_answer, text_lang, two_sentences
from .protocol import Handoff

# Tests that carry renal function, best first.
RENAL_TESTS = ("bmp",)

SYSTEM = (
    "You are Dev, the laboratory officer of a teaching hospital in India, answering a doctor at the bedside in a "
    "SYNTHETIC training simulator. <record> holds only the results you have issued in this encounter. "
    "Read out or explain those results. Do not diagnose, do not advise treatment, do not discuss any test that is not in the record."
)


def turnaround_s(count: int) -> float:
    """Seconds the analysers take: LAB_TURNAROUND_S when set, otherwise 2 to 5 with the size of the order."""
    raw = os.environ.get("LAB_TURNAROUND_S", "").strip()
    try:
        return max(0.0, min(20.0, float(raw))) if raw else min(5.0, 1.5 + 0.5 * max(1, count))
    except ValueError:
        return 2.0


def spoken_results(results: list[dict[str, Any]], unknown: list[str], lang: str, critical_key: str = "res_critical") -> str:
    """At most two sentences: the worst result with its value, then the rest by name."""
    def names(rows: list[dict[str, Any]]) -> str:
        return phrases.join([phrases.short_test(r["name"]) for r in rows[:4]], lang)

    crit = [r for r in results if r["critical"]]
    abn = [r for r in results if r["abnormal"] and not r["critical"]]
    normal = [r for r in results if not r["abnormal"]]
    if crit:
        first = phrases.say(critical_key, lang, t=phrases.short_test(crit[0]["name"]), v=phrases.speakable(crit[0]["result"], 110))
        rest = crit[1:] + abn
    elif abn:
        first = phrases.say("res_abnormal", lang, t=phrases.short_test(abn[0]["name"]), v=phrases.speakable(abn[0]["result"], 110))
        rest = abn[1:]
    elif normal:
        first, rest, normal = phrases.say("res_normal", lang, t=names(normal)), [], []
    else:
        return phrases.say("res_unknown", lang, t=phrases.join(unknown[:3], lang)) if unknown else ""
    if rest:
        return f"{first} {phrases.say('res_rest_abnormal', lang, t=names(rest))}"
    if normal:
        return f"{first} {phrases.say('res_rest_normal', lang, t=names(normal))}"
    if unknown:
        return f"{first} {phrases.say('res_unknown', lang, t=phrases.join(unknown[:2], lang))}"
    return first


def human_line(results: list[dict[str, Any]], unknown: list[str]) -> str:
    parts = []
    for r in results:
        flag = " (CRITICAL)" if r["critical"] else " (abnormal)" if r["abnormal"] else ""
        parts.append(f"{r['name']}{flag}: {phrases.speakable(r['result'], 160)}")
    if unknown:
        parts.append("Not performed here: " + ", ".join(unknown))
    return "Results. " + ". ".join(parts) + "." if parts else "No results."


class LabAdapter(DepartmentAdapter):
    role = LAB
    handles = frozenset({("request", "run_test"), ("request", "ask"), ("query", "renal_function")})

    def __init__(self, owner: str = "", **kw: Any) -> None:
        super().__init__(owner, **kw)
        self._records: Optional[Records] = None

    @property
    def records(self) -> Records:
        if self._records is None:
            # Everything the bedside and the bench do, plus nothing from imaging.
            self._records = Records(("lab", "bedside"))
        return self._records

    def warm(self) -> None:
        self.records.names

    @staticmethod
    def issued(room: Room) -> dict[str, dict[str, Any]]:
        return room.data.setdefault("issued", {})

    async def restore(self, room: Room, h: Handoff) -> None:
        if h.kind == "result" and h.action == "run_test":
            for r in h.data.get("results") or []:
                if isinstance(r, dict) and r.get("testId"):
                    self.issued(room)[str(r["testId"])] = r

    async def handle(self, turn: Turn, h: Handoff) -> None:
        if h.action == "run_test":
            await self.run(turn, h)
        elif h.action == "renal_function":
            await self.renal(turn, h)
        else:
            await self.answer(turn, h)

    async def run(self, turn: Turn, h: Handoff) -> None:
        known, unknown, names = self.records.wanted(h.data.get("tests"))
        case_id = str(h.data.get("caseId") or "")[:80]
        case = await self.records.case(case_id)
        if case is None:
            # No sample is registered for this patient: report nothing rather than someone's normal values.
            unknown, known = known + unknown, []
        results: list[dict[str, Any]] = []
        if known:
            turn.tool("receive_sample", "Sample received", tests=known)
            wait = turnaround_s(len(known))
            for tid in known[:4]:
                turn.thought(f"Analyser: {phrases.short_test(names[tid])}")
            if wait:
                await asyncio.sleep(wait)
            for tid in known:
                text, abnormal = self.records.report(case[2], tid)
                reasons = analytes.critical_reasons(tid, text, abnormal, case[0])
                results.append({"testId": tid, "name": names[tid], "result": text, "abnormal": abnormal, "critical": bool(reasons)})
                self.issued(turn.room)[tid] = results[-1]
            crit = [r for r in results if r["critical"]]
            turn.tool_done(f"{len(results)} result(s) validated" + (f", {len(crit)} critical" if crit else ""))
        else:
            crit = []
            turn.thought("No test in this order can be run by the laboratory")
        await turn.reply(human_line(results, [names[u] for u in unknown]), "result", "run_test", h.ref,
                         spoken=spoken_results(results, [phrases.short_test(names[u]) for u in unknown], turn.lang),
                         data={"results": results, "unknown": unknown})
        if crit:
            await self._warn_pharmacy(turn, h, case_id, crit)

    async def _warn_pharmacy(self, turn: Turn, h: Handoff, case_id: str, crit: list[dict[str, Any]]) -> None:
        """A critical value can make a released drug unsafe. Only if the pharmacist is already here."""
        pid = await turn.participant(PHARMACIST)
        if not pid:
            return
        rows = [{k: r[k] for k in ("testId", "name", "result", "abnormal", "critical")} for r in crit]
        await turn.reply("Critical result on this case, please check the drugs you have released.", "note", "critical_value", h.ref,
                         data={"caseId": case_id, "results": rows}, to=pid)

    async def renal(self, turn: Turn, h: Handoff) -> None:
        case_id = str(h.data.get("caseId") or "")[:80]
        turn.tool("search_record", "Searching the record for kidney function")
        case = await self.records.case(case_id)
        data: dict[str, Any] = {"available": False, "text": "No kidney function result is on record for this case."}
        if case is not None:
            for tid in RENAL_TESTS:
                own = case[2].get(tid)
                if own and own[0]:
                    data = analytes.renal_summary(own[0], case[0], case[1])
                    break
        turn.tool_done("Kidney function found" if data["available"] else "No kidney function on record", bool(data["available"]))
        await turn.reply(data["text"], "answer", "renal_function", h.ref, data=data)

    # ── questions ────────────────────────────────────────────────────────────
    async def _answer_text(self, room: Room, question: str, lang: str, held: Any = None) -> str:
        issued = list(self.issued(room).values()) or [r for r in (held if isinstance(held, list) else []) if isinstance(r, dict)][-10:]
        if not issued:
            return phrases.say("lab_ask_none", lang)
        out = await llm_answer(SYSTEM, {"issuedResults": [
            {"test": r.get("name"), "result": str(r.get("result"))[:500], "abnormal": r.get("abnormal"), "critical": r.get("critical")}
            for r in issued[-10:]]}, question, lang, female=False)
        if out:
            return out
        low = question.lower()
        named = [r for r in issued if any(w in low for w in (str(r.get("testId")).lower(), phrases.short_test(str(r.get("name"))).lower()))]
        return spoken_results(named or issued[-3:], [], lang)

    async def answer(self, turn: Turn, h: Handoff) -> None:
        ctx = h.data.get("context") if isinstance(h.data.get("context"), dict) else {}
        text = two_sentences(await self._answer_text(turn.room, str(h.data.get("question") or ""), turn.lang, ctx.get("results")))
        await turn.reply(text, "answer", "ask", h.ref, spoken=text, data={"text": text})

    async def on_human(self, turn: Turn, text: str) -> None:
        if not text:
            await turn.no_reply("empty message")
            return
        await turn.send(await self._answer_text(turn.room, text, text_lang(text)), None, turn.sender_id)

    async def on_failure(self, turn: Turn, h: Handoff, reason: str) -> None:
        if h.action == "renal_function":
            await turn.reply("The record could not be searched.", "answer", "renal_function", h.ref,
                             data={"available": False, "text": "The record could not be searched."})
            return
        await super().on_failure(turn, h, reason)
