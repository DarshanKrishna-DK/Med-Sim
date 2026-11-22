"""Receptionist Priya in the agent room (her own BAND identity, in the API process).

Two real dependencies: a student's question waits for a human faculty member, and a revision
plan waits for Teacher Iyer. Neither is answered by Priya herself. The browser follows the
side room and gets the answer whenever it comes, at the desk or anywhere else in the app.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
from typing import Any, Optional

import lang as langmod

from . import academic, bedside, siderooms
from . import dept_phrases as phrases
from .protocol import RECEPTION, TEACHER
from .scrub import for_teacher
from .siderooms import Kind, Reply, SideRoom

log = logging.getLogger("medsim.room.desk")

ASK, PLAN = "desk", "desk_plan"
POST_WAIT_S = 5.5      # a voice tool has 8 s in all
PLAN_WAIT_S = 6.0
PLAN_TIMEOUT_S = 60.0
MAX_ANSWERS = 5


def _say(key: str, lang: Optional[str], **kw: Any) -> str:
    return phrases.say(key, langmod.norm_lang(lang), **kw)


def called(name: str) -> str:
    """The way the desk names the faculty member aloud."""
    from .hub import Hub

    return Hub._called(name)


def _unavailable(lang: Optional[str]) -> dict[str, Any]:
    return {"ok": False, "error": "Faculty cannot be reached from the desk right now", "spoken": _say("desk_unavailable", lang)}


# ── a question for a human ─────────────────────────────────────────────────


async def ask_faculty(question: str, *, student: str = "", lang: Optional[str] = None, side_id: str = "",
                      hub: Any = None) -> dict[str, Any]:
    """Post the student's question to the human. Never raises. `side_id`: an earlier question this follows up."""
    q = re.sub(r"\s+", " ", question or "").strip()[:600]
    if not q:
        return {"ok": False, "error": "There is no question to ask yet", "spoken": ""}
    if not siderooms.available(RECEPTION):
        return _unavailable(lang)
    side = siderooms.by_id(side_id, hub) if side_id.startswith(f"{siderooms.PREFIX}{ASK}.") else None
    again = side is not None and bool(side.state.get("question"))
    if side is None:
        side = siderooms.open_room(ASK, secrets.token_hex(8), lang=lang or "en", redact={student: "the student"} if student else None, hub=hub)
    if side is None:
        return _unavailable(lang)
    side.update(status="sending", question=q, final=False)
    text = (f"The student adds: {q}" if again else
            f"A student asks at the front desk: {q}\nPlease reply here and mention me, Receptionist Priya; I will pass it on.")

    async def post() -> None:
        try:
            person = await side.invite_human(text)
            side.update(status="asked", to=person["name"])
            side.expect()
        except Exception:
            side.update(status="failed", final=True)
            raise

    task = side.hub.spawn(post(), "desk question")
    await asyncio.wait({task}, timeout=POST_WAIT_S)
    if side.state["status"] == "failed":
        return {**_unavailable(lang), "sideId": side.id}
    name = called(str(side.state.get("to") or "Faculty"))
    return {"ok": True, "sideId": side.id, "kind": ASK, "question": q, "asked": name, "delivered": side.state["status"] == "asked",
            "spoken": _say("desk_asked", lang, name=name)}


async def _on_message(side: SideRoom, r: Reply) -> None:
    if r.role != "faculty" or RECEPTION not in r.to:
        return
    text = bedside.clean_spoken(side.redact(r.text), 500)
    if not text:
        return
    first = not side.state.get("answers")
    # Shown as written; spoken in the session language when it could be translated.
    said = await side.in_lang(text)
    name = called(r.name)
    spoken = _say("desk_reply", side.lang, name=name, text=said) if said else _say("desk_reply_screen", side.lang, name=name)
    answers = [*(side.state.get("answers") or []), {"id": r.message_id, "by": r.name, "text": text, "spoken": spoken}][-MAX_ANSWERS:]
    side.update(status="answered", answers=answers, answer=text, by=r.name, spoken=spoken)
    if first:
        try:
            await side.post("faculty", "Thank you. I have passed your reply on to the student.")
        except Exception as e:  # noqa: BLE001 - the student has the reply already
            log.info("thanks not posted: %s", type(e).__name__)


# ── a revision plan from the teacher ───────────────────────────────────────


