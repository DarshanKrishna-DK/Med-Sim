"""Telegram case-authoring bot: interview state machine, validation + re-asks,
keyboards, callback buttons, case creation (LLM mocked), poller offsets and
notify's known_chat hook. The Telegram API is a httpx.MockTransport."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))
if str(_B / "tests") not in sys.path:
    sys.path.insert(0, str(_B / "tests"))

os.environ["CUSTOM_CASES_FILE"] = "off"

import httpx  # noqa: E402

import case_author  # noqa: E402
import custom_cases  # noqa: E402
import telegram_bot as bot  # noqa: E402
from integrations import notify  # noqa: E402

from test_case_author import GOOD  # noqa: E402

CHAT = 4242


def msg(text, chat=CHAT, uid=None, username="drdemo"):
    return {"update_id": uid or int(time.time() * 1000) % 10**9, "message": {
        "message_id": 1, "text": text, "chat": {"id": chat, "username": username, "type": "private"},
        "from": {"id": chat, "first_name": "Darsh"}}}


def cb(data, chat=CHAT):
    return {"update_id": 1, "callback_query": {"id": "cq1", "data": data, "message": {"chat": {"id": chat}}}}


class BotBase(unittest.TestCase):
    def setUp(self):
        bot._sessions.clear()
        bot._chats.clear()
        bot._offset["next"] = None
        notify._tg_chats.clear()
        custom_cases.reset()
        # Leave no cached chats behind for notify's own tests.
        self.addCleanup(bot._chats.clear)
        self.addCleanup(bot._sessions.clear)
        self.addCleanup(notify._tg_chats.clear)
        self.sent = []
        self.updates = []
        self.get_params = []

        def handler(req: httpx.Request) -> httpx.Response:
            method = req.url.path.rsplit("/", 1)[-1]
            if method == "getUpdates":
                self.get_params.append(dict(req.url.params))
                batch, self.updates = self.updates, []
                return httpx.Response(200, json={"ok": True, "result": batch})
            body = json.loads(req.content) if req.content else {}
            self.sent.append((method, body))
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 9}})

        self.transport = httpx.MockTransport(handler)
        env = mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:abc", "APP_URL": "https://medsim.example"})
        env.start()
        self.addCleanup(env.stop)
        f = mock.patch.object(bot, "_client_factory", lambda timeout=15.0: httpx.AsyncClient(transport=self.transport))
        f.start()
        self.addCleanup(f.stop)

    def run_updates(self, *updates):
        async def go():
            for u in updates:
                await bot.dispatch(u)
            if bot._jobs:
                await asyncio.gather(*list(bot._jobs))
        asyncio.run(go())

    def texts(self):
        return [b.get("text", "") for m, b in self.sent if m == "sendMessage"]

    def last(self):
        return [b for m, b in self.sent if m == "sendMessage"][-1]

    def step(self):
        return bot._sessions[CHAT]["step"]


ANSWERS_FLOW = ["Cardiology", "ravi kumar", "54", "Male", "My chest feels tight when I climb stairs.", "Urgent",
                "2 weeks, worse in 2 days", "smoker, diabetic", "penicillin", "None", "Unstable angina",
                "HR 104, BP 150/92, SpO2 96, T 36.9, RR 20"]


class ConversationTests(BotBase):
    def test_start_and_help(self):
        self.run_updates(msg("/start"))
        self.assertIn("/newpatient", self.texts()[-1])
        self.assertIn("Darsh", self.texts()[-1])
        self.run_updates(msg("/start medsim"))
        self.assertIn("prescriptions", self.texts()[-1])
        self.run_updates(msg("/help"))
        self.assertIn("/list", self.texts()[-1])

    def test_full_flow_to_summary(self):
        self.run_updates(msg("/newpatient"))
        self.assertEqual(self.step(), "specialty")
        kb = self.last()["reply_markup"]["keyboard"]
        self.assertIn("Cardiology", [b["text"] for row in kb for b in row])
        self.run_updates(*[msg(t) for t in ANSWERS_FLOW])
        self.assertEqual(self.step(), "summary")
        a = bot._sessions[CHAT]["answers"]
        self.assertEqual((a["specialty"], a["name"], a["age"], a["gender"], a["severity"]),
                         ("cardiology", "Ravi Kumar", 54, "M", "urgent"))
        self.assertEqual(a["medications"], "none")
        self.assertEqual(a["vitals"], {"hr": 104, "bp": "150/92", "spo2": 96, "temp": 36.9, "rr": 20})
        summary = self.last()
        self.assertIn("Ravi Kumar", summary["text"])
        buttons = [b["callback_data"] for row in summary["reply_markup"]["inline_keyboard"] for b in row]
        self.assertEqual(buttons, ["c:create", "c:edit", "c:cancel"])

    def test_natural_language_trigger(self):
        self.run_updates(msg("can you create a patient for me"))
        self.assertEqual(self.step(), "specialty")
        bot._sessions.clear()
        self.run_updates(msg("new case please"))
        self.assertEqual(self.step(), "specialty")

    def test_bad_inputs_reask(self):
        self.run_updates(msg("/newpatient"), msg("Astrology"))
        self.assertEqual(self.step(), "specialty")
        self.assertIn("specialty", self.texts()[-1].lower())
        self.run_updates(msg("cardio"))  # ambiguous: cardiology or cardiothoracic surgery
        self.assertEqual(self.step(), "specialty")
        self.run_updates(msg("cardiol"))  # unique prefix accepted
        self.assertEqual(self.step(), "name")
        self.run_updates(msg("R2D2"))
        self.assertEqual(self.step(), "name")
        self.run_updates(msg("Meena"), msg("140"))
        self.assertEqual(self.step(), "age")
        self.assertIn("110", self.texts()[-1])
        self.run_updates(msg("8 months"))
        self.assertEqual(bot._sessions[CHAT]["answers"]["age"], 0.67)
        self.run_updates(msg("maybe"))
        self.assertEqual(self.step(), "gender")
        self.run_updates(msg("F"), msg("ok"))  # complaint too short
        self.assertEqual(self.step(), "complaint")
        self.run_updates(msg("Baby is not feeding well"), msg("very bad"))
        self.assertEqual(self.step(), "severity")
        self.run_updates(msg("critical"))
        self.assertEqual(self.step(), "onset")

    def test_skip_optional_and_not_required(self):
        self.run_updates(msg("/newpatient"), *[msg(t) for t in ANSWERS_FLOW[:6]])
        self.assertEqual(self.step(), "onset")
        kb = self.last()["reply_markup"]["keyboard"]
        self.assertIn("Skip", [b["text"] for row in kb for b in row])
        self.run_updates(msg("skip"), msg("Skip"), msg("Skip"), msg("/skip"))
        a = bot._sessions[CHAT]["answers"]
        self.assertIsNone(a["onset"])
        self.assertEqual((a["allergies"], a["medications"]), ("none", "none"))
        self.assertEqual(self.step(), "diagnosis")
        self.run_updates(msg("skip"))  # the diagnosis is required
        self.assertEqual(self.step(), "diagnosis")
        self.assertIn("needed", self.texts()[-1])
        self.run_updates(msg("Unstable angina"), msg("Skip"))
        self.assertEqual(self.step(), "summary")
        self.assertIsNone(bot._sessions[CHAT]["answers"]["vitals"])

    def test_bad_vitals(self):
        self.run_updates(msg("/newpatient"), *[msg(t) for t in ANSWERS_FLOW[:11]], msg("BP 60/90"))
        self.assertEqual(self.step(), "vitals")
        self.run_updates(msg("temp 101.3F"))
        self.assertEqual(bot._sessions[CHAT]["answers"]["vitals"], {"temp": 38.5})

    def test_cancel_and_expiry(self):
        self.run_updates(msg("/newpatient"), msg("/cancel"))
        self.assertNotIn(CHAT, bot._sessions)
        self.assertIn("Cancelled", self.texts()[-1])
        self.run_updates(msg("/newpatient"))
        bot._sessions[CHAT]["ts"] -= bot.SESSION_TTL_S + 1
        self.run_updates(msg("Cardiology"))
        self.assertNotIn(CHAT, bot._sessions)
        self.assertIn("expired", self.texts()[-1])

    def test_edit_via_callback_returns_to_summary(self):
        self.run_updates(msg("/newpatient"), *[msg(t) for t in ANSWERS_FLOW], cb("c:edit"))
        self.assertIn(("answerCallbackQuery", {"callback_query_id": "cq1"}), self.sent)
        fields = [b["callback_data"] for row in self.last()["reply_markup"]["inline_keyboard"] for b in row]
        self.assertIn("e:age", fields)
        self.run_updates(cb("e:age"))
        self.assertEqual(self.step(), "age")
        self.run_updates(msg("61"))
        self.assertEqual(self.step(), "summary")
        self.assertEqual(bot._sessions[CHAT]["answers"]["age"], 61)
        self.assertIn("61", self.last()["text"])

    def test_cancel_callback_and_stale_callback(self):
        self.run_updates(msg("/newpatient"), *[msg(t) for t in ANSWERS_FLOW], cb("c:cancel"))
        self.assertNotIn(CHAT, bot._sessions)
        self.run_updates(cb("c:create"))
        self.assertIn("no longer open", self.texts()[-1])

    def test_create_stores_case_and_replies_with_link(self):
        async def chat(messages, **kw):
            return {"content": json.dumps(GOOD)}, "mock"

        with mock.patch.object(case_author.llm_provider, "chat", chat):
            self.run_updates(msg("/newpatient"), *[msg(t) for t in ANSWERS_FLOW], cb("c:create"))
        cases = custom_cases.list_cases(CHAT)
        self.assertEqual(len(cases), 1)
        c = cases[0]
        self.assertTrue(c["id"].startswith("tg-"))
        self.assertEqual(c["source"]["title"], "Created via Telegram by Darsh")
        self.assertEqual(c["vitals"]["hr"], 104)
        self.assertIn(f"Created Ravi Kumar (Cardiology, urgent). Open MedSim &gt; Cardiology to see the patient: "
                      f"https://medsim.example/?case={c['id']}", self.texts()[-1])
        self.assertNotIn(CHAT, bot._sessions)
        # /list and /delete
        self.run_updates(msg("/list"))
        self.assertIn(c["id"], self.texts()[-1])
        self.run_updates(msg(f"/delete {c['id']}", chat=999))
        self.assertIn("No patient", self.texts()[-1])
        self.run_updates(msg(f"/delete {c['id']}"))
        self.assertIn("Deleted", self.texts()[-1])
        self.assertEqual(custom_cases.list_cases(), [])

    def test_create_failure_keeps_draft(self):
        async def chat(messages, **kw):
            return {"content": "not json"}, "mock"

        with mock.patch.object(case_author.llm_provider, "chat", chat):
            self.run_updates(msg("/newpatient"), *[msg(t) for t in ANSWERS_FLOW], cb("c:create"))
        self.assertEqual(self.step(), "summary")
        self.assertIn("could not build", self.texts()[-1])
        self.assertEqual(custom_cases.list_cases(), [])


class PollerTests(BotBase):
    def test_offset_advances_and_dispatches(self):
        self.updates = [msg("/help", uid=10), msg("/start", uid=11, chat=77, username="Other")]

        async def go():
            async with bot._client_factory() as c:
                n1 = await bot.poll_once(c, timeout=0)
                n2 = await bot.poll_once(c, timeout=0)
            return n1, n2

        n1, n2 = asyncio.run(go())
        self.assertEqual((n1, n2), (2, 0))
        self.assertEqual(bot._offset["next"], 12)
        self.assertNotIn("offset", self.get_params[0])
        self.assertEqual(self.get_params[1]["offset"], "12")
        self.assertEqual(self.get_params[0]["timeout"], "0")
        self.assertEqual(len(self.texts()), 2)
        self.assertEqual(bot.known_chat("telegram"), 77)
        self.assertEqual(bot.known_chat("@other"), 77)
        self.assertEqual(bot.known_chat("@drdemo"), CHAT)
        self.assertIsNone(bot.known_chat("@nobody"))

    def test_bad_update_does_not_stall(self):
        self.updates = [{"update_id": 5, "message": {"chat": {"id": 1}, "text": "/help"}}, {"update_id": 6}]

        async def boom(u):
            raise ValueError("x")

        with mock.patch.object(bot, "dispatch", boom):
            async def go():
                async with bot._client_factory() as c:
                    return await bot.poll_once(c, timeout=0)
            self.assertEqual(asyncio.run(go()), 2)
        self.assertEqual(bot._offset["next"], 7)

    def test_enabled_flags(self):
        with mock.patch.object(sys, "argv", ["server.py"]):
            self.assertTrue(bot.enabled())
            with mock.patch.dict(os.environ, {"TELEGRAM_BOT_POLLING": "0"}):
                self.assertFalse(bot.enabled())
            with mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": ""}):
                self.assertFalse(bot.enabled())


class NotifyHookTests(BotBase):
    """notify._tg_resolve_chat asks the poller's cache before calling getUpdates."""

    def setUp(self):
        super().setUp()
        self.notify_calls = []

        def handler(req):
            self.notify_calls.append(req.url.path.rsplit("/", 1)[-1])
            if req.url.path.endswith("getUpdates"):
                return httpx.Response(200, json={"ok": True, "result": [
                    {"update_id": 1, "message": {"chat": {"id": 555, "username": "scan"}, "text": "/start"}}]})
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

        f = mock.patch.object(notify, "_client_factory", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        f.start()
        self.addCleanup(f.stop)

    def resolve(self, dest):
        return asyncio.run(notify.resolve_telegram(dest))

    def test_cache_hit_skips_getupdates(self):
        bot.remember_chat({"id": 321, "username": "DrDemo"})
        self.assertEqual(self.resolve("telegram"), "tg:321")
        self.assertEqual(self.resolve("@drdemo"), "tg:321")
        self.assertEqual(self.notify_calls, [])

    def test_cache_miss_falls_back_to_scan_when_not_polling(self):
        self.assertEqual(self.resolve("@scan"), "tg:555")
        self.assertEqual(self.notify_calls, ["getUpdates"])

    def test_no_scan_while_polling(self):
        with mock.patch.object(bot, "polling_active", lambda: True):
            self.assertIsNone(self.resolve("@scan"))
        self.assertEqual(self.notify_calls, [])

    def test_send_uses_cached_chat(self):
        bot.remember_chat({"id": 888})
        res = asyncio.run(notify.send_to_patient("telegram", "telegram", "Hello"))
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.notify_calls, ["sendMessage"])


