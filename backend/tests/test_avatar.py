"""Avatar option of /voice/start (mocked Agora). No network."""

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

ENV = {
    "AGORA_APP_ID": "a" * 32,
    "AGORA_APP_CERTIFICATE": "b" * 32,
    "AGORA_CUSTOMER_ID": "cust",
    "AGORA_CUSTOMER_SECRET": "sec",
    "MURF_API_KEY": "murf-key-zz",
    "SARVAM_API_KEY": "sarvam-key-zz",
    "PATIENT_LLM_PROVIDER": "sarvam",
}
AV = ["AVATAR_VENDOR", "AVATAR_API_KEY", "AVATAR_ID", "AVATAR_QUALITY"]
HDR = {"Origin": "http://localhost:5173"}


class AvatarTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old = {k: os.environ.get(k) for k in [*ENV, *AV, "VOICE_ASR"]}
        os.environ.update(ENV)
        os.environ.pop("VOICE_ASR", None)
        for k in AV:
            os.environ.pop(k, None)
        self.calls: list[dict] = []
        self.reject_avatar = False
        self._orig = voice._client_factory

        def handler(req: httpx.Request) -> httpx.Response:
            body = json.loads(req.content)
            self.calls.append(body)
            if self.reject_avatar and "avatar" in body["properties"]:
                return httpx.Response(400, json={"reason": "InvalidAvatar"})
            return httpx.Response(200, json={"agent_id": "AG1"})

        voice._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        voice._client_factory = self._orig
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _start(self, case: str = "teacher", **extra):
        return self.client.post("/voice/start", headers=HDR, json={
            "caseId": case, "systemPrompt": "x", "initialLine": "y", **extra})

    def _enable(self, vendor: str = "anam") -> None:
        os.environ.update({"AVATAR_VENDOR": vendor, "AVATAR_API_KEY": "av-key-zz", "AVATAR_ID": "face1"})

    def test_off_without_env(self) -> None:
        r = self._start(avatar=True)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("avatar", self.calls[0]["properties"])
        self.assertNotIn("avatarUid", r.json())

    def test_on_for_teacher_by_default(self) -> None:
        self._enable()
        r = self._start()
        self.assertEqual(r.json()["avatarUid"], voice.AVATAR_UID)
        av = self.calls[0]["properties"]["avatar"]
        self.assertEqual(av["vendor"], "anam")
        self.assertTrue(av["enable"])
        self.assertEqual(av["params"]["agora_uid"], str(voice.AVATAR_UID))
        self.assertEqual(av["params"]["avatar_id"], "face1")
        self.assertTrue(av["params"]["agora_token"])
        self.assertNotIn("av-key-zz", r.text)

    def test_patient_needs_explicit_request(self) -> None:
        self._enable()
        self._start("case1")
        self.assertNotIn("avatar", self.calls[0]["properties"])
        self._start("case1", avatar=True)
        self.assertIn("avatar", self.calls[1]["properties"])
        self._start("teacher", avatar=False)
        self.assertNotIn("avatar", self.calls[2]["properties"])

    def test_sample_rate_override(self) -> None:
        self._enable("akool")
        self._start()
        self.assertEqual(self.calls[0]["properties"]["tts"]["params"]["sample_rate"], 16000)
        self._enable("liveavatar")
        self._start()
        self.assertEqual(self.calls[1]["properties"]["tts"]["params"]["sample_rate"], 24000)

    def test_retry_without_avatar_on_400(self) -> None:
        self._enable()
        self.reject_avatar = True
        r = self._start()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn("avatar", self.calls[1]["properties"])
        self.assertNotIn("avatarUid", r.json())
        self.assertIn("avatarError", r.json())


if __name__ == "__main__":
    unittest.main()
