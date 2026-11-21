import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from integrations import calendar_invite as ci

IST = timezone(timedelta(hours=5, minutes=30))


def unfold(text: str) -> list[str]:
    return text.replace("\r\n ", "").split("\r\n")


class IcsTests(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 11, 25, 10, 0, tzinfo=IST)
        self.long_desc = "Review BP, sugar; bring reports.\nSecond line " + "x" * 200 + " naïve é"
        self.ics = ci.build_ics("uid-1@medsim", "Follow-up: BP, check", self.long_desc,
                                self.start, 15, "MedSim Clinic")

    def test_crlf_and_folding(self):
        self.assertTrue(self.ics.endswith("\r\n"))
        self.assertNotIn("\n", self.ics.replace("\r\n", ""))
        for line in self.ics.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75)
        self.assertIn("\r\n ", self.ics)  # something was folded

    def test_structure_and_escaping(self):
        lines = unfold(self.ics)
        self.assertIn("PRODID:-//MedSim//Follow-up//EN", lines)
        self.assertIn("SUMMARY:Follow-up: BP\\, check", lines)
        desc = next(x for x in lines if x.startswith("DESCRIPTION:Review"))
        self.assertIn("BP\\, sugar\\; bring reports.\\nSecond line", desc)
        self.assertIn("naïve é", desc)

    def test_ist_times_and_timezone_block(self):
        lines = unfold(self.ics)
        self.assertIn("DTSTART;TZID=Asia/Kolkata:20261125T100000", lines)
        self.assertIn("DTEND;TZID=Asia/Kolkata:20261125T101500", lines)
        self.assertIn("BEGIN:VTIMEZONE", lines)
        self.assertIn("TZOFFSETTO:+0530", lines)
        self.assertTrue(any(x.startswith("DTSTAMP:") and x.endswith("Z") for x in lines))

    def test_valarm(self):
        lines = unfold(self.ics)
        self.assertIn("BEGIN:VALARM", lines)
        self.assertIn("TRIGGER:-P1D", lines)
        self.assertIn("END:VALARM", lines)

    def test_utc_start_converted_to_ist(self):
        ics = ci.build_ics("u", "t", "d", datetime(2026, 11, 25, 4, 30, tzinfo=timezone.utc))
        self.assertIn("DTSTART;TZID=Asia/Kolkata:20261125T100000", unfold(ics))

    def test_no_em_dash(self):
        self.assertNotIn(chr(0x2014), self.ics)


class GoogleLinkTests(unittest.TestCase):
    def test_utc_dates_and_encoding(self):
        s = datetime(2026, 11, 25, 10, 0, tzinfo=IST)
        url = ci.google_calendar_link("Follow-up: BP & sugar", "a, b; c", s,
                                      s + timedelta(minutes=15), "MedSim Clinic")
        self.assertTrue(url.startswith("https://calendar.google.com/calendar/render?action=TEMPLATE"))
        q = parse_qs(urlparse(url).query)
        self.assertEqual(q["dates"], ["20261125T043000Z/20261125T044500Z"])
        self.assertEqual(q["text"], ["Follow-up: BP & sugar"])
        self.assertEqual(q["details"], ["a, b; c"])
        self.assertNotIn(" ", url)
        self.assertIn("%26", url)


class ScheduleTests(unittest.TestCase):
    def test_sunday_rolls_to_monday(self):
        now = datetime(2026, 11, 22, 18, 0, tzinfo=IST)  # Sunday
        self.assertEqual(now.weekday(), 6)
        self.assertEqual(ci.pick_start(0, now), datetime(2026, 11, 23, 10, 0, tzinfo=IST))
        # Tuesday + 5 days lands on Sunday 22 Nov... use Wed 18 Nov + 4 = Sun 22
        wed = datetime(2026, 11, 18, 9, 0, tzinfo=IST)
        got = ci.pick_start(4, wed)
        self.assertEqual((got.day, got.weekday(), got.hour), (23, 0, 10))

    def test_make_follow_up_shape(self):
        now = datetime(2026, 11, 21, 9, 0, tzinfo=IST)  # Saturday
        r = ci.make_follow_up("c1", "Asha", 1, "BP review", now=now)
        self.assertTrue(r["ok"])
        self.assertEqual(r["title"], "Follow-up: BP review")
        self.assertEqual(r["startText"], "Mon 23 Nov, 10:00 am")
        self.assertTrue(r["start"].startswith("2026-11-23T10:00:00"))
        self.assertRegex(r["icsPath"], r"^/rx/calendar/[A-Za-z0-9_-]{20,}\.ics$")
        self.assertTrue(r["googleCalendarUrl"].startswith("https://calendar.google.com/"))


