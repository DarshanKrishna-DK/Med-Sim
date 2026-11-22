"""Side rooms: BAND rooms that belong to one result, desk question, drill, report or
authored case instead of a bedside encounter. See "Side room API" in docs/band/CONTRACT.md.

A side room is an ordinary hub encounter with another owner and another brain. The hub
keeps doing what it does (event log, SSE, roster, posting, transcript polling); this module
adds who may open one, how a flow posts as any participant of this process, and how it
waits for an agent or a person with a time limit.

Trust rules, the same as at the bedside:
  * an agent's answer counts only when its sender is the participant that was asked, the
    ref is ours and the message mentions the participant that asked;
  * a person's words count only when BAND lists that person as a human in this very room;
  * nothing here signs, approves or releases anything on silence.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import lang as langmod

from . import bedside, client as band_client, config
from . import hub as hubmod
from .protocol import API_ROLES, FACULTY, NURSE, ROLES, Handoff, new_ref

log = logging.getLogger("medsim.room.side")

PREFIX = "side."
MAX_SIDE_ROOMS = 120
OPEN_LIMIT, OPEN_WINDOW_S = 60, 600.0  # new rooms per window: BAND's plan has 250 active ones
MAX_WAITS = 40
MAX_HUMAN = 60
LIVE_POLL_S = 10 * 60      # someone is expected to answer within this long: poll fast
IDLE_STOP_S = 30 * 60      # nobody watching and nothing expected: stop polling (a re-open starts it again)
FAILED_STATUSES = ("failed", "rejected")

REF_ID = re.compile(r"[A-Za-z0-9_.:-]{1,80}")
KIND = re.compile(r"[a-z][a-z0-9_]{1,30}")


@dataclass
class Reply:
    """What a wait ended with. `ok` is False on timeout, outage or a refusal."""

    ok: bool
    role: str = ""            # who answered: an agent role, or "faculty"
    name: str = ""
    text: str = ""            # the human sentence (hand-off removed)
    kind: str = ""            # hand-off kind ("result", "verdict", "answer", "query", ...), "" for a person
    data: dict[str, Any] = field(default_factory=dict)
    spoken: str = ""          # the department's own words, only when really in the room's language
    handoff: Optional[Handoff] = None
    sender_id: str = ""
    message_id: str = ""
    to: list[str] = field(default_factory=list)
    reason: str = ""          # "timeout" | "unreachable" | "failed" | "closed" when not ok
    ref: str = ""


@dataclass
class _Wait:
    ref: str                  # "" = a person
    target_id: str            # the participant that must answer ("" = any human in the room)
    asker: str                # role the answer must mention
    to: str = ""              # humans: only words addressed to this role
    future: Optional[asyncio.Future] = None


Flow = Callable[["SideRoom", dict[str, Any]], Awaitable[None]]
Action = Callable[["SideRoom", dict[str, Any]], Awaitable[Any]]
Listener = Callable[["SideRoom", Reply], Any]


@dataclass(frozen=True)
class Kind:
    """One use of side rooms."""

    name: str
    owner: str                        # API participant that opens the room: nurse | reception | theatre
    flow: Optional[Flow] = None       # runs once, in the background, when the room is opened over HTTP
    title: str = ""                   # fixed BAND title; a caller may append its own words
    actions: dict[str, Action] = field(default_factory=dict)  # POST /agent/room/side/{id}/act
    listener: Optional[Listener] = None   # agent or human messages no wait has claimed
    # Checks the HTTP context and returns the one to use; raise ValueError to refuse (422).
    check: Optional[Callable[[str, dict[str, Any]], dict[str, Any]]] = None
    http: bool = True                 # may the browser open it


KINDS: dict[str, Kind] = {}
_opened: list[float] = []


def register(kind: Kind) -> Kind:
    """Declare a use of side rooms, once, at import time."""
    if not KIND.fullmatch(kind.name) or kind.owner not in API_ROLES:
        raise ValueError("bad side room kind")
    KINDS[kind.name] = kind
    return kind


def room_key(kind: str, ref_id: str) -> str:
    return f"{PREFIX}{kind}.{ref_id}"


def available(owner: str = NURSE) -> bool:
    """BAND is configured and this participant has an identity of its own."""
    return config.enabled() and bool(config.api_key(owner))


class SideRoom:
    def __init__(self, hub: hubmod.Hub, enc: hubmod.Encounter, kind: Kind, ref_id: str, context: dict[str, Any],
                 redact: dict[str, str]):
        self.hub, self.enc, self.kind, self.ref_id = hub, enc, kind, ref_id
        self.context = context
        self.redact_names = {k.strip(): v for k, v in redact.items() if len(k.strip()) >= 3}
        self.state: dict[str, Any] = {"kind": kind.name, "refId": ref_id, "status": "new", "final": False, "url": ""}
        self.memory: dict[str, Any] = {}      # a flow's own notes, never sent anywhere
        self.listener: Optional[Listener] = kind.listener
        self.humans: list[Reply] = []         # everything people said here, oldest first
        self.sent: dict[str, Handoff] = {}    # our own hand-offs by ref (also rebuilt by adopt)
        self._waits: list[_Wait] = []
        self._expect_until = 0.0              # busy polling until then
        self._task: Optional[asyncio.Task] = None
        self._closed = False

    # ── facts ────────────────────────────────────────────────────────────────

    @property
    def id(self) -> str:
        return self.enc.id

    @property
    def lang(self) -> str:
        return self.enc.lang

    @property
    def owner(self) -> str:
        return self.enc.owner

    @property
    def url(self) -> str:
        return config.room_url(self.enc.room_id) if self.enc.room_id else ""

    @property
    def closed(self) -> bool:
        return self._closed or self.hub.stopping

    def human(self) -> Optional[dict[str, Any]]:
        """The human in the room: {id, name, online, ...} or None."""
        return self.enc.participant(FACULTY)

    def redact(self, text: Any) -> str:
        out = str(text or "")
        for name, instead in self.redact_names.items():
            words = [name, *[w for w in re.split(r"\s+", name) if len(w) >= 3 and w.lower().strip(".") not in
                             ("mrs", "miss", "baby", "master", "kumar", "devi", "doctor")]]
            for w in words:
                out = re.sub(rf"(?<!\w){re.escape(w)}(?!\w)", instead, out, flags=re.IGNORECASE)
            out = re.sub(rf"(?:{re.escape(instead)}[\s,]+)+{re.escape(instead)}", instead, out)
        return out

    def _redact_all(self, v: Any) -> Any:
        if isinstance(v, str):
            return self.redact(v)
        if isinstance(v, dict):
            return {k: self._redact_all(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [self._redact_all(x) for x in v]
        return v

    # ── what the browser sees ────────────────────────────────────────────────

    def update(self, **fields: Any) -> dict[str, Any]:
        """Merge into the state the browser gets as a `side` event (and from GET/open)."""
        self.state.update(fields)
        self.state["url"] = self.url
        self.hub.emit(self.enc, "side", key="side", side=dict(self.state))
        return self.state

    def emit(self, etype: str, key: str = "", **payload: Any) -> None:
        """Any other RoomEvent, for example `faculty` or `score`."""
        self.hub.emit(self.enc, etype, key, **payload)

    def speak(self, text: str, *, speaker: str = "", priority: str = "result", ref: str = "") -> None:
        """A `speak` event. `text` must already be in the room's language (bedside.line, Reply.spoken, say_free)."""
        text = bedside.clean_spoken(text, 600)
        if not text:
            return
        speak: dict[str, Any] = {"id": new_ref("spk"), "speaker": speaker or self.owner, "text": text, "lang": self.lang,
                                 "priority": priority}
        if ref:
            speak["ref"] = ref
        self.hub.emit(self.enc, "speak", speak=speak)

    async def in_lang(self, text: str) -> str:
        """Somebody's free text in the room's language, "" when it could not be translated."""
        return await bedside.translate(bedside.clean_spoken(text, 260), self.lang) or ""

    # ── posting ──────────────────────────────────────────────────────────────

    async def ensure(self) -> str:
        """Create the BAND room (once) and return its id. Raises BandError."""
        if not self.enc.room_id:
            await self.hub._ensure_room(self.enc)
            self.update()
            self._loop()
        return self.enc.room_id

    async def join(self, role: str, why: str = "") -> dict[str, Any]:
        """Bring an agent in (once). Raises BandError when it does not exist."""
        await self.ensure()
        return await self.hub._ensure_participant(self.enc, role, why or f"Adding {ROLES[role].name}")

    async def thought(self, text: str, as_role: str = "") -> None:
        """A visible step in the room. Never fails."""
        if self.enc.room_id:
            await self.hub._event(self.enc, self.redact(text), as_role)

    async def post(self, to: str, text: str, handoff: Optional[Handoff] = None, *, as_role: str = "", why: str = "") -> str:
        """One message from `as_role` (default: the owner) to one participant role ("faculty" = the human)."""
        async with self.enc.send_lock:
            return await self._post(to, text, handoff, as_role, why)

    async def _post(self, to: str, text: str, handoff: Optional[Handoff], as_role: str, why: str) -> str:
        await self.ensure()
        if as_role and as_role != self.owner:
            await self.hub._ensure_participant(self.enc, as_role, f"Adding {ROLES[as_role].name}")
        if to == FACULTY:
            person = self.enc.participant(FACULTY) or await self.add_human()
        else:
            person = await self.hub._ensure_participant(self.enc, to, why or f"Adding {ROLES[to].name}")
        if handoff is not None:
            handoff = Handoff(kind=handoff.kind, action=handoff.action, ref=handoff.ref, enc=self.id, lang=handoff.lang or self.lang,
                              spoken=self.redact(handoff.spoken), data=self._redact_all(handoff.data))
        return await self.hub._post(self.enc, person, self.redact(text), handoff, as_role)

    async def add_human(self) -> dict[str, Any]:
        """Add the human owner without a message (an agent in the room will write to them). Raises BandError."""
        await self.ensure()
        person = await self.hub._add_faculty(self.enc)
        if not self.enc.faculty_invited:
            self.enc.faculty_invited = True
            self.emit("faculty", faculty={"action": "invited", "name": person["name"], "text": ""})
        return person

    async def invite_human(self, text: str, *, as_role: str = "") -> dict[str, Any]:
        """Add the human owner and say why they are needed. Raises BandError."""
        await self.post(FACULTY, text, as_role=as_role)
        self._expect_until = time.monotonic() + LIVE_POLL_S
        self._loop()
        person = self.human()
        assert person is not None
        return person

    # ── asking and waiting ───────────────────────────────────────────────────

    def ref(self, prefix: str) -> str:
        return new_ref(prefix)

    async def request(self, to: str, action: str, text: str, data: Optional[dict[str, Any]] = None, *, kind: str = "request",
                      ref: str = "", as_role: str = "", timeout: float = 45.0, label: str = "", why: str = "") -> Reply:
        """Post a hand-off to a department and wait for its answer. Never raises.

        The answer is the first hand-off with this ref and action from that very participant to
        `as_role`. A `query` back (a question) is also returned: answer it with `post`, then `wait`.
        """
        r = self.file(to, action, text, data, kind=kind, ref=ref, as_role=as_role, label=label)
        wait = self._file_wait(r.ref, "", as_role or self.owner)
        try:
            async with self.enc.send_lock:
                await self.ensure()
                person = await self.hub._ensure_participant(self.enc, to, why or f"Adding {ROLES[to].name}")
                r.target_id = wait.target_id = person["id"]  # before posting: the answer can beat the response
                mid = await self._post(to, text, r.handoff, as_role, why)
                if mid:
                    r.message_ids.add(mid)
                    self.enc.msg_ref[mid] = r.ref
        except Exception as e:  # noqa: BLE001 - an outage is an answer too
            self._drop_wait(wait)
            log.warning("%s %s not sent: %s", self.kind.name, action, e if isinstance(e, band_client.BandError) else type(e).__name__)
            self.set_delegation(r.ref, "failed", f"Could not reach {ROLES[to].title.lower()}")
            return Reply(False, role=to, reason="unreachable", ref=r.ref)
        reply = await self._await(wait, timeout)
        if reply.kind != "query" and (reply.ok or reply.reason == "failed"):
            self.set_delegation(r.ref, "done" if reply.ok else "failed", reply.text or reply.reason)
        elif reply.kind == "query":
            self.set_delegation(r.ref, "waiting", waiting_on=as_role or self.owner)
        elif reply.reason == "timeout":
            self.set_delegation(r.ref, "timeout", f"No reply from {ROLES[to].name} yet")
        return reply

    def file(self, to: str, action: str, text: str, data: Optional[dict[str, Any]], *, kind: str = "request", ref: str = "",
             as_role: str = "", label: str = "") -> hubmod.Ref:
        """Register a delegation (shown on the stream) without sending it."""
        ref = ref or new_ref(re.sub(r"[^a-z]", "", action)[:8] or "side")
        h = Handoff(kind=kind, action=action, ref=ref, enc=self.id, lang=self.lang, data=data or {})
        r = hubmod.Ref(ref=ref, action=action, target=to, label=hubmod._clip(self.redact(label or text), 120), text=text, handoff=h,
                       started=hubmod._now(), deadline=float("inf"))
        self.enc.refs[ref] = r
        while len(self.enc.refs) > hubmod.MAX_REFS:
            self.enc.refs.popitem(last=False)
        self.emit("delegation", f"delegation:{ref}", delegation=self.hub._delegation(r))
        return r

    def set_delegation(self, ref: str, status: str, summary: Optional[str] = None, waiting_on: Optional[str] = None) -> None:
        r = self.enc.refs.get(ref)
        if r is not None:
            self.hub._set(self.enc, r, status, None if summary is None else self.redact(summary), waiting_on)

    async def wait(self, ref: str, timeout: float = 45.0, *, as_role: str = "") -> Reply:
        """Wait (again) for the participant `ref` was sent to."""
        r = self.enc.refs.get(ref)
        if r is None or not r.target_id:
            return Reply(False, reason="unreachable", ref=ref)
        return await self._await(self._file_wait(ref, r.target_id, as_role or self.owner), timeout)

    async def wait_human(self, timeout: float, *, to: str = "", after: int = 0) -> Reply:
        """The next thing a person in this room says (to `to`, when given). `after` = len(humans)
        you have already read, so nothing said while you were busy is lost."""
        for h in self.humans[after:]:
            if not to or to in h.to or not h.to:
                return h
        wait = self._file_wait("", "", "")
        wait.to = to
        return await self._await(wait, timeout)

    def _file_wait(self, ref: str, target_id: str, asker: str) -> _Wait:
        w = _Wait(ref=ref, target_id=target_id, asker=asker, future=asyncio.get_running_loop().create_future())
        self._waits.append(w)
        while len(self._waits) > MAX_WAITS:
            old = self._waits.pop(0)
            if old.future and not old.future.done():
                old.future.set_result(Reply(False, reason="closed"))
        return w

    def _drop_wait(self, w: _Wait) -> None:
        if w in self._waits:
            self._waits.remove(w)

    async def _await(self, w: _Wait, timeout: float) -> Reply:
        self._loop()
        assert w.future is not None
        try:
            return await asyncio.wait_for(asyncio.shield(w.future), timeout)
        except asyncio.TimeoutError:
            return Reply(False, reason="timeout", ref=w.ref)
        finally:
            self._drop_wait(w)

    # ── what arrives (called by the hub, once per message) ───────────────────

    def on_message(self, role: str, sender_id: str, msg: dict[str, Any], h: Optional[Handoff]) -> None:
        if msg.get("human"):
            self.hub.spawn(self._on_human(sender_id, msg), "side human")
            return
        if h is None or (h.enc and h.enc != self.id):
            return
        me = next((p["role"] for p in self.enc.people.values() if p["id"] == sender_id), role)
        if me in API_ROLES and sender_id in self._mine():
            self.sent.setdefault(h.ref, h)  # our own words are never an answer to us
            while len(self.sent) > hubmod.MAX_REFS:
                self.sent.pop(next(iter(self.sent)))
            return
        own = bedside.clean_spoken(h.spoken)
        spoken = own if langmod.norm_lang(h.lang) == self.lang and bedside.in_language(own, self.lang) else ""
        reply = Reply(True, role=me, name=msg.get("fromName", ""), text=msg.get("text", ""), kind=h.kind, data=h.data, spoken=spoken,
                      handoff=h, sender_id=sender_id, message_id=msg["id"], to=list(msg.get("to") or []), ref=h.ref)
        r = self.enc.refs.get(h.ref)
        if r is not None and r.target_id and sender_id != r.target_id:
            if h.kind not in ("request", "query") and r.handoff.kind in ("request", "query") and r.handoff.action == h.action:
                log.warning("%s tried to answer a ref delegated to %s; ignored", me, r.target)
                return
        for w in list(self._waits):
            if w.ref and w.ref == h.ref and w.target_id and w.target_id == sender_id and w.asker in reply.to:
                if r is not None and h.action != r.action:
                    continue
                if h.kind == "ack" and str(h.data.get("status") or "") not in FAILED_STATUSES:
                    continue
                if h.kind == "ack":
                    reply.ok, reply.reason = False, "failed"
                self._drop_wait(w)
                if w.future and not w.future.done():
                    w.future.set_result(reply)
                return
        self._tell_listener(reply)

    def _mine(self) -> set[str]:
        ids = {str(self.hub._me.get("id") or ""), *(str(x.get("id") or "") for x in self.hub._ids.values())}
        return ids - {""}

    async def _on_human(self, sender_id: str, msg: dict[str, Any]) -> None:
        person = self.enc.people.get(sender_id)
        if person is None or not person["human"]:
            await self.hub._refresh_people(self.enc)
            person = self.enc.people.get(sender_id)
        if person is None or not person["human"]:
            log.warning("a User who is not in the room was ignored")
            return
        if not self.enc.faculty_joined:
            self.hub._faculty_arrived(self.enc, person)
        self.enc.faculty_messages += 1
        reply = Reply(True, role=FACULTY, name=person["name"], text=str(msg.get("text") or ""), sender_id=sender_id,
                      message_id=msg["id"], to=list(msg.get("to") or []))
        self.humans.append(reply)
        del self.humans[:-MAX_HUMAN]
        self.emit("faculty", faculty={"action": "message", "name": person["name"], "text": bedside.clean_spoken(reply.text, 400)})
        claimed = False
        for w in list(self._waits):
            if not w.ref and (not w.to or not reply.to or w.to in reply.to):
                self._drop_wait(w)
                if w.future and not w.future.done():
                    w.future.set_result(reply)
                claimed = True
        if not claimed:
            self._tell_listener(reply)

    def _tell_listener(self, reply: Reply) -> None:
        if self.listener is None:
            return
        try:
            out = self.listener(self, reply)
            if asyncio.iscoroutine(out):
                self.hub.spawn(out, "side listener")
        except Exception as e:  # noqa: BLE001 - room content can be anything
            log.warning("side listener failed: %s", type(e).__name__)

    # ── lifetime ─────────────────────────────────────────────────────────────

    def expect(self, seconds: float = LIVE_POLL_S) -> None:
        """Somebody should answer within this long: keep polling fast."""
        self._expect_until = max(self._expect_until, time.monotonic() + seconds)
        self._loop()

    def _loop(self) -> None:
        if self.enc.room_id and not self.closed:
            self.hub._ensure_loop(self.enc)

    def busy(self) -> bool:
        return bool(self._waits) or (time.monotonic() < self._expect_until and not self.state.get("final"))

    def finished(self) -> bool:
        if self._closed:
            return True
        if self._waits or self.enc.waiters:
            return False
        return bool(self.state.get("final")) or hubmod._now() - self.enc.touched > IDLE_STOP_S

    def start(self, coro: Any) -> None:
        """Run this room's flow in the background; one at a time."""
        if self._task is not None and not self._task.done():
            coro.close()
            return
        self._task = self.hub.spawn(coro, f"side {self.kind.name}")

    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def cancel(self) -> None:
        """End every wait and the flow. Called when the room is dropped."""
        self._closed = True
        for w in self._waits:
            if w.future and not w.future.done():
                w.future.set_result(Reply(False, reason="closed", ref=w.ref))
        self._waits.clear()
        if self._task is not None:
            self._task.cancel()

    async def adopt(self, room_id: str) -> bool:
        """Take up an existing BAND room after a restart. Only a room whose transcript carries this
        room's own hand-offs, written by the owner, is accepted."""
        if self.enc.room_id or not re.fullmatch(r"[A-Za-z0-9-]{4,64}", room_id or ""):
            return False
        try:
            me = await self.hub.me(self.owner)
            page, _ = await self.hub.as_role(self.owner).context(room_id)
        except Exception as e:  # noqa: BLE001
            log.info("room not adopted: %s", type(e).__name__)
            return False
        from .protocol import decode

        mine = any(str(m.get("sender_id")) == str(me.get("id")) and (d := decode(str(m.get("content") or ""))[1]) is not None
                   and d.enc == self.id for m in page if isinstance(m, dict))
        if not mine or self.enc.room_id:
            return False
        self.enc.room_id = room_id
        self.hub.rooms[room_id] = self.id
        self.enc.people[str(me.get("id"))] = {"id": str(me.get("id")), "role": self.owner, "name": ROLES[self.owner].name,
                                              "title": ROLES[self.owner].title, "human": False, "online": True}
        self.hub._emit_room(self.enc)
        self.update()
        return True


