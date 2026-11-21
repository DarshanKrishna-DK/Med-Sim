"""Tests for POST /teach/lesson: validation, normalisation, repair retry, cache. LLM mocked."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_B = Path(__file__).resolve().parents[1]
if str(_B) not in sys.path:
    sys.path.insert(0, str(_B))

from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402
import teacher  # noqa: E402

HDR = {"Origin": "http://localhost:5173"}


def good_lesson(**over):
    lesson = {
        "title": "The Cardiac Cycle",
        "summary": "How the heart fills and pumps in one beat.",
        "steps": [
            {
                "heading": "Two pumps, one beat",
                "points": ["Right heart to lungs", "Left heart to body"],
                "narration": "Think of the heart as two pumps working side by side. One sends blood to the lungs, the other to the body.",
                "visual": {"kind": "flow", "nodes": [{"id": "ra", "label": "Right atrium"}, {"id": "rv", "label": "Right ventricle"}, {"id": "lu", "label": "Lungs"}],
                           "edges": [{"from": "ra", "to": "rv"}, {"from": "rv", "to": "lu", "label": "pulmonary"}]},
            },
            {
                "heading": "Phases in a loop",
                "points": ["Filling", "Contraction", "Ejection", "Relaxation"],
                "narration": "The beat runs as a loop of four phases. Fill, squeeze, push out, relax, and repeat.",
                "visual": {"kind": "cycle", "nodes": ["Filling", "Isovolumic contraction", "Ejection", "Isovolumic relaxation"], "center": "One beat"},
            },
            {
                "heading": "Systole vs diastole",
                "points": ["Systole squeezes", "Diastole fills"],
                "narration": "Systole is the squeeze and diastole is the rest when the chambers fill.",
                "visual": {"kind": "compare", "left": {"title": "Systole", "items": ["Valves AV shut", "Ejection"]},
                           "right": {"title": "Diastole", "items": ["AV valves open", "Filling"]}},
            },
            {
                "heading": "Pressure over time",
                "points": ["LV pressure rises fast"],
                "narration": "If we plot pressure against time, the ventricle shoots up and then falls back.",
                "visual": {"kind": "graph", "xLabel": "time", "yLabel": "pressure",
                           "series": [{"name": "LV", "points": [[0, 5], [0.1, 10], [0.2, 120], [0.3, 100], [0.4, 8]]}]},
            },
        ],
        "quiz": {"question": "Which valve closure makes S1?", "options": ["AV valves", "Semilunar valves", "Mitral only", "None"],
                 "answerIndex": 0, "why": "S1 is closure of the mitral and tricuspid valves."},
    }
    lesson.update(over)
    return lesson


def reply(obj) -> tuple[dict, str]:
    content = obj if isinstance(obj, str) else json.dumps(obj)
    return {"role": "assistant", "content": content}, "sarvam"


class ValidateTests(unittest.TestCase):
    def test_good_lesson_passes_and_keeps_shapes(self):
        out = teacher.validate_lesson(good_lesson(), "cardiac cycle", "student")
        self.assertEqual(len(out["steps"]), 4)
        kinds = [s["visual"]["kind"] for s in out["steps"]]
        self.assertEqual(kinds, ["flow", "cycle", "compare", "graph"])
        cyc = out["steps"][1]["visual"]
        self.assertEqual([n["label"] for n in cyc["nodes"]][0], "Filling")
        self.assertEqual(cyc["center"], "One beat")
        self.assertEqual(out["steps"][0]["visual"]["edges"][1]["label"], "pulmonary")
        self.assertEqual(out["quiz"]["answerIndex"], 0)

    def test_too_few_steps_rejected(self):
        bad = good_lesson()
        bad["steps"] = bad["steps"][:2]
        with self.assertRaises(ValueError):
            teacher.validate_lesson(bad, "x", "student")

    def test_quiz_needs_four_options(self):
        bad = good_lesson(quiz={"question": "Q?", "options": ["a", "b"], "answerIndex": 0})
        with self.assertRaises(ValueError):
            teacher.validate_lesson(bad, "x", "student")

    def test_answer_letter_and_points_capped(self):
        raw = good_lesson(quiz={"question": "Q?", "options": ["A) one", "B) two", "C) three", "D) four"], "answer": "C", "why": "w"})
        raw["steps"][0]["points"] = ["p1", "p2", "p3", "p4", "p5"]
        raw["steps"] = raw["steps"] * 2  # 8 steps -> capped at 6
        out = teacher.validate_lesson(raw, "x", "intern")
        self.assertEqual(out["quiz"]["answerIndex"], 2)
        self.assertEqual(out["quiz"]["options"][0], "one")
        self.assertEqual(len(out["steps"][0]["points"]), 3)
        self.assertEqual(len(out["steps"]), 6)

    def test_unknown_visual_falls_back_to_flow_of_points(self):
        v = teacher.normalize_visual({"kind": "hologram"}, ["a", "b", "c"])
        self.assertEqual(v["kind"], "flow")
        self.assertEqual(len(v["nodes"]), 3)
        self.assertEqual(len(v["edges"]), 2)

    def test_labelled_timeline_and_graph_variants(self):
        lab = teacher.normalize_visual({"kind": "labeled", "center": "Nephron", "labels": ["Glomerulus", {"label": "Loop", "note": "concentrates"}]}, [])
        self.assertEqual(lab["kind"], "labelled")
        self.assertEqual(lab["labels"][1]["note"], "concentrates")
        tl = teacher.normalize_visual({"kind": "timeline", "events": [{"time": "0 min", "label": "Dose"}, {"t": "30 min", "label": "Peak"}]}, [])
        self.assertEqual(tl["events"][0]["t"], "0 min")
        g = teacher.normalize_visual({"kind": "graph", "series": [{"name": "s", "points": [{"x": 2, "y": 1}, {"x": 1, "y": "3"}]}]}, [])
        self.assertEqual(g["series"][0]["points"], [[1.0, 3.0], [2.0, 1.0]])

    def test_prompt_lists_every_waveform_preset_and_bans_graph_for_physiology(self):
        prompt = teacher.SYSTEM.format(level="student", presets=" | ".join(teacher.WAVEFORM_PRESETS))
        for preset in teacher.WAVEFORM_PRESETS:
            self.assertIn(preset, prompt)
        self.assertEqual(len(teacher.WAVEFORM_PRESETS), 14)
        self.assertIn("waveform", prompt)
        self.assertIn("NEVER use graph", prompt)
        self.assertIn("at most 6 points", prompt)

    def test_known_waveform_preset_accepted(self):
        v = teacher.normalize_visual({"kind": "waveform", "preset": "ECG_normal", "highlight": "QRS", "caption": "**Beat**"}, ["a"])
        self.assertEqual(v, {"kind": "waveform", "preset": "ecg-normal", "highlight": "qrs", "caption": "Beat"})
        v = teacher.normalize_visual({"kind": "waveform", "preset": "pv-loop", "highlight": "qrs"}, [])
        self.assertEqual(v, {"kind": "waveform", "preset": "pv-loop"})

    def test_unknown_waveform_preset_falls_back_to_flow_of_points(self):
        v = teacher.normalize_visual({"kind": "waveform", "preset": "made-up-curve"}, ["a", "b", "c"])
        self.assertEqual(v["kind"], "flow")
        self.assertEqual(len(v["nodes"]), 3)
        raw = good_lesson()
        raw["steps"][3]["visual"] = {"kind": "waveform", "preset": "ecg-stemi"}
        raw["steps"][0]["visual"] = {"kind": "waveform", "preset": "nope"}
        out = teacher.validate_lesson(raw, "x", "student")
        self.assertEqual(out["steps"][3]["visual"]["preset"], "ecg-stemi")
        self.assertEqual(out["steps"][0]["visual"]["kind"], "flow")

    def test_markdown_is_stripped_from_text(self):
        raw = good_lesson(title="**Cardiac** cycle")
        self.assertEqual(teacher.validate_lesson(raw, "x", "student")["title"], "Cardiac cycle")

    def test_parse_fenced_json(self):
        self.assertEqual(teacher.parse_json_object('```json\n{"a": 1}\n```'), {"a": 1})
        with self.assertRaises(ValueError):
            teacher.parse_json_object("no json here")


class RouteTests(unittest.TestCase):
    def setUp(self) -> None:
        teacher._cache.clear()
        self.client = TestClient(server.app)

    def test_lesson_ok_then_cached(self):
        with mock.patch.object(teacher, "chat", mock.AsyncMock(return_value=reply(good_lesson()))) as m:
            r1 = self.client.post("/teach/lesson", json={"topic": "Cardiac cycle"}, headers=HDR)
            r2 = self.client.post("/teach/lesson", json={"topic": "  cardiac   CYCLE! "}, headers=HDR)
        self.assertEqual(r1.status_code, 200, r1.text)
        body = r1.json()
        self.assertEqual(body["title"], "The Cardiac Cycle")
        self.assertFalse(body["cached"])
        self.assertTrue(r2.json()["cached"])
        self.assertEqual(m.await_count, 1)
        # json mode requested
        self.assertTrue(m.await_args.kwargs.get("json_mode"))

    def test_repair_retry_then_success(self):
        seq = [reply("sorry, here it is: {broken"), reply(good_lesson())]
        with mock.patch.object(teacher, "chat", mock.AsyncMock(side_effect=seq)) as m:
            r = self.client.post("/teach/lesson", json={"topic": "ECG basics", "level": "intern"}, headers=HDR)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["level"], "intern")
        self.assertEqual(m.await_count, 2)
        repair_msgs = m.await_args_list[1].args[0]
        self.assertIn("not usable", repair_msgs[-1]["content"])

    def test_two_bad_replies_give_502(self):
        bad = good_lesson()
        bad["steps"] = bad["steps"][:1]
        with mock.patch.object(teacher, "chat", mock.AsyncMock(side_effect=[reply(bad), reply(bad)])):
            r = self.client.post("/teach/lesson", json={"topic": "Asthma"}, headers=HDR)
        self.assertEqual(r.status_code, 502)
        self.assertIn("malformed", r.json()["detail"])

    def test_empty_topic_rejected(self):
        r = self.client.post("/teach/lesson", json={"topic": ""}, headers=HDR)
        self.assertEqual(r.status_code, 422)

    def test_ask_returns_clean_reply(self):
        m = mock.AsyncMock(return_value=({"role": "assistant", "content": "<think>x</think>**Good** question. Think of it as a pump."}, "sarvam"))
        with mock.patch.object(teacher, "chat", m):
            r = self.client.post("/teach/ask", json={"system": "You are a teacher.", "messages": [{"role": "user", "content": "What is S1?"}]}, headers=HDR)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["reply"], "Good question. Think of it as a pump.")
        sent = m.await_args.args[0]
        self.assertTrue(sent[0]["content"].startswith("You are a teacher."))
        self.assertIn(teacher.ASK_STYLE, sent[0]["content"])
        self.assertEqual(sent[-1]["content"], "What is S1?")

    def test_ask_model_down_gives_natural_fallback(self):
        for side in (RuntimeError("down"), [({"role": "assistant", "content": "   "}, "sarvam")]):
            with mock.patch.object(teacher, "chat", mock.AsyncMock(side_effect=side)):
                r = self.client.post("/teach/ask", json={"system": "You are a teacher.", "lang": "hi",
                                                         "messages": [{"role": "user", "content": "s1 kya"}]}, headers=HDR)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["fallback"])
            self.assertEqual(r.json()["reply"], teacher.ASK_FALLBACK["hi"])

    def test_ask_style_and_fallbacks_are_human(self):
        self.assertIn("short sentences", teacher.ASK_STYLE)
        self.assertIn("never say you did not understand", teacher.ASK_STYLE)
        for line in teacher.ASK_FALLBACK.values():
            low = line.lower()
            for bad in ("understand", "catch", "sorry", "error"):
                self.assertNotIn(bad, low)

    def test_bad_level_rejected(self):
        r = self.client.post("/teach/lesson", json={"topic": "x", "level": "professor"}, headers=HDR)
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
