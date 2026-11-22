"""Toolsets for the autonomous live voice agents (registered into agent_runtime).

  receptionist   Priya at Reception: assignment status, scores, email the report
                 to the assignment's teacher, list assignments, book a study
                 session in Google Calendar, text a plan to the student's phone.
  teacher        Dr. Iyer in the Teacher Portal: draw a lesson on the whiteboard,
                 pop a quiz, assign practice cases to the class, schedule a revision.
  viva-examiner  Prof. Kulkarni: record a per-answer grade, pick the next
                 question from the hidden plan, end the viva (final marking UI).
  followup       Asha's follow-up call (followup_tools, unchanged).

Executors only ever act on the session's own ctx (sent by the client at
/voice/start and /voice/context, validated in agent_runtime.clean_ctx): the
email goes to the assignment teacher only, the phone message only to the
contact the student saved in this browser. UI changes reach the page through
agent_events.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException

import agent_runtime as rt
import assignments as asg
import followup_tools
import reception
import teacher
import viva

_WAVEFORMS = set(teacher.WAVEFORM_PRESETS)
_CASE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")


def _clip(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def _key(text: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(text or "").lower()))


def _int(v: Any, lo: int, hi: int) -> Optional[int]:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- time words

_DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_PARTS = {"morning": 9, "afternoon": 14, "evening": 18, "tonight": 20, "night": 20, "noon": 12, "lunch": 13}


def resolve_when(when_text: str, in_days: Any = None, hour: Any = None, now: Optional[datetime] = None) -> datetime:
    """Start time (IST) from what the student said plus optional explicit fields.
    Explicit in_days / hour (24h) win; otherwise words like "tomorrow evening",
    "friday 7 pm", "in 3 days". Never in the past (moves to the next day)."""
    from integrations.calendar_invite import IST

    now = (now or datetime.now(IST)).astimezone(IST)
    t = (when_text or "").lower()
    days = _int(in_days, 0, 60)
    if days is None:
        if "day after tomorrow" in t:
            days = 2
        elif "tomorrow" in t:
            days = 1
        elif m := re.search(r"in (\d{1,2}) days?", t):
            days = int(m.group(1))
        elif "next week" in t:
            days = 7
        elif (d := next((i for i, n in enumerate(_DAYS) if n in t), None)) is not None:
            days = (d - now.weekday()) % 7 or 7
    h = _int(hour, 0, 23)
    minute = 0
    if h is None and (m := re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)", t)):
        h = int(m.group(1)) % 12 + (12 if m.group(3).startswith("p") else 0)
        minute = int(m.group(2) or 0) % 60
    if h is None:
        h = next((v for k, v in _PARTS.items() if k in t), None)
    if h is None:
        h = 18
    start = (now + timedelta(days=days or 0)).replace(hour=h, minute=minute, second=0, microsecond=0)
    if start <= now:
        start += timedelta(days=1)
    return start


def _start_text(dt: datetime) -> str:
    return dt.strftime("%a %d %b, %I:%M %p").replace(" 0", " ")


async def book_calendar(title: str, description: str, start: datetime, minutes: int, location: str) -> dict[str, Any]:
    from integrations import gcal_script

    res = await gcal_script.book_event(title, description, start, minutes=minutes, location=location)
    out = {"startText": _start_text(start), "startIso": start.isoformat(), "minutes": minutes}
    if res and res.get("ok", True):
        return {"ok": True, "calendarBooked": True, **out}
    return {"ok": False, "calendarBooked": False, "error": "Google Calendar is not connected right now", **out}


# ---------------------------------------------------------------- receptionist

def _reception_state(ctx: dict[str, Any]) -> reception.ReceptionState:
    prof = ctx.get("profile") if isinstance(ctx.get("profile"), dict) else {}
    raw = {
        "utterance": "(live voice turn)",
        "profile": {"name": _clip(prof.get("name"), 80), "university": _clip(prof.get("university"), 120)},
        "assignmentCode": _clip(ctx.get("assignmentCode"), 12) or None,
        "knownCodes": [_clip(c, 12) for c in (ctx.get("knownCodes") or []) if isinstance(c, str)][:20],
        "lang": _clip(ctx.get("lang"), 5) or None,
        "deskRoom": _clip(ctx.get("deskRoom"), 120) or None,
    }
    try:
        req = reception.ReceptionActRequest(**raw, localProgress=reception.LocalProgress(**(ctx.get("localProgress") or {})))
    except Exception:  # noqa: BLE001 - bad localProgress shape: drop it, keep the rest
        req = reception.ReceptionActRequest(**raw)
    return reception.ReceptionState(req)


def contact_of(ctx: dict[str, Any]) -> Optional[str]:
    """The student's own phone / email / Telegram, from ctx only. None when missing or invalid."""
    from integrations import notify

    c = _clip(ctx.get("contact"), 120)
    if not c:
        return None
    if notify.is_telegram(c) or notify.is_email(c) or notify.normalize_phone(c):
        return c
    return None


