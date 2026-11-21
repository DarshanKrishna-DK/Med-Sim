"""Cases created outside the static data files (today: by the Telegram bot).

In memory, mirrored to a JSON file (CUSTOM_CASES_FILE, default under the OS
temp dir; "off" disables it). Best effort: a read-only disk means memory only.

  GET /agent/custom-cases        -> {"cases": [...]} newest first (the app polls this)
  GET /agent/custom-cases/{id}   -> one case

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
_lock = threading.Lock()
_cases: dict[str, dict[str, Any]] = {}  # id -> {"case": {...}, "chat": int}
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
                _cases[c["id"]] = {"case": c, "chat": row.get("chat")}
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


def add(case: dict[str, Any], chat_id: Optional[int] = None) -> dict[str, Any]:
    with _lock:
        _ensure_loaded()
        _cases[case["id"]] = {"case": case, "chat": chat_id}
        while len(_cases) > MAX_CASES:
            _cases.pop(next(iter(_cases)))
        _save()
    return case


def get(case_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        _ensure_loaded()
        row = _cases.get(case_id)
        return row["case"] if row else None


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
    return {"cases": list_cases()}


@router.get("/agent/custom-cases/{case_id}")
def api_get(case_id: str) -> dict[str, Any]:
    c = get(case_id)
    if not c:
        raise HTTPException(status_code=404, detail="Unknown case")
    return c
