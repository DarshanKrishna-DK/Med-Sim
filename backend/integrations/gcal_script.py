"""Book follow-ups into the user's own Google Calendar via an Apps Script web app.

See scripts/apps-script/Code.gs. Env: GCAL_SCRIPT_URL, GCAL_SCRIPT_SECRET.
Never raises; returns None when unconfigured or on any failure.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Optional

import httpx

log = logging.getLogger("medsim.gcal")


def _client_factory() -> httpx.AsyncClient:
    # Apps Script web apps answer with a 302 to script.googleusercontent.com.
    return httpx.AsyncClient(timeout=15.0, follow_redirects=True)


async def book_event(title: str, description: str, start: datetime, minutes: int = 20,
                     recurrence: Optional[dict] = None, guest_email: Optional[str] = None,
                     location: str = "MedSim Clinic") -> Optional[dict]:
    url = (os.environ.get("GCAL_SCRIPT_URL") or "").strip()
    secret = (os.environ.get("GCAL_SCRIPT_SECRET") or "").strip()
    if not url or not secret:
        return None
    payload = {
        "secret": secret, "title": title, "description": description, "location": location,
        "startIso": start.isoformat(), "minutes": int(minutes),
        "recurrence": recurrence or None,
    }
    if guest_email:
        payload["guestEmail"] = guest_email
    try:
        async with _client_factory() as client:
            r = await client.post(url, json=payload)
            if r.status_code != 200:
                log.warning("apps script returned %s", r.status_code)
                return None
            data = r.json()
            return data if isinstance(data, dict) else None
    except Exception as e:  # noqa: BLE001
        log.warning("apps script booking failed: %s", type(e).__name__)
        return None


async def _post_action(action: str, fields: dict) -> Optional[dict]:
    """POST {action, secret, **fields} to the Apps Script web app. None on any problem."""
    url = (os.environ.get("GCAL_SCRIPT_URL") or "").strip()
    secret = (os.environ.get("GCAL_SCRIPT_SECRET") or "").strip()
    if not url or not secret:
        return None
    payload = {"action": action, "secret": secret, **fields}
    try:
        async with _client_factory() as client:
            r = await client.post(url, json=payload)
            if r.status_code != 200:
                log.warning("apps script %s returned %s", action, r.status_code)
                return None
            data = r.json()
            return data if isinstance(data, dict) else None
    except Exception as e:  # noqa: BLE001
        log.warning("apps script %s failed: %s", action, type(e).__name__)
        return None


async def append_logbook(row: dict) -> Optional[dict]:
    """Append one row to the user's "MedSim Clinical Logbook" sheet.

    Returns {ok, sheetUrl, row} from Apps Script, or None when unconfigured or failed."""
    return await _post_action("logbook", {"row": row})


async def create_referral(fields: dict) -> Optional[dict]:
    """Create the referral Google Doc and its PDF. Returns {ok, docUrl, pdfUrl} or None."""
    return await _post_action("referral", dict(fields))
