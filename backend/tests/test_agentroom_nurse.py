"""Nurse Asha with and without the agent room: delegation, stop/cancel, clarify, dedupe. No network."""

from __future__ import annotations

import asyncio
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

import nurse  # noqa: E402
from agentroom import bedside, hub as hubmod, routes  # noqa: E402
from agentroom.protocol import Handoff  # noqa: E402
from fake_band import FakeBand  # noqa: E402

CATALOG = {"tests": [{"id": "cbc", "name": "CBC", "category": "lab"}, {"id": "ecg", "name": "ECG", "category": "bedside"},
                     {"id": "cxr", "name": "Chest X-Ray", "category": "imaging"}],
           "medications": [{"id": "amoxicillin-clavulanate-1g", "name": "Amoxicillin/Clavulanate 1g", "dosing": "1 tab twice a day"},
                           {"id": "azithromycin-500", "name": "Azithromycin 500mg", "dosing": "500 mg once daily"},
                           {"id": "paracetamol-500", "name": "Paracetamol 500mg", "dosing": "1 tab SOS"}]}
PATIENT = {"name": "Ravi Kumar", "age": 45, "gender": "M", "chiefComplaint": "cough", "allergies": "Yes, penicillin.", "anamnesis": []}
AMOX = "amoxicillin-clavulanate-1g"


def req(**kw) -> nurse.NurseActRequest:
    return nurse.NurseActRequest(**{"caseId": "im-005", "utterance": "Asha, order a CBC", "patient": PATIENT, "catalog": CATALOG, **kw})


