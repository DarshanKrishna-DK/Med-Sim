"""The API side of phase 2 against an in-memory BAND: theatre, second read, case review."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
for _p in (str(_B), str(_B / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ["CUSTOM_CASES_FILE"] = "off"

import case_author  # noqa: E402
import custom_cases  # noqa: E402
import telegram_bot as bot  # noqa: E402
from agentroom import bedside, casereview, reads, siderooms, theatre  # noqa: E402
from agentroom import hub as hubmod  # noqa: E402
from agentroom.client import BandError  # noqa: E402
from agentroom.protocol import Handoff, decode  # noqa: E402
from fake_band import FakeBand, OWNER  # noqa: E402
from test_case_author import ANSWERS, GOOD  # noqa: E402

LANGS = ("en", "hi", "kn", "ta", "te", "mr", "bn")


class FlowCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        for p in (mock.patch.dict(os.environ, {"BAND_ASHA_API_KEY": "k", "BAND_RECEPTION_API_KEY": "k", "BAND_THEATRE_API_KEY": "k"}),
                  mock.patch.object(hubmod, "POLL_BUSY_S", 0.02), mock.patch.object(hubmod, "POLL_IDLE_S", 0.05),
                  mock.patch.object(bedside, "_llm_translate", mock.AsyncMock(side_effect=RuntimeError("no llm")))):
            p.start()
            self.addCleanup(p.stop)
        self.band = FakeBand()
        self.hub = hubmod.Hub(client_for=self.band.client)
        self.hub.started = True

    async def asyncTearDown(self) -> None:
        await self.hub.stop()

    async def until(self, cond, what: str = "", timeout: float = 5.0) -> None:
        end = asyncio.get_running_loop().time() + timeout
        while not cond():
            if asyncio.get_running_loop().time() > end:
                self.fail(f"timed out: {what}")
            await asyncio.sleep(0.01)

    def sent(self, action: str, kind: str = "request") -> list[Handoff]:
        return [h for room in self.band.rooms.values() for m in room["messages"]
                if (h := decode(m["content"])[1]) and h.action == action and h.kind == kind]

    def spoken(self, side) -> list[dict]:
        return [e["speak"] for e in side.enc.events.values() if e["type"] == "speak"]

    def humans_told(self) -> list[str]:
        return [m["content"] for room in self.band.rooms.values() for m in room["messages"]
                if any(x["id"] == OWNER["id"] for x in m["metadata"].get("mentions", []))]


class TheatreCase(FlowCase):
    def open(self, lang="en", ref="drill1"):
        ctx = theatre.check(ref, {"scenarioId": "ot-lscs", "extra": "dropped"})
        self.assertEqual(ctx, {"scenarioId": "ot-lscs"})
        side = siderooms.open_room(theatre.KIND, ref, lang=lang, context=ctx, hub=self.hub)
        assert side is not None
        return side

    def test_only_known_operations(self):
        for bad in ("", "im-001", "ot-", "ot-x;drop"):
            with self.assertRaises(ValueError):
                theatre.check("d", {"scenarioId": bad})

    async def test_nothing_is_opened_until_somebody_is_needed(self):
        self.open()
        self.assertFalse(self.band.rooms)

    async def test_blood_waits_for_the_laboratory(self):
        side = self.open()
        await theatre.blood(side, {"n": 1, "units": 2})
        self.assertEqual(side.state["blood"]["status"], "waiting")
        await self.until(lambda: self.sent("crossmatch"))
        h = self.sent("crossmatch")[0]
        self.assertEqual(h.data, {"caseId": "ot-lscs", "product": "packed red cells", "units": 2, "emergency": False})
        self.assertEqual([p["name"] for p in self.band.room["people"]], ["Theatre Sister Leela", "Lab Officer Dev"])
        # a release by somebody else is not a release
        self.band.say("pharmacist", Handoff("result", "crossmatch", h.ref, data={"status": "released", "compatible": True}), to="theatre")
        await asyncio.sleep(0.1)
        self.assertEqual(side.state["blood"]["status"], "waiting")
        self.band.say("lab", Handoff("result", "crossmatch", h.ref, lang="en", spoken="Lab here. Released.", data={
            "status": "released", "compatible": True, "group": "O negative", "units": [{"unit": "K1041", "group": "O negative"}]}), to="theatre")
        await self.until(lambda: side.state["blood"]["status"] == "released")
        self.assertEqual((side.state["blood"]["group"], side.state["blood"]["n"]), ("O negative", 1))
        self.assertIn(("lab", "Lab here. Released."), [(s["speaker"], s["text"]) for s in self.spoken(side)])

    async def test_a_release_without_a_compatible_crossmatch_is_not_one(self):
        side = self.open()
        await theatre.blood(side, {"n": 1})
        await self.until(lambda: self.sent("crossmatch"))
        self.band.say("lab", Handoff("result", "crossmatch", self.sent("crossmatch")[0].ref, data={"status": "released"}), to="theatre")
        await self.until(lambda: side.state["blood"]["status"] == "unavailable")

    async def test_the_sample_question(self):
        side = self.open()
        with self.assertRaises(ValueError):
            await theatre.sample(side, {})
        await theatre.blood(side, {"n": 1})
        await self.until(lambda: self.sent("crossmatch"))
        ref = self.sent("crossmatch")[0].ref
        self.band.say("lab", Handoff("query", "crossmatch", ref, lang="en", spoken="Please send a sample.", data={"question": "sample?"}), to="theatre")
        await self.until(lambda: side.state["blood"]["status"] == "sample")
        await theatre.sample(side, {})
        self.assertEqual(self.sent("crossmatch", "answer")[0].data, {"sample": True})
        with self.assertRaises(ValueError):
            await theatre.sample(side, {})  # once is enough
        self.band.say("lab", Handoff("result", "crossmatch", ref, data={"status": "released", "compatible": True, "units": []}), to="theatre")
        await self.until(lambda: side.state["blood"]["status"] == "released")

    async def test_emergency_is_recorded_and_silence_is_said_so(self):
        side = self.open()
        await theatre.blood(side, {"n": 3, "units": 9, "emergency": True})
        await self.until(lambda: self.sent("crossmatch"))
        self.assertEqual((self.sent("crossmatch")[0].data["emergency"], self.sent("crossmatch")[0].data["units"]), (True, 4))
        with mock.patch.object(theatre, "XM_TIMEOUT_S", 0.05):
            await theatre.blood(side, {"n": 4})
            await self.until(lambda: side.state["blood"]["status"] == "no_reply")
        ref = side.state["blood"]["ref"]
        await theatre.unconfirmed(side, {})
        self.assertTrue(side.state["blood"]["unconfirmed"])
        # the laboratory answers after all: recorded, late
        self.band.say("lab", Handoff("result", "crossmatch", ref, data={"status": "released", "compatible": True, "group": "O negative"}), to="theatre")
        await self.until(lambda: side.state["blood"]["status"] == "released")
        with self.assertRaises(ValueError):
            await theatre.unconfirmed(side, {})

    async def test_allergy_verdict_and_silence(self):
        side = self.open()
        await theatre.allergy(side, {"allergies": "Metoclopramide", "drug": "Cefazolin", "dose": "2 g", "drugs": [{"id": "cefazolin", "name": "Cefazolin"}],
                                     "age": 28, "gender": "F"})
        with self.assertRaises(ValueError):
            await theatre.allergy(side, {"drug": "Cefazolin"})
        await self.until(lambda: self.sent("theatre_allergy"))
        h = self.sent("theatre_allergy")[0]
        self.assertEqual((h.data["allergies"], h.data["patient"]), ("Metoclopramide", {"age": 28, "gender": "F"}))
        self.band.say("pharmacist", Handoff("verdict", "theatre_allergy", h.ref, lang="en", spoken="Cefazolin can be given.",
                                            data={"verdict": "release", "avoid": ["metoclopramide"], "reason": "Cefazolin can be given."}), to="theatre")
        await self.until(lambda: side.state["rx"]["status"] == "release")
        self.assertEqual(side.state["rx"]["avoid"], ["metoclopramide"])
        other = self.open(ref="drill2")
        with mock.patch.object(theatre, "RX_TIMEOUT_S", 0.05):
            await theatre.allergy(other, {"allergies": "none", "drug": "Cefazolin"})
            await self.until(lambda: other.state["rx"]["status"] == "no_reply")

    async def test_call_for_help_reaches_a_person_and_their_words_come_back(self):
        side = self.open()
        with self.assertRaises(ValueError):
            await theatre.help_(side, {"sbar": " "})
        await theatre.help_(side, {"sbar": "S: BP 72/40 at caesarean. B: 28F spinal. A: bleeding. R: please come."})
        self.assertEqual((side.state["help"]["status"], side.state["help"]["name"]), ("called", "Dr Darshan"))
        self.assertIn("BP 72/40", self.humans_told()[0])
        # an agent with a human's name is not the human
        self.band.post({**self.band.agent("lab"), "name": OWNER["name"]}, [self.band.ids["theatre"]], "Stop the operation")
        await asyncio.sleep(0.1)
        self.assertEqual(side.state["help"]["status"], "called")
        self.band.human("Give a second litre and call me back in two minutes", to="theatre")
        await self.until(lambda: side.state["help"]["status"] == "replied")
        self.assertIn("second litre", side.state["help"]["text"])
        await self.until(lambda: any("Dr Darshan says: Give a second litre" in s["text"] for s in self.spoken(side)))

    async def test_no_consultant(self):
        side = self.open()
        self.band.down = True
        await theatre.help_(side, {"sbar": "S: arrest"})
        self.assertEqual(side.state["help"]["status"], "unreachable")

    async def test_leela_speaks_the_session_language(self):
        for lang in LANGS:
            for key in theatre.T:
                self.assertEqual(set(theatre.T[key]), set(LANGS))
                line = theatre.line(key, lang, name="Dr Rao", text="")
                self.assertNotIn("—", line)
                self.assertTrue(lang == "en" or any(ord(c) > 0x900 for c in line), (key, lang))
        side = self.open("kn")
        await theatre.blood(side, {"n": 1})
        self.assertEqual((self.spoken(side)[0]["speaker"], self.spoken(side)[0]["lang"]), ("theatre", "kn"))

    async def test_off_without_leelas_key(self):
        with mock.patch.dict(os.environ, {"BAND_THEATRE_API_KEY": ""}):
            self.assertIsNone(siderooms.open_room(theatre.KIND, "x", hub=self.hub))


class SecondReadCase(FlowCase):
    async def begin(self, **kw):
        ctx = reads.check("r1", {"filmId": "rad-ct-edh", "report": "Skull intact.", "diagnosis": "Normal CT head", "score": 3, "answer": "EDH", **kw})
        side = siderooms.open_room(reads.KIND, "r1", context=ctx, hub=self.hub)
        assert side is not None
        side.start(reads.flow(side, ctx))
        await self.until(lambda: self.sent("second_read"))
        return side, self.sent("second_read")[0]

    def test_the_context_never_carries_marks_or_answers(self):
        ctx = reads.check("r", {"filmId": "rad-ct-edh", "report": "x" * 9000, "diagnosis": "y", "findings": ["z"], "score": 99})
        self.assertEqual(set(ctx), {"filmId", "report", "diagnosis"})
        self.assertEqual(len(ctx["report"]), 4000)
        for bad in ({"filmId": "x", "diagnosis": "y"}, {"filmId": "rad-ct-edh"}):
            with self.assertRaises(ValueError):
                reads.check("r", bad)

    async def test_agreement_ends_it(self):
        side, h = await self.begin()
        self.assertEqual(set(h.data), {"filmId", "report", "diagnosis"})
        self.band.say("radiology", Handoff("result", "second_read", h.ref, data={"outcome": "agree", "missed": [], "diagnosisAgrees": True}))
        await self.until(lambda: side.state["status"] == "agree")
        self.assertTrue(side.state["final"])
        self.assertEqual([c["who"] for c in side.state["chain"]], ["nurse", "radiology"])

    async def test_critical_finding_is_acknowledged_and_closed(self):
        side, h = await self.begin()
        label = "Biconvex (lentiform) hyperdense extra-axial collection"
        self.band.say("radiology", Handoff("result", "second_read", h.ref, data={
            "outcome": "discrepancy", "missed": [{"label": label, "critical": True}], "diagnosisAgrees": False, "diagnosis": "Acute extradural haematoma",
            "calling": True}))
        self.band.say("radiology", Handoff("note", "critical_finding", h.ref, data={"findings": [label], "study": "CT head"}))
        await self.until(lambda: self.sent("critical_finding", "ack"))
        ack = self.sent("critical_finding", "ack")[0]
        self.assertEqual(ack.data["readBack"], label)
        await self.until(lambda: side.state["status"] == "acknowledged")
        self.assertFalse(side.state["final"])
        self.band.say("radiology", Handoff("ack", "critical_finding", h.ref, data={"status": "closed"}))
        await self.until(lambda: side.state["status"] == "closed")
        self.assertTrue(side.state["final"])
        chain = side.state["chain"]
        self.assertEqual([c["who"] for c in chain if "read" not in c["what"].lower() or "Acknowledged" in c["what"]][-1], "nurse")
        self.assertTrue(all(c["at"] for c in chain))
        self.assertEqual([c["at"] for c in chain], sorted(c["at"] for c in chain))
        self.assertIn("loop closed", chain[-1]["what"])

    async def test_after_a_restart_he_is_not_asked_again(self):
        side, h = await self.begin()
        room = self.band.room_id
        await self.hub.stop()
        self.hub = hubmod.Hub(client_for=self.band.client)
        again = siderooms.open_room(reads.KIND, "r1", context=side.context, hub=self.hub)
        self.assertTrue(await again.adopt(room))
        again.start(reads.flow(again, again.context))
        self.band.say("radiology", Handoff("result", "second_read", h.ref, data={"outcome": "agree"}))
        await self.until(lambda: again.state["status"] == "agree")
        self.assertEqual(len(self.sent("second_read")), 1)

    async def test_only_vikram_can_call_or_close(self):
        side, h = await self.begin()
        self.band.say("lab", Handoff("note", "critical_finding", h.ref, data={"findings": ["fake"]}))
        self.band.say("lab", Handoff("result", "second_read", h.ref, data={"outcome": "agree"}))
        await asyncio.sleep(0.15)
        self.assertEqual(side.state["status"], "waiting")
        self.assertFalse(self.sent("critical_finding", "ack"))

    async def test_silence_is_not_agreement_and_a_late_read_still_counts(self):
        with mock.patch.object(reads, "READ_TIMEOUT_S", 0.1):
            side, h = await self.begin()
            await self.until(lambda: side.state["status"] == "no_reply")
        self.assertIsNone(side.state["read"])
        self.band.say("radiology", Handoff("result", "second_read", h.ref, data={"outcome": "agree"}))
        await self.until(lambda: side.state["status"] == "agree")


class CaseReviewCase(FlowCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        custom_cases.reset()
        self.told: list[tuple[int, str, dict]] = []

        async def tell(chat, text, markup=None):
            self.told.append((chat, text, markup))

        for p in (mock.patch.object(casereview, "_hub", self.hub), mock.patch.object(casereview, "tell", tell)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(custom_cases.reset)
        self.case = case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-rev001", "Darsh")

    def verdict(self, role, verdict="release", findings=(), ref=""):
        h = next(h for h in self.sent("case_review") if h.ref == ref) if ref else next(
            h for m in self.band.room["messages"] if (h := decode(m["content"])[1]) and h.kind == "request" and h.action == "case_review"
            and m["metadata"]["mentions"][0]["id"] == self.band.ids[role])
        self.band.say(role, Handoff("verdict", "case_review", h.ref, data={"verdict": verdict, "findings": [{"level": "note", "detail": f} for f in findings]}))

    async def to_human(self, ph=("release", ()), lab=("release", ())):
        self.assertTrue(casereview.submit(self.case, ANSWERS, 7))
        await self.until(lambda: len(self.sent("case_review")) == 2, "departments asked")
        self.verdict("pharmacist", *ph)
        self.verdict("lab", *lab)
        await self.until(self.humans_told, "person asked")
        return siderooms.get(casereview.KIND, self.case["id"], self.hub)

    def visible(self):
        return [c["id"] for c in custom_cases.api_list()["cases"]]

    async def test_hidden_until_a_person_approves(self):
        side = await self.to_human(lab=("clarify", ("no test on the case can show it",)))
        self.assertEqual((self.visible(), custom_cases.status_of("tg-rev001")), ([], "in_review"))
        with self.assertRaises(Exception):
            custom_cases.api_get("tg-rev001")
        brief = self.humans_told()[0]
        self.assertIn("no test on the case can show it", brief)
        self.assertNotIn("Ravi Kumar", json.dumps(list(self.band.rooms.values())))
        await self.until(lambda: self.told, "author told about the checks")
        self.assertIn("Laboratory: points to look at", self.told[-1][1])
        self.assertEqual(self.told[-1][2]["inline_keyboard"][0][0]["callback_data"], "p:tg-rev001")
        self.band.human("Approved, good case")
        await self.until(lambda: custom_cases.status_of("tg-rev001") == "approved")
        self.assertEqual(self.visible(), ["tg-rev001"])
        self.assertEqual(custom_cases.api_list()["cases"][0]["reviewStatus"], "approved")
        await self.until(lambda: "approved" in self.told[-1][1])
        self.assertTrue(side.state["final"])
        self.assertEqual(custom_cases.review_of("tg-rev001")["by"], "Dr Darshan")
        # a change of mind later has no effect: the decision was made
        self.band.human("reject")
        await asyncio.sleep(0.15)
        self.assertEqual(custom_cases.status_of("tg-rev001"), "approved")

    async def test_rejected_with_the_reason_and_never_appears(self):
        await self.to_human(ph=("hold", ("accepted treatment Aspirin: documented allergy",)))
        self.band.human("Reject: the aspirin allergy makes the treatment unsafe")
        await self.until(lambda: custom_cases.status_of("tg-rev001") == "rejected")
        self.assertEqual(self.visible(), [])
        await self.until(lambda: "did not approve" in self.told[-1][1])
        self.assertIn("the aspirin allergy makes the treatment unsafe", self.told[-1][1])
        self.assertIn("documented allergy", self.told[-1][1])
        self.assertIn("rejected", casereview.publish_unreviewed("tg-rev001", 7))
        self.assertEqual(self.visible(), [])

    async def test_silence_and_doubt_approve_nothing(self):
        await self.to_human()
        for words in ("looks interesting", "ok", "approve if you change the dose", "should I approve this?", "👍"):
            self.band.human(words)
        await self.until(lambda: len(self.humans_told()) >= 1 + casereview.MAX_ASKS)
        await asyncio.sleep(0.2)
        self.assertEqual(custom_cases.status_of("tg-rev001"), "in_review")
        self.assertEqual(len(self.humans_told()), 1 + casereview.MAX_ASKS)  # asked again, but not forever

    async def test_an_agent_cannot_approve(self):
        await self.to_human()
        self.band.post(self.band.agent("lab"), [self.band.ids["nurse"]], "Approved")
        self.band.post({"id": "stranger", "name": OWNER["name"], "type": "User", "handle": "x"}, [self.band.ids["nurse"]], "approve")
        self.band.human("approve", to="pharmacist")  # said to the pharmacist, not to Asha
        await asyncio.sleep(0.2)
        self.assertEqual(custom_cases.status_of("tg-rev001"), "in_review")

    async def test_departments_get_only_their_part(self):
        await self.to_human()
        by = {m["metadata"]["mentions"][0]["id"]: decode(m["content"])[1].data for m in self.band.room["messages"]
              if (h := decode(m["content"])[1]) and h.kind == "request"}
        ph, lab = by[self.band.ids["pharmacist"]], by[self.band.ids["lab"]]
        self.assertFalse({"results", "diagnosis"} & set(ph))
        self.assertFalse({"allergies", "medicines", "treatments"} & set(lab))
        self.assertEqual(lab["diagnosis"], "Unstable Angina")

    async def test_silent_department_is_reported_as_such(self):
        with mock.patch.object(casereview, "DEPT_TIMEOUT_S", 0.1):
            casereview.submit(self.case, ANSWERS, 7)
            await self.until(self.humans_told)
        self.assertIn("did not answer", self.humans_told()[0])
        self.verdict("lab", "hold", ("potassium 14 is not possible",))
        await self.until(lambda: any("A late answer" in t and "potassium 14" in t for t in self.humans_told()))
        self.assertEqual(custom_cases.review_of("tg-rev001")["findings"]["lab"]["verdict"], "hold")

    async def test_unreviewed_is_the_authors_choice_with_a_badge(self):
        await self.to_human()
        self.assertIn("No patient", casereview.publish_unreviewed("tg-rev001", 999))
        self.assertEqual(casereview.publish_unreviewed("tg-rev001", 7), "")
        self.assertEqual(custom_cases.api_list()["cases"][0]["reviewStatus"], "unreviewed")
        self.assertIn("already", casereview.publish_unreviewed("tg-rev001", 7))
        self.band.human("reject, vitals do not fit")
        await self.until(lambda: custom_cases.status_of("tg-rev001") == "rejected")
        self.assertEqual(self.visible(), [])

    async def test_no_reviewer_keeps_it_in_review(self):
        with mock.patch.object(siderooms.SideRoom, "invite_human", mock.AsyncMock(side_effect=BandError("down"))):
            casereview.submit(self.case, ANSWERS, 7)
            await self.until(lambda: len(self.sent("case_review")) == 2)
            self.verdict("pharmacist")
            self.verdict("lab")
            await self.until(lambda: self.told)
        self.assertIn("No reviewer could be reached", self.told[-1][1])
        self.assertEqual(custom_cases.status_of("tg-rev001"), "in_review")

    async def test_deleted_while_waiting(self):
        await self.to_human()
        self.assertTrue(custom_cases.delete("tg-rev001", 7))
        self.band.human("approve")
        await self.until(lambda: any("deleted" in t for t in self.humans_told()))
        self.assertEqual(self.visible(), [])

    async def test_after_a_restart_the_room_is_taken_up_again(self):
        await self.to_human()
        self.assertEqual(custom_cases.review_of("tg-rev001")["roomId"], self.band.room_id)
        await self.hub.stop()
        self.hub = hubmod.Hub(client_for=self.band.client)
        self.hub.started = True
        with mock.patch.object(casereview, "_hub", self.hub):
            await casereview.resume_one("tg-rev001")
            self.band.human("approve")
            await self.until(lambda: custom_cases.status_of("tg-rev001") == "approved")
        self.assertEqual(len(self.sent("case_review")), 2)  # nothing was asked twice

    async def test_without_band_or_outside_the_server_it_is_published_at_once(self):
        self.hub.started = False
        self.assertFalse(casereview.submit(self.case, ANSWERS, 7))
        self.hub.started = True
        with mock.patch.dict(os.environ, {"BAND_ASHA_API_KEY": ""}):
            self.assertFalse(casereview.submit(self.case, ANSWERS, 7))
        self.assertIsNone(custom_cases.status_of("tg-rev001"))

    def test_plain_words_only(self):
        for text, want in (("approve", "approve"), ("Approved.", "approve"), ("publish it", "approve"), ("Accepted, thanks", "approve"),
                           ("reject: wrong units", "reject"), ("Rejected because Hb is implausible", "reject"), ("do not publish this", "reject"),
                           ("not approved", "reject"), ("send it back, vitals do not fit", "reject"), ("needs changes", "reject"),
                           ("ok", ""), ("", ""), ("can I approve it?", ""), ("approve if the dose is changed", ""), ("maybe approve", ""),
                           ("approve but fix the potassium first", ""), ("what is the diagnosis", "")):
            self.assertEqual(casereview.decide(text)[0], want, text)
        self.assertEqual(casereview.decide("Reject: wrong units")[1], "wrong units")
        self.assertEqual(casereview.decide("Rejected because Hb is implausible")[1], "Hb is implausible")


class BotReviewCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        custom_cases.reset()
        self.addCleanup(custom_cases.reset)
        self.addCleanup(bot._chats.clear)
        self.addCleanup(bot._sessions.clear)
        self.sent = []

        async def send(chat, text, markup=None):
            self.sent.append((chat, text, markup))
            return {"ok": True}

        async def api(method, payload):
            return {"ok": True}

        for p in (mock.patch.object(bot, "send", send), mock.patch.object(bot, "api", api)):
            p.start()
            self.addCleanup(p.stop)
        self.case = case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-bot001", "Darsh")

    async def test_created_case_goes_to_review(self):
        async def gen(answers, first=""):
            return self.case

        def submit(case, answers, chat):
            custom_cases.add(case, chat, custom_cases.IN_REVIEW)
            return True

        with mock.patch.object(case_author, "generate_case", gen), mock.patch.object(casereview, "submit", submit):
            await bot.create_case(5, {"answers": ANSWERS, "step": "generating"})
        chat, text, markup = self.sent[-1]
        self.assertIn("in review", text)
        self.assertNotIn("?case=", text)  # no link to something nobody can open
        self.assertEqual(markup["inline_keyboard"][0][0]["callback_data"], "p:tg-bot001")
        await bot.cmd_list(5)
        self.assertIn("in review", self.sent[-1][1])
        self.assertNotIn("?case=", self.sent[-1][1])

    async def test_publish_button_and_command(self):
        custom_cases.add(self.case, 5, custom_cases.IN_REVIEW)
        await bot.handle_callback({"id": "1", "data": "p:tg-bot001", "message": {"chat": {"id": 6}}})
        self.assertIn("No patient", self.sent[-1][1])
        await bot.handle_callback({"id": "1", "data": "p:tg-bot001", "message": {"chat": {"id": 5}}})
        self.assertIn("UNREVIEWED", self.sent[-1][1])
        await bot.cmd_list(5)
        self.assertIn("published UNREVIEWED", self.sent[-1][1])
        await bot.cmd_publish(5, "")
        self.assertIn("/publish", self.sent[-1][1])

    async def test_rejected_shows_its_reason_to_the_author(self):
        custom_cases.add(self.case, 5, custom_cases.IN_REVIEW)
        custom_cases.set_review("tg-bot001", custom_cases.REJECTED, reason="wrong <units>")
        await bot.cmd_list(5)
        self.assertIn("rejected, not visible: wrong &lt;units&gt;", self.sent[-1][1])

    def test_status_survives_the_file(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"CUSTOM_CASES_FILE": str(Path(d) / "c.json")}):
            custom_cases.add(self.case, 5, custom_cases.IN_REVIEW, {"roomId": "room1"})
            custom_cases.reset(load_file=True)
            self.assertEqual((custom_cases.status_of("tg-bot001"), custom_cases.review_of("tg-bot001")), ("in_review", {"roomId": "room1"}))
            # an old file has no status: those cases were published
            rows = json.loads((Path(d) / "c.json").read_text(encoding="utf-8"))
            for r in rows:
                r.pop("status")
                r.pop("review")
            (Path(d) / "c.json").write_text(json.dumps(rows), encoding="utf-8")
            custom_cases.reset(load_file=True)
            self.assertEqual(custom_cases.visible_cases(), [self.case])
            rows[0]["status"] = "whatever"
            (Path(d) / "c.json").write_text(json.dumps(rows), encoding="utf-8")
            custom_cases.reset(load_file=True)
            self.assertEqual(custom_cases.visible_cases(), [])


if __name__ == "__main__":
    unittest.main()
