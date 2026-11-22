"""Cases created outside the static data files (today: by the Telegram bot).

In memory, mirrored to a JSON file (CUSTOM_CASES_FILE, default under the OS
temp dir; "off" disables it). Best effort: a read-only disk means memory only.

  GET /agent/custom-cases        -> {"cases": [...]} newest first (the app polls this)
  GET /agent/custom-cases/{id}   -> one case

A case has a review status (agentroom/casereview.py). Students see a case only when it
is published (no review room configured), approved by a person, or published by its
author as "unreviewed". in_review and rejected cases are never returned by the API.

Deleting is only offered through the bot (/delete <id>), and only for the
chat that created the case. The creator chat id is never returned by the API.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

log = logging.getLogger("medsim.custom_cases")
router = APIRouter()

MAX_CASES = 200
PUBLISHED, IN_REVIEW, APPROVED, REJECTED, UNREVIEWED = "published", "in_review", "approved", "rejected", "unreviewed"
STATUSES = (PUBLISHED, IN_REVIEW, APPROVED, REJECTED, UNREVIEWED)
VISIBLE = (PUBLISHED, APPROVED, UNREVIEWED)
_lock = threading.Lock()
_cases: dict[str, dict[str, Any]] = {}  # id -> {"case": {...}, "chat": int, "status": str, "review": {...}}
_loaded = False


def _path() -> Optional[Path]:
    env = os.environ.get("CUSTOM_CASES_FILE", "").strip()
    if env.lower() in ("off", "none", "0"):
        return None
    return Path(env) if env else Path(tempfile.gettempdir()) / "medsim_custom_cases.json"


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    p = _path()
    if not p or not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        for row in data if isinstance(data, list) else []:
            c = row.get("case") if isinstance(row, dict) else None
            if isinstance(c, dict) and isinstance(c.get("id"), str):
                status = row.get("status", PUBLISHED)  # rows from before reviews existed were published
                review = row.get("review")
                _cases[c["id"]] = {"case": c, "chat": row.get("chat"), "status": status if status in STATUSES else IN_REVIEW,
                                   "review": review if isinstance(review, dict) else {}}
    except Exception as e:  # noqa: BLE001
        log.warning("custom cases file unreadable: %s", type(e).__name__)


def _save() -> None:
    p = _path()
    if not p:
        return
    try:
        p.write_text(json.dumps(list(_cases.values()), ensure_ascii=False), encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        log.warning("custom cases file not writable: %s", type(e).__name__)


def reset(load_file: bool = False) -> None:
    """Tests: empty the store (optionally re-read the file on next access)."""
    global _loaded
    with _lock:
        _cases.clear()
        _loaded = not load_file


def add(case: dict[str, Any], chat_id: Optional[int] = None, status: str = PUBLISHED,
        review: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    with _lock:
        _ensure_loaded()
        _cases[case["id"]] = {"case": case, "chat": chat_id, "status": status, "review": dict(review or {})}
        while len(_cases) > MAX_CASES:
            _cases.pop(next(iter(_cases)))
        _save()
    return case


def get(case_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        return row["case"] if row else None


def status_of(case_id: str) -> Optional[str]:
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        return row["status"] if row else None


def review_of(case_id: str) -> dict[str, Any]:
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        return dict(row["review"]) if row else {}


def chat_of(case_id: str) -> Optional[int]:
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        return row.get("chat") if row else None


def with_status(*statuses: str) -> list[str]:
    with _lock:
        _ensure_loaded()
        return [cid for cid, r in _cases.items() if r["status"] in statuses]


def set_review(case_id: str, status: Optional[str] = None, *, only_from: tuple[str, ...] = STATUSES, **review: Any) -> bool:
    """Merge review fields and, when given, change the status. False when the case is gone or no
    longer in one of `only_from` (so two decisions can never both win)."""
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        if row is None or row["status"] not in only_from or (status is not None and status not in STATUSES):
            return False
        row["review"].update(review)
        if status is not None:
            row["status"] = status
        _save()
        return True


def visible_cases() -> list[dict[str, Any]]:
    """What students get, newest first; the review status is added only when there was a review."""
    with _lock:
        _ensure_loaded()
        rows = [r for r in _cases.values() if r["status"] in VISIBLE]
    return [r["case"] if r["status"] == PUBLISHED else {**r["case"], "reviewStatus": r["status"]} for r in reversed(rows)]


def list_cases(chat_id: Optional[int] = None) -> list[dict[str, Any]]:
    """Newest first; with chat_id, only the cases that chat created."""
    with _lock:
        _ensure_loaded()
        rows = list(_cases.values())
    if chat_id is not None:
        rows = [r for r in rows if r.get("chat") == chat_id]
    return [r["case"] for r in reversed(rows)]


def delete(case_id: str, chat_id: int) -> bool:
    """Remove a case, only when chat_id created it."""
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        if not row or row.get("chat") != chat_id:
            return False
        del _cases[case_id]
        _save()
        return True


@router.get("/agent/custom-cases")
def api_list() -> dict[str, Any]:
    return {"cases": visible_cases()}


@router.get("/agent/custom-cases/{case_id}")
def api_get(case_id: str) -> dict[str, Any]:
    c = get(case_id)
    if not c or status_of(case_id) not in VISIBLE:
        raise HTTPException(status_code=404, detail="Unknown case")
    return c
