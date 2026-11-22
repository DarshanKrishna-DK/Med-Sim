"""Routing authority (intent.py): the shared fixture set, the LLM fallback, POST /voice/route,
and the LLM proxy using the same decision. No network."""

from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

from fastapi.testclient import TestClient  # noqa: E402

import intent  # noqa: E402
import llm_provider  # noqa: E402
import llm_proxy  # noqa: E402
import server  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "intent_cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
HDR = {"Origin": "http://localhost:5173"}


class FixtureTests(unittest.TestCase):
    def test_fixture_shape(self):
        self.assertGreater(len(CASES), 700)
        langs = Counter(c["lang"] for c in CASES)
        for lg in ("en", "hi", "kn", "ta", "te", "mr", "bn"):
            self.assertGreaterEqual(langs[lg], 45, lg)
        self.assertEqual({c["target"] for c in CASES}, set(intent.TARGETS))
        for c in CASES:
            self.assertIn(c["action"], (*intent.ACTIONS, None), c)
        self.assertEqual(len({(c["u"], json.dumps(c.get("context"))) for c in CASES}), len(CASES))

    def test_rules_route_every_case(self):
        wrong = []
        for c in CASES:
            r = intent.route_rules(c["u"], lang=c["lang"], context=c.get("context"))
            if c.get("tier") == "llm":
                ok = r.target == "patient" and r.ambiguous  # rules stay with the patient and ask
            else:
                ok = r.target == c["target"] and (c["action"] is None or r.action == c["action"])
            if not ok:
                wrong.append(f"{c['u']!r}: want {c['target']}/{c['action']}, got {r.target}/{r.action} ambiguous={r.ambiguous}")
        self.assertEqual(wrong, [])

    def test_ordinary_patient_talk_never_waits_for_the_model(self):
        plain = [c for c in CASES if c["target"] == "patient" and c.get("tier") != "llm" and c["tag"] != "llm-patient"]
        slow = [c["u"] for c in plain if intent.route_rules(c["u"], lang=c["lang"], context=c.get("context")).ambiguous]
        self.assertEqual(slow, [])

    def test_patient_is_silent_only_for_other_targets(self):
        for c in CASES:
            r = intent.route_rules(c["u"], lang=c["lang"], context=c.get("context"))
            if r.target == "patient":
                self.assertFalse(r.silent, c["u"])
        self.assertTrue(intent.route_rules("Nurse check the BP").silent)
        self.assertFalse(intent.route_rules("Let me listen to your chest").silent)
        self.assertFalse(intent.route_rules("How long have you had this? Nurse, send a CBC").silent)

    def test_case_and_punctuation_do_not_matter(self):
        for c in CASES[:200]:
            if c.get("tier") == "llm" or any(ch in c["u"] for ch in ",?:"):
                continue
            r = intent.route_rules(c["u"].upper().rstrip("."), lang=c["lang"], context=c.get("context"))
            self.assertEqual(r.target, c["target"], c["u"])

    def test_junk(self):
        for t in ("", "   ", "???", "...", "a", "‍", "x" * 5000, "nurse " * 400):
            self.assertIsInstance(intent.route_rules(t), intent.Route)
        self.assertEqual(intent.route_rules("", context={"pendingQuestion": "bad", "awaitingFaculty": "x"}).target, "patient")

    def test_rules_are_fast(self):
        t0 = time.perf_counter()
        for c in CASES:
            intent._rules(c["u"], c["lang"], "", "", False, ())
        self.assertLess((time.perf_counter() - t0) / len(CASES), 0.02)

    def test_skeleton_matches_drugs_across_scripts(self):
        for w in ("amoxycillin", "अमोक्सिसिलिन", "ಪ್ಯಾರಸಿಟಮಾಲ್", "பாராசிட்டமால்", "ప్యారాసిటమాల్", "প্যারাসিটামল", "एज़िथ्रोमाइसिन"):
            self.assertTrue(intent._drug_token(intent.normalise(w).strip()), w)
        for w in ("medicine", "तकलीफ", "pressure", "ತೊಂದರೆ"):
            self.assertFalse(intent._drug_token(intent.normalise(w).strip()), w)


def _chat(reply, delay=0.0, calls=None):
    async def chat(messages, **kw):
        if calls is not None:
            calls.append(messages)
        await asyncio.sleep(delay)
        return {"content": reply}, "sarvam"
    return chat


UNCLEAR = "Let's get you an ECG and some bloods"