async def reception_exec(name: str, args: dict[str, Any], tctx: dict[str, Any]) -> dict[str, Any]:
    ctx = tctx["ctx"]
    if name in ("get_assignment_status", "get_my_scores", "list_assignments", "email_report_to_teacher"):
        st = _reception_state(ctx)
        res = await st.execute(name, args)
        if name == "email_report_to_teacher" and res.get("ok"):
            tctx["publish"]("report_emailed", {"code": st._code(args.get("code")), "to": res.get("to"),
                                                "teacherName": res.get("teacherName")})
        return res
    if name in ("ask_faculty", "ask_revision_plan"):
        st = _reception_state(ctx)
        st.req.lang = tctx.get("lang") or st.req.lang
        res = await st.execute(name, args)
        if st.desk:
            tctx["publish"]("desk_room", st.desk)  # the page follows the room and shows the answer when it comes
        out = {k: v for k, v in res.items() if k in ("ok", "error", "asked", "ready", "question")}
        return {**out, **({"say_this": res["spoken"]} if res.get("spoken") else {}), **({"plan": res["plan"]} if res.get("plan") else {})}
    if name == "book_study_session":
        topic = _clip(args.get("topic"), 80) or "revision"
        minutes = _int(args.get("minutes"), 15, 180) or 60
        start = resolve_when(_clip(args.get("when_text"), 80), args.get("in_days"), args.get("hour"))
        res = await book_calendar(f"Study: {topic}", f"MedSim study session booked by Priya at Reception. Topic: {topic}.",
                                  start, minutes, "MedSim study session")
        tctx["publish"]("calendar", {"title": f"Study: {topic}", "startText": res["startText"], "booked": res["calendarBooked"]})
        return {**res, "topic": topic}
    if name == "send_to_my_phone":
        from integrations import notify

        text = _clip(args.get("text"), 600)
        if not text:
            return {"ok": False, "error": "nothing to send"}
        dest = contact_of(ctx)
        if not dest:
            return {"ok": False, "error": "No phone or Telegram saved in this browser. Add one in Settings first."}
        res = await notify.send_to_patient("auto", dest, f"MedSim, from Priya at Reception: {text}")
        return {"ok": bool(res.get("ok")), "to": notify.mask(dest), "channel": res.get("channel"),
                **({} if res.get("ok") else {"error": _clip(res.get("error") or res.get("reason") or "send failed", 160)})}
    return {"ok": False, "error": f"unknown tool {name}"}


def reception_summary(name: str, res: dict[str, Any]) -> str:
    if name in ("get_assignment_status", "get_my_scores", "list_assignments", "email_report_to_teacher", "ask_faculty", "ask_revision_plan"):
        try:
            return reception.summarize(name, res)
        except Exception:  # noqa: BLE001
            return name
    if name == "book_study_session":
        when = res.get("startText") or "?"
        return f"Study session {when} " + ("booked in Google Calendar" if res.get("calendarBooked") else "(calendar not connected)")
    if name == "send_to_my_phone":
        return f"Sent to {res.get('to')}" if res.get("ok") else f"send_to_my_phone: {res.get('error') or 'failed'}"
    return name


RECEPTION_TOOLS = reception.TOOL_SPECS + [
    {"type": "function", "function": {
        "name": "book_study_session",
        "description": "Block time in the student's Google Calendar to study or revise a topic. Use when they say they are free "
                       "at some time or ask you to plan / block / book study time.",
        "parameters": {"type": "object", "properties": {
            "topic": {"type": "string", "description": "What they will study, e.g. 'cardiology revision'"},
            "when_text": {"type": "string", "description": "What they said, e.g. 'tomorrow evening'"},
            "minutes": {"type": "integer", "minimum": 15, "maximum": 180, "description": "Length, default 60"},
            "in_days": {"type": "integer", "minimum": 0, "maximum": 60, "description": "Days from today when clear"},
            "hour": {"type": "integer", "minimum": 0, "maximum": 23, "description": "Start hour, 24h, India time, when clear"},
        }, "required": ["topic", "when_text"]},
    }},
    {"type": "function", "function": {
        "name": "send_to_my_phone",
        "description": "Text a short message (a study plan, a reminder, their pending items) to the student's own phone or "
                       "Telegram saved in this browser. There is no recipient: it only goes to the student.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string", "description": "The message, plain text, at most 3 short sentences"},
        }, "required": ["text"]},
    }},
]

