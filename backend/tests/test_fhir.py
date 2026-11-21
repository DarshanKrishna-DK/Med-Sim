"""Tests for the FHIR integration. httpx.MockTransport, no network."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

import httpx  # noqa: E402

from integrations import fhir  # noqa: E402


def _factory(handler):
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _ok(request: httpx.Request) -> httpx.Response:
    rtype = request.url.path.rsplit("/", 1)[-1]
    return httpx.Response(201, json={"resourceType": rtype, "id": "abc1"})


class FhirTests(unittest.TestCase):
    def setUp(self):
        fhir._patient_cache.clear()
        self.env = mock.patch.dict(os.environ, {"FHIR_ENABLED": "1", "FHIR_BASE_URL": "https://fhir.test/r4"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def _run(self, handler, coro_fn):
        with mock.patch.object(fhir, "_client_factory", _factory(handler)):
            return asyncio.run(coro_fn())

    def test_patient_payload_and_conditional_create(self):
        seen = {}

        def h(req):
            seen["body"] = json.loads(req.content)
            seen["headers"] = req.headers
            return _ok(req)

        pid = self._run(h, lambda: fhir.ensure_patient("case-1", "Asha Rao", 30, "F"))
        self.assertEqual(pid, "abc1")
        b = seen["body"]
        self.assertEqual(b["gender"], "female")
        self.assertEqual(b["identifier"][0], {"system": "https://medsim.app/case", "value": "case-1"})
        self.assertEqual(b["meta"]["tag"][0]["code"], "medsim-synthetic")
        self.assertEqual(seen["headers"]["if-none-exist"], "identifier=https://medsim.app/case|case-1")
        self.assertEqual(seen["headers"]["content-type"], "application/fhir+json")

    def test_medication_dosage_text(self):
        seen = {}

        def h(req):
            seen["body"] = json.loads(req.content)
            return _ok(req)

        rec = self._run(h, lambda: fhir.record_medication_request("p1", "Paracetamol", "500 mg TID", "5 days"))
        self.assertEqual(seen["body"]["dosageInstruction"][0]["text"], "500 mg TID for 5 days")
        self.assertEqual(rec["url"], "https://fhir.test/r4/MedicationRequest/abc1")

    def test_appointment_ist(self):
        seen = {}

        def h(req):
            seen["body"] = json.loads(req.content)
            return _ok(req)

        self._run(h, lambda: fhir.record_appointment("p1", 7, "Review"))
        b = seen["body"]
        self.assertTrue(b["start"].endswith("+05:30"))
        self.assertIn("T10:00:00", b["start"])
        self.assertIn("T10:15:00", b["end"])
        self.assertEqual(b["participant"][0]["status"], "accepted")

    def test_failure_returns_none(self):
        def boom(req):
            raise httpx.ConnectError("down")

        self.assertIsNone(self._run(boom, lambda: fhir.record_service_request("p1", "CBC", "cbc")))
        self.assertIsNone(self._run(lambda r: httpx.Response(500), lambda: fhir.ensure_patient("c", "N", 5, "M")))
        self.assertEqual(self._run(boom, lambda: fhir.record_batch({"id": "c"}, [("cbc", "CBC")], [])), [])

    def test_disabled_short_circuits(self):
        calls = []

        def h(req):
            calls.append(req)
            return _ok(req)

        with mock.patch.dict(os.environ, {"FHIR_ENABLED": "0"}):
            self.assertIsNone(self._run(h, lambda: fhir.ensure_patient("c", "N", 5, "M")))
            self.assertIsNone(self._run(h, lambda: fhir.record_service_request("p", "CBC", "cbc")))
            self.assertEqual(self._run(h, lambda: fhir.record_batch({"id": "c"}, [], [])), [])
        self.assertEqual(calls, [])

    def test_batch(self):
        recs = self._run(_ok, lambda: fhir.record_batch(
            {"id": "c2", "name": "Ravi", "age": 40, "gender": "M"},
            [("cbc", "CBC")], [{"name": "Amoxicillin", "dose": "500 mg", "duration": "5 days"}],
            {"inDays": 3, "reason": "Recheck"}))
        self.assertEqual(sorted(r["resourceType"] for r in recs),
                         ["Appointment", "MedicationRequest", "ServiceRequest"])


if __name__ == "__main__":
    unittest.main()
