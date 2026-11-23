"""The room hub against an in-memory BAND: lifecycle, trust rules, faculty, SSE. No network."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_B = Path(__file__).resolve().parents[1]
for _p in (str(_B), str(_B / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agentroom import asha, bedside, client as band_client, faculty, hub as hubmod  # noqa: E402
from agentroom.protocol import Handoff  # noqa: E402
from fake_band import FakeBand  # noqa: E402

PATIENT = {"name": "Ravi Kumar", "age": 45, "gender": "M", "chiefComplaint": "chest pain, says Ravi",
           "allergies": "Yes, penicillin. Rash.", "anamnesis": [{"question": "Any drug allergies?", "answer": "Yes, penicillin."}]}


class HubCase(unittest.IsolatedAsyncioTestCase):
    lang = "en"
    osce = False

    async def asyncSetUp(self) -> None:
        env = mock.patch.dict(os.environ, {"BAND_ASHA_API_KEY": "test-key"})
        env.start()
        self.addCleanup(env.stop)
        for target, value in ((hubmod, {"COALESCE_S": 0.02, "POLL_BUSY_S": 0.02, "POLL_IDLE_S": 0.05}),):
            for k, v in value.items():
                p = mock.patch.object(target, k, v)
                p.start()
                self.addCleanup(p.stop)
        p = mock.patch.object(bedside, "_llm_translate", mock.AsyncMock(side_effect=RuntimeError("no llm in tests")))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(faculty, "_ask_llm", mock.AsyncMock(side_effect=RuntimeError("no llm in tests")))
        self.ask_llm = p.start()
        self.addCleanup(p.stop)
        self.band = FakeBand()
        self.hub = hubmod.Hub(client_for=self.band.client)
        self.assertTrue(self.hub.open("enc-1", "im-005", self.lang, self.osce, dict(PATIENT), "Dr Test"))
        self.enc = self.hub.get("enc-1")
        self.hub.set_chart(self.enc, [], {"amox": "Amoxicillin 500mg", "azithromycin-500": "Azithromycin 500mg", "asp": "Aspirin 100mg"})

    async def asyncTearDown(self) -> None:
        await self.hub.stop()

    # helpers
    async def until(self, cond, what: str = "condition", timeout: float = 3.0) -> None:
        end = asyncio.get_running_loop().time() + timeout
        while not cond():
            if asyncio.get_running_loop().time() > end:
                self.fail(f"timed out waiting for {what}")
            await asyncio.sleep(0.01)

    def events(self, etype: str) -> list[dict]:
        return [e for e in self.enc.events.values() if e["type"] == etype]

    def applies(self) -> list[dict]:
        return [e["apply"] for e in self.events("apply")]

    def spoken(self) -> list[dict]:
        return [e["speak"] for e in self.events("speak")]

    async def rx(self, **kw):
        r = self.hub.delegate_rx(self.enc, kw.pop("mid", "amox"), kw.pop("name", "Amoxicillin 500mg"), "500 mg three times a day", "7 days", **kw)
        await self.until(lambda: r.message_ids, "request posted")
        return r

    def verdict(self, r, verdict: str, **data):
        d = {"verdict": verdict, "medicationId": r.medication_id, "reason": "Documented penicillin allergy", **data}
        return Handoff(kind="verdict", action="verify_rx", ref=r.ref, enc="enc-1", lang="en", spoken=data.pop("spoken", ""), data=d)

    async def held(self):
        r = await self.rx()
        self.band.say("pharmacist", self.verdict(r, "hold"))
        await self.until(lambda: r.status == "held", "hold")
        return r

    async def with_faculty(self, r):
        out = await self.hub.request_override(self.enc, r.ref, "rash was 20 years ago")
        self.assertTrue(out["ok"])
        return r


class Lifecycle(HubCase):
    async def test_room_is_lazy_titled_without_the_name_and_grows_by_need(self) -> None:
        self.assertEqual(self.band.rooms, {})
        r = await self.rx()
        self.assertIn("45M", self.band.room["title"])
        self.assertNotIn("Ravi", self.band.room["title"])
        self.assertEqual([p["name"] for p in self.band.room["people"]], ["Nurse Asha", "Pharmacist Meera"])
        self.assertTrue(any("first prescription" in m["content"] for m in self.band.room["messages"] if m["message_type"] == "thought"))
        self.hub.delegate_tests(self.enc, [{"testId": "cbc", "name": "CBC", "category": "lab"}, {"testId": "ecg", "name": "ECG", "category": "bedside"},
                                           {"testId": "cxr", "name": "Chest X-Ray", "category": "imaging"}])
        await self.until(lambda: len(self.band.requests()) == 3, "three requests")
        (_, lab), = self.band.requests("run_test")
        (_, img), = self.band.requests("run_imaging")
        self.assertEqual([t["testId"] for t in lab.data["tests"]], ["cbc", "ecg"])  # one message per department
        self.assertEqual(set(lab.data), {"caseId", "tests", "patient"})  # minimum disclosure
        self.assertEqual(lab.data["patient"], {"age": 45, "gender": "M"})
        self.assertEqual(img.data["pregnancy"], "no")
        self.assertNotIn("Ravi", json.dumps([lab.data, img.data, self.band.requests("verify_rx")[0][1].data]))
        self.assertEqual(len(self.band.rooms), 1)
        self.assertEqual(r.target_id, self.band.ids["pharmacist"])

    async def test_release_applies_once_and_speaks(self) -> None:
        r = await self.rx()
        mid = next(iter(r.message_ids))
        self.band.mark(mid, "processing")
        await self.until(lambda: r.status == "working", "working")
        m = self.band.say("pharmacist", self.verdict(r, "release", spoken="Cleared, doctor."))
        await self.until(lambda: r.status == "done", "done")
        # WebSocket redelivery, polling and a second verdict message: still one prescription.
        self.hub.on_band_message(self.band.room_id, dict(m))
        self.band.say("pharmacist", self.verdict(r, "release"))
        await asyncio.sleep(0.15)
        rx = [a for a in self.applies() if "addPrescription" in a]
        self.assertEqual(rx, [{"ref": r.ref, "addPrescription": {"medicationId": "amox", "dose": "500 mg three times a day", "duration": "7 days"}}])
        self.assertEqual([(s["speaker"], s["text"]) for s in self.spoken()], [("nurse", "Cleared, doctor.")])
        ticks = [e["message"] for e in self.events("message") if e["message"].get("ref") == r.ref and e["message"]["from"] == "nurse"]
        self.assertEqual(ticks[0]["delivery"], "processing")
        self.assertEqual(ticks[0]["to"], ["pharmacist"])

    async def test_waiting_on_another_department(self) -> None:
        r = await self.rx()
        await self.hub._ensure_participant(self.enc, "lab", "x")
        self.band.say("pharmacist", Handoff("query", "renal_function", r.ref, "enc-1", data={"caseId": "im-005"}), to="lab")
        await self.until(lambda: r.status == "waiting", "waiting")
        self.assertEqual(r.waiting_on, "lab")
        self.band.say("lab", Handoff("answer", "renal_function", r.ref, "enc-1", data={"available": True, "egfr": 90, "text": "ok"}), to="pharmacist")
        await self.until(lambda: r.status == "working", "working")
        texts = [e["message"] for e in self.events("message") if e["message"].get("action") == "renal_function"]
        self.assertEqual([t["from"] for t in texts], ["pharmacist", "lab"])  # side channel is in the transcript
        self.assertEqual(self.applies(), [])

    async def test_results_only_for_requested_tests_once(self) -> None:
        r, = self.hub.delegate_tests(self.enc, [{"testId": "cbc", "name": "CBC", "category": "lab"}, {"testId": "crp", "name": "CRP", "category": "lab"}])
        await self.until(lambda: r.message_ids, "posted")
        res = lambda **k: Handoff("result", "run_test", r.ref, "enc-1", data=k)  # noqa: E731
        self.band.say("lab", res(results=[{"testId": "cbc", "name": "evil name", "result": "WBC 14", "abnormal": True, "critical": False},
                                          {"testId": "troponin", "result": "99", "abnormal": True, "critical": True}]))
        await self.until(lambda: self.applies(), "first result")
        self.assertEqual(r.status, "working")
        self.band.say("lab", res(results=[{"testId": "cbc", "result": "changed", "abnormal": False}], unknown=["crp"]))
        await self.until(lambda: r.status == "done", "done")
        self.assertEqual(self.applies()[0]["results"], [{"testId": "cbc", "name": "CBC", "result": "WBC 14", "abnormal": True, "critical": False}])
        self.assertEqual(self.applies()[1], {"ref": r.ref, "cancelTests": ["crp"]})
        self.assertEqual(self.enc.results["cbc"]["result"], "WBC 14")
        self.assertEqual(self.enc.criticals, [])

    async def test_results_landing_together_are_one_line_and_critical_is_urgent(self) -> None:
        a = await self.rx()
        b, c = self.hub.delegate_tests(self.enc, [{"testId": "cbc", "name": "CBC", "category": "lab"}, {"testId": "cxr", "name": "Chest X-Ray", "category": "imaging"}])
        await self.until(lambda: b.message_ids and c.message_ids, "posted")
        with mock.patch.object(hubmod, "COALESCE_S", 0.2):
            self.band.say("pharmacist", self.verdict(a, "release"))
            self.band.say("lab", Handoff("result", "run_test", b.ref, "enc-1", data={"results": [{"testId": "cbc", "result": "x"}]}))
            await self.until(lambda: a.status == "done" and b.status == "done", "both")
            await self.until(lambda: self.spoken(), "speech")
        self.assertEqual(len(self.spoken()), 1)
        self.assertEqual(self.spoken()[0]["speaker"], "nurse")
        self.assertIn("Amoxicillin", self.spoken()[0]["text"])
        self.assertIn("CBC", self.spoken()[0]["text"])
        self.band.say("radiology", Handoff("result", "run_imaging", c.ref, "enc-1", spoken="Doctor, tension pneumothorax.", data={
            "results": [{"testId": "cxr", "result": "pneumothorax", "abnormal": True, "critical": True}], "impression": "Tension pneumothorax"}))
        await self.until(lambda: len(self.spoken()) == 2, "critical")
        self.assertEqual((self.spoken()[1]["priority"], self.spoken()[1]["speaker"]), ("urgent", "nurse"))
        self.assertEqual(c.summary, "Tension pneumothorax")
        self.assertIsNone(self.enc.criticals[0]["ackAt"])
        await asyncio.sleep(0.02)
        self.hub.doctor_acted(self.enc)
        self.assertIsNotNone(self.enc.criticals[0]["ackAt"])

    async def test_timeout_then_late_result(self) -> None:
        with mock.patch.object(hubmod, "TIMEOUT_S", 0.05):
            r = await self.rx()
            await self.until(lambda: r.status == "timeout", "timeout")
        await self.until(lambda: self.spoken(), "spoken timeout")
        self.assertIn("hasn't replied", self.spoken()[0]["text"])
        self.band.say("pharmacist", self.verdict(r, "release"))
        await self.until(lambda: r.status == "done", "late result")
        self.assertEqual(len([a for a in self.applies() if "addPrescription" in a]), 1)

    async def test_cancel_and_retry(self) -> None:
        r, = self.hub.delegate_tests(self.enc, [{"testId": "cbc", "name": "CBC", "category": "lab"}])
        await self.until(lambda: r.message_ids, "posted")
        self.assertTrue(self.hub.cancel(self.enc, r.ref)["ok"])
        self.assertEqual(self.applies(), [{"ref": r.ref, "cancelTests": ["cbc"]}])
        self.band.say("lab", Handoff("result", "run_test", r.ref, "enc-1", data={"results": [{"testId": "cbc", "result": "x"}]}))
        await asyncio.sleep(0.15)
        self.assertEqual(len(self.applies()), 1)  # a result for a cancelled order changes nothing
        self.assertEqual(r.status, "cancelled")
        await self.until(lambda: any("disregard" in t for t in self.band.plain()), "department told")
        self.assertFalse(self.hub.retry(self.enc, r.ref)["ok"])
        with mock.patch.object(hubmod, "TIMEOUT_S", 0.05):
            r2, = self.hub.delegate_tests(self.enc, [{"testId": "crp", "name": "CRP", "category": "lab"}])
            await self.until(lambda: r2.status == "timeout", "timeout")
        self.assertTrue(self.hub.retry(self.enc, r2.ref)["ok"])
        await self.until(lambda: len([1 for _, h in self.band.requests("run_test") if h.ref == r2.ref]) == 2, "sent again")
        self.assertEqual(r2.status, "sent")

    async def test_cancel_one_test_keeps_the_rest(self) -> None:
        r, = self.hub.delegate_tests(self.enc, [{"testId": "cbc", "name": "CBC", "category": "lab"}, {"testId": "crp", "name": "CRP", "category": "lab"}])
        await self.until(lambda: r.message_ids, "posted")
        self.assertTrue(self.hub.cancel_test(self.enc, "crp"))
        self.assertEqual((r.test_ids, r.status), (["cbc"], "sent"))
        self.band.say("lab", Handoff("result", "run_test", r.ref, "enc-1", data={"results": [{"testId": "cbc", "result": "x"}, {"testId": "crp", "result": "y"}]}))
        await self.until(lambda: r.status == "done", "done")
        self.assertEqual([x["testId"] for a in self.applies() for x in a.get("results", [])], ["cbc"])

    async def test_outage_fails_the_delegation_only_and_retry_recovers(self) -> None:
        self.band.down = True
        r = self.hub.delegate_rx(self.enc, "amox", "Amoxicillin 500mg", "500 mg", "7 days")
        await self.until(lambda: r.status == "failed", "failed")
        await self.until(lambda: self.spoken(), "spoken")
        self.assertIn("couldn't reach", self.spoken()[0]["text"])
        self.band.down = False
        self.hub.retry(self.enc, r.ref)
        await self.until(lambda: r.message_ids, "posted")
        self.band.say("pharmacist", self.verdict(r, "release"))
        await self.until(lambda: r.status == "done", "done")

    async def test_department_failure_ack(self) -> None:
        r = await self.rx()
        self.band.say("pharmacist", Handoff("ack", "verify_rx", r.ref, "enc-1", data={"status": "failed", "reason": "error"}))
        await self.until(lambda: r.status == "failed", "failed")
        self.assertEqual(self.applies(), [])

    async def test_safety_question_pauses_the_clock_and_the_answer_goes_back(self) -> None:
        with mock.patch.object(hubmod, "TIMEOUT_S", 0.3):
            r, = self.hub.delegate_tests(self.enc, [{"testId": "cxr", "name": "Chest X-Ray", "category": "imaging"}])
            await self.until(lambda: r.message_ids, "posted")
            self.band.say("radiology", Handoff("query", "safety_question", r.ref, "enc-1", data={"question": "Any metal implants?", "about": r.ref}))
            await self.until(lambda: self.events("question"), "question")
            self.assertEqual({k: self.events("question")[0][k] for k in ("ref", "from", "text")},
                             {"ref": r.ref, "from": "radiology", "text": "Any metal implants?"})
            await asyncio.sleep(0.4)
            self.assertEqual((r.status, r.waiting_on), ("waiting", "nurse"))  # waiting for the doctor is not a timeout
        await self.until(lambda: self.spoken(), "spoken")
        self.assertEqual((self.spoken()[0]["speaker"], "metal implants" in self.spoken()[0]["text"]), ("nurse", True))
        self.assertTrue(self.hub.answer(self.enc, r.ref, "No implants, Ravi is fine", "en"))
        self.assertFalse(self.hub.answer(self.enc, r.ref, "again", "en"))
        await self.until(lambda: self.band.requests("safety_question"), "answer posted")
        m, h = self.band.requests("safety_question")[0]
        self.assertEqual((h.kind, h.ref, h.data), ("answer", r.ref, {"answer": "No implants, the patient is fine"}))
        self.assertEqual(m["metadata"]["mentions"], [{"id": self.band.ids["radiology"]}])

    async def test_ask_gets_only_that_departments_facts(self) -> None:
        await self.held()
        for role in ("lab", "radiology", "pharmacist"):
            self.assertIsNotNone(self.hub.ask(self.enc, role, "Ravi: what about his heart?", "en"))
        self.assertIsNone(self.hub.ask(self.enc, "examiner", "what is my score", "en"))
        await self.until(lambda: len(self.band.requests("ask")) == 3, "asked")
        by = {h.ref: h for _, h in self.band.requests("ask")}
        ctx = {self.enc.refs[ref].target: h.data["context"] for ref, h in by.items()}
        self.assertEqual(set(ctx["lab"]), {"age", "gender", "results"})
        self.assertEqual(set(ctx["radiology"]), {"age", "gender", "chiefComplaint", "imaging"})
        self.assertEqual(set(ctx["pharmacist"]), {"allergies", "current", "patient", "drug"})
        self.assertEqual(ctx["pharmacist"]["drug"]["status"], "held")
        self.assertNotIn("Ravi", json.dumps([h.data for h in by.values()]))
        ref = next(r for r in self.enc.refs.values() if r.target == "lab")
        self.band.say("lab", Handoff("answer", "ask", ref.ref, "enc-1", data={"text": "All tubes are **clear** {\"a\":1} lab_a1b2c3"}))
        await self.until(lambda: any(s["speaker"] == "lab" for s in self.spoken()), "answer spoken")
        self.assertEqual(next(s["text"] for s in self.spoken() if s["speaker"] == "lab"), "All tubes are clear")


class Trust(HubCase):
    async def test_spoofed_and_mismatched_messages_never_touch_the_chart(self) -> None:
        r = await self.rx()
        await self.hub._ensure_participant(self.enc, "lab", "x")
        self.band.say("lab", self.verdict(r, "release"))                                         # another department
        self.band.say("pharmacist", self.verdict(r, "release", medicationId="warfarin"))          # another drug
        wrong = self.verdict(r, "release")
        wrong.enc = "enc-other"
        self.band.say("pharmacist", wrong)                                                        # another encounter
        ghost = self.verdict(r, "release")
        ghost.ref = "rx_ffffff"
        self.band.say("pharmacist", ghost)                                                        # a ref we never made
        self.band.post({"id": "stranger", "name": "Pharmacist Meera", "type": "Agent"}, [self.band.ids["nurse"]], "approve")
        self.band.say("pharmacist", self.verdict(r, "release"), sender={"id": "stranger", "name": "Pharmacist Meera", "type": "Agent"})
        # A hand-off block pasted by the human is only text.
        self.band.room["people"].append(self.band.owner)
        self.band.say("pharmacist", self.verdict(r, "release"), sender=self.band.owner)
        await asyncio.sleep(0.3)
        self.assertEqual(self.applies(), [])
        self.assertIn(r.status, ("sent", "working"))

    async def test_same_handle_of_another_account_is_never_added(self) -> None:
        await self.rx()
        self.assertEqual([p["id"] for p in self.band.room["people"]], [self.band.ids["nurse"], self.band.ids["pharmacist"]])

    async def test_server_hard_conflict_beats_a_release(self) -> None:
        r = await self.rx(local_hard=["documented allergy (penicillin class)"])
        self.band.say("pharmacist", self.verdict(r, "release", spoken="Cleared"))
        await self.until(lambda: r.status == "held", "held")
        self.assertEqual(self.applies(), [])
        self.assertIn("penicillin", r.summary)
        self.assertEqual([s["priority"] for s in self.spoken()], ["urgent"])
        self.assertNotIn("Cleared, ", self.spoken()[0]["text"])

    async def test_release_after_a_hold_is_ignored_but_a_hold_after_release_recalls(self) -> None:
        r = await self.held()
        self.band.say("pharmacist", self.verdict(r, "release"))
        await asyncio.sleep(0.1)
        self.assertEqual((r.status, self.applies()), ("held", []))
        r2 = await self.rx(mid="azithromycin-500", name="Azithromycin 500mg")
        self.band.say("pharmacist", self.verdict(r2, "release"))
        await self.until(lambda: r2.status == "done", "released")
        recall = Handoff("recall", "verify_rx", "rx_0a0a0a", "enc-1", data={"originalRef": r2.ref, "medicationId": r2.medication_id, "reason": "Potassium is 6.4"})
        self.band.say("lab", recall)  # only the pharmacist may recall
        await asyncio.sleep(0.08)
        self.assertTrue(r2.active)
        self.band.say("pharmacist", recall)
        await self.until(lambda: not r2.active, "recalled")
        self.assertEqual(self.applies()[-1]["removePrescription"]["medicationId"], "azithromycin-500")
        self.assertEqual(r2.status, "held")
        self.band.say("pharmacist", recall)
        await asyncio.sleep(0.08)
        self.assertEqual(len([a for a in self.applies() if "removePrescription" in a]), 1)

    async def test_clarify_becomes_a_question(self) -> None:
        r = await self.rx()
        self.band.say("pharmacist", self.verdict(r, "clarify", reason="Is the patient breastfeeding?"))
        await self.until(lambda: self.events("question"), "question")
        self.hub.answer(self.enc, r.ref, "No")
        await self.until(lambda: self.band.requests("safety_question"), "answered")
        self.band.say("pharmacist", self.verdict(r, "release"))
        await self.until(lambda: r.status == "done", "done")


class Faculty(HubCase):
    async def test_hold_then_human_approval_releases(self) -> None:
        r = await self.held()
        self.assertEqual(self.applies(), [])
        await self.with_faculty(r)
        text = self.band.plain()[-1]
        self.assertIn("approve or deny", text)
        self.assertIn("penicillin allergy", text)
        self.assertNotIn("Ravi", " ".join(self.band.plain()))
        self.assertNotIn("handoff", text)
        self.band.human("Approve, childhood rash only")  # "only" is a condition word: not plain enough
        await self.until(lambda: any("approve or deny" in t and "can't take that" in t for t in self.band.plain()), "asked again")
        self.assertEqual(r.status, "held")
        self.band.owner["online"] = True
        self.band.human("Approved, go ahead")
        await self.until(lambda: r.status == "overridden", "overridden")
        self.assertEqual(self.applies(), [{"ref": r.ref, "addPrescription": {"medicationId": "amox", "dose": "500 mg three times a day", "duration": "7 days"}}])
        acts = [e["faculty"]["action"] for e in self.events("faculty")]
        self.assertEqual([a for a in acts if a in ("invited", "joined", "approve")], ["invited", "joined", "approve"])
        self.assertTrue(any("Dr Darshan has approved" in s["text"] for s in self.spoken()))
        await self.until(lambda: any("despite the hold" in t for t in self.band.plain()), "pharmacy told")

    async def test_denial_keeps_it_held_and_removes_an_active_drug(self) -> None:
        r = await self.held()
        await self.with_faculty(r)
        self.band.human("Do not give it")
        await self.until(lambda: any(e["faculty"]["action"] == "deny" for e in self.events("faculty")), "deny")
        self.assertEqual((r.status, self.applies()), ("held", []))
        r2 = await self.rx(mid="azithromycin-500", name="Azithromycin 500mg")
        self.band.say("pharmacist", self.verdict(r2, "release"))
        await self.until(lambda: r2.active, "active")
        self.band.human("stop the azithromycin")
        await self.until(lambda: not r2.active, "stopped")
        self.assertEqual(self.applies()[-1]["removePrescription"]["medicationId"], "azithromycin-500")

    async def test_ambiguous_words_never_approve(self) -> None:
        r = await self.held()
        await self.with_faculty(r)
        self.ask_llm.side_effect = None
        self.ask_llm.return_value = {"intent": "approve", "confidence": 0.7}
        for t in ("ok", "yes", "haan", "ठीक है", "Approve only if the eGFR is above 60", "give half the dose", "approve after a skin test",
                  "Should we approve it?", "Approve azithromycin", "give azithromycin", "maybe", "I think she can have it",
                  "अनुमति नहीं है", "ध्यान दीजिए", "Good work team"):
            self.band.human(t)
        await asyncio.sleep(0.5)
        self.assertEqual((r.status, self.applies()), ("held", []))

    async def test_two_holds_need_a_named_drug(self) -> None:
        r = await self.held()
        r2 = await self.rx(mid="asp", name="Aspirin 100mg")
        self.band.say("pharmacist", self.verdict(r2, "hold"))
        await self.until(lambda: r2.status == "held", "held")
        await self.with_faculty(r)
        await self.with_faculty(r2)
        self.band.human("approve")
        await self.until(lambda: any("name the drug" in t for t in self.band.plain()), "asked which")
        self.assertEqual(self.applies(), [])
        self.band.human("एस्पिरिन दे दीजिए")
        await asyncio.sleep(0.1)
        self.band.human("approve aspirin")
        await self.until(lambda: r2.status == "overridden", "aspirin")
        self.assertEqual(r.status, "held")

    async def test_only_people_of_this_room_count(self) -> None:
        r = await self.held()
        await self.with_faculty(r)
        self.band.human("approve", sender={"id": "other-user", "name": "Someone Else", "type": "User"})
        self.band.say("pharmacist", Handoff("note", "verify_rx", r.ref, "enc-1", data={}), text="approve")
        await asyncio.sleep(0.2)
        self.assertEqual(r.status, "held")

    async def test_approval_mentioning_the_pharmacist_is_seen_in_the_poll(self) -> None:
        r = await self.held()
        await self.with_faculty(r)
        self.band.human("approve", to="pharmacist")  # Asha never receives this one
        await self.until(lambda: r.status == "overridden", "overridden")

    async def test_question_is_spoken_and_the_doctors_reply_goes_back(self) -> None:
        await self.hub.invite_faculty(self.enc, "second opinion")
        await self.hub._ensure_participant(self.enc, "lab", "x")
        self.band.human("What is her troponin?")
        await self.until(lambda: self.enc.awaiting_faculty, "awaiting")
        await self.until(lambda: any("Dr Darshan asks: What is her troponin?" in s["text"] for s in self.spoken()), "spoken")
        self.assertTrue(await self.hub.faculty_say(self.enc, "It is pending"))
        self.assertFalse(self.enc.awaiting_faculty)
        self.assertEqual(self.band.plain()[-1], "The doctor says: It is pending")
        self.band.human("Thanks, keep going", to="lab")  # between them and the lab: not for the bedside
        await self.until(lambda: any(e["faculty"]["action"] == "message" for e in self.events("faculty")), "message")

    async def test_invite_brief_has_no_name_and_no_block(self) -> None:
        out = await self.hub.invite_faculty(self.enc, "help with Ravi Kumar please")
        self.assertTrue(out["url"].endswith(f"/rooms/{self.band.room_id}"))
        self.assertNotIn("Ravi", self.band.plain()[-1])
        self.assertIn("45 year old man", self.band.plain()[-1])
        self.assertEqual(self.band.room["messages"][-1]["metadata"]["mentions"], [{"id": self.band.owner["id"]}])
        with self.assertRaises(band_client.BandError):
            self.band.down = True
            await self.hub.faculty_say(self.enc, "hello")


class PhoneFaculty(HubCase):
    """Faculty invited by phone (Twilio link): decide from MedSim's page, Asha records it in BAND."""

    TOKEN = "t" * 32

    def thoughts(self) -> list[str]:
        return [m["content"] for room in self.band.rooms.values() for m in room["messages"] if m["message_type"] == "thought"]

    async def guest(self):
        g = self.hub.add_guest(self.enc, "Dr Meena Rao", self.TOKEN)
        self.hub.guest_join(self.enc, g)
        return g

    async def test_link_lets_them_approve_and_band_has_the_record(self) -> None:
        r = await self.held()
        g = await self.guest()
        self.assertEqual(self.hub.guest(self.TOKEN), (self.enc, g))
        self.assertIsNone(self.hub.guest("x" * 32))
        await self.hub.request_override(self.enc, r.ref, "rash was 20 years ago")
        self.assertIsNone(self.enc.participant("faculty"))  # the BAND owner was not pulled in
        view = self.hub.guest_view(self.enc, g)
        self.assertEqual([(h["ref"], h["asked"]) for h in view["holds"]], [(r.ref, True)])
        self.assertIn("approve or deny", view["inbox"][-1]["text"].lower())
        out = await self.hub.guest_act(self.enc, g, "approve", r.ref)
        self.assertTrue(out["ok"])
        self.assertEqual(r.status, "overridden")
        self.assertEqual(self.applies()[-1]["addPrescription"]["medicationId"], "amox")
        acts = [e["faculty"]["action"] for e in self.events("faculty")]
        self.assertEqual([a for a in acts if a in ("invited", "joined", "approve")], ["invited", "joined", "approve"])
        await self.until(lambda: any("by phone) approved Amoxicillin" in t for t in self.thoughts()), "recorded in BAND")
        await self.until(lambda: any("despite the hold" in t for t in self.band.plain()), "pharmacy told")
        self.assertFalse((await self.hub.guest_act(self.enc, g, "approve", r.ref))["ok"])  # decided already

    async def test_deny_and_typed_ok_never_approves(self) -> None:
        r = await self.held()
        g = await self.guest()
        await self.hub.request_override(self.enc, r.ref)
        for t in ("ok", "haan", "maybe"):
            self.assertTrue((await self.hub.guest_act(self.enc, g, "say", text=t))["ok"])
        self.assertEqual((r.status, self.applies()), ("held", []))
        await self.until(lambda: any("can't take that" in m["text"] for m in g["inbox"]), "asked again on the page")
        self.assertTrue((await self.hub.guest_act(self.enc, g, "deny", r.ref))["ok"])
        self.assertEqual((r.status, self.applies()), ("held", []))
        self.assertTrue(any(e["faculty"]["action"] == "deny" for e in self.events("faculty")))

    async def test_questions_and_the_doctors_reply_reach_the_page(self) -> None:
        g = await self.guest()
        self.assertTrue((await self.hub.guest_act(self.enc, g, "say", text="What is his troponin?"))["ok"])
        await self.until(lambda: self.enc.awaiting_faculty, "awaiting")
        self.assertTrue(self.hub.guest_view(self.enc, g)["waitingForDoctor"])
        self.assertTrue(await self.hub.faculty_say(self.enc, "It is pending"))
        self.assertEqual(g["inbox"][-1], {**g["inbox"][-1], "from": "doctor", "text": "It is pending"})
        self.assertIsNone(self.enc.participant("faculty"))
        self.assertFalse(self.hub.guest_view(self.enc, g)["waitingForDoctor"])

    async def test_closed_or_unknown_ref_does_nothing(self) -> None:
        g = await self.guest()
        self.assertFalse((await self.hub.guest_act(self.enc, g, "approve", "rx_nope"))["ok"])
        self.hub.close(self.enc)
        self.assertFalse((await self.hub.guest_act(self.enc, g, "say", text="hello"))["ok"])