class LlmFallbackTests(unittest.TestCase):
    def setUp(self):
        intent.reset()
        self.addCleanup(intent.reset)

    def run_route(self, text, chat, **kw):
        with mock.patch.object(llm_provider, "chat", chat):
            return asyncio.run(intent.route(text, **kw))

    def test_clear_turns_never_call_the_model(self):
        calls: list = []
        for t in ("Nurse, order a CBC", "How long have you had the cough?", "kab se dard hai"):
            self.run_route(t, _chat("{}", calls=calls))
        self.assertEqual(calls, [])

    def test_model_decides_unclear_turns_and_is_cached(self):
        calls: list = []
        chat = _chat('{"target":"nurse","action":"order","confidence":0.9}', calls=calls)
        r = self.run_route(UNCLEAR, chat)
        self.assertEqual((r.target, r.action, r.via, r.silent), ("nurse", "order", "llm", True))
        self.assertEqual(self.run_route(UNCLEAR, chat).target, "nurse")
        self.assertEqual(len(calls), 1)

    def test_low_confidence_bad_json_and_errors_stay_with_patient(self):
        async def boom(*a, **k):
            raise RuntimeError("down")
        for chat in (_chat('{"target":"nurse","action":"order","confidence":0.4}'), _chat("no idea"), boom,
                     _chat('{"target":"cleaner","action":"order","confidence":0.9}')):
            intent.reset()
            r = self.run_route(UNCLEAR, chat)
            self.assertEqual((r.target, r.silent), ("patient", False))

    def test_concurrent_callers_share_one_call(self):
        calls: list = []

        async def both():
            return await asyncio.gather(intent.route(UNCLEAR), intent.route(UNCLEAR, llm_cap_s=1.2))
        with mock.patch.object(llm_provider, "chat", _chat('{"target":"nurse","action":"order","confidence":0.9}', 0.05, calls)):
            a, b = asyncio.run(both())
        self.assertEqual((a.target, b.target, len(calls)), ("nurse", "nurse", 1))

    def test_first_timeout_decides_for_everyone(self):
        async def both():
            proxy = asyncio.ensure_future(intent.route(UNCLEAR, llm_cap_s=0.05))
            browser = asyncio.ensure_future(intent.route(UNCLEAR, llm_cap_s=1.0))
            return await asyncio.gather(proxy, browser)
        with mock.patch.object(llm_provider, "chat", _chat('{"target":"nurse","action":"order","confidence":0.9}', 0.3)):
            t0 = time.perf_counter()
            a, b = asyncio.run(both())
        self.assertLess(time.perf_counter() - t0, 0.9)
        self.assertEqual((a.target, b.target), ("patient", "patient"))


class EndpointTests(unittest.TestCase):
    def setUp(self):
        intent.reset()
        self.addCleanup(intent.reset)
        self.c = TestClient(server.app)

    def post(self, body):
        r = self.c.post("/voice/route", json=body, headers=HDR)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_shape(self):
        d = self.post({"utterance": "Nurse, order a CBC", "lang": "en", "context": {"patientName": "Ravi"}})
        self.assertEqual({k: d[k] for k in ("target", "action", "via", "silent")},
                         {"target": "nurse", "action": "order", "via": "rule", "silent": True})
        self.assertEqual(d["text"], "Nurse, order a CBC")
        self.assertGreater(d["confidence"], 0.8)

    def test_patient_named_asha(self):
        d = self.post({"utterance": "Asha, where does it hurt?", "context": {"patientName": "Asha Thakkar"}})
        self.assertEqual(d["target"], "patient")

    def test_guarded_like_the_rest_of_voice(self):
        self.assertEqual(self.c.post("/voice/route", json={"utterance": "x"}).status_code, 401)

    def test_context_is_shared_with_the_proxy(self):
        intent.bind_session("ch-1", case_id="c1", encounter_id="e1", patient_name="Ravi")
        self.post({"utterance": "", "encounterId": "e1", "context": {"pendingQuestion": {"role": "radiology", "ref": "r"}}})
        ctx = intent.session_context("ch-1")
        self.assertEqual(intent.route_rules("No, she is not pregnant", context=ctx).target, "radiology")
        self.post({"utterance": "", "encounterId": "e1", "context": {}})
        self.assertEqual(intent.route_rules("No, she is not pregnant", context=intent.session_context("ch-1")).target, "patient")

    def test_same_case_twice_never_shares_state(self):
        intent.bind_session("ch-1", case_id="c1", patient_name="Ravi")
        intent.bind_session("ch-2", case_id="c1", patient_name="Ravi")
        self.assertFalse(intent.note_context({"awaitingFaculty": True}, case_id="c1"))
        self.assertTrue(intent.note_context({"awaitingFaculty": True}, channel="ch-2"))
        self.assertNotIn("awaitingFaculty", intent.session_context("ch-1"))
        self.assertTrue(intent.session_context("ch-2")["awaitingFaculty"])

    def test_persona_names(self):
        for prompt, want in (("You are a human patient named Asha Thakkar, a 34-year-old woman.", "Asha Thakkar"),
                             ("You are the mother of Vikram Dubey, a 6-year-old boy.", "Vikram Dubey"),
                             ("You are Meera Nair, a 52-year-old woman, the daughter of ...", "Meera Nair"),
                             ("persona", "")):
            self.assertEqual(intent.persona_name(prompt), want)


