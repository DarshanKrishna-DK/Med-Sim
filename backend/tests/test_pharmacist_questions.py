"""The doctor asks the pharmacist about a drug: the asked drug is checked, context is context,
and no model wording can go against the fixed verdict."""
from __future__ import annotations

import asyncio
import re
import sys
import unittest
from pathlib import Path

_B = Path(__file__).resolve().parents[1]
for _p in (str(_B), str(_B / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import test_agentroom_departments as dep  # noqa: E402
from agentroom import drugquestion as dq, pharmacist  # noqa: E402
from agentroom import dept_phrases as phrases  # noqa: E402
from agentroom.protocol import Handoff  # noqa: E402

LANGS = phrases.LANGS
F = pharmacist.Formulary()
IX = dq.index_for(F.meds)


def roles(q):
    return {d.key: d.role for d in dq.parse(q, IX).drugs}


# The reported case, the way it is said in every language and mixed.
DOXY_WARFARIN = {
    "en": ["Meera, can I give doxycycline instead of amoxicillin? He is on warfarin too.",
           "Is doxycycline okay with warfarin?", "We want to switch to doxycycline, the patient takes warfarin daily"],
    "hi": ["Meera, iske jagah doxycycline de sakte hain kya? warfarin bhi le raha hai",
           "अमोक्सिसिलिन की जगह डॉक्सीसाइक्लिन दे सकते हैं? वारफेरिन भी ले रहे हैं",
           "मीरा, doxycycline दे सकते हैं क्या, मरीज़ warfarin पर है", "warfarin ke saath doxy theek hai?"],
    "kn": ["ಅಮೋಕ್ಸಿಸಿಲಿನ್ ಬದಲು ಡಾಕ್ಸಿಸೈಕ್ಲಿನ್ ಕೊಡಬಹುದಾ? ವಾರ್ಫರಿನ್ ಕೂಡ ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದಾರೆ",
           "ವಾರ್ಫರಿನ್ ಜೊತೆ doxycycline ಕೊಡಬಹುದಾ", "doxycycline kodbahuda? warfarin tagoltha iddare"],
    "ta": ["டாக்ஸிசைக்ளின் கொடுக்கலாமா? வார்ஃபரின் சாப்பிடுகிறார்", "warfarin உடன் doxycycline கொடுக்கலாமா"],
    "te": ["డాక్సీసైక్లిన్ ఇవ్వవచ్చా? వార్ఫరిన్ తీసుకుంటున్నారు"],
    "mr": ["डॉक्सीसाइक्लिन देऊ शकतो का? वारफेरिन घेत आहे", "वारफेरिन सोबत doxycycline देऊ शकतो का"],
    "bn": ["ডক্সিসাইক্লিন দেওয়া যাবে? ওয়ারফারিন খাচ্ছেন"],
}


class ParseTests(unittest.TestCase):
    def test_asked_drug_and_context_in_every_language(self):
        for lang, qs in DOXY_WARFARIN.items():
            for q in qs:
                r = roles(q)
                self.assertEqual((r.get("doxycycline"), r.get("warfarin")), ("asked", "taking"), (lang, q, r))

    def test_roles(self):
        for q, want in (
            ("Can I put him on doxycycline", {"doxycycline": "asked"}),
            ("the patient is on warfarin and digoxin, can I give ibuprofen", {"warfarin": "taking", "digoxin": "taking", "ibuprofen": "asked"}),
            ("warfarin aur digoxin le raha hai, brufen de du?", {"warfarin": "taking", "digoxin": "taking", "ibuprofen": "asked"}),
            ("She is allergic to sulfa, can I give septran?", {"class:sulfa": "allergy", "sulfamethoxazole": "asked"}),
            ("penicillin allergy hai, azithral de sakte hain kya", {"class:penicillin": "allergy", "azithromycin": "asked"}),
            ("switch from amoxicillin to azithromycin", {"amoxicillin": "replaced", "azithromycin": "asked"}),
            ("doxycycline aur warfarin ek saath de sakte hain?", {"doxycycline": "asked", "warfarin": "taking"}),
            ("azithromycin or doxycycline?", {"azithromycin": "asked", "doxycycline": "asked"}),
            ("can I give doxicyclin 100 bd", {"doxycycline": "asked"}),
            ("Can I give clindamycin?", {"clindamycin": "asked"}),
            ("what about bluecomycin", {"bluecomycin": "asked"}),
            ("Can I use a cephalosporin?", {"class:cephalosporin": "asked"}),
            ("Release it anyway", {}), ("ಕೊಡಿ ಪರವಾಗಿಲ್ಲ", {}), ("इस मरीज को बुखार तीन दिन से है और पेट में दर्द है", {}),
            ("What is the potassium and should I give fluids", {}),
        ):
            self.assertEqual(roles(q), want, q)

    def test_every_formulary_drug_is_found_by_its_own_name(self):
        for mid, row in F.meds.items():
            base = re.sub(r"\(.*?\)|\d.*$", " ", row[0])
            words = [w for w in re.findall(r"[A-Za-z]{5,}", base) if w.lower() not in dq._NOT_NAMES]
            if words:
                got = [d for d in dq.parse(f"can I give {base.strip()}", IX).drugs if d.role == "asked"]
                self.assertTrue(got and got[0].med_id, (mid, row[0], got))

    def test_permission_or_fact(self):
        for q in ("What class is azithromycin?", "how many days of azithromycin", "azithromycin kitne din"):
            self.assertFalse(dq.wants_permission(q), q)
        for q in ("azithromycin chalega?", "is it safe", "why not doxycycline", "how many days can I give azithromycin"):
            self.assertTrue(dq.wants_permission(q), q)


class AskBase(dep.Base):
    async def held(self, lang="en", allergies="Penicillin (rash)", osce=False, current=(), members=(), **kw):
        bus = dep.Bus("pharmacist", *members)
        await bus.nurse("pharmacist", dep.rx(allergies=allergies, lang=lang, osce=osce, current=current, **kw))
        self.assertEqual(bus.last("pharmacist", "verdict").data["verdict"], "hold")
        return bus

    async def ask(self, bus, q, lang="en", osce=False, **ctx):
        await bus.nurse("pharmacist", Handoff("request", "ask", "ask_1", enc="enc1", lang=lang, data={
            "caseId": "im-005", "question": q, "context": {"allergies": "Penicillin (rash)", "current": [], **ctx}, "osce": osce}))
        return bus.last("pharmacist", "answer")


class ReportedCaseTests(AskBase):
    async def test_doxycycline_with_warfarin_while_amoxicillin_is_held(self):
        bus = await self.held()
        a = await self.ask(bus, "Meera, iske jagah doxycycline de sakte hain kya? warfarin bhi le raha hai")
        self.assertEqual(a.data["text"], "Doxycycline is fine with the penicillin allergy. "
                                         "With Warfarin it can raise the INR, so check INR in 3 to 5 days.")
        self.assertEqual([(c["drug"], c["verdict"]) for c in a.data["checked"]], [("Doxycycline", "release")])

    async def test_the_same_question_in_every_language(self):
        for lang, qs in DOXY_WARFARIN.items():
            for q in qs:
                bus = await self.held(lang)
                a = await self.ask(bus, q, lang)
                self.assertEqual(a.data["checked"][0]["verdict"], "release", q)
                self.assertIn("Doxycycline", a.spoken, q)
                self.assertIn("Warfarin", a.spoken, q)
                self.assertIn("INR", a.spoken, q)
                self.assertNotIn("Amoxicillin", a.spoken, q)
                if lang != "en":
                    self.assertScript(a.spoken, lang)
                self.assertLessEqual(len(re.findall(r"[.।](?:\s|$)", a.spoken)), 2, a.spoken)

    async def test_the_model_is_not_asked(self):
        bus = await self.held()
        self.llm = "No, we cannot give doxycycline here."
        self.assertIn("is fine", (await self.ask(bus, "Can we give doxycycline?")).data["text"])


class OtherDrugTests(AskBase):
    async def test_same_class_as_the_allergy_is_refused(self):
        bus = await self.held()
        a = await self.ask(bus, "Augmentin de du kya?")
        self.assertEqual(a.data["checked"][0]["verdict"], "hold")
        self.assertTrue(a.data["text"].startswith("Do not give"), a.data["text"])

    async def test_common_warfarin_pairs(self):
        for q, verdict in (("azithromycin", "hold"), ("co-trimoxazole", "hold"), ("metronidazole", "hold"), ("ciprofloxacin", "hold"),
                           ("ibuprofen", "hold"), ("diclofenac", "hold"), ("aspirin", "hold"), ("doxycycline", "release"), ("paracetamol", "release")):
            bus = await self.held()
            for text in (f"Can I give {q}? The patient is on warfarin", f"{q} de sakte hain? warfarin chal raha hai", f"ವಾರ್ಫರಿನ್ ಜೊತೆ {q} ಕೊಡಬಹುದಾ"):
                a = await self.ask(bus, text)
                self.assertEqual(a.data["checked"][0]["verdict"], verdict, (text, a.data))

    async def test_current_medicines_on_the_chart_count(self):
        bus = await self.held()
        a = await self.ask(bus, "can I give ibuprofen?", current=[{"medicationId": "apixaban-5", "name": "Apixaban 5mg"}])
        self.assertEqual(a.data["checked"][0]["verdict"], "hold")

    async def test_context_alone_rechecks_the_drug_under_discussion(self):
        bus = await self.held()
        a = await self.ask(bus, "warfarin bhi le raha hai, koi dikkat?")
        self.assertIn("Amoxicillin", a.data["text"])
        self.assertIn("stays on hold", a.data["text"])

    async def test_not_in_the_formulary_is_said_plainly(self):
        for lang, q in (("en", "Can I give clindamycin?"), ("hi", "क्लिंडामाइसिन दे सकते हैं?"), ("kn", "clindamycin ಕೊಡಬಹುದಾ"), ("hi", "fosfomycin chalega kya")):
            bus = await self.held(lang)
            a = await self.ask(bus, q, lang)
            self.assertEqual(a.data["checked"][0]["verdict"], "not_in_formulary", q)
            want = {"en": "not in our formulary", "hi": "फॉर्मुलरी में नहीं", "kn": "ಫಾರ್ಮುಲರಿಯಲ್ಲಿ ಇಲ್ಲ"}[lang]
            self.assertIn(want, a.data["text"])
            self.assertNotIn("Amoxicillin", a.data["text"])

    async def test_two_drugs_get_one_sentence_each(self):
        bus = await self.held()
        a = await self.ask(bus, "azithromycin or doxycycline? he is on warfarin")
        self.assertEqual([(c["drug"], c["verdict"]) for c in a.data["checked"]], [("Azithromycin", "hold"), ("Doxycycline", "release")])
        self.assertIn("Do not give Azithromycin", a.data["text"])
        self.assertIn("Doxycycline can be given with care", a.data["text"])

    async def test_pregnancy_and_age_still_decide(self):
        bus = await self.held(age=26, gender="F", history=[{"question": "Are you pregnant?", "answer": "Yes, 5 months."}])
        self.assertEqual((await self.ask(bus, "Can I give doxycycline?")).data["checked"][0]["verdict"], "hold")
        bus = await self.held(age=5, gender="M")
        self.assertEqual((await self.ask(bus, "Can I give doxycycline?")).data["checked"][0]["verdict"], "clarify")

    async def test_without_any_order_the_context_is_enough(self):
        bus = dep.Bus("pharmacist")
        a = await self.ask(bus, "can I give septran?", allergies="Sulfa drugs, rash", patient={"age": 40, "gender": "M"})
        self.assertEqual(a.data["checked"][0]["verdict"], "hold")
        a = await self.ask(bus, "can I give azithromycin?", allergies="", patient={"age": 40, "gender": "M"})
        self.assertEqual(a.data["checked"][0]["verdict"], "release")

    async def test_allergy_said_in_the_question(self):
        bus = dep.Bus("pharmacist")
        a = await self.ask(bus, "She is allergic to sulfa, can I give septran?", allergies="")
        self.assertEqual(a.data["checked"][0]["verdict"], "hold")
        a = await self.ask(dep.Bus("pharmacist"), "No allergy to sulfa, can I give septran?", allergies="")
        self.assertNotEqual(a.data["checked"][0]["verdict"], "hold")

    async def test_class_question(self):
        bus = await self.held(allergies="Cephalosporin, anaphylaxis", med="cefuroxime-500", name="Cefuroxime Axetil 500mg", dose="500 mg twice a day")
        a = await self.ask(bus, "Can I use a cephalosporin?", allergies="Cephalosporin, anaphylaxis")
        self.assertEqual(a.data["checked"][0]["verdict"], "hold")
        bus = await self.held()
        self.assertIn("Tell me which", (await self.ask(bus, "Can I use a macrolide?")).data["text"])

    async def test_kidney_function_is_asked_from_the_laboratory(self):
        bus = await self.held(members=("lab",))
        a = await self.ask(bus, "can I give metformin?")
        self.assertTrue(bus.sent_by("pharmacist", "query"))
        self.assertIn(a.data["checked"][0]["verdict"], ("release", "hold"))
        bus = await self.held(members=("lab",))
        bus.deaf.add(dep.IDS["lab"])
        await bus.nurse("pharmacist", Handoff("request", "ask", "ask_1", lang="en", data={"caseId": "im-005", "question": "can I give metformin?", "context": {}}))
        self.assertFalse(bus.sent_by("pharmacist", "answer"))
        for _ in range(200):
            if bus.sent_by("pharmacist", "answer"):
                break
            await asyncio.sleep(0.02)
        self.assertIn("laboratory", bus.last("pharmacist", "answer").data["checked"][0]["reason"])


class HeldDrugTests(AskBase):
    async def test_the_held_drug_itself_stays_held(self):
        bus = await self.held()
        for q in ("Can I give amoxicillin anyway?", "Release the amoxicillin", "अमोक्सिसिलिन दे दो", "ಅಮೋಕ್ಸಿಸಿಲಿನ್ ಕೊಡಿ", "what can I give instead of amoxicillin?"):
            a = await self.ask(bus, q)
            self.assertIn("Amoxicillin 500mg stays on hold", a.data["text"], q)
            self.assertEqual(a.data["checked"][0]["verdict"], "hold")

    async def test_the_suggestion_is_checked_again_once_warfarin_is_known(self):
        bus = await self.held()
        self.assertIn("Azithromycin 500mg is an option", (await self.ask(bus, "why is amoxicillin on hold?")).data["text"])
        a = await self.ask(bus, "amoxicillin nahi de sakte? warfarin bhi le raha hai")
        self.assertNotIn("Azithromycin", a.data["text"])
        self.assertIn("Doxycycline 100mg is an option", a.data["text"])

    async def test_a_co_medication_named_in_a_question_is_remembered_for_the_next_order(self):
        bus = await self.held()
        await self.ask(bus, "he takes warfarin, is doxycycline fine?")
        await bus.nurse("pharmacist", dep.rx(med="azithromycin-500", name="Azithromycin 500mg", dose="500 mg once a day", ref="rx_2", allergies="Penicillin (rash)"))
        v = bus.last("pharmacist", "verdict")
        self.assertEqual((v.ref, v.data["verdict"]), ("rx_2", "hold"))
        self.assertEqual(v.data["suggestion"]["medicationId"], "doxycycline-100")

    async def test_osce_never_names_an_alternative(self):
        bus = await self.held(osce=True)
        for q in ("why is amoxicillin on hold?", "what instead of amoxicillin?", "can I give augmentin?"):
            a = await self.ask(bus, q, osce=True)
            for alt in ("zithromycin", "oxycycline"):
                self.assertNotIn(alt, a.data["text"], q)

    async def test_context_is_never_the_order(self):
        bus = await self.held()
        a = await self.ask(bus, "he is on warfarin. can I release it?")
        self.assertNotIn("Warfarin is", a.data["text"])
        self.assertIn("Amoxicillin", a.data["text"])

    async def test_a_person_asking_gets_the_same_check(self):
        bus = await self.held(members=("faculty",))
        await bus.human("pharmacist", "Can we give doxycycline instead, he is on warfarin?")
        text = bus.sent_by("pharmacist")[-1][1]
        self.assertIn("Doxycycline is fine", text)
        self.assertNotIn("Nurse Asha", text)


class WordingTests(AskBase):
    def test_guard(self):
        v = {"amoxicillin": "hold", "doxycycline": "release"}
        for text, ok in (
            ("Amoxicillin is on hold because of the penicillin allergy.", True),
            ("Doxycycline can be given, check the INR.", True),
            ("Azithromycin is a macrolide.", True),
            ("You can give amoxicillin.", False),
            ("Amoxicillin is safe now.", False),
            ("Doxycycline should be avoided.", False),
            ("Azithromycin is a good alternative.", False),
            ("Do not give ciprofloxacin.", False),
            ("अमोक्सिसिलिन दे सकते हैं।", False),
            ("ಅಜಿತ್ರೋಮೈಸಿನ್ ಕೊಡಬಹುದು.", False),
            ("Yes, go ahead.", False),
        ):
            self.assertEqual(dq.wording_ok(text, v, IX, any_held=True), ok, text)

    async def test_a_contradicting_answer_is_replaced(self):
        bus = await self.held()
        for said in ("You can safely give amoxicillin.", "Ciprofloxacin is a good alternative.", "Yes, go ahead and give it."):
            self.llm = said
            a = await self.ask(bus, "How long does this take?")
            self.assertNotEqual(a.data["text"], said)
        self.llm = "A macrolide stops bacteria making protein."
        self.assertEqual((await self.ask(bus, "How does a macrolide work?")).data["text"], self.llm)

    async def test_facts_about_a_drug_fall_back_to_the_formulary_not_to_the_held_drug(self):
        bus = await self.held()
        for lang in LANGS:
            a = await self.ask(bus, "What is the usual dose of azithromycin?", lang)
            self.assertIn("Azithromycin", a.data["text"])
            self.assertNotIn("Amoxicillin", a.data["text"])


if __name__ == "__main__":
    unittest.main()
