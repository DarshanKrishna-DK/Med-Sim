"""Tests for OSCE examiner marking (/agent/debrief/osce). LLM mocked, no network."""

from __future__ import annotations

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
import osce  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}
SECRET = "sarvam-key-osce-zz"
EM = chr(0x2014)  # em dash, built at runtime so the source stays dash-free

RUBRIC = {
    "data_gathering": [
        {"criterion_id": "dg-01", "label": "Onset and duration of chest pain", "weight": 1,
         "evidence": "Asks when the pain started."},
        {"criterion_id": "dg-02", "label": "Radiation of pain", "weight": 1, "evidence": "Asks where it spreads."},
    ],
    "clinical_management": [
        {"criterion_id": "cm-01", "label": "Gives aspirin", "weight": 3, "evidence": "Prescribes aspirin."},
    ],
    "interpersonal": [
        {"criterion_id": "ip-01", "label": "Introduces self", "weight": 1, "evidence": "Greets and introduces."},
    ],
    "safety_netting": {"required_elements": ["Return if pain worsens"], "weight": 1},
    "global_rating": "borderline-regression",
}


def _body(**over) -> dict:
    body = {
        "caseId": "im-001",
        "patient": {"name": "Ravi Kumar", "age": 54, "gender": "M", "chiefComplaint": "Chest pain for 2 hours"},
        "correctDiagnosis": {"id": "acs", "name": "Acute coronary syndrome"},
        "submittedDiagnosis": {"id": "acs", "name": "Acute coronary syndrome"},
        "actions": [{"t": 60, "kind": "test", "detail": "12-lead ECG"},
                    {"t": 90, "kind": "prescription", "detail": "Aspirin, 300 mg, stat"}],
        "transcript": [
            {"role": "user", "content": "Hello, I am Dr Mehta, one of the interns. When did the pain start?"},
            {"role": "assistant", "content": "About two hours ago, doctor, while climbing stairs."},
            {"role": "user", "content": "Does the pain go anywhere, like your arm or jaw?"},
            {"role": "assistant", "content": "Yes, to my left arm."},
        ],
        "elapsedSeconds": 410,
        "stationSeconds": 480,
        "rubric": RUBRIC,
        "coachAlerts": [],
    }
    body.update(over)
    return body


class FakeChat:
    def __init__(self, content=None, exc: Exception | None = None):
        self.content, self.exc = content, exc
        self.calls: list[list[dict]] = []

    async def __call__(self, messages, **kw):
        self.calls.append(messages)
        self.kw = kw
        if self.exc:
            raise self.exc
        return {"role": "assistant", "content": self.content}, "sarvam"


def _model(**over) -> str:
    out = {
        "items": [
            {"id": "dg-01", "verdict": "met", "evidence": "When did the pain start?", "note": "Clear onset question."},
            {"id": "dg-02", "verdict": "met", "evidence": "Does the pain go anywhere", "note": "Asked radiation."},
            {"id": "cm-01", "verdict": "met", "evidence": "Aspirin, 300 mg, stat", "note": "Loaded aspirin."},
            {"id": "ip-01", "verdict": "partial", "evidence": "I am Dr Mehta",
             "note": "Did not confirm the patient's identity."},
            {"id": "sn-01", "verdict": "not-met", "evidence": "", "note": ""},
            {"id": "st-exam", "verdict": "not-met", "evidence": "", "note": "No examination."},
            {"id": "st-inv", "verdict": "met", "evidence": "the patient said he loves cricket", "note": "ECG."},
            {"id": "st-plan", "verdict": "partial", "evidence": "", "note": "Plan not explained."},
        ],
        "skills": {"history": 82, "reasoning": 75, "tests": 70, "treatment": 66, "communication": 140,
                   "disposition": "x"},
        "globalRating": "excellent",
        "strengths": ["Focused pain history " + EM + " good."],
        "improvements": "Explain the plan\nExamine the chest",
        "examinerComment": "Solid history and early aspirin.",
    }
    out.update(over)
    return json.dumps(out)


class OsceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_chat = osce.chat
        self._old_key = os.environ.get("SARVAM_API_KEY")
        os.environ["SARVAM_API_KEY"] = SECRET
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        osce.chat = self._orig_chat
        if self._old_key is None:
            os.environ.pop("SARVAM_API_KEY", None)
        else:
            os.environ["SARVAM_API_KEY"] = self._old_key

    def _post(self, body: dict, fake: FakeChat, status: int = 200):
        osce.chat = fake
        r = self.client.post("/agent/debrief/osce", headers=HDR, json=body)
        self.assertEqual(r.status_code, status, r.text)
        self.assertNotIn(SECRET, r.text)
        return r.json()

    def test_checklist_from_rubric_adds_station_tasks(self) -> None:
        items = osce.build_checklist(RUBRIC)
        ids = [i["id"] for i in items]
        self.assertEqual(ids[:4], ["dg-01", "dg-02", "cm-01", "ip-01"])
        for sid in ("sn-01", "st-exam", "st-inv", "st-dx", "st-plan"):
            self.assertIn(sid, ids)
        fallback = [i["id"] for i in osce.build_checklist(None)]
        self.assertIn("dg-01", fallback)
        self.assertIn("st-dx", fallback)

    def test_full_marking_scores_and_sanitises(self) -> None:
        fake = FakeChat(_model())
        out = self._post(_body(), fake)
        self.assertEqual(len(fake.calls), 1)
        self.assertTrue(fake.kw.get("json_mode"))
        user = fake.calls[0][1]["content"]
        self.assertIn("When did the pain start?", user)
        self.assertNotIn("Ravi Kumar’s candidate", user)

        items = {i["id"]: i for d in out["domains"] for i in d["items"]}
        # Model-skipped item defaults to not-met; deterministic diagnosis item.
        self.assertEqual(items["st-dx"]["verdict"], "met")
        self.assertEqual(items["dg-01"]["evidence"], "When did the pain start?")
        # Hallucinated quote is dropped, verdict kept.
        self.assertEqual(items["st-inv"]["evidence"], "")
        self.assertEqual(items["sn-01"]["note"], "No evidence in the transcript or action log.")

        # Scores are computed from verdicts, not the model.
        dg = next(d for d in out["domains"] if d["id"] == "data_gathering")
        # dg-01 (1, met) + dg-02 (1, met) + st-exam (2, not-met) = 2/4
        self.assertEqual(dg["score"], 50)
        self.assertTrue(0 <= out["score"] <= 100)
        # Holistic rating kept within one band of the checklist score.
        band = osce.RATINGS.index(osce.rating_for_score(out["score"]))
        self.assertLessEqual(abs(osce.RATINGS.index(out["globalRating"]) - band), 1)
        # Skills clamped / backfilled.
        self.assertEqual(out["skills"]["communication"], 100)
        self.assertIsInstance(out["skills"]["disposition"], int)
        # Lists normalised, no em dashes anywhere.
        self.assertEqual(out["improvements"], ["Explain the plan", "Examine the chest"])
        self.assertNotIn(EM, json.dumps(out, ensure_ascii=False))

    def test_wrong_diagnosis_is_not_met_and_danger_alert_caps_rating(self) -> None:
        body = _body(
            submittedDiagnosis={"id": "gerd", "name": "Reflux"},
            coachAlerts=[
                {"severity": "warning", "title": "Irrelevant test", "short": "Not needed."},
                {"severity": "danger", "title": "Allergy conflict", "short": "Penicillin allergy.",
                 "explanation": "The chart documents a penicillin allergy."},
                {"severity": "danger", "title": "allergy conflict", "short": "dup"},
            ],
        )
        all_met = {"items": [{"id": i["id"], "verdict": "met", "evidence": "", "note": ""}
                             for i in osce.build_checklist(RUBRIC)], "globalRating": "excellent"}
        out = self._post(body, FakeChat(json.dumps(all_met)))
        items = {i["id"]: i for d in out["domains"] for i in d["items"]}
        self.assertEqual(items["st-dx"]["verdict"], "not-met")
        self.assertIn("Acute coronary syndrome", items["st-dx"]["note"])
        self.assertEqual(out["globalRating"], "borderline")
        errs = out["criticalErrors"]
        self.assertEqual([e["title"] for e in errs], ["Allergy conflict", "Irrelevant test"])
        self.assertEqual(errs[0]["detail"], "The chart documents a penicillin allergy.")

    def test_no_interaction_is_clear_fail_without_llm(self) -> None:
        fake = FakeChat(_model())
        out = self._post(_body(transcript=[{"role": "assistant", "content": "Hello doctor"}], actions=[],
                               submittedDiagnosis=None), fake)
        self.assertEqual(fake.calls, [])
        self.assertEqual(out["globalRating"], "clear-fail")
        self.assertEqual(out["score"], 0)
        self.assertTrue(out["examinerComment"])

    def test_malformed_json_is_502_and_provider_errors_pass_through(self) -> None:
        for bad in ["not json", '{"items": "nope"}', ""]:
            self._post(_body(), FakeChat(bad), status=502)
        self._post(_body(), FakeChat(exc=HTTPException(status_code=503, detail="no provider")), status=503)

    def test_think_block_is_ignored(self) -> None:
        out = self._post(_body(), FakeChat("<think>hmm {not this}</think>" + _model()))
        self.assertIn(out["globalRating"], osce.RATINGS)


if __name__ == "__main__":
    unittest.main()
