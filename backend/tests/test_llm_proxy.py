"""Tests for the patient LLM proxy + /voice/start wiring. No network."""

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

import llm_proxy  # noqa: E402
import server  # noqa: E402
import voice  # noqa: E402

KEYS = {
    "AGORA_APP_ID": "a" * 32, "AGORA_APP_CERTIFICATE": "b" * 32,
    "AGORA_CUSTOMER_ID": "cid", "AGORA_CUSTOMER_SECRET": "csec",
    "MURF_API_KEY": "murf-zz", "SARVAM_API_KEY": "sarvam-secret-zz",
}
class _Chunks(httpx.AsyncByteStream):
    def __init__(self, data: bytes):
        self.data = data

    async def __aiter__(self):
        mid = len(self.data) // 2
        yield self.data[:mid]
        yield self.data[mid:]


SSE = b'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self._old = {k: os.environ.get(k) for k in [*KEYS, "PUBLIC_URL", "PATIENT_LLM_PROVIDER"]}
        os.environ.update(KEYS)
        os.environ["PATIENT_LLM_PROVIDER"] = "sarvam"
        os.environ.pop("PUBLIC_URL", None)
        self.seen: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            if "agora.io" in req.url.host:
                return httpx.Response(200, json={"agent_id": "ag1"})
            self.seen.append(req)
            body = json.loads(req.content)
            if body.get("stream"):
                return httpx.Response(200, stream=_Chunks(SSE), headers={"content-type": "text/event-stream"})
            return httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})

        self._orig = (llm_proxy._client_factory, voice._client_factory)
        mk = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))  # noqa: E731
        llm_proxy._client_factory = mk
        voice._client_factory = mk
        self.c = TestClient(server.app)
        self.tok = llm_proxy.mint_token()
        self.auth = {"Authorization": f"Bearer {self.tok}"}

    def tearDown(self):
        llm_proxy._client_factory, voice._client_factory = self._orig
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def post(self, body, headers=None):
        return self.c.post(llm_proxy.PROXY_PATH, json=body, headers=headers if headers is not None else self.auth)

    def test_blank_user_content_replaced(self):
        msgs = [
            {"role": "system", "content": "you are a patient"},
            {"role": "user", "content": "   "},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": [{"type": "text", "text": ""}]},
        ]
        r = self.post({"model": "placeholder", "messages": msgs, "stream": False})
        self.assertEqual(r.status_code, 200)
        sent = json.loads(self.seen[-1].content)
        self.assertEqual(sent["model"], "sarvam-105b-conversations")
        users = [m for m in sent["messages"] if m["role"] == "user"]
        self.assertEqual([m["content"] for m in users], [llm_proxy.PLACEHOLDER])
        self.assertFalse([m for m in sent["messages"] if m["role"] == "assistant"])
        self.assertEqual(self.seen[-1].headers["authorization"], "Bearer sarvam-secret-zz")

    def test_auth_required(self):
        body = {"messages": [{"role": "user", "content": "hi"}]}
        self.assertEqual(self.post(body, headers={}).status_code, 401)
        self.assertEqual(self.post(body, headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertFalse(self.seen)

    def test_stream_passthrough(self):
        r = self.post({"messages": [{"role": "user", "content": ""}], "stream": True})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(r.content, SSE)
        self.assertNotIn("sarvam-secret-zz", r.text)

    def test_upstream_error_shape(self):
        def bad(req):
            return httpx.Response(400, json={"detail": "bad sarvam-secret-zz"})
        llm_proxy._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(bad))
        os.environ.pop("GROQ_API_KEY", None)
        r = self.post({"messages": [{"role": "user", "content": "x"}], "stream": True})
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json())
        self.assertNotIn("sarvam-secret-zz", r.text)

    def test_voice_start_proxy_vs_direct(self):
        req = {"caseId": "c1", "systemPrompt": "sp", "initialLine": "hi", "gender": "M"}
        hdr = {"Origin": "http://localhost:5173"}
        sent = []
        orig = voice._client_factory

        def cap(req_):
            sent.append(json.loads(req_.content))
            return httpx.Response(200, json={"agent_id": "ag1"})
        voice._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(cap))
        try:
            r = self.c.post("/voice/start", json=req, headers=hdr)
            self.assertEqual(r.status_code, 200, r.text)
            llm = sent[-1]["properties"]["llm"]
            self.assertEqual(llm["url"], "https://api.sarvam.ai/v1/chat/completions")
            self.assertNotIn("vendor", llm)
            td = sent[-1]["properties"]["turn_detection"]["config"]
            self.assertEqual(td["speech_threshold"], 0.6)
            self.assertEqual(td["start_of_speech"]["vad_config"]["interrupt_duration_ms"], 240)
            self.assertIn("didn't catch", llm["failure_message"])
            self.assertNotIn("sarvam-secret-zz", r.text)

            os.environ["PUBLIC_URL"] = "https://t.example.com/"
            r = self.c.post("/voice/start", json=req, headers=hdr)
            llm = sent[-1]["properties"]["llm"]
            self.assertEqual(llm["vendor"], "custom")
            self.assertEqual(llm["url"], "https://t.example.com" + llm_proxy.PROXY_PATH)
            self.assertTrue(llm_proxy.valid_token(llm["api_key"]))
            self.assertNotEqual(llm["api_key"], "sarvam-secret-zz")
            self.assertIn("turn_detection", sent[-1]["properties"])
            self.assertNotIn("sarvam-secret-zz", r.text)
            self.assertEqual(self.c.get("/health").json()["llm"]["patient_route"], "proxy via t.example.com")
        finally:
            voice._client_factory = orig


if __name__ == "__main__":
    unittest.main()
