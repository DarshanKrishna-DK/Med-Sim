"""Agent event bus: tool results from a live voice agent reach the browser.

Tools run inside our custom LLM endpoint (agent_runtime), far from the page
that shows the whiteboard, quiz or viva marks. Each tool that changes the UI
publishes a small event onto an in-memory, per-channel queue; the browser
polls GET /agent/agent-events/{channel}?after=<seq> every 1.5 s while a
tool-enabled session is live and applies the events in order.

Bounded on purpose: at most MAX_EVENTS per channel (oldest dropped), at most
MAX_CHANNELS channels (least recently used dropped), events older than
TTL_S forgotten. No background loop: pruning happens on publish / read.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

router = APIRouter()

MAX_EVENTS = 100
MAX_CHANNELS = 200
MAX_PAGE = 50
TTL_S = 4 * 3600
MAX_TYPE_LEN = 40

_lock = threading.Lock()
# channel -> {"seq": last seq, "events": deque[event], "touched": ts}
_channels: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


def _valid_channel(channel: str) -> bool:
    return bool(channel) and len(channel) <= 64 and all(ch.isalnum() or ch in "-_" for ch in channel)


def _prune(now: float) -> None:
    for ch in [c for c, v in _channels.items() if now - v["touched"] > TTL_S]:
        _channels.pop(ch, None)
    while len(_channels) > MAX_CHANNELS:
        _channels.popitem(last=False)


def publish(channel: str, etype: str, data: Optional[dict[str, Any]] = None) -> Optional[dict[str, Any]]:
    """Append one event; returns it (with its seq), or None for a bad channel."""
    if not _valid_channel(channel):
        return None
    now = time.time()
    with _lock:
        box = _channels.get(channel)
        if box is None:
            box = {"seq": 0, "events": deque(maxlen=MAX_EVENTS), "touched": now}
            _channels[channel] = box
        box["seq"] += 1
        box["touched"] = now
        _channels.move_to_end(channel)
        ev = {"seq": box["seq"], "type": str(etype)[:MAX_TYPE_LEN], "data": dict(data or {}), "at": int(now * 1000)}
        box["events"].append(ev)
        _prune(now)
        return dict(ev)


def since(channel: str, after: int = 0, limit: int = MAX_PAGE) -> dict[str, Any]:
    """Events with seq > after, oldest first, at most `limit`. `next` is the cursor to send back."""
    limit = max(1, min(MAX_PAGE, int(limit)))
    with _lock:
        _prune(time.time())
        box = _channels.get(channel)
        if box is None:
            return {"events": [], "next": max(0, int(after))}
        out = [dict(e) for e in box["events"] if e["seq"] > after][:limit]
        nxt = out[-1]["seq"] if out else max(int(after), 0)
        # A cursor ahead of the queue (server restarted) resets to the newest seq.
        if after > box["seq"]:
            nxt = box["seq"]
        return {"events": out, "next": nxt}


def clear(channel: Optional[str] = None) -> None:
    with _lock:
        if channel is None:
            _channels.clear()
        else:
            _channels.pop(channel, None)


@router.get("/agent/agent-events/{channel}")
async def agent_events(channel: str, after: int = 0, limit: int = MAX_PAGE):
    if not _valid_channel(channel):
        raise HTTPException(status_code=404, detail="unknown channel")
    return since(channel, after, limit)