RECEPTION_ADDENDUM = (
    "TOOLS: You act yourself during this call with your tools: get_assignment_status, get_my_scores, list_assignments, "
    "email_report_to_teacher, book_study_session, send_to_my_phone, ask_faculty, ask_revision_plan. Ignore any instruction above saying a separate "
    "system does the actions. Decide on your own when a tool helps; you may chain them in one turn (for example book a "
    "study session and then text the plan). Email only goes to the assignment's teacher and only when the student asks "
    "to send or submit their report. Never claim an action happened unless the tool result says ok. After tools, answer "
    "in one or two short spoken sentences. "
    "INTENT, NOT KEYWORDS: act on loose phrasing. 'how'm I doing', 'kitna bacha hai', 'am I on track', 'what's left' "
    "-> get_assignment_status (or get_my_scores for practice marks). 'send this to sir', 'give it to ma'am', 'submit "
    "kar do', 'mail my report' -> email_report_to_teacher. 'block time to study cardiology tomorrow', 'remind me to "
    "revise renal on Sunday', 'slot for pharma tonight' -> book_study_session (pass what they said as when_text). "
    "'text me that', 'WhatsApp it', 'send it to my phone', 'remind me' with no time -> send_to_my_phone. If a "
    "request needs a time or topic you can guess from context, guess and confirm in the same reply instead of asking. "
    "'ask sir if...', 'sir ko pooch lo', 'check with faculty', anything only a person can decide -> ask_faculty with the whole question. "
    "'what should I revise', 'plan bana do', 'ask Dr Iyer' -> ask_revision_plan. Never answer for faculty or invent their reply. When a tool "
    "result has say_this, say exactly that sentence and nothing else. "
    "PROACTIVE BUT BOUNDED: at most ONE helpful action nobody asked for per session, only when strongly implied "
    "(for example they say they will study tonight and nothing is booked: offer, or text them the plan once)."
)

