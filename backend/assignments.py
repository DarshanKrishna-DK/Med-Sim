"""Teacher assignments: create, look up, record attempts, aggregate a per-student report,
and email that report to the assignment's teacher.

Store: in memory, mirrored to a JSON file (ASSIGNMENTS_FILE, default under the OS temp
dir) when writable. Best effort: a read-only disk just means memory only.

Endpoints (all under /agent/, so the shared-secret middleware guards them):
  POST /agent/assignments                       create -> {code, link, assignment}
  GET  /agent/assignments/{code}                the assignment
  POST /agent/assignments/{code}/attempts       record one attempt (case | osce | viva)
  GET  /agent/assignments/{code}/report?student= aggregated results for one student
  POST /agent/assignments/{code}/email          email that report to the teacher
"""

from __future__ import annotations

import asyncio
import html as htmlmod
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

log = logging.getLogger("medsim.assignments")
router = APIRouter()

# No 0/O, 1/I/L: codes are read out loud and typed from a projector.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LEN = 6
CODE_RE = re.compile(rf"^[{CODE_ALPHABET}]{{{CODE_LEN}}}$")
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]+@[^@\s<>\"',;]+\.[A-Za-z]{2,}$")
DEFAULT_TEACHER_EMAIL = "darshankrishna2k2@gmail.com"
MAX_ASSIGNMENTS = 500
MAX_ATTEMPTS_PER_ASSIGNMENT = 2000
EMAIL_WINDOW_S = 600
EMAIL_MAX_PER_WINDOW = 5

_lock = threading.Lock()
_assignments: dict[str, dict[str, Any]] = {}
_attempts: dict[str, list[dict[str, Any]]] = {}
_email_log: dict[str, list[float]] = {}
_loaded = False


# ── persistence (best effort) ────────────────────────────────────────────


def _store_path() -> Optional[Path]:
    env = os.environ.get("ASSIGNMENTS_FILE", "").strip()
    if env.lower() in ("off", "none", "0"):
        return None
    return Path(env) if env else Path(tempfile.gettempdir()) / "medsim_assignments.json"


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    p = _store_path()
    if not p or not p.is_file():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        for a in data.get("assignments", []):
            if isinstance(a, dict) and CODE_RE.match(str(a.get("code", ""))):
                _assignments[a["code"]] = a
        for code, rows in (data.get("attempts") or {}).items():
            if code in _assignments and isinstance(rows, list):
                _attempts[code] = [r for r in rows if isinstance(r, dict)]
    except Exception as e:  # noqa: BLE001
        log.warning("assignments file unreadable: %s", type(e).__name__)


def _persist() -> None:
    p = _store_path()
    if not p:
        return
    try:
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"assignments": list(_assignments.values()), "attempts": _attempts}), encoding="utf-8")
        os.replace(tmp, p)
    except Exception as e:  # noqa: BLE001
        log.info("assignments not persisted: %s", type(e).__name__)


def reset_store() -> None:
    """Tests only: forget everything (memory; the file is left alone)."""
    global _loaded
    with _lock:
        _assignments.clear()
        _attempts.clear()
        _email_log.clear()
        _loaded = True


# ── models ───────────────────────────────────────────────────────────────


class ItemIn(BaseModel):
    kind: Literal["case", "osce", "viva"] = "case"
    caseId: Optional[str] = None
    subject: Optional[str] = None
    label: str = ""
    specialty: Optional[str] = None