def plan_request(report: dict[str, Any]) -> dict[str, Any]:
    """What the teacher needs from an assignment report: areas, specialty and gaps. No names, no labels."""
    def words(label: str) -> list[str]:
        return [w for w in re.findall(r"[A-Za-z][\w'-]{2,}", label or "")]

    cat = academic.teaching()["clinics"]
    items = [i for i in report.get("items") or [] if isinstance(i, dict)]
    low = sorted((i for i in items if i.get("bestScore") is not None), key=lambda i: float(i["bestScore"]))
    todo = [i for i in items if i.get("bestScore") is None]
    pick = [*[i for i in low if float(i["bestScore"]) < 70], *todo, *low]
    clinic = next((str(i["specialty"]) for i in pick if i.get("specialty") in cat), "")
    weak = [{"name": str(k)[:60], "pct": int(v)} for k, v in sorted((report.get("domains") or {}).items(), key=lambda kv: kv[1])][:3]
    if not weak:
        weak = [{"name": cat[clinic]["label"] if clinic else "Clinical reasoning", "pct": 0}]
    names = {w.lower() for i in items if i.get("kind") not in ("viva", "lesson") for w in words(str(i.get("label") or ""))}
    student = {w.lower() for w in words(str(report.get("student") or ""))}
    clean = lambda t: re.sub(r"\b[A-Z][\w'-]{2,}", lambda m: "the patient" if m.group(0).lower() in names | student else m.group(0), t)  # noqa: E731
    gaps = [for_teacher(clean(str(g))) for g in (report.get("weaknesses") or []) if not str(g).startswith(("Not yet attempted", "Weakest domain"))]
    about = next((str(i["subject"])[:60] for i in pick if i.get("kind") == "viva" and i.get("subject")), "")
    return {"what": "assignment", "clinic": clinic, "about": about, "weak": weak, "gaps": [g for g in gaps if g][:4], "focus": ""}


async def revision_plan(report: dict[str, Any], *, lang: Optional[str] = None, hub: Any = None) -> dict[str, Any]:
    """Ask Teacher Iyer for a plan on this assignment. Never raises."""
    if not siderooms.available(RECEPTION):
        return {"ok": False, "error": "Dr Iyer cannot be reached from the desk right now", "spoken": _say("desk_plan_failed", lang)}
    side = siderooms.open_room(PLAN, secrets.token_hex(8), lang=lang or "en", hub=hub)
    if side is None:
        return {"ok": False, "error": "Dr Iyer cannot be reached from the desk right now", "spoken": _say("desk_plan_failed", lang)}
    side.update(status="planning", plan={"status": "planning"})
    data = plan_request(report)

    async def go() -> None:
        r = await side.request(TEACHER, "study_plan", "A student asks for a revision plan. Weak: " + ", ".join(w["name"].lower() for w in data["weak"]) + ".",
                               data, timeout=PLAN_TIMEOUT_S, label="Revision plan", why="Adding the teacher: a student wants a revision plan")
        plan = academic.check_plan(r.data) if r.ok and r.kind == "answer" else None
        if plan is None:
            side.update(status="failed", final=True, plan={"status": "failed"}, spoken=_say("desk_plan_failed", lang))
        else:
            side.update(status="ready", final=True, plan=plan, spoken=_say("desk_plan", lang, topic=plan["topic"]))

    task = side.hub.spawn(go(), "desk plan")
    await asyncio.wait({task}, timeout=PLAN_WAIT_S)
    out: dict[str, Any] = {"sideId": side.id, "kind": PLAN}
    if side.state["status"] == "failed":
        return {**out, "ok": False, "error": "Dr Iyer did not answer", "spoken": side.state["spoken"]}
    if side.state["status"] == "ready":
        return {**out, "ok": True, "ready": True, "plan": side.state["plan"], "spoken": side.state["spoken"]}
    return {**out, "ok": True, "ready": False, "spoken": _say("desk_plan_wait", lang)}


async def _act_say(side: SideRoom, data: dict[str, Any]) -> None:
    text = re.sub(r"\s+", " ", str(data.get("text") or "")).strip()[:600]
    if not text:
        raise ValueError("nothing to say")
    await side.post("faculty", f"The student adds: {text}")
    side.update(status="asked", question=text)
    side.expect()


siderooms.register(Kind(ASK, owner=RECEPTION, title="MedSim front desk question", listener=_on_message, http=False, actions={"say": _act_say}))
siderooms.register(Kind(PLAN, owner=RECEPTION, title="MedSim revision plan", http=False))