rt.register(rt.AgentToolset(
    kind="receptionist",
    tools=RECEPTION_TOOLS,
    executor=reception_exec,
    fillers={
        "email_report_to_teacher": {"en": "Sure, sending it to your teacher now.", "hi": "ज़रूर, अभी आपके टीचर को भेज रही हूँ।",
                                    "kn": "ಖಂಡಿತ, ಈಗಲೇ ನಿಮ್ಮ ಟೀಚರ್‌ಗೆ ಕಳಿಸ್ತಿದ್ದೀನಿ.", "ta": "சரி, இப்பவே உங்க டீச்சருக்கு அனுப்பறேன்.",
                                    "te": "తప్పకుండా, ఇప్పుడే మీ టీచర్‌కి పంపిస్తున్నాను.", "mr": "नक्की, आत्ताच तुमच्या टीचरना पाठवते आहे.",
                                    "bn": "অবশ্যই, এখনই আপনার টিচারকে পাঠাচ্ছি।"},
        "book_study_session": {"en": "Achha, let me block that in your calendar.", "hi": "अच्छा, मैं आपके कैलेंडर में समय रख रही हूँ।",
                               "kn": "ಸರಿ, ನಿಮ್ಮ ಕ್ಯಾಲೆಂಡರ್‌ನಲ್ಲಿ ಸಮಯ ಇಡ್ತಿದ್ದೀನಿ.", "ta": "சரி, உங்க காலண்டர்ல நேரம் போடறேன்.",
                               "te": "సరే, మీ క్యాలెండర్‌లో సమయం పెడుతున్నాను.", "mr": "बरं, तुमच्या कॅलेंडरमध्ये वेळ ठेवते आहे.",
                               "bn": "আচ্ছা, আপনার ক্যালেন্ডারে সময় রেখে দিচ্ছি।"},
        "send_to_my_phone": {"en": "One moment, texting you now.", "hi": "एक पल, अभी आपको भेज रही हूँ।",
                             "kn": "ಒಂದು ಕ್ಷಣ, ಈಗಲೇ ನಿಮಗೆ ಕಳಿಸ್ತೀನಿ.", "ta": "ஒரு நிமிஷம், இப்பவே உங்களுக்கு அனுப்பறேன்.",
                             "te": "ఒక్క క్షణం, ఇప్పుడే మీకు పంపిస్తున్నాను.", "mr": "एक क्षण, आत्ताच तुम्हाला पाठवते.",
                             "bn": "এক মুহূর্ত, এখনই আপনাকে পাঠাচ্ছি।"},
        "ask_faculty": {"en": "Sure, I am asking faculty now.", "hi": "ज़रूर, अभी फ़ैकल्टी से पूछ रही हूँ।",
                        "kn": "ಖಂಡಿತ, ಈಗಲೇ ಫ್ಯಾಕಲ್ಟಿಯನ್ನು ಕೇಳ್ತಿದ್ದೀನಿ.", "ta": "சரி, இப்பவே பேராசிரியர்கிட்ட கேட்கறேன்.",
                        "te": "తప్పకుండా, ఇప్పుడే ఫ్యాకల్టీని అడుగుతున్నాను.", "mr": "नक्की, आत्ताच फॅकल्टीला विचारते.",
                        "bn": "অবশ্যই, এখনই ফ্যাকাল্টিকে জিজ্ঞেস করছি।"},
        "ask_revision_plan": {"en": "One moment, I am asking Dr Iyer.", "hi": "एक पल, मैं डॉक्टर अय्यर से पूछ रही हूँ।",
                              "kn": "ಒಂದು ಕ್ಷಣ, ಡಾಕ್ಟರ್ ಅಯ್ಯರ್ ಅವರನ್ನು ಕೇಳ್ತಿದ್ದೀನಿ.", "ta": "ஒரு நிமிஷம், டாக்டர் ஐயர்கிட்ட கேட்கறேன்.",
                              "te": "ఒక్క క్షణం, డాక్టర్ అయ్యర్ గారిని అడుగుతున్నాను.", "mr": "एक क्षण, डॉक्टर अय्यर यांना विचारते.",
                              "bn": "এক মুহূর্ত, ডাক্তার আইয়ারকে জিজ্ঞেস করছি।"},
        "get_assignment_status": {"en": "One moment, let me check.", "hi": "एक पल, मैं देखती हूँ।",
                                  "kn": "ಒಂದು ಕ್ಷಣ, ನೋಡ್ತೀನಿ.", "ta": "ஒரு நிமிஷம், பார்க்கறேன்.",
                                  "te": "ఒక్క క్షణం, చూస్తాను.", "mr": "एक क्षण, बघते.", "bn": "এক মুহূর্ত, দেখছি।"},
    },
    system_addendum=RECEPTION_ADDENDUM,
    max_rounds=3,
    idempotent={
        "email_report_to_teacher": lambda a: _key(a.get("code")) or "active",
        "book_study_session": lambda a: f"{_key(a.get('topic'))}|{_key(a.get('when_text'))}|{a.get('in_days')}|{a.get('hour')}",
        "send_to_my_phone": lambda a: _key(a.get("text")),
        "ask_faculty": lambda a: re.sub(r"\s+", " ", str(a.get("question") or "")).strip().lower(),
        "ask_revision_plan": lambda a: _key(a.get("code")) or "active",
    },
    ctx_keys=("assignmentCode", "knownCodes", "profile", "localProgress", "contact", "lang", "deskRoom"),
    summarize=reception_summary,
))


# ---------------------------------------------------------------- teacher

def _catalog(ctx: dict[str, Any]) -> dict[str, list[list[str]]]:
    cat = ctx.get("catalog")
    return cat if isinstance(cat, dict) else {}


def _specialty_key(s: str) -> str:
    return re.sub(r"[^a-z]+", "-", s.lower()).strip("-")


def practice_items(ctx: dict[str, Any], case_ids: Any, specialty: Any) -> list[dict[str, Any]]:
    """Assignment items from explicit case ids (checked against the client catalog when present)
    or the first cases of a specialty from that catalog."""
    cat = _catalog(ctx)
    labels = {row[0]: (row[1] if len(row) > 1 else row[0]) for rows in cat.values() if isinstance(rows, list)
              for row in rows if isinstance(row, list) and row and isinstance(row[0], str)}
    spec_of = {row[0]: spec for spec, rows in cat.items() if isinstance(rows, list)
               for row in rows if isinstance(row, list) and row and isinstance(row[0], str)}
    items: list[dict[str, Any]] = []
    ids = case_ids if isinstance(case_ids, list) else ([case_ids] if isinstance(case_ids, str) and case_ids else [])
    for cid in ids[:5]:
        c = _clip(cid, 40).lower()
        if not _CASE_ID_RE.match(c) or (cat and c not in labels):
            continue
        items.append({"kind": "case", "caseId": c, "label": labels.get(c, c), "specialty": spec_of.get(c)})
    if not items and specialty:
        want = _specialty_key(str(specialty))
        for spec, rows in cat.items():
            if _specialty_key(spec) == want or want in _specialty_key(spec):
                for row in (rows or [])[:3]:
                    if isinstance(row, list) and row and isinstance(row[0], str) and _CASE_ID_RE.match(row[0]):
                        items.append({"kind": "case", "caseId": row[0], "label": row[1] if len(row) > 1 else row[0],
                                      "specialty": spec})
                break
    return items


