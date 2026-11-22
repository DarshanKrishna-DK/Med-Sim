"""Drug and allergy words: native scripts, Indian brands, stems, negation. Pure."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import drugterms as d  # noqa: E402
import nurse  # noqa: E402

MEDS = [{"id": "amoxicillin-clavulanate-1g", "name": "Amoxicillin/Clavulanate 1g"}, {"id": "azithromycin-500", "name": "Azithromycin 500mg"},
        {"id": "trimethoprim-smx", "name": "Trimethoprim/Sulfamethoxazole DS"}, {"id": "ibuprofen-400", "name": "Ibuprofen 400mg"},
        {"id": "paracetamol-500", "name": "Paracetamol 500mg"}, {"id": "pantoprazole-40", "name": "Pantoprazole 40mg"}]


def state(allergies: str = "", anamnesis=(), utterance: str = "x") -> nurse.NurseState:
    return nurse.NurseState(nurse.NurseActRequest(
        caseId="c", utterance=utterance, catalog={"tests": [], "medications": MEDS},
        patient={"name": "A", "allergies": allergies, "anamnesis": [{"question": q, "answer": a} for q, a in anamnesis]}))


class AllergyNegation(unittest.TestCase):
    NEGATIVE = ["No allergy to penicillin", "NKDA", "No known drug allergies", "none", "nil", "Not allergic to penicillin", "Denies any allergies",
                "denies allergy to sulfa, penicillin or aspirin", "no history of penicillin allergy", "I do not have penicillin allergy", "Allergies: none",
                "कोई एलर्जी नहीं है", "पेनिसिलिन से एलर्जी नहीं है", "ಪೆನಿಸಿಲಿನ್ ಅಲರ್ಜಿ ಇಲ್ಲ", "அலர்ஜி இல்லை", "అలర్జీ లేదు", "ऍलर्जी नाही",
                "পেনিসিলিনে এলার্জি নেই", "penicillin se allergy nahi hai", "No, nothing", "No"]
    POSITIVE = ["Penicillin (rash)", "Penicillin. No other allergies", "No known allergies except penicillin", "allergic to penicillin, no other allergies",
                "I don't take penicillin because I'm allergic", "Penicillin allergy - no rash since", "Yes, penicillin. I got hives",
                "penicillin se allergy hai isliye nahi leta", "पेनिसिलिन से एलर्जी है", "ಪೆನಿಸಿಲಿನ್‌ಗೆ ಅಲರ್ಜಿ ಇದೆ", "பென்சிலினுக்கு அலர்ஜி",
                "పెన్సిలిన్ అలర్జీ ఉంది", "পেনিসিলিনে এলার্জি আছে", "पेनिसिलिनची ऍलर्जी आहे", "allergic to amoxy", "maybe allergic to penicillin, not sure"]

    def test_negated_never_blocks_and_real_ones_do(self) -> None:
        for t in self.NEGATIVE:
            self.assertEqual(state(t)._warnings("amoxicillin-clavulanate-1g")[0], [], t)
        for t in self.POSITIVE:
            self.assertTrue(state(t)._warnings("amoxicillin-clavulanate-1g")[0], t)

    def test_mixed(self) -> None:
        st = state("not allergic to penicillin but allergic to sulfa")
        self.assertEqual(st._warnings("amoxicillin-clavulanate-1g")[0], [])
        self.assertTrue(st._warnings("trimethoprim-smx")[0])
        self.assertTrue(state("सल्फा से एलर्जी")._warnings("trimethoprim-smx")[0])
        self.assertTrue(state("painkiller allergy")._warnings("ibuprofen-400")[0])
        self.assertTrue(state("Crocin se allergy hai")._warnings("paracetamol-500")[0])

    def test_interview_answers(self) -> None:
        self.assertTrue(state("", [("Are you allergic to penicillin?", "Yes")])._warnings("amoxicillin-clavulanate-1g")[0])
        self.assertTrue(state("", [("Are you allergic to penicillin?", "हाँ")])._warnings("amoxicillin-clavulanate-1g")[0])
        self.assertEqual(state("", [("Are you allergic to penicillin?", "No")])._warnings("amoxicillin-clavulanate-1g")[0], [])
        self.assertEqual(state("", [("How is the pain?", "like penicillin")])._warnings("amoxicillin-clavulanate-1g")[0], [])


class Named(unittest.TestCase):
    def test_brands_stems_and_scripts(self) -> None:
        yes = [("start amoxy 500", 0), ("Augmentin 625 de do", 0), ("azithral 500 od", 1), ("azee", 1), ("Crocin", 4), ("dolo 650", 4), ("calpol", 4),
               ("Pan 40 subah khali pet", 5), ("pantocid", 5), ("combiflam", 3), ("brufen", 3), ("ಪ್ಯಾರಸಿಟಮಾಲ್ ಕೊಡಿ", 4), ("पैरासिटामोल दे दो", 4),
               ("பாராசிட்டமால் கொடுங்க", 4), ("పాంటోప్రజోల్ ఇవ్వండి", 5), ("অ্যাজিথ্রোমাইসিন দিন", 1), ("give para 500", 4)]
        for said, i in yes:
            self.assertTrue(state(utterance=said)._named_by_doctor(MEDS[i]["id"], MEDS[i]["name"]), said)
        for said, i in [("start amoxicillin", 1), ("the pain is sprain like", 5), ("a parallel bar", 4), ("augmentin", 1), ("company", 5)]:
            self.assertFalse(state(utterance=said)._named_by_doctor(MEDS[i]["id"], MEDS[i]["name"]), said)

    def test_any_catalog_drug_in_native_script(self) -> None:
        for said, mid, name in [("அம்லோடிபின்", "amlodipine-5", "Amlodipine 5mg"), ("सर्ट्रालिन", "sertraline-50", "Sertraline 50mg"),
                                ("ಕ್ಲೋಪಿಡೋಗ್ರೆಲ್", "clopidogrel-75", "Clopidogrel 75mg"), ("ఒండాన్సెట్రాన్", "ondansetron-8", "Ondansetron 8mg")]:
            self.assertTrue(d.mentions_drug(said, mid, name), said)

    def test_catalog_search(self) -> None:
        st = state()
        for q, want in [("crocin", "paracetamol-500"), ("augmentin", "amoxicillin-clavulanate-1g"), ("pan 40", "pantoprazole-40"), ("amoxy", "amoxicillin-clavulanate-1g"),
                        ("पैरासिटामोल", "paracetamol-500"), ("ibuprofen", "ibuprofen-400")]:
            self.assertEqual(st.find_in_catalog(q, "medication")["matches"][0]["id"], want, q)
        self.assertFalse(st.find_in_catalog("zzz", "medication")["ok"])

    def test_norm_keeps_native_letters(self) -> None:
        self.assertEqual(d.norm("Urine β-hCG (x)"), "urine hcg x")
        self.assertEqual(nurse._norm("पेनिसिलिन!"), "पेनिसिलिन")
        self.assertIn("penicillin", d.expand("ಪೆನಿಸಿಲಿನ್"))


if __name__ == "__main__":
    unittest.main()
