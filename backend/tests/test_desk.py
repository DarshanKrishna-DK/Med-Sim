"""Priya's desk in the agent room: a human or the teacher answers, never Priya. No network."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
for _p in (str(_B), str(_B / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import agent_toolsets  # noqa: E402
import reception  # noqa: E402
from agentroom import bedside, desk, hub as hubmod, siderooms  # noqa: E402
from agentroom.protocol import Handoff  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from test_siderooms import SideCase  # noqa: E402

REPORT = {"student": "Anitha Rao", "domains": {"Communication": 42.0, "Tests": 80.0},
          "items": [{"kind": "case", "label": "Lakshmi Sharma, 45F", "specialty": "cardiology", "bestScore": 41},
                    {"kind": "case", "label": "Ravi Kumar, 60M", "specialty": "neurology", "bestScore": None}],
          "weaknesses": ["Lakshmi was not told about side effects", "Not yet attempted: Ravi Kumar, 60M"]}


class DeskTests(SideCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        p = mock.patch.object(hubmod, "hub", self.hub)
        p.start()
        self.addCleanup(p.stop)

    async def ask(self, q: str = "Can I take the viva on Friday? Anitha Rao here", **kw):
        return await desk.ask_faculty(q, student="Anitha Rao", **kw)

    async def test_question_reaches_the_human_and_the_reply_reaches_the_student(self) -> None:
        res = await self.ask(lang="hi")
        self.assertTrue(res["ok"] and res["delivered"])
        self.assertTrue(bedside.in_language(res["spoken"], "hi"))
        self.assertEqual(self.band.room["people"][0]["name"], "Receptionist Priya")
        blob = json.dumps(list(self.band.rooms.values()))
        self.assertIn("Can I take the viva on Friday?", blob)
        self.assertNotIn("Anitha", blob)
        side = siderooms.by_id(res["sideId"], self.hub)
        self.assertEqual(side.state["status"], "asked")  # nothing is answered until a person does
        self.band.human("Yes, at 10 am. Bring your logbook.", to="reception")
        await self.until(lambda: side.state["status"] == "answered")
        self.assertEqual((side.state["answer"], side.state["by"]), ("Yes, at 10 am. Bring your logbook.", self.band.owner["name"]))
        self.assertTrue(bedside.in_language(side.state["spoken"], "hi"))  # no translator in tests: the fixed line
        self.assertIn("स्क्रीन", side.state["spoken"])
        # a second reply, and a follow-up question in the same room
        self.band.human("And tell the office.", to="reception")
        await self.until(lambda: len(side.state["answers"]) == 2)
        again = await self.ask("Which office?", side_id=res["sideId"])
        self.assertEqual((again["sideId"], len(self.band.rooms)), (res["sideId"], 1))

    async def test_reply_is_spoken_in_english_as_written(self) -> None:
        res = await self.ask(lang="en")
        side = siderooms.by_id(res["sideId"], self.hub)
        self.band.human("Yes, at 10 am.", to="reception")
        await self.until(lambda: side.state["status"] == "answered")
        self.assertTrue(side.state["spoken"].endswith("has replied to your question: Yes, at 10 am."))

    async def test_no_key_or_outage_is_said_plainly(self) -> None:
        with mock.patch.dict(os.environ, {"BAND_RECEPTION_API_KEY": ""}):
            res = await self.ask(lang="kn")
        self.assertFalse(res["ok"])
        self.assertTrue(bedside.in_language(res["spoken"], "kn"))
        self.band.down = True
        res = await self.ask()
        self.assertFalse(res["ok"])
        self.assertEqual((await desk.ask_faculty("  "))["ok"], False)

    async def test_revision_plan_comes_from_the_teacher_without_names(self) -> None:
        task = asyncio.ensure_future(desk.revision_plan(REPORT, lang="ta"))
        await self.until(lambda: self.sent("study_plan"))
        h = self.sent("study_plan")[0]
        blob = json.dumps(list(self.band.rooms.values()))
        for name in ("Anitha", "Lakshmi", "Sharma", "Ravi"):
            self.assertNotIn(name, blob)
        self.assertEqual((h.data["clinic"], h.data["weak"][0]), ("cardiology", {"name": "Communication", "pct": 42}))
        self.band.say("teacher", Handoff("answer", "study_plan", h.ref, data={"topic": "Explaining side effects", "cases": ["card-003"], "reason": "R."}), to="reception")
        res = await task
        self.assertTrue(res["ready"])
        self.assertEqual((res["plan"]["topic"], res["plan"]["caseId"]), ("Explaining side effects", "card-003"))
        self.assertTrue(bedside.in_language(res["spoken"], "ta"))

    async def test_silent_teacher_is_not_waited_for_and_never_invented(self) -> None:
        with mock.patch.object(desk, "PLAN_WAIT_S", 0.1), mock.patch.object(desk, "PLAN_TIMEOUT_S", 0.3):
            res = await desk.revision_plan(REPORT)
            self.assertEqual((res["ok"], res["ready"]), (True, False))
            side = siderooms.by_id(res["sideId"], self.hub)
            await self.until(lambda: side.state["status"] == "failed")

    async def test_typed_path(self) -> None:
        async def llm(st, messages, steps):
            res = await st.execute("ask_faculty", {"question": "May I skip the ward round?"})
            steps.append({"tool": "ask_faculty", "args": {}, "ok": bool(res.get("ok")), "summary": reception.summarize("ask_faculty", res), "result": res})
            return "Sir says yes, of course you may!"  # the model may not answer for the faculty

        with mock.patch.object(reception, "_run_native", llm):
            out = await reception.reception_act(reception.ReceptionActRequest(utterance="ask sir", lang="te", profile={"name": "Anitha Rao"}))
        self.assertTrue(bedside.in_language(out["spokenConfirmation"], "te"))
        self.assertNotIn("Sir says yes", out["spokenConfirmation"])
        self.assertEqual((out["desk"]["kind"], out["desk"]["question"]), ("desk", "May I skip the ward round?"))

    async def test_typed_path_without_a_model(self) -> None:
        async def down(*a, **k):
            raise HTTPException(status_code=503, detail="down")

        with mock.patch.object(reception, "_run_native", down):
            out = await reception.reception_act(reception.ReceptionActRequest(utterance="Please ask the professor if my viva is on Monday"))
        self.assertEqual((out["source"], out["steps"][0]["tool"]), ("keywords", "ask_faculty"))
        self.assertEqual(reception.keyword_plan("what should I revise next")[0][0], "ask_revision_plan")
        self.assertEqual(reception.keyword_plan("email my report to my teacher")[-1][0], "email_report_to_teacher")
        self.assertEqual(reception.keyword_plan("send my scores to sir")[-1][0], "email_report_to_teacher")

    async def test_voice_path_publishes_the_room(self) -> None:
        events: list[tuple[str, dict]] = []
        tctx = {"ctx": {"profile": {"name": "Anitha Rao"}}, "lang": "bn", "publish": lambda t, d=None: events.append((t, d))}
        res = await agent_toolsets.reception_exec("ask_faculty", {"question": "Is the viva on Monday?"}, tctx)
        self.assertTrue(res["ok"] and bedside.in_language(res["say_this"], "bn"))
        self.assertEqual(events[0][0], "desk_room")
        self.assertEqual(events[0][1]["kind"], "desk")
        self.assertIn("BAND", agent_toolsets.reception_summary("ask_faculty", {"ok": True, "asked": "Dr Rao"}))


if __name__ == "__main__":
    import unittest

    unittest.main()