class Osce(HubCase):
    osce = True

    async def test_nothing_that_could_hint_is_spoken(self) -> None:
        r = await self.rx()
        self.band.say("pharmacist", self.verdict(r, "hold", spoken="Penicillin allergy, use azithromycin instead.",
                                                 suggestion={"medicationId": "azithromycin-500", "name": "Azithromycin", "dose": "500 mg"}))
        await self.until(lambda: self.spoken(), "spoken")
        self.assertIn("holding Amoxicillin", self.spoken()[0]["text"])
        self.assertNotIn("azithro", self.spoken()[0]["text"].lower())
        self.assertNotIn("penicillin", self.spoken()[0]["text"].lower())
        self.assertTrue(self.band.requests("verify_rx")[0][1].data["osce"])
        self.assertEqual(self.enc.tally.get("suggestionsOffered"), None)


class Hindi(HubCase):
    lang = "hi"

    async def test_department_words_only_in_the_session_language(self) -> None:
        r = await self.rx()
        self.band.say("pharmacist", self.verdict(r, "hold", spoken="Holding it."))  # English `spoken` in a Hindi session
        await self.until(lambda: self.spoken(), "spoken")
        self.assertTrue(bedside.in_language(self.spoken()[0]["text"], "hi"))
        self.assertEqual(self.spoken()[0]["lang"], "hi")
        self.assertNotIn("Documented", self.spoken()[0]["text"])  # no translation available: the template alone
        await self.with_faculty(r)
        self.band.human("दे दीजिए")
        await self.until(lambda: r.status == "overridden", "overridden")


