"""Tests for the operation theatre drill explainer (/agent/ot/explain). LLM mocked, no network."""

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
import ot  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}
SECRET = "sarvam-key-ot-zz"

BODY = {
    "scenario": "Laparoscopic cholecystectomy",
    "problem": "Vagal bradycardia",
    "callout": "Insufflating... heart rate is 42!",
    "outcome": "missed",
    "attempts": ["Giving Atropine 0.2 mg IV (wrong)"],
    "model": "Ask the surgeon to stop the stimulus, then atropine 0.6 mg IV",
    "teaching": "Peritoneal stretch fires a vagal reflex. Give atropine 0.6 mg IV (0.5 to 1 mg).",
}


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


class OTExplainTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_chat = ot.chat
        self._old_key = os.environ.get("SARVAM_API_KEY")
        os.environ["SARVAM_API_KEY"] = SECRET
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        ot.chat = self._orig_chat
        if self._old_key is None:
            os.environ.pop("SARVAM_API_KEY", None)
        else:
            os.environ["SARVAM_API_KEY"] = self._old_key

    def _post(self, fake: FakeChat, **over):
        ot.chat = fake
        body = {**BODY, **over}
        r = self.client.post("/agent/ot/explain", headers=HDR, json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(SECRET, r.text)
        return r.json()

    def test_llm_explanation_is_cleaned(self) -> None:
        fake = FakeChat(json.dumps({"explanation": "The **stretch** fired a vagal reflex \u2014 give atropine 0.6 mg."}))
        out = self._post(fake)
        self.assertEqual(out["source"], "llm")
        self.assertNotIn("\u2014", out["explanation"])
        self.assertNotIn("*", out["explanation"])
        self.assertIn("atropine 0.6 mg", out["explanation"])
        # the teaching point and the student's attempt reach the model
        sent = fake.calls[0][1]["content"]
        self.assertIn("0.5 to 1 mg", sent)
        self.assertIn("0.2 mg", sent)

    def test_failures_fall_back_to_the_teaching_point(self) -> None:
        for fake in (
            FakeChat("no json here"),
            FakeChat('{"explanation": ""}'),
            FakeChat(exc=HTTPException(status_code=503, detail="no provider")),
        ):
            out = self._post(fake)
            self.assertEqual(out["source"], "rules")
            self.assertIn("atropine 0.6 mg", out["explanation"])
            self.assertTrue(out["explanation"].startswith("You missed this one."))
        old = ot.LLM_TIMEOUT_S
        ot.LLM_TIMEOUT_S = 0.05
        try:
            out = self._post(FakeChat("{}", delay=0.5))
        finally:
            ot.LLM_TIMEOUT_S = old
        self.assertEqual(out["source"], "rules")

    def test_language_tail_and_validation(self) -> None:
        self.assertEqual(ot._lang_tail("en"), "")
        self.assertIn("English", ot._lang_tail("hi"))
        fake = FakeChat(json.dumps({"explanation": "ठीक है, atropine 0.6 mg दीजिए।"}))
        out = self._post(fake, lang="hi")
        self.assertEqual(out["source"], "llm")
        r = self.client.post("/agent/ot/explain", headers=HDR, json={"problem": "", "model": "x"})
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
