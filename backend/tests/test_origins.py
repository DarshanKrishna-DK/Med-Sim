"""FRONTEND_ORIGINS trust + SPA serving."""
from __future__ import annotations

import importlib
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class FrontendOriginsTest(unittest.TestCase):
    def setUp(self):
        os.environ["FRONTEND_ORIGINS"] = "https://site.example.com/, https://b.example.com"
        sys.modules.pop("server", None)
        self.server = importlib.import_module("server")

    def tearDown(self):
        os.environ.pop("FRONTEND_ORIGINS", None)
        sys.modules.pop("server", None)

    def test_origins_trusted(self):
        s = self.server
        self.assertTrue(s._is_dev_origin("https://site.example.com"))
        self.assertTrue(s._is_dev_origin("https://b.example.com"))
        self.assertIn("https://site.example.com", s.ALLOWED_ORIGINS)
        self.assertFalse(s._is_dev_origin("https://evil.example.com"))

    def test_health_public(self):
        from fastapi.testclient import TestClient
        self.assertEqual(TestClient(self.server.app).get("/health").status_code, 200)

    def test_spa_paths_are_public_but_api_needs_trusted_origin(self):
        from fastapi.testclient import TestClient
        c = TestClient(self.server.app)
        # A top-level page load or asset fetch carries no Origin header.
        for path in ("/", "/index.html", "/assets/characters/doctor.glb"):
            self.assertNotEqual(c.get(path).status_code, 401, path)
        # The API still refuses requests from an untrusted origin.
        r = c.post("/voice/start", json={}, headers={"Origin": "https://evil.example.com"})
        self.assertEqual(r.status_code, 401)
        r = c.post("/voice/stop", json={"agentId": "x"})
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
