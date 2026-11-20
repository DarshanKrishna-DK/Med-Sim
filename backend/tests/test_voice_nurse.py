"""Tests for /voice/start (mocked Agora), nurse tools, and debrief parsing. No network."""

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

import server  # noqa: E402
import voice  # noqa: E402
import nurse  # noqa: E402
import debrief  # noqa: E402

SECRETS = {
    "AGORA_APP_ID": "a" * 32,
    "AGORA_APP_CERTIFICATE": "b" * 32,
    "AGORA_CUSTOMER_ID": "cust-id-zz",
    "AGORA_CUSTOMER_SECRET": "cust-secret-zz",
    "MURF_API_KEY": "murf-key-zz",
    "SARVAM_API_KEY": "sarvam-key-zz",
}
HDR = {"Origin": "http://localhost:5173"}


class VoiceStartTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old = {k: os.environ.get(k) for k in [*SECRETS, "PATIENT_LLM_PROVIDER", "VOICE_ASR"]}
        os.environ.update(SECRETS)
        os.environ["PATIENT_LLM_PROVIDER"] = "sarvam"
        os.environ.pop("VOICE_ASR", None)
        self.calls: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            self.calls.append(req)
            if req.url.path.endswith("/join"):
                return httpx.Response(200, json={"agent_id": "AGENT123", "status": "RUNNING"})
            if req.url.path.endswith("/leave"):
                return httpx.Response(404, json={"detail": "not found"})
            return httpx.Response(200, json={})

        self._orig = voice._client_factory
        voice._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        voice._client_factory = self._orig
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_start_builds_murf_openai_sarvam_body_and_hides_keys(self) -> None:
        r = self.client.post("/voice/start", headers=HDR, json={
            "caseId": "case 1", "systemPrompt": "You are Raj.", "initialLine": "Hi doc", "gender": "F"})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(set(data), {"appId", "channel", "uid", "token", "agentUid", "agentId"})
        self.assertEqual(data["agentId"], "AGENT123")
        self.assertTrue(data["channel"].startswith("medsim-case1-"))
        self.assertTrue(100000 <= data["uid"] <= 999999)
        for secret in SECRETS.values():
            if secret != SECRETS["AGORA_APP_ID"]:
                self.assertNotIn(secret, r.text)
        join = self.calls[0]
        self.assertTrue(join.headers["authorization"].startswith("Basic "))
        body = json.loads(join.content)["properties"]
        self.assertEqual(body["tts"]["vendor"], "murf")
        self.assertIn(body["tts"]["params"]["voiceId"], voice.PATIENT_VOICE_POOLS["F"])
        # Same case id always maps to the same voice.
        self.assertEqual(voice._voice_for("F", "case-x"), voice._voice_for("F", "case-x"))
        self.assertEqual(voice._voice_for("nurse"), "en-IN-anisha")
        self.assertEqual(body["llm"]["style"], "openai")
        self.assertIn("sarvam.ai", body["llm"]["url"])
        self.assertEqual(body["asr"]["vendor"], "sarvam")
        self.assertEqual(body["remote_rtc_uids"], [str(data["uid"])])
        self.assertEqual(body["agent_rtc_uid"], "900001")
        self.assertEqual(body["llm"]["system_messages"][0]["content"], "You are Raj.")
        self.assertEqual(body["llm"]["greeting_message"], "Hi doc")

    def test_join_has_static_filler_words(self) -> None:
        r = self.client.post("/voice/start", headers=HDR, json={
            "caseId": "c", "systemPrompt": "x", "initialLine": "y", "gender": "M"})
        self.assertEqual(r.status_code, 200, r.text)
        fw = json.loads(self.calls[0].content)["properties"]["filler_words"]
        self.assertTrue(fw["enable"])
        self.assertEqual(fw["trigger"]["fixed_time_config"]["response_wait_ms"], 1100)
        self.assertEqual(fw["content"]["mode"], "static")
        self.assertNotIn("generated_config", fw["content"])
        self.assertEqual(fw["content"]["static_config"]["selection_rule"], "shuffle")
        self.assertIn("Hmm...", fw["content"]["static_config"]["phrases"])

    def test_join_retries_without_filler_when_rejected(self) -> None:
        calls: list[dict] = []

        def handler(req: httpx.Request) -> httpx.Response:
            body = json.loads(req.content)
            calls.append(body)
            if "filler_words" in body["properties"]:
                return httpx.Response(400, json={"reason": "InvalidFieldValue: filler_words not supported"})
            return httpx.Response(200, json={"agent_id": "AGENT9"})

        voice._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        r = self.client.post("/voice/start", headers=HDR, json={
            "caseId": "c", "systemPrompt": "x", "initialLine": "y", "gender": "M"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("filler_words", calls[1]["properties"])

    def test_ares_asr_when_voice_asr_ares(self) -> None:
        os.environ["VOICE_ASR"] = "ares"
        r = self.client.post("/voice/start", headers=HDR, json={
            "caseId": "c", "systemPrompt": "x", "initialLine": "y", "gender": "M"})
        self.assertEqual(r.status_code, 200, r.text)
        body = json.loads(self.calls[0].content)["properties"]
        self.assertEqual(body["asr"]["vendor"], "ares")

    def test_missing_config_is_503_without_values(self) -> None:
        os.environ.pop("MURF_API_KEY")
        r = self.client.post("/voice/start", headers=HDR, json={
            "caseId": "c", "systemPrompt": "x", "initialLine": "y", "gender": "M"})
        self.assertEqual(r.status_code, 503)
        self.assertIn("MURF_API_KEY", r.text)

    def test_agora_error_is_502_with_body(self) -> None:
        voice._client_factory = lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda req: httpx.Response(400, json={"detail": "bad", "reason": "nope"})))
        r = self.client.post("/voice/start", headers=HDR, json={
            "caseId": "c", "systemPrompt": "x", "initialLine": "y", "gender": "M"})
        self.assertEqual(r.status_code, 502)
        self.assertIn("nope", r.text)

    def test_stop_is_idempotent(self) -> None:
        r = self.client.post("/voice/stop", headers=HDR, json={"agentId": "gone"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])


