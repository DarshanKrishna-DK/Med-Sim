"""The patient stays silent when the doctor talks to Nurse Asha; Asha's check-in never leaks the answer."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import coach  # noqa: E402
from llm_proxy import _silent_reply, addressed_to_nurse  # noqa: E402


def user(text):
    return [{"role": "system", "content": "persona"}, {"role": "user", "content": text}]


class NurseAddressTests(unittest.TestCase):
    def test_nurse_addressed_turns(self):
        for t in ("Nurse, order a CBC", "Okay Asha, how am I doing?", "Aasha please start paracetamol",
                  "Sister, get an ECG", "please, nurse asha give him fluids", "नर्स, CBC करो"):
            self.assertTrue(addressed_to_nurse(user(t)), t)

    def test_patient_turns(self):
        for t in ("How long have you had the cough?", "Are you ashamed of it?", "I am a nurse myself",
                  "Tell me about your sister"):
            self.assertFalse(addressed_to_nurse(user(t)), t)

    def test_only_latest_turn_counts(self):
        msgs = user("Nurse, order a CBC") + [{"role": "assistant", "content": "Okay"}]
        self.assertFalse(addressed_to_nurse(msgs))

    def test_silent_stream_is_valid_sse(self):
        body = _silent_reply(True, "m").body.decode()
        self.assertTrue(body.rstrip().endswith("data: [DONE]"))
        first = json.loads(body.split("\n\n")[0][len("data: "):])
        self.assertEqual(first["choices"][0]["delta"]["content"], "")


class HintTests(unittest.TestCase):
    def req(self, **enc):
        return coach.CoachHintRequest(
            correctDiagnosis="Iron deficiency anaemia",
            patient={"chiefComplaint": "Tired all the time"},
            encounterSoFar=enc,
        )

    def test_fallback_starts_with_history(self):
        self.assertIn("history", coach.fallback_hint(self.req()).hint)

    def test_hint_naming_the_diagnosis_is_replaced(self):
        leak = json.dumps({"verdict": "partly", "hint": "This is iron deficiency anaemia, order ferritin."})
        with mock.patch.object(coach, "_llm", mock.AsyncMock(return_value=leak)):
            out = asyncio.run(coach.coach_hint(self.req(askedHistory=True)))
        self.assertNotIn("anaemia", out.hint.lower())

    def test_model_hint_passes_through(self):
        ok = json.dumps({"verdict": "on_track", "hint": "Good history. Have you looked at the conjunctiva?"})
        with mock.patch.object(coach, "_llm", mock.AsyncMock(return_value=ok)):
            out = asyncio.run(coach.coach_hint(self.req(askedHistory=True)))
        self.assertEqual(out.verdict, "on_track")
        self.assertIn("conjunctiva", out.hint)


if __name__ == "__main__":
    unittest.main()
