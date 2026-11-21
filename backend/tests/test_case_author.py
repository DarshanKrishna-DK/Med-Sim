"""Case-authoring agent: catalogue sync with the TS sources, deterministic
validation, LLM repair round (mocked), custom-case storage + API. No network."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import unittest
from pathlib import Path

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

os.environ["CUSTOM_CASES_FILE"] = "off"

from fastapi.testclient import TestClient  # noqa: E402

import case_author  # noqa: E402
import catalog  # noqa: E402
import custom_cases  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}

ANSWERS = {
    "specialty": "cardiology", "name": "Ravi Kumar", "age": 54, "gender": "M",
    "complaint": "My chest feels tight when I climb stairs.", "severity": "urgent",
    "onset": "2 weeks, worse in 2 days", "history": "smoker, diabetic", "allergies": "penicillin",
    "medications": "metformin", "diagnosis": "Unstable angina", "vitals": None,
}

GOOD = {
    "arrivalBlurb": "A sweaty middle-aged man walks in holding his chest.",
    "chiefComplaint": "My chest feels tight when I climb stairs.",
    "vitals": {"hr": 104, "bp": "150/92", "spo2": 96, "temp": 36.9, "rr": 20},
    "anamnesis": [
        {"id": "onset", "question": "When did it start?", "answer": "Two weeks ago, worse for two days.", "relevant": True},
        {"id": "rest", "question": "Does it come at rest?", "answer": "Yes, last night in bed.", "relevant": True},
        {"id": "smoke", "question": "Do you smoke?", "answer": "Twenty a day.", "relevant": True},
        {"id": "pets", "question": "Any pets?", "answer": "A dog.", "relevant": False},
    ],
    "testResults": [
        {"testId": "ecg", "result": "ST depression V4-V6", "abnormal": True},
        {"testId": "troponin", "result": "18 ng/L (normal)", "abnormal": False},
        {"testId": "cbc", "result": "Hb 14.1 g/dL, WBC 7.2, platelets 250", "abnormal": False},
    ],
    "correctDiagnosisId": "unstable-angina",
    "diagnosisOptions": ["unstable-angina", "stable-angina", "gerd", "costochondritis"],
    "diagnosisLabels": {"unstable-angina": "Unstable Angina", "stable-angina": "Stable Angina",
                        "gerd": "GERD", "costochondritis": "Costochondritis"},
    "acceptableTreatmentIds": ["aspirin", "nitro", "heparin"],
    "criticalTreatmentIds": ["aspirin"],
}


def fake_chat(*replies):
    calls = []
    queue = list(replies)

    async def chat(messages, **kw):
        calls.append({"messages": messages, **kw})
        r = queue.pop(0)
        return {"content": r if isinstance(r, str) else json.dumps(r)}, "mock"

    chat.calls = calls
    return chat


def gen(chat):
    return asyncio.run(case_author.generate_case(ANSWERS, "Darsh", chat=chat, case_id="tg-abc123"))


class CatalogTests(unittest.TestCase):
    def test_json_matches_typescript_sources(self):
        self.assertEqual(catalog.load(), catalog.parse_sources(),
                         "backend/data/case_catalog.json is stale: run python backend/catalog.py --write")

    def test_catalog_contents(self):
        ids = [s["id"] for s in catalog.specialties()]
        self.assertIn("cardiology", ids)
        self.assertNotIn("all-specialties", ids)
        self.assertNotIn("communication-skills", ids)
        self.assertEqual(catalog.specialty_label("obgyn"), "OB/GYN")
        self.assertIn("troponin", catalog.test_ids())
        self.assertIn("aspirin", catalog.treatment_ids())


class ValidationTests(unittest.TestCase):
    def case(self, **over):
        c = case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-abc123", "Darsh")
        c.update(over)
        return c

    def test_good_case_passes(self):
        self.assertEqual(case_author.validate_case(self.case()), [])

    def test_unknown_ids_rejected(self):
        c = self.case(acceptableTreatmentIds=["aspirin", "magic-pill"])
        c["testResults"] = c["testResults"] + [{"testId": "xray-brain", "result": "fine", "abnormal": False}]
        errs = case_author.validate_case(c)
        self.assertTrue(any("magic-pill" in e for e in errs))
        self.assertTrue(any("xray-brain" in e for e in errs))

    def test_abnormal_flag_must_match_range(self):
        c = self.case()
        c["testResults"][2] = {"testId": "cbc", "result": "Hb 8.1 g/dL, WBC 7.2", "abnormal": False}
        self.assertTrue(any("out of reference range" in e for e in case_author.validate_case(c)))

    def test_vitals_plausibility_and_severity(self):
        self.assertTrue(case_author.validate_case(self.case(vitals={"hr": 300, "bp": "120/80", "spo2": 98, "temp": 37, "rr": 16})))
        self.assertTrue(case_author.validate_case(self.case(vitals={"hr": 80, "bp": "80/90", "spo2": 98, "temp": 37, "rr": 16})))
        stable_bad = self.case(severity="stable", vitals={"hr": 90, "bp": "120/80", "spo2": 85, "temp": 37, "rr": 16})
        self.assertTrue(any("stable" in e for e in case_author.validate_case(stable_bad)))
        crit_calm = self.case(severity="critical", vitals={"hr": 80, "bp": "120/80", "spo2": 98, "temp": 37, "rr": 16})
        self.assertTrue(any("critical" in e for e in case_author.validate_case(crit_calm)))

    def test_diagnosis_options(self):
        c = self.case(diagnosisOptions=["unstable-angina", "gerd"])
        self.assertTrue(any("exactly 4" in e for e in case_author.validate_case(c)))
        c = self.case(correctDiagnosisId="mi")
        self.assertTrue(any("correctDiagnosisId" in e for e in case_author.validate_case(c)))

    def test_em_dash_rejected_and_normalised(self):
        c = self.case(arrivalBlurb="He walks in \u2014 pale")
        self.assertIn("text must not contain em dashes", case_author.validate_case(c))
        self.assertNotIn("\u2014", json.dumps(case_author.no_em_dash(c), ensure_ascii=False))

    def test_normalise_forces_author_facts(self):
        raw = {**copy.deepcopy(GOOD), "name": "Someone Else", "age": 20, "diagnosisOptions":
               ["Unstable Angina", "Stable angina", "GERD", "Costo chondritis"], "correctDiagnosisId": "Unstable Angina"}
        c = case_author.normalise(raw, ANSWERS, "tg-x", "Darsh")
        self.assertEqual((c["name"], c["age"], c["specialty"]), ("Ravi Kumar", 54, "cardiology"))
        self.assertEqual(c["correctDiagnosisId"], "unstable-angina")
        self.assertIn("costo-chondritis", c["diagnosisOptions"])
        self.assertEqual(c["source"], {"title": "Created via Telegram by Darsh", "url": ""})
        self.assertTrue(c["synthetic"])

    def test_author_vitals_override(self):
        c = case_author.normalise(copy.deepcopy(GOOD), {**ANSWERS, "vitals": {"hr": 120, "spo2": 91}}, "tg-x", "")
        self.assertEqual((c["vitals"]["hr"], c["vitals"]["spo2"], c["vitals"]["bp"]), (120, 91, "150/92"))


class GenerationTests(unittest.TestCase):
    def test_first_draft_ok_single_call(self):
        chat = fake_chat(GOOD)
        c = gen(chat)
        self.assertEqual(len(chat.calls), 1)
        self.assertTrue(chat.calls[0]["json_mode"])
        prompt = chat.calls[0]["messages"][0]["content"]
        self.assertIn("troponin", prompt)  # only catalogue ids are offered
        self.assertIn("aspirin", prompt)
        self.assertEqual(c["id"], "tg-abc123")
        self.assertEqual(case_author.validate_case(c), [])

    def test_repair_round_sends_errors_back(self):
        bad = copy.deepcopy(GOOD)
        bad["diagnosisOptions"] = ["unstable-angina"]
        chat = fake_chat(bad, "```json\n" + json.dumps(GOOD) + "\n```")
        c = gen(chat)
        self.assertEqual(len(chat.calls), 2)
        repair_msg = chat.calls[1]["messages"][-1]["content"]
        self.assertIn("exactly 4", repair_msg)
        self.assertEqual(len(c["diagnosisOptions"]), 4)

    def test_mechanical_fix_after_repair(self):
        bad = copy.deepcopy(GOOD)
        bad["acceptableTreatmentIds"] = ["aspirin", "unicorn-tears"]
        bad["testResults"].append({"testId": "brain-scan-9000", "result": "odd", "abnormal": True})
        bad["testResults"][1] = {"testId": "troponin", "result": "450 ng/L", "abnormal": False}
        c = gen(fake_chat(bad, bad))
        self.assertEqual(c["acceptableTreatmentIds"], ["aspirin"])
        self.assertNotIn("brain-scan-9000", [t["testId"] for t in c["testResults"]])
        self.assertTrue(next(t for t in c["testResults"] if t["testId"] == "troponin")["abnormal"])

    def test_unfixable_raises(self):
        bad = copy.deepcopy(GOOD)
        bad["vitals"] = {"hr": 400, "bp": "nope", "spo2": 10, "temp": 99, "rr": 1}
        with self.assertRaises(case_author.CaseAuthorError) as ctx:
            gen(fake_chat(bad, bad))
        self.assertTrue(ctx.exception.errors)

    def test_non_json_reply(self):
        with self.assertRaises(case_author.CaseAuthorError):
            gen(fake_chat("sorry, I can't", "still no"))


class StorageTests(unittest.TestCase):
    def setUp(self):
        custom_cases.reset()

    def test_add_list_delete_by_creator_only(self):
        a = case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-aaa111", "A")
        b = case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-bbb222", "B")
        custom_cases.add(a, 1)
        custom_cases.add(b, 2)
        self.assertEqual([c["id"] for c in custom_cases.list_cases()], ["tg-bbb222", "tg-aaa111"])
        self.assertEqual([c["id"] for c in custom_cases.list_cases(1)], ["tg-aaa111"])
        self.assertFalse(custom_cases.delete("tg-aaa111", 2))
        self.assertTrue(custom_cases.delete("tg-aaa111", 1))
        self.assertIsNone(custom_cases.get("tg-aaa111"))

    def test_file_roundtrip(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "cases.json")
            os.environ["CUSTOM_CASES_FILE"] = path
            try:
                custom_cases.add(case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-file01", "A"), 5)
                custom_cases.reset(load_file=True)
                self.assertEqual(custom_cases.get("tg-file01")["name"], "Ravi Kumar")
                self.assertEqual(custom_cases.list_cases(5)[0]["id"], "tg-file01")
            finally:
                os.environ["CUSTOM_CASES_FILE"] = "off"
                custom_cases.reset()

    def test_api(self):
        import server

        custom_cases.add(case_author.normalise(copy.deepcopy(GOOD), ANSWERS, "tg-api001", "A"), 9)
        client = TestClient(server.app)
        r = client.get("/agent/custom-cases", headers=HDR)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["cases"][0]["id"], "tg-api001")
        self.assertNotIn("chat", r.json()["cases"][0])  # creator chat id stays server-side
        self.assertEqual(client.get("/agent/custom-cases/tg-api001", headers=HDR).json()["name"], "Ravi Kumar")
        self.assertEqual(client.get("/agent/custom-cases/nope", headers=HDR).status_code, 404)
        self.assertEqual(client.get("/agent/custom-cases").status_code, 401)  # guarded like every /agent/ route


if __name__ == "__main__":
    unittest.main()
