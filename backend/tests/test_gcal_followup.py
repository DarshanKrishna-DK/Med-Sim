"""Google Calendar Apps Script bridge, recurrence, call links and the nurse follow-up tool (no network)."""

import asyncio
import json
import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import nurse  # noqa: E402
from integrations import calendar_invite as ci, followup_calls, gcal_script  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
ENV = {"GCAL_SCRIPT_URL": "https://script.google.com/macros/s/abc/exec", "GCAL_SCRIPT_SECRET": "s3cret"}


class GcalScriptTests(unittest.TestCase):
    def test_unconfigured_returns_none(self):
        with mock.patch.dict(os.environ, {"GCAL_SCRIPT_URL": "", "GCAL_SCRIPT_SECRET": ""}):
            self.assertIsNone(asyncio.run(gcal_script.book_event("t", "d", datetime.now(IST))))

    def test_request_shape_and_redirect_followed(self):
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.host == "script.google.com":
                return httpx.Response(302, headers={"location": "https://script.googleusercontent.com/macros/echo?x=1"})
            return httpx.Response(200, json={"ok": True, "id": "e1", "seriesId": "e1", "htmlLink": "https://calendar.google.com/x"})

        factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)  # noqa: E731
        start = datetime(2026, 11, 25, 10, 0, tzinfo=IST)
        rec = {"freq": "WEEKLY", "count": 4, "interval": 1}
        with mock.patch.dict(os.environ, ENV), mock.patch.object(gcal_script, "_client_factory", factory):
            out = asyncio.run(gcal_script.book_event("Follow-up: BP", "desc", start, 20, rec, "a@b.co"))
        self.assertTrue(out["ok"])
        self.assertEqual(out["seriesId"], "e1")
        self.assertEqual(len(seen), 2)  # POST then redirect target
        body = json.loads(seen[0].content)
        self.assertEqual(body["secret"], "s3cret")
        self.assertEqual(body["title"], "Follow-up: BP")
        self.assertEqual(body["minutes"], 20)
        self.assertEqual(body["recurrence"], rec)
        self.assertEqual(body["guestEmail"], "a@b.co")
        self.assertTrue(body["startIso"].startswith("2026-11-25T10:00:00"))

    def test_http_error_and_exception_return_none(self):
        bad = lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))  # noqa: E731

        def boom(request):
            raise httpx.ConnectError("down")

        worse = lambda: httpx.AsyncClient(transport=httpx.MockTransport(boom))  # noqa: E731
        with mock.patch.dict(os.environ, ENV):
            for f in (bad, worse):
                with mock.patch.object(gcal_script, "_client_factory", f):
                    self.assertIsNone(asyncio.run(gcal_script.book_event("t", "d", datetime.now(IST))))


class RecurrenceIcsTests(unittest.TestCase):
    def test_rrule_in_ics_and_google_link_and_call_link(self):
        now = datetime(2026, 11, 21, 9, 0, tzinfo=IST)
        r = ci.make_follow_up("c1", "Asha", 7, "BP", now=now,
                              recurrence={"freq": "weekly", "count": 4, "interval": 2},
                              call_url="https://x.test/call/tok")
        self.assertEqual(r["rrule"], "RRULE:FREQ=WEEKLY;COUNT=4;INTERVAL=2")
        q = parse_qs(urlparse(r["googleCalendarUrl"]).query)
        self.assertEqual(q["recur"], ["RRULE:FREQ=WEEKLY;COUNT=4;INTERVAL=2"])
        self.assertIn("Join your Asha follow-up call: https://x.test/call/tok", q["details"][0])
        token = r["icsPath"].rsplit("/", 1)[-1].removesuffix(".ics")
        lines = ci.get_ics(token).replace("\r\n ", "").split("\r\n")
        self.assertIn("RRULE:FREQ=WEEKLY;COUNT=4;INTERVAL=2", lines)
        self.assertIn("URL:https://x.test/call/tok", lines)
        self.assertTrue(any("Join your Asha follow-up call" in x for x in lines))

    def test_backward_compatible_without_recurrence(self):
        r = ci.make_follow_up("c1", "Asha", 1, "x", now=datetime(2026, 11, 21, 9, 0, tzinfo=IST))
        self.assertNotIn("recur=", r["googleCalendarUrl"])
        token = r["icsPath"].rsplit("/", 1)[-1].removesuffix(".ics")
        self.assertNotIn("RRULE", ci.get_ics(token))

    def test_bad_recurrence_ignored(self):
        self.assertIsNone(ci.build_rrule({"freq": "yearly", "count": 2}))
        self.assertIsNone(ci.build_rrule(None))


