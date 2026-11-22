"""The hand-off contract every participant of a MedSim BAND room speaks.

A room message is a plain sentence a human can read, followed by one fenced
``handoff`` block that software can read:

    Please verify amoxicillin 500 mg for this patient.

    ```handoff
    {"v":1,"kind":"request","action":"verify_rx","ref":"rx_4f2a91", ...}
    ```

Messages from humans (the faculty member) never carry a block. This module is
imported by the API process and by every department worker, so it stays free of
third-party imports.
"""

from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass, field
from typing import Any

VERSION = 1

# Roles. "nurse" is Asha and runs in the API process; the departments run as workers.
NURSE, PHARMACIST, LAB, RADIOLOGY, EXAMINER, FACULTY, TEACHER, RECEPTION, THEATRE = (
    "nurse", "pharmacist", "lab", "radiology", "examiner", "faculty", "teacher", "reception", "theatre",
)
WORKER_ROLES = (PHARMACIST, LAB, RADIOLOGY, EXAMINER)
AGENT_ROLES = (NURSE, *WORKER_ROLES)


@dataclass(frozen=True)
class RoleInfo:
    role: str
    key_env: str   # env var holding this participant's own BAND agent key
    handle: str    # handle suffix used to find it in GET /peers
    name: str
    title: str


ROLES: dict[str, RoleInfo] = {
    NURSE: RoleInfo(NURSE, "BAND_ASHA_API_KEY", "nurse-asha", "Nurse Asha", "Charge nurse"),
    PHARMACIST: RoleInfo(PHARMACIST, "BAND_PHARMACIST_API_KEY", "pharmacist-meera", "Pharmacist Meera", "Clinical pharmacist"),
    LAB: RoleInfo(LAB, "BAND_LAB_API_KEY", "lab-officer-dev", "Lab Officer Dev", "Laboratory"),
    RADIOLOGY: RoleInfo(RADIOLOGY, "BAND_RADIOLOGY_API_KEY", "radiologist-vikram", "Radiologist Vikram", "Radiology"),
    EXAMINER: RoleInfo(EXAMINER, "BAND_EXAMINER_API_KEY", "examiner-kulkarni", "Examiner Kulkarni", "Examiner"),
    TEACHER: RoleInfo(TEACHER, "BAND_TEACHER_API_KEY", "teacher-iyer", "Teacher Iyer", "Teacher"),
    RECEPTION: RoleInfo(RECEPTION, "BAND_RECEPTION_API_KEY", "receptionist-priya", "Receptionist Priya", "Front desk"),
    THEATRE: RoleInfo(THEATRE, "BAND_THEATRE_API_KEY", "theatre-sister-leela", "Theatre Sister Leela", "Theatre coordinator"),
}

# kind: what a message is. action: what it is about.
KINDS = ("request", "query", "answer", "verdict", "result", "recall", "note", "score", "ack")
ACTIONS = (
    "verify_rx",        # nurse -> pharmacist         => verdict
    "run_test",         # nurse -> lab                => result
    "run_imaging",      # nurse -> radiology          => result | query(safety question)
    "renal_function",   # pharmacist|radiology -> lab => answer
    "safety_question",  # radiology|pharmacist -> nurse => answered by the doctor
    "ask",              # nurse -> any department     => answer
    "critical_value",   # lab -> pharmacist (note): a critical result may affect released drugs
    "score_teamwork",   # nurse -> examiner           => score
    "sign_off",         # examiner -> human, then examiner -> requester (OSCE, viva, debrief results)
    "study_plan",       # examiner|reception -> teacher => answer
    "crossmatch",       # theatre -> lab              => result
    "theatre_allergy",  # theatre -> pharmacist       => verdict
    "second_read",      # nurse -> radiology          => result (agree or discrepancy)
    "critical_finding", # radiology -> nurse (note)   => ack
    "case_review",      # nurse -> pharmacist|lab     => verdict on a newly authored case
)
VERDICTS = ("release", "hold", "clarify")

_BLOCK = re.compile(r"\n*```handoff\s*\n(.*?)\n```\s*", re.DOTALL)
_MENTION = re.compile(r"@\[\[([0-9a-fA-F-]{36})\]\]")
_REF = re.compile(r"[A-Za-z0-9_\-]{1,40}")
MAX_BLOCK = 24_000


def new_ref(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(3)}"


@dataclass
class Handoff:
    kind: str
    action: str
    ref: str
    enc: str = ""          # encounter id
    lang: str = "en"       # session language for `spoken`
    spoken: str = ""       # one or two short sentences in `lang`, read aloud at the bedside
    data: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(
            {"v": VERSION, "kind": self.kind, "action": self.action, "ref": self.ref, "enc": self.enc,
             "lang": self.lang, "spoken": self.spoken, "data": self.data},
            ensure_ascii=False, separators=(",", ":"),
        )


def encode(text: str, handoff: Handoff) -> str:
    # A code fence inside a value would end the block early, so break it up.
    body = handoff.to_json().replace("`" * 3, "``")
    return f"{text.strip()}\n\n```handoff\n{body}\n```"


def decode(content: str) -> tuple[str, Handoff | None]:
    """(human text, hand-off or None). Never raises: room content is untrusted."""
    content = content or ""
    m = _BLOCK.search(content)
    if not m:
        return content.strip(), None
    text = (content[: m.start()] + "\n" + content[m.end():]).strip()
    raw = m.group(1)
    if len(raw) > MAX_BLOCK:
        return text, None
    try:
        d = json.loads(raw)
    except ValueError:
        return text, None
    if not isinstance(d, dict) or d.get("v") != VERSION:
        return text, None
    kind, action, ref = d.get("kind"), d.get("action"), d.get("ref")
    if kind not in KINDS or action not in ACTIONS or not isinstance(ref, str) or not _REF.fullmatch(ref):
        return text, None
    data = d.get("data")
    return text, Handoff(
        kind=kind, action=action, ref=ref, enc=str(d.get("enc") or "")[:120], lang=str(d.get("lang") or "en")[:5],
        spoken=str(d.get("spoken") or "")[:600], data=data if isinstance(data, dict) else {},
    )


def strip_mentions(text: str, names: dict[str, str] | None = None) -> str:
    """Replace BAND's stored ``@[[uuid]]`` tokens with ``@Name`` (or drop unknown ones)."""
    names = names or {}
    return _MENTION.sub(lambda m: f"@{names[m.group(1)]}" if m.group(1) in names else "", text).strip()