class AssignmentIn(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    items: list[ItemIn] = Field(min_length=1, max_length=8)
    dueDate: Optional[str] = None  # YYYY-MM-DD
    teacherName: str = Field(default="", max_length=80)
    teacherEmail: str = DEFAULT_TEACHER_EMAIL
    passMark: int = Field(default=60, ge=0, le=100)

    @field_validator("teacherEmail")
    @classmethod
    def _email(cls, v: str) -> str:
        v = (v or "").strip() or DEFAULT_TEACHER_EMAIL
        if not EMAIL_RE.match(v) or len(v) > 120:
            raise ValueError("teacherEmail is not a valid email address")
        return v

    @field_validator("dueDate")
    @classmethod
    def _due(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        try:
            return datetime.strptime(v.strip()[:10], "%Y-%m-%d").date().isoformat()
        except ValueError as e:
            raise ValueError("dueDate must be YYYY-MM-DD") from e


class AttemptIn(BaseModel):
    student: str = Field(min_length=1, max_length=80)
    university: str = Field(default="", max_length=120)
    caseId: str = Field(default="", max_length=80)
    kind: Literal["case", "osce", "viva"] = "case"
    subject: Optional[str] = Field(default=None, max_length=80)
    label: str = Field(default="", max_length=120)
    score: float = Field(ge=0, le=100)
    domains: dict[str, float] = Field(default_factory=dict)
    strengths: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    feedback: list[str] = Field(default_factory=list)
    timestamp: Optional[float] = None  # epoch ms
    clientId: Optional[str] = Field(default=None, max_length=80)


class EmailIn(BaseModel):
    student: str = Field(min_length=1, max_length=80)
    university: str = ""
    note: Optional[str] = Field(default=None, max_length=500)


# ── helpers ──────────────────────────────────────────────────────────────


def new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if code not in _assignments:
            return code


def norm_code(code: str) -> str:
    return (code or "").strip().upper()


def _norm_name(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"^dr\.?\s+", "", (s or "").strip(), flags=re.I)).lower()


def _clean_lines(lines: list[str], limit: int = 6) -> list[str]:
    out = []
    for s in lines[:limit]:
        t = re.sub(r"\s+", " ", str(s)).strip()[:240]
        if t:
            out.append(t)
    return out


def _item_id(it: dict[str, Any]) -> str:
    if it["kind"] == "viva":
        return f"viva:{(it.get('subject') or 'any').strip().lower()}"
    if it["kind"] == "osce":
        return f"osce:{it.get('caseId') or 'any'}"
    return f"case:{it.get('caseId')}"


def _matches(item: dict[str, Any], att: dict[str, Any]) -> bool:
    kind = item["kind"]
    if kind == "case":
        # Practising the assigned case as an OSCE station counts too.
        return att["kind"] in ("case", "osce") and att.get("caseId") == item.get("caseId")
    if kind == "osce":
        return att["kind"] == "osce" and (not item.get("caseId") or att.get("caseId") == item.get("caseId"))
    want = (item.get("subject") or "").strip().lower()
    return att["kind"] == "viva" and (not want or (att.get("subject") or "").strip().lower() == want)


def create_assignment(data: AssignmentIn) -> dict[str, Any]:
    with _lock:
        _ensure_loaded()
        if len(_assignments) >= MAX_ASSIGNMENTS:
            oldest = min(_assignments.values(), key=lambda a: a["createdAt"])
            _assignments.pop(oldest["code"], None)
            _attempts.pop(oldest["code"], None)
        items = []
        seen: set[str] = set()
        for it in data.items:
            if it.kind in ("case",) and not it.caseId:
                raise HTTPException(status_code=422, detail="case items need a caseId")
            row = {
                "kind": it.kind,
                "caseId": (it.caseId or "").strip()[:80] or None,
                "subject": (it.subject or "").strip()[:80] or None,
                "label": (it.label or it.caseId or it.subject or it.kind).strip()[:120],
                "specialty": (it.specialty or "").strip()[:60] or None,
            }
            row["id"] = _item_id(row)
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            items.append(row)
        code = new_code()
        a = {
            "code": code,
            "title": data.title.strip(),
            "items": items,
            "dueDate": data.dueDate,
            "teacherName": data.teacherName.strip(),
            "teacherEmail": data.teacherEmail,
            "passMark": data.passMark,
            "createdAt": int(time.time() * 1000),
        }
        _assignments[code] = a
        _attempts[code] = []
        _persist()
        return dict(a)


def get_assignment(code: str) -> Optional[dict[str, Any]]:
    with _lock:
        _ensure_loaded()
        a = _assignments.get(norm_code(code))
        return dict(a) if a else None


def public_assignment(a: dict[str, Any]) -> dict[str, Any]:
    """What a student's browser sees: no teacher email address."""
    out = {k: v for k, v in a.items() if k != "teacherEmail"}
    out["teacherEmailMasked"] = mask_email(a.get("teacherEmail", ""))
    return out


def mask_email(addr: str) -> str:
    if "@" not in addr:
        return ""
    user, dom = addr.split("@", 1)
    return f"{user[:2]}***@{dom}"


def record_attempt(code: str, att: AttemptIn) -> dict[str, Any]:
    with _lock:
        _ensure_loaded()
        c = norm_code(code)
        if c not in _assignments:
            raise HTTPException(status_code=404, detail="Unknown assignment code")
        rows = _attempts.setdefault(c, [])
        if att.clientId and any(r.get("clientId") == att.clientId for r in rows):
            return {"ok": True, "duplicate": True}
        row = {
            "student": att.student.strip(),
            "university": att.university.strip(),
            "caseId": att.caseId.strip(),
            "kind": att.kind,
            "subject": (att.subject or "").strip() or None,
            "label": att.label.strip(),
            "score": round(float(att.score), 1),
            "domains": {str(k)[:40]: round(max(0.0, min(100.0, float(v))), 1) for k, v in list(att.domains.items())[:10]},
            "strengths": _clean_lines(att.strengths),
            "improvements": _clean_lines(att.improvements),
            "feedback": _clean_lines(att.feedback),
            "timestamp": int(att.timestamp or time.time() * 1000),
            "clientId": att.clientId,
        }
        rows.append(row)
        if len(rows) > MAX_ATTEMPTS_PER_ASSIGNMENT:
            del rows[: len(rows) - MAX_ATTEMPTS_PER_ASSIGNMENT]
        _persist()
        matched = [it["id"] for it in _assignments[c]["items"] if _matches(it, row)]
        return {"ok": True, "matchedItems": matched}


def attempts_for(code: str, student: Optional[str] = None) -> list[dict[str, Any]]:
    with _lock:
        _ensure_loaded()
        rows = list(_attempts.get(norm_code(code), []))
    if student:
        key = _norm_name(student)
        rows = [r for r in rows if _norm_name(r["student"]) == key]
    return rows


def _top_lines(lines: list[str], n: int = 4) -> list[str]:
    counts = Counter()
    first: dict[str, str] = {}
    for s in lines:
        k = s.lower().rstrip(".")
        counts[k] += 1
        first.setdefault(k, s)
    return [first[k] for k, _ in counts.most_common(n)]


def build_report(a: dict[str, Any], student: str, attempts: list[dict[str, Any]], university: str = "") -> dict[str, Any]:
    """Pure aggregation: per item best score, completion, average, verdict, strengths."""
    items_out = []
    used: list[dict[str, Any]] = []
    for it in a["items"]:
        mine = [r for r in attempts if _matches(it, r)]
        best = max(mine, key=lambda r: r["score"]) if mine else None
        if best:
            used.append(best)
        items_out.append({
            "id": it["id"], "kind": it["kind"], "label": it["label"], "specialty": it.get("specialty"),
            "caseId": it.get("caseId"), "subject": it.get("subject"),
            "status": "completed" if best else "pending",
            "bestScore": best["score"] if best else None,
            "attempts": len(mine),
            "lastAt": max(r["timestamp"] for r in mine) if mine else None,
        })
    completed = [i for i in items_out if i["status"] == "completed"]
    total = len(items_out)
    average = round(sum(i["bestScore"] for i in completed) / len(completed), 1) if completed else None
    pass_mark = int(a.get("passMark", 60))
    if not completed:
        verdict = "not-started"
    elif len(completed) < total:
        verdict = "incomplete"
    else:
        verdict = "pass" if (average or 0) >= pass_mark else "fail"

    dom_vals: dict[str, list[float]] = {}
    for r in used:
        for k, v in r.get("domains", {}).items():
            dom_vals.setdefault(k, []).append(v)
    domains = {k: round(sum(v) / len(v), 1) for k, v in dom_vals.items()}
    ranked = sorted(domains.items(), key=lambda kv: kv[1], reverse=True)

    strengths = _top_lines([s for r in used for s in r.get("strengths", [])])
    weaknesses = _top_lines([s for r in used for s in r.get("improvements", [])])
    if ranked and ranked[0][1] >= 70 and len(strengths) < 4:
        strengths.append(f"Strongest domain: {ranked[0][0]} ({ranked[0][1]:.0f}/100)")
    if ranked and ranked[-1][1] < 70 and len(weaknesses) < 4:
        weaknesses.append(f"Weakest domain: {ranked[-1][0]} ({ranked[-1][1]:.0f}/100)")
    for i in items_out:
        if i["status"] == "pending" and len(weaknesses) < 5:
            weaknesses.append(f"Not yet attempted: {i['label']}")

    uni = university or next((r["university"] for r in reversed(attempts) if r.get("university")), "")
    return {
        "code": a["code"], "title": a["title"], "dueDate": a.get("dueDate"), "passMark": pass_mark,
        "teacherName": a.get("teacherName", ""),
        "student": student.strip(), "university": uni,
        "items": items_out, "completed": len(completed), "total": total,
        "average": average, "verdict": verdict, "passed": verdict == "pass",
        "domains": domains, "strengths": strengths, "weaknesses": weaknesses,
        "submittedAt": max((r["timestamp"] for r in attempts), default=None),
        "attemptCount": len(attempts),
    }


def report_for(code: str, student: str, university: str = "") -> dict[str, Any]:
    a = get_assignment(code)
    if not a:
        raise HTTPException(status_code=404, detail="Unknown assignment code")
    return build_report(a, student, attempts_for(code, student), university)


# ── email report ─────────────────────────────────────────────────────────

VERDICT_STYLE = {
    "pass": ("PASS", "#1f7a3d", "#e3f4e8"),
    "fail": ("BELOW PASS MARK", "#a3261f", "#fbe6e4"),
    "incomplete": ("INCOMPLETE", "#8a5a00", "#fff1d6"),
    "not-started": ("NOT STARTED", "#5b6475", "#eceff4"),
}


def _fmt_date(ms: Optional[float]) -> str:
    if not ms:
        return "-"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone().strftime("%d %b %Y, %H:%M")


def _fmt_due(d: Optional[str]) -> str:
    if not d:
        return "No due date"
    try:
        return datetime.strptime(d, "%Y-%m-%d").strftime("%d %b %Y")
    except ValueError:
        return d


def _logo_url() -> Optional[str]:
    base = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    return f"{base}/brand/medsim-logo-256.png" if base.startswith(("https://", "http://")) else None


def render_report_email(rep: dict[str, Any], note: Optional[str] = None) -> tuple[str, str, str]:
    """(subject, html, text). Table layout + inline CSS so Gmail renders it."""
    e = htmlmod.escape
    label, fg, bg = VERDICT_STYLE.get(rep["verdict"], VERDICT_STYLE["incomplete"])
    avg = "-" if rep["average"] is None else f"{rep['average']:.0f}"
    subject = f"MedSim report: {rep['student']} - {rep['title']} ({label.title()})"
    logo = _logo_url()
    logo_html = (
        f'<img src="{e(logo)}" width="40" height="40" alt="MedSim" style="display:block;border:0;">' if logo else ""
    )
    font = "font-family:Arial,Helvetica,sans-serif;"

    rows = []
    for i, it in enumerate(rep["items"]):
        done = it["status"] == "completed"
        zebra = "#ffffff" if i % 2 == 0 else "#f6f8fb"
        score = "-" if it["bestScore"] is None else f"{it['bestScore']:.0f}"
        kind = {"case": "Case", "osce": "OSCE station", "viva": "Viva"}[it["kind"]]
        status = (
            '<span style="color:#1f7a3d;font-weight:bold;">Completed</span>' if done
            else '<span style="color:#8a5a00;font-weight:bold;">Pending</span>'
        )
        rows.append(
            f'<tr style="background:{zebra};">'
            f'<td style="padding:8px 10px;border-bottom:1px solid #e3e7ee;{font}font-size:14px;color:#14213d;">{e(it["label"])}'
            f'<div style="font-size:11px;color:#6b7385;">{kind}</div></td>'
            f'<td style="padding:8px 10px;border-bottom:1px solid #e3e7ee;{font}font-size:13px;color:#33405c;">{e(it.get("specialty") or "-")}</td>'
            f'<td align="center" style="padding:8px 10px;border-bottom:1px solid #e3e7ee;{font}font-size:15px;font-weight:bold;color:#14213d;">{score}</td>'
            f'<td style="padding:8px 10px;border-bottom:1px solid #e3e7ee;{font}font-size:12px;color:#33405c;">{_fmt_date(it["lastAt"])}</td>'
            f'<td style="padding:8px 10px;border-bottom:1px solid #e3e7ee;{font}font-size:13px;">{status}</td></tr>'
        )

    bars = []
    for name, val in sorted(rep["domains"].items(), key=lambda kv: kv[1], reverse=True):
        pct = max(2, min(100, int(round(val))))
        color = "#1f7a3d" if val >= 75 else ("#d08a00" if val >= 55 else "#a3261f")
        bars.append(
            f'<tr><td width="38%" style="padding:4px 8px 4px 0;{font}font-size:13px;color:#33405c;">{e(name)}</td>'
            f'<td style="padding:4px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">'
            f'<tr><td width="{pct}%" style="background:{color};height:14px;font-size:0;line-height:0;">&nbsp;</td>'
            + (f'<td width="{100 - pct}%" style="background:#e9edf3;height:14px;font-size:0;line-height:0;">&nbsp;</td>' if pct < 100 else "")
            + f'</tr></table></td><td width="44" align="right" style="padding:4px 0 4px 8px;{font}font-size:13px;font-weight:bold;color:#14213d;">{val:.0f}</td></tr>'
        )
    bars_html = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(bars)}</table>'
        if bars else f'<p style="{font}font-size:13px;color:#6b7385;margin:0;">No domain scores yet.</p>'
    )

    def bullet_list(lines: list[str], empty: str) -> str:
        if not lines:
            return f'<p style="{font}font-size:13px;color:#6b7385;margin:0;">{empty}</p>'
        return "".join(f'<p style="{font}font-size:13px;color:#14213d;margin:0 0 6px;">&#8226; {e(s)}</p>' for s in lines)

    note_html = (
        f'<tr><td style="padding:0 24px 16px;"><div style="background:#f6f8fb;border-left:4px solid #3f7cc4;padding:10px 12px;{font}font-size:13px;color:#33405c;">'
        f'<b>Note from {e(rep["student"])}:</b> {e(note)}</div></td></tr>' if note else ""
    )

    html = f"""<!doctype html><html><body style="margin:0;padding:0;background:#eef1f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d9dee7;">
<tr><td style="background:#0b1f4b;padding:16px 24px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;">{logo_html}</td>
<td style="{font}font-size:22px;font-weight:bold;color:#f3f1e2;letter-spacing:1px;">MedSim<div style="font-size:11px;font-weight:normal;color:#c9d3e6;letter-spacing:0.5px;margin-top:2px;">The Voice-First Clinical Simulator</div></td>
<td style="{font}font-size:12px;color:#a8e27c;padding-left:12px;text-transform:uppercase;letter-spacing:2px;">Assignment report</td>
</tr></table></td></tr>
<tr><td style="padding:22px 24px 8px;">
<div style="{font}font-size:12px;color:#6b7385;text-transform:uppercase;letter-spacing:1px;">{e(rep["title"])} &middot; code {e(rep["code"])}</div>
<div style="{font}font-size:24px;font-weight:bold;color:#14213d;margin-top:4px;">{e(rep["student"])}</div>
<div style="{font}font-size:14px;color:#33405c;margin-top:2px;">{e(rep["university"] or "University not given")}</div>
</td></tr>
<tr><td style="padding:8px 24px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="33%" style="padding:10px;background:#f6f8fb;border:1px solid #e3e7ee;{font}"><div style="font-size:11px;color:#6b7385;text-transform:uppercase;">Overall average</div><div style="font-size:28px;font-weight:bold;color:#14213d;">{avg}<span style="font-size:13px;color:#6b7385;"> / 100</span></div></td>
<td width="33%" style="padding:10px;background:#f6f8fb;border:1px solid #e3e7ee;{font}"><div style="font-size:11px;color:#6b7385;text-transform:uppercase;">Completed</div><div style="font-size:28px;font-weight:bold;color:#14213d;">{rep["completed"]}<span style="font-size:13px;color:#6b7385;"> of {rep["total"]}</span></div></td>
<td width="34%" style="padding:10px;background:#f6f8fb;border:1px solid #e3e7ee;{font}"><div style="font-size:11px;color:#6b7385;text-transform:uppercase;">Result (pass mark {rep["passMark"]})</div>
<div style="margin-top:6px;"><span style="display:inline-block;padding:5px 10px;background:{bg};color:{fg};border:1px solid {fg};font-size:13px;font-weight:bold;letter-spacing:1px;">{label}</span></div></td>
</tr></table>
<div style="{font}font-size:12px;color:#6b7385;margin-top:8px;">Due {e(_fmt_due(rep.get("dueDate")))} &middot; Submitted {e(_fmt_date(time.time() * 1000))} &middot; Last attempt {e(_fmt_date(rep.get("submittedAt")))}</div>
</td></tr>
{note_html}
<tr><td style="padding:0 24px 18px;">
<div style="{font}font-size:15px;font-weight:bold;color:#14213d;margin-bottom:8px;">Assigned items</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e3e7ee;">
<tr style="background:#0b1f4b;">
<th align="left" style="padding:8px 10px;{font}font-size:12px;color:#f3f1e2;">Case</th>
<th align="left" style="padding:8px 10px;{font}font-size:12px;color:#f3f1e2;">Specialty</th>
<th align="center" style="padding:8px 10px;{font}font-size:12px;color:#f3f1e2;">Best score</th>
<th align="left" style="padding:8px 10px;{font}font-size:12px;color:#f3f1e2;">Date</th>
<th align="left" style="padding:8px 10px;{font}font-size:12px;color:#f3f1e2;">Status</th></tr>
{"".join(rows)}
</table></td></tr>
<tr><td style="padding:0 24px 18px;"><div style="{font}font-size:15px;font-weight:bold;color:#14213d;margin-bottom:8px;">Skill domains</div>{bars_html}</td></tr>
<tr><td style="padding:0 24px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="50%" valign="top" style="padding-right:10px;"><div style="{font}font-size:15px;font-weight:bold;color:#1f7a3d;margin-bottom:8px;">Strengths</div>{bullet_list(rep["strengths"], "No strengths recorded yet.")}</td>
<td width="50%" valign="top" style="padding-left:10px;"><div style="{font}font-size:15px;font-weight:bold;color:#a3261f;margin-bottom:8px;">Areas to improve</div>{bullet_list(rep["weaknesses"], "Nothing flagged.")}</td>
</tr></table></td></tr>
<tr><td style="background:#0b1f4b;padding:12px 24px;{font}font-size:11px;color:#a8e27c;letter-spacing:3px;text-align:center;">SIMULATION</td></tr>
<tr><td style="padding:10px 24px 16px;{font}font-size:11px;color:#6b7385;text-align:center;">Sent by Priya at MedSim Reception (The Voice-First Clinical Simulator) on behalf of the student. Synthetic training cases, not a clinical assessment.</td></tr>
</table></td></tr></table></body></html>"""

    lines = [
        f"MedSim assignment report: {rep['title']} (code {rep['code']})",
        f"Student: {rep['student']}" + (f", {rep['university']}" if rep["university"] else ""),
        f"Due: {_fmt_due(rep.get('dueDate'))}   Submitted: {_fmt_date(time.time() * 1000)}",
        f"Overall average: {avg}/100   Completed: {rep['completed']} of {rep['total']}   Result: {label} (pass mark {rep['passMark']})",
        "",
    ]
    if note:
        lines += [f"Note from the student: {note}", ""]
    lines.append("Items:")
    for it in rep["items"]:
        sc = "-" if it["bestScore"] is None else f"{it['bestScore']:.0f}"
        lines.append(f"  - {it['label']} [{it.get('specialty') or it['kind']}]: {sc} ({it['status']}, {_fmt_date(it['lastAt'])})")
    if rep["domains"]:
        lines += ["", "Domains:"] + [f"  - {k}: {v:.0f}" for k, v in rep["domains"].items()]
    lines += ["", "Strengths:"] + [f"  - {s}" for s in rep["strengths"] or ["none recorded"]]
    lines += ["", "Areas to improve:"] + [f"  - {s}" for s in rep["weaknesses"] or ["nothing flagged"]]
    lines += ["", "SIMULATION. Synthetic training cases, not a clinical assessment."]
    return subject, html, "\n".join(lines)


