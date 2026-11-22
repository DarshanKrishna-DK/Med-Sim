"""An in-memory BAND for hub tests: rooms, mention-scoped context, no network."""

from __future__ import annotations

import itertools
import re
from typing import Any, Optional

from agentroom.client import BandError
from agentroom.protocol import AGENT_ROLES, ROLES, Handoff, decode, encode

OWNER = {"id": "00000000-0000-4000-8000-0000000000ff", "name": "Darshan Krishna N", "handle": "acct", "type": "User", "online": False}


class FakeBand:
    def __init__(self) -> None:
        self.n = itertools.count(1)
        self.ids = {r: f"00000000-0000-4000-8000-00000000000{i}" for i, r in enumerate(AGENT_ROLES, 1)}
        self.roles = {v: k for k, v in self.ids.items()}
        self.rooms: dict[str, dict[str, Any]] = {}
        self.down = False
        self.owner = dict(OWNER)
        self.calls: list[str] = []
        self.online = {r: True for r in AGENT_ROLES}

    # identity
    def agent(self, role: str) -> dict[str, Any]:
        i = ROLES[role]
        return {"id": self.ids[role], "name": i.name, "handle": f"acct/{i.handle}", "type": "Agent", "online": self.online[role]}

    def client(self, role: str) -> Optional["FakeClient"]:
        return FakeClient(self, role)

    # what tests drive
    @property
    def room(self) -> dict[str, Any]:
        return next(iter(self.rooms.values()))

    @property
    def room_id(self) -> str:
        return next(iter(self.rooms))

    def post(self, sender: dict[str, Any], to: list[str], content: str, room_id: str = "", mtype: str = "text") -> dict[str, Any]:
        room = self.rooms[room_id or self.room_id]
        m = {"id": f"m{next(self.n)}", "sender_id": sender["id"], "sender_type": sender["type"], "sender_name": sender["name"],
             "content": "".join(f"@[[{t}]] " for t in to) + content, "message_type": mtype,
             "metadata": {"mentions": [{"id": t} for t in to],
                          "delivery_status": {t: {"status": "delivered"} for t in to}} if to else {},
             "inserted_at": f"2026-11-23T00:00:{len(room['messages']):02d}Z"}
        room["messages"].append(m)
        return m

    def say(self, role: str, h: Handoff, text: str = "here it is", to: str = "nurse", sender: Optional[dict] = None) -> dict[str, Any]:
        return self.post(sender or self.agent(role), [self.ids.get(to, to)], encode(text, h))

    def human(self, text: str, to: str = "nurse", sender: Optional[dict] = None) -> dict[str, Any]:
        return self.post(sender or self.owner, [self.ids[to]], text)

    def requests(self, action: str = "") -> list[tuple[dict[str, Any], Handoff]]:
        out = []
        for room in self.rooms.values():
            for m in room["messages"]:
                if m["sender_id"] != self.ids["nurse"]:
                    continue
                _, h = decode(m["content"])
                if h and (not action or h.action == action):
                    out.append((m, h))
        return out

    def plain(self) -> list[str]:
        """Asha's messages without a hand-off block."""
        out = []
        for room in self.rooms.values():
            for m in room["messages"]:
                if m["sender_id"] == self.ids["nurse"] and m["message_type"] == "text" and decode(m["content"])[1] is None:
                    out.append(re.sub(r"@\[\[.*?\]\]\s*", "", m["content"]))
        return out

    def mark(self, mid: str, status: str) -> None:
        for room in self.rooms.values():
            for m in room["messages"]:
                if m["id"] == mid:
                    for v in m["metadata"]["delivery_status"].values():
                        v["status"] = status


class FakeClient:
    def __init__(self, band: FakeBand, role: str):
        self.b, self.role = band, role

    def _up(self, what: str) -> None:
        self.b.calls.append(f"{self.role}:{what}")
        if self.b.down:
            raise BandError("down")

    async def aclose(self) -> None:
        pass

    async def me(self) -> dict[str, Any]:
        self._up("me")
        return {**self.b.agent(self.role), "owner_uuid": self.b.owner["id"]}

    async def peers(self) -> list[dict[str, Any]]:
        self._up("peers")
        return [self.b.owner, *[self.b.agent(r) for r in AGENT_ROLES if r != self.role],
                {"id": "stranger", "name": "Pharmacist Meera", "handle": "evil/pharmacist-meera", "type": "Agent", "online": True}]

    async def create_chat(self, title: str) -> dict[str, Any]:
        self._up("create_chat")
        rid = f"room{next(self.b.n)}"
        self.b.rooms[rid] = {"title": title, "people": [self.b.agent(self.role)], "messages": []}
        return {"id": rid}

    async def participants(self, chat_id: str) -> list[dict[str, Any]]:
        self._up("participants")
        out = []
        for p in self.b.rooms[chat_id]["people"]:
            out.append(dict(self.b.owner) if p["id"] == self.b.owner["id"] else dict(p))
        return out

    async def add_participant(self, chat_id: str, pid: str) -> dict[str, Any]:
        self._up("add_participant")
        p = self.b.owner if pid == self.b.owner["id"] else self.b.agent(self.b.roles[pid])
        self.b.rooms[chat_id]["people"].append(dict(p))
        return {}

    async def send_message(self, chat_id: str, content: str, mentions: list[dict[str, str]]) -> dict[str, Any]:
        self._up("send_message")
        for x in mentions:  # BAND turns "@Name" into the token
            content = content.replace(f"@{x['name']} ", "", 1)
        m = self.b.post(self.b.agent(self.role), [x["id"] for x in mentions], content, chat_id)
        return {"id": m["id"]}

    async def send_event(self, chat_id: str, content: str, message_type: str = "thought", metadata: Any = None) -> dict[str, Any]:
        self._up("send_event")
        return {"id": self.b.post(self.b.agent(self.role), [], content, chat_id, message_type)["id"]}

    async def context(self, chat_id: str, cursor: Optional[str] = None, limit: int = 100) -> tuple[list[dict[str, Any]], Optional[str]]:
        self._up("context")
        me = self.b.ids[self.role]
        mine = [m for m in self.b.rooms[chat_id]["messages"]
                if m["sender_id"] == me or (m["message_type"] == "text" and any(x["id"] == me for x in m["metadata"].get("mentions", [])))]
        return mine, None
