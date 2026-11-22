"""Review of a case somebody wrote on Telegram, before any student can see it.

Nurse Asha opens a room for the case. Pharmacist Meera checks the treatments against the
allergy and the patient's own medicines; Lab Officer Dev checks that the results are
plausible and can show the stated diagnosis. Then the human reviewer reads both and
decides, in their own words, in that room. Nothing is approved on silence: the case stays
in review, and only its author may publish it "unreviewed", with a badge saying so.

Side room kind "case_review" (owner: nurse), opened by telegram_bot.py, never over HTTP.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

import catalog
import custom_cases
from custom_cases import APPROVED, IN_REVIEW, REJECTED, UNREVIEWED

from . import bedside, client as band_client, faculty, siderooms
from . import hub as hubmod
from .protocol import FACULTY, LAB, NURSE, PHARMACIST, ROLES
from .siderooms import Kind, Reply, SideRoom

log = logging.getLogger("medsim.room.casereview")

KIND = "case_review"
DEPT_TIMEOUT_S = 45.0
KEEP_S = 300.0
MAX_ASKS = 3
# Treatments are judged by the pharmacy; results by the department that performs the test.
LAB_CATEGORIES = ("lab", "bedside")
VERDICT_WORD = {"release": "no concerns", "clarify": "points to look at", "hold": "unsafe or wrong as written", "no_reply": "did not answer"}

Tell = Callable[..., Awaitable[Any]]
tell: Optional[Tell] = None          # telegram_bot.send, set by that module
_hub: Optional[hubmod.Hub] = None    # tests use their own
_task: Optional[asyncio.Task] = None


def _clip(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def enabled() -> bool:
    """A review room can be opened: BAND is configured and the server is running (never from a test run)."""
    return siderooms.available(NURSE) and (_hub or hubmod.hub).started


# ── what each department gets, and nothing else ────────────────────────────


def _answer(case: dict[str, Any], word: str) -> str:
    return "; ".join(_clip(q.get("answer"), 300) for q in case.get("anamnesis") or []
                     if isinstance(q, dict) and re.search(word, f"{q.get('id')} {q.get('question')}", re.I))[:500]


def facts_of(case: dict[str, Any], answers: Optional[dict[str, Any]]) -> dict[str, str]:
    """The author's allergy and medicine lines; from the history when they are not at hand."""
    a = answers or {}
    return {"allergies": _clip(a.get("allergies"), 300) or _answer(case, "allerg") or "not stated",
            "medicines": _clip(a.get("medications"), 300) or _answer(case, "medic|drug|tablet") or "not stated"}


def _names(kind: str) -> dict[str, str]:
    return {t["id"]: t["name"] for t in catalog.load()[kind]}


def pharmacy_data(case: dict[str, Any], facts: dict[str, str]) -> dict[str, Any]:
    names = _names("treatments")
    ids = list(dict.fromkeys([*(case.get("criticalTreatmentIds") or []), *(case.get("acceptableTreatmentIds") or [])]))[:16]
    return {"caseId": case["id"], "age": case.get("age"), "gender": case.get("gender"), "allergies": facts["allergies"],
            "medicines": facts["medicines"], "complaint": _clip(case.get("chiefComplaint"), 300),
            "treatments": [{"id": i, "name": names.get(i, i)} for i in ids]}


def lab_data(case: dict[str, Any]) -> dict[str, Any]:
    from .base import load_json

    category = {t: row[1] for t, row in load_json("lis.json")["tests"].items()}
    names = _names("tests")
    mine, others = [], []
    for r in (case.get("testResults") or [])[:16]:
        tid = str(r.get("testId") or "")
        if category.get(tid) in LAB_CATEGORIES:
            mine.append({"testId": tid, "name": names.get(tid, tid), "result": _clip(r.get("result"), 400), "abnormal": bool(r.get("abnormal"))})
        else:
            others.append(tid)  # the name of an imaging study, never its report
    return {"caseId": case["id"], "age": case.get("age"), "gender": case.get("gender"), "diagnosis": diagnosis_of(case),
            "results": mine, "otherTests": others}


