"""@medsim_asha_bot as a conversational case-authoring agent.

A long-polling loop (getUpdates, timeout=25) runs from the FastAPI lifespan when
TELEGRAM_BOT_TOKEN is set and TELEGRAM_BOT_POLLING != "0". Polling consumes
updates, so this module also keeps the chat cache notify.py used to build from
getUpdates ('telegram' -> latest chat, '@username' -> chat id): see known_chat().

Conversation (per chat, in memory, 30 min TTL), one question at a time:
  specialty -> name -> age -> sex -> complaint -> severity -> onset -> history
  -> allergies -> medicines -> intended diagnosis -> vitals -> summary
  [Create] [Edit] [Cancel]
Create runs case_author.generate_case (LLM + checks + one repair round) and stores
the case in custom_cases. With BAND configured the case first goes to a review room
(agentroom/casereview.py): pharmacy and lab check it, a person approves or rejects
it, and the author is told here; "Publish unreviewed" is the author's own choice.
Without BAND it is published at once. The reply carries a link that opens it in MedSim.

Commands: /start, /help, /newpatient (or "create a patient", "new case"),
/cancel, /list, /publish <id>, /delete <id>.
"""
from __future__ import annotations

import asyncio
import html
import logging
import os
import re
import sys
import time
from typing import Any, Callable, Optional

import httpx

import case_author
import catalog
import custom_cases
from agentroom import casereview

log = logging.getLogger("medsim.telegram_bot")

TG_API = "https://api.telegram.org"
POLL_TIMEOUT_S = 25
SESSION_TTL_S = 30 * 60
BACKOFF_S = 5.0

_chats: dict[str, int] = {}
_sessions: dict[int, dict[str, Any]] = {}
_offset: dict[str, Optional[int]] = {"next": None}
_jobs: set[asyncio.Task] = set()
_task: Optional[asyncio.Task] = None


def _token() -> str:
    return os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


def enabled() -> bool:
    # Never poll the live bot from a test run (it would consume real updates).
    under_test = "unittest" in (sys.argv[0] if sys.argv else "") or "pytest" in sys.modules
    return bool(_token()) and os.environ.get("TELEGRAM_BOT_POLLING", "1").strip() != "0" and not under_test


def _url(method: str) -> str:
    return f"{TG_API}/bot{_token()}/{method}"


def _client_factory(timeout: float = 15.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout)


def app_url() -> str:
    """Base URL of the MedSim web app for the links the bot sends."""
    for env in ("APP_URL", "PUBLIC_URL"):
        v = os.environ.get(env, "").strip().rstrip("/")
        if v.startswith(("https://", "http://")):
            return v
    try:
        import llm_proxy

        v = llm_proxy.public_url()
        if v:
            return v
    except Exception:  # noqa: BLE001
        pass
    return "http://localhost:5173"


# ------------------------------------------------------------------ chat cache (notify hook)

def remember_chat(chat: dict[str, Any]) -> None:
    cid = chat.get("id")
    if not isinstance(cid, int):
        return
    if chat.get("username"):
        _chats["@" + str(chat["username"]).lower()] = cid
    _chats["telegram"] = cid


def known_chat(dest: str) -> Optional[int]:
    """'telegram' / 'tg' -> the latest chat seen, '@user' -> that user's chat. None when unknown."""
    d = (dest or "").strip().lower()
    if d in ("tg", "telegram"):
        return _chats.get("telegram")
    if d.startswith("@"):
        return _chats.get(d)
    return None


def polling_active() -> bool:
    return _task is not None and not _task.done()


# ------------------------------------------------------------------ telegram api