def script(*turns):
    """A fake chat(): each turn is a list of (tool, args) calls, or the closing text."""
    seq = list(turns)
    calls = []

    async def chat(messages, tools=None, **kw):
        calls.append({"messages": messages, "tools": [t["function"]["name"] for t in tools or []]})
        t = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(t, str):
            return {"content": t}, "sarvam"
        return {"content": "", "tool_calls": [{"id": f"c{i}", "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(t)]}, "sarvam"

    chat.calls = calls
    return chat


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        for p in (mock.patch.dict(os.environ, {"BAND_ASHA_API_KEY": "k"}),
                  mock.patch.object(nurse, "_record_to_ehr", mock.AsyncMock()),
                  mock.patch.object(hubmod, "POLL_BUSY_S", 0.02), mock.patch.object(hubmod, "COALESCE_S", 0.02),
                  mock.patch.object(bedside, "_llm_translate", mock.AsyncMock(side_effect=RuntimeError))):
            p.start()
            self.addCleanup(p.stop)
        self.band = FakeBand()
        self.hub = hubmod.Hub(client_for=self.band.client)
        for m in (hubmod, routes):
            p = mock.patch.object(m, "hub", self.hub)
            p.start()
            self.addCleanup(p.stop)
        self.hub.open("enc-1", "im-005", "en", False, dict(PATIENT))
        self.enc = self.hub.get("enc-1")
        nurse._recent.clear()

    async def asyncTearDown(self) -> None:
        await self.hub.stop()

    async def until(self, cond, what: str = "condition") -> None:
        for _ in range(300):
            if cond():
                return
            await asyncio.sleep(0.01)
        self.fail(f"timed out waiting for {what}")

    async def act(self, *turns, **kw):
        kw.setdefault("encounterId", "enc-1")
        chat = script(*turns)
        with mock.patch.object(nurse, "chat", chat):
            out = await nurse.nurse_act(req(**kw))
        out["_chat"] = chat
        return out


class RoomMode(Base):
    async def test_orders_are_delegated_not_executed(self) -> None:
        out = await self.act(
            [("find_in_catalog", {"query": "cbc", "kind": "test"})],
            [("order_test", {"testId": "cbc"}), ("order_test", {"testId": "ecg"}), ("order_test", {"testId": "cxr"}),
             ("prescribe", {"medicationId": AMOX, "dose": "1 g twice a day", "duration": "7 days"})],
            "Okay doctor, CBC and ECG are off to the lab, and I'm checking co-amoxiclav with pharmacy.",
            utterance="Asha, CBC, ECG, chest x-ray and start augmentin 1 g twice a day")
        self.assertEqual(out["intent"], "order")
        self.assertEqual(out["applied"]["prescriptions"], [])
        self.assertEqual(out["applied"]["orderedTestIds"], ["cbc", "ecg", "cxr"])
        self.assertEqual([(p["action"], p["target"], p.get("testIds"), p.get("medicationId")) for p in out["pending"]],
                         [("verify_rx", "pharmacist", None, AMOX), ("run_test", "lab", ["cbc", "ecg"], None), ("run_imaging", "radiology", ["cxr"], None)])
        self.assertIn("pharmacy", out["spokenConfirmation"])
        await self.until(lambda: len(self.band.requests()) == 3, "three messages")
        tools = out["_chat"].calls[0]["tools"]
        self.assertNotIn("check_allergies_and_interactions", tools)
        self.assertTrue(set(nurse.ROOM_TOOLS) <= set(tools))
        blob = json.dumps(out["steps"])
        self.assertNotIn("Within normal", blob)
        self.assertIn("result pending", blob)
        self.assertIn("verification", blob)
        # The server's own hard conflict rides along: a release cannot beat it.
        ref = next(r for r in self.enc.refs.values() if r.action == "verify_rx")
        self.assertTrue(ref.local_hard)
        self.assertEqual(ref.dose, "1 g twice a day")

    async def test_early_claims_are_replaced(self) -> None:
        out = await self.act([("prescribe", {"medicationId": "paracetamol-500", "dose": "1 tab", "duration": "3 days"})],
                             "Okay doctor, paracetamol is prescribed, one tablet. Anything else?", utterance="Asha give crocin")
        self.assertIn("checking Paracetamol", out["spokenConfirmation"])
        self.assertNotIn("prescribed, one", out["spokenConfirmation"])
        out = await self.act([("order_test", {"testId": "cbc"})], "CBC is done and it is normal, doctor.", utterance="Asha CBC please")
        self.assertIn("sent to the lab", out["spokenConfirmation"])
        out = await self.act([("prescribe", {"medicationId": "azithromycin-500", "dose": "500 mg", "duration": "3 days"})],
                             "ठीक है डॉक्टर, दे दिया।", utterance="azithral 500 de do", lang="hi")
        self.assertIn("फार्मेसी", out["spokenConfirmation"])

    async def test_held_drug_override_and_tools(self) -> None:
        await self.act([("prescribe", {"medicationId": AMOX, "dose": "1 g", "duration": "7 days"})], "checking with pharmacy", utterance="augmentin")
        ref = next(iter(self.enc.refs.values()))
        await self.until(lambda: ref.message_ids, "posted")
        self.band.say("pharmacist", Handoff("verdict", "verify_rx", ref.ref, "enc-1", data={"verdict": "hold", "medicationId": AMOX, "reason": "penicillin"}))
        await self.until(lambda: ref.status == "held", "held")
        out = await self.act([("prescribe", {"medicationId": AMOX, "dose": "1 g", "duration": "7 days"})],
                             [("request_override", {"medicationId": AMOX, "reason": "old rash"})], "I've asked faculty, doctor.",
                             utterance="give it anyway, ask the professor")
        self.assertFalse(out["steps"][0]["ok"])
        self.assertIn("on hold by pharmacy", out["steps"][0]["summary"])
        self.assertTrue(out["steps"][1]["ok"])
        self.assertTrue(ref.override_requested)
        self.assertEqual(out["pending"], [])
        out = await self.act([("ask_department", {"department": "pharmacy", "question": "what else?"}), ("message_faculty", {"text": "please see"}),
                              ("invite_faculty", {"reason": "help"}), ("message_faculty", {"text": "please see"})], "Asked.", utterance="ask pharmacy")
        self.assertTrue(all(s["ok"] for s in out["steps"]))
        self.assertEqual(sum("please see" in t for t in self.band.plain()), 1)  # a repeated call is not a second message
        self.band.down = True
        out = await self.act([("invite_faculty", {"reason": "x"})], "I could not reach them.", utterance="call faculty again")
        self.assertFalse(out["steps"][0]["ok"])
        self.band.down = False

    async def test_stop_and_cancel(self) -> None:
        await self.act([("order_test", {"testId": "cbc"}), ("order_test", {"testId": "ecg"}),
                        ("prescribe", {"medicationId": "paracetamol-500", "dose": "1 tab", "duration": "3 days"})], "checking with pharmacy", utterance="cbc ecg dolo")
        rx = next(r for r in self.enc.refs.values() if r.action == "verify_rx")
        lab = next(r for r in self.enc.refs.values() if r.action == "run_test")
        await self.until(lambda: rx.message_ids and lab.message_ids, "posted")
        out = await self.act([("cancel_test", {"testId": "ecg"}), ("stop_medication", {"medicationId": "paracetamol-500"})], "Cancelled both, doctor.",
                             utterance="cancel the ECG and the dolo", alreadyOrdered=["cbc", "ecg"])
        self.assertEqual(out["applied"]["cancelledTestIds"], ["ecg"])
        self.assertEqual((rx.status, lab.test_ids, lab.status), ("cancelled", ["cbc"], "sent"))
        self.assertEqual(out["spokenConfirmation"], "Cancelled both, doctor.")

    async def test_reorder_after_timeout_asks_again(self) -> None:
        with mock.patch.object(hubmod, "TIMEOUT_S", 0.03):
            await self.act([("order_test", {"testId": "cbc"})], "sent to the lab", utterance="cbc")
            ref = next(iter(self.enc.refs.values()))
            await self.until(lambda: ref.status == "timeout", "timeout")
        out = await self.act([("order_test", {"testId": "cbc"})], "asked the lab again", utterance="ask the lab again", alreadyOrdered=["cbc"])
        self.assertEqual(ref.status, "sent")
        self.assertEqual([p["ref"] for p in out["pending"]], [ref.ref])
        self.assertEqual(len(self.enc.refs), 1)

    async def test_band_down_never_breaks_the_nurse(self) -> None:
        self.band.down = True
        out = await self.act([("order_test", {"testId": "cbc"})], "CBC is sent to the lab.", utterance="cbc")
        self.assertEqual((out["intent"], out["applied"]["orderedTestIds"]), ("order", ["cbc"]))
        with mock.patch.object(self.hub, "delegate_tests", side_effect=RuntimeError("x")):
            out = await self.act([("order_test", {"testId": "ecg"})], "ECG sent to the lab.", utterance="ecg")
        self.assertEqual(out["intent"], "order")

    async def test_osce_never_substitutes(self) -> None:
        self.hub.open("enc-2", "im-005", "en", True, dict(PATIENT))
        out = await self.act([("prescribe", {"medicationId": "azithromycin-500", "dose": "500 mg", "duration": "3 days"})], "Which antibiotic, doctor?",
                             utterance="give an antibiotic", encounterId="enc-2")
        self.assertFalse(out["steps"][0]["ok"])
        self.assertIn("EXAM", out["_chat"].calls[0]["messages"][0]["content"])
        self.assertEqual(self.hub.get("enc-2").refs, {})

    async def test_not_sent_to_the_patient_before_release(self) -> None:
        out = await self.act([("prescribe", {"medicationId": "paracetamol-500", "dose": "1 tab", "duration": "3 days"}), ("send_to_patient", {"channel": "auto"})],
                             "checking with pharmacy", utterance="crocin and send it", contact="+919876543210")
        self.assertFalse(out["steps"][1]["ok"])
        self.assertIn("not released", out["steps"][1]["result"]["error"])


class Idempotency(Base):
    async def test_same_order_within_the_window_is_one_run(self) -> None:
        chat = script([("order_test", {"testId": "cbc"})], "CBC sent to the lab.")
        with mock.patch.object(nurse, "chat", chat):
            a, b = await asyncio.gather(nurse.nurse_act(req(encounterId="enc-1")), nurse.nurse_act(req(encounterId="enc-1", utterance="Asha,  order a CBC ")))
        self.assertEqual(a["runId"], b["runId"])
        self.assertEqual(len(self.enc.refs), 1)
        with mock.patch.object(nurse, "chat", script("NO_ORDER")), mock.patch.object(nurse, "DEDUPE_S", -1.0):
            c = await nurse.nurse_act(req(encounterId="enc-1"))
        self.assertNotEqual(c["runId"], a["runId"])


class Legacy(Base):
    async def test_no_keys_is_the_old_single_agent(self) -> None:
        os.environ.pop("BAND_ASHA_API_KEY")
        out = await self.act([("order_test", {"testId": "cbc"}), ("prescribe", {"medicationId": "paracetamol-500", "dose": "1 tab", "duration": "3 days"})],
                             "Okay doctor, CBC is sent and paracetamol is on.", utterance="cbc and crocin")
        self.assertEqual(out["applied"]["prescriptions"], [{"medicationId": "paracetamol-500", "dose": "1 tab", "duration": "3 days"}])
        self.assertEqual(out["pending"], [])
        self.assertEqual(out["spokenConfirmation"], "Okay doctor, CBC is sent and paracetamol is on.")
        self.assertIn("check_allergies_and_interactions", out["_chat"].calls[0]["tools"])
        self.assertNotIn("invite_faculty", out["_chat"].calls[0]["tools"])
        self.assertEqual(out["steps"][0]["summary"], "Ordered CBC: result pending, see chart")
        self.assertEqual(self.band.rooms, {})
        out = await self.act([("invite_faculty", {"reason": "x"})], "no", utterance="call faculty")
        self.assertFalse(out["steps"][0]["ok"])

    async def test_unregistered_encounter_is_legacy_too(self) -> None:
        out = await self.act([("order_test", {"testId": "cbc"})], "CBC is sent.", utterance="cbc", encounterId="nobody")
        self.assertEqual((out["pending"], out["applied"]["orderedTestIds"]), ([], ["cbc"]))

    async def test_allergy_still_refuses(self) -> None:
        out = await self.act([("prescribe", {"medicationId": AMOX, "dose": "1 g", "duration": "7 days"})], "Held, doctor.", utterance="augmentin", encounterId=None)
        self.assertTrue(out["steps"][0]["result"]["refused"])

    async def test_stop_and_cancel(self) -> None:
        out = await self.act([("stop_medication", {"medicationId": "paracetamol-500"}), ("cancel_test", {"testId": "cbc"}),
                              ("stop_medication", {"medicationId": "azithromycin-500"})], "Stopped.", utterance="stop the crocin, cancel CBC",
                             encounterId=None, alreadyPrescribed=["paracetamol-500"], alreadyOrdered=["cbc"])
        self.assertEqual((out["applied"]["stoppedMedicationIds"], out["applied"]["cancelledTestIds"]), (["paracetamol-500"], ["cbc"]))
        self.assertFalse(out["steps"][2]["ok"])

    async def test_clarify_is_spoken(self) -> None:
        out = await self.act("Which antibiotic would you like, doctor?", utterance="start the antibiotic", encounterId=None)
        self.assertEqual((out["intent"], out["spokenConfirmation"]), ("clarify", "Which antibiotic would you like, doctor?"))
        out = await self.act("Sure doctor, I'm here.", utterance="Nurse Asha, are you there", encounterId=None)
        self.assertEqual(out["intent"], "clarify")
        out = await self.act("NO_ORDER", utterance="how is the pain", encounterId=None)
        self.assertEqual((out["intent"], out["spokenConfirmation"]), ("none", ""))
        out = await self.act("The patient seems unwell.", utterance="how is the pain", encounterId=None)
        self.assertEqual(out["intent"], "none")


class Routes(Base):
    async def test_http_surface(self) -> None:
        import httpx
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(routes.router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            st = (await c.get("/agent/room/status")).json()
            self.assertTrue(st["enabled"])
            self.assertTrue(st["departments"]["pharmacist"])
            body = {"encounterId": "e-9", "caseId": "c", "lang": "hi-IN", "osce": True, "patient": {"name": "A", "age": 3, "gender": "F"}}
            self.assertEqual((await c.post("/agent/room/open", json=body)).json(), {"enabled": True})
            self.assertEqual((self.hub.get("e-9").lang, self.hub.get("e-9").osce), ("hi", True))
            self.assertEqual((await c.post("/agent/room/open", json={**body, "encounterId": "../x"})).status_code, 422)
            self.assertEqual((await c.get("/agent/room/unknown/stream")).status_code, 404)
            r = await c.post("/agent/room/e-9/ask", json={"target": "lab", "utterance": "when?", "lang": "en"})
            self.assertTrue(r.json()["ref"].startswith("ask_"))
            self.assertEqual((await c.post("/agent/room/e-9/ask", json={"target": "examiner", "utterance": "when?"})).status_code, 422)
            self.assertEqual((await c.post("/agent/room/e-9/answer", json={"ref": "rx_1", "text": "no"})).status_code, 409)
            self.assertEqual((await c.post("/agent/room/e-9/override", json={"ref": "rx_1"})).status_code, 409)
            self.assertEqual((await c.post("/agent/room/e-9/retry", json={"ref": "rx_1"})).status_code, 409)
            self.assertIn("/rooms/", (await c.post("/agent/room/e-9/faculty/invite", json={})).json()["url"])
            self.assertEqual((await c.post("/agent/room/e-9/faculty/say", json={"text": "hi"})).json(), {"ok": True})
            self.band.down = True
            self.assertEqual((await c.post("/agent/room/e-9/faculty/say", json={"text": "hi"})).status_code, 502)
            self.band.down = False
            self.assertTrue((await c.post("/agent/room/e-9/cancel", json={"ref": r.json()["ref"]})).json()["ok"])
            self.assertIn("ref", (await c.post("/agent/room/e-9/close", json={"summary": {"x": 1}})).json())
            self.assertEqual((await c.post("/agent/room/e-9/ask", json={"target": "lab", "utterance": "x"})).status_code, 404)
            os.environ.pop("BAND_ASHA_API_KEY")
            self.assertEqual((await c.post("/agent/room/open", json=body)).json()["enabled"], False)
            self.assertFalse((await c.get("/agent/room/status")).json()["enabled"])


if __name__ == "__main__":
    unittest.main()