class RegistryTests(unittest.TestCase):
    def setUp(self):
        followup_calls._calls.clear()

    def test_roundtrip_unknown_and_expiry(self):
        tok = followup_calls.register_call({"caseId": "c1", "patientName": "A"})
        self.assertEqual(followup_calls.get_call(tok)["caseId"], "c1")
        self.assertIsNone(followup_calls.get_call("nope"))
        followup_calls._calls[tok] = (time.time() - 1, {"caseId": "c1"})
        self.assertIsNone(followup_calls.get_call(tok))

    def test_max_entries(self):
        toks = [followup_calls.register_call({"i": i}) for i in range(followup_calls.MAX_ENTRIES + 5)]
        self.assertEqual(len(followup_calls._calls), followup_calls.MAX_ENTRIES)
        self.assertIsNone(followup_calls.get_call(toks[0]))

    def test_endpoint(self):
        app = FastAPI()
        app.include_router(nurse.router)
        client = TestClient(app)
        tok = followup_calls.register_call({"caseId": "c9", "patientName": "Ravi", "reason": "INR"})
        res = client.get(f"/agent/followup-call/{tok}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["patientName"], "Ravi")
        self.assertEqual(client.get("/agent/followup-call/unknown").status_code, 404)


def req(**kw):
    base = dict(
        caseId="im-x", utterance="weekly check-in calls for a month",
        patient={"name": "Ravi Kumar", "age": 60, "gender": "M", "chiefComplaint": "cough", "allergies": "none"},
        catalog={"tests": [], "medications": []},
    )
    base.update(kw)
    return nurse.NurseActRequest(**base)


class NurseRecurringFollowUp(unittest.TestCase):
    def test_recurrence_validated_and_clamped(self):
        st = nurse.NurseState(req())
        res = st.execute("schedule_follow_up", {"inDays": 7, "reason": "r",
                                                "recurrence": {"freq": "weekly", "count": 99, "interval": 9}, "mode": "call"})
        self.assertEqual(res["recurrence"], {"freq": "WEEKLY", "count": 12, "interval": 4})
        self.assertEqual(res["mode"], "call")
        bad = st.execute("schedule_follow_up", {"inDays": 7, "reason": "r", "recurrence": {"freq": "hourly"}, "mode": "x"})
        self.assertNotIn("recurrence", bad)
        self.assertNotIn("mode", bad)

    def test_recurring_books_event_and_returns_call_link(self):
        followup_calls._calls.clear()
        st = nurse.NurseState(req(contact="p@x.org"))
        booked = mock.AsyncMock(return_value={"ok": True, "id": "e", "seriesId": "e", "htmlLink": "https://calendar.google.com/e"})
        with mock.patch.object(gcal_script, "book_event", booked):
            res = asyncio.run(st.aexecute("schedule_follow_up", {
                "inDays": 7, "reason": "check-in", "recurrence": {"freq": "weekly", "count": 4}}))
        cal = res["calendar"]
        self.assertIn("/call/", cal["callUrl"])
        token = cal["callUrl"].rsplit("/", 1)[-1]
        self.assertEqual(followup_calls.get_call(token)["patientName"], "Ravi Kumar")
        self.assertEqual(cal["booked"], {"ok": True, "htmlLink": "https://calendar.google.com/e",
                                         "recurring": True, "seriesId": "e"})
        kwargs = booked.await_args.kwargs
        self.assertEqual(kwargs["recurrence"], {"freq": "WEEKLY", "count": 4, "interval": 1})
        self.assertEqual(kwargs["guest_email"], "p@x.org")
        self.assertIn("recur=", cal["googleCalendarUrl"])
        summary = nurse.summarize("schedule_follow_up", {}, res)
        self.assertIn("repeating every week x 4", summary)
        self.assertIn("added to Google Calendar", summary)

    def test_plain_visit_has_no_call_link_and_unconfigured_not_booked(self):
        st = nurse.NurseState(req())
        with mock.patch.dict(os.environ, {"GCAL_SCRIPT_URL": "", "GCAL_SCRIPT_SECRET": ""}):
            res = asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 3, "reason": "r"}))
        self.assertNotIn("callUrl", res["calendar"])
        self.assertNotIn("booked", res["calendar"])
        self.assertIn("calendar invite ready", nurse.summarize("schedule_follow_up", {}, res))

    def test_call_mode_without_recurrence_gets_link(self):
        st = nurse.NurseState(req())
        with mock.patch.object(gcal_script, "book_event", mock.AsyncMock(return_value=None)):
            res = asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 3, "reason": "r", "mode": "call"}))
        self.assertIn("/call/", res["calendar"]["callUrl"])
        self.assertNotIn("booked", res["calendar"])


if __name__ == "__main__":
    unittest.main()
