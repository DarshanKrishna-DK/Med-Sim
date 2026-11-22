"""Teacher Iyer: turns weak areas into one lesson and one practice patient.

She is told what kind of exam it was, the specialty, and which areas were weak. She never
learns who the student or the patient is, and her catalogue holds no identity either. The
practice cases are picked by rule from that catalogue; a model may word the lesson title
and the reason, inside checks, and fixed sentences stand behind it.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Optional

from . import academic_lines  # noqa: F401  (adds its frames)
from . import dept_phrases as phrases
from .base import UNTRUSTED, DepartmentAdapter, Turn, in_script, llm_text, load_json, two_sentences
from .protocol import TEACHER, Handoff

LLM_TIMEOUT_S = 8.0
MAX_TOPIC = 80

# What a domain name is about, in every marking scheme of the app.
AREAS: tuple[tuple[str, str, str], ...] = (
    ("communication", r"communicat|interpersonal|empath|explain|rapport|safety.?net|counsel|professional", "explaining the plan to the patient"),
    ("history", r"histor|data.?gather|examin|recall|question", "history and examination"),
    ("tests", r"test|investigat|imaging|lab", "choosing the right investigations"),
    ("reasoning", r"reason|diagnos|interpret", "reaching the diagnosis"),
    ("management", r"manag|treat|safety|prescri|dispos|follow|applied|drug", "treatment and safety"),
)


def area_of(name: str) -> str:
    n = (name or "").lower()
    return next((key for key, rx, _ in AREAS if re.search(rx, n)), "")


def clean_request(data: dict[str, Any]) -> dict[str, Any]:
    """Only what the teacher needs, in fixed shapes. Anything else in the request is dropped."""
    def text(v: Any, n: int) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[<>`{}]", " ", str(v or ""))).strip()[:n]

    weak = []
    for x in data.get("weak") if isinstance(data.get("weak"), list) else []:
        if isinstance(x, dict) and x.get("name"):
            try:
                pct = max(0, min(100, int(float(x.get("pct")))))
            except (TypeError, ValueError):
                pct = 0
            weak.append({"name": text(x["name"], 60), "pct": pct})
    return {
        "what": text(data.get("what"), 20) or "result",
        "clinic": text(data.get("clinic"), 40),
        "about": text(data.get("about"), 80),
        "weak": weak[:4],
        "gaps": [text(g, 160) for g in (data.get("gaps") if isinstance(data.get("gaps"), list) else [])[:4] if text(g, 160)],
        "focus": text(data.get("focus"), 60),
    }


class Catalogue:
    def __init__(self) -> None:
        d = load_json("teaching.json")
        self.clinics: dict[str, dict[str, Any]] = d["clinics"]
        self.cases: dict[str, list[Any]] = d["cases"]

    def label(self, clinic: str) -> str:
        return str((self.clinics.get(clinic) or {}).get("label") or "")

    def practice(self, clinic: str, area: str, seed: str) -> list[str]:
        """Three cases of that specialty that exercise the weak area, not the same three every time."""
        if area == "communication" and "communication-skills" in self.clinics and clinic != "communication-skills":
            pool = [c for c, row in self.cases.items() if row[0] == clinic and row[4]]
            pool = pool or [c for c, row in self.cases.items() if row[0] == "communication-skills"]
        else:
            pool = [c for c, row in self.cases.items() if row[0] == clinic]
        if not pool:
            pool = [c for c, row in self.cases.items() if row[0] == "internal-medicine"]
        rank = {"history": 1, "tests": 2, "reasoning": 2, "management": 3}.get(area)
        if rank is not None:
            pool = sorted(pool, key=lambda c: -int(self.cases[c][rank]))[: max(6, len(pool) // 2)]
        return sorted(pool, key=lambda c: hashlib.sha256(f"{seed}|{c}".encode()).hexdigest())[:3]

    def topic(self, req: dict[str, Any], area: str, seed: str) -> str:
        """A lesson title that is right without a model."""
        words = next((w for key, _, w in AREAS if key == area), "")
        about = req["about"]
        if not about:
            topics = (self.clinics.get(req["clinic"]) or {}).get("topics") or []
            if req["what"] != "viva" and topics and area in ("reasoning", "management", "tests"):
                about = topics[int(hashlib.sha256(seed.encode()).hexdigest(), 16) % len(topics)]
            else:
                about = self.label(req["clinic"])
        return (f"{about}: {words}" if about and words else about or words or "Clinical reasoning basics")[:MAX_TOPIC]


SYSTEM = (
    "You are Dr Iyer, a kind teacher in an Indian medical college, planning revision for a student of a SYNTHETIC training "
    "simulator. <record> says which exam it was, the specialty, what it was about and which areas were weak. " + UNTRUSTED +
    ' Reply with ONE JSON object only: {"topic": "...", "reason": "..."}. topic: an English whiteboard lesson title of 3 to 9 '
    "words on the single most useful thing to revise, taken from the gaps or weak areas. reason: exactly two short sentences, in "
    "%s, spoken to the student, saying why this lesson and why to practise on a patient right after. No numbers, no marks, no "
    "names of people, no diagnosis of the practice patient, no markdown, no em dashes."
)


def check_topic(v: Any) -> str:
    t = re.sub(r"\s*[—–]\s*", ": ", re.sub(r"[*_`#<>{}\"]+", "", str(v or "")))
    t = re.sub(r"\s+", " ", t).strip(" .:")
    if not 4 <= len(t) <= MAX_TOPIC or not re.search(r"[A-Za-z]{3}", t) or re.search(r"\d+\s*(?:/|out of|%|marks?)", t, re.I):
        return ""
    return t if all(ord(ch) < 0x0900 for ch in t) else ""


def check_reason(v: Any, lang: str) -> str:
    t = two_sentences(str(v or ""), 300)
    if len(t) < 20 or re.search(r"\d+\s*(?:/|out of|%|marks?|points?)", t, re.I):
        return ""
    if lang == "en":
        return t if all(not 0x0900 <= ord(ch) <= 0x0DFF for ch in t) else ""
    return t if in_script(t, lang) else ""


class TeacherAdapter(DepartmentAdapter):
    role = TEACHER
    handles = frozenset({("request", "study_plan")})

    def __init__(self, owner: str = "", **kw: Any) -> None:
        super().__init__(owner, **kw)
        self._catalogue: Optional[Catalogue] = None

    @property
    def catalogue(self) -> Catalogue:
        if self._catalogue is None:
            self._catalogue = Catalogue()
        return self._catalogue

    def warm(self) -> None:
        self.catalogue  # noqa: B018

    async def handle(self, turn: Turn, h: Handoff) -> None:
        req = clean_request(h.data)
        weakest = req["focus"] or (min(req["weak"], key=lambda w: w["pct"])["name"] if req["weak"] else "")
        area = area_of(weakest) or next((a for g in req["gaps"] if (a := area_of(g))), "")
        turn.tool("pick_practice", "Looking for practice cases that exercise the weak area", clinic=req["clinic"], area=area)
        cases = self.catalogue.practice(req["clinic"], area, h.ref)
        turn.tool_done(f"{len(cases)} practice case(s) found", bool(cases))
        topic = self.catalogue.topic(req, area, h.ref)
        reason = ""
        worded = await self._word(req, weakest, turn.lang)
        if worded:
            topic, reason = worded[0] or topic, worded[1]
        reason = reason or phrases.say("plan_reason", turn.lang, topic=topic)
        clinic = str(self.catalogue.cases[cases[0]][0]) if cases else req["clinic"]
        await turn.reply(f"Suggested lesson: {topic}. Then one practice case in {self.catalogue.label(clinic) or 'the clinic'}.",
                         "answer", "study_plan", h.ref, spoken=phrases.say("plan_ready", turn.lang, topic=topic),
                         data={"topic": topic, "level": "student", "cases": cases, "clinic": clinic, "reason": reason})

    async def _word(self, req: dict[str, Any], weakest: str, lang: str) -> Optional[tuple[str, str]]:
        import lang as langmod

        body = json.dumps({**req, "specialty": self.catalogue.label(req["clinic"]), "weakest": weakest}, ensure_ascii=False)

        def accept(text: str) -> Optional[tuple[str, str]]:
            m = re.search(r"\{.*\}", text, re.DOTALL)
            d = json.loads(m.group(0)) if m else {}
            topic, reason = check_topic(d.get("topic")), check_reason(d.get("reason"), lang)
            return (topic, reason) if topic else None

        name = langmod.LANG_NAMES.get(lang, "English")
        return await llm_text([{"role": "system", "content": SYSTEM % (name if lang == "en" else f"{name}, in {name} script")},
                               {"role": "user", "content": f"<record>{body}</record>"}],
                              accept, timeout=LLM_TIMEOUT_S, max_tokens=300, json_mode=True)

    async def on_human(self, turn: Turn, text: str) -> None:
        await turn.send("I plan revision for the examiner and the front desk. Please write to Examiner Kulkarni about a result.",
                        None, turn.sender_id)
