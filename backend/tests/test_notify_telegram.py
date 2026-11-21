"""Telegram channel: chat resolution, message + Murf audio + calendar invite, no network."""

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from integrations import notify  # noqa: E402


class TelegramTests(unittest.TestCase):
    def setUp(self):
        notify._sends.clear()
        notify._tg_chats.clear()
        self.calls = []

        def handler(req: httpx.Request) -> httpx.Response:
            method = req.url.path.rsplit("/", 1)[-1]
            self.calls.append((method, req))
            if method == "getUpdates":
                return httpx.Response(200, json={"ok": True, "result": [
                    {"update_id": 1, "message": {"chat": {"id": 111, "username": "other"}, "text": "/start"}},
                    {"update_id": 2, "message": {"chat": {"id": 222, "username": "DrDemo"}, "text": "/start medsim"}},
                ]})
            if method == "getMe":
                return httpx.Response(200, json={"ok": True, "result": {"username": "medsim_bot"}})
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 7}})

        env = mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:abc"})
        env.start()
        self.addCleanup(env.stop)
        factory = mock.patch.object(notify, "_client_factory", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        factory.start()
        self.addCleanup(factory.stop)

    def send(self, to, channel="auto"):
        return asyncio.run(notify.send_to_patient(channel, to, "Hello", None, b"mp3", b"BEGIN:VCALENDAR"))

    def test_latest_chat_gets_message_audio_and_invite(self):
        res = self.send("telegram")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["channel"], "telegram")
        methods = [m for m, _ in self.calls]
        self.assertEqual(methods, ["getUpdates", "sendMessage", "sendAudio", "sendDocument"])
        self.assertEqual(json.loads(self.calls[1][1].content)["chat_id"], 222)
        self.assertTrue(res["audioSent"] and res["inviteSent"])

    def test_username_picks_that_chat(self):
        self.send("@other")
        self.assertEqual(json.loads(self.calls[1][1].content)["chat_id"], 111)

    def test_explicit_chat_id_skips_lookup(self):
        self.send("tg:333")
        self.assertEqual(self.calls[0][0], "sendMessage")

    def test_unconfigured(self):
        with mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": ""}):
            res = self.send("telegram", "telegram")
        self.assertFalse(res["ok"])

    def test_bot_link(self):
        info = asyncio.run(notify.telegram_bot_info())
        self.assertEqual(info["link"], "https://t.me/medsim_bot?start=medsim")

    def test_mask_and_detection(self):
        self.assertTrue(notify.is_telegram("@DrDemo"))
        self.assertFalse(notify.is_telegram("a@b.com"))
        self.assertEqual(notify.mask("telegram"), "Telegram chat")
        self.assertIn("telegram", notify.configured_channels())


if __name__ == "__main__":
    unittest.main()