class Closing(HubCase):
    async def test_faculty_question_and_the_doctors_reply_are_on_record(self) -> None:
        await self.hub.invite_faculty(self.enc, "")
        self.band.human("what is the CURB-65 score and why?")
        await self.until(lambda: self.enc.faculty_asks, "question noted")
        self.assertEqual((self.hub.counts(self.enc)["facultyQuestions"], self.hub.counts(self.enc)["facultyAnswered"]), (1, 0))
        await self.hub.faculty_say(self.enc, "CURB-65 is 0 sir: no confusion, RR 20")
        c = self.hub.counts(self.enc)
        self.assertEqual((c["facultyQuestions"], c["facultyAnswered"], len(c["facultyAnswerSeconds"])), (1, 1, 1))
        what = [t["what"] for t in self.enc.timeline]
        self.assertTrue(any("asked the doctor: what is the CURB-65" in w for w in what))
        self.assertTrue(any(w.startswith("Answered the question from") and w.endswith("seconds") for w in what))

    async def test_overrides_are_counted_with_and_without_a_reason(self) -> None:
        r = await self.held()
        await self.hub.request_override(self.enc, r.ref, "")
        c = self.hub.counts(self.enc)
        self.assertEqual((c["overridesWithReason"], c["overridesWithoutReason"]), (0, 1))
        await self.hub.request_override(self.enc, r.ref, "she took it last year without a rash")
        c = self.hub.counts(self.enc)
        self.assertEqual((c["overridesWithReason"], c["overridesWithoutReason"]), (1, 0))

    async def test_close_asks_the_examiner_and_the_human_signs_off(self) -> None:
        r = await self.held()
        await self.with_faculty(r)
        self.band.human("deny")
        await self.until(lambda: self.enc.tally.get("overridesDenied"), "denied")
        ref = self.hub.close(self.enc, {"history": 12, "patientName": "Ravi Kumar", "note": "Ravi was fine"})
        self.assertEqual(self.hub.close(self.enc, {}), ref)
        await self.until(lambda: self.band.requests("score_teamwork"), "asked")
        h = self.band.requests("score_teamwork")[0][1]
        self.assertEqual((h.data["counts"]["holds"], h.data["counts"]["overridesRequested"], h.data["counts"]["overridesDenied"]), (1, 1, 1))
        self.assertTrue(h.data["facultyInRoom"])
        self.assertEqual(h.data["facultyId"], self.band.owner["id"])
        self.assertEqual(h.data["clientSummary"], {"history": 12, "note": "the patient was fine"})
        self.assertNotIn("Ravi", json.dumps(h.data))
        score = lambda st: Handoff("score", "score_teamwork", ref, "enc-1", data={  # noqa: E731
            "status": st, "total": 130, "domains": [{"name": "Escalation", "score": 30, "max": 25, "note": "n"}],
            "strengths": ["s", 3], "improvements": [], "signedBy": "Dr D"})
        self.band.say("examiner", score("signed_off"))  # nobody signed yet
        await self.until(lambda: self.events("score"), "score")
        s = self.events("score")[-1]["score"]
        self.assertEqual((s["status"], s["total"], s["domains"][0]["score"]), ("awaiting_signoff", 100, 25))
        self.assertNotIn("signedBy", s)
        self.assertIsNone(self.hub.active("enc-1"))
        self.band.human("Signed off, fair marking", to="examiner")
        self.band.say("examiner", score("signed_off"))
        await self.until(lambda: self.enc.score_final, "final")
        self.assertEqual(self.events("score")[-1]["score"]["signedBy"], "Dr D")
        await self.until(lambda: self.enc.loop_task.done(), "polling stops")

    async def test_close_without_a_room_needs_no_examiner(self) -> None:
        self.assertIsNone(self.hub.close(self.enc, {}))
        self.assertEqual(self.band.rooms, {})
        self.assertIsNone(self.hub.active("enc-1"))


