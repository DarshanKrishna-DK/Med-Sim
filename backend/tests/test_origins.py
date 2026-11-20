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


if __name__ == "__main__":
    unittest.main()