def _email_rate_ok(code: str) -> bool:
    now = time.time()
    with _lock:
        log_ = [t for t in _email_log.get(code, []) if now - t < EMAIL_WINDOW_S]
        if len(log_) >= EMAIL_MAX_PER_WINDOW:
            _email_log[code] = log_
            return False
        log_.append(now)
        _email_log[code] = log_
        return True


async def _smtp_fallback(to: str, subject: str, html: str, text: str) -> Optional[str]:
    """Returns None on success, else a reason."""
    from integrations import notify

    if not notify._smtp_ready():
        return "SMTP is not configured"
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = notify._env("SMTP_FROM") or notify._env("SMTP_USER")
    msg["To"] = to
    msg["Message-ID"] = f"<{secrets.token_hex(12)}@medsim.local>"
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    try:
        await asyncio.wait_for(asyncio.to_thread(notify._smtp_send, msg), timeout=notify.SMTP_TIMEOUT_S + 5)
    except Exception as e:  # noqa: BLE001
        return f"SMTP send failed: {type(e).__name__}"
    return None


async def email_report(code: str, student: str, university: str = "", note: Optional[str] = None) -> dict[str, Any]:
    """Email the student's report to the assignment's teacher (never any other address)."""
    from integrations import gcal_script

    a = get_assignment(code)
    if not a:
        return {"ok": False, "reason": "Unknown assignment code"}
    to = a.get("teacherEmail") or ""
    if not EMAIL_RE.match(to):
        return {"ok": False, "reason": "The assignment has no valid teacher email"}
    if not student.strip():
        return {"ok": False, "reason": "Student name missing (fill in your profile)"}
    if not _email_rate_ok(f"{a['code']}:{_norm_name(student)}"):
        return {"ok": False, "reason": "Too many report emails for this assignment, try again in a few minutes"}
    rep = build_report(a, student, attempts_for(code, student), university)
    subject, html, text = render_report_email(rep, (note or "").strip()[:500] or None)
    res = await gcal_script.send_email(to, subject, html, text)
    base = {"to": mask_email(to), "teacherName": a.get("teacherName", ""), "report": rep, "subject": subject}
    if res is not None:
        return {"ok": True, "via": "apps-script", "remaining": res.get("remaining"), **base}
    reason = await _smtp_fallback(to, subject, html, text)
    if reason is None:
        return {"ok": True, "via": "smtp", **base}
    return {"ok": False, "reason": f"Email is not available: Apps Script email failed or is unconfigured, and {reason}", **base}


# ── routes ───────────────────────────────────────────────────────────────


@router.post("/agent/assignments")
async def create(req: AssignmentIn):
    a = create_assignment(req)
    return {"code": a["code"], "link": f"/?assignment={a['code']}", "assignment": public_assignment(a)}


def _require(code: str) -> dict[str, Any]:
    if not CODE_RE.match(norm_code(code)):
        raise HTTPException(status_code=404, detail="Unknown assignment code")
    a = get_assignment(code)
    if not a:
        raise HTTPException(status_code=404, detail="Unknown assignment code")
    return a


@router.get("/agent/assignments/{code}")
async def read(code: str):
    return public_assignment(_require(code))


@router.post("/agent/assignments/{code}/attempts")
async def add_attempt(code: str, req: AttemptIn):
    _require(code)
    return record_attempt(code, req)


@router.get("/agent/assignments/{code}/report")
async def report(code: str, student: str, university: str = ""):
    _require(code)
    if not student.strip():
        raise HTTPException(status_code=422, detail="student is required")
    return report_for(code, student, university)


@router.post("/agent/assignments/{code}/email")
async def email(code: str, req: EmailIn):
    _require(code)
    out = await email_report(code, req.student, req.university, req.note)
    out.pop("report", None)
    return out