class Stream(HubCase):
    async def read(self, after: int, n: int) -> list[dict]:
        out: list[dict] = []
        gen = self.hub.stream(self.enc, after)

        async def go() -> None:
            async for frame in gen:
                for ln in frame.splitlines():
                    if ln.startswith("data: "):
                        out.append(json.loads(ln[6:]))
                if len(out) >= n:
                    return

        try:
            await asyncio.wait_for(go(), 1.0)
        except asyncio.TimeoutError:
            pass
        await gen.aclose()
        return out

    async def test_replay_upsert_and_stale_speech(self) -> None:
        r = await self.held()
        await self.until(lambda: self.spoken(), "spoken")
        full = await self.read(0, 500)
        self.assertEqual([e["seq"] for e in full], sorted(e["seq"] for e in full))
        self.assertEqual(len([e for e in full if e["type"] == "delegation"]), 1)  # only the latest state of a ref
        self.assertEqual([e["delegation"]["status"] for e in full if e["type"] == "delegation"], ["held"])
        self.assertTrue(any(e["type"] == "speak" for e in full))
        last = full[-1]["seq"]
        self.assertEqual(await self.read(last, 1), [])
        self.hub.emit(self.enc, "faculty", faculty={"action": "note", "name": "x", "text": "y"})
        self.assertEqual([e["seq"] for e in await self.read(last, 1)], [last + 1])
        self.assertEqual(len(await self.read(9999, 3)), 3)  # a cursor from before a restart
        with mock.patch.object(hubmod, "STALE_SPEAK_S", -1.0):
            self.assertFalse(any(e["type"] == "speak" for e in await self.read(0, 500)))
        self.assertEqual(r.status, "held")

    async def test_keepalive_and_bounds(self) -> None:
        with mock.patch.object(hubmod, "KEEPALIVE_S", 0.02):
            gen = self.hub.stream(self.enc, self.enc.seq)
            frames = [await asyncio.wait_for(gen.__anext__(), 1) for _ in range(2)]
            while ": keepalive\n\n" not in frames and len(frames) < 10:
                frames.append(await asyncio.wait_for(gen.__anext__(), 1))
            await gen.aclose()
        self.assertIn(": keepalive\n\n", frames)
        self.assertEqual(self.enc.waiters, set())
        for i in range(hubmod.MAX_EVENTS + 50):
            self.hub.emit(self.enc, "faculty", faculty={"action": "note", "name": "x", "text": str(i)})
        self.hub.emit(self.enc, "apply", apply={"ref": "x"})
        self.assertLessEqual(len(self.enc.events), hubmod.MAX_EVENTS)
        for i in range(hubmod.MAX_ENCOUNTERS + 5):
            self.hub.open(f"e{i}", "c", "en", False, {"name": "x"})
        self.assertLessEqual(len(self.hub.encounters), hubmod.MAX_ENCOUNTERS)

    async def test_ttl(self) -> None:
        with mock.patch.object(hubmod, "_now", lambda: self.enc.touched + hubmod.TTL_S + 5):
            self.hub.open("fresh", "c", "en", False, {})
        self.assertIsNone(self.hub.get("enc-1"))


