"""Front-desk receptionist agent: POST /agent/reception/act.

Priya at Reception answers questions about the student's assignment and scores and
can email the assignment report to the teacher. OpenAI-compatible tool loop
(llm_provider.chat, Sarvam first, Groq fallback), same pattern as nurse._run_native
but self-contained. When no LLM is reachable a keyword router runs the same tools,
so the front desk still works offline.

Tools: get_assignment_status(code), get_my_scores(), email_report_to_teacher(code, note?),
list_assignments(), ask_faculty(question) (a human answers in the BAND room) and
ask_revision_plan(code?) (Teacher Iyer answers there). The email tool has no recipient parameter: the report only ever
goes to the teacher email stored on the assignment.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import assignments as asg
from llm_provider import chat, strip_think

log = logging.getLogger("medsim.reception")
router = APIRouter()
MAX_ITERATIONS = 4


class ProfileIn(BaseModel):
    name: str = ""
    university: str = ""


class LocalAttempt(BaseModel):
    label: str = ""
    kind: str = "case"
    specialty: Optional[str] = None
    score: float = 0
    at: Optional[float] = None


class LocalProgress(BaseModel):
    sessions: int = 0
    average: Optional[float] = None
    recent: list[LocalAttempt] = Field(default_factory=list)
    skills: dict[str, float] = Field(default_factory=dict)


class ReceptionActRequest(BaseModel):
    utterance: str = Field(min_length=1, max_length=600)
    profile: ProfileIn = Field(default_factory=ProfileIn)
    assignmentCode: Optional[str] = None
    knownCodes: list[str] = Field(default_factory=list)
    localProgress: LocalProgress = Field(default_factory=LocalProgress)
    lang: Optional[str] = None
    history: list[dict[str, str]] = Field(default_factory=list)
    # The BAND side room of an earlier question that is still open at this desk.
    deskRoom: Optional[str] = Field(None, max_length=120)


TOOL_SPECS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "get_assignment_status",
        "description": "Progress on one assignment for this student: completed vs pending items, best score per item, average, pass or fail against the pass mark, due date.",
        "parameters": {"type": "object", "properties": {"code": {"type": "string", "description": "6-character assignment code; omit for the active assignment"}}, "required": []},
    }},
    {"type": "function", "function": {
        "name": "get_my_scores",
        "description": "The student's recent practice scores and skill averages from this browser, plus the active assignment's results.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    {"type": "function", "function": {
        "name": "email_report_to_teacher",
        "description": "Email the student's assignment report (scores, pass or fail, strengths, areas to improve) to the teacher who set the assignment. The recipient is fixed by the assignment.",
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string", "description": "assignment code; omit for the active assignment"},
            "note": {"type": "string", "description": "optional short note from the student to the teacher"},
        }, "required": []},
    }},
    {"type": "function", "function": {
        "name": "list_assignments",
        "description": "Assignments this student has joined, with title, due date and progress.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    {"type": "function", "function": {
        "name": "ask_faculty",
        "description": "Put the student's question to a human faculty member, who answers in their own time. Use when the student asks "
                       "to ask, message or check something with faculty, sir, ma'am, the professor or the HOD, or asks something only a "
                       "person can decide (leave, exam dates, rules, a disputed mark).",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string", "description": "The student's question in their own words, complete, one or two sentences"},
        }, "required": ["question"]},
    }},
    {"type": "function", "function": {
        "name": "ask_revision_plan",
        "description": "Ask Dr Iyer, the teacher, for a revision plan for the student's assignment: one lesson and one practice patient. "
                       "Use when the student asks what to revise, study or practise next.",
        "parameters": {"type": "object", "properties": {"code": {"type": "string", "description": "assignment code; omit for the active assignment"}}, "required": []},
    }},
]


class ReceptionState:
    def __init__(self, req: ReceptionActRequest):
        self.req = req
        self.student = req.profile.name.strip()
        self.university = req.profile.university.strip()
        codes = [asg.norm_code(c) for c in ([req.assignmentCode or ""] + req.knownCodes) if c]
        self.known = list(dict.fromkeys(c for c in codes if asg.CODE_RE.match(c)))
        self.active = asg.norm_code(req.assignmentCode or "") or None
        self.emailed: Optional[dict[str, Any]] = None
        self.desk: Optional[dict[str, Any]] = None  # a BAND side room the browser should follow

    def _code(self, code: Any) -> Optional[str]:
        c = asg.norm_code(str(code or "")) or self.active
        # Only codes this browser has joined: the agent can't mail reports for other classes.
        return c if c and c in self.known else None

    async def execute(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "get_assignment_status":
                code = self._code(args.get("code"))
                if not code:
                    return {"ok": False, "error": "No active assignment. Open the assignment link from your teacher first."}
                if not self.student:
                    return {"ok": False, "error": "Profile name missing."}
                rep = asg.report_for(code, self.student, self.university)
                return {"ok": True, **_compact_report(rep)}
            if name == "get_my_scores":
                lp = self.req.localProgress
                out: dict[str, Any] = {
                    "ok": True, "sessions": lp.sessions, "average": lp.average,
                    "recent": [a.model_dump() for a in lp.recent[:8]], "skills": lp.skills,
                }
                if self.active and self.active in self.known and self.student and asg.get_assignment(self.active):
                    out["assignment"] = _compact_report(asg.report_for(self.active, self.student, self.university))
                return out
            if name == "email_report_to_teacher":
                code = self._code(args.get("code"))
                if not code:
                    return {"ok": False, "error": "No assignment to report on. Open your teacher's assignment link first."}
                note = str(args.get("note") or "").strip()[:300] or None
                res = await asg.email_report(code, self.student, self.university, note)
                rep = res.pop("report", None)
                out = {k: v for k, v in res.items() if k in ("ok", "via", "to", "teacherName", "reason", "remaining")}
                if rep:
                    out["summary"] = {"average": rep["average"], "verdict": rep["verdict"], "completed": rep["completed"], "total": rep["total"]}
                self.emailed = out
                return out
            if name == "list_assignments":
                rows = []
                for c in self.known:
                    a = asg.get_assignment(c)
                    if not a:
                        continue
                    rep = asg.build_report(a, self.student or "-", asg.attempts_for(c, self.student) if self.student else [])
                    rows.append({"code": c, "title": a["title"], "dueDate": a.get("dueDate"), "completed": rep["completed"],
                                 "total": rep["total"], "active": c == self.active})
                return {"ok": True, "assignments": rows}
            if name in ("ask_faculty", "ask_revision_plan"):
                return await self._desk(name, args)
            return {"ok": False, "error": f"unknown tool {name}"}
        except HTTPException as e:
            return {"ok": False, "error": str(e.detail)}


    async def _desk(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """What Priya cannot answer herself: a human or Teacher Iyer does, in the BAND room."""
        from agentroom import desk

        if self.desk is not None:
            return {"ok": True, "note": "already asked this turn"}
        if name == "ask_faculty":
            res = await desk.ask_faculty(str(args.get("question") or ""), student=self.student, lang=self.req.lang,
                                         side_id=self.req.deskRoom or "")
        else:
            code = self._code(args.get("code"))
            if code and self.student:
                rep = asg.report_for(code, self.student, self.university)
            else:  # no assignment: what this browser knows about the student's practice
                rep = {"student": self.student, "items": [a.model_dump() | {"bestScore": a.score} for a in self.req.localProgress.recent[:8]],
                       "domains": self.req.localProgress.skills, "weaknesses": []}
            res = await desk.revision_plan(rep, lang=self.req.lang)
        if res.get("sideId"):
            self.desk = {k: res[k] for k in ("sideId", "kind", "question", "asked", "ready", "plan") if k in res}
        return res


def _compact_report(rep: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": rep["code"], "title": rep["title"], "dueDate": rep["dueDate"], "passMark": rep["passMark"],
        "completed": rep["completed"], "total": rep["total"], "average": rep["average"], "verdict": rep["verdict"],
        "items": [{"label": i["label"], "status": i["status"], "bestScore": i["bestScore"]} for i in rep["items"]],
        "strengths": rep["strengths"][:3], "weaknesses": rep["weaknesses"][:3],
    }


def summarize(name: str, res: dict[str, Any]) -> str:
    if not res.get("ok"):
        return f"{name}: {res.get('error') or res.get('reason') or 'failed'}"
    if name == "get_assignment_status":
        avg = "-" if res.get("average") is None else f"{res['average']:.0f}"
        return f"{res['title']}: {res['completed']}/{res['total']} done, average {avg}, {res['verdict']}"
    if name == "get_my_scores":
        avg = "-" if res.get("average") is None else f"{res['average']:.0f}"
        return f"{res.get('sessions', 0)} sessions, average {avg}"
    if name == "email_report_to_teacher":
        return f"Report emailed to {res.get('teacherName') or 'the teacher'} ({res.get('to')}) via {res.get('via')}"
    if name == "list_assignments":
        return f"{len(res.get('assignments', []))} assignment(s)"
    if name == "ask_faculty":
        return f"Question sent to {res.get('asked') or 'faculty'} in the BAND room"
    if name == "ask_revision_plan":
        return f"Dr Iyer's plan: {res['plan']['topic']}" if res.get("plan") else "Asked Dr Iyer for a revision plan"
    return name


def _system_prompt(st: ReceptionState) -> str:
    ctx = {
        "student": st.student or None, "university": st.university or None,
        "activeAssignment": st.active, "joinedAssignments": st.known,
    }
    return (
        "You are Priya, the warm, efficient receptionist at the front desk of MedSim General Hospital, "
        "a medical training simulator. You help students with their teacher's assignments and scores. "
        "Use the tools to look things up or act; never invent scores, items or due dates. "
        "Call email_report_to_teacher only when the student asks to send, submit or email their report or results. "
        "You cannot email anyone except the assignment's teacher; if asked to email someone else, say so. "
        "You never answer for faculty: use ask_faculty, and only say what its result says. Use ask_revision_plan when they ask what to revise. "
        "After the tools, reply with ONE short spoken sentence or two (max 40 words), no markdown, no lists, "
        "numbers as words where natural. If the student is only chatting, just answer briefly without tools.\n"
        f"Context: {json.dumps(ctx)}"
    )


async def _run_native(st: ReceptionState, messages: list[dict[str, Any]], steps: list[dict[str, Any]]) -> str:
    provider: Optional[str] = None
    for _ in range(MAX_ITERATIONS):
        msg, provider = await chat(messages, tools=TOOL_SPECS, max_tokens=400, temperature=0.2, stick_to=provider)
        content = strip_think(msg.get("content") or "")
        calls = msg.get("tool_calls") or []
        if not calls:
            return content
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
            # A second email in the same turn is never needed.
            if name == "email_report_to_teacher" and st.emailed is not None:
                res = {"ok": st.emailed.get("ok", False), "note": "already sent this turn"}
            else:
                res = await st.execute(name, args)
                steps.append({"tool": name, "args": args, "ok": bool(res.get("ok")), "summary": summarize(name, res), "result": res})
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(res)})
    msg, _ = await chat(messages + [{"role": "user", "content": "Give the short spoken reply now."}], max_tokens=120, stick_to=provider)
    return strip_think(msg.get("content") or "")


ASK_FACULTY_RE = re.compile(
    r"\b(?:ask|message|tell|contact|reach|check with|talk to|speak to)\b.{0,40}\b(?:faculty|professor|prof|hod|examiner|teacher|sir|madam|ma'?am|doctor)\b"
    r"|\bquestion for (?:the |my )?(?:faculty|professor|teacher|sir|madam|ma'?am|hod)\b", re.I)
PLAN_RE = re.compile(r"\b(?:revision|study|practice|practise) plan\b|\bwhat (?:should|can|do) i (?:revise|study|practi[sc]e)\b|\bdr\.? ?iyer\b|\bhelp me revise\b", re.I)
EMAIL_RE = re.compile(r"\b(e-?mail|mail|send|submit|forward|share)\b", re.I)
STATUS_RE = re.compile(r"\b(status|progress|pending|left|remaining|done|due|assignment|homework|deadline)\b", re.I)
SCORE_RE = re.compile(r"\b(score|scores|marks|grade|grades|result|results|how am i doing|average|performance)\b", re.I)
LIST_RE = re.compile(r"\b(list|all|which|my assignments)\b", re.I)


def keyword_plan(utterance: str) -> list[tuple[str, dict[str, Any]]]:
    """Deterministic routing used when the LLM is unavailable."""
    u = utterance.lower()
    if PLAN_RE.search(u):
        return [("ask_revision_plan", {})]
    if ASK_FACULTY_RE.search(u) and not re.search(r"\b(report|result|results|score|scores)\b", u):
        return [("ask_faculty", {"question": utterance})]
    if EMAIL_RE.search(u) and re.search(r"\b(report|result|results|score|scores|teacher|sir|madam|ma'am|professor)\b", u):
        return [("get_assignment_status", {}), ("email_report_to_teacher", {})]
    if LIST_RE.search(u) and "assignment" in u:
        return [("list_assignments", {})]
    if SCORE_RE.search(u):
        return [("get_my_scores", {})]
    if STATUS_RE.search(u):
        return [("get_assignment_status", {})]
    return []


def fallback_reply(steps: list[dict[str, Any]]) -> str:
    if not steps:
        return "Hello! I can check your assignment progress, tell you your scores, or email your report to your teacher."
    last = steps[-1]
    res = last["result"]
    if res.get("spoken"):
        return res["spoken"]
    if last["tool"] == "email_report_to_teacher":
        if res.get("ok"):
            who = res.get("teacherName") or "your teacher"
            return f"Done! I've emailed your report to {who}. They'll see your scores and feedback in their inbox."
        return f"Sorry, I couldn't send the email. {res.get('reason') or res.get('error') or ''}".strip()
    if not res.get("ok"):
        return f"Hmm, {res.get('error') or 'I could not find that'}."
    if last["tool"] == "get_assignment_status":
        avg = "no score yet" if res.get("average") is None else f"an average of {res['average']:.0f}"
        return f"For {res['title']}, you've finished {res['completed']} of {res['total']}, with {avg}."
    if last["tool"] == "get_my_scores":
        avg = "no scores yet" if res.get("average") is None else f"an average of {res['average']:.0f}"
        return f"You've done {res.get('sessions', 0)} sessions so far, with {avg}."
    if last["tool"] == "list_assignments":
        n = len(res.get("assignments", []))
        return f"You have {n} assignment{'s' if n != 1 else ''} with me."
    return "All done."


@router.post("/agent/reception/act")
async def reception_act(req: ReceptionActRequest):
    st = ReceptionState(req)
    run_id = f"rx_{secrets.token_hex(4)}"
    steps: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = [{"role": "system", "content": _system_prompt(st)}]
    for m in req.history[-6:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:600]})
    messages.append({"role": "user", "content": req.utterance})
    final = ""
    source = "llm"
    try:
        final = await _run_native(st, messages, steps)
    except HTTPException as e:
        log.warning("reception LLM unavailable (%s); keyword routing", str(e.detail)[:120])
        source = "keywords"
        if not steps:
            for name, args in keyword_plan(req.utterance):
                res = await st.execute(name, args)
                steps.append({"tool": name, "args": args, "ok": bool(res.get("ok")), "summary": summarize(name, res), "result": res})
    final = re.sub(r"[*_`#]+", "", final or "").strip()
    spoken = final or fallback_reply(steps)
    # What a person or Dr Iyer will do is said in fixed words, in the student's language, never in the model's.
    fixed = next((s["result"]["spoken"] for s in reversed(steps) if s["tool"] in ("ask_faculty", "ask_revision_plan") and s["result"].get("spoken")), "")
    spoken = fixed or spoken
    return {
        "runId": run_id,
        "intent": "action" if steps else "none",
        "source": source,
        "steps": steps,
        "emailed": st.emailed,
        "desk": st.desk,
        "spokenConfirmation": spoken[:400],
    }
