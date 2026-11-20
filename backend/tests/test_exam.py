"""Tests for the physical examination route (/agent/exam/perform). LLM mocked, no network."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402
import exam  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}
SECRET = "sarvam-key-exam-zz"


def _body(system: str = "resp", case_id: str = "pn-1", **over) -> dict:
    body = {
        "caseId": case_id,
        "system": system,
        "maneuver": "auscultate the chest",
        "patient": {
            "name": "Ravi Kumar", "age": 52, "gender": "M",
            "chiefComplaint": "Fever and cough with rusty sputum for 4 days",
            "anamnesis": [{"question": "Any chest pain?", "answer": "Right side, worse when I breathe in."}],
            "vitals": {"hr": 112, "bp": "118/74", "spo2": 91, "temp": 38.9, "rr": 26},
            "testResults": [{"testId": "cxr", "name": "Chest X-ray", "result": "Right lower lobe consolidation", "abnormal": True}],
        },
        "correctDiagnosis": "Community-acquired pneumonia",
        "lang": "en",
    }
    body.update(over)
    return body


PNEUMONIA = json.dumps({
    "findings": [
        {"label": "Inspection", "value": "Reduced chest movement on the right, RR 18/min", "abnormal": True},
        {"label": "Percussion", "value": "Dull note over the right base", "abnormal": True},
        {"label": "Auscultation", "value": "Bronchial breathing and coarse crackles at the right base, typical of pneumonia", "abnormal": True},
        {"label": "Vocal resonance", "value": "Increased at the right base", "abnormal": "true"},
    ],
    "summary": "Chest: dull note, bronchial breathing and crackles at the right base " + chr(0x2014) + " consolidation. Left side clear. Extra sentence.",
    "sound": "normal-breath",
})


class FakeChat:
    def __init__(self, contents=None, exc: Exception | None = None, delay: float = 0.0):
        self.contents = list(contents) if isinstance(contents, list) else [contents]
        self.exc, self.delay = exc, delay
        self.calls: list[tuple[list[dict], dict]] = []

    async def __call__(self, messages, **kw):
        self.calls.append((messages, kw))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        content = self.contents[min(len(self.calls), len(self.contents)) - 1]
        return {"role": "assistant", "content": content}, "sarvam"


class ExamTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_chat = exam.chat
        self._old_key = os.environ.get("SARVAM_API_KEY")
        os.environ["SARVAM_API_KEY"] = SECRET
        exam.clear_cache()
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        exam.chat = self._orig_chat
        exam.clear_cache()
        if self._old_key is None:
            os.environ.pop("SARVAM_API_KEY", None)
        else:
            os.environ["SARVAM_API_KEY"] = self._old_key

    def _post(self, body: dict, fake: FakeChat | None = None, status: int = 200):
        if fake is not None:
            exam.chat = fake
        r = self.client.post("/agent/exam/perform", headers=HDR, json=body)
        self.assertEqual(r.status_code, status, r.text)
        self.assertNotIn(SECRET, r.text)
        return r.json()

    def test_valid_findings_are_normalised(self) -> None:
        fake = FakeChat(PNEUMONIA)
        out = self._post(_body(), fake)
        self.assertEqual(out["system"], "resp")
        self.assertEqual(len(out["findings"]), 4)
        self.assertTrue(all(f["abnormal"] for f in out["findings"]))
        # Sound follows the written findings, not the model's contradictory pick.
        self.assertEqual(out["sound"], "bronchial")
        # At most 2 sentences, no em dash, diagnosis never named.
        self.assertLessEqual(out["summary"].count("."), 2)
        dump = json.dumps(out, ensure_ascii=False)
        self.assertNotIn(chr(0x2014), dump)
        self.assertNotIn("pneumonia", dump.lower())
        # Low temperature JSON mode, prompt carries diagnosis, vitals and maneuver.
        messages, kw = fake.calls[0]
        self.assertTrue(kw["json_mode"])
        self.assertLessEqual(kw["temperature"], 0.2)
        self.assertIn("Community-acquired pneumonia", messages[1]["content"])
        self.assertIn("auscultate the chest", messages[1]["content"])
        self.assertIn("38.9", messages[1]["content"])

    def test_vital_restated_by_model_is_reconciled(self) -> None:
        content = json.dumps({"findings": [
            {"label": "Respiratory rate", "value": "16/min, comfortable", "abnormal": False},
            {"label": "Temperature", "value": "afebrile", "abnormal": False},
            {"label": "Auscultation", "value": "Coarse crackles at the right base", "abnormal": True},
        ], "summary": "Crackles at the right base.", "sound": None})
        out = self._post(_body(), FakeChat(content))
        by = {f["label"]: f for f in out["findings"]}
        self.assertEqual(by["Respiratory rate"]["value"], "26/min")
        self.assertTrue(by["Respiratory rate"]["abnormal"])
        self.assertIn("38.9", by["Temperature"]["value"])
        self.assertTrue(by["Temperature"]["abnormal"])
        self.assertEqual(out["sound"], "crackles")

    def test_repeat_exam_is_cached_per_case_and_system(self) -> None:
        fake = FakeChat(PNEUMONIA)
        a = self._post(_body(), fake)
        b = self._post(_body(maneuver="listen to the lungs again"), fake)
        self.assertEqual(a, b)
        self.assertEqual(len(fake.calls), 1)
        # Another system or another case is a new exam.
        self._post(_body(system="cardio"), FakeChat(json.dumps({"findings": [
            {"label": "Heart sounds", "value": "S1 S2 normal, no murmur", "abnormal": False}],
            "summary": "CVS: S1 S2 heard, no murmur.", "sound": "murmur-systolic"})))
        self._post(_body(case_id="pn-2"), fake)
        self.assertEqual(len(fake.calls), 2)

    def test_normal_cardio_gets_normal_heart_sound(self) -> None:
        content = json.dumps({"findings": [
            {"label": "Apex beat", "value": "5th intercostal space, midclavicular line", "abnormal": False},
            {"label": "Heart sounds", "value": "S1 S2 normal, no murmurs or added sounds", "abnormal": False}],
            "summary": "CVS: S1 S2 normal, no murmur.", "sound": "murmur-systolic"})
        out = self._post(_body(system="cardiovascular"), FakeChat(content))
        self.assertEqual(out["system"], "cardio")
        self.assertEqual(out["sound"], "normal-heart")

    def test_murmur_with_negated_radiation_still_detected(self) -> None:
        content = json.dumps({"findings": [
            {"label": "Auscultation", "value": "Pansystolic murmur grade 3/6 at the apex, no radiation", "abnormal": True}],
            "summary": "Pansystolic murmur at the apex.", "sound": None})
        out = self._post(_body(system="cardio", case_id="mr-1"), FakeChat(content))
        self.assertEqual(out["sound"], "murmur-systolic")

    def test_non_auscultation_system_has_no_sound(self) -> None:
        content = json.dumps({"findings": [
            {"label": "Palpation", "value": "Soft, non-tender, no organomegaly", "abnormal": False}],
            "summary": "Abdomen soft and non-tender.", "sound": "wheeze"})
        out = self._post(_body(system="abdomen"), FakeChat(content))
        self.assertIsNone(out["sound"])

    def test_vitals_system_is_deterministic(self) -> None:
        fake = FakeChat("should not be called")
        out = self._post(_body(system="vitals"), fake)
        self.assertEqual(fake.calls, [])
        by = {f["label"]: f for f in out["findings"]}
        self.assertTrue(by["Pulse"]["abnormal"])
        self.assertFalse(by["Blood pressure"]["abnormal"])
        self.assertTrue(by["SpO2"]["abnormal"])
        self.assertIn("Abnormal", out["summary"])

    def test_paediatric_vitals_use_age_ranges(self) -> None:
        body = _body(system="vitals")
        body["patient"]["age"] = 2
        body["patient"]["vitals"] = {"hr": 120, "bp": "95/60", "spo2": 98, "temp": 37.0, "rr": 30}
        out = self._post(body, FakeChat("x"))
        self.assertFalse(any(f["abnormal"] for f in out["findings"]))

    def test_malformed_output_retries_then_502_and_is_not_cached(self) -> None:
        fake = FakeChat(["sure thing", '{"findings": "none"}'])
        self._post(_body(), fake, status=502)
        self.assertEqual(len(fake.calls), 2)
        good = FakeChat(PNEUMONIA)
        out = self._post(_body(), good)
        self.assertEqual(len(good.calls), 1)
        self.assertEqual(out["sound"], "bronchial")

    def test_retry_recovers_from_one_bad_reply(self) -> None:
        fake = FakeChat(["<think>hmm</think> not json", PNEUMONIA])
        out = self._post(_body(), fake)
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(len(out["findings"]), 4)

    def test_provider_failure_and_timeout_are_502(self) -> None:
        self._post(_body(), FakeChat(exc=HTTPException(status_code=503, detail="no provider")), status=502)
        old = exam.EXAM_TIMEOUT_S
        exam.EXAM_TIMEOUT_S = 0.05
        try:
            self._post(_body(case_id="slow"), FakeChat(PNEUMONIA, delay=0.5), status=502)
        finally:
            exam.EXAM_TIMEOUT_S = old

    def test_bad_system_is_422(self) -> None:
        r = self.client.post("/agent/exam/perform", headers=HDR, json=_body(system="soul"))
        self.assertEqual(r.status_code, 422)

    def test_findings_are_capped(self) -> None:
        content = json.dumps({"findings": [
            {"label": f"Sign {i}", "value": "word " * 80, "abnormal": False} for i in range(12)],
            "summary": "", "sound": None})
        out = self._post(_body(system="neuro"), FakeChat(content))
        self.assertLessEqual(len(out["findings"]), 8)
        self.assertTrue(all(len(f["value"]) <= 180 for f in out["findings"]))
        self.assertTrue(out["summary"])  # synthesised when the model leaves it empty


if __name__ == "__main__":
    unittest.main()