async def teacher_exec(name: str, args: dict[str, Any], tctx: dict[str, Any]) -> dict[str, Any]:
    ctx = tctx["ctx"]
    if name == "draw_on_board":
        topic = _clip(args.get("topic"), 80)
        if len(topic) < 2:
            return {"ok": False, "error": "say which topic to draw"}
        preset = _clip(args.get("preset"), 40).lower().replace(" ", "-").replace("_", "-") or None
        preset = preset if preset in _WAVEFORMS else None
        tctx["publish"]("whiteboard", {"topic": topic, "preset": preset})
        return {"ok": True, "topic": topic, "preset": preset,
                "note": "The board is being drawn now; the steps are narrated automatically. Briefly introduce the topic."}
    if name == "start_quiz":
        question = _clip(args.get("question"), 200)
        options = [_clip(o, 80) for o in (args.get("options") or []) if _clip(o, 80)][:4]
        if not question or len(options) < 2:
            return {"ok": False, "error": "a quiz needs a question and 2 to 4 options"}
        idx = teacher._answer_index(args.get("answer"), options)
        if idx is None:
            return {"ok": False, "error": "answer must be the index, letter or text of one option"}
        tctx["publish"]("quiz", {"question": question, "options": options, "answerIndex": idx,
                                 "why": _clip(args.get("why"), 200)})
        return {"ok": True, "shown": True, "options": len(options),
                "note": "The quiz is on screen. Read the question out and wait; do not reveal the answer."}
    if name == "assign_practice":
        items = practice_items(ctx, args.get("case_ids"), args.get("specialty"))
        if not items:
            return {"ok": False, "error": "no matching cases: give case ids or a specialty like cardiology"}
        due_days = _int(args.get("in_days"), 0, 60)
        due = resolve_when(_clip(args.get("due_text"), 60) or "in 7 days", due_days if due_days is not None else None, 23)
        title = _clip(args.get("title"), 100) or f"Practice: {items[0].get('specialty') or items[0]['label']}"[:100]
        email = _clip(ctx.get("teacherEmail"), 120)
        try:
            a = asg.create_assignment(asg.AssignmentIn(
                title=title if len(title) >= 2 else "Practice cases", items=[asg.ItemIn(**i) for i in items],
                dueDate=due.date().isoformat(), teacherName=_clip(ctx.get("teacherName"), 80) or "Dr. Meera Iyer",
                teacherEmail=email if asg.EMAIL_RE.match(email) else asg.DEFAULT_TEACHER_EMAIL,
            ))
        except (HTTPException, ValueError) as e:
            return {"ok": False, "error": _clip(getattr(e, "detail", e), 160)}
        tctx["publish"]("assignment", {"code": a["code"], "link": f"/?assignment={a['code']}", "title": a["title"],
                                       "dueDate": a["dueDate"], "items": len(a["items"])})
        return {"ok": True, "code": a["code"], "title": a["title"], "dueDate": a["dueDate"], "items": len(a["items"]),
                "spokenCode": " ".join(a["code"])}
    if name == "schedule_revision":
        topic = _clip(args.get("topic"), 80) or "revision"
        start = resolve_when(_clip(args.get("when_text"), 80), args.get("in_days"), args.get("hour"))
        res = await book_calendar(f"Revise: {topic}", f"Revision planned with Dr. Iyer in MedSim. Topic: {topic}.",
                                  start, _int(args.get("minutes"), 15, 180) or 45, "MedSim revision")
        tctx["publish"]("calendar", {"title": f"Revise: {topic}", "startText": res["startText"], "booked": res["calendarBooked"]})
        return {**res, "topic": topic}
    return {"ok": False, "error": f"unknown tool {name}"}


def teacher_summary(name: str, res: dict[str, Any]) -> str:
    if not res.get("ok"):
        return f"{name}: {res.get('error') or 'failed'}"
    if name == "draw_on_board":
        return f"Drew {res.get('topic')} on the board"
    if name == "start_quiz":
        return "Quiz shown on screen"
    if name == "assign_practice":
        return f"Assignment created: {res.get('code')} ({res.get('items')} cases, due {res.get('dueDate')})"
    if name == "schedule_revision":
        return f"Revision of {res.get('topic')} booked for {res.get('startText')}"
    return name