class AshaTurn(HubCase):
    async def test_every_turn_ends_with_no_reply_and_is_deduped(self) -> None:
        from collections import OrderedDict

        r = await self.rx()
        m = self.band.say("pharmacist", self.verdict(r, "hold"))
        msg = SimpleNamespace(id=m["id"], sender_id=m["sender_id"], sender_type="Agent", sender_name="Pharmacist Meera",
                              content=m["content"].replace(f"@[[{self.band.ids['nurse']}]]", "@acct/nurse-asha"), message_type="text", metadata={}, created_at=None)
        tools = SimpleNamespace(no_reply=mock.AsyncMock())
        seen: OrderedDict = OrderedDict()
        await asha.handle_message(self.hub, seen, msg, tools, self.band.room_id)
        self.assertEqual(r.status, "held")
        await asha.handle_message(self.hub, seen, msg, tools, self.band.room_id)
        await asha.handle_message(self.hub, seen, SimpleNamespace(id="zz", content="x"), tools, "unknown-room")
        self.assertEqual(tools.no_reply.await_count, 3)
        shown = next(e["message"] for e in self.events("message") if e["message"]["id"] == m["id"])
        self.assertEqual((shown["text"], shown["to"]), ("here it is", ["nurse"]))


class RedFlag(HubCase):
    async def test_new_room_with_the_human_and_pharmacy_only_for_a_drug(self) -> None:
        snap = {"patientName": "Ravi Kumar", "age": 45, "gender": "M", "prescriptions": [{"name": "Amoxicillin 500mg", "dose": "TDS"}]}
        self.hub.red_flag("rash after the tablet", "urgent", snap)
        await asyncio.sleep(0.05)
        self.assertEqual(self.band.rooms, {})  # never from a process whose server is not running
        self.hub.started = True
        self.hub.red_flag("Ravi has a rash after the tablet", "urgent", snap)
        await self.until(lambda: self.band.requests("ask"), "pharmacy asked")
        self.assertEqual([p["name"] for p in self.band.room["people"]], ["Nurse Asha", "Darshan Krishna N", "Pharmacist Meera"])
        self.assertTrue(self.band.room["title"].startswith("Follow-up red flag"))
        self.assertNotIn("Ravi", json.dumps(self.band.room["messages"]))
        self.hub.red_flag("chest pain", "emergency", {**snap, "prescriptions": [{"name": "Paracetamol"}]})
        await self.until(lambda: len(self.band.rooms) == 2, "second room")
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.band.requests("ask")), 1)
        self.band.down = True
        self.hub.red_flag("bleeding", "urgent", snap)  # an outage is silent
        await asyncio.sleep(0.05)