class RouterAndStoreTests(unittest.TestCase):
    def setUp(self):
        ci._store.clear()
        app = FastAPI()
        app.include_router(ci.router)
        self.client = TestClient(app)

    def test_valid_token(self):
        r = ci.make_follow_up("c1", "Asha", 3, "Review")
        res = self.client.get(r["icsPath"])
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.headers["content-type"].startswith("text/calendar"))
        self.assertIn("attachment", res.headers["content-disposition"])
        self.assertIn("BEGIN:VCALENDAR", res.text)

    def test_unknown_token_404(self):
        self.assertEqual(self.client.get("/rx/calendar/nope.ics").status_code, 404)

    def test_expired_404(self):
        token = ci.store_ics("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
        exp, ics = ci._store[token]
        ci._store[token] = (0.0, ics)
        self.assertEqual(self.client.get(f"/rx/calendar/{token}.ics").status_code, 404)

    def test_eviction_past_500(self):
        tokens = [ci.store_ics(f"ics-{i}") for i in range(ci.MAX_ENTRIES + 10)]
        self.assertEqual(len(ci._store), ci.MAX_ENTRIES)
        self.assertIsNone(ci.get_ics(tokens[0]))
        self.assertEqual(ci.get_ics(tokens[-1]), f"ics-{ci.MAX_ENTRIES + 9}")


class Tier2Tests(unittest.TestCase):
    def test_unconfigured_returns_none(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GOOGLE_SERVICE_ACCOUNT_JSON", None)
            os.environ.pop("GOOGLE_CALENDAR_ID", None)
            r = asyncio.run(ci.book_google_event("t", "d", datetime.now(IST)))
        self.assertIsNone(r)

    def test_bad_config_never_raises(self):
        env = {"GOOGLE_SERVICE_ACCOUNT_JSON": "{not json", "GOOGLE_CALENDAR_ID": "x@y"}
        with mock.patch.dict(os.environ, env):
            self.assertIsNone(asyncio.run(ci.book_google_event("t", "d", datetime.now(IST))))

    def test_rs256_matches_textbook_rsa(self):
        # Tiny-structure check: sign with a known key built from two Mersenne-style primes.
        p, q = (1 << 521) - 1, (1 << 607) - 1
        n, e = p * q, 65537
        d = pow(e, -1, (p - 1) * (q - 1))
        import base64

        def enc(tag, payload):
            ln = len(payload)
            hdr = bytes([tag]) + (bytes([ln]) if ln < 128 else bytes([0x80 | (ln.bit_length() + 7) // 8]) + ln.to_bytes((ln.bit_length() + 7) // 8, "big"))
            return hdr + payload

        def i(v):
            b = v.to_bytes((v.bit_length() + 8) // 8, "big")
            return enc(2, b)

        der = enc(0x30, i(0) + i(n) + i(e) + i(d))
        pem = "-----BEGIN RSA PRIVATE KEY-----\n" + base64.b64encode(der).decode() + "\n-----END RSA PRIVATE KEY-----"
        sig = ci.rs256_sign(b"hello", pem)
        em = pow(int.from_bytes(sig, "big"), e, n).to_bytes((n.bit_length() + 7) // 8, "big")
        self.assertTrue(em.startswith(b"\x00\x01\xff"))
        self.assertTrue(em.endswith(__import__("hashlib").sha256(b"hello").digest()))


if __name__ == "__main__":
    unittest.main()
