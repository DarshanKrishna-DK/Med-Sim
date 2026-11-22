"""The live BAND connections of the API process: Nurse Asha, and Receptionist Priya and
Theatre Sister Leela when they have keys of their own (SDK agents inside this process).

Every message that mentions one of them is handed to the hub, which decides and posts
by REST; the SDK turn itself always ends with no_reply, so nothing is marked
failed. Deliveries are deduped by message id. If the socket cannot be opened
(for example another process already runs that participant) the hub keeps working from its
polling, and this module keeps trying.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from typing import Any, Optional

from . import config
from .protocol import API_ROLES, NURSE

log = logging.getLogger("medsim.room.asha")

MAX_SEEN = 4000
RETRY_MIN_S = 3.0
RETRY_MAX_S = 60.0

_tasks: dict[str, asyncio.Task] = {}
_agents: dict[str, Any] = {}


def online(role: str = NURSE) -> bool:
    return bool(getattr(_agents.get(role), "is_running", False))


async def handle_message(hub: Any, seen: "OrderedDict[str, None]", msg: Any, tools: Any, room_id: str,
                         role: str = NURSE) -> None:
    """One delivered message: to the hub once, then end the turn quietly."""
    mid = str(getattr(msg, "id", "") or "")
    try:
        if mid and mid in seen:
            reason = "already handled"
        else:
            if mid:
                seen[mid] = None
                while len(seen) > MAX_SEEN:
                    seen.popitem(last=False)
            meta = getattr(msg, "metadata", None)
            meta = dict(meta) if isinstance(meta, dict) else {}
            if not meta.get("mentions"):
                me = await hub.me(role)  # it reached this participant, so it mentions them
                meta["mentions"] = [{"id": me.get("id")}]
            created = getattr(msg, "created_at", None)
            known = hub.on_band_message(str(room_id), {
                "id": mid, "sender_id": str(getattr(msg, "sender_id", "") or ""),
                "sender_type": str(getattr(msg, "sender_type", "") or ""), "sender_name": getattr(msg, "sender_name", None),
                "content": str(getattr(msg, "content", "") or ""),
                "message_type": str(getattr(msg, "message_type", "") or "text"), "metadata": meta,
                "inserted_at": created.isoformat() if hasattr(created, "isoformat") else "",
            })
            reason = "handled at the bedside" if known else "not an open encounter"
    except Exception as e:  # noqa: BLE001 - a bad message must not fail the turn
        log.warning("message not handed over: %s", type(e).__name__)
        reason = "not handled"
    await tools.no_reply(reason)


def _import_sdk() -> None:
    import band  # noqa: F401
    import band.core  # noqa: F401
    import band.runtime.sessionconfig  # noqa: F401

    # It warns about every presence change it has no handler for.
    logging.getLogger("band.client.streaming.client").setLevel(logging.ERROR)


async def _run(hub: Any, role: str) -> None:
    delay = RETRY_MIN_S
    seen: "OrderedDict[str, None]" = OrderedDict()
    while True:
        try:
            # The SDK is slow to import: off the event loop, so requests are served meanwhile.
            await asyncio.to_thread(_import_sdk)
            from band import Agent
            from band.core import SimpleAdapter
            from band.runtime.sessionconfig import SessionConfig

            class AshaAdapter(SimpleAdapter):
                async def on_message(self, msg, tools, history, participants_msg, contacts_msg, *,
                                     is_session_bootstrap, room_id):
                    await handle_message(hub, seen, msg, tools, room_id, role)

            me = await hub.me(role)
            agent = _agents[role] = Agent.create(
                adapter=AshaAdapter(), agent_id=str(me["id"]), api_key=config.api_key(role),
                rest_url=config.rest_url(), ws_url=config.ws_url(),
                # The hub keeps its own state, so no history is fetched per message.
                session_config=SessionConfig(enable_context_hydration=False, enable_working_state=False),
            )
            await agent.run(install_signal_handlers=False)
            delay = RETRY_MIN_S
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("%s is not connected to BAND (%s); polling only, retrying in %ds", role, type(e).__name__, int(delay))
        finally:
            _agents.pop(role, None)
        await asyncio.sleep(delay)
        delay = min(RETRY_MAX_S, delay * 2)


def start(hub: Any) -> None:
    hub.asha_online = online
    for role in API_ROLES:
        task = _tasks.get(role)
        if config.api_key(role) and (task is None or task.done()):
            _tasks[role] = asyncio.ensure_future(_run(hub, role))


async def stop() -> None:
    agents, tasks = dict(_agents), list(_tasks.values())
    _tasks.clear()

    async def end(role: str, agent: Any) -> None:
        try:
            await asyncio.wait_for(agent.stop(timeout=3.0), timeout=6.0)
        except Exception as e:  # noqa: BLE001
            log.info("%s stop: %s", role, type(e).__name__)

    await asyncio.gather(*[end(r, a) for r, a in agents.items()])
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _agents.clear()
