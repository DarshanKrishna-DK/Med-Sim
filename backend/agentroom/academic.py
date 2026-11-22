"""The academic room: one side room per OSCE, viva or consultation result.

Asha opens it and hands the marks (never a name) to Examiner Kulkarni. He drafts a covering
note and asks Teacher Iyer, agent to agent, for a study plan. When the student asks, the
human faculty member joins; only their own words in the room sign the result, send it back
or change the score. Signing is a layer on top: the marks of osce.py, viva.py and debrief.py
are never touched, and nothing is ever signed on silence.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

import lang as langmod

from . import academic_lines  # noqa: F401  (adds its frames)
from . import dept_phrases as phrases
from . import siderooms
from .client import BandError
from .protocol import EXAMINER, NURSE
from .siderooms import Kind, Reply, SideRoom

log = logging.getLogger("medsim.room.academic")

KIND = "academic"
WHATS = ("osce", "viva", "debrief")
EXAMINER_TIMEOUT_S = 60.0
DECISIONS = ("signed_off", "revised", "sent_back")
MAX_MARKED = 600
MARKED_TTL_S = 24 * 3600

# ── marks this server produced ─────────────────────────────────────────────
# The browser brings the result to the room. A result counts as verified only when this
# server marked the same station, viva or case with the same total in the last day.

_marked: "OrderedDict[str, float]" = OrderedDict()


def _mark_key(what: str, key: str, total: Any) -> str:
    return hashlib.sha256(f"{what}|{str(key or '').strip().lower()}|{int(round(float(total)))}".encode()).hexdigest()[:24]


def record_marks(what: str, key: Any, total: Any) -> None:
    """Called by osce.py, viva.py and debrief.py after marking. Never raises."""
    try:
        k = _mark_key(what, str(key or ""), total)
    except (TypeError, ValueError):
        return
    _marked.pop(k, None)
    _marked[k] = time.time()
    while len(_marked) > MAX_MARKED:
        _marked.popitem(last=False)


def verified(what: str, key: str, total: Any) -> bool:
    try:
        at = _marked.get(_mark_key(what, key, total))
    except (TypeError, ValueError):
        return False
    return at is not None and time.time() - at < MARKED_TTL_S


# ── the catalogue, to check what the teacher suggests ──────────────────────

_teaching: Optional[dict[str, Any]] = None


def teaching() -> dict[str, Any]:
    global _teaching
    if _teaching is None:
        _teaching = json.loads((Path(__file__).resolve().parents[1] / "data" / "teaching.json").read_text(encoding="utf-8"))
    return _teaching


def check_plan(data: dict[str, Any], *, avoid: str = "") -> Optional[dict[str, Any]]:
    """The plan as the page may use it: a topic /teach/lesson accepts and a case that exists. None = unusable."""
    import teacher as lessons  # the lesson endpoint's own request model decides

    topic = re.sub(r"\s+", " ", re.sub(r"[<>{}`]", " ", str(data.get("topic") or ""))).strip()[:120]
    level = "intern" if data.get("level") == "intern" else "student"
    try:
        lessons.LessonRequest(topic=topic, level=level)
    except ValueError:
        return None
    cat = teaching()
    raw = data.get("cases") if isinstance(data.get("cases"), list) else []
    case = next((c for c in raw if isinstance(c, str) and c in cat["cases"] and c != avoid), "")
    clinic = cat["cases"][case][0] if case else ""
    return {"status": "ready", "topic": topic, "level": level, "caseId": case, "clinic": clinic,
            "clinicLabel": (cat["clinics"].get(clinic) or {}).get("label", ""),
            "reason": re.sub(r"\s+", " ", str(data.get("reason") or "")).strip()[:400]}


# ── opening ────────────────────────────────────────────────────────────────


def _text(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[<>`]", " ", str(v or ""))).strip()[:n]


def check_context(ref_id: str, ctx: dict[str, Any]) -> dict[str, Any]:
    what = str(ctx.get("what") or "")
    if what not in WHATS:
        raise ValueError("what must be osce, viva or debrief")
    try:
        total = int(max(0, min(100, round(float(ctx["total"])))))
    except (KeyError, TypeError, ValueError):
        raise ValueError("total is missing") from None
    domains = []
    for d in (ctx.get("domains") if isinstance(ctx.get("domains"), list) else [])[:8]:
        if not isinstance(d, dict) or not d.get("name"):
            continue
        try:
            top = max(1.0, min(1000.0, float(d.get("max") or 100)))
            score = max(0.0, min(top, float(d.get("score") or 0)))
        except (TypeError, ValueError):
            continue
        domains.append({"name": _text(d["name"], 60), "score": round(score, 1), "max": round(top, 1), "note": _text(d.get("note"), 200)})
    lines = lambda k: [_text(x, 180) for x in (ctx.get(k) if isinstance(ctx.get(k), list) else [])[:4] if _text(x, 180)]  # noqa: E731
    clinic = _text(ctx.get("clinic"), 40)
    cat = teaching()
    if clinic not in cat["clinics"]:
        clinic = "internal-medicine"
    key = _text(ctx.get("key"), 200)
    return {
        "what": what, "total": total, "domains": domains, "strengths": lines("strengths"), "improvements": lines("improvements"),
        "clinic": clinic, "specialty": _text(ctx.get("specialty"), 60) or cat["clinics"][clinic]["label"], "about": _text(ctx.get("about"), 80),
        "caseId": _text(ctx.get("caseId"), 80), "resume": ctx.get("resume") is True, "verified": verified(what, key, total),
        # Names that must never reach the room. Used for redaction only, never sent.
        "patientNames": [_text(x, 80) for x in (ctx.get("patientNames") if isinstance(ctx.get("patientNames"), list) else [])[:2]],
        "studentName": _text(ctx.get("studentName"), 80),
    }


def _ref(side: SideRoom) -> str:
    return "so_" + hashlib.sha256(side.id.encode()).hexdigest()[:10]  # the same after a restart


def _audit(side: SideRoom, who: str, what: str, **extra: Any) -> None:
    log_ = [*(side.state.get("audit") or []), {"at": _iso(), "who": who, "what": what, **extra}]
    side.state["audit"] = log_[-30:]


def _iso() -> str:
    from .hub import _iso as iso

    return iso()


async def _flow(side: SideRoom, ctx: dict[str, Any]) -> None:
    side.redact_names.update({n: "the patient" for n in ctx["patientNames"] if len(n) >= 3})
    if len(ctx["studentName"]) >= 3:
        side.redact_names[ctx["studentName"]] = "the student"
    side.update(status="drafting", total=ctx["total"], verified=ctx["verified"], what=ctx["what"], plan={"status": "planning"}, audit=[])
    if side.enc.room_id:  # taken up after a restart: the room's own transcript says where it stands
        await _catch_up(side)
        if side.state["status"] != "drafting":
            return
    elif ctx["resume"]:
        # This browser holds a signed result and only wants its room back: never draft it again.
        side.update(status="unavailable", plan={"status": "failed"})
        return
    await _ask_examiner(side)


async def _catch_up(side: SideRoom) -> None:
    try:
        await side.hub._poll_once(side.enc)
    except BandError as e:
        log.info("transcript unavailable: %s", e)
    for _ in range(10):  # the listener settles what it found
        await asyncio.sleep(0.2)
        if side.state["status"] in DECISIONS:
            break


def _request_data(side: SideRoom, **extra: Any) -> dict[str, Any]:
    c = side.context
    return {**{k: c[k] for k in ("what", "total", "domains", "strengths", "improvements", "clinic", "specialty", "about", "verified")}, **extra}


async def _ask_examiner(side: SideRoom, **extra: Any) -> Reply:
    what = {"osce": "OSCE", "viva": "viva", "debrief": "consultation"}[side.context["what"]]
    side.expect()
    r = await side.request(EXAMINER, "sign_off", f"Please draft this {what} result. It stays a draft until a faculty member signs it.",
                           _request_data(side, **extra), ref=_ref(side), timeout=EXAMINER_TIMEOUT_S, label=f"{what} result",
                           why="Adding the examiner: this result needs a draft and a human signature")
    if r.ok:
        await _on_score(side, r)
    elif side.state["status"] in ("new", "drafting"):
        # Today's behaviour: the marks stand, unsigned.
        side.update(status="unavailable", plan={"status": "failed"})
    return r


# ── what comes back ────────────────────────────────────────────────────────


def _listen(side: SideRoom, r: Reply) -> Any:
    if r.role == EXAMINER and r.kind == "score" and r.ref == _ref(side) and NURSE in r.to:
        return _on_score(side, r)
    if r.role == EXAMINER and NURSE in r.to and r.ref == _ref(side) and r.handoff is not None and r.handoff.action == "study_plan":
        _on_plan(side, r)
    elif r.role == "faculty" and NURSE in r.to and not side.memory.get("redirected"):
        side.memory["redirected"] = True
        return side.post("faculty", "Thank you. Examiner Kulkarni records the decision: please mention him with sign off, "
                         "a changed mark with the reason, or send back.")
    return None


def _on_plan(side: SideRoom, r: Reply) -> None:
    plan = check_plan(r.data, avoid=side.context.get("caseId") or "") if r.kind == "answer" else None
    if plan is None:
        if (side.state.get("plan") or {}).get("status") != "ready":
            side.update(plan={"status": "failed"})
        return
    again = (side.state.get("plan") or {}).get("status") == "ready"
    _audit(side, "Teacher Iyer", "planned your revision again" if again else "planned your revision")
    side.update(plan={**plan, "updated": again})
    if not again and r.spoken and not side.memory.get("planSpoken") and side.enc.waiters:
        side.memory["planSpoken"] = True
        side.speak(r.spoken, speaker="teacher", priority="chat")


async def _on_score(side: SideRoom, r: Reply) -> None:
    d = r.data
    status = str(d.get("status") or "")
    if status not in ("draft", "awaiting_signoff", *DECISIONS):
        return
    fields: dict[str, Any] = {"examinerComment": _text(d.get("comment"), 320),
                              "weak": [_text(w, 60) for w in (d.get("weak") if isinstance(d.get("weak"), list) else [])[:3]]}
    signer: Optional[Reply] = None
    if status in DECISIONS:
        signer = await _human_behind(side)
        if signer is None:  # the examiner cannot sign for the human
            log.warning("a decision without a human message was ignored")
            status = "awaiting_signoff" if side.state["status"] == "awaiting_signoff" else "draft"
    if status not in DECISIONS:
        if side.state["status"] in ("signed_off", "revised"):
            return  # a repeated draft never un-signs a result
        if status == "awaiting_signoff" and side.state["status"] != "awaiting_signoff":
            _audit(side, "Examiner Kulkarni", "asked faculty to sign")
        elif status == "draft" and side.state["status"] in ("new", "drafting"):
            _audit(side, "Examiner Kulkarni", "drafted the result")
        if status == "draft" and side.state["status"] == "sent_back":
            status = "sent_back"
        side.update(status=status, **fields)
        side.expect()
        return
    assert signer is not None
    adjusted: Optional[int] = None
    if status == "revised":
        try:
            adjusted = int(max(0, min(100, round(float(d["adjustedScore"])))))
        except (KeyError, TypeError, ValueError):
            return
    comment = _text(d.get("facultyComment"), 400)
    what = {"signed_off": "signed the result", "revised": f"signed with {adjusted} instead of {side.context['total']}", "sent_back": "sent the result back"}[status]
    if side.memory.get("decided") == (signer.message_id, status):
        return
    side.memory["decided"] = (signer.message_id, status)
    _audit(side, signer.name, what, human=True, **({"comment": comment} if comment else {}), **({"score": adjusted} if adjusted is not None else {}))
    fields.update(status=status, signedBy=signer.name if status != "sent_back" else "", decidedBy=signer.name, facultyComment=comment,
                  signedAt=_iso() if status != "sent_back" else "", adjustedScore=adjusted, final=status != "sent_back")
    side.update(**fields)
    spoken = r.spoken or phrases.say({"signed_off": "res_signed", "revised": "res_revised", "sent_back": "res_back"}[status],
                                     langmod.norm_lang(side.lang), by=signer.name, n=adjusted if adjusted is not None else side.context["total"])
    if side.enc.waiters:  # somebody is looking at the result now
        side.speak(spoken, speaker=EXAMINER)


async def _human_behind(side: SideRoom) -> Optional[Reply]:
    """The last thing a human of this room wrote to the examiner, or None."""
    def last() -> Optional[Reply]:
        return next((h for h in reversed(side.humans) if EXAMINER in h.to), None)

    for attempt in range(4):
        if (h := last()) is not None:
            return h
        if attempt == 0:
            try:
                await side.hub._poll_once(side.enc)
            except BandError as e:
                log.info("poll before signing failed: %s", e)
        await asyncio.sleep(0.25)
    return last()


# ── what the student can do ────────────────────────────────────────────────


async def _invite(side: SideRoom, data: dict[str, Any]) -> dict[str, Any]:
    """Ask faculty to sign (or to look again after a send back)."""
    if side.state["status"] in ("signed_off", "revised"):
        raise ValueError("already signed")
    if side.running() or side.state["status"] == "drafting":
        raise ValueError("the examiner is still drafting")
    person = await side.add_human()
    note = _text(data.get("note"), 300)
    _audit(side, "You", "asked for a signature" if not note else f"asked for a signature: {note}")
    side.update(facultyName=person["name"], inviting=True)

    async def go() -> None:
        try:
            r = await _ask_examiner(side, facultyId=person["id"], **({"note": note} if note else {}))
            if not r.ok:
                side.update(askFailed=True)
        finally:
            side.update(inviting=False)

    side.start(go())
    return {"url": side.url}


async def _retry(side: SideRoom, data: dict[str, Any]) -> None:
    """The examiner or the teacher did not answer: ask again."""
    if side.running():
        raise ValueError("already asking")
    side.update(plan={"status": "planning"} if (side.state.get("plan") or {}).get("status") != "ready" else side.state["plan"], askFailed=False,
                **({"status": "drafting"} if side.state["status"] in ("unavailable", "new") else {}))
    human = side.human()
    extra = {"facultyId": human["id"]} if human and side.state["status"] in ("awaiting_signoff", "draft") else {}
    side.start(_ask_examiner(side, **extra))


siderooms.register(Kind(KIND, owner=NURSE, title="MedSim result", flow=_flow, check=check_context, listener=_listen,
                        actions={"invite": _invite, "retry": _retry}))
