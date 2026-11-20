"""Hindi / Kannada support: locale -> Murf voice mapping, prompt language blocks,
filler phrases, greeting translation and the /voice/start + /voice/tts bodies. No network."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import coach  # noqa: E402
import lang  # noqa: E402
import nurse  # noqa: E402
import server  # noqa: E402
import teacher  # noqa: E402
import voice  # noqa: E402

SECRETS = {
    "AGORA_APP_ID": "a" * 32,
    "AGORA_APP_CERTIFICATE": "b" * 32,
    "AGORA_CUSTOMER_ID": "cust-id-zz",
    "AGORA_CUSTOMER_SECRET": "cust-secret-zz",
    "MURF_API_KEY": "murf-key-zz",
    "SARVAM_API_KEY": "sarvam-key-zz",
}
HDR = {"Origin": "http://localhost:5173"}

# Voices verified (2026-11-21) to list the locale in Murf's supportedLocales.
HI_OK = {
    "en-IN-aarav", "en-IN-nikhil", "en-IN-samar", "en-IN-abhinav", "en-IN-eashwar",
    "en-IN-priya", "en-IN-pooja", "en-IN-anusha", "en-IN-isha", "en-IN-arohi", "en-IN-alia", "en-IN-anisha",
}
KN_OK = {
    "en-IN-nikhil", "en-IN-samar", "hi-IN-chirag", "hi-IN-pranav",
    "en-IN-pooja", "hi-IN-poonam", "hi-IN-neeta", "hi-IN-jaya", "hi-IN-rachna", "kn-IN-harshitha",
}


class LangUnitTests(unittest.TestCase):
    def test_norm_and_locale(self) -> None:
        self.assertEqual(lang.norm_lang("hi-IN"), "hi")
        self.assertEqual(lang.norm_lang("KN"), "kn")
        self.assertEqual(lang.norm_lang("en-IN"), "en")
        self.assertEqual(lang.norm_lang("fr"), "en")
        self.assertEqual(lang.norm_lang(None), "en")
        self.assertEqual(lang.locale_for("kn"), "kn-IN")
        self.assertEqual(lang.locale_for(None), "en-IN")

    def test_every_voice_supports_its_locale(self) -> None:
        for lg, ok in (("hi", HI_OK), ("kn", KN_OK)):
            for _g, pool in lang.PATIENT_VOICE_POOLS[lg].items():
                for v in pool:
                    self.assertIn(v, ok, f"{v} not verified for {lg}")
            self.assertIn(lang.nurse_voice(lg), ok)

    def test_voice_stable_and_gendered(self) -> None:
        for lg in ("en", "hi", "kn"):
            a = lang.pick_patient_voice(lg, "F", "case-1")
            self.assertEqual(a, lang.pick_patient_voice(lg, "F", "case-1"))
            self.assertIn(a, lang.PATIENT_VOICE_POOLS[lg]["F"])
            self.assertIn(lang.pick_patient_voice(lg, "M", "case-1"), lang.PATIENT_VOICE_POOLS[lg]["M"])

    def test_fillers_per_language(self) -> None:
        self.assertIn("हाँ डॉक्टर...", lang.fillers("hi"))
        self.assertIn("एक मिनट...", lang.fillers("hi"))
        self.assertIn("ಹೌದು ಡಾಕ್ಟರ್...", lang.fillers("kn"))
        self.assertIn("ಒಂದು ನಿಮಿಷ...", lang.fillers("kn"))
        self.assertIn("Haan, doctor...", lang.fillers("en"))
        for p in lang.fillers("hi"):
            self.assertTrue(lang.has_script(p, "hi"), p)
        for p in lang.fillers("kn"):
            self.assertTrue(lang.has_script(p, "kn"), p)
        self.assertEqual(voice.filler_block("kn")["content"]["static_config"]["phrases"], lang.fillers("kn"))

    def test_language_blocks(self) -> None:
        self.assertEqual(lang.language_block("en"), "")
        hi = lang.language_block("hi", female=True)
        self.assertIn("Devanagari", hi)
        self.assertIn("feminine Hindi", hi)
        self.assertIn("BP, sugar, test", hi)
        self.assertIn("language the doctor last spoke", hi)
        self.assertIn("masculine Hindi", lang.language_block("hi", female=False))
        kn = lang.language_block("kn")
        self.assertIn("Kannada script", kn)
        self.assertNotIn("feminine", kn)
        self.assertIn("JSON", lang.language_block("hi", role="coach"))
        self.assertIn("lesson", lang.language_block("kn", role="teacher"))
        self.assertEqual(lang.with_language("X", "en"), "X")
        self.assertTrue(lang.with_language("X", "hi", role="nurse").startswith("X\n\n"))

    def test_failure_message_per_language(self) -> None:
        self.assertTrue(lang.has_script(lang.failure_message("hi"), "hi"))
        self.assertTrue(lang.has_script(lang.failure_message("kn"), "kn"))
        self.assertIn("didn't catch", lang.failure_message("en"))

    def test_voice_for_ignores_english_override_for_indic(self) -> None:
        old = os.environ.get("MURF_NURSE_VOICE")
        os.environ["MURF_NURSE_VOICE"] = "en-US-custom"
        try:
            self.assertEqual(voice._voice_for("nurse"), "en-US-custom")
            self.assertEqual(voice._voice_for("nurse", None, "kn"), "kn-IN-harshitha")
            self.assertEqual(voice._voice_for("nurse", None, "hi"), "en-IN-anisha")
        finally:
            if old is None:
                os.environ.pop("MURF_NURSE_VOICE", None)
            else:
                os.environ["MURF_NURSE_VOICE"] = old

    def test_rule_alerts_localised(self) -> None:
        req = coach.CoachCheckRequest(
            event=coach.CoachEvent(kind="prescription", detail="Amoxicillin"),
            patient=coach.CoachPatient(allergies="penicillin"),
            lang="hi",
        )
        a = coach.rule_alert(req)
        self.assertIsNotNone(a)
        self.assertTrue(lang.has_script(a.explanation, "hi"))
        req.lang = "kn"
        self.assertTrue(lang.has_script(coach.rule_alert(req).title, "kn"))
        req.lang = None
        self.assertEqual(coach.rule_alert(req).title, "Allergy conflict")

    def test_lesson_prompt_and_cache_key(self) -> None:
        self.assertNotIn("LANGUAGE:", teacher.lesson_system("student", "en"))
        self.assertIn("Kannada", teacher.lesson_system("student", "kn"))
        self.assertIn("feminine Hindi", teacher.lesson_system("intern", "hi"))
        self.assertNotEqual(teacher.cache_key("ECG", "student", "hi"), teacher.cache_key("ECG", "student"))
        self.assertEqual(teacher.cache_key("ECG", "student", "en"), teacher.cache_key("ECG", "student"))

    def test_nurse_fallback_confirmation_localised(self) -> None:
        class St:
            new_tests: list = []
            new_rx: list = []
            follow_up = None
            tests: dict = {}
            meds: dict = {}

        self.assertTrue(lang.has_script(nurse._fallback_confirmation(St(), [], "hi"), "hi"))
        self.assertTrue(lang.has_script(nurse._fallback_confirmation(St(), [], "kn"), "kn"))


class VoiceLocaleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old = {k: os.environ.get(k) for k in [*SECRETS, "PATIENT_LLM_PROVIDER", "VOICE_ASR", "PUBLIC_URL"]}
        os.environ.update(SECRETS)
        os.environ["PATIENT_LLM_PROVIDER"] = "sarvam"
        os.environ.pop("VOICE_ASR", None)
        os.environ.pop("PUBLIC_URL", None)
        self.sent: list[dict] = []

        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.path.endswith("/join"):
                self.sent.append(json.loads(req.content))
                return httpx.Response(200, json={"agent_id": "A1"})
            if req.url.host.endswith("murf.ai"):
                self.sent.append(json.loads(req.content))
                return httpx.Response(200, content=b"ID3audio")
            return httpx.Response(200, json={})

        self._orig = voice._client_factory
        voice._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self._orig_tr = lang.translate_line

        async def fake_translate(text, lg):
            return {"hi": "मुझे सीने में दर्द है", "kn": "ನನಗೆ ಎದೆ ನೋವು ಇದೆ"}.get(lang.norm_lang(lg), text)

        lang.translate_line = fake_translate
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        voice._client_factory = self._orig
        lang.translate_line = self._orig_tr
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _start(self, locale, gender: str = "F") -> dict:
        body = {"caseId": "c-77", "systemPrompt": "sp", "initialLine": "Chest pain", "gender": gender}
        if locale:
            body["locale"] = locale
        r = self.client.post("/voice/start", headers=HDR, json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return self.sent[-1]["properties"]

    def test_start_hindi(self) -> None:
        p = self._start("hi-IN")
        self.assertEqual(p["tts"]["params"]["locale"], "hi-IN")
        self.assertIn(p["tts"]["params"]["voiceId"], HI_OK)
        self.assertEqual(p["asr"]["params"]["language"], "unknown")
        self.assertEqual(p["llm"]["greeting_message"], "मुझे सीने में दर्द है")
        self.assertIn("हाँ डॉक्टर...", p["filler_words"]["content"]["static_config"]["phrases"])
        self.assertTrue(lang.has_script(p["llm"]["failure_message"], "hi"))

    def test_start_kannada(self) -> None:
        for g in ("M", "F"):
            p = self._start("kn-IN", g)
            self.assertEqual(p["tts"]["params"]["locale"], "kn-IN")
            self.assertIn(p["tts"]["params"]["voiceId"], KN_OK)
            self.assertEqual(p["llm"]["greeting_message"], "ನನಗೆ ಎದೆ ನೋವು ಇದೆ")
            self.assertIn("ಹೌದು ಡಾಕ್ಟರ್...", p["filler_words"]["content"]["static_config"]["phrases"])

    def test_start_english_unchanged(self) -> None:
        p = self._start(None)
        self.assertEqual(p["tts"]["params"]["locale"], "en-IN")
        self.assertEqual(p["llm"]["greeting_message"], "Chest pain")
        self.assertIn("Haan, doctor...", p["filler_words"]["content"]["static_config"]["phrases"])

    def test_tts_locale_and_voice(self) -> None:
        r = self.client.post("/voice/tts", headers=HDR, json={"text": "ठीक है डॉक्टर", "voice": "nurse", "locale": "hi-IN"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sent[-1]["locale"], "hi-IN")
        self.assertIn(self.sent[-1]["voiceId"], HI_OK)
        r = self.client.post("/voice/tts", headers=HDR, json={"text": "ಸರಿ ಡಾಕ್ಟರ್", "voice": "nurse", "locale": "kn-IN"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sent[-1]["locale"], "kn-IN")
        self.assertEqual(self.sent[-1]["voiceId"], "kn-IN-harshitha")
        self.client.post("/voice/tts", headers=HDR, json={"text": "Okay doctor"})
        self.assertEqual(self.sent[-1]["locale"], "en-US")
        self.assertEqual(self.sent[-1]["voiceId"], "en-IN-anisha")


if __name__ == "__main__":
    unittest.main()
