"""The Agora join body asks for runtime metrics + error messages over RTM."""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class JoinMetricsTest(unittest.TestCase):
    def test_join_requests_metrics_and_errors_over_rtm(self):
        os.environ.setdefault("SARVAM_API_KEY", "test-key")
        import voice

        req = voice.VoiceStartRequest(caseId="comm-001", systemPrompt="p", initialLine="hi")
        body = voice.build_join_body(req, "chan", 123456, "tok", "murf-key")
        params = body["properties"]["parameters"]
        self.assertEqual(params["data_channel"], "rtm")
        self.assertTrue(params["enable_metrics"])
        self.assertTrue(params["enable_error_message"])
        self.assertTrue(body["properties"]["advanced_features"]["enable_rtm"])


if __name__ == "__main__":
    unittest.main()
