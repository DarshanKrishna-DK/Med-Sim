"""In-memory registry of remote follow-up calls (Nurse Asha), keyed by an unguessable token."""
from __future__ import annotations

import secrets
import time
from collections import OrderedDict
from typing import Any, Optional

TTL_SECONDS = 30 * 24 * 3600
MAX_ENTRIES = 500

_calls: "OrderedDict[str, tuple[float, dict[str, Any]]]" = OrderedDict()


def register_call(snapshot: dict[str, Any]) -> str:
    now = time.time()
    for k in [k for k, (exp, _) in _calls.items() if exp <= now]:
        _calls.pop(k, None)
    token = secrets.token_urlsafe(16)
    _calls[token] = (now + TTL_SECONDS, dict(snapshot))
    while len(_calls) > MAX_ENTRIES:
        _calls.popitem(last=False)
    return token


def get_call(token: str) -> Optional[dict[str, Any]]:
    item = _calls.get(token)
    if not item:
        return None
    if item[0] <= time.time():
        _calls.pop(token, None)
        return None
    return dict(item[1])
