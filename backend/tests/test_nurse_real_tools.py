"""Nurse agent wiring for the real-world tools: drug databases, calendar, FHIR, send to patient."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import nurse  # noqa: E402
from integrations import drugsafety, fhir, notify  # noqa: E402


def req(**kw):
    base = dict(
        caseId="im-x", utterance="start warfarin",
        patient={"name": "Ravi Kumar", "age": 60, "gender": "M", "allergies": "none"},
        catalog={"tests": [{"id": "cbc", "name": "Complete Blood Count", "category": "lab"}],
                 "medications": [{"id": "warfarin-5", "name": "Warfarin 5mg", "dosing": "5 mg OD"}]},
    )
    base.update(kw)
    return nurse.NurseActRequest(**base)


class RealDrugCheck(unittest.TestCase):
    def test_source_backed_allergy_blocks_prescribe(self):
        st = nurse.NurseState(req())
        ext = {"ok": True, "drug": "warfarin", "rxcui": "11289", "classes": ["Vitamin K antagonists"],
               "allergyConflict": "Warfarin is in the Vitamin K antagonists class; patient allergy: warfarin",
               "interactions": [{"with": "aspirin", "excerpt": "aspirin increases bleeding risk"}],
               "boxedWarning": "BLEEDING RISK", "sources": [{"name": "openFDA drug label", "url": "u"}]}
        with mock.patch.object(drugsafety, "check_drug", mock.AsyncMock(return_value=ext)):
            res = asyncio.run(st.aexecute("check_allergies_and_interactions", {"medicationId": "warfarin-5"}))
        self.assertFalse(res["safe"])
        self.assertTrue(res["realCheck"]["ok"])
        self.assertTrue(any("FDA label" in w for w in res["warnings"]))
        rx = st.execute("prescribe", {"medicationId": "warfarin-5", "dose": "5 mg", "duration": "1 month"})
        self.assertTrue(rx.get("refused"))

    def test_database_outage_falls_back_to_catalogue(self):
        st = nurse.NurseState(req())
        with mock.patch.object(drugsafety, "check_drug", mock.AsyncMock(return_value={"ok": False, "error": "x"})):
            res = asyncio.run(st.aexecute("check_allergies_and_interactions", {"medicationId": "warfarin-5"}))
        self.assertTrue(res["safe"])
        self.assertFalse(res["realCheck"]["ok"])


class FollowUpAndSend(unittest.TestCase):
    def test_follow_up_gets_calendar_invite(self):
        st = nurse.NurseState(req())
        res = asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 7, "reason": "INR check"}))
        self.assertIn("calendar.google.com", res["calendar"]["googleCalendarUrl"])
        self.assertTrue(st.follow_up["icsPath"].startswith("/rx/calendar/"))

    def test_send_needs_contact(self):
        st = nurse.NurseState(req())
        res = asyncio.run(st.aexecute("send_to_patient", {"channel": "auto"}))
        self.assertFalse(res["ok"])
        self.assertIn("phone or email", res["error"])

    def test_send_uses_chart_prescriptions(self):
        st = nurse.NurseState(req(contact="+919876543210", doctorName="Dr. Test",
                                  prescriptionsSoFar=[{"medicationId": "warfarin-5", "dose": "5 mg OD", "duration": "1 month"}]))
        sent = mock.AsyncMock(return_value={"ok": True, "channel": "whatsapp", "to": "+91******3210"})
        with mock.patch("rx_audio.generate_script", mock.AsyncMock(return_value="script")), \
             mock.patch("rx_audio.synthesize", mock.AsyncMock(return_value=(b"mp3", "v", "en-IN"))), \
             mock.patch.object(notify, "send_to_patient", sent):
            res = asyncio.run(st.aexecute("send_to_patient", {"channel": "whatsapp"}))
        self.assertTrue(res["ok"])
        self.assertEqual(res["medications"], ["Warfarin 5mg"])
        message = sent.await_args.args[2]
        self.assertIn("Warfarin 5mg", message)
        self.assertIn("Dr. Test", message)


class EhrStep(unittest.TestCase):
    def test_orders_are_recorded_as_a_step(self):
        st = nurse.NurseState(req())
        st.execute("order_test", {"testId": "cbc"})
        steps = []
        rec = [{"ok": True, "resourceType": "ServiceRequest", "id": "42", "url": "https://hapi/ServiceRequest/42"}]
        with mock.patch.object(fhir, "record_batch", mock.AsyncMock(return_value=rec)):
            asyncio.run(nurse._record_to_ehr(req(), st, steps))
        self.assertEqual(steps[-1]["tool"], "record_to_ehr")
        self.assertIn("ServiceRequest/42", steps[-1]["summary"])

    def test_nothing_new_writes_nothing(self):
        steps = []
        asyncio.run(nurse._record_to_ehr(req(), nurse.NurseState(req()), steps))
        self.assertEqual(steps, [])


if __name__ == "__main__":
    unittest.main()
