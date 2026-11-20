"""Tests for the radiology reading room (/agent/radiology/grade, /agent/radiology/probe).
LLM mocked, no network. Also checks the shared case file and its images."""

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
import radiology  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}
SECRET = "sarvam-key-radiology-zz"
PUBLIC = _B.parent / "public"


class FakeChat:
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


PNA = "rad-cxr-lobar-pneumonia"
GOOD_READ = (
    "PA film, adequate. Trachea is central. There is a dense consolidation in the right lower zone "
    "with loss of the right heart border, so right middle lobe. Costophrenic angles are clear. Left lung clear."
)


class CaseDataTests(unittest.TestCase):
    def test_case_file_is_complete_and_images_are_local_and_small(self) -> None:
        cases = radiology.load_cases()
        self.assertGreaterEqual(len(cases), 15)
        for cid, c in cases.items():
            with self.subTest(case=cid):
                self.assertTrue(c["image"].startswith("/assets/radiology/"))
                img = PUBLIC / c["image"].lstrip("/")
                self.assertTrue(img.is_file(), f"missing image {img}")
                self.assertLess(img.stat().st_size, 400 * 1024)
                for k in ("author", "license", "licenseUrl", "source"):
                    self.assertTrue(c["credit"].get(k), k)
                self.assertGreaterEqual(len(c["findings"]), 3)
                self.assertTrue(any(f.get("critical") for f in c["findings"]))
                self.assertEqual(len(c["distractors"]), 3)
                self.assertNotIn(c["diagnosis"], c["distractors"])
                ids = [f["id"] for f in c["findings"]]
                self.assertEqual(len(ids), len(set(ids)))
                for f in c["findings"]:
                    self.assertTrue(f["keywords"], f["id"])
                    self.assertTrue(f.get("probe"), f["id"])
                # Own diagnosis passes the rule grader; every distractor fails it.
                self.assertTrue(radiology.rule_diagnosis(c, c["diagnosis"]))
                for d in c["distractors"]:
                    self.assertFalse(radiology.rule_diagnosis(c, d), d)
                text = json.dumps(c, ensure_ascii=False)
                self.assertNotIn("\u2014", text)


class RuleGraderTests(unittest.TestCase):
    def test_keyword_negation_is_clause_scoped(self) -> None:
        t = radiology.norm("No effusion, consolidation in the right lower zone.")
        self.assertTrue(radiology.keyword_hit(t, "consolidation in the right"))
        self.assertFalse(radiology.keyword_hit(radiology.norm("there is no consolidation"), "consolidation"))
        self.assertTrue(radiology.keyword_hit(t, "no effusion"))

    def test_rule_found_and_score(self) -> None:
        c = radiology.get_case(PNA)
        found = radiology.rule_found(c, GOOD_READ)
        for fid in ("consolidation", "silhouette", "no-collapse", "cp-angles", "left-clear"):
            self.assertIn(fid, found)
        self.assertNotIn("air-bronchogram", found)
        self.assertGreaterEqual(radiology.score_for(c, found, True), 85)
        self.assertEqual(radiology.score_for(c, [], False), 0)
        self.assertEqual(radiology.score_for(c, [f["id"] for f in c["findings"]], True), 100)

    def test_diagnosis_synonyms_and_excludes(self) -> None:
        c = radiology.get_case("rad-cxr-pneumothorax")
        self.assertTrue(radiology.rule_diagnosis(c, "Right spontaneous pneumothorax"))
        self.assertFalse(radiology.rule_diagnosis(c, "tension pneumothorax on the right"))
        e = radiology.get_case("rad-ct-edh")
        self.assertTrue(radiology.rule_diagnosis(e, "epidural hematoma"))
        self.assertFalse(radiology.rule_diagnosis(e, "acute subdural bleed"))


class RouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_chat = radiology.chat
        self._old_key = os.environ.get("SARVAM_API_KEY")
        os.environ["SARVAM_API_KEY"] = SECRET
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        radiology.chat = self._orig_chat
        if self._old_key is None:
            os.environ.pop("SARVAM_API_KEY", None)
        else:
            os.environ["SARVAM_API_KEY"] = self._old_key

    def _grade(self, fake: FakeChat, **body):
        radiology.chat = fake
        payload = {"caseId": PNA, "description": GOOD_READ, "diagnosis": "Right middle lobe pneumonia"}
        payload.update(body)
        r = self.client.post("/agent/radiology/grade", headers=HDR, json=payload)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(SECRET, r.text)
        return r.json()

    def test_llm_grade_is_validated_against_the_key(self) -> None:
        content = json.dumps({
            "found": ["consolidation", "silhouette", "made-up-id", 7],
            "diagnosisCorrect": True,
            "feedback": "Good read \u2014 you localised it well. Next time name the air bronchograms.",
        })
        fake = FakeChat(content)
        out = self._grade(fake)
        self.assertEqual(out["gradedBy"], "llm")
        self.assertEqual(len(out["foundFindings"]), 2)
        self.assertIn("Air bronchograms within the opacity", out["missedFindings"])
        self.assertTrue(out["diagnosisCorrect"])
        self.assertEqual(out["correctDiagnosis"], "Right middle lobe pneumonia")
        self.assertNotIn("\u2014", out["feedback"])
        # 2 criticals found (4 of 8 weight) -> 30 + 40
        self.assertEqual(out["score"], 70)
        sent = fake.calls[0][1]["content"]
        self.assertIn("silhouette", sent)
        self.assertIn("right lower zone", sent)

    def test_exact_distractor_overrides_a_lenient_model(self) -> None:
        content = json.dumps({"found": [], "diagnosisCorrect": True, "feedback": "ok"})
        out = self._grade(FakeChat(content), diagnosis="Right pleural effusion")
        self.assertFalse(out["diagnosisCorrect"])

    def test_malformed_or_failed_llm_falls_back_to_rules(self) -> None:
        for fake in (
            FakeChat("sure, here is the grade"),
            FakeChat('{"found": "all"}'),
            FakeChat(exc=HTTPException(status_code=503, detail="no provider")),
        ):
            out = self._grade(fake)
            self.assertEqual(out["gradedBy"], "rules")
            self.assertTrue(out["diagnosisCorrect"])
            self.assertGreaterEqual(out["score"], 85)
            self.assertIn("Air bronchograms within the opacity", out["missedFindings"])
        old = radiology.LLM_TIMEOUT_S
        radiology.LLM_TIMEOUT_S = 0.05
        try:
            out = self._grade(FakeChat("{}", delay=0.5))
        finally:
            radiology.LLM_TIMEOUT_S = old
        self.assertEqual(out["gradedBy"], "rules")

    def test_transcript_lines_count_and_wrong_diagnosis_scores_low(self) -> None:
        out = self._grade(
            FakeChat(exc=HTTPException(status_code=503, detail="x")),
            description="",
            transcript=["The trachea is central.", "I think it is normal."],
            diagnosis="Normal chest radiograph",
        )
        self.assertFalse(out["diagnosisCorrect"])
        self.assertLess(out["score"], 30)
        self.assertIn("Homogeneous airspace opacity (consolidation) in the right mid to lower zone", out["missedCritical"])

    def test_unknown_case_and_bad_body(self) -> None:
        r = self.client.post("/agent/radiology/grade", headers=HDR, json={"caseId": "nope", "diagnosis": "x"})
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/agent/radiology/grade", headers=HDR, json={"caseId": PNA, "diagnosis": ""})
        self.assertEqual(r.status_code, 422)

    def test_probe_llm_and_rule_fallback(self) -> None:
        radiology.chat = FakeChat(json.dumps({"question": "What about the right heart border \u2014 can you see it?"}))
        r = self.client.post("/agent/radiology/probe", headers=HDR, json={"caseId": PNA, "transcript": ["Consolidation right lower zone."]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["gradedBy"], "llm")
        self.assertNotIn("\u2014", r.json()["question"])

        radiology.chat = FakeChat(exc=HTTPException(status_code=502, detail="down"))
        r = self.client.post("/agent/radiology/probe", headers=HDR, json={"caseId": PNA, "description": "There is consolidation in the right lower zone."})
        body = r.json()
        self.assertEqual(body["gradedBy"], "rules")
        # consolidation was named, so the probe targets the other must-not-miss finding
        self.assertIn("right heart border", body["question"])

    def test_language_tail_only_for_non_english(self) -> None:
        self.assertEqual(radiology._lang_tail("en"), "")
        self.assertIn("English", radiology._lang_tail("hi"))


if __name__ == "__main__":
    unittest.main()