TEACHER_TOOLS = [
    {"type": "function", "function": {
        "name": "draw_on_board",
        "description": "Draw a full lesson on the whiteboard (diagram plus narrated steps). Use whenever the student wants "
                       "to learn, see or revise a topic, or when a diagram would explain your answer better.",
        "parameters": {"type": "object", "properties": {
            "topic": {"type": "string", "description": "Short topic title, e.g. 'Cardiac cycle'"},
            "preset": {"type": "string", "enum": list(teacher.WAVEFORM_PRESETS),
                       "description": "Optional physiology curve to show"},
        }, "required": ["topic"]},
    }},
    {"type": "function", "function": {
        "name": "start_quiz",
        "description": "Put a multiple-choice question on screen to check understanding. Offer one on your own "
                       "after you finish teaching a topic, or when the student says 'test me', 'quiz me', 'ask me'.",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string"},
            "options": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4},
            "answer": {"type": "integer", "description": "0-based index of the correct option"},
            "why": {"type": "string", "description": "One-line explanation shown after answering"},
        }, "required": ["question", "options", "answer"]},
    }},
    {"type": "function", "function": {
        "name": "assign_practice",
        "description": "Create a class assignment of practice cases (a 6-character code students join). Use when the "
                       "teacher asks in any words: assign, homework, 'give the class some cases', 'something for Friday'.",
        "parameters": {"type": "object", "properties": {
            "case_ids": {"type": "array", "items": {"type": "string"}, "description": "Case ids if named"},
            "specialty": {"type": "string", "description": "Or a specialty, e.g. 'cardiology'"},
            "due_text": {"type": "string", "description": "When it is due, e.g. 'next friday'"},
            "in_days": {"type": "integer", "minimum": 0, "maximum": 60},
            "title": {"type": "string"},
        }, "required": []},
    }},
    {"type": "function", "function": {
        "name": "schedule_revision",
        "description": "Book a revision slot for a topic in Google Calendar.",
        "parameters": {"type": "object", "properties": {
            "topic": {"type": "string"},
            "when_text": {"type": "string", "description": "What was said, e.g. 'sunday morning'"},
            "in_days": {"type": "integer", "minimum": 0, "maximum": 60},
            "hour": {"type": "integer", "minimum": 0, "maximum": 23},
        }, "required": ["topic", "when_text"]},
    }},
]

TEACHER_ADDENDUM = (
    "TOOLS: You act yourself during this call: draw_on_board, start_quiz, assign_practice, schedule_revision. Decide on "
    "your own when a tool helps; nobody needs to say a keyword. When the student wants to learn or see a topic, call "
    "draw_on_board instead of explaining it all in words. Check understanding now and then with start_quiz. Only call "
    "assign_practice when asked to set work for the class. After tools, one or two short spoken sentences; never read "
    "codes or JSON aloud except an assignment code letter by letter. "
    "INTENT, NOT KEYWORDS: 'I'm weak in ECG', 'acid base confuses me', 'what's the deal with heart failure', "
    "'samjhao na murmurs', or any mention of struggling with a topic -> draw_on_board for that topic. After you finish "
    "teaching a topic, offer a quick check and call start_quiz with one question on it. 'give the class some cases', "
    "'homework for Friday', 'set them cardio', 'something to practise this week' -> assign_practice (guess the "
    "specialty from the lesson topic and pass the due words as due_text). 'remind me to revise this on Sunday', 'put "
    "it in my calendar' -> schedule_revision. If the student talks over you, stop and answer them; do not restart the "
    "lecture. PROACTIVE BUT BOUNDED: at most ONE helpful tool action nobody asked for per session, only when strongly "
    "implied (usually the quiz after a lesson)."
)

