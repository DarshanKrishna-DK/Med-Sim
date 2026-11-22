"""Examiner Kulkarni: scores how the doctor worked with the team, never who the patient was.

The numbers are arithmetic on the encounter's own counts. A model may word the
strengths and improvements, nothing else. The score stays a draft until a human
faculty member signs it off, revises it or sends it back, in the BAND room, in words.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any, Optional

from . import dept_phrases as phrases
from .base import EXAMINER, FACULTY, NURSE, UNTRUSTED, DepartmentAdapter, Room, Turn, _get, llm_answer, llm_text, text_lang, two_sentences
from .protocol import Handoff

log = logging.getLogger("medsim.room.examiner")

LLM_TIMEOUT_S = 8.0

# ───────────────────────── arithmetic ─────────────────────────

# canonical count -> other names it may arrive under
COUNT_NAMES: dict[str, tuple[str, ...]] = {
    "delegations": ("delegations", "requests"),
    "closed": ("closed", "completed"),
    "timedOut": ("timeouts", "timedOut"),
    "failed": ("failed",),
    "open": ("openAtClose",),
    "departments": ("byDepartment", "departments"),
    "asks": ("directQuestions", "asks"),
    "holds": ("holds",),
    "recalls": ("recalls",),
    "heldAtClose": ("heldAtClose",),
    "holdsIgnored": ("heldDrugReordered", "holdsIgnored"),
    "substituted": ("suggestionsTaken",),
    "overrideRequests": ("overridesRequested",),
    "overridden": ("overridesApproved", "overridden"),
    "overrideDenied": ("overridesDenied",),
    "criticals": ("criticalResults", "criticals"),
    "criticalsActed": ("criticalAcknowledged", "criticalsActed"),
    "questions": ("safetyQuestions", "questions"),
    "questionsAnswered": ("safetyAnswered", "questionsAnswered"),
    "facultyInvited": ("facultyInvited",),
    "toFaculty": ("doctorToFaculty",),
}

# Fallback when a count was not sent: read it off the timeline.
TIMELINE: dict[str, str] = {
    "holds": r"\bhold\b|\bheld\b", "recalls": r"\brecall", "criticals": r"\bcritical", "timedOut": r"time(?:d)?\s?-?out|no reply",
    "asks": r"\bask(?:ed|s)?\b", "facultyInvited": r"faculty (?:was )?(?:invited|joined)|invited? faculty",
}


def read_counts(data: dict[str, Any]) -> dict[str, float]:
    raw = data.get("counts") if isinstance(data.get("counts"), dict) else {}
    out: dict[str, float] = {}
    for key, names in COUNT_NAMES.items():
        for n in names:
            v = raw.get(n)
            if isinstance(v, bool):
                out[key] = 1.0 if v else 0.0
            elif isinstance(v, (int, float)):
                out[key] = max(0.0, float(v))
            elif isinstance(v, (list, dict)):
                out[key] = float(len(v))
            else:
                continue
            break
    rows = data.get("timeline") if isinstance(data.get("timeline"), list) else []
    for key, pattern in TIMELINE.items():
        if key not in out:
            out[key] = float(sum(1 for r in rows if isinstance(r, dict) and re.search(pattern, str(r.get("what") or ""), re.I)))
    if "departments" not in out:
        whos = " ".join(str(r.get("who") or "").lower() for r in rows if isinstance(r, dict))
        out["departments"] = float(sum(1 for d in ("pharmacist", "lab", "radiology") if d in whos))
    return out


def _ratio(part: float, whole: float) -> float:
    return min(1.0, part / whole) if whole > 0 else 0.0


def score_domains(c: dict[str, float]) -> tuple[list[dict[str, Any]], list[str]]:
    """(scored domains, names of the domains this encounter gave no chance to show)."""
    g = lambda k: c.get(k, 0.0)  # noqa: E731
    rows: list[tuple[str, Optional[float], str]] = []

    total = g("delegations")
    closed = c.get("closed", max(0.0, total - g("timedOut") - g("failed") - g("open")))
    if total > 0 or g("questions") > 0:
        parts = []
        note = []
        if total > 0:
            parts.append(_ratio(closed, total))
            note.append(f"{int(min(closed, total))} of {int(total)} requests were followed through to an answer")
        if g("questions") > 0:
            parts.append(_ratio(g("questionsAnswered"), g("questions")))
            note.append(f"{int(min(g('questionsAnswered'), g('questions')))} of {int(g('questions'))} safety questions were answered")
        rows.append(("Closed-loop communication", sum(parts) / len(parts), "; ".join(note)))
    else:
        rows.append(("Closed-loop communication", None, ""))

    depts = g("departments")
    used = 0.0 if total == 0 and depts == 0 and g("asks") == 0 else {0: 0.4, 1: 0.65, 2: 0.85}.get(int(depts), 1.0)
    if g("asks") > 0 and used:
        used = min(1.0, used + 0.15)
    rows.append(("Use of the team", used, f"{int(depts)} department(s) involved, {int(g('asks'))} direct question(s)"))

    holds = g("holds") + g("recalls")
    if holds > 0:
        # Settled: no longer held at the end, changed to the pharmacist's option, or decided by faculty.
        settled = min(holds, max(0.0, holds - g("heldAtClose")) + g("substituted") + g("overrideDenied"))
        asked = min(holds - settled, g("overrideRequests"))
        s = (settled + 0.8 * asked + 0.5 * (holds - settled - asked)) / holds - 0.25 * g("holdsIgnored")
        rows.append(("Safety response to holds", max(0.0, min(1.0, s)),
                     f"{int(holds)} hold(s) or recall(s), {int(settled)} settled safely" +
                     (f", {int(g('holdsIgnored'))} ignored" if g("holdsIgnored") else "")))
    else:
        rows.append(("Safety response to holds", None, ""))

    if g("criticals") > 0:
        acted = min(g("criticals"), g("criticalsActed"))
        rows.append(("Acting on critical results", _ratio(acted, g("criticals")), f"{int(acted)} of {int(g('criticals'))} critical result(s) acted on"))
    else:
        rows.append(("Acting on critical results", None, ""))

    need = holds + g("criticals") + g("timedOut")
    if need > 0 or g("facultyInvited") > 0:
        up = 1.0 if g("facultyInvited") > 0 or g("overrideRequests") > 0 or g("toFaculty") > 0 else \
            0.7 if g("criticals") > 0 and g("criticalsActed") >= g("criticals") else 0.4
        rows.append(("Escalation", up, "senior help was asked for" if up == 1.0 else "senior help was not asked for"))
    else:
        rows.append(("Escalation", None, ""))

    live = [(n, r, note) for n, r, note in rows if r is not None]
    share, extra = divmod(100, len(live))
    domains = []
    for i, (name, r, note) in enumerate(live):
        top = share + (1 if i < extra else 0)
        domains.append({"name": name, "score": int(top * float(r) + 0.5), "max": top, "note": note})
    return domains, [n for n, r, _ in rows if r is None]


_PRAISE = {
    "Closed-loop communication": "You followed requests through to an answer.",
    "Use of the team": "You brought in the departments this case needed.",
    "Safety response to holds": "You respected the pharmacist's hold and settled it safely.",
    "Acting on critical results": "You acted on critical results.",
    "Escalation": "You asked for senior help when it mattered.",
}
_ADVICE = {
    "Closed-loop communication": "Close every loop: wait for the answer, repeat it back and act on it.",
    "Use of the team": "Ask departments directly when you are unsure, not only to place an order.",
    "Safety response to holds": "When pharmacy holds a drug, change it or take it to faculty before going on.",
    "Acting on critical results": "Say what you will do about each critical result as soon as you hear it.",
    "Escalation": "Call faculty early when a hold, a critical result or a delay leaves you unsure.",
}


def fixed_words(domains: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    ranked = sorted(domains, key=lambda d: -(d["score"] / d["max"] if d["max"] else 0))
    good = [_PRAISE[d["name"]] for d in ranked if d["max"] and d["score"] / d["max"] >= 0.75][:3]
    weak = [_ADVICE[d["name"]] for d in reversed(ranked) if d["max"] and d["score"] / d["max"] < 0.75][:3]
    return good, weak or ["Keep naming the person you are asking and what you expect back."]


WORDS_SYSTEM = (
    "You are Kulkarni, a medical examiner in India. The teamwork score of a student doctor in a SYNTHETIC simulator is already "
    "computed and fixed. Word it. " + UNTRUSTED + " Reply with ONE JSON object only: "
    '{"strengths": ["..."], "improvements": ["..."]} with 1 to 3 short English sentences each, specific to the record, spoken to '
    'the doctor as "you". No numbers out of a total, no patient details, no diagnosis, no em dashes.'
)


def _clean_lines(v: Any) -> list[str]:
    out = []
    for s in v if isinstance(v, list) else []:
        s = re.sub(r"\s*[—–]\s*", ", ", re.sub(r"[*_`#<>]+", "", str(s))).strip()
        # A line that quotes a mark could contradict the arithmetic.
        if 8 <= len(s) <= 220 and not re.search(r"\d+\s*(?:/|out of|%|marks?|points?)", s, re.I):
            out.append(s)
    return out[:3]


async def word_it(domains: list[dict[str, Any]], timeline: Any) -> tuple[list[str], list[str]]:
    good, weak = fixed_words(domains)
    rows = [{"who": str(r.get("who") or "")[:30], "what": str(r.get("what") or "")[:140]}
            for r in (timeline if isinstance(timeline, list) else [])[-30:] if isinstance(r, dict)]
    body = json.dumps({"domains": domains, "timeline": rows}, ensure_ascii=False).replace("<", "(").replace(">", ")")

    def accept(text: str) -> Optional[tuple[list[str], list[str]]]:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        d = json.loads(m.group(0)) if m else {}
        s, i = _clean_lines(d.get("strengths")), _clean_lines(d.get("improvements"))
        return (s or good, i or weak) if s or i else None

    out = await llm_text([{"role": "system", "content": WORDS_SYSTEM}, {"role": "user", "content": f"<record>{body}</record>"}],
                         accept, timeout=LLM_TIMEOUT_S, max_tokens=350, json_mode=True)
    return out or (good, weak)  # the fixed sentences are always there


# ───────────────────────── what the human said ─────────────────────────

_SIGN = re.compile(
    r"\bsign(?:ed|ing)?[\s-]*(?:it\s+|this\s+|the score\s+)?off\b|\bsign ?off\b|\bapproved?\b|\baccept(?:ed)?\b|\bconfirm(?:ed)?\b|\bfinali[sz]ed?\b"
    r"|\bmanzoo?r\b|\bmanjoor\b|\banumodan\b|\boppige\b|\bsammata\b"
    r"|मंज़ूर|मंजूर|स्वीकृत|स्वीकार है|अनुमोद|साइन ऑफ|मान्य|ಒಪ್ಪಿಗೆ|ಒಪ್ಪಿದ್ದೇನೆ|ಅನುಮೋದ|ಸೈನ್ ಆಫ್|ஒப்புதல்|ஒப்புக்கொள்|அங்கீகர|சைன் ஆஃப்"
    r"|ఆమోద|అంగీకరి|సైన్ ఆఫ్|অনুমোদন|মঞ্জুর|সাইন অফ", re.I)
_BACK = re.compile(
    r"\b(?:send|sent|sending|return|give) (?:it |this |the score )?back\b|\breturn (?:it|this|the score)\b|\bredo\b|\bre-?(?:assess|score|grade|do|consider)\b"
    r"|\breject(?:ed)?\b|\bdisagree\b|\breview (?:it )?again\b|\blook (?:at it )?again\b|\bwapas\b|\bvapas\b"
    r"|वापस|दोबारा देख|फिर से देख|अस्वीक|ಹಿಂದಿರುಗಿಸ|ವಾಪಸ್|ಮರುಪರಿಶೀಲ|ತಿರಸ್ಕರ|திருப்பி|மறுபரிசீல|நிராகர|తిరిగి పంప|పునఃపరిశీల|తిరస్కర"
    r"|परत पाठव|पुन्हा तपास|पुन्हा बघ|नामंजूर|नाकार|ফেরত|আবার দেখ|পুনর্বিবেচ|প্রত্যাখ্যান", re.I)
_NEG = re.compile(
    r"\b(?:no|not|never|don'?t|do not|won'?t|will not|cannot|can'?t|shouldn'?t|nahi|nahin|mat|beda|illa|vendam|illai|vaddu|ledu|nako|naka)\b|n't\b"
    r"|नहीं|नही|मत|नाही|नको|नका|ಇಲ್ಲ|ಬೇಡ|இல்லை|வேண்டாம்|முடியாது|లేదు|వద్దు|కాదు|না(?![ঀ-৿])|নেই|নয়", re.I)
_DOUBT = re.compile(
    r"\b(?:if|unless|maybe|perhaps|probably|not sure|unsure|might|could|should i|let me|later|wait|think(?:ing)? about|before i|once|until|after i)\b"
    r"|\bagar\b|\bshayad\b|अगर|यदि|शायद|बाद में|ಬಹುಶಃ|ಆಮೇಲೆ|ಒಂದು ವೇಳೆ|ஒருவேளை|பிறகு|బహుశా|తర్వాత|कदाचित|नंतर|जर |হয়তো|যদি|পরে", re.I)
_CHANGE = re.compile(
    r"\b(?:make|change|set|revise|revised|reduce|lower|raise|increase|bring|put|give|mark|award|should be|must be|score|update|adjust|kar do|kar dijiye|karo|maadi|madi|aakku|maatru|cheyandi|kara|korun)\b"
    r"|कर दो|कर दीजिए|करें|कीजिए|दीजिए|बदल|ಮಾಡಿ|ಕೊಡಿ|ಬದಲಿಸ|ஆக்கு|மாற்று|கொடு|చేయండి|మార్చ|ఇవ్వండి|करा|द्या|करून|করুন|করে দিন|দিন|বদল", re.I)
_REASON = re.compile(
    r"\b(?:because|since|as (?:the|he|she|they)|due to|kyunki|kyonki|reason)\b|क्योंकि|कारण|ಏಕೆಂದರೆ|ಯಾಕೆಂದರೆ|ಕಾರಣ|ஏனென்றால்|ஏனெனில்|ஏன்னா|ఎందుకంటే|कारण|কারণ", re.I)
_QUESTION = re.compile(r"\?|^\W*(?:what|why|how|which|when|who|where|is|are|did|does|should|can|could)\b|क्या |क्यों|ಯಾಕೆ|ಏನು|ஏன் |என்ன|ఎందుకు (?!అంటే)|ఏమిటి|काय |का\?|কেন|কী ", re.I)


def _digits(text: str) -> str:
    out = []
    for ch in text:
        try:
            out.append(str(unicodedata.digit(ch)) if not ch.isascii() and ch.isdigit() else ch)
        except ValueError:
            out.append(ch)
    return "".join(out)


def parse_faculty(text: str) -> tuple[str, Optional[int], str]:
    """('signoff' | 'revise' | 'back' | 'question' | 'unclear', mark, comment).

    Anything hedged, conditional, mixed or merely polite is 'unclear': only a plain
    approval signs a score off, and only a plain instruction with one mark revises it.
    """
    t = re.sub(r"\s+", " ", _digits(text or "")).strip()
    if not t:
        return "unclear", None, ""
    m = _REASON.search(t)
    head, reason = (t[: m.start()], t[m.end():].strip(" :,.-")) if m else (t, "")
    head = head or t
    if _QUESTION.search(head):
        return "question", None, t
    if _DOUBT.search(head):
        return "unclear", None, t
    h = re.sub(r"(?:/|\bout of\b|\bof\b)\s*100\b|100\s*(?:में से|ರಲ್ಲಿ|க்கு|కి|पैकी|এর মধ্যে)", " ", head, flags=re.I)
    h = re.sub(r"\b(?:not|instead of|rather than|from)\s+\d{1,3}\b", " ", h, flags=re.I)
    relative = re.search(r"\bby \d|\d+\s*(?:marks?|points?)\s*(?:more|less|up|down|lower|higher)", h, re.I)
    marks = {int(x) for x in re.findall(r"(?<![\d.])\d{1,3}(?![\d.]*\d)", h)}
    sign, back, neg = _SIGN.search(h), _BACK.search(h), _NEG.search(h)
    if marks:
        mark = next(iter(marks))
        if len(marks) == 1 and 0 <= mark <= 100 and not relative and not neg and not back and (_CHANGE.search(h) or sign):
            return "revise", mark, reason or t
        return "unclear", None, t
    if back or (sign and neg):
        return "back", None, reason or t
    if sign:
        # "Approved, but ..." carries a condition this parser cannot honour.
        if re.search(r"\b(?:but|except|however|only)\b|लेकिन|ಆದರೆ|ஆனால்|కానీ|पण |কিন্তু", t, re.I):
            return "unclear", None, t
        return "signoff", None, reason
    return "unclear", None, t


ASK_FACULTY = (
    "Teamwork score for your sign-off: {total} out of 100 (draft).\n{lines}\n"
    "Please mention me and reply \"sign off\", or \"make it 70 because ...\", or \"send back\". Nothing is final until you do."
)

SYSTEM = (
    "You are Kulkarni, an examiner of a teaching hospital in India, explaining a teamwork score in a SYNTHETIC training "
    "simulator. <record> holds the score; it was computed and you cannot change it. You know nothing about the patient."
)


class ExaminerAdapter(DepartmentAdapter):
    role = EXAMINER
    handles = frozenset({("request", "score_teamwork"), ("request", "ask")})

    @staticmethod
    def state(room: Room) -> dict[str, Any]:
        return room.data.setdefault("score", {})

    async def restore(self, room: Room, h: Handoff) -> None:
        if h.kind == "score" and isinstance(h.data.get("domains"), list):
            self.state(room).update(ref=h.ref, score=dict(h.data), facultyId="", lang=phrases.norm(h.lang))
            room.enc, room.lang = h.enc or room.enc, phrases.norm(h.lang)

    async def handle(self, turn: Turn, h: Handoff) -> None:
        if h.action == "ask":
            text = two_sentences(await self._answer_text(turn.room, str(h.data.get("question") or ""), turn.lang))
            await turn.reply(text, "answer", "ask", h.ref, spoken=text, data={"text": text})
            return
        turn.tool("count_teamwork", "Counting requests, holds, critical results and answers")
        counts = read_counts(h.data)
        domains, skipped = score_domains(counts)
        total = sum(d["score"] for d in domains)
        turn.tool_done(f"Draft score {total} out of 100")
        strengths, improvements = await word_it(domains, h.data.get("timeline"))
        faculty_id = str(h.data.get("facultyId") or "")[:64] if h.data.get("facultyInRoom") else ""
        if h.data.get("facultyInRoom") and not faculty_id:
            faculty_id = await turn.participant(FACULTY) or ""
        score: dict[str, Any] = {"status": "draft", "total": total, "domains": domains, "strengths": strengths, "improvements": improvements}
        if skipped:
            score["notAssessed"] = skipped
        if faculty_id:
            lines = "\n".join(f"- {d['name']}: {d['score']} of {d['max']} ({d['note']})" for d in domains)
            try:
                await turn.send(ASK_FACULTY.format(total=total, lines=lines), None, faculty_id)
                score["status"] = "awaiting_signoff"
            except Exception as e:  # noqa: BLE001 - the score still goes to the nurse as a draft
                log.info("faculty could not be asked: %s", type(e).__name__)
        self.state(turn.room).update(ref=h.ref, score=score, facultyId=faculty_id, lang=turn.lang)
        key = "score_await" if score["status"] == "awaiting_signoff" else "score_draft"
        await turn.reply(f"Teamwork score {total} out of 100 ({score['status'].replace('_', ' ')}).", "score", "score_teamwork", h.ref,
                         spoken=phrases.say(key, turn.lang, n=total), data=score, to=turn.sender_id)

    # ── the faculty member ───────────────────────────────────────────────────
    async def on_human(self, turn: Turn, text: str) -> None:
        st = self.state(turn.room)
        score = st.get("score")
        lang = text_lang(text)
        if not score:
            await turn.send(phrases.say("exam_ask_none", lang), None, turn.sender_id)
            return
        if st.get("facultyId") and turn.sender_id != st["facultyId"]:
            await turn.send("Only the faculty member who was asked can sign this score off.", None, turn.sender_id)
            return
        intent, mark, comment = parse_faculty(text)
        if intent == "question":
            out = await llm_answer(SYSTEM, score, text, lang, female=False)
            await turn.send((out or "; ".join(f"{d['name']} {d['score']} of {d['max']}" for d in score["domains"])) +
                            " The score is not signed off yet.", None, turn.sender_id)
            return
        if intent == "unclear":
            await turn.send("I have not signed anything off. Please reply \"sign off\", \"make it 70 because ...\" or \"send back\".",
                            None, turn.sender_id)
            return
        by = await self._name(turn)
        new = dict(score)
        if intent == "signoff":
            new.update(status="signed_off", signedBy=by)
            key = "score_signed"
        elif intent == "revise":
            new.update(status="revised", total=mark, signedBy=by)
            key = "score_revised"
        else:
            new.update(status="draft")
            new.pop("signedBy", None)
            key = "score_back"
        if comment:
            new["facultyComment"] = comment[:400]
        nurse = turn.room.nurse_id or await turn.participant(NURSE)
        if not nurse:
            await turn.send("Nurse Asha is not in the room, so I could not file this.", None, turn.sender_id)
            return
        st["score"] = new
        turn.lang = phrases.norm(st.get("lang") or turn.lang)
        turn.tool("record_signoff", "Recording the faculty decision")
        turn.tool_done(new["status"])
        await turn.reply(f"Teamwork score {new['total']} out of 100: {new['status'].replace('_', ' ')} ({by}).", "score", "score_teamwork",
                         st["ref"], spoken=phrases.say(key, turn.lang, by=by, n=new["total"]), data=new, to=nurse)

    async def _name(self, turn: Turn) -> str:
        if turn.sender_name:
            return turn.sender_name[:80]
        try:
            for p in await turn.tools.get_participants() or []:
                if str(_get(p, "id") or "") == turn.sender_id and _get(p, "name"):
                    return str(_get(p, "name"))[:80]
        except Exception as e:  # noqa: BLE001
            log.info("participants unavailable: %s", type(e).__name__)
        return "Faculty"

    async def _answer_text(self, room: Room, question: str, lang: str) -> str:
        score = self.state(room).get("score")
        if not score:
            return phrases.say("exam_ask_none", lang)
        out = await llm_answer(SYSTEM, score, question, lang, female=False)
        key = {"signed_off": "score_signed", "revised": "score_revised", "awaiting_signoff": "score_await"}.get(score["status"], "score_draft")
        return out or phrases.say(key, lang, n=score["total"], by=score.get("signedBy", ""))
