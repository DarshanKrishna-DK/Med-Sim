"""Scheduled Asha check-in reminders."""

import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import nurse  # noqa: E402
from integrations import call_reminders, gcal_script, notify  # noqa: E402

T0 = datetime(2026, 11, 23, 4, 30, tzinfo=timezone.utc)


class Occurrences(unittest.TestCase):
    def test_weekly_and_monthly(self):
        w = call_reminders.occurrences(T0, {"freq": "weekly", "count": 4})
        self.assertEqual(len(w), 4)
        self.assertEqual(w[3] - w[0], timedelta(weeks=3))
        m = call_reminders.occurrences(datetime(2026, 1, 31, tzinfo=timezone.utc), {"freq": "monthly", "count": 2})
        self.assertEqual((m[1].month, m[1].day), (2, 28))
        self.assertEqual(call_reminders.occurrences(T0, None), [T0])


class Firing(unittest.TestCase):
    def setUp(self):
        call_reminders._pending.clear()
        call_reminders._sent.clear()

    def test_only_due_reminders_fire_with_join_link(self):
        call_reminders.schedule("telegram", "Ravi", "https://x/call/abc", T0, {"freq": "daily", "count": 2}, "BP")
        sent = mock.AsyncMock(return_value={"ok": True, "channel": "telegram"})
        with mock.patch.object(notify, "send_to_patient", sent):
            n = asyncio.run(call_reminders.fire_due(T0 + timedelta(minutes=1)))
        self.assertEqual(n, 1)
        msg = sent.await_args.args[2]
        self.assertIn("Join your Asha follow-up call: https://x/call/abc", msg)
        self.assertIn("(1 of 2)", msg)
        self.assertEqual(len(call_reminders.pending()), 1)

    def test_relative_link_is_not_scheduled(self):
        self.assertEqual(call_reminders.schedule("telegram", "R", "/call/abc", T0), [])


class NurseCallSoon(unittest.TestCase):
    def setUp(self):
        call_reminders._pending.clear()

    def test_call_in_five_minutes_books_and_schedules_reminder(self):
        r = nurse.NurseActRequest(caseId="c", utterance="check-in call in 5 minutes", contact="telegram",
                                  patient={"name": "Ravi"}, catalog={})
        st = nurse.NurseState(r)
        with mock.patch.object(gcal_script, "book_event", mock.AsyncMock(return_value=None)), \
             mock.patch.object(notify, "absolute_url", lambda p: "https://demo.example" + p):
            res = asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 0, "reason": "BP check", "startsInMinutes": 5}))
        self.assertEqual(res["mode"], "call")
        self.assertEqual(res["calendar"]["reminders"], 1)
        due = datetime.fromisoformat(call_reminders.pending()[0]["at"])
        self.assertLess(abs((due - datetime.now(timezone.utc)) - timedelta(minutes=5)), timedelta(minutes=1))
        self.assertIn("Check-in call in 5 minutes", nurse.summarize("schedule_follow_up", {}, res))


if __name__ == "__main__":
    unittest.main()