# ── opening ────────────────────────────────────────────────────────────────


def get(kind: str, ref_id: str, hub: Optional[hubmod.Hub] = None) -> Optional[SideRoom]:
    enc = (hub or hubmod.hub).get(room_key(kind, ref_id))
    return enc.side if enc is not None else None


def by_id(side_id: str, hub: Optional[hubmod.Hub] = None) -> Optional[SideRoom]:
    enc = (hub or hubmod.hub).get(side_id)
    return enc.side if enc is not None else None


def open_room(kind: str, ref_id: str, *, title: str = "", lang: str = "en", context: Optional[dict[str, Any]] = None,
              redact: Optional[dict[str, str]] = None, hub: Optional[hubmod.Hub] = None) -> Optional[SideRoom]:
    """The side room of (kind, ref_id), created when needed. None when BAND is off. No BAND call is
    made yet: the room is created by the first post (or `ensure`). Must run on the event loop.

    `redact`: names that must never reach the room, with what to write instead, for example
    {"Ravi Kumar": "the patient"}. Applied to every text and hand-off this room posts."""
    hub = hub or hubmod.hub
    k = KINDS.get(kind)
    if k is None or not REF_ID.fullmatch(ref_id or ""):
        raise ValueError("bad side room")
    if not available(k.owner) or hub.stopping:
        return None
    sid = room_key(kind, ref_id)
    enc = hub.get(sid)
    if enc is not None and enc.side is not None:
        enc.lang = langmod.norm_lang(lang)
        enc.touched = hubmod._now()
        enc.side.redact_names.update({n: v for n, v in (redact or {}).items() if len(n.strip()) >= 3})
        return enc.side
    t = time.monotonic()
    _opened[:] = [x for x in _opened if t - x < OPEN_WINDOW_S]
    if len(_opened) >= OPEN_LIMIT:
        log.warning("too many side rooms in a short time; %s not opened", kind)
        return None
    _opened.append(t)
    _prune(hub)
    now = hubmod._now()
    enc = hubmod.Encounter(id=sid, case_id="", lang=langmod.norm_lang(lang), osce=False, patient={}, doctor="", created=now, touched=now)
    enc.owner = k.owner
    side = SideRoom(hub, enc, k, ref_id, context or {}, redact or {})
    enc.side = side
    extra = side.redact(title).strip()
    enc.title = hubmod._clip(f"{k.title}: {extra}" if k.title and extra else k.title or extra or f"MedSim {kind.replace('_', ' ')}", 90)
    hub.encounters[sid] = enc
    side.update()
    return side