class KeyboardTests(unittest.TestCase):
    def test_specialty_rows_two_per_row(self):
        rows = bot.specialty_rows()
        self.assertTrue(all(1 <= len(r) <= 2 for r in rows))
        self.assertEqual(sum(len(r) for r in rows), len(bot.catalog.specialties()))

    def test_markups(self):
        self.assertEqual(bot._markup_for(bot.STEP_BY_KEY["name"]), bot.REMOVE_KEYBOARD)
        kb = bot._markup_for(bot.STEP_BY_KEY["severity"])
        self.assertEqual([b["text"] for b in kb["keyboard"][0]], ["Stable", "Urgent", "Critical"])
        self.assertTrue(kb["one_time_keyboard"])
        self.assertEqual(bot._markup_for(bot.STEP_BY_KEY["vitals"])["keyboard"], [[{"text": "Skip"}]])

    def test_parsers(self):
        self.assertEqual(bot.parse_specialty("allergy and immunology"), "allergy-immunology")
        self.assertEqual(bot.parse_specialty("OB/GYN"), "obgyn")
        with self.assertRaises(bot.Bad):
            bot.parse_specialty("surgery")  # ambiguous
        self.assertEqual(bot.parse_age("3 weeks"), 0.06)
        self.assertEqual(bot.parse_gender("female"), "F")
        self.assertEqual(bot.parse_severity("red flag"), "critical")
        self.assertEqual(bot.parse_vitals("pulse 88 bp 118/76 sats 99 rr 14"),
                         {"hr": 88, "bp": "118/76", "spo2": 99, "rr": 14})
        self.assertEqual(bot.free_text(2, 50, "x")("a \u2014 b"), "a, b")


if __name__ == "__main__":
    unittest.main()