def _req(**over) -> nurse.NurseActRequest:
    base = {
        "caseId": "c", "utterance": "x",
        "patient": {"name": "A", "allergies": "Penicillin (rash)",
                    "anamnesis": [{"question": "Current medications?", "answer": "warfarin"}],
                    "testResults": [{"testId": "cbc", "result": "WBC 14", "abnormal": True}]},
        "catalog": {"tests": [{"id": "cbc", "name": "Complete Blood Count", "category": "lab"},
                              {"id": "crp", "name": "C-Reactive Protein", "category": "lab"}],
                    "medications": [{"id": "amoxicillin", "name": "Amoxicillin", "dosing": "500mg TID"},
                                    {"id": "ibuprofen", "name": "Ibuprofen"},
                                    {"id": "azithromycin", "name": "Azithromycin"}]},
        "alreadyOrdered": [], "alreadyPrescribed": [],
    }
    base.update(over)
    return nurse.NurseActRequest(**base)


class NurseToolTests(unittest.TestCase):
    def test_find_in_catalog(self) -> None:
        st = nurse.NurseState(_req())
        self.assertEqual(st.find_in_catalog("blood count", "test")["matches"][0]["id"], "cbc")
        self.assertEqual(st.find_in_catalog("amoxicillin", "medication")["matches"][0]["id"], "amoxicillin")
        self.assertFalse(st.find_in_catalog("zzz", "test")["ok"])

    def test_order_test_uses_case_result_or_default(self) -> None:
        st = nurse.NurseState(_req())
        a = st.order_test("cbc")
        self.assertEqual((a["result"], a["abnormal"]), ("WBC 14", True))
        b = st.order_test("crp")
        self.assertEqual((b["result"], b["abnormal"]), ("Within normal limits", False))
        self.assertFalse(st.order_test("nope")["ok"])
        self.assertEqual(st.new_tests, ["cbc", "crp"])
        self.assertTrue(st.order_test("cbc")["alreadyOrdered"])

    def test_allergy_refuses_prescribe(self) -> None:
        st = nurse.NurseState(_req())
        chk = st.check_allergies_and_interactions("amoxicillin")
        self.assertFalse(chk["safe"])
        res = st.prescribe("amoxicillin", "500mg", "5d")
        self.assertFalse(res["ok"])
        self.assertTrue(res["refused"])
        self.assertEqual(st.new_rx, [])
        self.assertTrue(st.prescribe("azithromycin", "500mg", "3d")["ok"])
        self.assertEqual(st.new_rx[0]["medicationId"], "azithromycin")

    def test_interaction_warning_from_anamnesis(self) -> None:
        st = nurse.NurseState(_req(patient={"allergies": "none", "anamnesis": [
            {"question": "Current medications?", "answer": "warfarin"}]}))
        chk = st.check_allergies_and_interactions("ibuprofen")
        self.assertTrue(chk["safe"])
        self.assertTrue(chk["warnings"])

    def test_follow_up(self) -> None:
        st = nurse.NurseState(_req())
        self.assertTrue(st.schedule_follow_up(7, "recheck")["ok"])
        self.assertEqual(st.follow_up, {"inDays": 7, "reason": "recheck"})
        self.assertFalse(st.schedule_follow_up("soon", "x")["ok"])

    def test_unknown_tool_and_bad_args(self) -> None:
        st = nurse.NurseState(_req())
        self.assertFalse(st.execute("rm_rf", {})["ok"])
        self.assertFalse(st.execute("order_test", {"wrong": 1})["ok"])


class DevOriginTests(unittest.TestCase):
    def test_any_local_port_is_trusted_but_foreign_origins_are_not(self) -> None:
        self.assertTrue(server._is_dev_origin("http://localhost:5181"))
        self.assertTrue(server._is_dev_origin("http://127.0.0.1:5190"))
        self.assertFalse(server._is_dev_origin("http://evil.example.com"))
        self.assertFalse(server._is_dev_origin("http://localhost.evil.com:5173"))
        self.assertFalse(server._is_dev_origin("https://localhost:5173.evil.com"))


class DebriefTests(unittest.TestCase):
    def test_coerce_and_clamp(self) -> None:
        raw = debrief.parse_json_object(
            '<think>x</think>```json\n{"score":130,"domains":[{"name":"A","score":"80","notes":"n"}],"summary":"s"}\n```')
        out = debrief.coerce_debrief(raw, ["A"])
        self.assertEqual(out.score, 100)
        self.assertEqual(out.domains[0].score, 80)

    def test_string_lists_are_split_into_lines_not_characters(self) -> None:
        raw = {
            "score": 70,
            "domains": [{"name": "History", "score": 70, "notes": "ok"}],
            "strengths": "- Asked about allergies\n- Clear explanation",
            "improvements": "Check vitals earlier",
        }
        out = debrief.coerce_debrief(raw, ["History"])
        self.assertEqual(out.strengths, ["Asked about allergies", "Clear explanation"])
        self.assertEqual(out.improvements, ["Check vitals earlier"])

    def test_no_domains_raises(self) -> None:
        with self.assertRaises(ValueError):
            debrief.coerce_debrief({"score": 5}, [])


if __name__ == "__main__":
    unittest.main()
