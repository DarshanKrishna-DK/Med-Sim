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


TA_OK = {
    "en-IN-samar", "hi-IN-chirag", "hi-IN-pranav", "ta-IN-karthikeyan", "en-IN-pooja", "hi-IN-poonam",
    "hi-IN-neeta", "hi-IN-jaya", "hi-IN-rachna", "en-IN-anisha",
}
TE_OK = {
    "en-IN-samar", "hi-IN-chirag", "hi-IN-pranav", "en-IN-pooja", "en-IN-alia", "hi-IN-poonam", "hi-IN-neeta",
    "hi-IN-jaya", "hi-IN-rachna", "hi-IN-ayushi", "en-IN-anisha",
}
MR_OK = {
    "en-IN-samar", "en-IN-abhinav", "hi-IN-chirag", "hi-IN-pranav", "mr-IN-prathamesh", "hi-IN-poonam",
    "hi-IN-neeta", "hi-IN-jaya", "hi-IN-rachna", "mr-IN-prajakta", "en-IN-anisha",
}
BN_OK = {
    "hi-IN-chirag", "hi-IN-pranav", "bn-IN-subhankar", "hi-IN-poonam", "hi-IN-neeta", "hi-IN-jaya",
    "hi-IN-rachna", "bn-IN-debarati", "en-IN-anisha",
}
NEW_LANGS = {"ta": TA_OK, "te": TE_OK, "mr": MR_OK, "bn": BN_OK}
SAMPLE_TEXT = {"ta": "வணக்கம் டாக்டர்", "te": "నమస్కారం డాక్టర్", "mr": "नमस्कार डॉक्टर", "bn": "নমস্কার ডাক্তারবাবু"}


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

    def test_new_languages_voices_and_locales(self) -> None:
        self.assertEqual(lang.LANGS, ("en", "hi", "kn", "ta", "te", "mr", "bn"))
        for lg, ok in NEW_LANGS.items():
            self.assertEqual(lang.locale_for(f"{lg}-IN"), f"{lg}-IN")
            self.assertEqual(lang.norm_lang(lg.upper()), lg)
            for g in ("M", "F"):
                self.assertTrue(lang.PATIENT_VOICE_POOLS[lg][g], f"{lg} {g} pool empty")
                for v in lang.PATIENT_VOICE_POOLS[lg][g]:
                    self.assertIn(v, ok, f"{v} not verified for {lg}")
            self.assertIn(lang.nurse_voice(lg), ok)
            self.assertEqual(len(lang.fillers(lg)), len(lang.fillers("hi")))
            for p in lang.fillers(lg):
                self.assertTrue(lang.has_script(p, lg), p)
            self.assertTrue(lang.has_script(lang.failure_message(lg), lg))
            self.assertTrue(lang.has_script(SAMPLE_TEXT[lg], lg))
            self.assertFalse(lang.has_script("hello", lg))
        self.assertEqual(lang.nurse_voice("mr"), "mr-IN-prajakta")
        self.assertEqual(lang.nurse_voice("bn"), "bn-IN-debarati")
        self.assertFalse(lang.has_script("வணக்கம்", "hi"))

    def test_new_language_blocks(self) -> None:
        for lg, script in (("ta", "Tamil script"), ("te", "Telugu script"), ("mr", "Devanagari script"), ("bn", "Bengali script")):
            b = lang.language_block(lg, female=True)
            self.assertIn(script, b)
            self.assertIn("BP, sugar, test", b)
            self.assertIn(f"Reply in {lang.LANG_NAMES[lg]} by default", b)
            self.assertIn("MIXED LANGUAGES", b)
            self.assertIn("JSON", lang.language_block(lg, role="coach"))
            self.assertIn("lesson", lang.language_block(lg, role="teacher"))
        self.assertIn("feminine Marathi", lang.language_block("mr", female=True))
        self.assertIn("masculine Marathi", lang.language_block("mr", female=False))
        self.assertNotIn("Hindi verb", lang.language_block("ta"))
        self.assertIn("Tamil", teacher.lesson_system("student", "ta"))

    def test_new_language_nurse_and_coach_text(self) -> None:
        class St:
            new_tests: list = []
            new_rx: list = []
            follow_up = None
            tests: dict = {}
            meds: dict = {}

        for lg in NEW_LANGS:
            self.assertTrue(lang.has_script(nurse._fallback_confirmation(St(), [], lg), lg))
            req = coach.CoachCheckRequest(
                event=coach.CoachEvent(kind="prescription", detail="Amoxicillin"),
                patient=coach.CoachPatient(allergies="penicillin"),
                lang=lg,
            )
            a = coach.rule_alert(req)
            self.assertTrue(lang.has_script(a.title, lg), lg)
            self.assertTrue(lang.has_script(a.explanation, lg), lg)

    def test_voice_stable_and_gendered(self) -> None:
        for lg in lang.LANGS:
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
        self.assertIn("MIXED LANGUAGES", lang.language_block("en"))
        self.assertIn("Indian English", lang.language_block("en"))
        hi = lang.language_block("hi", female=True)
        self.assertIn("Devanagari", hi)
        self.assertIn("feminine Hindi", hi)
        self.assertIn("BP, sugar, test", hi)
        self.assertIn("Reply in Hindi by default", hi)
        self.assertIn("masculine Hindi", lang.language_block("hi", female=False))
        kn = lang.language_block("kn")
        self.assertIn("Kannada script", kn)
        self.assertNotIn("feminine", kn)
        self.assertIn("JSON", lang.language_block("hi", role="coach"))
        self.assertIn("lesson", lang.language_block("kn", role="teacher"))
        self.assertTrue(lang.with_language("X", "en").startswith("X\n\nMIXED LANGUAGES"))
        self.assertTrue(lang.with_language("X", "hi", role="nurse").startswith("X\n\n"))

    def test_failure_message_per_language(self) -> None:
        self.assertTrue(lang.has_script(lang.failure_message("hi"), "hi"))
        self.assertTrue(lang.has_script(lang.failure_message("kn"), "kn"))
        self.assertEqual(lang.failure_message("en"), "Hmm, sorry, say that once more?")

    def test_failure_and_retry_lines_sound_human(self) -> None:
        doctor = ("doctor", "डॉक्टर", "ಡಾಕ್ಟರ್", "டாக்டர்", "డాక్టర్", "ডাক্তার")
        robotic = ("didn't", "did not", "catch that", "error", "system", "सुन नहीं")
        for lg in lang.LANGS:
            lines = [lang.failure_message(lg), *lang.NATURAL_RETRY_LINES[lg]]
            self.assertGreaterEqual(len(lang.NATURAL_RETRY_LINES[lg]), 3, lg)
            for line in lines:
                low = line.lower()
                self.assertFalse([w for w in doctor if w in low], f"{lg}: {line}")
                self.assertFalse([w for w in robotic if w in low], f"{lg}: {line}")
                self.assertLessEqual(len(line), 80, f"{lg}: {line}")
                if lg != "en":
                    self.assertTrue(lang.has_script(line, lg), f"{lg}: {line}")
            self.assertIn(lang.natural_retry_line(lg), lang.NATURAL_RETRY_LINES[lg])

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


class StaffVoiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old = {k: v for k, v in os.environ.items() if k.startswith("MURF_")}
        for k in self._old:
            os.environ.pop(k)

    def tearDown(self) -> None:
        for k in [k for k in os.environ if k.startswith("MURF_")]:
            os.environ.pop(k)
        os.environ.update(self._old)

    def test_staff_voices_are_distinct_and_support_the_locale(self) -> None:
        for lg in lang.LANGS:
            voices = [lang.nurse_voice(lg), *(lang.staff_voice(r, lg) for r in lang.STAFF_ROLES)]
            self.assertEqual(len(set(voices)), 5, f"{lg}: {voices}")
            ok = {"hi": HI_OK | {"hi-IN-rachna", "hi-IN-chirag", "hi-IN-pranav"}, "kn": KN_OK, **NEW_LANGS}.get(lg)
            for v in voices if ok else ():
                self.assertIn(v, ok, f"{v} not verified for {lg}")

    def test_nurse_and_pharmacist_are_never_a_patient(self) -> None:
        for lg in lang.LANGS:
            for pool in lang.PATIENT_VOICE_POOLS[lg].values():
                self.assertNotIn(lang.nurse_voice(lg), pool, lg)
                self.assertNotIn(lang.staff_voice("pharmacist", lg), pool, lg)
                self.assertGreaterEqual(len(pool), 2)

    def test_staff_voice_steps_aside_for_the_patient(self) -> None:
        for lg in lang.LANGS:
            for role in lang.STAFF_ROLES:
                patient = lang.STAFF_VOICES[role][lg]
                v = lang.staff_voice(role, lg, avoid=patient)
                if lg == "bn" and role != "pharmacist":
                    continue  # documented gap: Murf has three male Bengali voices
                self.assertNotEqual(v, patient, f"{role} {lg}")
                others = [lang.staff_voice(r, lg) for r in lang.STAFF_ROLES if r != role]
                self.assertNotIn(v, [lang.nurse_voice(lg), *others])

    def test_env_overrides(self) -> None:
        os.environ["MURF_LAB_VOICE"] = "en-IN-x"
        os.environ["MURF_LAB_VOICE_KN"] = "kn-IN-x"
        self.assertEqual(lang.staff_voice("lab", "en"), "en-IN-x")
        self.assertEqual(lang.staff_voice("lab", "kn"), "kn-IN-x")
        self.assertEqual(lang.staff_voice("lab", "ta"), "en-IN-samar")

    def test_majority_script_picks_the_voice_language(self) -> None:
        req = lambda **k: voice.tts_voice_and_locale(voice.VoiceTtsRequest(**k))  # noqa: E731
        self.assertEqual(req(text="Okay doctor"), ("en-IN-anisha", "en-IN"))
        self.assertEqual(req(text="Okay doctor", lang="kn"), ("kn-IN-harshitha", "kn-IN"))
        self.assertEqual(req(text="ECG और CBC order कर दिया है", locale="en-IN")[1], "hi-IN")
        self.assertEqual(req(text="ಸರಿ ಡಾಕ್ಟರ್, ECG ಕಳಿಸಿದೆ", lang="hi")[1], "kn-IN")
        self.assertEqual(req(text="ठीक आहे डॉक्टर", lang="mr")[1], "mr-IN")
        self.assertEqual(req(text="ठीक आहे, मी पाठवते")[1], "mr-IN")
        self.assertEqual(req(text="Sending the CBC and the LFT to the lab now, haan ठीक", lang="en")[1], "en-IN")
        self.assertEqual(req(text="Release.", voice="pharmacist"), ("hi-IN-rachna", "en-IN"))
        self.assertEqual(req(text="রিপোর্ট তৈরি", voice="lab"), ("bn-IN-subhankar", "bn-IN"))

    def test_speech_and_turn_language(self) -> None:
        self.assertEqual(lang.speech_lang("", "ta"), "ta")
        self.assertEqual(lang.turn_lang("how long have you had it", "hi"), "en")
        self.assertIsNone(lang.turn_lang("kab se dard hai", "hi"))
        self.assertIsNone(lang.turn_lang("", "hi"))
        self.assertEqual(lang.turn_lang("ನೋವು ಇದೆ", "hi"), "kn")


