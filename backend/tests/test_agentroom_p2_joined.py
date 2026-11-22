"""Both halves together: the API side rooms talking to the real department agents over the
in-memory BAND (no network, no model)."""
from __future__ import annotations

import asyncio
import copy
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
for _p in (str(_B), str(_B / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import test_agentroom_p2_flows as flows  # noqa: E402
import case_author  # noqa: E402
import custom_cases  # noqa: E402
from agentroom import base, casereview, lab, pharmacist, radiology, reads, secondread, siderooms, theatre  # noqa: E402
from agentroom.protocol import ROLES  # noqa: E402
from fake_band import OWNER  # noqa: E402
from test_case_author import ANSWERS, GOOD  # noqa: E402


class Tools:
    """AgentTools of one department on the fake BAND."""

    def __init__(self, case, role, room):
        self.case, self.role, self.room = case, role, room

    @property
    def participants(self):
        return list(self.case.band.rooms[self.room]["people"])

    async def get_participants(self):
        return self.participants

    async def lookup_peers(self, page=1, page_size=50):
        return {"data": []}

    async def send_message(self, content, mentions=None):
        self.case.band.post(self.case.band.agent(self.role), list(mentions or []), content, self.room)

    async def send_event(self, content, message_type, metadata=None):
        self.case.band.post(self.case.band.agent(self.role), [], content, self.room, message_type)

    async def no_reply(self, reason=None):
        pass


class Msg:
    def __init__(self, m):
        self.id, self.sender_id, self.sender_type, self.sender_name, self.content = m["id"], m["sender_id"], m["sender_type"], m["sender_name"], m["content"]


class Joined(flows.FlowCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()

        async def no_model(*a, **k):
            return None

        for p in (mock.patch.dict(os.environ, {"LAB_TURNAROUND_S": "0"}), mock.patch.object(secondread, "llm_text", no_model),
                  mock.patch.object(base, "log_event", lambda *a, **k: None)):
            p.start()
            self.addCleanup(p.stop)
        self.agents = {"lab": lab.LabAdapter("acct"), "pharmacist": pharmacist.PharmacistAdapter("acct"), "radiology": radiology.RadiologyAdapter("acct")}
        self.delivered: set[tuple[str, str]] = set()
        self.pump_task = asyncio.ensure_future(self.pump())

    async def asyncTearDown(self):
        self.pump_task.cancel()
        await super().asyncTearDown()

    async def pump(self):
        """BAND's delivery: each text message to the departments it mentions, once."""
        while True:
            for rid, room in list(self.band.rooms.items()):
                for m in list(room["messages"]):
                    if m["message_type"] != "text":
                        continue
                    for x in m["metadata"].get("mentions", []):
                        role = self.band.roles.get(x["id"])
                        key = (m["id"], role or "")
                        if role in self.agents and key not in self.delivered and m["sender_id"] != x["id"]:
                            self.delivered.add(key)
                            await self.agents[role].on_message(Msg(m), Tools(self, role, rid), None, None, None, is_session_bootstrap=False, room_id=rid)
            await asyncio.sleep(0.01)


class TheatreJoined(Joined):
    def open(self, scenario, lang="en"):
        return siderooms.open_room(theatre.KIND, "drill", lang=lang, context={"scenarioId": scenario}, hub=self.hub)

    async def test_blood_with_a_valid_sample(self):
        side = self.open("ot-lscs")
        await theatre.blood(side, {"n": 1, "units": 2})
        await self.until(lambda: side.state["blood"]["status"] == "released")
        self.assertEqual((side.state["blood"]["group"], len(side.state["blood"]["units"])), ("O negative", 2))

    async def test_blood_that_needs_a_sample_first(self):
        side = self.open("ot-appendix", "hi")
        await theatre.blood(side, {"n": 1})
        await self.until(lambda: side.state["blood"]["status"] == "sample")
        await theatre.sample(side, {})
        await self.until(lambda: side.state["blood"]["status"] == "released")
        self.assertEqual(side.state["blood"]["group"], "B positive")
        self.assertTrue(all(any(ord(c) > 0x900 for c in s["text"]) for s in self.spoken(side)))

    async def test_emergency_and_allergy(self):
        side = self.open("ot-lscs")
        await theatre.blood(side, {"n": 1, "emergency": True})
        await theatre.allergy(side, {"allergies": "Metoclopramide (dystonia)", "drug": "Cefazolin", "dose": "2 g", "age": 28, "gender": "F",
                                     "drugs": [{"id": "cefazolin", "name": "Cefazolin"}]})
        await self.until(lambda: side.state["blood"]["status"] == "emergency" and side.state["rx"]["status"] == "release")
        self.assertEqual(side.state["rx"]["avoid"], ["metoclopramide"])


class ReadJoined(Joined):
    async def read(self, report, diagnosis):
        ctx = reads.check("r", {"filmId": "rad-cxr-pneumoperitoneum", "report": report, "diagnosis": diagnosis})
        side = siderooms.open_room(reads.KIND, "r", context=ctx, hub=self.hub)
        side.start(reads.flow(side, ctx))
        await self.until(lambda: side.state["final"], timeout=8)
        return side

    async def test_the_whole_critical_loop(self):
        side = await self.read("Lungs clear.", "Normal chest radiograph")
        self.assertEqual(side.state["status"], "closed")
        self.assertEqual([c["who"] for c in side.state["chain"]], ["nurse", "radiology", "radiology", "nurse", "radiology"])
        self.assertIn("Free gas", side.state["chain"][3]["what"])

    async def test_agreement(self):
        side = await self.read("Free gas under the left hemidiaphragm. Free air under the diaphragm.", "Pneumoperitoneum from a perforated peptic ulcer")
        self.assertEqual(side.state["status"], "agree")


class CaseJoined(Joined):
    async def test_a_case_is_checked_then_approved_by_a_person(self):
        custom_cases.reset()
        self.addCleanup(custom_cases.reset)
        case = case_author.normalise(copy.deepcopy(GOOD), {**ANSWERS, "allergies": "Aspirin (wheeze)"}, "tg-join01", "Darsh")
        told = []

        async def tell(chat, text, markup=None):
            told.append(text)

        with mock.patch.object(casereview, "_hub", self.hub), mock.patch.object(casereview, "tell", tell):
            casereview.submit(case, {**ANSWERS, "allergies": "Aspirin (wheeze)"}, 7)
            await self.until(self.humans_told)
            findings = custom_cases.review_of("tg-join01")["findings"]
            self.assertEqual(findings["pharmacist"]["verdict"], "hold")
            self.assertIn(findings["lab"]["verdict"], ("release", "clarify"))
            self.assertIn("Pharmacy: unsafe", self.humans_told()[0])
            self.band.human("Rejected: aspirin allergy")
            await self.until(lambda: custom_cases.status_of("tg-join01") == "rejected")
            await self.until(lambda: any("did not approve" in t for t in told))
        self.assertEqual(custom_cases.visible_cases(), [])
        self.assertNotIn(ROLES["examiner"].name, [p["name"] for p in self.band.room["people"]])
        self.assertIn(OWNER["id"], [p["id"] for p in self.band.room["people"]])


if __name__ == "__main__":
    unittest.main()
