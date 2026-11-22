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

from . import academic_lines  # noqa: F401  (adds its frames)
from . import dept_phrases as phrases
from .base import EXAMINER, FACULTY, NURSE, UNTRUSTED, DepartmentAdapter, Pending, Room, Turn, _get, llm_answer, llm_text, text_lang, two_sentences
from .protocol import TEACHER, Handoff
from .scrub import for_teacher

log = logging.getLogger("medsim.room.examiner")

LLM_TIMEOUT_S = 8.0
PLAN_TIMEOUT_S = 45.0  # how long the teacher may take

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
    "facultyQuestions": ("facultyQuestions",),
    "facultyAnswered": ("facultyAnswered",),
    "overridesReasoned": ("overridesWithReason",),
    "overridesUnreasoned": ("overridesWithoutReason",),
    "hardReasoned": ("hardOverridesWithReason",),
    "retries": ("retries",),
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
    if total > 0 or g("questions") > 0 or g("facultyQuestions") > 0:
        parts = []
        note = []
        if total > 0:
            parts.append(_ratio(closed, total))
            note.append(f"{int(min(closed, total))} of {int(total)} requests were followed through to an answer")
        if g("questions") > 0:
            parts.append(_ratio(g("questionsAnswered"), g("questions")))
            note.append(f"{int(min(g('questionsAnswered'), g('questions')))} of {int(g('questions'))} safety questions were answered")
        if g("facultyQuestions") > 0:
            parts.append(_ratio(g("facultyAnswered"), g("facultyQuestions")))
            note.append(f"{int(min(g('facultyAnswered'), g('facultyQuestions')))} of {int(g('facultyQuestions'))} faculty questions were answered")
        rows.append(("Closed-loop communication", sum(parts) / len(parts), "; ".join(note)))
    else:
        rows.append(("Closed-loop communication", None, ""))

    depts = g("departments")
    used = 0.0 if total == 0 and depts == 0 and g("asks") == 0 else {0: 0.4, 1: 0.65, 2: 0.85}.get(int(depts), 1.0)
    if g("asks") > 0 and used:
        used = min(1.0, used + 0.15)
    rows.append(("Use of the team", used, f"{int(depts)} department(s) involved, {int(g('asks'))} direct question(s)"))

    holds = g("holds") + g("recalls")
    need_holds = holds
    # A hard allergy hold that the doctor took to faculty with a reason is neutral here: neither credit nor
    # penalty. (Ordering against a documented allergy is a clinical error, marked elsewhere.)
    neutral = min(holds, g("hardReasoned"))
    holds -= neutral
    if holds > 0 or g("holdsIgnored") > 0:
        holds = max(1.0, holds)
        # Settled: no longer held at the end, changed to the pharmacist's option, or decided by faculty.
        settled = min(holds, max(0.0, holds - max(0.0, g("heldAtClose") - neutral)) + g("substituted") + max(0.0, g("overrideDenied") - neutral))
        asked = min(holds - settled, max(0.0, g("overridesReasoned") - neutral) if "overridesReasoned" in c else g("overrideRequests"))
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

    need = need_holds - neutral + g("criticals") + g("timedOut")
    if need > 0 or g("facultyInvited") > 0:
        up = 1.0 if g("facultyInvited") > 0 or g("toFaculty") > 0 else \
            0.7 if g("overrideRequests") > 0 else \
            0.7 if g("criticals") > 0 and g("criticalsActed") >= g("criticals") else 0.4
        rows.append(("Escalation", up, "senior help was asked for" if up == 1.0 or g("overrideRequests") > 0 else "senior help was not asked for"))
    else:
        rows.append(("Escalation", None, ""))

    live = [(n, r, note) for n, r, note in rows if r is not None]
    share, extra = divmod(100, len(live))
    domains = []
    for i, (name, r, note) in enumerate(live):
        top = share + (1 if i < extra else 0)
        domains.append({"name": name, "score": int(top * float(r) + 0.5), "max": top, "note": note})
    return domains, [n for n, r, _ in rows if r is None]


# ───────────────────────── words, from facts only ─────────────────────────


def _n(count: float, one: str, many: str) -> str:
    return one if int(count) == 1 else many.format(n=int(count))