rt.register(rt.AgentToolset(
    kind="teacher",
    tools=TEACHER_TOOLS,
    executor=teacher_exec,
    fillers={
        "draw_on_board": {"en": "Achha, let me draw that on the board.", "hi": "अच्छा, मैं इसे बोर्ड पर बनाती हूँ।",
                          "kn": "ಸರಿ, ಇದನ್ನ ಬೋರ್ಡ್ ಮೇಲೆ ಬರೀತೀನಿ.", "ta": "சரி, இதை போர்டுல வரையறேன்.",
                          "te": "సరే, దీన్ని బోర్డు మీద గీస్తాను.", "mr": "बरं, हे बोर्डवर काढते.", "bn": "আচ্ছা, এটা বোর্ডে এঁকে দেখাচ্ছি।"},
        "assign_practice": {"en": "One moment, I'm setting that for the class.", "hi": "एक पल, मैं क्लास के लिए सेट कर रही हूँ।",
                            "kn": "ಒಂದು ಕ್ಷಣ, ಕ್ಲಾಸ್‌ಗೆ ಇದನ್ನ ಕೊಡ್ತಿದ್ದೀನಿ.", "ta": "ஒரு நிமிஷம், கிளாஸுக்கு இதை செட் பண்றேன்.",
                            "te": "ఒక్క క్షణం, క్లాస్ కోసం దీన్ని సెట్ చేస్తున్నాను.", "mr": "एक क्षण, वर्गासाठी हे सेट करते आहे.",
                            "bn": "এক মুহূর্ত, ক্লাসের জন্য এটা সেট করছি।"},
        "schedule_revision": {"en": "Let me put that in the calendar.", "hi": "मैं इसे कैलेंडर में डालती हूँ।",
                              "kn": "ಇದನ್ನ ಕ್ಯಾಲೆಂಡರ್‌ಗೆ ಹಾಕ್ತೀನಿ.", "ta": "இதை காலண்டர்ல போடறேன்.",
                              "te": "దీన్ని క్యాలెండర్‌లో పెడతాను.", "mr": "हे कॅलेंडरमध्ये ठेवते.", "bn": "এটা ক্যালেন্ডারে রেখে দিচ্ছি।"},
    },
    system_addendum=TEACHER_ADDENDUM,
    max_rounds=2,
    idempotent={
        "draw_on_board": lambda a: _key(a.get("topic")),
        "start_quiz": lambda a: _key(a.get("question")),
        "assign_practice": lambda a: "|".join(sorted(_key(c) for c in (a.get("case_ids") or []) if isinstance(c, str)))
        + "|" + _key(a.get("specialty")),
        "schedule_revision": lambda a: f"{_key(a.get('topic'))}|{_key(a.get('when_text'))}",
    },
    ctx_keys=("topic", "level", "lessonId", "teacherEmail", "teacherName", "catalog", "lang"),
    summarize=teacher_summary,
))


# ---------------------------------------------------------------- viva examiner

def _plan(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for i, q in enumerate(ctx.get("plan") or []):
        if isinstance(q, dict) and _clip(q.get("q"), 300):
            out.append({"index": i, "q": _clip(q.get("q"), 300), "difficulty": viva._difficulty(q.get("difficulty"))})
    return out[:12]


async def viva_exec(name: str, args: dict[str, Any], tctx: dict[str, Any]) -> dict[str, Any]:
    data = tctx["state"]["data"]
    grades: list[dict[str, Any]] = data.setdefault("grades", [])
    if data.get("ended") and name != "end_viva":
        return {"ok": False, "error": "the viva has ended"}
    if name == "record_answer_grade":
        question = _clip(args.get("question"), 240)
        if not question:
            return {"ok": False, "error": "question is required"}
        score = _int(args.get("score"), 0, 10)
        if score is None:
            return {"ok": False, "error": "score must be 0 to 10"}
        hit = [_clip(x, 120) for x in (args.get("key_points_hit") or []) if _clip(x, 120)][:6]
        missed = [_clip(x, 120) for x in (args.get("missed") or []) if _clip(x, 120)][:6]
        rec = {"question": question, "score": score, "hit": hit, "missed": missed}
        k = _key(question)
        for i, g in enumerate(grades):
            if _key(g["question"]) == k:  # re-marked: replace, never double count
                grades[i] = rec
                break
        else:
            grades.append(rec)
            del grades[:-20]
        tctx["publish"]("viva_grade", {**rec, "count": len(grades)})
        avg = round(sum(g["score"] for g in grades) / len(grades), 1)
        return {"ok": True, "recorded": len(grades), "runningAverage": avg}
    if name == "next_question":
        diff = viva._difficulty(args.get("difficulty"))
        plan = _plan(tctx["ctx"])
        asked: list[int] = data.setdefault("asked", [])
        if not plan:
            return {"ok": True, "question": None, "difficulty": diff,
                    "guidance": f"No question paper yet: ask one {['', 'easy', 'medium', 'hard'][diff]} question on "
                                f"{_clip(tctx['ctx'].get('subject'), 80) or 'the subject'}."}
        left = [q for q in plan if q["index"] not in asked]
        if not left:
            return {"ok": True, "question": None, "remaining": 0, "guidance": "All planned questions are asked: close the viva with end_viva."}
        pick = next((q for q in left if q["difficulty"] == diff), None) or min(left, key=lambda q: abs(q["difficulty"] - diff))
        asked.append(pick["index"])
        tctx["publish"]("viva_question", {"index": pick["index"], "difficulty": pick["difficulty"]})
        return {"ok": True, "question": pick["q"], "index": pick["index"], "difficulty": pick["difficulty"],
                "remaining": len(left) - 1}
    if name == "end_viva":
        if data.get("ended"):
            return {"ok": True, "alreadyEnded": True}
        data["ended"] = True
        summary = _clip(args.get("summary"), 400)
        avg = round(sum(g["score"] for g in grades) / len(grades), 1) if grades else None
        tctx["publish"]("viva_end", {"summary": summary, "graded": len(grades), "average": avg})
        return {"ok": True, "ended": True, "note": "Say a brief, polite closing line (for example 'That will be all, thank you')."}
    return {"ok": False, "error": f"unknown tool {name}"}


def viva_summary(name: str, res: dict[str, Any]) -> str:
    if not res.get("ok"):
        return f"{name}: {res.get('error') or 'failed'}"
    if name == "record_answer_grade":
        return f"Answer marked ({res.get('recorded')} so far, average {res.get('runningAverage')}/10)"
    if name == "next_question":
        return f"Next question #{(res.get('index') or 0) + 1}" if res.get("question") else "Next question (free choice)"
    if name == "end_viva":
        return "Viva ended"
    return name


VIVA_TOOLS = [
    {"type": "function", "function": {
        "name": "record_answer_grade",
        "description": "Silently mark the student's answer to the question you just asked, as soon as they finish answering. "
                       "Call it once per answered question, then go on (ask the next question or a follow-up).",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string", "description": "The question you asked, short"},
            "score": {"type": "integer", "minimum": 0, "maximum": 10},
            "key_points_hit": {"type": "array", "items": {"type": "string"}},
            "missed": {"type": "array", "items": {"type": "string"}},
        }, "required": ["question", "score"]},
    }},
    {"type": "function", "function": {
        "name": "next_question",
        "description": "Get the next question from your hidden question paper at a difficulty: go harder after a strong "
                       "answer, easier after a weak one.",
        "parameters": {"type": "object", "properties": {
            "difficulty": {"type": "string", "enum": ["easy", "medium", "hard"]},
        }, "required": ["difficulty"]},
    }},
    {"type": "function", "function": {
        "name": "end_viva",
        "description": "End the viva when the paper is done, time is up, or the student asks to stop. Opens the marking sheet.",
        "parameters": {"type": "object", "properties": {
            "summary": {"type": "string", "description": "One-line overall impression"},
        }, "required": []},
    }},
]

