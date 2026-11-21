"""NMC CBME style clinical logbook: POST /agent/logbook appends a row to the user's
"MedSim Clinical Logbook" Google Sheet through the Apps Script bridge
(scripts/apps-script/Code.gs, action "logbook"). Never raises to the caller.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

log = logging.getLogger("medsim.logbook")
router = APIRouter()

_IST = timezone(timedelta(hours=5, minutes=30))
NOT_CONFIGURED = "Logbook is not configured: set GCAL_SCRIPT_URL and GCAL_SCRIPT_SECRET and deploy scripts/apps-script/Code.gs"


class FacultyMark(BaseModel):
    examiner: str = ""
    comment: str = ""
    scores: dict[str, float] = Field(default_factory=dict)


class LogbookRequest(BaseModel):
    caseId: str = ""
    caseName: str = ""
    specialty: str = ""
    patientName: str = ""
    diagnosis: str = ""
    skills: list[str] = Field(default_factory=list)
    tests: list[str] = Field(default_factory=list)
    prescriptions: list[str] = Field(default_factory=list)
    score: Optional[float] = None
    student: str = ""
    university: str = ""
    facultyMarks: list[FacultyMark] = Field(default_factory=list)
    notes: str = ""


def _join(items: list[str], limit: int = 40) -> str:
    return "; ".join(str(x).strip() for x in items[:limit] if str(x).strip())


def faculty_signoff(marks: list[FacultyMark]) -> str:
    """'Dr A (4.2/5): comment' per sheet; empty when no faculty observer marked the case."""
    out = []
    for m in marks[:5]:
        vals = [v for v in m.scores.values() if isinstance(v, (int, float))]
        avg = f" ({sum(vals) / len(vals):.1f}/5)" if vals else ""
        who = m.examiner.strip() or "Faculty observer"
        tail = f": {m.comment.strip()[:160]}" if m.comment.strip() else ""
        out.append(f"{who}{avg}{tail}")
    return " | ".join(out)


def build_row(req: LogbookRequest) -> dict[str, Any]:
    """The Apps Script row object. Every row is labelled as a simulation."""
    notes = (req.notes or "").strip()
    label = "SIMULATION, synthetic patient"
    return {
        "date": datetime.now(_IST).strftime("%Y-%m-%d"),
        "student": req.student.strip() or "Student",
        "university": req.university.strip(),
        "specialty": req.specialty.strip(),
        "caseName": req.caseName.strip() or req.caseId,
        "patient": req.patientName.strip(),
        "diagnosis": req.diagnosis.strip(),
        "skills": _join(req.skills),
        "tests": _join(req.tests),
        "prescriptions": _join(req.prescriptions),
        "score": "" if req.score is None else round(float(req.score)),
        "facultySignoff": faculty_signoff(req.facultyMarks),
        "notes": f"{notes} ({label})" if notes else label,
    }


async def log_row(row: dict[str, Any]) -> dict[str, Any]:
    from integrations import gcal_script

    try:
        res = await asyncio.wait_for(gcal_script.append_logbook(row), timeout=20.0)
    except Exception as e:  # noqa: BLE001
        log.warning("logbook append failed: %s", type(e).__name__)
        res = None
    if res is None:
        return {"ok": False, "error": NOT_CONFIGURED if not _configured() else "The logbook sheet could not be reached"}
    if not res.get("ok"):
        return {"ok": False, "error": str(res.get("error") or "logbook error")[:200]}
    return {"ok": True, "sheetUrl": res.get("sheetUrl"), "row": res.get("row")}


def _configured() -> bool:
    import os

    return bool((os.environ.get("GCAL_SCRIPT_URL") or "").strip() and (os.environ.get("GCAL_SCRIPT_SECRET") or "").strip())


@router.post("/agent/logbook")
async def agent_logbook(req: LogbookRequest) -> dict[str, Any]:
    return await log_row(build_row(req))