async def api(method: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        async with _client_factory() as c:
            r = await c.post(_url(method), json=payload)
        body = r.json() if r.content else {}
        if not body.get("ok"):
            log.warning("telegram %s failed: HTTP %s", method, r.status_code)
        return body
    except Exception as e:  # noqa: BLE001
        log.warning("telegram %s failed: %s", method, type(e).__name__)
        return {"ok": False}


def reply_keyboard(rows: list[list[str]], placeholder: str = "") -> dict[str, Any]:
    kb: dict[str, Any] = {"keyboard": [[{"text": t} for t in row] for row in rows],
                          "resize_keyboard": True, "one_time_keyboard": True}
    if placeholder:
        kb["input_field_placeholder"] = placeholder[:64]
    return kb


REMOVE_KEYBOARD = {"remove_keyboard": True}


def inline_keyboard(rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in row] for row in rows]}


async def send(chat_id: int, text: str, markup: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                               "disable_web_page_preview": True}
    if markup:
        payload["reply_markup"] = markup
    return await api("sendMessage", payload)


# ------------------------------------------------------------------ input parsers
# Each returns (value, error). error=None means accepted.

class Bad(Exception):
    pass


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower().replace("&", " and ")).strip()


def parse_specialty(text: str) -> str:
    t = _norm(text)
    if not t:
        raise Bad("Pick a specialty from the keyboard.")
    specs = catalog.specialties()
    for s in specs:
        if t in (_norm(s["label"]), _norm(s["id"])):
            return s["id"]
    hits = [s for s in specs if _norm(s["label"]).startswith(t) or _norm(s["id"]).startswith(t)]
    if len(hits) == 1:
        return hits[0]["id"]
    hits = [s for s in specs if t in _norm(s["label"])]
    if len(hits) == 1:
        return hits[0]["id"]
    raise Bad("I don't know that specialty. Pick one from the keyboard.")


