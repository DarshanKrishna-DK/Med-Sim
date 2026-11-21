"""Regression tests for the review fixes: untrusted follow-up links, notify caps,
Telegram resolution, allergy negation, nurse fallback, Asha call caps and errors."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import nurse  # noqa: E402
from integrations import call_reminders, calendar_invite, drugsafety, fhir, followup_calls, notify  # noqa: E402
from llm_proxy import addressed_to_nurse  # noqa: E402

EVIL = "https://evil.example/phish"


def nreq(**kw):
    base = dict(
        caseId="im-x", utterance="start warfarin",
        patient={"name": "Ravi Kumar", "age": 60, "gender": "M", "allergies": "none"},
        catalog={"tests": [{"id": "cbc", "name": "Complete Blood Count", "category": "lab"}],
                 "medications": [{"id": "warfarin-5", "name": "Warfarin 5mg", "dosing": "5 mg OD"}]},
    )
    base.update(kw)
    return nurse.NurseActRequest(**base)


def audio_mocks():
    return (mock.patch("rx_audio.generate_script", mock.AsyncMock(return_value="script")),
            mock.patch("rx_audio.synthesize", mock.AsyncMock(return_value=(b"mp3", "v", "en-IN"))))


# ---------------------------------------------------------------- 1. followUpSoFar

class UntrustedFollowUp(unittest.TestCase):
    def test_client_links_are_dropped_and_rebuilt(self):
        st = nurse.NurseState(nreq(
            contact="+919876543210",
            prescriptionsSoFar=[{"medicationId": "warfarin-5", "dose": "5 mg OD", "duration": "1 month"}],
            followUpSoFar={"inDays": 7, "reason": "INR check", "callUrl": EVIL, "googleCalendarUrl": EVIL,
                           "startText": "<b>now</b>", "icsPath": "/rx/calendar/x.ics", "booked": True,
                           "recurrence": {"freq": "weekly", "count": 2}, "mode": "hack"}))
        sent = mock.AsyncMock(return_value={"ok": True, "channel": "whatsapp", "to": "x"})
        a, b = audio_mocks()
        with a, b, mock.patch.object(notify, "send_to_patient", sent), \
                mock.patch.object(notify, "absolute_url", lambda p: "https://medsim.test" + p):
            res = asyncio.run(st.aexecute("send_to_patient", {"channel": "whatsapp"}))
        self.assertTrue(res["ok"])
        message = sent.call_args.args[2]
        self.assertNotIn("evil.example", message)
        self.assertNotIn("<b>now</b>", message)
        self.assertNotIn("already booked", message)
        self.assertIn("https://calendar.google.com/", message)
        self.assertIn("https://medsim.test/call/", res["callUrl"])
        self.assertIsNotNone(sent.call_args.args[5])  # not "booked": the .ics invite is attached

    def test_safe_follow_up_shape(self):
        out = nurse._safe_follow_up({"inDays": "3", "reason": "x" * 500, "mode": "call", "callUrl": EVIL})
        self.assertEqual(set(out), {"inDays", "reason", "mode"})
        self.assertEqual(len(out["reason"]), 160)
        self.assertIsNone(nurse._safe_follow_up({"reason": "no days"}))


class NotifyCaps(unittest.TestCase):
    def setUp(self):
        notify._sends.clear()
        self.addCleanup(notify._sends.clear)

    def test_global_cap_across_destinations(self):
        with mock.patch.dict(os.environ, {"NOTIFY_MAX_PER_HOUR": "3", "NOTIFY_ALLOWED_DESTS": ""}):
            self.assertTrue(all(notify._rate_ok(f"+9198765432{i:02d}") for i in range(3)))
            self.assertFalse(notify._rate_ok("+919876543299"))

    def test_allowed_destinations(self):
        with mock.patch.dict(os.environ, {"NOTIFY_ALLOWED_DESTS": "9876543210, Doc@Example.com", "NOTIFY_MAX_PER_HOUR": ""}):
            self.assertTrue(notify._rate_ok("+919876543210"))
            self.assertTrue(notify._rate_ok("doc@example.com"))
            self.assertFalse(notify._rate_ok("+919999999999"))
            self.assertFalse(notify._rate_ok("tg:42"))
        with mock.patch.dict(os.environ, {"NOTIFY_ALLOWED_DESTS": "telegram"}):
            self.assertTrue(notify._rate_ok("tg:42"))
            self.assertTrue(notify.dest_allowed("@someone"))
            self.assertFalse(notify._rate_ok("+919876543210"))

    def test_disallowed_send_fails_cleanly(self):
        with mock.patch.dict(os.environ, {"NOTIFY_ALLOWED_DESTS": "+910000000000", "TWILIO_ACCOUNT_SID": "AC",
                                          "TWILIO_AUTH_TOKEN": "t"}):
            res = asyncio.run(notify.send_to_patient("whatsapp", "+919876543210", "hi"))
        self.assertFalse(res["ok"])
        self.assertIn("allowed", res["error"])


# ---------------------------------------------------------------- 2. call snapshot clipping

class SnapshotClipping(unittest.TestCase):
    def test_register_call_fields_are_clipped(self):
        long = "y" * 1000
        rx = [{"medicationId": "warfarin-5", "name": long, "dose": long, "duration": long}] * 20
        st = nurse.NurseState(nreq(patient={"name": long, "age": 60, "gender": "M", "chiefComplaint": long},
                                   prescriptionsSoFar=rx))
        captured = {}
        real = followup_calls.register_call

        def spy(snap):
            captured.update(snap)
            return real(snap)

        with mock.patch.object(followup_calls, "register_call", spy):
            asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 3, "reason": long}))
        self.assertEqual(len(captured["patientName"]), 80)
        self.assertEqual(len(captured["chiefComplaint"]), 200)
        self.assertEqual(len(captured["reason"]), 160)
        self.assertEqual(len(captured["prescriptions"]), 12)
        self.assertTrue(all(len(v) <= 80 for r in captured["prescriptions"] for v in r.values()))


# ---------------------------------------------------------------- 3-5, 10, 16. Telegram

class TelegramFixes(unittest.TestCase):
    def setUp(self):
        notify._sends.clear()
        notify._tg_chats.clear()
        notify._tg_offset["next"] = None
        self.calls = []
        self.fail_audio = False

        def handler(req: httpx.Request) -> httpx.Response:
            method = req.url.path.rsplit("/", 1)[-1]
            self.calls.append((method, req))
            if method == "getUpdates":
                off = int(req.url.params.get("offset") or 0)
                ups = [{"update_id": 1, "message": {"chat": {"id": 111, "username": "other"}}},
                       {"update_id": 2, "message": {"chat": {"id": 222, "username": "DrDemo"}}}]
                return httpx.Response(200, json={"ok": True, "result": [u for u in ups if u["update_id"] >= off]})
            if method == "sendAudio" and self.fail_audio:
                raise httpx.ConnectError("audio upload broke")
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 7}})

        env = mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:abc", "NOTIFY_ALLOWED_DESTS": "",
                                           "NOTIFY_MAX_PER_HOUR": ""})
        env.start()
        self.addCleanup(env.stop)
        f = mock.patch.object(notify, "_client_factory", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        f.start()
        self.addCleanup(f.stop)

    def send(self, to, mp3=None):
        return asyncio.run(notify.send_to_patient("auto", to, "Hello", None, mp3, None))

    def test_offset_and_cache(self):
        self.assertEqual(self.send("telegram")["resolvedTo"], "tg:222")
        res = self.send("@other")  # update 1 is no longer returned: the cache answers
        self.assertEqual(res["resolvedTo"], "tg:111")
        ups = [r for m, r in self.calls if m == "getUpdates"]
        self.assertNotIn("offset", ups[0].url.params)
        self.assertEqual(ups[1].url.params["offset"], "3")
        self.assertEqual(asyncio.run(notify.resolve_telegram("@drdemo")), "tg:222")
        self.assertEqual(asyncio.run(notify.resolve_telegram("tg:5")), "tg:5")
        self.assertIsNone(asyncio.run(notify.resolve_telegram("@nobody_here")))

    def test_rate_limit_is_per_resolved_chat(self):
        for _ in range(notify.RATE_MAX):
            self.assertTrue(self.send("telegram")["ok"])
        self.assertFalse(self.send("@drdemo")["ok"])  # same chat 222, different spelling
        self.assertTrue(self.send("@other")["ok"])  # a different person is not blocked

    def test_audio_failure_keeps_message_ok(self):
        self.fail_audio = True
        res = self.send("telegram", mp3=b"mp3")
        self.assertTrue(res["ok"])
        self.assertFalse(res["audioSent"])

    def test_html_links_are_safe(self):
        out = notify.telegram_html("Add to calendar: https://x.test/?a=1&b=2. Done.", False)
        self.assertIn('<a href="https://x.test/?a=1&amp;b=2">Add to Google Calendar</a>.', out)
        out = notify.telegram_html('Add to calendar: https://x.test/a"onmouseover="x. Done.', False)
        self.assertNotIn("<a", out)
        out = notify.telegram_html("Join your Asha follow-up call: javascript:alert(1). ok", False)
        self.assertNotIn("<a", out)
        out = notify.telegram_html("Listen to your prescription: http://plain.test/a.mp3. ok", False)
        self.assertNotIn("<a", out)


class NurseTelegramReminders(unittest.TestCase):
    def setUp(self):
        call_reminders._pending.clear()
        self.addCleanup(call_reminders._pending.clear)

    def _schedule(self, st, resolved):
        with mock.patch.object(notify, "resolve_telegram", mock.AsyncMock(return_value=resolved)), \
                mock.patch.object(notify, "absolute_url", lambda p: "https://medsim.test" + p):
            return asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 2, "reason": "review", "mode": "call"}))

    def test_calendar_resolves_telegram_contact(self):
        st = nurse.NurseState(nreq(contact="telegram"))
        res = self._schedule(st, "tg:42")
        self.assertEqual(res["calendar"]["reminders"], 1)
        self.assertEqual(call_reminders._pending[0]["contact"], "tg:42")
        self.assertTrue(st.follow_up["start"])

    def test_send_retargets_unresolved_reminders(self):
        st = nurse.NurseState(nreq(contact="@drdemo", prescriptionsSoFar=[
            {"medicationId": "warfarin-5", "dose": "5 mg OD", "duration": "1 month"}]))
        self._schedule(st, None)
        self.assertEqual(call_reminders._pending[0]["contact"], "@drdemo")
        sent = mock.AsyncMock(return_value={"ok": True, "channel": "telegram", "to": "Telegram chat", "resolvedTo": "tg:222"})
        a, b = audio_mocks()
        with a, b, mock.patch.object(notify, "send_to_patient", sent):
            asyncio.run(st.aexecute("send_to_patient", {"channel": "telegram"}))
        self.assertEqual(call_reminders._pending[0]["contact"], "tg:222")
        self.assertEqual(st.resolved_contact, "tg:222")


# ---------------------------------------------------------------- 6. allergy negation

class AllergyNegation(unittest.TestCase):
    NSAID = ["Nonsteroidal Anti-inflammatory Drug"]

    def test_negated_text_never_conflicts(self):
        for text in ("No known drug allergies", "none", "NKDA", "nil", "Not allergic to any medicine",
                     "Denies drug allergies", "", "no"):
            self.assertIsNone(drugsafety._allergy_conflict("ibuprofen", self.NSAID, text), text)

    def test_real_allergy_still_conflicts(self):
        self.assertIsNotNone(drugsafety._allergy_conflict("ibuprofen", self.NSAID, "NSAID allergy (rash)"))
        self.assertIsNotNone(drugsafety._allergy_conflict("amoxicillin", ["Penicillins"], "Penicillin. No other allergies"))

    def test_nurse_skips_external_conflict_when_negated(self):
        st = nurse.NurseState(nreq(patient={"name": "R", "age": 60, "gender": "M", "allergies": "No known drug allergies"}))
        ext = {"ok": True, "drug": "warfarin", "classes": [], "allergyConflict": "bogus", "interactions": [], "sources": []}
        with mock.patch.object(drugsafety, "check_drug", mock.AsyncMock(return_value=ext)):
            res = asyncio.run(st.aexecute("check_allergies_and_interactions", {"medicationId": "warfarin-5"}))
        self.assertTrue(res["safe"])


# ---------------------------------------------------------------- 7, 14. nurse resilience

def tool_call(name, args):
    return {"content": "", "tool_calls": [{"id": "c1", "function": {"name": name, "arguments": json.dumps(args)}}]}


class NurseFallback(unittest.TestCase):
    def test_no_json_replay_after_steps_ran(self):
        seq = [tool_call("order_test", {"testId": "cbc"})]

        async def chat(messages, **kw):
            if seq:
                return seq.pop(0), "sarvam"
            raise HTTPException(status_code=502, detail="upstream broke")

        plan = mock.AsyncMock()
        with mock.patch.object(nurse, "chat", chat), mock.patch.object(nurse, "_run_json_plan", plan), \
                mock.patch.object(nurse, "_record_to_ehr", mock.AsyncMock()):
            out = asyncio.run(nurse.nurse_act(nreq(utterance="order a CBC")))
        plan.assert_not_called()
        self.assertEqual(out["applied"]["orderedTestIds"], ["cbc"])
        self.assertIn("Complete Blood Count", out["spokenConfirmation"])

    def test_second_failure_is_a_clean_response(self):
        async def chat(messages, **kw):
            raise HTTPException(status_code=502, detail="down")

        with mock.patch.object(nurse, "chat", chat):
            out = asyncio.run(nurse.nurse_act(nreq(utterance="order a CBC")))
        self.assertEqual(out["intent"], "none")
        self.assertEqual(out["steps"], [])
        self.assertTrue(out["spokenConfirmation"])

    def test_json_plan_ignores_malformed_calls(self):
        replies = [{"content": json.dumps({"intent": "order", "calls": [1, "x", {"tool": "order_test", "args": "bad"},
                                                                         {"tool": "order_test", "args": {"testId": "cbc"}}]})},
                   {"content": "Okay doctor."}]

        async def chat(messages, **kw):
            return replies.pop(0), "groq"

        st = nurse.NurseState(nreq())
        steps: list = []
        with mock.patch.object(nurse, "chat", chat):
            asyncio.run(nurse._run_json_plan(st, st.req, steps))
        self.assertEqual([s["tool"] for s in steps], ["order_test", "order_test"])
        self.assertEqual(st.new_tests, ["cbc"])
        bad = {"content": json.dumps({"intent": "order", "calls": "order everything"})}

        async def chat2(messages, **kw):
            return bad, "groq"

        with mock.patch.object(nurse, "chat", chat2):
            self.assertEqual(asyncio.run(nurse._run_json_plan(st, st.req, [])), ("", "NO_ORDER"))

    def test_tool_exceptions_do_not_escape(self):
        st = nurse.NurseState(nreq(contact="+919876543210"))
        with mock.patch.object(st, "send_to_patient", mock.AsyncMock(side_effect=RuntimeError("x"))):
            res = asyncio.run(st.aexecute("send_to_patient", {"channel": "auto"}))
        self.assertFalse(res["ok"])
        with mock.patch.object(st, "_calendar", mock.AsyncMock(side_effect=KeyError("x"))):
            res = asyncio.run(st.aexecute("schedule_follow_up", {"inDays": 3, "reason": "r"}))
        self.assertTrue(res["ok"])
        with mock.patch.object(st, "_real_drug_check", mock.AsyncMock(side_effect=ValueError("x"))):
            res = asyncio.run(st.aexecute("check_allergies_and_interactions", {"medicationId": "warfarin-5"}))
        self.assertTrue(res["ok"])


# ---------------------------------------------------------------- 8. nurse address

class AshaPatient(unittest.TestCase):
    def msgs(self, persona, text):
        return [{"role": "system", "content": persona}, {"role": "user", "content": text}]

    def test_patient_named_asha(self):
        for persona in ("You are Asha, a 34-year-old woman and the patient. You are a REAL person",
                        "You are a human patient named Asha, a 34-year-old woman.",
                        "You are the mother of Asha, a 6-year-old girl."):
            self.assertFalse(addressed_to_nurse(self.msgs(persona, "Asha, where does it hurt?")), persona)
            self.assertTrue(addressed_to_nurse(self.msgs(persona, "Nurse Asha, order a CBC")), persona)
            self.assertTrue(addressed_to_nurse(self.msgs(persona, "Sister Asha, get an ECG")), persona)
            self.assertTrue(addressed_to_nurse(self.msgs(persona, "Nurse, order a CBC")), persona)

    def test_other_patients_and_usha(self):
        persona = "You are Ravi, a 52-year-old man and the patient."
        self.assertTrue(addressed_to_nurse(self.msgs(persona, "Asha, order a CBC")))
        self.assertFalse(addressed_to_nurse(self.msgs(persona, "Usha, how are you feeling?")))


# ---------------------------------------------------------------- 9. render.yaml

class RenderBlueprint(unittest.TestCase):
    def test_uvicorn_trusts_proxy_headers(self):
        text = (Path(__file__).resolve().parents[2] / "render.yaml").read_text(encoding="utf-8")
        line = next(x for x in text.splitlines() if "startCommand" in x)
        self.assertIn("--proxy-headers", line)
        self.assertIn("--forwarded-allow-ips='*'", line)


# ---------------------------------------------------------------- 11. start times

class StartTimes(unittest.TestCase):
    def test_past_start_rolls_to_next_day(self):
        ist = calendar_invite.IST
        mon = datetime(2026, 11, 23, 11, 0, tzinfo=ist)
        self.assertEqual(calendar_invite.pick_start(0, mon), datetime(2026, 11, 24, 10, 0, tzinfo=ist))
        sat = datetime(2026, 11, 21, 11, 0, tzinfo=ist)  # Saturday after 10 am -> Sunday -> Monday
        self.assertEqual(calendar_invite.pick_start(0, sat), datetime(2026, 11, 23, 10, 0, tzinfo=ist))
        early = datetime(2026, 11, 23, 9, 0, tzinfo=ist)
        self.assertEqual(calendar_invite.pick_start(0, early), datetime(2026, 11, 23, 10, 0, tzinfo=ist))

    def test_fhir_appointment_uses_calendar_start(self):
        seen = []

        def h(req):
            seen.append(json.loads(req.content))
            return httpx.Response(201, json={"id": "a1"})

        fhir._patient_cache.clear()
        with mock.patch.dict(os.environ, {"FHIR_ENABLED": "1", "FHIR_BASE_URL": "https://fhir.test/r4"}), \
                mock.patch.object(fhir, "_client_factory", lambda: httpx.AsyncClient(transport=httpx.MockTransport(h))):
            asyncio.run(fhir.record_batch({"id": "c1", "name": "R"}, [], [],
                                          {"inDays": 0, "reason": "call", "start": "2026-11-24T15:35:00+05:30"}))
        appt = next(b for b in seen if b.get("resourceType") == "Appointment")
        self.assertEqual(appt["start"], "2026-11-24T15:35:00+05:30")
        self.assertEqual(appt["end"], "2026-11-24T15:50:00+05:30")


# ---------------------------------------------------------------- 2, 12, 13. Asha call start

ENV = {"AGORA_APP_ID": "0" * 32, "AGORA_APP_CERTIFICATE": "1" * 32, "AGORA_CUSTOMER_ID": "cust",
       "AGORA_CUSTOMER_SECRET": "secret", "MURF_API_KEY": "murf-test", "SARVAM_API_KEY": "sarvam-test"}
SNAP = {"caseId": "im-001", "patientName": "Ravi Kumar", "age": 52, "gender": "M", "chiefComplaint": "cough",
        "prescriptions": [], "reason": "check", "lang": "en"}


class CallStartFixes(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, {**ENV, "FOLLOWUP_MAX_CONCURRENT": "", "FOLLOWUP_MAX_PER_DAY": ""})
        env.start()
        self.addCleanup(env.stop)
        import followup_call
        import server
        import voice

        self.fc, self.voice = followup_call, voice
        followup_call._history.clear()
        followup_call._locks.clear()
        self.n = 0

        async def start(req, **kw):
            self.n += 1
            await asyncio.sleep(0.01)
            return voice.VoiceStartResponse(appId="a", channel="c", uid=1, token="t", agentUid=2,
                                            agentId=f"agent-{self.n}", avatarError="Agora rejected the avatar (400): SECRET")

        for p in (mock.patch.object(voice, "start_agent_session", start),
                  mock.patch.object(voice, "leave_agent", mock.AsyncMock()),
                  mock.patch.object(followup_call, "_schedule_guard", lambda call, lang: None)):
            p.start()
            self.addCleanup(p.stop)
        from fastapi.testclient import TestClient

        self.client = TestClient(server.app)

    def test_avatar_error_is_not_returned(self):
        tok = followup_calls.register_call(SNAP)
        r = self.client.post(f"/call-api/{tok}/start")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("avatarError", r.json())
        self.assertNotIn("SECRET", r.text)

    def test_upstream_error_body_is_hidden(self):
        tok = followup_calls.register_call(SNAP)
        boom = mock.AsyncMock(side_effect=HTTPException(502, "Agora join failed (400): SECRET body"))
        with mock.patch.object(self.voice, "start_agent_session", boom):
            r = self.client.post(f"/call-api/{tok}/start")
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("SECRET", r.text)

    def test_global_concurrency_cap(self):
        a, b, c = (followup_calls.register_call(SNAP) for _ in range(3))
        self.assertEqual(self.client.post(f"/call-api/{a}/start").status_code, 200)
        self.assertEqual(self.client.post(f"/call-api/{b}/start").status_code, 200)
        r = self.client.post(f"/call-api/{c}/start")
        self.assertEqual(r.status_code, 429)
        self.assertIn("other calls", r.json()["detail"])
        self.assertEqual(self.fc.calls_left(c), 3)  # a refused start costs nothing

    def test_global_daily_cap(self):
        with mock.patch.dict(os.environ, {"FOLLOWUP_MAX_PER_DAY": "2", "FOLLOWUP_MAX_CONCURRENT": "10"}):
            toks = [followup_calls.register_call(SNAP) for _ in range(3)]
            self.assertEqual(self.client.post(f"/call-api/{toks[0]}/start").status_code, 200)
            self.assertEqual(self.client.post(f"/call-api/{toks[1]}/start").status_code, 200)
            r = self.client.post(f"/call-api/{toks[2]}/start")
        self.assertEqual(r.status_code, 429)
        self.assertIn("today", r.json()["detail"])
        with mock.patch.object(self.fc.time, "time", return_value=time.time() + self.fc.DAY_S + 1):
            self.assertEqual(self.fc._global_load(self.fc.time.time())[1], 0)

    def test_parallel_taps_leave_one_live_agent(self):
        tok = followup_calls.register_call(SNAP)

        async def both():
            return await asyncio.gather(self.fc.call_start(tok), self.fc.call_start(tok))

        asyncio.run(both())
        self.assertEqual(len(self.fc._live_calls(tok)), 1)
        self.assertEqual(self.fc.calls_left(tok), 1)


if __name__ == "__main__":
    unittest.main()