def _prune(hub: hubmod.Hub) -> None:
    hub._prune()
    sides = [e for e in hub.encounters.values() if e.side is not None]
    # Finished and unwatched ones go first, then the oldest.
    sides.sort(key=lambda e: (bool(e.waiters) or e.side.running(), not e.side.state.get("final"), e.touched))
    for e in sides[: max(0, len(sides) - MAX_SIDE_ROOMS + 1)]:
        hub._drop(e.id)
    while len(hub.encounters) >= hubmod.MAX_ENCOUNTERS:
        hub._drop(next(iter(hub.encounters)))


async def open_http(kind: str, ref_id: str, *, title: str, lang: str, context: dict[str, Any], room_id: str = "",
                    hub: Optional[hubmod.Hub] = None) -> Optional[SideRoom]:
    """POST /agent/room/side/open. Starts the kind's flow once. ValueError = refuse."""
    k = KINDS.get(kind)
    if k is None or not k.http:
        raise ValueError("unknown kind")
    if not REF_ID.fullmatch(ref_id or ""):
        raise ValueError("bad refId")
    known = get(kind, ref_id, hub)
    if known is None and k.check is not None:
        context = k.check(ref_id, context)  # a known room keeps the context it was opened with
    side = open_room(kind, ref_id, title=title, lang=lang, context=context, hub=hub)
    if side is None:
        return None
    if known is None and room_id:
        await side.adopt(room_id)
    if side.enc.room_id:
        side._loop()
    if known is None and k.flow is not None:
        side.start(k.flow(side, side.context))
    return side
