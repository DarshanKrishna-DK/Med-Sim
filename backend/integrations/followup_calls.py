"""Follow-up call registry: an unguessable token per scheduled follow-up.

The calendar event links to /call/<token>; the patient's phone opens it and
talks to Nurse Asha. In-memory only (single process), TTL 30 days, max 500.

Snapshot keys: caseId, patientName, age, gender, chiefComplaint,
prescriptions [{name, dose, duration}], reason, lang.
"""
from __future__ import annotations

import copy
import secrets
import time
from collections import OrderedDict
from typing import Any, Optional

TTL_SECONDS = 30 * 24 * 3600
MAX_ENTRIES = 500

_store: "OrderedDict[str, tuple[float, dict[str, Any]]]" = OrderedDict()
_calls = _store  # alias used by the calendar tests


def _prune(now: float) -> None:
    for tok in [t for t, (exp, _) in _store.items() if exp <= now]:
        _store.pop(tok, None)
    while len(_store) > MAX_ENTRIES:
        _store.popitem(last=False)


def register_call(snapshot: dict[str, Any]) -> str:
    """Store a patient snapshot and return its call token."""
    now = time.time()
    token = secrets.token_urlsafe(12)
    _store[token] = (now + TTL_SECONDS, copy.deepcopy(dict(snapshot)))
    _prune(now)
    return token


def get_call(token: str) -> Optional[dict[str, Any]]:
    """The snapshot for a live token, or None (unknown or expired)."""
    hit = _store.get(token or "")
    if not hit:
        return None
    exp, snap = hit
    if exp <= time.time():
        _store.pop(token, None)
        return None
    return copy.deepcopy(snap)
