"""CBME logbook (Apps Script sheet) and the refer_patient nurse tool. No network."""

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import logbook  # noqa: E402
import nurse  # noqa: E402
import referral  # noqa: E402
from integrations import fhir, gcal_script, notify  # noqa: E402
import rx_audio  # noqa: E402

ENV = {"GCAL_SCRIPT_URL": "https://script.google.com/macros/s/abc/exec", "GCAL_SCRIPT_SECRET": "s3cret"}
NO_ENV = {"GCAL_SCRIPT_URL": "", "GCAL_SCRIPT_SECRET": ""}
EMDASH = chr(0x2014)


def factory_for(handler, seen=None):
    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handler(request)

    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=True)


def req(**kw):
    base = dict(
        caseId="card-1", utterance="refer to cardiology",
        patient={"name": "Ravi Kumar", "age": 60, "gender": "M", "chiefComplaint": "chest pain",
                 "allergies": "none", "vitals": {"hr": 110, "bp": "150/95", "spo2": 94},
                 "testResults": [{"testId": "ecg", "result": "ST elevation", "abnormal": True}]},
        catalog={"tests": [{"id": "ecg", "name": "ECG", "category": "cardiac"}],
                 "medications": [{"id": "asp", "name": "Aspirin", "dosing": "75 mg OD"}]},
        alreadyOrdered=["ecg"], alreadyPrescribed=["asp"],
        student="Dr Asha Rao", university="AIIMS", specialty="Cardiology", caseName="Chest pain 1",
        skills=["History taking", "ECG interpretation"],
    )
    base.update(kw)
    return nurse.NurseActRequest(**base)


class GcalActions(unittest.TestCase):
    def test_unconfigured_returns_none(self):
        with mock.patch.dict(os.environ, NO_ENV):
            self.assertIsNone(asyncio.run(gcal_script.append_logbook({"student": "x"})))
            self.assertIsNone(asyncio.run(gcal_script.create_referral({"patient": "x"})))

    def test_logbook_payload_and_redirect(self):
        seen = []

        def handler(request):
            if request.url.host == "script.google.com":
                return httpx.Response(302, headers={"location": "https://script.googleusercontent.com/macros/echo?x=1"})
            return httpx.Response(200, json={"ok": True, "sheetUrl": "https://docs.google.com/spreadsheets/d/1", "row": 2})

        with mock.patch.dict(os.environ, ENV), mock.patch.object(gcal_script, "_client_factory", factory_for(handler, seen)):
            out = asyncio.run(gcal_script.append_logbook({"student": "A"}))
        self.assertEqual(out["row"], 2)
        body = json.loads(seen[0].content)
        self.assertEqual((body["action"], body["secret"], body["row"]), ("logbook", "s3cret", {"student": "A"}))

    def test_referral_payload_and_failures_never_raise(self):
        seen = []
        ok = lambda r: httpx.Response(200, json={"ok": True, "docUrl": "d", "pdfUrl": "p"})  # noqa: E731
        with mock.patch.dict(os.environ, ENV), mock.patch.object(gcal_script, "_client_factory", factory_for(ok, seen)):
            out = asyncio.run(gcal_script.create_referral({"patient": "P", "specialty": "Cardiology"}))
        self.assertEqual(out["pdfUrl"], "p")
        self.assertEqual(json.loads(seen[0].content)["action"], "referral")

        def boom(request):
            raise httpx.ConnectError("x")

        with mock.patch.dict(os.environ, ENV):
            with mock.patch.object(gcal_script, "_client_factory", factory_for(boom)):
                self.assertIsNone(asyncio.run(gcal_script.append_logbook({})))
            with mock.patch.object(gcal_script, "_client_factory", factory_for(lambda r: httpx.Response(500))):
                self.assertIsNone(asyncio.run(gcal_script.create_referral({})))


