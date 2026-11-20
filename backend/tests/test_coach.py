"""Tests for the mistake coach (/agent/coach/check, /agent/coach/explain). LLM mocked, no network."""

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
import coach  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}
SECRET = "sarvam-key-coach-zz"


def _body(kind: str = "order", detail: str = "Chest X-ray", **over) -> dict:
    body = {
        "caseId": "c1",
        "event": {"kind": kind, "detail": detail},
        "patient": {
            "name": "Asha Rao", "age": 34, "gender": "F", "chiefComplaint": "Sore throat for 3 days",
            "allergies": "Penicillin (rash)",
            "anamnesis": [{"question": "Any allergies?", "answer": "Penicillin gave me a rash."}],
            "vitals": {"hr": 92, "bp": "118/76", "spo2": 99, "temp": 38.1, "rr": 16},
        },
        "correctDiagnosis": "Streptococcal pharyngitis",
        "encounterSoFar": {"orderedTests": [], "prescriptions": [], "askedHistory": True,
                            "transcriptTail": ["Doctor: How long has it hurt?", "Patient: Three days."]},
    }
    body.update(over)
    return body


class FakeChat:
    """Stands in for llm_provider.chat; records calls."""

    def __init__(self, content=None, exc: Exception | None = None, delay: float = 0.0):
        self.content, self.exc, self.delay = content, exc, delay
        self.calls: list[list[dict]] = []

    async def __call__(self, messages, **kw):
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return {"role": "assistant", "content": self.content}, "sarvam"


class CoachTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_chat = coach.chat
        self._old_key = os.environ.get("SARVAM_API_KEY")
        os.environ["SARVAM_API_KEY"] = SECRET
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        coach.chat = self._orig_chat
        if self._old_key is None:
            os.environ.pop("SARVAM_API_KEY", None)
        else:
            os.environ["SARVAM_API_KEY"] = self._old_key

    def _check(self, body: dict, fake: FakeChat):
        coach.chat = fake
        r = self.client.post("/agent/coach/check", headers=HDR, json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(SECRET, r.text)
        return r.json()

    def test_valid_json_alert_is_returned_and_clamped(self) -> None:
        content = json.dumps({"alert": {
            "severity": "warning",
            "title": "Chest X-ray not indicated here at all today",
            "short": "A chest X-ray adds radiation and cost without changing management of a simple sore throat.",
            "explanation": "Order tests that answer a clinical question. A sore throat with no chest signs does not need imaging.",
            "suggestion": "Use the Centor criteria and a throat swab instead.",
        }})
        fake = FakeChat(content)
        out = self._check(_body(), fake)
        a = out["alert"]
        self.assertEqual(a["severity"], "warning")
        self.assertTrue(a["id"].startswith("ca-"))
        self.assertLessEqual(len(a["title"].rstrip(".").split()), 6)
        self.assertLessEqual(len(a["short"].rstrip(".").split()), 18)
        self.assertIn("Centor", a["suggestion"])
        self.assertEqual(len(fake.calls), 1)
        self.assertIn("Chest X-ray", fake.calls[0][1]["content"])

    def test_null_alert(self) -> None:
        out = self._check(_body(), FakeChat('{"alert": null}'))
        self.assertIsNone(out["alert"])

    def test_malformed_model_output_is_null_not_error(self) -> None:
        for bad in ["sure! here you go", '{"alert": "oops"}', '{"alert": {"severity": "danger"}}', "{not json", ""]:
            out = self._check(_body(), FakeChat(bad))
            self.assertIsNone(out["alert"], bad)

    def test_think_block_and_bad_severity_are_handled(self) -> None:
        content = '<think>hmm</think>{"alert": {"severity": "catastrophic", "title": "Missed red flag", "short": "Fever and stiff neck need urgent review."}}'
        out = self._check(_body(), FakeChat(content))
        self.assertEqual(out["alert"]["severity"], "warning")
        self.assertEqual(out["alert"]["title"], "Missed red flag")

    def test_provider_failure_and_timeout_degrade_to_null(self) -> None:
        out = self._check(_body(), FakeChat(exc=HTTPException(status_code=503, detail="no provider")))
        self.assertIsNone(out["alert"])
        old = coach.COACH_TIMEOUT_S
        coach.COACH_TIMEOUT_S = 0.05
        try:
            out = self._check(_body(), FakeChat('{"alert": null}', delay=0.5))
        finally:
            coach.COACH_TIMEOUT_S = old
        self.assertIsNone(out["alert"])

    def test_allergy_conflict_is_deterministic_danger(self) -> None:
        fake = FakeChat('{"alert": null}')
        out = self._check(_body(kind="prescription", detail="Amoxicillin 500 mg"), fake)
        self.assertEqual(out["alert"]["severity"], "danger")
        self.assertIn("penicillin", out["alert"]["short"].lower())
        self.assertEqual(fake.calls, [])  # no LLM needed

    def test_negated_allergy_does_not_fire(self) -> None:
        body = _body(kind="prescription", detail="Amoxicillin 500 mg")
        body["patient"]["allergies"] = "No known drug allergies"
        body["patient"]["anamnesis"] = [{"question": "Allergies?", "answer": "No, not allergic to penicillin."}]
        out = self._check(body, FakeChat('{"alert": null}'))
        self.assertIsNone(out["alert"])

    def test_prescribing_before_history_warns(self) -> None:
        body = _body(kind="prescription", detail="Paracetamol 500 mg")
        body["encounterSoFar"]["askedHistory"] = False
        out = self._check(body, FakeChat('{"alert": null}'))
        self.assertEqual(out["alert"]["severity"], "warning")
        self.assertIn("history", out["alert"]["title"].lower())

    def test_correct_diagnosis_skips_llm(self) -> None:
        fake = FakeChat('{"alert": {"severity": "info", "title": "x", "short": "y"}}')
        out = self._check(_body(kind="diagnosis", detail="streptococcal pharyngitis"), fake)
        self.assertIsNone(out["alert"])
        self.assertEqual(fake.calls, [])

    def test_bad_event_kind_is_422(self) -> None:
        r = self.client.post("/agent/coach/check", headers=HDR, json=_body(kind="dance"))
        self.assertEqual(r.status_code, 422)

    def test_explain_answers_and_caps_words(self) -> None:
        coach.chat = FakeChat("Because " + "word " * 120)
        r = self.client.post("/agent/coach/explain", headers=HDR, json={
            "alert": {"title": "Allergy conflict", "explanation": "Penicillin class.", "suggestion": "Use azithromycin."},
            "question": "Why is that wrong?", "caseId": "c1", "patient": _body()["patient"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertLessEqual(len(r.json()["answer"].split()), 80)
        self.assertNotIn(SECRET, r.text)

    def test_explain_falls_back_to_alert_text(self) -> None:
        coach.chat = FakeChat(exc=RuntimeError("boom"))
        r = self.client.post("/agent/coach/explain", headers=HDR, json={
            "alert": {"title": "Allergy conflict", "explanation": "She is allergic to penicillin.", "suggestion": "Use azithromycin."},
            "caseId": "c1", "patient": {}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("penicillin", r.json()["answer"])
        self.assertIn("azithromycin", r.json()["answer"])

    def test_no_em_dashes_in_output(self) -> None:
        content = json.dumps({"alert": {"severity": "info", "title": "Think again", "short": "Fever " + chr(0x2014) + " check it",
                                        "explanation": "A " + chr(0x2014) + " B."}})
        out = self._check(_body(), FakeChat(content))
        self.assertNotIn(chr(0x2014), json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