def diagnosis_of(case: dict[str, Any]) -> str:
    cid = str(case.get("correctDiagnosisId") or "")
    return _clip((case.get("diagnosisLabels") or {}).get(cid) or cid.replace("-", " "), 120)


def finding_of(r: Reply) -> dict[str, Any]:
    verdict = str(r.data.get("verdict") or "") if r.ok and r.kind == "verdict" else ""
    if verdict not in ("release", "clarify", "hold"):
        return {"verdict": "no_reply", "text": "", "points": []}
    points = [_clip(bedside.clean_spoken(f.get("detail")), 200) for f in r.data.get("findings") or [] if isinstance(f, dict)][:8] \
        if isinstance(r.data.get("findings"), list) else []
    return {"verdict": verdict, "text": _clip(bedside.clean_spoken(r.text, 600), 500), "points": [p for p in points if p]}


def dept_line(role: str, f: dict[str, Any]) -> str:
    title = "Pharmacy" if role == PHARMACIST else "Laboratory"
    out = f"{title}: {VERDICT_WORD[f['verdict']]}"
    return out + (f" ({'; '.join(f['points'][:4])})" if f.get("points") else "") + "."


def brief(case: dict[str, Any], facts: dict[str, str], findings: dict[str, Any]) -> str:
    names = _names("tests")
    results = "; ".join(f"{names.get(r['testId'], r['testId'])}: {_clip(r['result'], 90)}" for r in (case.get("testResults") or [])[:6])
    treatments = _names("treatments")
    tx = ", ".join(treatments.get(t, t) for t in (case.get("acceptableTreatmentIds") or [])[:8])
    return " ".join([
        f"A new teaching case is waiting for your decision. {case.get('age')} {case.get('gender')}, {catalog.specialty_label(case.get('specialty') or '')},",
        f"{case.get('severity')}. Complaint: {_clip(case.get('chiefComplaint'), 200)} Diagnosis: {diagnosis_of(case)}.",
        f"Allergies: {facts['allergies']}. Medicines: {facts['medicines']}. Results: {results}. Accepted treatment: {tx}.",
        dept_line(PHARMACIST, findings["pharmacist"]), dept_line(LAB, findings["lab"]),
        "Students cannot see it until you decide. Reply to @Nurse Asha with \"approve\", or \"reject\" and the reason.",
    ]).replace("@Nurse Asha", "Nurse Asha")[:2400]


# ── the decision ───────────────────────────────────────────────────────────

_SEND_BACK = re.compile(r"\b(?:send (?:it )?back|needs? (?:changes?|work|fixing)|not (?:ready|suitable|acceptable)|fix (?:it|this) first|do not publish|don'?t publish)\b", re.I)
_PUBLISH = re.compile(r"\b(?:publish(?:ed)?(?: it| this)?|accept(?:ed)?)\b", re.I)
_REASON = re.compile(r"^.*?\b(?:reject(?:ed)?|den(?:y|ied)|decline[d]?|refuse[d]?|send (?:it )?back|not approved)\b[\s:,.\-]*(?:it\b|this\b)?[\s:,.\-]*(?:because\b|as\b|since\b|reason\b)?[\s:,.\-]*", re.I | re.S)


def decide(text: str) -> tuple[str, str]:
    """('approve'|'reject'|'', reason). Only plain words count; a condition or a question is neither."""
    t = _clip(text, 600)
    if not t or "?" in t:
        return "", ""
    rejected = bool(_SEND_BACK.search(t))
    said = faculty.classify_rules(_PUBLISH.sub("approved", t))
    if rejected or said == "deny":
        reason = _REASON.sub("", t, count=1).strip(" .") if _REASON.match(t) else t
        return "reject", _clip(reason, 300)
    return ("approve", "") if said == "approve" else ("", "")


async def _tell(case_id: str, text: str, markup: Any = None) -> None:
    chat = custom_cases.chat_of(case_id)
    if tell is None or chat is None:
        return
    try:
        await tell(chat, text, markup)
    except Exception as e:  # noqa: BLE001 - the decision stands whether or not Telegram is up
        log.warning("author not told: %s", type(e).__name__)