SYS = {"role": "system", "content": "You are a human patient named Ravi, a 52-year-old man."}


def u(t):
    return {"role": "user", "content": t}


def a(t):
    return {"role": "assistant", "content": t}


class ProxyRoutingTests(unittest.TestCase):
    """A1: one silenced order must not silence the patient for the rest of the visit."""

    def setUp(self):
        intent.reset()
        self.addCleanup(intent.reset)

    def test_silence_is_decided_on_the_last_raw_turn(self):
        msgs = [SYS, a("Chest pain."), u("Nurse, order a CBC"), a(""), u("How long have you had it?")]
        self.assertTrue(llm_proxy.addressed_to_nurse(msgs[:3]))
        self.assertFalse(llm_proxy.addressed_to_nurse(msgs))
        self.assertFalse(llm_proxy.addressed_to_nurse([SYS, u("Nurse, order a CBC"), u("How long have you had it?")]))

    def test_staff_turns_are_not_sent_upstream(self):
        msgs = [SYS, a("Chest pain."), u("Nurse, order a CBC"), a(""), u("any fever?"), a("No doctor."),
                u("Asha ek ECG kara do"), u("Since when?")]
        out = llm_proxy.sanitize_messages(llm_proxy.strip_staff_turns(msgs, {"patientName": "Ravi"}))
        self.assertEqual([m["content"] for m in out if m["role"] == "user"], ["any fever?", "Since when?"])

    def test_answered_turn_stays(self):
        msgs = [SYS, u("Nurse, order a CBC"), a("Okay doctor."), u("Since when?")]
        self.assertEqual(llm_proxy.strip_staff_turns(msgs, {}), msgs)

    def test_context_silenced_turn_is_remembered(self):
        intent.bind_session("ch", case_id="c", patient_name="Ravi")
        intent.mark_silenced("ch", "No, she is not pregnant.")
        msgs = [SYS, u("no she is not pregnant"), u("Any other pain?")]
        out = llm_proxy.strip_staff_turns(msgs, {"patientName": "Ravi"}, "ch")
        self.assertEqual([m["content"] for m in out[1:]], ["Any other pain?"])

    def test_blank_turns(self):
        self.assertFalse(llm_proxy.addressed_to_nurse([SYS, u("Nurse, order a CBC"), u("  ")]))
        self.assertEqual(llm_proxy.last_user_text([u([{"type": "text", "text": "hi"}])]), "hi")
        self.assertEqual(llm_proxy.last_user_text("nope"), "")

    def test_conversation_lang_follows_the_two_turn_rule(self):
        hi = {"role": "system", "content": "LANGUAGE: Speak natural, everyday spoken Hindi."}
        kn1, kn2 = u("ಎಷ್ಟು ದಿನದಿಂದ ಇದೆ?"), u("ಎಲ್ಲಿ ನೋವು?")
        self.assertEqual(llm_proxy.conversation_lang([hi, u("कब से है?"), kn1]), "hi")
        self.assertEqual(llm_proxy.conversation_lang([hi, kn1, kn2]), "kn")
        self.assertEqual(llm_proxy.conversation_lang([hi, kn1, u("Nurse, order a CBC"), u(""), kn2]), "kn")
        self.assertEqual(llm_proxy.conversation_lang([hi, u("how long have you had it"), u("where is the pain and since when")]), "en")
        en = {"role": "system", "content": "x The session language is English: reply"}
        self.assertEqual(llm_proxy.conversation_lang([en, u("क्या हुआ?")]), "en")


if __name__ == "__main__":
    unittest.main()
