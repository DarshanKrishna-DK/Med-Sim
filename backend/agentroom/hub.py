"""The room hub: one state machine per encounter between Nurse Asha and the BAND room.

Asha delegates (`delegate_rx`, `delegate_tests`, `ask`), departments answer in
the room, and the hub turns their messages into chart changes, spoken lines and
UI events on a per-encounter log the browser follows by SSE.

Trust rules, all enforced here and nowhere else:
  * a message changes the chart only if its sender is the participant the ref
    was delegated to, the ref is ours, and its contents match what we asked;
  * every result is applied once (message id and ref state);
  * our own hard-conflict check beats a pharmacist's release;
  * only a human (User) participant of that very room can release a hold, and
    only with words that cannot be read any other way.

Single process, in memory, bounded. Nothing here raises into its callers' turn:
posting happens in background tasks, and a BAND outage only fails the delegation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Optional

import lang as langmod

from . import bedside, client as band_client, config, faculty as facultymod
from .protocol import (
    AGENT_ROLES, API_ROLES, EXAMINER, FACULTY, LAB, NURSE, PHARMACIST, RADIOLOGY, ROLES, WORKER_ROLES,
    Handoff, decode, encode, new_ref, strip_mentions,
)

log = logging.getLogger("medsim.room.hub")

MAX_ENCOUNTERS = 200
MAX_EVENTS = 500
MAX_MESSAGES = 400
MAX_REFS = 80
TTL_S = 4 * 3600
TIMEOUT_S = 45.0
SCORE_TIMEOUT_S = 120.0
POLL_BUSY_S = 2.0
POLL_IDLE_S = 10.0
LOOP_IDLE_STOP_S = 20 * 60
CLOSE_KEEP_S = 10 * 60
COALESCE_S = 1.5
KEEPALIVE_S = 15.0
STREAM_MAX_S = 300.0
STALE_SPEAK_S = 20.0
STATUS_CACHE_S = 10.0

OPEN = ("sent", "working", "waiting")
LATE_OK = (*OPEN, "timeout", "failed")  # a late result is still accepted
DELIVERY_RANK = {"sent": 0, "delivered": 1, "processing": 2, "processed": 3, "failed": 4}
SPOKEN_ROLES = (PHARMACIST, LAB, RADIOLOGY)
# Events that must survive trimming: losing one would desynchronise the chart.
KEEP_TYPES = ("apply", "delegation", "room", "score", "status", "side")

ENCOUNTER_ID = re.compile(r"[A-Za-z0-9_.:-]{1,120}")

_WHY = {
    ("verify_rx", PHARMACIST): "Adding pharmacy: first prescription of this encounter",
    ("ask", PHARMACIST): "Adding pharmacy: the doctor has a question for the pharmacist",
    ("run_test", LAB): "Adding the laboratory: first test order of this encounter",
    ("ask", LAB): "Adding the laboratory: the doctor has a question for the lab",
    ("run_imaging", RADIOLOGY): "Adding radiology: first imaging order of this encounter",
    ("ask", RADIOLOGY): "Adding radiology: the doctor has a question for the radiologist",
    ("score_teamwork", EXAMINER): "Adding the examiner: the encounter is over and the teamwork needs marking",
}


def _now() -> float:  # tests patch this
    return time.time()


def _iso(t: Optional[float] = None) -> str:
    return datetime.fromtimestamp(_now() if t is None else t, timezone.utc).isoformat().replace("+00:00", "Z")


def _clip(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def handle_suffix(handle: Any) -> str:
    return str(handle or "").lstrip("@").rsplit("/", 1)[-1].lower()


# ── state ──────────────────────────────────────────────────────────────────


@dataclass
class Ref:
    ref: str
    action: str
    target: str
    label: str
    text: str                       # the plain sentence posted with the hand-off
    handoff: Handoff
    status: str = "sent"
    started: float = 0.0
    finished: Optional[float] = None
    waiting_on: Optional[str] = None
    summary: str = ""
    medication_id: str = ""
    medication: str = ""
    dose: str = ""
    duration: str = ""
    tests: list[dict[str, str]] = field(default_factory=list)
    target_id: str = ""             # the participant the request was sent to
    message_ids: set[str] = field(default_factory=set)
    local_hard: list[str] = field(default_factory=list)
    resulted: set[str] = field(default_factory=set)
    verdict_done: bool = False
    active: bool = False            # the drug is on the prescription through this ref
    question: str = ""              # what the department waits for the doctor to answer
    override_requested: bool = False
    held_at: Optional[float] = None
    deadline: float = 0.0
    retries: int = 0
    recorded: bool = False          # FHIR side effect done
    severity: str = ""              # of the hold: hard | soft | ""
    override_reasons: list[bool] = field(default_factory=list)  # one per request: was a reason given

    @property
    def test_ids(self) -> list[str]:
        return [t["testId"] for t in self.tests]

    def name_of(self, test_id: str) -> str:
        return next((t["name"] for t in self.tests if t["testId"] == test_id), test_id)


@dataclass
class Encounter:
    id: str
    case_id: str
    lang: str
    osce: bool
    patient: dict[str, Any]
    doctor: str
    created: float
    touched: float
    room_id: str = ""
    title: str = ""
    seq: int = 0
    events: "OrderedDict[int, dict[str, Any]]" = field(default_factory=OrderedDict)
    keys: dict[str, int] = field(default_factory=dict)
    waiters: set[asyncio.Event] = field(default_factory=set)
    people: dict[str, dict[str, Any]] = field(default_factory=dict)   # participant id -> RoomParticipant
    messages: "OrderedDict[str, dict[str, Any]]" = field(default_factory=OrderedDict)
    handled: "OrderedDict[str, None]" = field(default_factory=OrderedDict)
    refs: "OrderedDict[str, Ref]" = field(default_factory=OrderedDict)
    msg_ref: dict[str, str] = field(default_factory=dict)
    results: dict[str, dict[str, Any]] = field(default_factory=dict)  # testId -> RoomTestResult
    held_suggestions: set[str] = field(default_factory=set)
    current: list[dict[str, str]] = field(default_factory=list)       # drugs on the chart, as the browser knows them
    med_names: dict[str, str] = field(default_factory=dict)           # catalog names, to notice other drugs in faculty text
    cursors: dict[str, Optional[str]] = field(default_factory=dict)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    room_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    faculty_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    poll_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    kick: asyncio.Event = field(default_factory=asyncio.Event)
    loop_task: Optional[asyncio.Task] = None
    speak_queue: list[dict[str, Any]] = field(default_factory=list)
    flush_task: Optional[asyncio.Task] = None
    awaiting_faculty: bool = False
    faculty_invited: bool = False
    faculty_joined: bool = False
    faculty_messages: int = 0
    faculty_to_examiner: bool = False
    last_people_at: float = 0.0
    timeline: list[dict[str, str]] = field(default_factory=list)
    criticals: list[dict[str, Any]] = field(default_factory=list)
    tally: dict[str, int] = field(default_factory=dict)
    closed: Optional[float] = None
    faculty_asks: list[dict[str, Any]] = field(default_factory=list)  # {by, at, answeredAt}: questions from the human
    score_ref: str = ""
    score_final: bool = False
    owner: str = NURSE              # the API participant that opened the room
    side: Any = None                # siderooms.SideRoom: the room is not a bedside encounter

    def participant(self, role: str) -> Optional[dict[str, Any]]:
        return next((p for p in self.people.values() if p["role"] == role), None)

    def humans(self) -> list[dict[str, Any]]:
        return [p for p in self.people.values() if p["human"]]

    def bump(self, what: str, n: int = 1) -> None:
        self.tally[what] = self.tally.get(what, 0) + n


class Hub:
    def __init__(self, client_for: Optional[Callable[[str], Any]] = None):
        self._client_for = client_for or band_client.for_role
        self.encounters: "OrderedDict[str, Encounter]" = OrderedDict()
        self.rooms: dict[str, str] = {}
        self._tasks: set[asyncio.Task] = set()
        self._me: dict[str, Any] = {}
        self._ids: dict[str, dict[str, Any]] = {}  # other API participants
        self._status_cache: tuple[float, dict[str, bool]] = (0.0, {})
        self.stopping = False
        self.started = False  # the server lifespan runs (red flags never post from a test process)
        # Set by start(): real-world side effects of a released drug (never in unit tests).
        self.record_release: Optional[Callable[["Encounter", Ref], Any]] = None
        self.supervisor_status: Optional[Callable[[], dict[str, bool]]] = None
        self.asha_online: Callable[[], bool] = lambda: False

    # ── basics ───────────────────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        return config.enabled()

    @property
    def asha(self) -> Any:
        c = self._client_for(NURSE)
        if c is None:
            raise band_client.BandError("BAND is not configured")
        return c

    def spawn(self, coro: Any, name: str = "") -> asyncio.Task:
        async def run() -> None:
            try:
                await coro
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - a background step never takes the API down
                log.warning("room task %s failed: %s", name, e if isinstance(e, band_client.BandError) else type(e).__name__)

        task = asyncio.ensure_future(run())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def stop(self) -> None:
        self.stopping = True
        for enc in self.encounters.values():
            for w in list(enc.waiters):
                w.set()
        tasks = [t for t in self._tasks if t is not asyncio.current_task()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def as_role(self, role: str) -> Any:
        """The REST client of one participant of this process."""
        if role == NURSE:
            return self.asha
        c = self._client_for(role)
        if c is None:
            raise band_client.BandError(f"no BAND key for {role}")
        return c

    async def me(self, role: str = NURSE) -> dict[str, Any]:
        if role != NURSE:
            if role not in self._ids:
                self._ids[role] = await self.as_role(role).me()
            return self._ids[role]
        if not self._me:
            self._me = await self.asha.me()
        return self._me

    # ── encounters ───────────────────────────────────────────────────────────

    def open(self, encounter_id: str, case_id: str, lang: str, osce: bool, patient: dict[str, Any], doctor: str = "") -> bool:
        """Register (or refresh) an encounter. False when BAND is off."""
        if not self.enabled or not ENCOUNTER_ID.fullmatch(encounter_id or ""):
            return False
        self._prune()
        enc = self.encounters.get(encounter_id)
        if enc is not None and enc.side is not None:
            return False  # a side room is opened by siderooms.py only
        if enc is None:
            enc = Encounter(id=encounter_id, case_id=_clip(case_id, 80), lang=langmod.norm_lang(lang), osce=bool(osce),
                            patient=patient, doctor=_clip(doctor, 80), created=_now(), touched=_now())
            self.encounters[encounter_id] = enc
            while len(self.encounters) > MAX_ENCOUNTERS:
                self._drop(next(iter(self.encounters)))
        else:
            enc.lang, enc.osce, enc.patient = langmod.norm_lang(lang), bool(osce), patient
            enc.doctor = _clip(doctor, 80) or enc.doctor
            enc.touched = _now()
            if enc.closed and not enc.score_ref:
                enc.closed = None
        self.spawn(self._emit_status(enc), "status")
        return True

    def get(self, encounter_id: Optional[str]) -> Optional[Encounter]:
        return self.encounters.get(encounter_id or "")

    def active(self, encounter_id: Optional[str]) -> Optional[Encounter]:
        """The encounter when it is in room mode (BAND on, opened, not closed), else None."""
        enc = self.get(encounter_id) if self.enabled else None
        return enc if enc is not None and enc.closed is None and enc.side is None else None

    def _drop(self, encounter_id: str) -> None:
        enc = self.encounters.pop(encounter_id, None)
        if enc is None:
            return
        self.rooms.pop(enc.room_id, None)
        if enc.side is not None:
            enc.side.cancel()
        if enc.loop_task:
            enc.loop_task.cancel()
        for w in list(enc.waiters):
            w.set()

    def _prune(self) -> None:
        now = _now()
        for eid in [e.id for e in self.encounters.values() if now - e.touched > TTL_S]:
            self._drop(eid)

    # ── event log and SSE ────────────────────────────────────────────────────

    def emit(self, enc: Encounter, etype: str, key: str = "", **payload: Any) -> dict[str, Any]:
        """Append one event. With a key it replaces the previous event of that key (upsert)."""
        enc.seq += 1
        enc.touched = _now()
        ev = {"seq": enc.seq, "at": _iso(), "type": etype, **payload}
        if key:
            enc.events.pop(enc.keys.get(key, -1), None)
            enc.keys[key] = enc.seq
        enc.events[enc.seq] = ev
        while len(enc.events) > MAX_EVENTS:
            victim = next((s for s, e in enc.events.items() if e["type"] not in KEEP_TYPES), next(iter(enc.events)))
            enc.events.pop(victim, None)
        for w in list(enc.waiters):
            w.set()
        return ev

    async def stream(self, enc: Encounter, after: int = 0) -> AsyncIterator[str]:
        """SSE frames: replay from `after`, then live, with keepalives."""
        waiter = asyncio.Event()
        enc.waiters.add(waiter)
        cursor = after if 0 <= after <= enc.seq else 0  # a cursor from before a restart starts over
        started = time.monotonic()
        try:
            yield "retry: 1500\n\n"
            while not self.stopping and self.encounters.get(enc.id) is enc:
                waiter.clear()
                batch = [e for s, e in list(enc.events.items()) if s > cursor]
                for ev in batch:
                    cursor = ev["seq"]
                    if ev["type"] == "speak" and _now() - datetime.fromisoformat(ev["at"].replace("Z", "+00:00")).timestamp() > STALE_SPEAK_S:
                        continue  # a reload must not read old lines out again
                    yield f"id: {ev['seq']}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if time.monotonic() - started > STREAM_MAX_S:
                    return  # EventSource reconnects with its cursor
                if waiter.is_set():
                    continue
                try:
                    await asyncio.wait_for(waiter.wait(), timeout=KEEPALIVE_S)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            enc.waiters.discard(waiter)

    def _delegation(self, r: Ref) -> dict[str, Any]:
        d: dict[str, Any] = {"ref": r.ref, "action": r.action, "target": r.target, "status": r.status, "label": r.label,
                             "startedAt": _iso(r.started)}
        if r.finished:
            d["finishedAt"] = _iso(r.finished)
        if r.waiting_on and r.status == "waiting":
            d["waitingOn"] = r.waiting_on
        if r.summary:
            d["summary"] = r.summary
        if r.medication_id:
            d.update(medicationId=r.medication_id, dose=r.dose, duration=r.duration)
        if r.tests:
            d["testIds"] = r.test_ids
        return d

    def _set(self, enc: Encounter, r: Ref, status: str, summary: Optional[str] = None, waiting_on: Optional[str] = None) -> None:
        if summary is not None:
            r.summary = _clip(summary, 240)
        if status == r.status and waiting_on == r.waiting_on and summary is None:
            return
        r.status, r.waiting_on = status, waiting_on
        r.finished = None if status in OPEN else _now()
        self.emit(enc, "delegation", key=f"delegation:{r.ref}", delegation=self._delegation(r))
        enc.kick.set()

    def _log(self, enc: Encounter, who: str, what: str) -> None:
        enc.timeline.append({"at": _iso(), "who": who, "what": _clip(what, 200)})
        del enc.timeline[:-120]

    # ── status ───────────────────────────────────────────────────────────────

    async def departments(self) -> dict[str, bool]:
        """Who is reachable: our own worker processes first, else BAND's presence."""
        at, cached = self._status_cache
        if cached and time.monotonic() - at < STATUS_CACHE_S:
            return dict(cached)
        out = {role: False for role in WORKER_ROLES}
        try:
            if self.supervisor_status:
                out.update({r: bool(v) for r, v in self.supervisor_status().items() if r in out})
        except Exception as e:  # noqa: BLE001
            log.debug("supervisor status failed: %s", type(e).__name__)
        if not all(out.values()):
            try:
                for p in await asyncio.wait_for(self._peers(), timeout=4.0):
                    role = self._role_of_peer(p)
                    if role in out and p.get("online"):
                        out[role] = True
            except Exception as e:  # noqa: BLE001
                log.debug("peers unavailable: %s", type(e).__name__)
        out[NURSE] = True
        out.update({r: True for r in API_ROLES if config.api_key(r)})
        self._status_cache = (time.monotonic(), dict(out))
        return out

    async def status(self) -> dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "reason": config.disabled_reason(), "departments": {}}
        return {"enabled": True, "departments": await self.departments()}

    async def _emit_status(self, enc: Encounter) -> None:
        self.emit(enc, "status", key="status", enabled=True, departments=await self.departments())

    # ── roster ───────────────────────────────────────────────────────────────

    async def _peers(self, role: str = NURSE) -> list[dict[str, Any]]:
        await self.me()
        return await self.as_role(role).peers()

    def _role_of_peer(self, p: dict[str, Any]) -> str:
        """Role of a sibling agent. Only agents of our own account count: a stranger
        could register any handle suffix."""
        if str(p.get("type") or "").lower() == "user":
            return FACULTY
        handle = str(p.get("handle") or "").lstrip("@").lower()
        owner = str(self._me.get("handle") or "").lstrip("@").lower().rpartition("/")[0]
        if not owner or handle.rpartition("/")[0] != owner:
            return ""
        return next((r for r in AGENT_ROLES if ROLES[r].handle == handle_suffix(handle)), "")

    def _person(self, p: dict[str, Any], online: Optional[bool] = None) -> Optional[dict[str, Any]]:
        role = self._role_of_peer(p)
        pid = str(p.get("id") or "")
        if not role or not pid:
            return None
        human = role == FACULTY
        return {"id": pid, "role": role, "name": _clip(p.get("name") or (ROLES[role].name if not human else "Faculty"), 80),
                "title": "Faculty" if human else ROLES[role].title, "human": human,
                "online": bool(p.get("online")) if online is None else online}

    def _emit_room(self, enc: Encounter) -> None:
        self.emit(enc, "room", key="room", roomId=enc.room_id, url=config.room_url(enc.room_id), title=enc.title,
                  participants=list(enc.people.values()))

    def _title(self, enc: Encounter) -> str:
        p = enc.patient
        age = p.get("age")
        who = f"{int(age)}{_clip(p.get('gender'), 1).upper()}" if isinstance(age, (int, float)) else "Patient"
        complaint = self._redact(enc, _clip(p.get("chiefComplaint"), 200)).strip(" .\"'")
        return _clip(f"MedSim: {who} {complaint}", 90).rstrip(" .,")

    def _redact(self, enc: Encounter, text: str) -> str:
        """Free text without the patient's name (minimum disclosure)."""
        name = str(enc.patient.get("name") or "")
        out = text or ""
        for part in [name, *[w for w in re.split(r"\s+", name) if len(w) >= 3 and w.lower().strip(".") not in ("mrs", "miss", "baby", "master", "kumar", "devi")]]:
            if part.strip():
                out = re.sub(rf"(?<!\w){re.escape(part.strip())}(?!\w)", "the patient", out, flags=re.IGNORECASE)
        return re.sub(r"(?:the patient[\s,]+)+the patient", "the patient", out)

    async def _ensure_room(self, enc: Encounter) -> None:
        async with enc.room_lock:
            if enc.room_id:
                return
            me = await self.me(enc.owner)
            enc.title = enc.title or self._title(enc)
            chat = await self.as_role(enc.owner).create_chat(enc.title)
            room_id = str(chat.get("id") or "")
            if not room_id:
                raise band_client.BandError("no room id in the reply")
            enc.room_id = room_id
            self.rooms[room_id] = enc.id
            enc.people[str(me.get("id"))] = {"id": str(me.get("id")), "role": enc.owner, "name": ROLES[enc.owner].name,
                                             "title": ROLES[enc.owner].title, "human": False, "online": True}
            self._emit_room(enc)
            self._log(enc, enc.owner, "Opened the room")
        if enc.side is None:
            await self._event(enc, "Opened a room for this encounter. I add a department only when this case needs it.")

    async def _event(self, enc: Encounter, text: str, role: str = "") -> None:
        """A thought in the room, shown right away. Never fails the caller."""
        try:
            me = await self.me(role or enc.owner)
            ev = await self.as_role(role or enc.owner).send_event(enc.room_id, text, "thought")
            if ev.get("id"):
                self._ingest(enc, {"id": ev["id"], "sender_id": me.get("id"), "sender_type": "Agent", "content": text,
                                   "message_type": "thought", "metadata": {}, "inserted_at": ev.get("inserted_at") or _iso()})
        except Exception as e:  # noqa: BLE001
            log.info("room event not posted: %s", type(e).__name__)

    async def _ensure_participant(self, enc: Encounter, role: str, why: str) -> dict[str, Any]:
        async with enc.room_lock:
            p = enc.participant(role)
            if p:
                return p
            peer = next((x for x in await self._peers(enc.owner) if self._role_of_peer(x) == role), None)
            if peer is None:
                raise band_client.BandError(f"no {role} among the peers")
            person = self._person(peer)
            if person is None:
                raise band_client.BandError(f"no {role} among the peers")
            try:
                await self.as_role(enc.owner).add_participant(enc.room_id, person["id"])
            except band_client.BandError as e:
                if e.status not in (409, 422):  # already in (another department may have added it)
                    raise
            enc.people[person["id"]] = person
            self._emit_room(enc)
            self._log(enc, enc.owner, why)
        await self._event(enc, why)
        return person

    async def _add_faculty(self, enc: Encounter) -> dict[str, Any]:
        async with enc.room_lock:
            p = enc.participant(FACULTY)
            if p:
                return p
            me = await self.me(enc.owner)
            owner = str(me.get("owner_uuid") or "")
            if not owner:
                raise band_client.BandError("this agent has no human owner")
            peer = next((x for x in await self._peers(enc.owner) if str(x.get("id")) == owner), None)
            person = self._person(peer or {"id": owner, "name": "Faculty", "type": "User"}, online=False)
            assert person is not None
            try:
                await self.as_role(enc.owner).add_participant(enc.room_id, owner)
            except band_client.BandError as e:
                if e.status not in (409, 422):
                    raise
            enc.people[owner] = person
            self._emit_room(enc)
            return person

    async def _refresh_people(self, enc: Encounter) -> None:
        await self.me()
        enc.last_people_at = _now()
        seen: set[str] = set()
        changed = False
        for raw in await self.as_role(enc.owner).participants(enc.room_id):
            if str(raw.get("status") or "active").lower() in ("removed", "left"):
                continue
            p = self._person(raw)
            if p is None:
                continue
            if p["role"] in API_ROLES:
                p["online"] = True
            seen.add(p["id"])
            old = enc.people.get(p["id"])
            if old != p:
                enc.people[p["id"]] = p
                changed = True
            if p["human"] and p["online"] and not enc.faculty_joined:
                self._faculty_arrived(enc, p)
        for pid in [x for x in enc.people if x not in seen and enc.people[x]["role"] != enc.owner]:
            gone = enc.people.pop(pid)
            changed = True
            if gone["human"]:
                enc.faculty_joined = False
                self.emit(enc, "faculty", faculty={"action": "left", "name": gone["name"], "text": ""})
                self._log(enc, "faculty", f"{gone['name']} left the room")
        if changed:
            self._emit_room(enc)

    def _faculty_arrived(self, enc: Encounter, p: dict[str, Any]) -> None:
        if enc.faculty_joined:
            return
        enc.faculty_joined = True
        self.emit(enc, "faculty", faculty={"action": "joined", "name": p["name"], "text": ""})
        self._log(enc, "faculty", f"{p['name']} joined the room")
        self._speak(enc, NURSE, bedside.line("fac_joined", enc.lang, name=self._called(p["name"])), "chat")

    @staticmethod
    def _called(name: str) -> str:
        first = re.sub(r"^(?:dr|doctor|prof)\.?\s+", "", _clip(name, 60), flags=re.IGNORECASE).split(" ")[0]
        return f"Dr {first}" if first and first.lower() != "faculty" else "Faculty"

    # ── posting ──────────────────────────────────────────────────────────────

    async def _post(self, enc: Encounter, person: dict[str, Any], text: str, handoff: Optional[Handoff] = None,
                    role: str = "") -> str:
        """Post a message mentioning one participant; only they receive it. Returns the message id."""
        me = await self.me(role or enc.owner)
        content = f"@{person['name']} {text}"
        if handoff:
            content = encode(content, handoff)
        r = await self.as_role(role or enc.owner).send_message(enc.room_id, content, [{"id": person["id"], "name": person["name"]}])
        mid = str(r.get("id") or "")
        if mid:
            self._ingest(enc, {"id": mid, "sender_id": me.get("id"), "sender_type": "Agent", "content": content,
                               "message_type": "text", "metadata": {"mentions": [{"id": person["id"]}]},
                               "inserted_at": r.get("inserted_at") or _iso()})
        return mid

    def _new_ref(self, enc: Encounter, prefix: str, action: str, target: str, label: str, text: str,
                 data: dict[str, Any], **extra: Any) -> Ref:
        ref = new_ref(prefix)
        while ref in enc.refs:
            ref = new_ref(prefix)
        h = Handoff(kind="request", action=action, ref=ref, enc=enc.id, lang=enc.lang, data=data)
        r = Ref(ref=ref, action=action, target=target, label=_clip(label, 120), text=text, handoff=h, started=_now(), **extra)
        r.deadline = r.started + (SCORE_TIMEOUT_S if action == "score_teamwork" else TIMEOUT_S)
        enc.refs[ref] = r
        while len(enc.refs) > MAX_REFS:
            old = next((k for k, v in enc.refs.items() if v.status not in OPEN and v.status != "held" and not v.active), None)
            if old is None:
                break
            enc.refs.pop(old)
        self.emit(enc, "delegation", key=f"delegation:{ref}", delegation=self._delegation(r))
        self._ensure_loop(enc)
        self.spawn(self._send(enc, r), f"send {action}")
        return r

    async def _send(self, enc: Encounter, r: Ref) -> None:
        async with enc.send_lock:
            if r.status not in OPEN:
                return
            try:
                await self._ensure_room(enc)
                why = _WHY.get((r.action, r.target), f"Adding {ROLES[r.target].name}")
                person = await self._ensure_participant(enc, r.target, why)
                r.target_id = person["id"]  # set before posting: the answer can beat the response
                mid = await self._post(enc, person, r.text, r.handoff)
                if mid:
                    r.message_ids.add(mid)
                    enc.msg_ref[mid] = r.ref
                self._log(enc, "nurse", f"Sent {r.label} to {ROLES[r.target].name}")
            except Exception as e:  # noqa: BLE001 - an outage fails this delegation, nothing else
                log.warning("delegation %s not sent: %s", r.action, e if isinstance(e, band_client.BandError) else type(e).__name__)
                if r.status in OPEN:
                    self._set(enc, r, "failed", f"Could not reach {ROLES[r.target].title.lower()}")
                    enc.bump("failed")
                    if r.action != "score_teamwork":
                        self._speak(enc, NURSE, bedside.line("unreachable", enc.lang, item=r.label,
                                                             dept=bedside.department(r.target, enc.lang)), "result", r.ref)

    # ── delegations (called by the nurse and the routes; never block, never raise) ──

    def _people_facts(self, enc: Encounter) -> dict[str, Any]:
        return {"age": enc.patient.get("age"), "gender": _clip(enc.patient.get("gender"), 16)}

    def _history(self, enc: Encounter) -> list[dict[str, str]]:
        return [{"question": self._redact(enc, _clip(qa.get("question"), 200)), "answer": self._redact(enc, _clip(qa.get("answer"), 400))}
                for qa in (enc.patient.get("anamnesis") or [])[:20]
                if isinstance(qa, dict) and (qa.get("question") or qa.get("answer"))]

    def active_drugs(self, enc: Encounter) -> list[dict[str, str]]:
        """On the prescription now: what the browser reported plus what the room released since."""
        out = {d["medicationId"]: d for d in enc.current if d.get("medicationId")}
        for r in enc.refs.values():
            if r.action == "verify_rx" and r.active:
                out[r.medication_id] = {"medicationId": r.medication_id, "name": r.medication, "dose": r.dose}
        return list(out.values())

    def set_chart(self, enc: Encounter, current: list[dict[str, str]], med_names: Optional[dict[str, str]] = None) -> None:
        enc.current = [{k: _clip(d.get(k), 120) for k in ("medicationId", "name", "dose")} for d in current[:30]]
        if med_names:
            enc.med_names = dict(list(med_names.items())[:400])

    def rx_ref(self, enc: Encounter, medication_id: str, statuses: tuple[str, ...]) -> Optional[Ref]:
        return next((r for r in reversed(enc.refs.values())
                     if r.action == "verify_rx" and r.medication_id == medication_id and r.status in statuses), None)

    @staticmethod
    def _rx_label(medication: str, dose: str) -> str:
        """'Amoxicillin 500mg' + '250 mg three times a day' -> 'Amoxicillin 250 mg'."""
        unit = "(?:mg|mcg|g|ml|units?|iu)"
        m = re.match("([0-9.]+) ?(" + unit + ")(?![a-z])", dose or "", re.IGNORECASE)
        if not m:
            return medication
        return re.sub(" ?[0-9.]+ ?" + unit + "$", "", medication, flags=re.IGNORECASE) + f" {m.group(1)} {m.group(2)}"

    def delegate_rx(self, enc: Encounter, medication_id: str, medication: str, dose: str, duration: str,
                    local_hard: Optional[list[str]] = None) -> Ref:
        current = [d for d in self.active_drugs(enc) if d["medicationId"] != medication_id]
        for r in enc.refs.values():  # drugs ordered together are checked against each other
            if r.action == "verify_rx" and r.status in OPEN and r.medication_id != medication_id:
                current.append({"medicationId": r.medication_id, "name": r.medication, "dose": r.dose})
        p = enc.patient
        label = self._rx_label(medication, dose)
        data = {
            "caseId": enc.case_id, "medicationId": medication_id, "medication": medication, "dose": dose, "duration": duration,
            "patient": {**self._people_facts(enc), "allergies": self._redact(enc, _clip(p.get("allergies"), 600)),
                        "chiefComplaint": self._redact(enc, _clip(p.get("chiefComplaint"), 300)), "history": self._history(enc)},
            "current": current[:30], "osce": enc.osce,
        }
        if medication_id in enc.held_suggestions:
            enc.bump("suggestionsTaken")
        if any(r.action == "verify_rx" and r.medication_id == medication_id and r.status == "held" for r in enc.refs.values()):
            enc.bump("heldDrugReordered")
        enc.bump("prescriptionsSent")
        return self._new_ref(enc, "rx", "verify_rx", PHARMACIST, label,
                             f"Please verify {medication}, {dose} for {duration}, before it goes on the prescription.", data,
                             medication_id=medication_id, medication=medication, dose=dose, duration=duration,
                             local_hard=list(local_hard or []))

    def delegate_tests(self, enc: Encounter, tests: list[dict[str, str]]) -> list[Ref]:
        """One message per department: imaging goes to radiology, lab and bedside to the lab."""
        out: list[Ref] = []
        for target, action, prefix in ((LAB, "run_test", "lab"), (RADIOLOGY, "run_imaging", "img")):
            mine = [{"testId": t["testId"], "name": _clip(t.get("name") or t["testId"], 80)} for t in tests
                    if (t.get("category") == "imaging") == (target == RADIOLOGY)]
            if not mine:
                continue
            names = ", ".join(t["name"] for t in mine)
            data: dict[str, Any] = {"caseId": enc.case_id, "tests": mine, "patient": self._people_facts(enc)}
            if target == RADIOLOGY:
                data["indication"] = self._redact(enc, _clip(enc.patient.get("chiefComplaint"), 300))
                data["pregnancy"] = self._pregnancy(enc)
            enc.bump("testsOrdered", len(mine))
            text = f"Please run {names}." if target == LAB else f"Please do {names}. Indication: {data['indication'] or 'not stated'}."
            out.append(self._new_ref(enc, prefix, action, target, names, text, data, tests=mine))
        return out

    def _pregnancy(self, enc: Encounter) -> str:
        p = enc.patient
        if _clip(p.get("gender"), 1).upper() == "M":
            return "no"
        age = p.get("age")
        if isinstance(age, (int, float)) and (age < 10 or age > 58):
            return "no"
        complaint = str(p.get("chiefComplaint") or "").lower()
        if re.search(r"\b(?:i am|i'm|she is|she's|\d+ weeks?) pregnant\b|\bantenatal\b|\bweeks pregnant\b", complaint):
            return "yes"
        for qa in p.get("anamnesis") or []:
            q, a = str((qa or {}).get("question") or "").lower(), str((qa or {}).get("answer") or "").lower().strip()
            if "pregnan" in q:
                if re.match(r"^\W*(?:yes|yeah|i am|\d+ weeks)", a):
                    return "yes"
                if re.match(r"^\W*(?:no|not|never)\b", a):
                    return "no"
            elif re.search(r"\bi(?:'m| am) (?:\w+ ){0,2}pregnant\b", a):
                return "yes"
        return "unknown"

    def ask(self, enc: Encounter, target: str, question: str, lang: Optional[str] = None) -> Optional[Ref]:
        """The doctor's direct question to a department, with only that department's facts."""
        if target not in SPOKEN_ROLES:
            return None
        if lang:
            enc.lang = langmod.norm_lang(lang)
        q = self._redact(enc, _clip(question, 600))
        ctx: dict[str, Any] = {}
        by = lambda action: [dict(enc.results[t]) for r in enc.refs.values() if r.action == action  # noqa: E731
                             for t in r.test_ids if t in enc.results]
        if target == LAB:
            ctx = {**self._people_facts(enc), "results": by("run_test")}
        elif target == RADIOLOGY:
            ctx = {**self._people_facts(enc), "chiefComplaint": self._redact(enc, _clip(enc.patient.get("chiefComplaint"), 300)),
                   "imaging": by("run_imaging")}
        else:
            ctx = {"allergies": self._redact(enc, _clip(enc.patient.get("allergies"), 600)), "current": self.active_drugs(enc),
                   # what an order carries, so a question about another drug can be checked like one
                   "patient": {**self._people_facts(enc), "chiefComplaint": self._redact(enc, _clip(enc.patient.get("chiefComplaint"), 300)),
                               "history": self._history(enc)}}
            rx = self._drug_in_question(enc, question)
            if rx:
                ctx["drug"] = {"medicationId": rx.medication_id, "name": rx.medication, "dose": rx.dose,
                               "status": rx.status, "reason": rx.summary}
        enc.bump("directQuestions")
        self.doctor_acted(enc, f"Asked {ROLES[target].name} a question")
        return self._new_ref(enc, "ask", "ask", target, _clip(q, 80), f"The doctor asks: {q}",
                             {"caseId": enc.case_id, "question": q, "context": ctx, "osce": enc.osce})

    def _drug_in_question(self, enc: Encounter, text: str) -> Optional[Ref]:
        import drugterms

        rx = [r for r in enc.refs.values() if r.action == "verify_rx" and r.status != "cancelled"]
        named = [r for r in rx if drugterms.mentions_drug(text, r.medication_id, r.medication)]
        return (named or rx or [None])[-1]

    def answer(self, enc: Encounter, ref: str, text: str, lang: Optional[str] = None) -> bool:
        """The doctor answers a department's safety question."""
        r = enc.refs.get(ref)
        body = self._redact(enc, _clip(text, 600))
        if r is None or not r.question or not body or not r.target_id:
            return False
        question, r.question = r.question, ""
        r.deadline = _now() + TIMEOUT_S
        if r.status in LATE_OK:
            self._set(enc, r, "working")
        enc.bump("safetyAnswered")
        self.doctor_acted(enc, f"Answered {ROLES[r.target].name}")

        async def go() -> None:
            async with enc.send_lock:
                try:
                    person = enc.people.get(r.target_id) or await self._ensure_participant(enc, r.target, "")
                    await self._post(enc, person, f"The doctor answers: {body}", Handoff(
                        kind="answer", action="safety_question", ref=r.ref, enc=enc.id,
                        lang=langmod.norm_lang(lang or enc.lang), data={"answer": body}))
                except Exception:
                    r.question = question  # the doctor can answer again
                    self._set(enc, r, "waiting", waiting_on=NURSE)
                    raise

        self._ensure_loop(enc)
        self.spawn(go(), "answer")
        return True

    def cancel(self, enc: Encounter, ref: str, why: str = "cancelled by the doctor") -> dict[str, Any]:
        r = enc.refs.get(ref)
        if r is None:
            return {"ok": False, "error": "unknown ref"}
        if r.status == "cancelled":
            return {"ok": True, "already": True}
        if r.status not in (*LATE_OK, "held"):
            return {"ok": False, "error": "already finished"}
        left = [t for t in r.test_ids if t not in r.resulted]
        r.question = ""
        if r.tests and left:
            self.emit(enc, "apply", apply={"ref": r.ref, "cancelTests": left})
        self._set(enc, r, "cancelled", why)
        enc.bump("cancelled")
        self.doctor_acted(enc, f"Cancelled {r.label}")
        self._tell_department(enc, r, f"Please disregard {r.label}: {why}.")
        return {"ok": True, "cancelTests": left}

    def _tell_department(self, enc: Encounter, r: Ref, text: str) -> None:
        """A plain sentence (no hand-off) so the department and the transcript know."""
        person = enc.people.get(r.target_id)
        if person is None:
            return

        async def go() -> None:
            async with enc.send_lock:
                await self._post(enc, person, text)

        self.spawn(go(), "notify")

    def retry(self, enc: Encounter, ref: str) -> dict[str, Any]:
        r = enc.refs.get(ref)
        if r is None:
            return {"ok": False, "error": "unknown ref"}
        if r.status not in ("timeout", "failed", "sent"):
            return {"ok": False, "error": "nothing to retry"}
        r.retries += 1
        r.started = _now()
        r.deadline = r.started + (SCORE_TIMEOUT_S if r.action == "score_teamwork" else TIMEOUT_S)
        r.status = ""  # forces the event
        self._set(enc, r, "sent", "")
        enc.bump("retries")
        self.doctor_acted(enc, f"Retried {r.label}")
        self._ensure_loop(enc)
        self.spawn(self._send(enc, r), "retry")
        return {"ok": True}

    def cancel_test(self, enc: Encounter, test_id: str) -> bool:
        """Take one test out of a pending order (the whole order when it was the only one)."""
        r = next((x for x in reversed(enc.refs.values()) if test_id in x.test_ids and test_id not in x.resulted and x.status in LATE_OK), None)
        if r is None:
            return False
        if len([t for t in r.test_ids if t not in r.resulted]) <= 1:
            return bool(self.cancel(enc, r.ref).get("ok"))
        name = r.name_of(test_id)
        r.tests = [t for t in r.tests if t["testId"] != test_id]
        r.label = ", ".join(t["name"] for t in r.tests)
        self.emit(enc, "apply", apply={"ref": r.ref, "cancelTests": [test_id]})
        self.emit(enc, "delegation", key=f"delegation:{r.ref}", delegation=self._delegation(r))
        enc.bump("cancelled")
        self.doctor_acted(enc, f"Cancelled {name}")
        self._tell_department(enc, r, f"Please cancel {name}; the rest of the order stands.")
        return True

    def stop_medication(self, enc: Encounter, medication_id: str, reason: str = "") -> str:
        """Returns 'cancelled' (was with pharmacy), 'stopped' (was active) or ''."""
        out = ""
        for r in list(enc.refs.values()):
            if r.action != "verify_rx" or r.medication_id != medication_id:
                continue
            if r.status in (*LATE_OK, "held"):
                self.cancel(enc, r.ref, reason or "stopped by the doctor")
                out = out or "cancelled"
            if r.active:
                r.active = False
                self._set(enc, r, "cancelled", reason or "stopped by the doctor")
                self._tell_department(enc, r, f"{r.medication} has been stopped by the doctor.")
                self.doctor_acted(enc, f"Stopped {r.medication}")
                out = "stopped"
        if any(d["medicationId"] == medication_id for d in enc.current):
            enc.current = [d for d in enc.current if d["medicationId"] != medication_id]
            out = "stopped"
        return out

    def doctor_acted(self, enc: Encounter, what: str = "") -> None:
        """Any doctor action after a critical result acknowledges it."""
        now = _now()
        enc.touched = now
        for c in enc.criticals:
            if c["ackAt"] is None and now > c["at"]:
                c["ackAt"] = now
        if what:
            self._log(enc, "doctor", what)

    # ── faculty ──────────────────────────────────────────────────────────────

    def _brief(self, enc: Encounter) -> str:
        p = enc.patient
        age = p.get("age")
        who = f"{int(age)} year old {'woman' if _clip(p.get('gender'), 1).upper() == 'F' else 'man'}" if isinstance(age, (int, float)) and age >= 16 else "A child" if isinstance(age, (int, float)) else "A patient"
        bits = [f"{who}, {self._redact(enc, _clip(p.get('chiefComplaint'), 200)).rstrip('.') or 'no complaint recorded'}."]
        if p.get("allergies"):
            bits.append(f"Allergies: {self._redact(enc, _clip(p.get('allergies'), 200)).rstrip('.')}.")
        done = [f"{x['name']}: {_clip(x['result'], 80)}" for x in enc.results.values()][:5]
        if done:
            bits.append("Results: " + "; ".join(done) + ".")
        drugs = [f"{d['name']} {d['dose']}".strip() for d in self.active_drugs(enc)][:6]
        if drugs:
            bits.append("On the prescription: " + ", ".join(drugs) + ".")
        held = [f"{r.medication} ({r.summary or 'no reason given'})" for r in enc.refs.values() if r.status == "held"]
        if held:
            bits.append("On hold: " + "; ".join(held) + ".")
        return " ".join(bits)

    async def invite_faculty(self, enc: Encounter, reason: str = "") -> dict[str, Any]:
        """Bring the human owner in and brief them. Raises BandError when BAND cannot be reached."""
        async with enc.send_lock:
            await self._ensure_room(enc)
            first = enc.participant(FACULTY) is None
            person = await self._add_faculty(enc)
            why = self._redact(enc, _clip(reason, 300))
            if first or why:
                text = (f"{enc.doctor or 'The doctor'} would like your guidance" + (f": {why.rstrip('.')}. " if why else ". ")
                        + self._brief(enc) + " Reply here and mention Nurse Asha; she speaks for you at the bedside.")
                await self._post(enc, person, text)
        if not enc.faculty_invited or first:
            enc.faculty_invited = True
            enc.bump("facultyInvited")
            self.emit(enc, "faculty", faculty={"action": "invited", "name": person["name"], "text": why})
            self._log(enc, "doctor", f"Invited {person['name']} (faculty)")
        self.doctor_acted(enc)
        self._ensure_loop(enc)
        enc.kick.set()
        return {"url": config.room_url(enc.room_id), "name": person["name"]}

    async def faculty_say(self, enc: Encounter, text: str) -> bool:
        body = self._redact(enc, _clip(text, 800))
        if not body:
            return False
        async with enc.send_lock:
            await self._ensure_room(enc)
            person = enc.participant(FACULTY) or await self._add_faculty(enc)
            await self._post(enc, person, f"The doctor says: {body}")
        enc.awaiting_faculty = False
        enc.bump("doctorToFaculty")
        open_ = [q for q in enc.faculty_asks if q["answeredAt"] is None]
        for q in open_:
            q["answeredAt"] = _now()
        self.doctor_acted(enc, "Wrote to faculty" if not open_ else
                          f"Answered {'the question' if len(open_) == 1 else f'{len(open_)} questions'} from {open_[-1]['by']} "
                          f"after {int(round(_now() - open_[-1]['at']))} seconds")
        self._ensure_loop(enc)
        enc.kick.set()
        return True

    async def request_override(self, enc: Encounter, ref: str, reason: str = "") -> dict[str, Any]:
        r = enc.refs.get(ref)
        if r is None or r.action != "verify_rx" or r.status != "held":
            return {"ok": False, "error": "that drug is not on hold"}
        why = self._redact(enc, _clip(reason, 300))
        async with enc.send_lock:
            await self._ensure_room(enc)
            first = enc.participant(FACULTY) is None
            person = await self._add_faculty(enc)
            text = (f"Pharmacy is holding {r.medication}, {r.dose} for {r.duration}. Reason: {r.summary.rstrip('.') or 'not given'}. "
                    + (f"The doctor asks for an override: {why.rstrip('.')}. " if why else "The doctor asks for an override. ")
                    + (self._brief(enc) + " " if first else "")
                    + "Please reply to Nurse Asha with approve or deny. The drug stays off the prescription until you do.")
            r.override_requested = True  # before posting: the answer can be quick
            try:
                await self._post(enc, person, text)
            except Exception:
                r.override_requested = False
                raise
        if first:
            enc.faculty_invited = True
            enc.bump("facultyInvited")
            self.emit(enc, "faculty", faculty={"action": "invited", "name": person["name"], "text": f"Override for {r.medication}", "ref": r.ref})
        self.emit(enc, "delegation", key=f"delegation:{r.ref}", delegation=self._delegation(r))
        enc.bump("overridesRequested")
        r.override_reasons.append(bool(why))
        self.doctor_acted(enc, f"Asked faculty to override the hold on {r.medication}, " + ("with a reason" if why else "without a reason"))
        self._speak(enc, NURSE, bedside.line("override_asked", enc.lang, name=self._called(person["name"]), item=r.medication), "ack", r.ref)
        self._ensure_loop(enc)
        enc.kick.set()
        return {"ok": True}

    async def _on_faculty(self, enc: Encounter, mid: str, sender_id: str, text: str, to: list[str]) -> None:
        async with enc.faculty_lock:
            person = enc.people.get(sender_id)
            if person is None or not person["human"]:
                await self._refresh_people(enc)
                person = enc.people.get(sender_id)
            if person is None or not person["human"]:
                log.warning("a User who is not in the room was ignored")
                return
            self._faculty_arrived(enc, person)
            enc.faculty_messages += 1
            name, called = person["name"], self._called(person["name"])
            body = bedside.clean_spoken(text, 400)
            if EXAMINER in to:
                enc.faculty_to_examiner = True
            if to and NURSE not in to and PHARMACIST not in to:
                # Between the human and another department (the examiner's sign-off, a word with the lab).
                self.emit(enc, "faculty", faculty={"action": "message", "name": name, "text": body})
                self._log(enc, "faculty", f"Wrote to {', '.join(to)}")
                return
            held = [r for r in enc.refs.values() if r.action == "verify_rx" and r.status == "held"]
            given = [r for r in enc.refs.values() if r.action == "verify_rx" and r.active]
            intent = await facultymod.classify(text, [r.medication for r in (*held, *given)])
            if intent == "approve":
                r = self._override_target(enc, text, held)
                if r is None:
                    intent = "note" if not held else "unclear"
                else:
                    self._approve(enc, r, name, called, body)
                    return
            if intent == "deny":
                r, was_active = self._deny_target(enc, text, held, given)
                if r is None:
                    intent = "unclear" if held or given else "note"
                else:
                    self._deny(enc, r, was_active, name, called, body)
                    return
            if intent == "question":
                enc.awaiting_faculty = True
                enc.bump("facultyQuestions")
                enc.faculty_asks.append({"by": name, "at": _now(), "answeredAt": None})
                del enc.faculty_asks[:-20]
                self.emit(enc, "faculty", faculty={"action": "question", "name": name, "text": body})
                self._log(enc, "faculty", f"{name} asked the doctor: {body}")
                self.spawn(self._speak_free(enc, "fac_question", text, "result", name=called), "speak")
                return
            self.emit(enc, "faculty", faculty={"action": "note", "name": name, "text": body})
            self._log(enc, "faculty", f"Said: {body}")
            waiting = [r for r in held if r.override_requested]
            if intent == "unclear" and waiting:
                self._speak(enc, NURSE, bedside.line("fac_unclear", enc.lang, name=called), "result")
                drugs = ", ".join(r.medication for r in waiting)
                self.spawn(self._tell_human(enc, person,
                           f"I can't take that as a decision, so the hold stays. For {drugs}, please reply approve or deny"
                           + (" and name the drug." if len(waiting) > 1 else ".")), "clarify")
            elif body:
                self.spawn(self._speak_free(enc, "fac_note", text, "result", name=called), "speak")

    async def _tell_human(self, enc: Encounter, person: dict[str, Any], text: str) -> None:
        async with enc.send_lock:
            await self._post(enc, person, text)

    def _mentions(self, text: str, r: Ref) -> bool:
        import drugterms

        return drugterms.mentions_drug(text, r.medication_id, r.medication)

    def _names_another_drug(self, enc: Encounter, text: str, allowed: list[Ref]) -> bool:
        """The human names a drug that is none of these: their words are not about the hold."""
        import drugterms

        ids = {r.medication_id for r in allowed}
        stems = set().union(*[drugterms.stems_of(r.medication_id, r.medication) for r in allowed]) if allowed else set()
        for mid, name in enc.med_names.items():
            if mid not in ids and not (drugterms.stems_of(mid, name) & stems) and drugterms.mentions_drug(text, mid, name):
                return True
        known = {c for r in allowed for c in drugterms.canonical_terms(r.medication)} | stems
        return any(c not in known and not any(c in k or k in c for k in known) for c in drugterms.canonical_terms(text))

    def _override_target(self, enc: Encounter, text: str, held: list[Ref]) -> Optional[Ref]:
        named = [r for r in held if self._mentions(text, r)]
        if len(named) == 1:
            return named[0]
        if named or self._names_another_drug(enc, text, held):
            return None
        waiting = [r for r in held if r.override_requested]
        return waiting[0] if len(waiting) == 1 else None

    def _deny_target(self, enc: Encounter, text: str, held: list[Ref], given: list[Ref]) -> tuple[Optional[Ref], bool]:
        named_given = [r for r in given if self._mentions(text, r)]
        named_held = [r for r in held if self._mentions(text, r)]
        if len(named_given) == 1 and not named_held:
            return named_given[0], True
        if named_held:
            return named_held[0], False
        if self._names_another_drug(enc, text, [*held, *given]):
            return None, False
        waiting = [r for r in held if r.override_requested]
        if len(waiting) == 1:
            return waiting[0], False
        overridden = [r for r in given if r.status == "overridden"]
        if not held and len(overridden) == 1:
            return overridden[0], True  # the human takes back their own approval
        return None, False

    def _approve(self, enc: Encounter, r: Ref, name: str, called: str, body: str) -> None:
        r.override_requested, r.verdict_done, r.active = False, True, True
        self.emit(enc, "faculty", faculty={"action": "approve", "name": name, "text": body, "ref": r.ref})
        self.emit(enc, "apply", apply={"ref": r.ref, "addPrescription": {
            "medicationId": r.medication_id, "dose": r.dose, "duration": r.duration}})
        self._set(enc, r, "overridden", f"Approved by {name}")
        enc.bump("overridesApproved")
        self._log(enc, "faculty", f"{name} approved {r.medication}")
        self._speak(enc, NURSE, bedside.line("fac_approved", enc.lang, name=called, item=r.medication), "urgent", r.ref)
        self._recorded(enc, r)
        self._tell_department(enc, r, f"{name} (faculty) approved {r.medication} despite the hold. It is on the prescription.")

    def _deny(self, enc: Encounter, r: Ref, was_active: bool, name: str, called: str, body: str) -> None:
        self.emit(enc, "faculty", faculty={"action": "deny", "name": name, "text": body, "ref": r.ref})
        r.override_requested = False
        enc.bump("overridesDenied")
        self._log(enc, "faculty", f"{name} said no to {r.medication}")
        if was_active:
            r.active = False
            enc.current = [d for d in enc.current if d["medicationId"] != r.medication_id]
            self.emit(enc, "apply", apply={"ref": r.ref, "removePrescription": {
                "medicationId": r.medication_id, "reason": f"Stopped by {name}"}})
        self._set(enc, r, "held", f"Stopped by {name}" if was_active else f"{name} said no. {r.summary}".strip())
        key = "fac_stopped" if was_active else "fac_denied"
        self._speak(enc, NURSE, bedside.line(key, enc.lang, name=called, item=r.medication), "urgent", r.ref)

    # ── what arrives from the room ───────────────────────────────────────────

    def on_band_message(self, room_id: str, raw: dict[str, Any]) -> bool:
        """A message pushed to Asha by the WebSocket. True when it belongs to an encounter."""
        enc = self.encounters.get(self.rooms.get(room_id, ""))
        if enc is None:
            return False
        self._ingest(enc, raw)
        self._ensure_loop(enc)
        return True

    def _clean_text(self, enc: Encounter, content: str) -> str:
        names = {pid: p["name"] for pid, p in enc.people.items()}
        t = strip_mentions(content, names)
        t = re.sub(r"@[\w.-]+/([\w.-]+)", lambda m: "@" + next(
            (p["name"] for p in enc.people.values() if not p["human"] and ROLES[p["role"]].handle == m.group(1).lower()), m.group(1)), t)
        known = sorted({*names.values(), *(i.name for i in ROLES.values())}, key=len, reverse=True)
        lead = re.compile(r"^\s*@(?:" + "|".join(re.escape(n) for n in known) + r"|\S+)[\s,:;]*") if known else None
        for _ in range(4):
            cut = lead.sub("", t, count=1) if lead else t
            if cut == t:
                break
            t = cut
        return t.strip()

    def _ingest(self, enc: Encounter, raw: dict[str, Any]) -> None:
        """Merge one room message: show it, then act on it once."""
        mid = str(raw.get("id") or "")
        sender_id = str(raw.get("sender_id") or "")
        if not mid or not sender_id:
            return
        is_user = str(raw.get("sender_type") or "").lower() == "user"
        sender = enc.people.get(sender_id)
        if sender is None and not is_user:
            # Another department may have added this one: learn the roster, then look again.
            if mid not in enc.handled:
                self.spawn(self._ingest_later(enc, raw), "roster")
            return
        role = FACULTY if is_user else sender["role"]
        mtype = str(raw.get("message_type") or "text").lower()
        kind = mtype if mtype in ("text", "thought", "tool_call", "tool_result", "error") else "system"
        meta = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
        content = str(raw.get("content") or "")
        text, h = decode(content) if kind == "text" else (content, None)
        if is_user:
            h = None  # people never carry a hand-off; one pasted into their text is just text
        mention_ids = [str(m.get("id")) for m in meta.get("mentions") or [] if isinstance(m, dict) and m.get("id")]
        to = [r for r in dict.fromkeys(FACULTY if enc.people[i]["human"] else enc.people[i]["role"] for i in mention_ids if i in enc.people)]
        statuses = [str((v or {}).get("status") or "sent") for v in (meta.get("delivery_status") or {}).values()] if isinstance(meta.get("delivery_status"), dict) else []
        known = [s for s in statuses if s in DELIVERY_RANK]
        delivery = "failed" if "failed" in known else min(known, key=DELIVERY_RANK.__getitem__) if known else "sent"
        prev = enc.messages.get(mid)
        msg: dict[str, Any] = {
            "id": mid, "from": role, "fromName": _clip((sender or {}).get("name") or raw.get("sender_name") or "Faculty", 80),
            "to": to or (prev or {}).get("to") or [], "text": _clip(self._clean_text(enc, text), 1200), "type": kind,
            "human": is_user, "at": (prev or {}).get("at") or str(raw.get("inserted_at") or _iso()),
        }
        if h:
            msg.update(kind=h.kind, action=h.action, ref=h.ref, payload=h.data)
        elif kind in ("tool_call", "tool_result") and meta:
            fn = meta.get("function") if isinstance(meta.get("function"), dict) else {}
            payload = {"name": fn.get("name"), "arguments": fn.get("arguments")} if fn else {k: meta[k] for k in ("success", "message") if k in meta}
            msg["payload"] = {k: v for k, v in payload.items() if v is not None}
        if kind == "text" and msg["to"]:
            old = str((prev or {}).get("delivery") or "sent")
            # Two participants' contexts can lag each other: ticks never go backwards.
            msg["delivery"] = delivery if DELIVERY_RANK[delivery] >= DELIVERY_RANK.get(old, 0) else old
        if msg != prev:
            enc.messages[mid] = msg
            while len(enc.messages) > MAX_MESSAGES:
                enc.messages.popitem(last=False)
            self.emit(enc, "message", key=f"message:{mid}", message=msg)
        if mid in enc.msg_ref and msg.get("delivery"):
            self._on_delivery(enc, enc.refs.get(enc.msg_ref[mid]), msg["delivery"])
        if kind != "text" or mid in enc.handled:
            return
        enc.handled[mid] = None
        while len(enc.handled) > MAX_MESSAGES * 4:
            enc.handled.popitem(last=False)
        try:
            if enc.side is not None:
                enc.side.on_message(role, sender_id, msg, h)
            elif is_user:
                self.spawn(self._on_faculty(enc, mid, sender_id, self._clean_text(enc, text), msg["to"]), "faculty")
            elif h is not None and role != NURSE:
                self._on_handoff(enc, role, sender_id, msg["to"], h)
        except Exception as e:  # noqa: BLE001 - room content can be anything
            log.warning("room message not handled: %s", type(e).__name__, exc_info=log.isEnabledFor(logging.DEBUG))

    async def _ingest_later(self, enc: Encounter, raw: dict[str, Any]) -> None:
        if _now() - enc.last_people_at > 1.0:
            await self._refresh_people(enc)
        if str(raw.get("sender_id")) in enc.people:
            self._ingest(enc, raw)
        else:
            enc.handled[str(raw.get("id"))] = None  # not one of ours: never look again

    def _on_delivery(self, enc: Encounter, r: Optional[Ref], delivery: str) -> None:
        if r is None:
            return
        if delivery in ("processing", "processed") and r.status == "sent":
            self._set(enc, r, "working")
        elif delivery == "failed" and r.status in ("sent", "working") and not r.question:
            self._set(enc, r, "failed", f"{ROLES[r.target].title} could not process the request")
            self._speak(enc, NURSE, bedside.line("unreachable", enc.lang, item=r.label, dept=bedside.department(r.target, enc.lang)), "result", r.ref)

    def _on_handoff(self, enc: Encounter, role: str, sender_id: str, to: list[str], h: Handoff) -> None:
        if h.enc and h.enc != enc.id:
            return
        if h.kind == "recall" and h.action == "verify_rx":
            if role == PHARMACIST and NURSE in to:
                self._on_recall(enc, sender_id, h)
            return
        r = enc.refs.get(h.ref)
        if r is None:
            return
        if NURSE not in to:
            self._on_side_channel(enc, r, role, sender_id, to, h)
            return
        if role != r.target or not r.target_id or sender_id != r.target_id:
            log.warning("%s tried to answer a ref delegated to %s; ignored", role, r.target)
            return
        key = (h.kind, h.action)
        if key == ("ack", r.action):
            if str(h.data.get("status") or "") in ("failed", "rejected") and r.status in OPEN:
                self._set(enc, r, "failed", "The department could not complete this")
                self._speak(enc, NURSE, bedside.line("unreachable", enc.lang, item=r.label, dept=bedside.department(r.target, enc.lang)), "result", r.ref)
        elif key == ("query", "safety_question"):
            self._on_question(enc, r, h)
        elif key == ("verdict", "verify_rx") and r.action == "verify_rx":
            self._on_verdict(enc, r, h)
        elif key in (("result", "run_test"), ("result", "run_imaging")) and h.action == r.action:
            self._on_result(enc, r, h)
        elif key == ("answer", "ask") and r.action == "ask":
            self._on_answer(enc, r, h)
        elif key == ("score", "score_teamwork") and r.action == "score_teamwork":
            self.spawn(self._on_score(enc, r, h), "score")

    def _on_side_channel(self, enc: Encounter, r: Ref, role: str, sender_id: str, to: list[str], h: Handoff) -> None:
        """Department to department: only moves the 'waiting on' display, never the chart."""
        if r.status not in LATE_OK:
            return
        if h.kind == "query" and sender_id == r.target_id and to:
            self._set(enc, r, "waiting", waiting_on=to[0])
        elif h.kind == "answer" and r.status == "waiting" and r.waiting_on == role and not r.question:
            self._set(enc, r, "working")

    # ── verdicts, results, answers ───────────────────────────────────────────

    def _own_words(self, enc: Encounter, h: Handoff) -> str:
        """The department's `spoken`, when it really is in the session language."""
        text = bedside.clean_spoken(h.spoken)
        return text if langmod.norm_lang(h.lang) == enc.lang and bedside.in_language(text, enc.lang) else ""

    def _on_verdict(self, enc: Encounter, r: Ref, h: Handoff) -> None:
        d = h.data
        verdict = str(d.get("verdict") or "")
        if str(d.get("medicationId") or "") != r.medication_id:
            log.warning("verdict for another drug ignored")
            return
        reason = _clip(bedside.clean_spoken(d.get("reason"), 400), 240)
        if verdict == "hold" and r.active and r.status in ("done", "overridden"):
            self._withdraw(enc, r, h, reason)
            return
        if r.verdict_done or r.status not in LATE_OK:
            return
        if verdict == "clarify":
            self._on_question(enc, r, h, _clip(d.get("question"), 240) or reason)
            return
        if verdict not in ("release", "hold"):
            return
        r.verdict_done, r.question = True, ""
        spoken = self._own_words(enc, h)
        if verdict == "release" and r.local_hard:
            # The server's own hard-conflict check is the authority.
            reason = "; ".join(r.local_hard)
            r.severity = "hard"
            self._hold(enc, r, f"Pharmacy released it, but the clinic's check found: {reason}")
            self._speak(enc, NURSE, bedside.line("local_hold", enc.lang, item=r.medication), "urgent", r.ref)
            return
        if verdict == "release":
            r.active = True
            self.emit(enc, "apply", apply={"ref": r.ref, "addPrescription": {
                "medicationId": r.medication_id, "dose": r.dose, "duration": r.duration}})
            self._set(enc, r, "done", reason or "Released")
            enc.bump("released")
            self._log(enc, "pharmacist", f"Released {r.medication}")
            self._speak(enc, PHARMACIST if spoken else NURSE, spoken or bedside.line("released", enc.lang, item=r.medication), "result", r.ref)
            self._recorded(enc, r)
            return
        if enc.osce:
            spoken = ""  # in an exam nothing that could hint at an alternative is read out
        else:
            s = d.get("suggestion")
            if isinstance(s, dict) and s.get("medicationId"):
                enc.held_suggestions.add(str(s["medicationId"])[:80])
                enc.bump("suggestionsOffered")
        r.severity = "hard" if r.local_hard or d.get("severity") == "hard" else _clip(d.get("severity"), 8)
        self._hold(enc, r, reason or "Held by pharmacy")
        if spoken:
            self._speak(enc, PHARMACIST, spoken, "urgent", r.ref)
        else:
            self.spawn(self._speak_free(enc, "held", "" if enc.osce else reason, "urgent", ref=r.ref, item=r.medication), "speak")

    def _hold(self, enc: Encounter, r: Ref, reason: str) -> None:
        r.held_at = _now()
        self._set(enc, r, "held", reason)
        enc.bump("holds")
        self._log(enc, "pharmacist", f"Held {r.medication}: {reason}")

    def _on_recall(self, enc: Encounter, sender_id: str, h: Handoff) -> None:
        r = enc.refs.get(str(h.data.get("originalRef") or ""))
        if r is None or r.action != "verify_rx" or sender_id != r.target_id or not r.active:
            return
        if str(h.data.get("medicationId") or r.medication_id) != r.medication_id:
            return
        self._withdraw(enc, r, h, _clip(bedside.clean_spoken(h.data.get("reason"), 400), 240))

    def _withdraw(self, enc: Encounter, r: Ref, h: Handoff, reason: str) -> None:
        r.active, r.held_at = False, _now()
        enc.current = [d for d in enc.current if d["medicationId"] != r.medication_id]
        self.emit(enc, "apply", apply={"ref": r.ref, "removePrescription": {
            "medicationId": r.medication_id, "reason": reason or "Recalled by pharmacy"}})
        self._set(enc, r, "held", reason or "Recalled by pharmacy")
        enc.bump("recalls")
        self._log(enc, "pharmacist", f"Recalled {r.medication}: {reason}")
        spoken = "" if enc.osce else self._own_words(enc, h)
        if spoken:
            self._speak(enc, PHARMACIST, spoken, "urgent", r.ref)
        else:
            self.spawn(self._speak_free(enc, "recalled", "" if enc.osce else reason, "urgent", ref=r.ref, item=r.medication), "speak")

    def _on_question(self, enc: Encounter, r: Ref, h: Handoff, text: str = "") -> None:
        if r.status not in LATE_OK or r.verdict_done:
            return
        q = _clip(bedside.clean_spoken(text or h.data.get("question"), 400), 300)
        if not q:
            return
        r.question = q
        self._set(enc, r, "waiting", waiting_on=NURSE)
        enc.bump("safetyQuestions")
        self.emit(enc, "question", ref=r.ref, **{"from": r.target}, text=q)
        self._log(enc, r.target, f"Asked: {q}")
        own = self._own_words(enc, h)
        if own:
            self._speak(enc, NURSE, bedside.line("question", enc.lang, dept=bedside.department(r.target, enc.lang), text=own), "urgent", r.ref)
        else:
            self.spawn(self._speak_free(enc, "question", q, "urgent", ref=r.ref, dept=bedside.department(r.target, enc.lang)), "speak")

    def _on_result(self, enc: Encounter, r: Ref, h: Handoff) -> None:
        if r.status not in LATE_OK:
            return
        asked = set(r.test_ids)
        fresh: list[dict[str, Any]] = []
        raw = h.data.get("results")
        for x in raw[:40] if isinstance(raw, list) else []:
            tid = str(x.get("testId") or "") if isinstance(x, dict) else ""
            if tid not in asked or tid in r.resulted or any(f["testId"] == tid for f in fresh):
                continue  # never asked for, or already on the chart
            fresh.append({"testId": tid, "name": r.name_of(tid), "result": _clip(x.get("result"), 1200),
                          "abnormal": bool(x.get("abnormal")), "critical": bool(x.get("critical"))})
        fresh = [f for f in fresh if f["result"]]
        unknown = [t for t in (h.data.get("unknown") if isinstance(h.data.get("unknown"), list) else [])
                   if isinstance(t, str) and t in asked and t not in r.resulted and all(f["testId"] != t for f in fresh)]
        if not fresh and not unknown:
            return
        r.resulted.update(f["testId"] for f in fresh)
        r.resulted.update(unknown)
        r.question = ""
        for f in fresh:
            enc.results[f["testId"]] = f
        if fresh:
            self.emit(enc, "apply", apply={"ref": r.ref, "results": fresh})
            enc.bump("resultsBack", len(fresh))
        if unknown:
            self.emit(enc, "apply", apply={"ref": r.ref, "cancelTests": unknown})
        critical = [f for f in fresh if f["critical"]]
        abnormal = [f["name"] for f in fresh if f["abnormal"]]
        summary = _clip(h.data.get("impression"), 200) or ("Critical: " + ", ".join(f["name"] for f in critical) if critical
                  else "Abnormal: " + ", ".join(abnormal) if abnormal else "Result on the chart" if fresh else "Not available")
        self._set(enc, r, "done" if asked <= r.resulted else "working", summary)
        self._log(enc, r.target, "Reported " + ", ".join(f["name"] for f in fresh) if fresh else "No result available")
        if critical:
            enc.bump("criticalResults", len(critical))
            enc.criticals.append({"ref": r.ref, "at": _now(), "ackAt": None, "names": [f["name"] for f in critical]})
        spoken = self._own_words(enc, h)
        dept = bedside.department(r.target, enc.lang)
        if critical:
            self._speak(enc, r.target if spoken else NURSE,
                        spoken or bedside.line("critical", enc.lang, items=", ".join(f["name"] for f in critical)), "urgent", r.ref)
        elif fresh:
            self._speak(enc, r.target if spoken else NURSE,
                        spoken or bedside.line("results", enc.lang, items=", ".join(f["name"] for f in fresh)), "result", r.ref)
        if unknown and not (spoken and fresh):
            names = ", ".join(r.name_of(t) for t in unknown)
            self._speak(enc, r.target if spoken else NURSE, spoken or bedside.line("unavailable", enc.lang, dept=dept, items=names), "result", r.ref)

    def _on_answer(self, enc: Encounter, r: Ref, h: Handoff) -> None:
        if r.status not in LATE_OK:
            return
        text = bedside.clean_spoken(h.data.get("text"), 600)
        self._set(enc, r, "done", text or "Answered")
        self._log(enc, r.target, "Answered the doctor")
        own = self._own_words(enc, h)
        if own:
            self._speak(enc, r.target, own, "result", r.ref, direct=True)
        else:
            self.spawn(self._speak_free(enc, "answer", text, "result", ref=r.ref, speaker=r.target,
                                        fallback="answer_fallback", dept=bedside.department(r.target, enc.lang)), "speak")

    async def _on_score(self, enc: Encounter, r: Ref, h: Handoff) -> None:
        if r.status == "cancelled" or enc.score_final:
            return
        score = self._score_shape(h.data)
        if score is None:
            return
        if score["status"] in ("signed_off", "revised"):
            # The examiner cannot sign for the human: we must have seen them write.
            if not enc.faculty_to_examiner:
                try:
                    await self._poll_once(enc)
                except Exception as e:  # noqa: BLE001
                    log.info("poll before sign-off failed: %s", type(e).__name__)
            if not enc.faculty_to_examiner:
                score["status"] = "awaiting_signoff"
                score.pop("signedBy", None)
                score.pop("facultyComment", None)
        final = score["status"] in ("signed_off", "revised")
        enc.score_final = enc.score_final or final
        self.emit(enc, "score", score=score)
        self._set(enc, r, "done" if final else "waiting", f"{score['total']} out of 100", waiting_on=None if final else FACULTY)
        r.deadline = float("inf")
        self._log(enc, "examiner", f"Score {score['status'].replace('_', ' ')}: {score['total']}")

    @staticmethod
    def _score_shape(d: dict[str, Any]) -> Optional[dict[str, Any]]:
        def num(v: Any, lo: float, hi: float) -> int:
            try:
                return int(max(lo, min(hi, round(float(v)))))
            except (TypeError, ValueError):
                return int(lo)

        status = str(d.get("status") or "draft")
        if status not in ("draft", "awaiting_signoff", "signed_off", "revised") or "total" not in d:
            return None
        texts = lambda v: [_clip(x, 240) for x in v[:8] if isinstance(x, str) and x.strip()] if isinstance(v, list) else []  # noqa: E731
        domains = []
        for x in d.get("domains") or []:
            if isinstance(x, dict) and x.get("name"):
                mx = num(x.get("max"), 1, 100)
                domains.append({"name": _clip(x["name"], 80), "score": num(x.get("score"), 0, mx), "max": mx, "note": _clip(x.get("note"), 300)})
        out: dict[str, Any] = {"status": status, "total": num(d.get("total"), 0, 100), "domains": domains[:8],
                               "strengths": texts(d.get("strengths")), "improvements": texts(d.get("improvements"))}
        for k in ("signedBy", "facultyComment"):
            if isinstance(d.get(k), str) and d[k].strip():
                out[k] = _clip(d[k], 300)
        return out

    def _recorded(self, enc: Encounter, r: Ref) -> None:
        """Real-world side effects of a released drug: once per ref."""
        if r.recorded or self.record_release is None:
            return
        r.recorded = True
        try:
            res = self.record_release(enc, r)
            if asyncio.iscoroutine(res):
                self.spawn(res, "record")
        except Exception as e:  # noqa: BLE001
            log.warning("release not recorded: %s", type(e).__name__)

    # ── speech ───────────────────────────────────────────────────────────────

    def _speak(self, enc: Encounter, speaker: str, text: str, priority: str = "result", ref: str = "", *,
               direct: bool = False) -> None:
        """Asha relays what a department sent her. A department uses its own voice only
        when the doctor asked it directly (`direct`)."""
        text = bedside.clean_spoken(text)
        if not direct:
            speaker = NURSE
        if not text or enc.closed or enc.side is not None:  # a side room decides for itself what is said
            return
        item = {"speaker": speaker, "text": text, "priority": priority, "ref": ref}
        if priority != "result":
            self._emit_speak(enc, [item])
            return
        enc.speak_queue.append(item)  # several results landing together become one line
        if enc.flush_task is None or enc.flush_task.done():
            enc.flush_task = self.spawn(self._flush_later(enc), "speech")

    async def _flush_later(self, enc: Encounter) -> None:
        await asyncio.sleep(COALESCE_S)
        items, enc.speak_queue = enc.speak_queue, []
        if items and not enc.closed:
            self._emit_speak(enc, items)

    def _emit_speak(self, enc: Encounter, items: list[dict[str, Any]]) -> None:
        if len({i["speaker"] for i in items}) == 1:
            speaker, text = items[0]["speaker"], " ".join(dict.fromkeys(i["text"] for i in items))
        else:
            speaker = NURSE
            text = " ".join(dict.fromkeys(
                i["text"] if i["speaker"] == NURSE else f"{bedside.department(i['speaker'], enc.lang)}: {i['text']}" for i in items))
            text = text[:1].upper() + text[1:]
        speak: dict[str, Any] = {"id": new_ref("spk"), "speaker": speaker, "text": bedside.clean_spoken(text, 600),
                                 "lang": enc.lang, "priority": items[0]["priority"]}
        if len(items) == 1 and items[0]["ref"]:
            speak["ref"] = items[0]["ref"]
        self.emit(enc, "speak", speak=speak)

    async def _speak_free(self, enc: Encounter, key: str, text: str, priority: str, *, ref: str = "", speaker: str = NURSE,
                          fallback: str = "", **kw: Any) -> None:
        """A template carrying someone's free text, translated when needed, else without it."""
        free = bedside.clean_spoken(text, 260)
        said = await bedside.translate(free, enc.lang) if free else ""
        if free and said is None and key in ("fac_question", "fac_note", "question"):
            said = free  # the words matter more than the language
        if not said and fallback:
            self._speak(enc, NURSE, bedside.line(fallback, enc.lang, **kw), priority, ref)
            return
        self._speak(enc, speaker, bedside.line(key, enc.lang, text=said or "", **kw), priority, ref, direct=speaker != NURSE)

    # ── polling loop ─────────────────────────────────────────────────────────

    def _ensure_loop(self, enc: Encounter) -> None:
        if enc.loop_task is None or enc.loop_task.done():
            enc.loop_task = self.spawn(self._loop(enc), "poll")
        enc.kick.set()

    def _busy(self, enc: Encounter) -> bool:
        if enc.side is not None:
            return bool(enc.side.busy())
        return (any(r.status in OPEN or r.override_requested for r in enc.refs.values())
                or enc.awaiting_faculty or (bool(enc.humans()) and enc.closed is None))

    def _finished(self, enc: Encounter) -> bool:
        if enc.side is not None:
            return bool(enc.side.finished())
        if enc.closed is None:
            return _now() - enc.touched > LOOP_IDLE_STOP_S
        return enc.score_final or not enc.score_ref or _now() - enc.closed > CLOSE_KEEP_S

    async def _loop(self, enc: Encounter) -> None:
        last = 0.0
        last_departments: dict[str, bool] = {}
        while not self.stopping and self.encounters.get(enc.id) is enc and not self._finished(enc):
            enc.kick.clear()
            self._tick(enc)
            busy = self._busy(enc)
            if enc.room_id and time.monotonic() - last >= (POLL_BUSY_S if busy else POLL_IDLE_S) * 0.95:
                try:
                    await self._poll_once(enc)
                except band_client.BandError as e:
                    log.info("room poll failed: %s", e)
                except Exception as e:  # noqa: BLE001
                    log.warning("room poll failed: %s", type(e).__name__, exc_info=log.isEnabledFor(logging.DEBUG))
                last = time.monotonic()
                deps = await self.departments()
                if last_departments and deps != last_departments:
                    self.emit(enc, "status", key="status", enabled=True, departments=deps)
                last_departments = deps
            wait = POLL_BUSY_S if busy else POLL_IDLE_S
            # A kick (new order, pushed message) wakes the loop, but never hammers the API.
            try:
                await asyncio.wait_for(enc.kick.wait(), timeout=wait)
                await asyncio.sleep(max(0.0, min(0.5, POLL_BUSY_S - (time.monotonic() - last))))
            except asyncio.TimeoutError:
                pass

    def _tick(self, enc: Encounter) -> None:
        now = _now()
        for r in list(enc.refs.values()):
            if r.status in OPEN and not r.question and now > r.deadline:
                self._set(enc, r, "timeout", f"No reply from {ROLES[r.target].name} yet")
                enc.bump("timeouts")
                self._log(enc, "nurse", f"No reply about {r.label}")
                if r.action != "score_teamwork":
                    self._speak(enc, NURSE, bedside.line("timeout", enc.lang, item=r.label, dept=bedside.department(r.target, enc.lang)), "result", r.ref)

    async def _poll_once(self, enc: Encounter) -> None:
        """Union of every in-room agent's own view: that is the complete transcript."""
        async with enc.poll_lock:
            if not enc.room_id:
                return
            if enc.humans() or enc.faculty_invited or _now() - enc.last_people_at > 15.0:
                try:
                    await self._refresh_people(enc)
                except band_client.BandError as e:
                    log.info("participants unavailable: %s", e)
            roles = [p["role"] for p in enc.people.values() if not p["human"]]
            pages = await asyncio.gather(*[self._context(enc, r) for r in roles], return_exceptions=True)
            items: dict[str, dict[str, Any]] = {}
            for page in pages:
                if isinstance(page, BaseException):
                    if isinstance(page, asyncio.CancelledError):
                        raise page
                    continue
                for m in page:
                    if isinstance(m, dict) and m.get("id"):
                        items.setdefault(str(m["id"]), m)
            for m in sorted(items.values(), key=lambda x: str(x.get("inserted_at") or "")):
                self._ingest(enc, m)

    async def _context(self, enc: Encounter, role: str) -> list[dict[str, Any]]:
        c = self._client_for(role)
        if c is None:
            return []  # that department's key is not in this process
        out: list[dict[str, Any]] = []
        cursor = enc.cursors.get(role)
        for _ in range(5):
            page, nxt = await c.context(enc.room_id, cursor=cursor)
            out.extend(page)
            if not nxt:
                break
            cursor = enc.cursors[role] = nxt
        return out

    # ── close and scoring ────────────────────────────────────────────────────

    def counts(self, enc: Encounter) -> dict[str, Any]:
        t = enc.tally
        refs = [r for r in enc.refs.values() if r.action != "score_teamwork"]
        acks = [round(c["ackAt"] - c["at"], 1) for c in enc.criticals if c["ackAt"]]
        by: dict[str, int] = {}
        for r in refs:
            by[r.target] = by.get(r.target, 0) + 1
        return {
            "delegations": len(refs), "byDepartment": by,
            "prescriptionsSent": t.get("prescriptionsSent", 0), "released": t.get("released", 0),
            "holds": t.get("holds", 0), "recalls": t.get("recalls", 0), "heldAtClose": sum(r.status == "held" for r in refs),
            "heldDrugReordered": t.get("heldDrugReordered", 0),
            "suggestionsOffered": t.get("suggestionsOffered", 0), "suggestionsTaken": t.get("suggestionsTaken", 0),
            "overridesRequested": t.get("overridesRequested", 0), "overridesApproved": t.get("overridesApproved", 0),
            "overridesDenied": t.get("overridesDenied", 0),
            "testsOrdered": t.get("testsOrdered", 0), "resultsBack": t.get("resultsBack", 0),
            "criticalResults": t.get("criticalResults", 0), "criticalAcknowledged": len(acks), "criticalAckSeconds": acks,
            "safetyQuestions": t.get("safetyQuestions", 0), "safetyAnswered": t.get("safetyAnswered", 0),
            "directQuestions": t.get("directQuestions", 0), "timeouts": t.get("timeouts", 0), "failed": t.get("failed", 0),
            "cancelled": t.get("cancelled", 0), "retries": t.get("retries", 0),
            "openAtClose": sum(r.status in OPEN for r in refs),
            "facultyInvited": t.get("facultyInvited", 0) > 0, "facultyMessages": enc.faculty_messages,
            "facultyQuestions": t.get("facultyQuestions", 0), "doctorToFaculty": t.get("doctorToFaculty", 0),
            "facultyAnswered": sum(q["answeredAt"] is not None for q in enc.faculty_asks),
            "facultyAnswerSeconds": [round(q["answeredAt"] - q["at"], 1) for q in enc.faculty_asks if q["answeredAt"] is not None],
            "overridesWithReason": sum(any(r.override_reasons) for r in refs),
            "overridesWithoutReason": sum(bool(r.override_reasons) and not any(r.override_reasons) for r in refs),
            "hardOverridesWithReason": sum(r.severity == "hard" and any(r.override_reasons) for r in refs),
        }

    @staticmethod
    def _clean_summary(raw: Any) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, v in list(raw.items())[:30] if isinstance(raw, dict) else []:
            if not isinstance(k, str) or re.search(r"name|patient|phone|contact|email", k, re.IGNORECASE):
                continue
            if isinstance(v, bool) or isinstance(v, (int, float)):
                out[k[:40]] = v
            elif isinstance(v, str):
                out[k[:40]] = _clip(v, 120)
        return out

    def close(self, enc: Encounter, summary: Any = None) -> Optional[str]:
        """End the encounter; the examiner starts marking when there was a room to mark."""
        if enc.closed is not None:
            return enc.score_ref or None
        counts = self.counts(enc)
        enc.speak_queue.clear()
        self._log(enc, "doctor", "Ended the encounter")
        for r in enc.refs.values():
            r.question = ""
        if not enc.room_id:
            enc.closed = _now()
            return None
        fac = enc.participant(FACULTY)
        client = {k: self._redact(enc, v) if isinstance(v, str) else v for k, v in self._clean_summary(summary).items()}
        data: dict[str, Any] = {"timeline": [{**e, "what": self._redact(enc, e["what"])} for e in enc.timeline[-60:]],
                                "counts": counts, "clientSummary": client,
                                "facultyInRoom": fac is not None, "osce": enc.osce}
        if fac:
            data["facultyId"] = fac["id"]
        r = self._new_ref(enc, "score", "score_teamwork", EXAMINER, "Teamwork score",
                          "The encounter is over. Please mark how the doctor worked with the team.", data)
        enc.score_ref = r.ref
        enc.closed = _now()
        enc.kick.set()
        return r.ref

    # ── red flag from a follow-up call ───────────────────────────────────────

    def red_flag(self, symptom: str, severity: str, snap: dict[str, Any]) -> None:
        """Fire and forget: a new room with the human in it. Never delays the call."""
        if not self.enabled or not self.started or self.stopping:
            return
        try:
            self.spawn(self._red_flag(_clip(symptom, 200), _clip(severity, 20), dict(snap or {})), "red flag")
        except RuntimeError:  # no running loop
            return

    async def _red_flag(self, symptom: str, severity: str, snap: dict[str, Any]) -> None:
        me = await self.me()
        owner = str(me.get("owner_uuid") or "")
        peers = await self._peers()
        chat = await self.asha.create_chat(f"Follow-up red flag: {symptom}"[:80])
        room_id = str(chat.get("id") or "")
        if not room_id:
            return
        fake = Encounter(id="", case_id="", lang="en", osce=False, patient={"name": snap.get("patientName") or ""}, doctor="",
                         created=_now(), touched=_now())
        said = self._redact(fake, symptom)
        meds = [m for m in snap.get("prescriptions") or [] if isinstance(m, dict) and m.get("name")][:8]
        age, g = snap.get("age"), _clip(snap.get("gender"), 1).upper()
        who = f"{int(age)}{g}" if isinstance(age, (int, float)) else "a patient"
        drugs = ", ".join(f"{_clip(m['name'], 60)} {_clip(m.get('dose'), 40)}".strip() for m in meds)
        if owner:
            person = next((p for p in peers if str(p.get("id")) == owner), {"id": owner, "name": "Faculty"})
            await self.asha.add_participant(room_id, owner)
            await self.asha.send_message(
                room_id, f"@{person.get('name')} Red flag ({severity or 'urgent'}) on a follow-up call, {who}: {said}. "
                + (f"Current medicines: {drugs}. " if drugs else "") + "I have advised emergency care (108). Please review.",
                [{"id": owner, "name": str(person.get("name") or "Faculty")}])
        if meds and self._drug_implicated(symptom, meds):
            peer = next((p for p in peers if self._role_of_peer(p) == PHARMACIST), None)
            if peer:
                await self.asha.send_event(room_id, "Adding pharmacy: one of the patient's medicines may be the cause")
                await self.asha.add_participant(room_id, str(peer["id"]))
                q = f"The patient reports {said}. Could one of the current medicines be the cause, and what should be stopped?"
                await self.asha.send_message(
                    room_id, encode(f"@{ROLES[PHARMACIST].name} {q}", Handoff(
                        kind="request", action="ask", ref=new_ref("flag"), lang="en",
                        data={"question": q, "context": {"current": [{"name": _clip(m["name"], 60), "dose": _clip(m.get("dose"), 60)} for m in meds]}})),
                    [{"id": str(peer["id"]), "name": ROLES[PHARMACIST].name}])

    @staticmethod
    def _drug_implicated(symptom: str, meds: list[dict[str, Any]]) -> bool:
        import drugterms

        if any(drugterms.mentions_drug(symptom, "", str(m.get("name") or "")) for m in meds):
            return True
        return bool(re.search(r"allerg|rash|hives|swell|itch|anaphyl|side effect|after (?:the )?(?:tablet|medicine|injection|dose|drug)"
                              r"|bleed|black stool|vomit|diarrh|dizz|faint|jaundice|yellow|low sugar|hypogly|overdose", symptom, re.IGNORECASE))