def select_facts(c: dict[str, float]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """(what went well, what to work on), each a sentence a count proves. No fact, no sentence."""
    g = lambda k: c.get(k, 0.0)  # noqa: E731
    good: list[tuple[str, str]] = []
    weak: list[tuple[str, str]] = []

    total, lost = g("delegations"), g("timedOut") + g("failed") + g("open")
    if total > 0 and lost == 0:
        good.append(("closed", _n(total, "You followed your request through to its answer.", "You followed all {n} requests through to an answer.")))
    if g("criticals") > 0 and g("criticalsActed") >= g("criticals"):
        good.append(("criticals", _n(g("criticals"), "You acted on the critical result.", "You acted on all {n} critical results.")))
    if g("questions") > 0 and g("questionsAnswered") >= g("questions"):
        good.append(("questions", _n(g("questions"), "You answered the department's safety question.", "You answered all {n} safety questions from the departments.")))
    if g("facultyQuestions") > 0 and g("facultyAnswered") >= g("facultyQuestions"):
        good.append(("faculty", _n(g("facultyQuestions"), "You answered faculty's question.", "You answered all {n} questions from faculty.")))
    if g("substituted") > 0:
        good.append(("substituted", "You took the pharmacist's alternative instead of the held drug."))
    if max(0.0, g("overridesReasoned") - g("hardReasoned")) > 0:
        good.append(("reasoned", "You gave a reason when you asked faculty to review a hold."))
    if g("asks") > 0:
        good.append(("asks", _n(g("asks"), "You asked a department directly when you needed an answer.", "You asked departments directly {n} times when you needed an answer.")))
    if g("departments") >= 2:
        good.append(("team", f"You brought {int(g('departments'))} departments into this case."))

    if g("criticals") > g("criticalsActed"):
        weak.append(("criticals", _n(g("criticals") - g("criticalsActed"), "One critical result had no action from you after it was read out.",
                                     "{n} critical results had no action from you after they were read out.")))
    if g("facultyQuestions") > g("facultyAnswered"):
        weak.append(("faculty", _n(g("facultyQuestions") - g("facultyAnswered"), "One question from faculty had no reply from you before you ended.",
                                   "{n} questions from faculty had no reply from you before you ended.")))
    if g("questions") > g("questionsAnswered"):
        weak.append(("questions", _n(g("questions") - g("questionsAnswered"), "One safety question from a department had no answer from you.",
                                     "{n} safety questions from the departments had no answer from you.")))
    if g("holdsIgnored") > 0:
        weak.append(("ignored", "You ordered a held drug again while the pharmacist's hold stood."))
    if g("overridesUnreasoned") > 0:
        weak.append(("unreasoned", "You asked faculty to override a hold without giving a reason."))
    left = max(0.0, g("heldAtClose") - g("overrideRequests"))
    if left > 0:
        weak.append(("held", _n(left, "One drug was still on hold when you ended, with no change and no word to faculty.",
                                "{n} drugs were still on hold when you ended, with no change and no word to faculty.")))
    if g("open") > 0:
        weak.append(("open", _n(g("open"), "One request was still waiting for an answer when you ended.", "{n} requests were still waiting for an answer when you ended.")))
    if g("timedOut") > g("retries"):
        weak.append(("timeouts", _n(g("timedOut") - g("retries"), "One request timed out and you did not send it again.",
                                    "{n} requests timed out and you did not send them again.")))
    rows = lambda xs: [{"id": i, "text": t} for i, t in xs[:3]]  # noqa: E731
    return rows(good), rows(weak)


_NEGATION = re.compile(r"\b(?:no|not|never|none|nothing|without|nor|neither|fail(?:ed|s|ing)?|miss(?:ed|ing)?|lack(?:ed|ing)?|unable|ignor(?:ed|ing)|"
                       r"un\w{4,}|cannot|only|but|however|although|despite|instead)\b|n't\b", re.I)
_NUMBER = re.compile(r"\d+|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|both|twice|once)\b", re.I)
# Words a rephrase may add without saying anything new.
_NEUTRAL = {
    "you", "your", "the", "and", "with", "from", "for", "that", "this", "each", "every", "when", "then", "well", "good", "clearly", "properly",
    "carefully", "also", "have", "had", "were", "was", "been", "before", "after", "during", "them", "they", "their", "which", "while", "made",
    "make", "sure", "gave", "case", "encounter", "done", "please", "next", "time", "until", "over", "into", "what", "where", "who",
}


def _stems(text: str) -> set[str]:
    return {w[:5] for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in _NEUTRAL}


def faithful(rephrased: str, fact: str) -> bool:
    """A rephrase says the fact and nothing else: same numbers, same negations, no new content word, nothing dropped."""
    numbers = lambda t: sorted(x.lower() for x in _NUMBER.findall(t))  # noqa: E731
    negations = lambda t: sorted(x.lower() for x in _NEGATION.findall(t))  # noqa: E731
    if not 8 <= len(rephrased) <= 220 or numbers(rephrased) != numbers(fact) or negations(rephrased) != negations(fact):
        return False
    said, asked = _stems(rephrased), _stems(fact)
    return said <= asked and len(asked - said) <= len(asked) // 3


WORDS_SYSTEM = (
    "You are Kulkarni, a medical examiner in India. <record> lists facts about how a student doctor worked with the team in a "
    "SYNTHETIC simulator. " + UNTRUSTED + ' Make each fact read naturally, spoken to the doctor as "you". Do not add, remove or '
    "explain anything: same meaning, same numbers, same words for who and what. Reply with ONE JSON object only, mapping each fact's "
    'id to its sentence: {"id": "sentence"}. No em dashes.'
)


async def word_it(good: list[dict[str, str]], weak: list[dict[str, str]]) -> tuple[list[str], list[str]]:
    """The facts as sentences. A model may rephrase one; anything that is not the same fact is thrown away."""
    facts = {**{f"w_{f['id']}": f["text"] for f in weak}, **{f"g_{f['id']}": f["text"] for f in good}}
    out: Optional[dict[str, str]] = None
    if facts:
        body = json.dumps(facts, ensure_ascii=False).replace("<", "(").replace(">", ")")

        def accept(text: str) -> Optional[dict[str, str]]:
            m = re.search(r"\{.*\}", text, re.DOTALL)
            d = json.loads(m.group(0)) if m else {}
            kept = {k: _clean_lines([d.get(k)]) for k in facts if isinstance(d.get(k), str)}
            kept = {k: v[0] for k, v in kept.items() if v and faithful(v[0], facts[k])}
            return kept or None

        out = await llm_text([{"role": "system", "content": WORDS_SYSTEM}, {"role": "user", "content": f"<record>{body}</record>"}],
                             accept, timeout=LLM_TIMEOUT_S, max_tokens=350, json_mode=True)
    said = {**facts, **(out or {})}
    return [said[f"g_{f['id']}"] for f in good], [said[f"w_{f['id']}"] for f in weak]


def _clean_lines(v: Any) -> list[str]:
    out = []
    for s in v if isinstance(v, list) else []:
        s = re.sub(r"\s*[—–]\s*", ", ", re.sub(r"[*_`#<>]+", "", str(s))).strip()
        # A line that quotes a mark could contradict the arithmetic.
        if 8 <= len(s) <= 220 and not re.search(r"\d+\s*(?:/|out of|%|marks?|points?)", s, re.I):
            out.append(s)
    return out[:3]


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

RESULT_SYSTEM = (
    "You are Kulkarni, an examiner of a teaching hospital in India, answering a faculty member about a student's result in a "
    "SYNTHETIC training simulator. <record> holds the marks; they were computed and you cannot change them. You do not know who "
    "the student or the patient is."
)

SYSTEM = (
    "You are Kulkarni, an examiner of a teaching hospital in India, explaining a teamwork score in a SYNTHETIC training "
    "simulator. <record> holds the score; it was computed and you cannot change it. You know nothing about the patient."
)


# ───────────────────────── results that a human signs (OSCE, viva, debrief) ─────────────────────────

WHAT = {"osce": "OSCE station", "viva": "Viva voce", "debrief": "Consultation"}
PASS_SHARE = 0.7  # a domain below this share of its marks is worth revising


def _plain(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[`<>]", " ", str(v or ""))).strip()[:n]


def read_result(data: dict[str, Any]) -> dict[str, Any]:
    """The result in fixed shapes. The total is the app's own arithmetic; the examiner never changes it."""
    def num(v: Any, lo: float, hi: float) -> int:
        try:
            return int(max(lo, min(hi, round(float(v)))))
        except (TypeError, ValueError):
            return int(lo)

    domains = []
    for d in data.get("domains") if isinstance(data.get("domains"), list) else []:
        if isinstance(d, dict) and d.get("name"):
            top = num(d.get("max"), 1, 1000)
            domains.append({"name": _plain(d["name"], 60), "score": num(d.get("score"), 0, top), "max": top, "note": _plain(d.get("note"), 200)})
    lines = lambda k: [_plain(x, 180) for x in (data.get(k) if isinstance(data.get(k), list) else [])[:4] if _plain(x, 180)]  # noqa: E731
    what = str(data.get("what") or "")
    return {
        "what": what if what in WHAT else "debrief", "total": num(data.get("total"), 0, 100), "domains": domains[:8],
        "strengths": lines("strengths"), "improvements": lines("improvements"), "clinic": _plain(data.get("clinic"), 40),
        "specialty": _plain(data.get("specialty"), 60), "about": _plain(data.get("about"), 80), "verified": data.get("verified") is True,
    }


def weak_domains(res: dict[str, Any], focus: str = "") -> list[dict[str, Any]]:
    rows = [{"name": d["name"], "pct": int(100 * d["score"] / d["max"] + 0.5)} for d in res["domains"]]
    rows.sort(key=lambda r: (r["name"] != focus, r["pct"]))
    weak = [r for r in rows if r["pct"] < 100 * PASS_SHARE or r["name"] == focus]
    return (weak or rows[:1])[:3]


def focus_of(res: dict[str, Any], comment: str) -> str:
    """The domain a faculty comment talks about. Only its name leaves the examiner, never the comment."""
    words = set(re.findall(r"[a-z]{4,}", (comment or "").lower()))
    best, hits = "", 0
    for d in res["domains"]:
        n = len(words & set(re.findall(r"[a-z]{4,}", d["name"].lower())))
        if n > hits:
            best, hits = d["name"], n
    return best


DRAFT_SYSTEM = (
    "You are Kulkarni, an examiner in an Indian medical college, writing the covering note of a student's result in a SYNTHETIC "
    "simulator for the faculty member who will sign it. The marks are computed and fixed. " + UNTRUSTED +
    ' Reply with ONE JSON object only: {"comment": "..."}: two short English sentences, what was strongest and what to look at '
    "before signing, under 30 words in total. A drug the pharmacist stopped was the pharmacist's catch, never the student's. No numbers, no marks, no names, no patient details, no em dashes."
)


def fixed_comment(res: dict[str, Any]) -> str:
    rows = sorted(res["domains"], key=lambda d: d["score"] / d["max"])
    if not rows:
        return "There is no domain breakdown for this result. Please look at it before signing."
    if len(rows) == 1 or rows[0]["score"] * rows[-1]["max"] == rows[-1]["score"] * rows[0]["max"]:
        return f"Marks are even across the domains. Please look at {rows[0]['name'].lower()} before signing."
    return f"Strongest: {rows[-1]['name'].lower()}. Weakest, and worth a look before signing: {rows[0]['name'].lower()}."


async def draft_comment(res: dict[str, Any]) -> str:
    body = json.dumps({k: res[k] for k in ("what", "domains", "strengths", "improvements")}, ensure_ascii=False).replace("<", "(").replace(">", ")")

    def accept(text: str) -> Optional[str]:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        d = json.loads(m.group(0)) if m else {}
        out = _clean_lines([two_sentences(str(d.get("comment") or ""), 219)])
        return out[0] if out else None

    out = await llm_text([{"role": "system", "content": DRAFT_SYSTEM}, {"role": "user", "content": f"<record>{body}</record>"}],
                         accept, timeout=LLM_TIMEOUT_S, max_tokens=220, json_mode=True)
    return out or fixed_comment(res)


ASK_SIGN = (
    "{what} result for your signature{about}: {total} out of 100 (draft{trust}).\n{lines}\n{comment}\n"
    "Please mention me and reply \"sign off\", or \"make it 70 because ...\", or \"send back, ...\". "
    "The student sees DRAFT until you do."
)


class ExaminerAdapter(DepartmentAdapter):
    role = EXAMINER
    handles = frozenset({("request", "score_teamwork"), ("request", "ask"), ("request", "sign_off")})

    # ── results that a human signs ───────────────────────────────────────────

    @staticmethod
    def result_state(room: Room) -> dict[str, Any]:
        return room.data.setdefault("result", {})

    async def _sign_off(self, turn: Turn, h: Handoff) -> None:
        st = self.result_state(turn.room)
        if st.get("ref") != h.ref:
            st.clear()
            turn.tool("draft_result", "Reading the marks")
            res = read_result(h.data)
            st.update(ref=h.ref, result=res, comment=await draft_comment(res), status="draft", plan="")
            turn.tool_done(f"Draft: {res['total']} out of 100")
        st.update(requester=turn.sender_id, lang=turn.lang)
        faculty_id = str(h.data.get("facultyId") or "")[:64]
        if faculty_id and st["status"] not in ("signed_off", "revised"):
            res = st["result"]
            lines = "\n".join(f"- {d['name']}: {d['score']} of {d['max']}" for d in res["domains"])
            note = _plain(h.data.get("note"), 300)
            text = ASK_SIGN.format(what=WHAT[res["what"]], about=f" ({res['specialty']})" if res["specialty"] else "", total=res["total"],
                                   trust="" if res["verified"] else ", marks reported by the student's browser, not verified",
                                   lines=lines, comment=st["comment"] + (f" The student adds: {note}" if note else ""))
            try:
                await turn.send(text, None, faculty_id)
                st.update(status="awaiting_signoff", facultyId=faculty_id)
            except Exception as e:  # noqa: BLE001 - it stays a draft
                log.info("faculty could not be asked: %s", type(e).__name__)
        await self._report(turn, st, turn.sender_id)
        if st["plan"] != "done" and (turn.room_id, f"{h.ref}p", "study_plan") not in self._pending:
            await self._ask_teacher(turn, st)

    async def _report(self, turn: Turn, st: dict[str, Any], to: str) -> None:
        res, status = st["result"], st["status"]
        key = {"signed_off": "res_signed", "revised": "res_revised", "sent_back": "res_back", "awaiting_signoff": "res_await"}.get(status, "res_draft")
        n = st.get("adjusted") if status == "revised" else res["total"]
        data: dict[str, Any] = {"status": status, "total": res["total"], "comment": st["comment"], "result": res,
                                "weak": [w["name"] for w in weak_domains(res)]}
        if status == "revised":
            data["adjustedScore"] = st["adjusted"]
        for k in ("signedBy", "facultyComment"):
            if st.get(k) and status in ("signed_off", "revised", "sent_back"):
                data[k] = st[k]
        by = st.get("signedBy") or "Faculty"
        await turn.reply(f"{WHAT[res['what']]} result, {n} out of 100: {status.replace('_', ' ')}" + (f" ({by})." if "signedBy" in data else "."),
                         "score", "sign_off", st["ref"], spoken=phrases.say(key, st["lang"], by=by, n=n), data=data, to=to, lang=st["lang"])

    async def _ask_teacher(self, turn: Turn, st: dict[str, Any], focus: str = "") -> None:
        """Examiner to teacher, without the nurse: weak areas only, nobody's name."""
        res = st["result"]
        st["plan"] = "asked"
        weak = weak_domains(res, focus)
        data = {"what": res["what"], "clinic": res["clinic"], "about": for_teacher(res["about"]), "weak": weak,
                "gaps": [g for x in res["improvements"] if (g := for_teacher(x))], "focus": focus}
        ok = await turn.ask_department(
            TEACHER, "Please plan one lesson and one practice case. Weak: " + ", ".join(w["name"].lower() for w in weak) + ".",
            Handoff(kind="request", action="study_plan", ref=f"{st['ref']}p", enc=turn.enc, lang=st["lang"], data=data),
            requester=st["requester"], state={"ref": st["ref"]}, timeout=PLAN_TIMEOUT_S)
        if not ok:
            await self._plan_failed(turn, st["ref"], st["requester"])

    async def _plan_failed(self, turn: Turn, ref: str, requester: str) -> None:
        self.result_state(turn.room)["plan"] = "failed"
        await turn.reply("The teacher is not available for a study plan right now.", "ack", "study_plan", ref,
                         data={"status": "failed"}, to=requester)

    async def resume(self, turn: Turn, p: Pending, h: Handoff) -> None:
        if p.action != "study_plan":
            return
        ref = str(p.state.get("ref") or "")
        topic = _plain(h.data.get("topic"), 120)
        cases = [str(c)[:80] for c in (h.data.get("cases") if isinstance(h.data.get("cases"), list) else [])[:3] if isinstance(c, str)]
        if not topic:
            await self._plan_failed(turn, ref, p.requester)
            return
        self.result_state(turn.room)["plan"] = "done"
        await turn.reply(f"Study plan from the teacher: {topic}.", "answer", "study_plan", ref, spoken=h.spoken,
                         data={"topic": topic, "level": _plain(h.data.get("level"), 10) or "student", "cases": cases,
                               "clinic": _plain(h.data.get("clinic"), 40), "reason": _plain(h.data.get("reason"), 400)},
                         to=p.requester)

    async def on_wait_timeout(self, turn: Turn, p: Pending) -> None:
        if p.action == "study_plan":
            await self._plan_failed(turn, str(p.state.get("ref") or ""), p.requester)

    async def _human_on_result(self, turn: Turn, text: str, st: dict[str, Any]) -> None:
        res, lang = st["result"], text_lang(text)
        if st.get("facultyId") and turn.sender_id != st["facultyId"]:
            await turn.send("Only the faculty member who was asked can sign this result.", None, turn.sender_id)
            return
        intent, mark, comment = parse_faculty(text)
        if intent == "question":
            out = await llm_answer(RESULT_SYSTEM, {k: res[k] for k in ("what", "total", "domains", "strengths", "improvements")}, text, lang, female=False)
            await turn.send((out or "; ".join(f"{d['name']} {d['score']} of {d['max']}" for d in res["domains"])) +
                            " The result is not signed yet.", None, turn.sender_id)
            return
        if intent == "unclear":
            await turn.send("I have not signed anything. Please reply \"sign off\", \"make it 70 because ...\" or \"send back, ...\".",
                            None, turn.sender_id)
            return
        nurse = turn.room.nurse_id or await turn.participant(NURSE)
        if not nurse:
            await turn.send("Nurse Asha is not in the room, so I could not file this.", None, turn.sender_id)
            return
        comment = comment or (text if len(text.split()) > 3 else "")
        by = await self._name(turn)
        st["status"] = {"signoff": "signed_off", "revise": "revised", "back": "sent_back"}[intent]
        st["signedBy"], st["facultyComment"] = by, comment[:400]
        if intent == "revise":
            st["adjusted"] = mark
        st["requester"] = nurse
        turn.tool("record_signature", "Recording the faculty decision")
        turn.tool_done(st["status"])
        await self._report(turn, st, nurse)
        focus = focus_of(res, comment)
        if focus and focus != weak_domains(res)[0]["name"]:
            await self._ask_teacher(turn, st, focus)  # the person pointed at something else: plan again


    @staticmethod
    def state(room: Room) -> dict[str, Any]:
        return room.data.setdefault("score", {})

    async def restore(self, room: Room, h: Handoff) -> None:
        if h.kind == "score" and h.action == "sign_off" and isinstance(h.data.get("result"), dict):
            self.result_state(room).update(
                ref=h.ref, result=read_result(h.data["result"]), comment=_plain(h.data.get("comment"), 300), status=str(h.data.get("status") or "draft"),
                lang=phrases.norm(h.lang), requester="", facultyId="", plan=self.result_state(room).get("plan") or "asked",
                adjusted=h.data.get("adjustedScore"), signedBy=_plain(h.data.get("signedBy"), 80), facultyComment=_plain(h.data.get("facultyComment"), 400))
            room.enc, room.lang = h.enc or room.enc, phrases.norm(h.lang)
        if h.kind == "answer" and h.action == "study_plan":
            self.result_state(room)["plan"] = "done"
        if h.kind == "score" and isinstance(h.data.get("domains"), list):
            self.state(room).update(ref=h.ref, score=dict(h.data), facultyId="", lang=phrases.norm(h.lang))
            room.enc, room.lang = h.enc or room.enc, phrases.norm(h.lang)

    async def handle(self, turn: Turn, h: Handoff) -> None:
        if h.action == "sign_off":
            await self._sign_off(turn, h)
            return
        if h.action == "ask":
            text = two_sentences(await self._answer_text(turn.room, str(h.data.get("question") or ""), turn.lang))
            await turn.reply(text, "answer", "ask", h.ref, spoken=text, data={"text": text})
            return
        turn.tool("count_teamwork", "Counting requests, holds, critical results and answers")
        counts = read_counts(h.data)
        domains, skipped = score_domains(counts)
        total = sum(d["score"] for d in domains)
        turn.tool_done(f"Draft score {total} out of 100")
        strengths, improvements = await word_it(*select_facts(counts))
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
        if self.result_state(turn.room).get("result"):
            await self._human_on_result(turn, text, self.result_state(turn.room))
            return
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