VIVA_ADDENDUM = (
    "TOOLS: You run this viva yourself with tools. After each answer call record_answer_grade (silently, never say the "
    "score aloud), then next_question with a difficulty that adapts to how they did, and ask that question in your own "
    "words. When the paper is done or the student wants to stop, call end_viva and close politely. Tool results are "
    "private notes; never read them out. "
    "AUTOMATIC: grade every answer with record_answer_grade without being asked, judging the meaning even when the "
    "wording is loose, Hinglish or mis-heard (credit 'beta blocker slows heart' as knowing the mechanism). Adapt: "
    "'hard' after a strong answer, 'easy' after a weak one or 'I don't know'. 'That's enough', 'stop', 'I'm done', "
    "'bas', 'can we finish', 'I need to go' -> end_viva at once and close in one polite sentence. Never say you did "
    "not understand; if an answer is empty, say 'Hmm? Go on.' PROACTIVE BUT BOUNDED: at most ONE unrequested action "
    "per session beyond grading and the next question (for example ending early when time is clearly up)."
)

rt.register(rt.AgentToolset(
    kind=viva.VIVA_CASE_ID,
    tools=VIVA_TOOLS,
    executor=viva_exec,
    fillers={},  # an examiner does not narrate his marking
    system_addendum=VIVA_ADDENDUM,
    max_rounds=2,
    fallback={"en": "Hmm. Let us move on. Tell me, what else do you know about this topic?",
              "hi": "हम्म। आगे बढ़ते हैं। बताइए, इस विषय के बारे में और क्या जानते हैं?",
              "kn": "ಹ್ಮ್. ಮುಂದೆ ಹೋಗೋಣ. ಈ ವಿಷಯದ ಬಗ್ಗೆ ಇನ್ನೇನು ಗೊತ್ತು, ಹೇಳಿ?",
              "ta": "ம்ம். அடுத்ததுக்கு போவோம். இந்த விஷயத்தைப் பத்தி வேற என்ன தெரியும், சொல்லுங்க?",
              "te": "హ్మ్. ముందుకు వెళ్దాం. ఈ విషయం గురించి ఇంకా ఏం తెలుసు, చెప్పండి?",
              "mr": "हं. पुढे जाऊया. या विषयाबद्दल आणखी काय माहीत आहे, सांगा?",
              "bn": "হুম। এগোনো যাক। এই বিষয়ে আর কী জানেন, বলুন?"},
    idempotent={},
    ctx_keys=("subject", "year", "topic", "plan", "lang"),
    summarize=viva_summary,
))


# ---------------------------------------------------------------- followup (unchanged loop)

rt.register(rt.AgentToolset(
    kind="followup",
    tools=followup_tools.TOOLS,
    handler=lambda payload, meta, model: followup_tools.handle(payload, meta, model),
))