hub = Hub()


async def _record_release(enc: Encounter, r: Ref) -> None:
    """A released drug goes to the FHIR record, once."""
    from integrations import fhir

    p = enc.patient
    await fhir.record_batch({"id": enc.case_id, "name": p.get("name") or "Synthetic Patient", "age": p.get("age"),
                             "gender": p.get("gender") or ""}, [],
                            [{"name": r.medication, "dose": r.dose, "duration": r.duration}])


# ── lifespan ───────────────────────────────────────────────────────────────

_supervisor_started = False


async def start() -> None:
    """Called from the server lifespan. Returns at once; never raises."""
    global _supervisor_started
    hub.stopping = False
    if not hub.enabled:
        return
    hub.record_release = _record_release
    hub.started = True
    try:
        from . import asha

        asha.start(hub)
    except Exception as e:  # noqa: BLE001
        log.warning("Asha's room connection did not start: %s", type(e).__name__)
    if config.workers_mode() in ("spawn", "compact"):
        try:
            from . import supervisor

            await supervisor.start()
            _supervisor_started = True
            hub.supervisor_status = supervisor.status
        except Exception as e:  # noqa: BLE001 - the room works with external workers too
            log.warning("department workers did not start: %s", type(e).__name__)


async def stop() -> None:
    global _supervisor_started
    hub.started = False
    try:
        await hub.stop()
    except Exception as e:  # noqa: BLE001
        log.warning("hub stop: %s", type(e).__name__)
    try:
        from . import asha

        await asha.stop()
    except Exception as e:  # noqa: BLE001
        log.warning("Asha's room connection did not stop: %s", type(e).__name__)
    if _supervisor_started:
        _supervisor_started = False
        try:
            from . import supervisor

            await supervisor.stop()
        except Exception as e:  # noqa: BLE001
            log.warning("department workers did not stop: %s", type(e).__name__)
    hub.supervisor_status = None
    hub.record_release = None
    await band_client.aclose_all()