async def _to_human(side: SideRoom, text: str) -> None:
    try:
        await side.post(FACULTY, text)
    except band_client.BandError as e:
        log.warning("reviewer not told: %s", e)


async def listen(side: SideRoom, r: Reply) -> None:
    case_id = side.ref_id
    if r.role != FACULTY:
        await _late(side, r)
        return
    if r.to and NURSE not in r.to:
        return  # they are talking to a department
    choice, reason = decide(r.text)
    case = custom_cases.get(case_id)
    if case is None:
        await _to_human(side, "The author has deleted this case, so there is nothing left to decide.")
        side.update(status="deleted", final=True)
        return
    if not choice:
        n = side.memory["asks"] = side.memory.get("asks", 0) + 1
        if n <= MAX_ASKS and custom_cases.status_of(case_id) in (IN_REVIEW, UNREVIEWED):
            await _to_human(side, "I can only act on a plain answer. Please reply \"approve\", or \"reject\" and the reason. Until then the case stays as it is.")
        return
    status = APPROVED if choice == "approve" else REJECTED
    name = hubmod.Hub._called(r.name)
    if not custom_cases.set_review(case_id, status, only_from=(IN_REVIEW, UNREVIEWED), by=name, at=_now(), reason=reason):
        return  # already decided
    side.update(status=status, final=True, by=name, reason=reason)
    who = html.escape(case["name"])
    if status == APPROVED:
        await _to_human(side, "Approved. Students can see the case now.")
        await _tell(case_id, f"{html.escape(name)} approved <b>{who}</b>. Students can open it now. Case id: <code>{case_id}</code>")
    else:
        await _to_human(side, "Rejected. Students will not see the case, and the author has the reason.")
        await _tell(case_id, f"{html.escape(name)} did not approve <b>{who}</b>" + (f": {html.escape(reason)}" if reason else "")
                    + f".\n\n{_report(custom_cases.review_of(case_id).get('findings') or {})}\n\nStudents will not see it. Send /newpatient to write it again, "
                      f"or /delete {case_id} to remove it.")


async def _late(side: SideRoom, r: Reply) -> None:
    """A department that answered after the wait: the reviewer should still see it."""
    ref = side.enc.refs.get(r.ref)
    if r.handoff is None or r.kind != "verdict" or r.handoff.action != "case_review" or ref is None or ref.target_id != r.sender_id:
        return
    findings = dict(side.memory.get("findings") or {})
    if findings.get(ref.target, {}).get("verdict") != "no_reply":
        return
    findings[ref.target] = side.memory["findings"][ref.target] = finding_of(r)
    side.set_delegation(r.ref, "done", r.text)
    custom_cases.set_review(side.ref_id, findings=findings)
    side.update(findings=findings)
    if side.human() is not None:
        await _to_human(side, f"A late answer. {dept_line(ref.target, findings[ref.target])}")


def _report(findings: dict[str, Any]) -> str:
    return "\n".join(html.escape(dept_line(role, findings[role])) for role in (PHARMACIST, LAB) if role in findings)


# ── the review ─────────────────────────────────────────────────────────────


async def review(side: SideRoom, case: dict[str, Any], facts: dict[str, str]) -> None:
    case_id = case["id"]
    side.update(status=IN_REVIEW)

    async def ask(role: str, text: str, data: dict[str, Any]) -> dict[str, Any]:
        f = finding_of(await side.request(role, "case_review", text, data, timeout=DEPT_TIMEOUT_S, label="Case review",
                                          why=f"Adding {ROLES[role].title.lower()}: a new case needs checking"))
        if side.enc.room_id:
            custom_cases.set_review(case_id, roomId=side.enc.room_id)
        return f

    ph, lab = await asyncio.gather(
        ask(PHARMACIST, "Please check this new case: accepted treatments against the allergy and the patient's medicines.", pharmacy_data(case, facts)),
        ask(LAB, "Please check this new case: are the results plausible, and can they show the stated diagnosis?", lab_data(case)))
    findings = {PHARMACIST: ph, LAB: lab}
    side.memory["findings"] = dict(findings)
    if not custom_cases.set_review(case_id, findings=findings, only_from=(IN_REVIEW, UNREVIEWED)):
        side.update(status="deleted", final=True)
        return
    side.update(findings=findings)
    try:
        person = await side.invite_human(brief(case, facts, findings))
        custom_cases.set_review(case_id, reviewer=hubmod.Hub._called(person["name"]), askedAt=_now())
        waiting = f"Now waiting for {html.escape(hubmod.Hub._called(person['name']))} to approve or reject it in BAND."
    except band_client.BandError as e:
        log.warning("no reviewer reached: %s", e)
        waiting = "No reviewer could be reached, so it stays in review."
    side.update(status=IN_REVIEW, waiting=waiting)
    if custom_cases.status_of(case_id) == IN_REVIEW:
        await _tell(case_id, f"Checks on <b>{html.escape(case['name'])}</b>:\n{_report(findings)}\n\n{waiting}", unreviewed_button(case_id))