class SharedPromptTests(unittest.TestCase):
    def test_mixed_speech_matches_the_browser_copy(self) -> None:
        ts = (_B.parent / "src" / "voice" / "language.ts").read_text(encoding="utf-8")
        for half in lang.MIXED_SPEECH.split("REPLYING:"):
            self.assertIn(half.strip(), ts)

    def test_spoken_lines_cover_every_language(self) -> None:
        import agent_runtime
        import agent_toolsets  # noqa: F401
        import followup_tools

        tables = [agent_runtime.DEFAULT_FALLBACK, followup_tools.FALLBACK, followup_tools.EMERGENCY_FALLBACK,
                  *followup_tools.FILLERS.values(), agent_runtime.get("viva-examiner").fallback, coach._EXPLAIN_DEFAULT]
        for kind in ("receptionist", "teacher"):
            tables += agent_runtime.get(kind).fillers.values()
        for t in tables:
            self.assertEqual(set(t), set(lang.LANGS), t)
            for lg, line in t.items():
                if lg != "en":
                    self.assertTrue(lang.has_script(line, lg), f"{lg}: {line}")
        for lg, line in followup_tools.EMERGENCY_FALLBACK.items():
            self.assertIn("108", line, lg)
        for lg, lines in coach.HINT_LINES.items():
            self.assertEqual(len(lines), 4, lg)
        self.assertEqual(set(coach.HINT_LINES), set(lang.LANGS))


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

    def test_start_new_languages(self) -> None:
        for lg, ok in NEW_LANGS.items():
            for g in ("M", "F"):
                p = self._start(f"{lg}-IN", g)
                self.assertEqual(p["tts"]["params"]["locale"], f"{lg}-IN")
                self.assertIn(p["tts"]["params"]["voiceId"], ok)
                self.assertEqual(p["asr"]["params"]["language"], "unknown")
                self.assertTrue(lang.has_script(p["llm"]["failure_message"], lg))
                phrases = p["filler_words"]["content"]["static_config"]["phrases"]
                self.assertEqual(phrases, lang.fillers(lg))

    def test_tts_new_language_nurse(self) -> None:
        for lg, ok in NEW_LANGS.items():
            body = {"text": SAMPLE_TEXT[lg], "voice": "nurse", "locale": f"{lg}-IN"}
            r = self.client.post("/voice/tts", headers=HDR, json=body)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self.sent[-1]["locale"], f"{lg}-IN")
            self.assertIn(self.sent[-1]["voiceId"], ok)

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
        self.assertEqual(self.sent[-1]["locale"], "en-IN")
        self.assertEqual(self.sent[-1]["voiceId"], "en-IN-anisha")


if __name__ == "__main__":
    unittest.main()