class ClientBackoff(unittest.IsolatedAsyncioTestCase):
    async def test_429_is_retried_and_posts_are_never_repeated_after_a_read_timeout(self) -> None:
        import httpx

        seen: list[str] = []
        replies = [httpx.Response(429, headers={"retry-after": "1"}), httpx.Response(503), httpx.Response(200, json={"data": {"id": "x"}})]

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append(req.url.path)
            if req.url.path.endswith("/messages"):
                raise httpx.ReadTimeout("slow")
            return replies.pop(0)

        slept: list[float] = []
        with mock.patch.object(band_client, "_sleep", mock.AsyncMock(side_effect=lambda s: slept.append(s))):
            c = band_client.BandClient("nurse", "k", transport=httpx.MockTransport(handler))
            self.assertEqual(await c.me(), {"id": "x"})
            self.assertEqual(len(slept), 2)
            self.assertGreaterEqual(slept[0], 0.85)
            with self.assertRaises(band_client.BandError):
                await c.send_message("r", "hi", [])
            await c.aclose()
        self.assertEqual(len([p for p in seen if p.endswith("/messages")]), 1)

    async def test_client_errors_are_not_retried(self) -> None:
        import httpx

        n = []
        c = band_client.BandClient("nurse", "k", transport=httpx.MockTransport(lambda r: (n.append(1), httpx.Response(404))[1]))
        with self.assertRaises(band_client.BandError) as e:
            await c.participants("gone")
        self.assertEqual((e.exception.status, len(n)), (404, 1))
        await c.aclose()