def unreviewed_button(case_id: str) -> dict[str, Any]:
    return {"inline_keyboard": [[{"text": "Publish unreviewed", "callback_data": f"p:{case_id}"}]]}


def _open(case: dict[str, Any]) -> Optional[SideRoom]:
    label = catalog.specialty_label(case.get("specialty") or "")
    return siderooms.open_room(KIND, case["id"], title=f"{label}, {case['id']}", lang="en", context={},
                               redact={str(case.get("name") or ""): "the patient"}, hub=_hub)


def submit(case: dict[str, Any], answers: Optional[dict[str, Any]], chat_id: Optional[int]) -> bool:
    """Store a new case as in review and start its review. False when there is no review room:
    the caller publishes it at once, as without BAND. Needs a running event loop."""
    if not enabled():
        return False
    facts = facts_of(case, answers)
    custom_cases.add(case, chat_id, IN_REVIEW, {"facts": facts, "submittedAt": _now()})
    side = _open(case)
    if side is not None:
        side.start(review(side, case, facts))
    return True


def publish_unreviewed(case_id: str, chat_id: int) -> str:
    """The author's own choice. '' when done, else why not."""
    if custom_cases.chat_of(case_id) != chat_id:
        return "No patient with that id was created from this chat."
    status = custom_cases.status_of(case_id)
    if status == REJECTED:
        return "A reviewer rejected this case, so it cannot be published."
    if status != IN_REVIEW or not custom_cases.set_review(case_id, UNREVIEWED, only_from=(IN_REVIEW,), publishedAt=_now()):
        return "This case is already published."
    side = siderooms.get(KIND, case_id, _hub)
    if side is not None:
        side.update(status=UNREVIEWED)
    return ""


# ── after a restart, and for reviews that take days ────────────────────────


async def resume_one(case_id: str) -> None:
    case, r = custom_cases.get(case_id), custom_cases.review_of(case_id)
    if case is None or siderooms.get(KIND, case_id, _hub) is not None:
        return
    side = _open(case)
    if side is None:
        return
    side.memory["findings"] = dict(r.get("findings") or {})
    room = str(r.get("roomId") or "")
    if room:
        # Old unclear messages are read again: never ask about those a second time.
        side.memory["asks"] = MAX_ASKS
        if await side.adopt(room):
            side.update(status=custom_cases.status_of(case_id), findings=r.get("findings") or {})
            side.expect(60.0)
    if custom_cases.status_of(case_id) == IN_REVIEW and not r.get("findings") and not side.running():
        facts = r.get("facts") if isinstance(r.get("facts"), dict) else facts_of(case, None)
        side.start(review(side, case, facts))


async def _keep() -> None:
    while True:
        await asyncio.sleep(15.0)
        if enabled():
            for case_id in custom_cases.with_status(IN_REVIEW, UNREVIEWED):
                try:
                    await resume_one(case_id)
                except Exception as e:  # noqa: BLE001 - one case must not stop the others
                    log.warning("review of a case not resumed: %s", type(e).__name__)
        await asyncio.sleep(KEEP_S)


def start() -> None:
    global _task
    if siderooms.available(NURSE) and (_task is None or _task.done()):
        _task = asyncio.get_event_loop().create_task(_keep())


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
    _task = None


siderooms.register(Kind(KIND, owner=NURSE, title="Case review", listener=listen, http=False))