class LogbookEndpoint(unittest.TestCase):
    def client(self):
        app = FastAPI()
        app.include_router(logbook.router)
        return TestClient(app)

    BODY = {"caseId": "c1", "caseName": "Chest pain", "specialty": "Cardiology", "patientName": "Ravi Kumar",
            "diagnosis": "STEMI", "skills": ["History", "ECG"], "tests": ["ECG"], "prescriptions": ["Aspirin"],
            "score": 81.6, "student": "Dr A", "university": "AIIMS",
            "facultyMarks": [{"examiner": "Dr B", "comment": "good", "scores": {"a": 4, "b": 5}}]}

    def test_row_shape(self):
        row = logbook.build_row(logbook.LogbookRequest(**self.BODY))
        self.assertEqual(row["skills"], "History; ECG")
        self.assertEqual(row["score"], 82)
        self.assertEqual(row["facultySignoff"], "Dr B (4.5/5): good")
        self.assertIn("SIMULATION, synthetic patient", row["notes"])
        self.assertRegex(row["date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_posts_row_and_returns_sheet_url(self):
        mocked = mock.AsyncMock(return_value={"ok": True, "sheetUrl": "https://sheet/1", "row": 5})
        with mock.patch.dict(os.environ, ENV), mock.patch.object(gcal_script, "append_logbook", mocked):
            r = self.client().post("/agent/logbook", json=self.BODY)
        self.assertEqual(r.json(), {"ok": True, "sheetUrl": "https://sheet/1", "row": 5})
        self.assertEqual(mocked.call_args.args[0]["university"], "AIIMS")

    def test_unconfigured_and_script_error(self):
        with mock.patch.dict(os.environ, NO_ENV):
            r = self.client().post("/agent/logbook", json=self.BODY)
        self.assertFalse(r.json()["ok"])
        self.assertIn("not configured", r.json()["error"])
        with mock.patch.dict(os.environ, ENV), mock.patch.object(
                gcal_script, "append_logbook", mock.AsyncMock(return_value={"ok": False, "error": "quota"})):
            r = self.client().post("/agent/logbook", json=self.BODY)
        self.assertEqual(r.json(), {"ok": False, "error": "quota"})


class FhirReferral(unittest.TestCase):
    def test_service_request_and_condition(self):
        posts = []

        def handler(request):
            body = json.loads(request.content)
            posts.append(body)
            return httpx.Response(201, json={**body, "id": f"id{len(posts)}"})

        factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))  # noqa: E731
        with mock.patch.object(fhir, "_client_factory", factory):
            rec = asyncio.run(fhir.record_referral("p1", "Cardiology", "emergency", "ST elevation", "STEMI", "note"))
        self.assertEqual([p["resourceType"] for p in posts], ["Condition", "ServiceRequest"])
        sr = posts[1]
        self.assertEqual(sr["category"][0]["text"], "referral")
        self.assertEqual(sr["priority"], "stat")
        self.assertEqual(sr["reasonReference"], [{"reference": "Condition/id1"}])
        self.assertIn("SIMULATION", sr["note"][0]["text"])
        self.assertEqual(rec["resourceType"], "ServiceRequest")
        self.assertEqual(rec["condition"]["id"], "id1")

    def test_no_condition_without_diagnosis(self):
        posts = []

        def handler(request):
            posts.append(json.loads(request.content))
            return httpx.Response(201, json={"id": "x"})

        with mock.patch.object(fhir, "_client_factory", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))):
            asyncio.run(fhir.record_referral("p1", "ENT", "weird", "reason"))
        self.assertEqual([p["resourceType"] for p in posts], ["ServiceRequest"])
        self.assertEqual(posts[0]["priority"], "routine")