class FacultyRules(unittest.TestCase):
    def test_table(self) -> None:
        want = {
            "approve": ["Approve", "Approved, go ahead", "ok give it", "yes release amoxicillin", "fine to give it", "You may give it",
                        "दे दीजिए", "haan de do", "ಸರಿ, ಕೊಡಬಹುದು", "கொடுக்கலாம்", "ఇవ్వండి", "द्या", "দিয়ে দিন", "No problem, approved"],
            "deny": ["Deny", "Do not give it", "Hold it", "keep it on hold", "not approved", "Please don't release it", "मत दीजिए",
                     "ಕೊಡಬೇಡಿ", "வேண்டாம்", "వద్దు", "देऊ नका", "দেবেন না"],
            "question": ["Why amoxicillin?", "Should we approve?", "Approve? Did you check the BP?", "What is her renal function"],
            "unclear": ["ok", "yes", "ठीक है", "👍", "Approve only if eGFR is above 60", "approve after a skin test", "अनुमति नहीं है"],
        }
        for intent, texts in want.items():
            for t in texts:
                self.assertEqual(faculty.classify_rules(t, ["Amoxicillin 500mg"]), intent, t)
        for t in ("Give a detailed history", "proceed to the next patient", "ध्यान दीजिए", "দুই দিন অপেক্ষা করুন", "release the report"):
            self.assertNotEqual(faculty.classify_rules(t, ["Amoxicillin 500mg"]), "approve", t)

    def test_llm_fallback_is_bounded(self) -> None:
        async def slow(_):
            await asyncio.sleep(5)

        with mock.patch.object(faculty, "_ask_llm", slow), mock.patch.object(faculty, "LLM_TIMEOUT_S", 0.02):
            self.assertEqual(asyncio.run(faculty.classify("the kidneys look fine to me today")), "note")
        with mock.patch.object(faculty, "_ask_llm", mock.AsyncMock(return_value={"intent": "approve", "confidence": 0.95})):
            self.assertEqual(asyncio.run(faculty.classify("she can have the drug")), "approve")
            self.assertEqual(asyncio.run(faculty.classify("she can have the drug if needed")), "unclear")
            self.assertEqual(asyncio.run(faculty.classify("she can not have the drug")), "unclear")


class Bedside(unittest.TestCase):
    def test_all_templates_in_all_languages(self) -> None:
        import lang as langmod

        for key, by in bedside.T.items():
            self.assertEqual(set(by), set(langmod.LANGS), key)
            for lg in langmod.LANGS:
                out = bedside.line(key, lg, dept="D", item="I", items="X", text="T", name="N")
                self.assertNotIn("{", out)
                self.assertNotIn("—", out)
                if lg != "en" and key != "answer":
                    self.assertTrue(langmod.has_script(out, lg), (key, lg))
        for role, by in bedside.DEPARTMENTS.items():
            self.assertEqual(set(by), set(langmod.LANGS), role)

    def test_nothing_raw_is_spoken(self) -> None:
        out = bedside.clean_spoken('**Hold** rx_4f2a91 {"a": 1} ```handoff\n{}\n``` see https://x.y @acct/nurse-asha '
                                   "@[[00000000-0000-4000-8000-000000000001]] — ok")
        self.assertEqual(out, "Hold see, ok")


if __name__ == "__main__":
    unittest.main()
