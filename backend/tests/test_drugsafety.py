from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

import httpx

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

from integrations import drugsafety as ds  # noqa: E402

LABEL = {"results": [{
    "drug_interactions": ["Concomitant use of aspirin increases bleeding risk. Other text here."],
    "contraindications": ["Pregnancy."],
    "boxed_warning": ["WARNING: BLEEDING RISK. Warfarin can cause major bleeding."],
    "openfda": {"generic_name": ["WARFARIN"], "pharm_class_epc": ["Vitamin K Antagonist [EPC]"]}}]}
RXCUI = {"idGroup": {"rxnormId": ["723"]}}
CLASSES = {"rxclassDrugInfoList": {"rxclassDrugInfo": [{
    "minConcept": {"rxcui": "723", "name": "amoxicillin", "tty": "IN"},
    "rxclassMinConceptItem": {"classId": "J01CA", "className": "Penicillins with extended spectrum",
                              "classType": "ATC1-4"}, "rela": "", "relaSource": "ATC"}]}}


class DrugSafetyTests(unittest.TestCase):
    def setUp(self):
        ds._cache.clear()
        self.calls = 0
        self.fail = False
        self._orig = ds._client_factory

        def handler(req: httpx.Request) -> httpx.Response:
            self.calls += 1
            if self.fail:
                raise httpx.ConnectError("down")
            p = req.url.path
            if p.endswith("rxcui.json"):
                return httpx.Response(200, json=RXCUI)
            if "rxclass" in p:
                return httpx.Response(200, json=CLASSES)
            return httpx.Response(200, json=LABEL)

        ds._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))

    def tearDown(self):
        ds._client_factory = self._orig

    def run_check(self, *a):
        return asyncio.run(ds.check_drug(*a))

    def test_normalise(self):
        self.assertEqual(ds.normalise("Amoxicillin 500mg"), "amoxicillin")
        self.assertEqual(ds.normalise("Paracetamol 650 mg tablet"), "paracetamol")

    def test_penicillin_allergy_via_class(self):
        r = self.run_check("Amoxicillin 500mg", "Penicillin: itchy rash", [])
        self.assertTrue(r["ok"])
        self.assertEqual(r["rxcui"], "723")
        self.assertIn("Penicillins", r["allergyConflict"])
        self.assertEqual(len(r["sources"]), 2)

    def test_no_allergy_conflict(self):
        self.assertIsNone(self.run_check("amoxicillin", "latex", [])["allergyConflict"])

    def test_interaction_excerpt_and_boxed(self):
        r = self.run_check("Warfarin 5mg", "", ["Aspirin 75mg", "metformin"])
        self.assertEqual([i["with"] for i in r["interactions"]], ["Aspirin 75mg"])
        self.assertIn("aspirin", r["interactions"][0]["excerpt"].lower())
        self.assertLessEqual(len(r["interactions"][0]["excerpt"]), 220)
        self.assertIn("BLEEDING", r["boxedWarning"])
        self.assertIn("Vitamin K Antagonist", r["classes"])

    def test_network_failure_does_not_raise(self):
        self.fail = True
        r = self.run_check("warfarin", "", [])
        self.assertFalse(r["ok"])
        self.assertIn("error", r)

    def test_cache_hit(self):
        self.run_check("warfarin", "", [])
        n = self.calls
        self.assertGreater(n, 0)
        self.run_check("Warfarin 5mg", "", ["aspirin"])
        self.assertEqual(self.calls, n)


if __name__ == "__main__":
    unittest.main()