class ReferralPipeline(unittest.TestCase):
    LLM = {"content": json.dumps({
        "situation": f"Ravi {EMDASH} 60M with chest pain.", "background": "HR 110.", "assessment": "Likely STEMI.",
        "recommendation": "Urgent review.", "voice": "Handover for cardiology, chest pain, ST elevation."})}

    def run_tool(self, args, env=None, llm=None, mp3=b"MP3", gcal=None, fhir_rec=None):
        st = nurse.NurseState(req())
        sent = mock.AsyncMock(return_value={"ok": True, "channel": "telegram"})
        patches = [
            mock.patch.dict(os.environ, env or NO_ENV),
            mock.patch("llm_provider.chat", mock.AsyncMock(side_effect=llm) if isinstance(llm, Exception)
                       else mock.AsyncMock(return_value=(llm or self.LLM, "sarvam"))),
            mock.patch.object(fhir, "ensure_patient", mock.AsyncMock(return_value="pid")),
            mock.patch.object(fhir, "record_referral", mock.AsyncMock(return_value=fhir_rec)),
            mock.patch.object(gcal_script, "create_referral", mock.AsyncMock(return_value=gcal)),
            mock.patch.object(rx_audio, "synthesize", mock.AsyncMock(return_value=(mp3, "v", "en-IN"))),
            mock.patch.object(notify, "store_audio", return_value="/rx/audio/tok.mp3"),
            mock.patch.object(notify, "absolute_url", side_effect=lambda p: "https://host" + p),
            mock.patch.object(notify, "send_to_patient", sent),
        ]
        for p in patches:
            p.start()
        try:
            res = asyncio.run(st.aexecute("refer_patient", args))
        finally:
            for p in patches:
                p.stop()
        return st, res, sent

    ARGS = {"specialty": "Cardiology", "urgency": "urgent", "reason": "ST elevation", "workingDiagnosis": "STEMI"}

    def test_full_pipeline(self):
        rec = {"ok": True, "resourceType": "ServiceRequest", "id": "42", "url": "https://fhir/ServiceRequest/42"}
        gcal = {"ok": True, "docUrl": "https://docs/d", "pdfUrl": "https://drive/pdf"}
        _, res, sent = self.run_tool(self.ARGS, gcal=gcal, fhir_rec=rec)
        self.assertTrue(res["ok"])
        self.assertEqual(res["pdfUrl"], "https://drive/pdf")
        self.assertEqual(res["fhir"]["id"], "42")
        self.assertEqual(res["audioUrl"], "https://host/rx/audio/tok.mp3")
        self.assertNotIn(EMDASH, json.dumps(res, ensure_ascii=False))
        self.assertIn("SIMULATION, synthetic patient", res["letter"])
        self.assertTrue(res["voiceScript"].lower().startswith("this is a simulation, synthetic patient"))
        sent.assert_not_called()  # no REFERRAL_DEST
        summary = nurse.summarize("refer_patient", self.ARGS, res)
        self.assertIn("Cardiology", summary)
        self.assertIn("referral PDF", summary)

    def test_everything_down_still_returns_letter(self):
        _, res, _ = self.run_tool(self.ARGS, llm=RuntimeError("llm down"), mp3=b"")
        self.assertTrue(res["ok"])
        self.assertIsNone(res["pdfUrl"])
        self.assertIsNone(res["fhir"])
        self.assertIn("Ravi Kumar", res["sbar"]["situation"])
        self.assertIn("ST elevation", res["sbar"]["assessment"] + res["sbar"]["situation"])
        self.assertIn("SIMULATION, synthetic patient", res["letter"])

    def test_delivery_to_consultant_when_dest_set(self):
        env = {**NO_ENV, "REFERRAL_DEST": "consultant@example.org"}
        _, res, sent = self.run_tool(self.ARGS, env=env, gcal={"ok": True, "docUrl": "d", "pdfUrl": "https://drive/pdf"})
        sent.assert_awaited_once()
        channel, dest, message = sent.await_args.args[:3]
        self.assertEqual(dest, "consultant@example.org")
        self.assertIn("SIMULATION, synthetic patient", message)
        self.assertIn("https://drive/pdf", message)
        self.assertEqual(sent.await_args.args[4], b"MP3")
        self.assertTrue(res["delivered"]["ok"])

    def test_missing_specialty_and_bad_urgency(self):
        _, res, _ = self.run_tool({"specialty": " ", "urgency": "routine", "reason": "x"})
        self.assertFalse(res["ok"])
        _, res, _ = self.run_tool({"specialty": "ENT", "urgency": "whenever", "reason": "x"})
        self.assertEqual(res["urgency"], "routine")

    def test_tool_registered(self):
        names = {s["function"]["name"] for s in nurse.TOOL_SPECS}
        self.assertTrue({"refer_patient", "log_case"} <= names)
        self.assertIn("refer_patient", nurse.SYSTEM_PROMPT)
        self.assertIn("log_case", nurse.SYSTEM_PROMPT)


class LogCaseTool(unittest.TestCase):
    def test_log_case_builds_row_from_encounter(self):
        st = nurse.NurseState(req())
        seen = {}

        async def fake(row):
            seen.update(row)
            return {"ok": True, "sheetUrl": "https://sheet/1", "row": 3}

        with mock.patch.object(gcal_script, "append_logbook", fake), mock.patch.dict(os.environ, ENV):
            res = asyncio.run(st.aexecute("log_case", {"diagnosis": "STEMI"}))
        self.assertTrue(res["ok"])
        self.assertEqual(res["sheetUrl"], "https://sheet/1")
        self.assertEqual(seen["student"], "Dr Asha Rao")
        self.assertEqual(seen["university"], "AIIMS")
        self.assertEqual(seen["specialty"], "Cardiology")
        self.assertEqual(seen["tests"], "ECG")
        self.assertEqual(seen["prescriptions"], "Aspirin")
        self.assertEqual(seen["skills"], "History taking; ECG interpretation")
        self.assertEqual(seen["diagnosis"], "STEMI")
        self.assertIn("logbook", nurse.summarize("log_case", {}, res).lower())

    def test_log_case_unconfigured(self):
        st = nurse.NurseState(req())
        with mock.patch.dict(os.environ, NO_ENV):
            res = asyncio.run(st.aexecute("log_case", {}))
        self.assertFalse(res["ok"])


if __name__ == "__main__":
    unittest.main()