def parse_name(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    if not 2 <= len(t) <= 60 or not all(ch.isalpha() or ch in " .'-" for ch in t) or not t[0].isalpha():
        raise Bad("Send the patient's name, letters only (2 to 60 characters), e.g. Ravi Kumar.")
    return " ".join(w[:1].upper() + w[1:] for w in t.split(" "))


def parse_age(text: str) -> float:
    t = text.strip().lower()
    m = re.search(r"(\d+(?:\.\d+)?)", t)
    if not m:
        raise Bad("Send the age as a number of years between 0 and 110, e.g. 54 (or 8 months).")
    v = float(m.group(1))
    if re.search(r"\b(month|months|mo|mos)\b", t):
        v = round(v / 12, 2)
    elif re.search(r"\b(week|weeks|wk|wks)\b", t):
        v = round(v / 52, 2)
    elif re.search(r"\b(day|days)\b", t):
        v = round(v / 365, 3)
    if not 0 <= v <= 110:
        raise Bad("Age must be between 0 and 110 years.")
    return int(v) if v == int(v) else v


def parse_gender(text: str) -> str:
    t = text.strip().lower()
    if t in ("m", "male", "man", "boy"):
        return "M"
    if t in ("f", "female", "woman", "girl"):
        return "F"
    raise Bad("Tap Male or Female.")


def parse_severity(text: str) -> str:
    t = text.strip().lower()
    alias = {"red flag": "critical", "emergency": "critical", "mild": "stable", "routine": "stable"}
    t = alias.get(t, t)
    if t in case_author.SEVERITIES:
        return t
    raise Bad("Tap Stable, Urgent or Critical.")


def free_text(min_len: int, max_len: int, what: str) -> Callable[[str], str]:
    def parse(text: str) -> str:
        t = re.sub(r"\s+", " ", text).strip()
        if not min_len <= len(t) <= max_len:
            raise Bad(f"{what} should be {min_len} to {max_len} characters.")
        return case_author.no_em_dash(t)
    return parse


def parse_none_or(what: str) -> Callable[[str], str]:
    base = free_text(2, 300, what)

    def parse(text: str) -> str:
        if text.strip().lower() in ("none", "no", "nil", "nkda", "nothing"):
            return "none"
        return base(text)
    return parse


_VITAL_PATTERNS = {
    "hr": r"\b(?:hr|pulse|heart rate|p)\s*[:=]?\s*(\d{2,3})",
    "bp": r"\b(?:bp|blood pressure)?\s*[:=]?\s*(\d{2,3}\s*/\s*\d{2,3})",
    "spo2": r"\b(?:spo2|sp02|sats?|o2|oxygen)\s*[:=]?\s*(\d{2,3})",
    "temp": r"\b(?:t|temp|temperature)\s*[:=]?\s*(\d{2,3}(?:\.\d)?)",
    "rr": r"\b(?:rr|resp(?:iratory)? rate|resp)\s*[:=]?\s*(\d{1,2})",
}


def parse_vitals(text: str) -> dict[str, Any]:
    t = text.lower()
    out: dict[str, Any] = {}
    for k, pat in _VITAL_PATTERNS.items():
        m = re.search(pat, t)
        if m:
            out[k] = m.group(1).replace(" ", "")
    if not out:
        raise Bad("Send vitals like: HR 110, BP 90/60, SpO2 93, T 38.4, RR 24 (any subset), or Skip.")
    v: dict[str, Any] = {}
    if "hr" in out:
        v["hr"] = int(out["hr"])
        if not 30 <= v["hr"] <= 230:
            raise Bad("Heart rate should be 30 to 230.")
    if "bp" in out:
        s, d = (int(x) for x in out["bp"].split("/"))
        if not (50 <= s <= 250 and 25 <= d <= 150 and d < s):
            raise Bad("BP should look like 120/80 (systolic above diastolic).")
        v["bp"] = f"{s}/{d}"
    if "spo2" in out:
        v["spo2"] = int(out["spo2"])
        if not 60 <= v["spo2"] <= 100:
            raise Bad("SpO2 should be 60 to 100 %.")
    if "temp" in out:
        temp = float(out["temp"])
        if temp > 80:  # Fahrenheit
            temp = round((temp - 32) * 5 / 9, 1)
        if not 34 <= temp <= 42:
            raise Bad("Temperature should be 34 to 42 C (or 93 to 108 F).")
        v["temp"] = temp
    if "rr" in out:
        v["rr"] = int(out["rr"])
        if not 6 <= v["rr"] <= 80:
            raise Bad("Respiratory rate should be 6 to 80.")
    return v


# ------------------------------------------------------------------ the interview

def specialty_rows() -> list[list[str]]:
    labels = [s["label"] for s in catalog.specialties()]
    return [labels[i:i + 2] for i in range(0, len(labels), 2)]


SKIP_ROW = ["Skip"]

STEPS: list[dict[str, Any]] = [
    {"key": "specialty", "label": "Specialty", "ask": "Which specialty is this patient for?",
     "parse": parse_specialty, "keyboard": specialty_rows},
    {"key": "name", "label": "Name", "ask": "Patient's name?", "parse": parse_name},
    {"key": "age", "label": "Age", "ask": "Age in years? (for babies: 8 months)", "parse": parse_age},
    {"key": "gender", "label": "Sex", "ask": "Sex?", "parse": parse_gender, "keyboard": lambda: [["Male", "Female"]]},
    {"key": "complaint", "label": "Complaint",
     "ask": "Chief complaint in the patient's own words? e.g. \"My chest feels tight when I climb stairs.\"",
     "parse": free_text(3, 300, "The complaint")},
    {"key": "severity", "label": "Severity", "ask": "How sick are they?", "parse": parse_severity,
     "keyboard": lambda: [["Stable", "Urgent", "Critical"]]},
    {"key": "onset", "label": "Onset", "ask": "Onset and duration? e.g. \"started 3 days ago, getting worse\"",
     "parse": free_text(2, 200, "Onset"), "optional": True},
    {"key": "history", "label": "History",
     "ask": "Key history points the doctor should uncover? (risk factors, past illness, family, social)",
     "parse": free_text(2, 600, "History"), "optional": True},
    {"key": "allergies", "label": "Allergies", "ask": "Allergies? (or None)", "parse": parse_none_or("Allergies"),
     "optional": True, "keyboard": lambda: [["None", "Skip"]]},
    {"key": "medications", "label": "Medicines", "ask": "Current medicines? (or None)",
     "parse": parse_none_or("Medicines"), "optional": True, "keyboard": lambda: [["None", "Skip"]]},
    {"key": "diagnosis", "label": "Diagnosis", "ask": "The intended diagnosis? e.g. \"Unstable angina\"",
     "parse": free_text(3, 120, "The diagnosis")},
    {"key": "vitals", "label": "Vitals",
     "ask": "Vitals? e.g. HR 110, BP 90/60, SpO2 93, T 38.4, RR 24 (any subset). Skip and I will pick ones that fit the severity.",
     "parse": parse_vitals, "optional": True},
]
STEP_BY_KEY = {s["key"]: s for s in STEPS}

NEW_RE = re.compile(r"\b(create|make|new|add|build|author)\b.{0,20}\b(patient|case)\b|\bnew ?(patient|case)\b", re.I)

HELP = (
    "I'm Asha from MedSim, The Voice-First Clinical Simulator. I can turn your idea into a playable patient.\n\n"
    "/newpatient  create a patient, one question at a time\n"
    "/list  patients you created here\n"
    "/publish &lt;id&gt;  publish one without waiting for its review\n"
    "/delete &lt;id&gt;  remove one of them\n"
    "/cancel  stop the current draft\n"
    "/help  this message\n\n"
    "Training simulation only, not medical advice."
)


def _session(chat_id: int, now: Optional[float] = None) -> tuple[Optional[dict[str, Any]], bool]:
    """(session, expired)."""
    now = now or time.time()
    s = _sessions.get(chat_id)
    if s and now - s["ts"] > SESSION_TTL_S:
        del _sessions[chat_id]
        return None, True
    return s, False


def _markup_for(step: dict[str, Any]) -> dict[str, Any]:
    rows = step["keyboard"]() if step.get("keyboard") else []
    if step.get("optional") and not any("Skip" in r for r in rows):
        rows = rows + [SKIP_ROW]
    return reply_keyboard(rows, step["label"]) if rows else REMOVE_KEYBOARD


async def ask(chat_id: int, step_key: str, prefix: str = "") -> None:
    step = STEP_BY_KEY[step_key]
    n = STEPS.index(step) + 1
    text = (prefix + "\n\n" if prefix else "") + f"<b>{n}/{len(STEPS)}</b> {html.escape(step['ask'])}"
    await send(chat_id, text, _markup_for(step))


def _fmt_value(key: str, v: Any) -> str:
    if v is None:
        return "(skip)"
    if key == "specialty":
        return catalog.specialty_label(v)
    if key == "gender":
        return "Male" if v == "M" else "Female"
    if key == "vitals":
        return ", ".join(f"{k.upper()} {val}" for k, val in v.items())
    return str(v)


def summary_text(answers: dict[str, Any]) -> str:
    lines = [f"<b>{html.escape(s['label'])}:</b> {html.escape(_fmt_value(s['key'], answers.get(s['key'])))}" for s in STEPS]
    return "Here is the patient:\n\n" + "\n".join(lines) + "\n\nCreate it?"


SUMMARY_BUTTONS = inline_keyboard([[("Create", "c:create"), ("Edit", "c:edit"), ("Cancel", "c:cancel")]])


async def show_summary(chat_id: int, s: dict[str, Any]) -> None:
    s["step"] = "summary"
    s["editing"] = False
    await send(chat_id, summary_text(s["answers"]), SUMMARY_BUTTONS)


async def start_new(chat_id: int, first_name: str) -> None:
    _sessions[chat_id] = {"step": STEPS[0]["key"], "answers": {}, "ts": time.time(),
                          "editing": False, "first_name": first_name}
    await ask(chat_id, STEPS[0]["key"], "Let's create a patient. Send /cancel any time to stop.")


async def handle_answer(chat_id: int, s: dict[str, Any], text: str) -> None:
    step_key = s["step"]
    if step_key == "summary":
        low = text.strip().lower()
        if low in ("create", "edit", "cancel"):
            await handle_action(chat_id, s, low)
        else:
            await send(chat_id, "Tap Create, Edit or Cancel below the summary.", SUMMARY_BUTTONS)
        return
    if step_key == "generating":
        await send(chat_id, "Still writing the case, one moment.")
        return
    step = STEP_BY_KEY[step_key]
    is_skip = text.strip().lower() in ("skip", "-", "/skip")
    if is_skip and not step.get("optional"):
        await send(chat_id, f"This one is needed. {html.escape(step['ask'])}", _markup_for(step))
        return
    if is_skip:
        value = None
        if step_key in ("allergies", "medications"):
            value = "none"
    else:
        try:
            value = step["parse"](text)
        except Bad as e:
            await send(chat_id, html.escape(str(e)), _markup_for(step))
            return
    s["answers"][step_key] = value
    if s.get("editing"):
        await show_summary(chat_id, s)
        return
    idx = STEPS.index(step)
    if idx + 1 < len(STEPS):
        s["step"] = STEPS[idx + 1]["key"]
        await ask(chat_id, s["step"])
    else:
        await show_summary(chat_id, s)


async def handle_action(chat_id: int, s: dict[str, Any], action: str) -> None:
    if action == "cancel":
        _sessions.pop(chat_id, None)
        await send(chat_id, "Draft cancelled. Send /newpatient to start again.", REMOVE_KEYBOARD)
    elif action == "edit":
        rows = [[(st["label"], f"e:{st['key']}") for st in STEPS[i:i + 3]] for i in range(0, len(STEPS), 3)]
        await send(chat_id, "Which field do you want to change?", inline_keyboard(rows))
    elif action == "create":
        if s["step"] == "generating":
            return
        s["step"] = "generating"
        await send(chat_id, "Writing the full case (history, vitals, tests, treatments) and checking it. About 20 seconds.",
                   REMOVE_KEYBOARD)
        job = asyncio.get_running_loop().create_task(create_case(chat_id, s))
        _jobs.add(job)
        job.add_done_callback(_jobs.discard)


async def create_case(chat_id: int, s: dict[str, Any]) -> Optional[dict[str, Any]]:
    try:
        case = await case_author.generate_case(s["answers"], s.get("first_name", ""))
    except case_author.CaseAuthorError as e:
        log.info("case generation failed: %s (%d errors)", e, len(e.errors))
        s["step"] = "summary"
        await send(chat_id, "Sorry, I could not build a valid case from that (the checks failed). "
                            "Try Create again, or Edit the diagnosis or complaint.", SUMMARY_BUTTONS)
        return None
    except Exception as e:  # noqa: BLE001 (LLM down, 503/502 HTTPException...)
        log.warning("case generation error: %s", type(e).__name__)
        s["step"] = "summary"
        await send(chat_id, "The case writer is unavailable right now. Try Create again in a minute.", SUMMARY_BUTTONS)
        return None
    label = catalog.specialty_label(case["specialty"])
    if casereview.submit(case, s["answers"], chat_id):
        _sessions.pop(chat_id, None)
        await send(chat_id, f"Written: {html.escape(case['name'])} ({html.escape(label)}, {case['severity']}). It is now in review: "
                            "pharmacy checks the medicines, the lab checks the results, then a doctor approves or rejects it. "
                            f"Students cannot see it yet, and I will tell you here.\n\nCase id: <code>{case['id']}</code>",
                   casereview.unreviewed_button(case["id"]))
        return case
    custom_cases.add(case, chat_id)
    _sessions.pop(chat_id, None)
    link = f"{app_url()}/?case={case['id']}"
    await send(chat_id, f"Created {html.escape(case['name'])} ({html.escape(label)}, {case['severity']}). "
                        f"Open MedSim &gt; {html.escape(label)} to see the patient: {html.escape(link)}\n\n"
                        f"Case id: <code>{case['id']}</code>")
    return case


casereview.tell = send

STATUS_WORDS = {custom_cases.IN_REVIEW: "in review, not visible yet", custom_cases.APPROVED: "approved",
                custom_cases.REJECTED: "rejected, not visible", custom_cases.UNREVIEWED: "published UNREVIEWED"}


def status_line(case_id: str) -> str:
    """How the review of this case stands; '' for one that never needed a review."""
    status = custom_cases.status_of(case_id)
    words = STATUS_WORDS.get(status or "", "")
    reason = custom_cases.review_of(case_id).get("reason")
    if words and status == custom_cases.REJECTED and reason:
        words += f": {html.escape(str(reason)[:200])}"
    return words


async def cmd_publish(chat_id: int, arg: str) -> None:
    cid = arg.strip()
    if not cid:
        await send(chat_id, "Send /publish &lt;id&gt;, e.g. /publish tg-a1b2c3 (see /list).")
        return
    problem = casereview.publish_unreviewed(cid, chat_id)
    if problem:
        await send(chat_id, problem)
        return
    await send(chat_id, f"Published <code>{html.escape(cid)}</code> without a review. It carries an UNREVIEWED badge until a doctor "
                        f"approves it: {html.escape(app_url())}/?case={html.escape(cid)}")


async def cmd_list(chat_id: int) -> None:
    rows = custom_cases.list_cases(chat_id)
    if not rows:
        await send(chat_id, "You have not created any patients here yet. Send /newpatient to make one.")
        return
    base = app_url()
    lines = [f"<code>{c['id']}</code> {html.escape(c['name'])}, {c['age']} {c['gender']} "
             f"({html.escape(catalog.specialty_label(c['specialty']))}, {c['severity']})"
             + (f"\n{st}" if (st := status_line(c["id"])) else "")
             + (f"\n{html.escape(base)}/?case={c['id']}" if custom_cases.status_of(c["id"]) in custom_cases.VISIBLE else "")
             for c in rows[:20]]
    await send(chat_id, "Your patients:\n\n" + "\n\n".join(lines))


async def cmd_delete(chat_id: int, arg: str) -> None:
    cid = arg.strip()
    if not cid:
        await send(chat_id, "Send /delete &lt;id&gt;, e.g. /delete tg-a1b2c3 (see /list).")
    elif custom_cases.delete(cid, chat_id):
        await send(chat_id, f"Deleted <code>{html.escape(cid)}</code>.")
    else:
        await send(chat_id, "No patient with that id was created from this chat.")


async def handle_message(msg: dict[str, Any]) -> None:
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if not isinstance(chat_id, int):
        return
    remember_chat(chat)
    first = (msg.get("from") or {}).get("first_name") or chat.get("first_name") or ""
    text = (msg.get("text") or "").strip()
    s, expired = _session(chat_id)
    if text.startswith("/"):
        cmd, _, arg = text.partition(" ")
        cmd = cmd.lower().split("@", 1)[0]
        if cmd == "/start":
            hello = f"Hello{(' ' + html.escape(first)) if first else ''}! "
            if arg.strip().lower() == "medsim":  # patient deep link from the prescription screen
                hello += "You're connected to MedSim Clinic: prescriptions and check-in reminders will arrive here.\n\n"
            await send(chat_id, hello + HELP, REMOVE_KEYBOARD)
        elif cmd == "/help":
            await send(chat_id, HELP)
        elif cmd in ("/newpatient", "/new", "/newcase"):
            await start_new(chat_id, first)
        elif cmd == "/cancel":
            _sessions.pop(chat_id, None)
            await send(chat_id, "Cancelled." if s else "Nothing to cancel.", REMOVE_KEYBOARD)
        elif cmd == "/list":
            await cmd_list(chat_id)
        elif cmd == "/publish":
            await cmd_publish(chat_id, arg)
        elif cmd == "/delete":
            await cmd_delete(chat_id, arg)
        elif cmd == "/skip" and s:
            await handle_answer(chat_id, s, "skip")
        else:
            await send(chat_id, "I don't know that command. " + HELP)
        return
    if not text:
        if s:
            await send(chat_id, "Please answer in text.")
        return
    if s:
        s["ts"] = time.time()
        await handle_answer(chat_id, s, text)
    elif NEW_RE.search(text):
        await start_new(chat_id, first)
    elif expired:
        await send(chat_id, "That draft expired after 30 minutes. Send /newpatient to start again.")
    else:
        await send(chat_id, "I can create a MedSim patient for you. Send /newpatient to start, or /help.")


async def handle_callback(cq: dict[str, Any]) -> None:
    await api("answerCallbackQuery", {"callback_query_id": cq.get("id")})
    msg = cq.get("message") or {}
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if not isinstance(chat_id, int):
        return
    remember_chat(chat)
    data = str(cq.get("data") or "")
    if data.startswith("p:"):
        await cmd_publish(chat_id, data[2:])
        return
    s, _ = _session(chat_id)
    if not s:
        await send(chat_id, "That draft is no longer open. Send /newpatient to start again.")
        return
    s["ts"] = time.time()
    if data.startswith("c:"):
        await handle_action(chat_id, s, data[2:])
    elif data.startswith("e:") and data[2:] in STEP_BY_KEY:
        if s["step"] == "generating":
            return
        s["step"] = data[2:]
        s["editing"] = True
        await ask(chat_id, s["step"])


async def dispatch(update: dict[str, Any]) -> None:
    if update.get("message"):
        await handle_message(update["message"])
    elif update.get("edited_message"):
        remember_chat((update["edited_message"].get("chat") or {}))
    elif update.get("callback_query"):
        await handle_callback(update["callback_query"])


# ------------------------------------------------------------------ polling

async def poll_once(c: httpx.AsyncClient, timeout: int = POLL_TIMEOUT_S) -> int:
    """One getUpdates round. Returns the number of updates handled."""
    params: dict[str, Any] = {"timeout": timeout, "allowed_updates": '["message","edited_message","callback_query"]'}
    if _offset["next"] is not None:
        params["offset"] = _offset["next"]
    r = await c.get(_url("getUpdates"), params=params)
    if r.status_code == 409:
        raise RuntimeError("getUpdates conflict (a webhook or another poller is active)")
    body = r.json() if r.content else {}
    if not body.get("ok"):
        raise RuntimeError(f"getUpdates HTTP {r.status_code}")
    n = 0
    for u in body.get("result") or []:
        if not isinstance(u, dict) or not isinstance(u.get("update_id"), int):
            continue
        # Advance first, so one bad update is never replayed forever.
        _offset["next"] = max(_offset["next"] or 0, u["update_id"] + 1)
        try:
            await dispatch(u)
        except Exception as e:  # noqa: BLE001
            log.warning("telegram update %s failed: %s", u["update_id"], type(e).__name__)
        n += 1
    return n


async def _loop() -> None:
    async with _client_factory(POLL_TIMEOUT_S + 15) as c:
        while True:
            try:
                await poll_once(c)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("telegram poll failed: %s", e if isinstance(e, RuntimeError) else type(e).__name__)
                await asyncio.sleep(BACKOFF_S)


def start() -> bool:
    global _task
    casereview.start()  # reviews left open by an earlier run go on, whether or not the bot polls
    if not enabled():
        return False
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_loop())
    return True


def stop() -> None:
    global _task
    casereview.stop()
    if _task and not _task.done():
        _task.cancel()
    _task = None
