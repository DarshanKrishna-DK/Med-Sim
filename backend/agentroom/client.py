"""Async REST client for one BAND participant (https://app.band.ai/api/v1/agent).

One BandClient per role, each with that role's own key. 429/503 are retried
with backoff (Retry-After honoured); network errors are retried only when the
request cannot have been executed, so a message is never posted twice.
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Callable, Optional

import httpx

from . import config

log = logging.getLogger("medsim.room.client")

MAX_ATTEMPTS = 4
BASE_DELAY_S = 0.5
MAX_DELAY_S = 8.0


class BandError(Exception):
    """A BAND call failed for good. Carries the HTTP status (0 = network)."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


async def _sleep(seconds: float) -> None:  # tests patch this
    await asyncio.sleep(seconds)


class BandClient:
    def __init__(self, role: str, key: str, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.role = role
        self._http = httpx.AsyncClient(
            base_url=f"{config.rest_url()}/api/v1/agent",
            headers={"X-API-Key": key, "Accept": "application/json"},
            timeout=httpx.Timeout(12.0, connect=5.0),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, *, json: Any = None, params: Optional[dict] = None) -> dict[str, Any]:
        delay = BASE_DELAY_S
        for attempt in range(1, MAX_ATTEMPTS + 1):
            last = attempt == MAX_ATTEMPTS
            try:
                r = await self._http.request(method, path, json=json, params=params)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as e:
                if last:
                    raise BandError(f"{method} {path}: {type(e).__name__}") from e
            except httpx.HTTPError as e:
                # The request may have been executed: only reads are safe to repeat.
                if last or method != "GET":
                    raise BandError(f"{method} {path}: {type(e).__name__}") from e
            else:
                if r.status_code < 400:
                    try:
                        body = r.json() if r.content else {}
                    except ValueError as e:
                        raise BandError(f"{method} {path}: not JSON", r.status_code) from e
                    return body if isinstance(body, dict) else {"data": body}
                retry = r.status_code in (429, 503) or (r.status_code in (500, 502, 504) and method == "GET")
                if not retry or last:
                    raise BandError(f"{method} {path}: HTTP {r.status_code}", r.status_code)
                try:
                    delay = max(delay, float(r.headers.get("retry-after", 0)))
                except ValueError:
                    pass
            await _sleep(min(MAX_DELAY_S, delay) * random.uniform(0.85, 1.15))
            delay *= 2
        raise BandError(f"{method} {path}: gave up")  # pragma: no cover

    async def me(self) -> dict[str, Any]:
        return (await self._call("GET", "/me")).get("data") or {}

    async def peers(self) -> list[dict[str, Any]]:
        return (await self._call("GET", "/peers", params={"page_size": 100})).get("data") or []

    async def create_chat(self, title: str) -> dict[str, Any]:
        return (await self._call("POST", "/chats", json={"chat": {"title": title[:120]}})).get("data") or {}

    async def participants(self, chat_id: str) -> list[dict[str, Any]]:
        return (await self._call("GET", f"/chats/{chat_id}/participants")).get("data") or []

    async def add_participant(self, chat_id: str, participant_id: str) -> dict[str, Any]:
        return (await self._call("POST", f"/chats/{chat_id}/participants",
                                 json={"participant": {"participant_id": participant_id, "role": "member"}})).get("data") or {}

    async def send_message(self, chat_id: str, content: str, mentions: list[dict[str, str]]) -> dict[str, Any]:
        return (await self._call("POST", f"/chats/{chat_id}/messages",
                                 json={"message": {"content": content, "mentions": mentions}})).get("data") or {}

    async def send_event(self, chat_id: str, content: str, message_type: str = "thought",
                         metadata: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        return (await self._call("POST", f"/chats/{chat_id}/events",
                                 json={"event": {"content": content, "message_type": message_type,
                                                 "metadata": metadata or {}}})).get("data") or {}

    async def context(self, chat_id: str, cursor: Optional[str] = None, limit: int = 100) -> tuple[list[dict[str, Any]], Optional[str]]:
        """One page, oldest first, plus the cursor of the next page (None = this is the newest page)."""
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        body = await self._call("GET", f"/chats/{chat_id}/context", params=params)
        meta = body.get("metadata") or {}
        return body.get("data") or [], (meta.get("next_cursor") if meta.get("has_more") else None)


# Tests replace this with a factory returning a fake client (or None).
_client_factory: Callable[[str, str], Any] = lambda role, key: BandClient(role, key)  # noqa: E731
_clients: dict[str, Any] = {}


def for_role(role: str) -> Any | None:
    """The role's client, or None when its key is not in this process."""
    key = config.api_key(role)
    if not key:
        return None
    c = _clients.get(role)
    if c is None:
        c = _clients[role] = _client_factory(role, key)
    return c


async def aclose_all() -> None:
    clients = list(_clients.values())
    _clients.clear()
    for c in clients:
        try:
            await c.aclose()
        except Exception as e:  # noqa: BLE001
            log.debug("closing a BAND client failed: %s", type(e).__name__)
