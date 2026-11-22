"""Pharmacist Meera: verifies every prescription before it reaches the chart.

The verdict is computed, never generated. Fixed tables (allergy classes, interactions,
pregnancy, age, disease, dose limits, renal limits) plus the public drug databases
produce findings; the worst finding decides release, hold or clarify. When the dose
depends on the kidneys she asks the laboratory first and answers when it replies.
A model is used only to phrase answers to spoken questions, with the verdicts as data.

Training simulator tables, not a clinical reference.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from . import analytes
from . import dept_phrases as phrases
from .answers import PREGNANT, go_ahead, yes_no
from .base import (
    LAB, NURSE, PHARMACIST, DepartmentAdapter, Pending, Room, Turn, clean_text, llm_answer, load_json, text_lang,
    two_sentences,
)
from .protocol import Handoff, new_ref

log = logging.getLogger("medsim.room.pharmacist")

LAB_WAIT_S = 12.0
DB_CAP_S = 8.0          # public drug databases, whole lookup
DB_CAP_HELD_S = 2.5     # when a local check already holds the drug, only a short look for evidence
QUESTION_WAIT_S = 600.0

# ───────────────────────── drug groups ─────────────────────────

# tag -> words that put a drug in the group (matched in its id, name and class)
GROUPS: dict[str, tuple[str, ...]] = {
    "penicillin": ("penicillin", "amoxicillin", "amoxycillin", "ampicillin", "piperacillin", "flucloxacillin", "augmentin",
                   "co-amoxiclav", "coamoxiclav", "cloxacillin", "amoxiclav"),
    "cephalosporin": ("cephalosporin", "cefuroxime", "ceftriaxone", "cefalexin", "cephalexin", "cefixime", "cefazolin",
                      "cefotaxime", "cefpodoxime", "ceftazidime", "cefepime"),
    "sulfa": ("sulfa", "sulpha", "sulfamethoxazole", "trimethoprim", "cotrimoxazole", "co-trimoxazole", "bactrim", "septran",
              "sulfadiazine", "sulfonamide", "tmp-smx"),
    "macrolide": ("macrolide", "azithromycin", "clarithromycin", "erythromycin"),
    "fluoroquinolone": ("fluoroquinolone", "quinolone", "ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin", "norfloxacin"),
    "tetracycline": ("tetracycline", "doxycycline", "minocycline"),
    "nsaid": ("nsaid", "ibuprofen", "diclofenac", "naproxen", "ketorolac", "aspirin", "indomethacin", "mefenamic",
              "aceclofenac", "etoricoxib", "celecoxib", "piroxicam", "meloxicam"),
    "aspirin": ("aspirin", "acetylsalicylic", "ecosprin"),
    "opioid": ("opioid", "morphine", "codeine", "tramadol", "fentanyl", "oxycodone", "pethidine", "buprenorphine"),
    "sedative": ("benzodiazepine", "lorazepam", "diazepam", "midazolam", "alprazolam", "clonazepam", "zolpidem"),
    "acei": ("ace inhibitor", "ramipril", "lisinopril", "enalapril", "perindopril", "captopril"),
    "arb": ("angiotensin-receptor", "losartan", "telmisartan", "valsartan", "olmesartan", "candesartan"),
    "ksparing": ("spironolactone", "eplerenone", "amiloride", "triamterene", "potassium"),
    "thiazide": ("thiazide", "hydrochlorothiazide", "hctz", "indapamide", "chlorthalidone"),
    "loop": ("loop diuretic", "furosemide", "torsemide"),
    "anticoagulant": ("anticoagulant", "warfarin", "acenocoumarol", "apixaban", "rivaroxaban", "dabigatran", "heparin",
                      "enoxaparin"),
    "warfarin": ("warfarin", "acenocoumarol"),
    "lmwh": ("enoxaparin", "dalteparin", "low-molecular-weight heparin"),
    "antiplatelet": ("antiplatelet", "clopidogrel", "ticagrelor", "prasugrel", "aspirin"),
    "clopidogrel": ("clopidogrel",),
    "ppi_cyp": ("omeprazole", "esomeprazole"),
    "statin": ("atorvastatin", "rosuvastatin", "simvastatin", "pravastatin", "hmg-coa"),
    "simvastatin": ("simvastatin",),
    "ssri": ("ssri", "sertraline", "escitalopram", "fluoxetine", "citalopram", "paroxetine"),
    "serotonergic": ("sertraline", "escitalopram", "fluoxetine", "citalopram", "paroxetine", "tramadol", "sumatriptan",
                     "mirtazapine", "venlafaxine", "linezolid", "amitriptyline"),
    "nitrate": ("nitroglycerin", "isosorbide", "glyceryl trinitrate"),
    "pde5": ("sildenafil", "tadalafil", "pde5"),
    "betablocker_ns": ("propranolol", "timolol", "nadolol", "carvedilol", "non-selective"),
    "betablocker": ("metoprolol", "bisoprolol", "atenolol", "propranolol", "carvedilol", "nebivolol"),
    "ratelimiting_ccb": ("verapamil", "diltiazem"),
    "metformin": ("metformin", "biguanide"),
    "sglt2": ("sglt2", "empagliflozin", "dapagliflozin", "canagliflozin"),
    "sulfonylurea": ("sulfonylurea", "gliclazide", "glimepiride", "glipizide", "glibenclamide"),
    "insulin": ("insulin",),
    "steroid": ("prednisone", "prednisolone", "dexamethasone", "systemic corticosteroid"),
    "methotrexate": ("methotrexate",),
    "alendronate": ("alendronate", "bisphosphonate"),
    "topiramate": ("topiramate",),
    "carbamazepine": ("carbamazepine", "oxcarbazepine"),
    "valproate": ("valproate", "valproic"),
    "isotretinoin": ("isotretinoin", "acitretin"),
    "retinoid": ("retinoid", "adapalene", "tretinoin"),
    "lithium": ("lithium",),
    "digoxin": ("digoxin",),
    "nitrofurantoin": ("nitrofurantoin",),
    "allopurinol": ("allopurinol",),
    "aminoglycoside": ("gentamicin", "amikacin", "tobramycin", "aminoglycoside"),
    "vancomycin": ("vancomycin",),
    "gabapentinoid": ("gabapentin", "pregabalin"),
    "colchicine": ("colchicine",),
    "baclofen": ("baclofen",),
    "aciclovir": ("acyclovir", "aciclovir", "valacyclovir"),
    "doac": ("apixaban", "rivaroxaban", "dabigatran"),
    "levothyroxine": ("levothyroxine",),
    "minerals": ("ferrous", "oral iron", "calcium"),
    "levodopa": ("levodopa",),
    "dopamine_blocker": ("metoclopramide", "haloperidol", "dopamine antagonist", "domperidone"),
    "ocp": ("contraceptive", "estrogen + progestin"),
    "oestrogen": ("contraceptive", "estradiol", "estrogen"),
    "antifibrinolytic": ("tranexamic",),
    "antithyroid": ("methimazole", "carbimazole", "propylthiouracil", "antithyroid"),
    "finasteride": ("finasteride", "dutasteride"),
    "tamsulosin": ("tamsulosin",),
    "loperamide": ("loperamide",),
    "stimulant": ("methylphenidate",),
    "qt": ("azithromycin", "clarithromycin", "erythromycin", "ciprofloxacin", "levofloxacin", "ondansetron", "haloperidol",
           "escitalopram", "citalopram", "quetiapine", "hydroxychloroquine", "domperidone", "amiodarone"),
    "metronidazole": ("metronidazole", "tinidazole"),
    "tramadol": ("tramadol",),
    "codeine": ("codeine",),
    "anticholinergic": ("solifenacin", "oxybutynin", "hyoscine", "amitriptyline"),
}

# Names a patient might mention that are not in the formulary but matter for interactions.
OTHER_DRUGS = ("warfarin", "acenocoumarol", "digoxin", "lithium", "isosorbide", "omeprazole", "heparin", "rivaroxaban",
               "dabigatran", "enalapril", "lisinopril", "telmisartan", "valproate", "codeine", "diazepam", "alprazolam",
               "clonazepam", "amiodarone", "verapamil", "diltiazem", "insulin", "aspirin", "ecosprin", "spironolactone",
               "tadalafil", "erythromycin", "clarithromycin", "gentamicin", "oral contraceptive pill", "potassium chloride")

# Words for the common culprit drugs in the scripts the app uses.
NATIVE_ALLERGENS: dict[str, tuple[str, ...]] = {
    "penicillin": ("पेनिसिलिन", "पेनिसिलीन", "ಪೆನ್ಸಿಲಿನ್", "ಪೆನಿಸಿಲಿನ್", "பென்சிலின்", "பெனிசிலின்", "పెన్సిలిన్", "పెనిసిలిన్",
                   "পেনিসিলিন", "एमोक्सिसिलिन", "अमोक्सिसिलिन", "ಅಮೋಕ್ಸಿಸಿಲಿನ್", "அமோக்ஸிசிலின்", "అమోక్సిసిలిన్", "অ্যামোক্সিসিলিন"),
    "sulfa": ("सल्फा", "ಸಲ್ಫಾ", "சல்ஃபா", "சல்பா", "సల్ఫా", "সালফা"),
    "nsaid": ("पेनकिलर", "ಪೇನ್ ಕಿಲ್ಲರ್", "பெயின்கில்லர்", "పెయిన్ కిల్లర్", "পেনকিলার", "painkiller", "pain killer"),
    "aspirin": ("एस्पिरिन", "ಆಸ್ಪಿರಿನ್", "ஆஸ்பிரின்", "ఆస్పిరిన్", "অ্যাসপিরিন"),
}
ALLERGY_TAGS = ("penicillin", "cephalosporin", "sulfa", "macrolide", "fluoroquinolone", "tetracycline", "nsaid", "aspirin",
                "opioid")
# A drug in the key group is also unsafe for an allergy in these groups.
ALLERGY_COVERS = {"nsaid": ("nsaid", "aspirin"), "aspirin": ("nsaid", "aspirin"), "opioid": ("opioid",)}

_NO_BEFORE = re.compile(r"(?:\bno\b|\bnot\b|\bnil\b|\bnone\b|\bnever\b|\bdenies\b|\bdenied\b|\bwithout\b)(?:\W+\w+){0,4}\W*$", re.I)
_NO_AFTER = re.compile(r"^\W*(?:allerg\w*\W*)?(?:[:=-]\s*)?(?:no|nil|none|negative|tolerated|tolerates)\b", re.I)


def _negated(clause: str, start: int, end: int) -> bool:
    return bool(_NO_BEFORE.search(clause[:start]) or _NO_AFTER.match(clause[end:]))


_GROUP_RX = {t: re.compile("(?<![a-z])(?:" + "|".join(map(re.escape, words)) + ")") for t, words in GROUPS.items()}


def tags_of(*texts: str) -> set[str]:
    hay = " ".join(texts).lower()
    out = {t for t, rx in _GROUP_RX.items() if rx.search(hay)}
    if "toothpaste" in hay:
        out.discard("ksparing")
    return out


def allergy_tags(text: str) -> set[str]:
    """Drug groups the patient is allergic to. Reads only drug words and denials, so any other
    text in the allergy field (including an instruction) cannot change the answer."""
    found: set[str] = set()
    for clause in re.split(r"[.;,\n/]+|\band\b|\bbut\b", (text or "").lower()):
        for tag in ALLERGY_TAGS:
            for w in GROUPS[tag] + NATIVE_ALLERGENS.get(tag, ()):
                m = re.search(rf"(?<![a-z]){re.escape(w)}", clause)
                if m and not _negated(clause, m.start(), m.end()):
                    found.add(tag)
    if "aspirin" in found:
        found.add("nsaid")
    return found


_SEVERE = re.compile(r"anaphyla|angio-?oedema|angioedema|swollen|swelling|breath|wheez|collapse|stevens|\bsjs\b|throat|shock", re.I)

# ───────────────────────── patient facts ─────────────────────────


def qa_pairs(history: Any) -> list[tuple[str, str]]:
    """The history as (question, answer), whatever shape it arrived in."""
    out: list[tuple[str, str]] = []
    items = history if isinstance(history, list) else [history]
    for it in items[:60]:
        if isinstance(it, dict):
            out.append((str(it.get("question") or it.get("q") or "")[:300], str(it.get("answer") or it.get("a") or "")[:500]))
        elif isinstance(it, str):
            for line in re.split(r"[\n|;]+", it[:6000]):
                q, sep, a = line.partition("?")
                out.append((q + "?", a.strip(" :-")) if sep and a.strip() else ("", line.strip()))
    return [(q, a) for q, a in out if q or a]


_YES = re.compile(r"^\W*(?:yes|yeah|yep|both|haa?n|ji|howdu|haudu|aama|avunu|ho\b|हाँ|हां|ಹೌದು|ஆமா|ஆம்|అవును|हो|হ্যাঁ)", re.I)
_NO = re.compile(r"^\W*(?:no|none|nil|never|not|nahi|illa|ledu|नहीं|नाही|ಇಲ್ಲ|இல்லை|లేదు|না)\b", re.I)


def has_fact(pairs: list[tuple[str, str]], pattern: str) -> bool:
    rx = re.compile(pattern, re.I)
    for q, a in pairs:
        for m in rx.finditer(a):
            clause_start = max(a.rfind(c, 0, m.start()) for c in ".;,")
            if not _negated(a[clause_start + 1:], m.start() - clause_start - 1, m.end() - clause_start - 1):
                return True
        if rx.search(q) and _YES.match(a):
            return True
    return False


_NOT_PREG = re.compile(r"not pregnant|no chance of pregnan|pregnancy (?:test )?(?:was |is )?(?:negative|ruled out)|negative pregnancy|"
                       r"\b(?:menopaus|hysterectom|tubectom|sterilis|on contracepti|vasectom)", re.I)
_PAST_PREG = re.compile(r"\b(?:prior|previous|past|last|first|earlier|how many|pregnancies|had|during my|in my)\b", re.I)


def pregnancy_status(gender: str, age: Optional[float], complaint: str, pairs: list[tuple[str, str]]) -> str:
    """'yes' | 'no' | 'unknown' from what has been said so far."""
    if not (gender or "").upper().startswith("F") or age is None or not 12 <= age <= 50:
        return "no"
    status = "unknown"
    for q, a in [("", complaint or "")] + pairs:
        if _NOT_PREG.search(a) or (PREGNANT.search(q) and not _PAST_PREG.search(q) and _NO.match(a)):
            return "no"
        if re.search(r"period|menses|LMP|menstrua", q, re.I) and re.search(r"last week|finished|just (?:ended|finished)|ongoing|today|yesterday", a, re.I):
            return "no"
        if PREGNANT.search(q) and not _PAST_PREG.search(q) and (_YES.match(a) or re.search(r"this pregnancy|your pregnancy", q, re.I)):
            status = "yes"
        for m in PREGNANT.finditer(a):
            if not _negated(a, m.start(), m.end()) and not _PAST_PREG.search(a[max(0, m.start() - 30): m.start()]):
                status = "yes"
    return status


# ───────────────────────── rules ─────────────────────────

LEVELS = ("hard", "hold", "clarify", "caution")


@dataclass
class Finding:
    level: str      # hard | hold | clarify | caution
    code: str       # phrase key without "why_"
    x: str          # value for the spoken phrase
    detail: str     # English, for the chart
    source: str = "MedSim formulary"


def _f(level: str, code: str, x: Any, detail: str, source: str = "MedSim formulary") -> Finding:
    return Finding(level, code, str(x), detail, source)


# (groups, groups, level, why). Checked in both directions.
INTERACTIONS: tuple[tuple[tuple[str, ...], tuple[str, ...], str, str], ...] = (
    (("nitrate",), ("pde5",), "hard", "a nitrate with a PDE5 inhibitor can cause a dangerous fall in blood pressure"),
    (("methotrexate",), ("sulfa",), "hard", "methotrexate with co-trimoxazole can cause bone marrow failure"),
    (("anticoagulant",), ("nsaid",), "hold", "an anticoagulant with an NSAID or aspirin raises bleeding risk"),
    (("anticoagulant",), ("antiplatelet",), "hold", "an anticoagulant with an antiplatelet raises bleeding risk"),
    (("opioid",), ("sedative",), "hold", "an opioid with a sedative can cause respiratory depression"),
    (("acei",), ("arb",), "hold", "an ACE inhibitor with an ARB can cause hyperkalaemia and kidney injury"),
    (("lithium",), ("nsaid", "acei", "arb", "thiazide"), "hold", "this raises lithium levels"),
    (("warfarin",), ("metronidazole", "sulfa", "fluoroquinolone", "macrolide"), "hold", "this antibiotic raises INR on warfarin"),
    (("levodopa",), ("dopamine_blocker",), "hold", "a dopamine blocker worsens Parkinson's disease"),
    (("betablocker",), ("ratelimiting_ccb",), "hold", "a beta blocker with verapamil or diltiazem can cause heart block"),
    (("simvastatin",), ("macrolide",), "hold", "a macrolide raises simvastatin levels and the risk of rhabdomyolysis"),
    (("acei", "arb"), ("ksparing",), "caution", "an ACE inhibitor or ARB with a potassium-sparing drug: hyperkalaemia risk, check potassium"),
    (("ksparing",), ("ksparing",), "hold", "two potassium-sparing drugs: hyperkalaemia risk"),
    (("acei", "arb"), ("nsaid",), "caution", "an NSAID with an ACE inhibitor or ARB can injure the kidneys"),
    (("loop", "thiazide"), ("nsaid",), "caution", "an NSAID blunts the diuretic and can injure the kidneys"),
    (("ssri",), ("nsaid", "anticoagulant", "antiplatelet"), "caution", "an SSRI adds to bleeding risk"),
    (("serotonergic",), ("serotonergic",), "caution", "two serotonergic drugs: watch for serotonin syndrome"),
    (("steroid",), ("nsaid",), "caution", "a steroid with an NSAID raises the risk of a stomach ulcer"),
    (("methotrexate",), ("nsaid",), "caution", "an NSAID can raise methotrexate levels"),
    (("clopidogrel",), ("aspirin",), "caution", "dual antiplatelet therapy raises bleeding risk"),
    (("clopidogrel",), ("ppi_cyp",), "caution", "omeprazole or esomeprazole weakens clopidogrel; pantoprazole is preferred"),
    (("digoxin",), ("loop", "thiazide", "macrolide"), "caution", "this can raise digoxin toxicity, check potassium"),
    (("levothyroxine",), ("minerals",), "caution", "iron or calcium blocks levothyroxine, keep them four hours apart"),
    (("fluoroquinolone", "tetracycline"), ("minerals",), "caution", "iron or calcium blocks the antibiotic, keep them apart"),
    (("ocp",), ("carbamazepine", "topiramate"), "caution", "this can make the contraceptive pill fail"),
    (("qt",), ("qt",), "caution", "two drugs that prolong the QT interval"),
)

# Groups where a second member is therapeutic duplication.
DUPLICATE_GROUPS = ("nsaid", "acei", "arb", "statin", "ssri", "sedative", "fluoroquinolone", "macrolide", "penicillin",
                    "cephalosporin", "anticoagulant", "sulfonylurea", "steroid", "thiazide", "pde5")

# group -> level when the patient is pregnant
PREGNANCY: dict[str, str] = {
    "methotrexate": "hard", "warfarin": "hard", "isotretinoin": "hard", "valproate": "hard", "acei": "hard", "arb": "hard",
    "tetracycline": "hard", "statin": "hard", "finasteride": "hard", "topiramate": "hard", "ocp": "hard", "retinoid": "hard",
    "lithium": "hold", "carbamazepine": "hold", "nsaid": "hold", "fluoroquinolone": "hold", "alendronate": "hold",
    "antithyroid": "caution", "sulfa": "hold", "opioid": "caution",
}
# Ask before releasing when pregnancy is possible and nobody has said.
PREGNANCY_ASK = ("methotrexate", "warfarin", "isotretinoin", "valproate", "acei", "arb", "topiramate")
PREGNANCY_WARN = ("tetracycline", "statin", "retinoid", "lithium", "carbamazepine")

# (group, unsuitable when age is below, level)
MIN_AGE: tuple[tuple[str, float, str], ...] = (
    ("aspirin", 16, "hard"), ("tramadol", 12, "hard"), ("codeine", 12, "hard"), ("loperamide", 2, "hard"),
    ("tetracycline", 8, "clarify"), ("fluoroquinolone", 18, "caution"), ("sedative", 12, "hold"), ("pde5", 18, "hold"),
    ("stimulant", 6, "hold"), ("statin", 10, "hold"), ("ssri", 18, "caution"), ("dopamine_blocker", 1, "hold"),
)
# (group, pattern of a past illness, level, words)
DISEASE: tuple[tuple[str, str, str, str], ...] = (
    ("betablocker_ns", r"\basthma|\bwheez|\bCOPD\b", "hard", "asthma"),
    ("nsaid", r"peptic ulcer|stomach ulcer|gastric ulcer|duodenal ulcer|GI bleed|black stools?|mel[ae]+na|vomit\w* blood", "hold", "peptic ulcer or bleeding"),
    ("nsaid", r"\basthma", "caution", "asthma"),
    ("nsaid", r"heart failure", "caution", "heart failure"),
    ("tramadol", r"\bseizure|\bepilep|\bfits\b", "hold", "seizures"),
    ("oestrogen", r"migraine with aura|\bDVT\b|blood clot|pulmonary embol|thrombosis", "hard", "clotting risk"),
    ("antifibrinolytic", r"\bDVT\b|blood clot|pulmonary embol|thrombosis", "hold", "clotting risk"),
    ("nitrofurantoin", r"\bG6PD\b", "hard", "G6PD deficiency"),
    ("sulfa", r"\bG6PD\b", "hard", "G6PD deficiency"),
    ("dopamine_blocker", r"parkinson", "hold", "Parkinson's disease"),
    ("metformin", r"lactic acidosis", "hard", "previous lactic acidosis"),
    ("anticholinergic", r"glaucoma|urinary retention|enlarged prostate", "caution", "glaucoma or urinary retention"),
)

# group -> (hold below eGFR, caution below eGFR, hold when potassium above, adjust instead of hold)
RENAL: dict[str, tuple[int, int, Optional[float], bool]] = {
    "metformin": (30, 45, None, False), "nsaid": (30, 60, None, False), "acei": (0, 30, 5.5, False), "arb": (0, 30, 5.5, False),
    "ksparing": (30, 50, 5.0, False), "aminoglycoside": (30, 60, None, False), "vancomycin": (0, 60, None, True),
    "lmwh": (0, 30, None, True), "digoxin": (0, 60, None, True), "nitrofurantoin": (30, 45, None, False),
    "allopurinol": (0, 60, None, True), "gabapentinoid": (0, 60, None, True), "methotrexate": (30, 60, None, False),
    "sglt2": (20, 45, None, False), "sulfa": (15, 30, 5.5, True), "alendronate": (35, 35, None, False),
    "colchicine": (10, 30, None, True), "baclofen": (0, 60, None, True), "lithium": (30, 60, None, True),
    "aciclovir": (0, 25, None, True), "doac": (15, 30, None, True),
}
# Groups held when creatinine is climbing, whatever the eGFR says today.
RENAL_RISE = ("metformin", "nsaid", "acei", "arb", "ksparing", "aminoglycoside", "nitrofurantoin", "methotrexate", "sulfa",
              "vancomycin", "lithium", "lmwh", "sglt2")

# Usual adult maximum per day in mg, by ingredient word.
MAX_DAILY_MG: dict[str, float] = {
    "paracetamol": 4000, "ibuprofen": 2400, "diclofenac": 150, "naproxen": 1250, "amoxicillin": 3000, "azithromycin": 1000,
    "ciprofloxacin": 1500, "cefuroxime": 1000, "cefalexin": 4000, "cephalexin": 4000, "doxycycline": 200,
    "metronidazole": 2400, "metformin": 2550, "ramipril": 10, "losartan": 100, "amlodipine": 10, "atorvastatin": 80,
    "rosuvastatin": 40, "simvastatin": 40, "tramadol": 400, "sertraline": 200, "escitalopram": 20, "fluoxetine": 60,
    "gabapentin": 3600, "allopurinol": 800, "cetirizine": 20, "levocetirizine": 10, "pantoprazole": 80, "esomeprazole": 80,
    "ondansetron": 24, "metoclopramide": 30, "furosemide": 240, "spironolactone": 200, "loperamide": 16, "lorazepam": 4,
    "zolpidem": 10, "nitrofurantoin": 400, "bisoprolol": 20, "metoprolol": 400, "indapamide": 2.5, "hydrochlorothiazide": 50,
    "gliclazide": 120, "empagliflozin": 25, "montelukast": 10, "famotidine": 80, "apixaban": 20, "clopidogrel": 75,
    "propranolol": 320, "topiramate": 400, "amitriptyline": 150, "carbamazepine": 1600, "donepezil": 10, "finasteride": 5,
    "solifenacin": 10, "tamsulosin": 0.8, "colchicine": 2, "baclofen": 100, "acyclovir": 4000,
}

# group with a problem -> safer options, best first. Each is checked against the patient before it is offered.
ALTERNATIVES: dict[str, tuple[str, ...]] = {
    "penicillin": ("azithromycin-500", "doxycycline-100"), "cephalosporin": ("azithromycin-500", "doxycycline-100"),
    "macrolide": ("doxycycline-100", "cefuroxime-500"), "fluoroquinolone": ("cefuroxime-500", "doxycycline-100"),
    "tetracycline": ("azithromycin-500", "cefuroxime-500"), "sulfa": ("nitrofurantoin-100", "cefuroxime-500"),
    "nitrofurantoin": ("cephalexin-500",), "nsaid": ("paracetamol-500",), "opioid": ("paracetamol-500",),
    "acei": ("amlodipine-5", "losartan-50"), "arb": ("amlodipine-5",), "betablocker_ns": ("amlodipine-5",),
    "metformin": ("insulin-glargine",), "simvastatin": ("rosuvastatin-10",), "ppi_cyp": ("pantoprazole-40",),
    "statin": ("ezetimibe-10",), "sedative": (), "thiazide": ("amlodipine-5",), "ksparing": ("amlodipine-5",),
    "ssri": ("mirtazapine-30",), "allopurinol": (), "alendronate": ("calcium-vitd",),
}

# analyte -> (test on its value, groups affected). A critical result recalls a released drug in these groups.
RECALL: tuple[tuple[str, Any, tuple[str, ...], str], ...] = (
    ("k", lambda x: x >= 5.5, ("acei", "arb", "ksparing", "sulfa", "nsaid"), "potassium"),
    ("k", lambda x: x <= 2.8, ("loop", "thiazide", "digoxin", "qt", "steroid"), "potassium"),
    ("na", lambda x: x <= 125, ("thiazide", "ssri", "carbamazepine"), "sodium"),
    ("inr", lambda x: x >= 4, ("anticoagulant", "antiplatelet", "nsaid"), "INR"),
    ("plt", lambda x: x <= 50, ("anticoagulant", "antiplatelet", "nsaid", "methotrexate"), "platelets"),
    ("hb", lambda x: x <= 7, ("anticoagulant", "antiplatelet", "nsaid"), "haemoglobin"),
    ("anc", lambda x: x < 1, ("methotrexate", "antithyroid", "carbamazepine"), "neutrophils"),
    ("wbc", lambda x: x <= 1.5, ("methotrexate", "antithyroid", "carbamazepine"), "white cells"),
    ("glucoseMin", lambda x: x <= 54, ("insulin", "sulfonylurea"), "glucose"),
    ("glucoseMax", lambda x: x >= 400, ("steroid",), "glucose"),
    ("lactate", lambda x: x >= 4, ("metformin",), "lactate"),
    ("bicarb", lambda x: x <= 12, ("metformin", "sglt2"), "bicarbonate"),
    ("ck", lambda x: x >= 5000, ("statin",), "CK"),
    ("creat", lambda x: x >= 4, RENAL_RISE, "creatinine"),
)

# ───────────────────────── dose arithmetic ─────────────────────────

_FREQ_WORDS = (
    (r"\b(?:qid|four times|4 times)\b|\b6[- ]?hourly\b|every 6 h", 4), (r"\b(?:tds|tid|thrice|three times|3 times)\b|\b8[- ]?hourly\b|every 8 h", 3),
    (r"\b(?:bd|bid|twice|two times|2 times)\b|\b12[- ]?hourly\b|every 12 h", 2), (r"\b5 times\b|five times", 5),
    (r"\b4[- ]?hourly\b|every 4 h", 6), (r"\b(?:od|qd|hs|once|daily|at night|nightly|bedtime|every day|morning)\b", 1),
)


def daily_mg(dose: str, name: str) -> Optional[float]:
    """Milligrams a day for a plainly written oral dose, or None when it cannot be read safely."""
    d = re.sub(r"\([^)]*\)", " ", (dose or "").lower()).replace("×", "x").replace(",", " ")
    if re.search(r"mg/kg|/kg|weekly|week|\bsc\b|\biu\b|puff|drop|\bml\b", d):
        return None
    freq: Optional[float] = None
    m = re.search(r"\b(\d)\s*-\s*(\d)\s*-\s*(\d)(?:\s*-\s*(\d))?\b", d)  # 1-0-1
    per = 1.0
    if m:
        freq = float(sum(int(g) for g in m.groups() if g))
    else:
        m = re.search(r"\b(\d)\s*x\s*(\d)\b", d)  # 3x1: three times a day, one each
        if m:
            freq, per = float(m.group(1)), float(m.group(2))
        else:
            freq = next((n for pat, n in _FREQ_WORDS if re.search(pat, d)), None)
    if not freq:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|mcg|g|gm)\b", d)
    if m:
        amount = float(m.group(1)) * {"mg": 1, "mcg": 0.001, "g": 1000, "gm": 1000}[m.group(2)]
        return amount * freq
    strength = re.search(r"(\d+(?:\.\d+)?)\s*(mg|g|mcg)\b", (name or "").lower())
    count = re.search(r"(\d+(?:\.\d+)?)(?:\s*-\s*(\d+))?\s*(?:tab|tb|cap)", d)
    if strength and (count or per):
        n = float(count.group(2) or count.group(1)) if count else per
        return n * freq * float(strength.group(1)) * {"mg": 1, "g": 1000, "mcg": 0.001}[strength.group(2)]
    return None


# ───────────────────────── the prescription being checked ─────────────────────────


@dataclass
class Rx:
    ref: str
    medication_id: str
    name: str
    dose: str
    duration: str
    case_id: str
    osce: bool
    tags: set[str]
    topical: bool
    age: Optional[float]
    gender: str
    allergies: str
    pairs: list[tuple[str, str]]
    pregnancy: str
    current: list[tuple[str, str, set[str]]]  # (id, name, tags)
    default_dose: str = ""
    known: bool = True
    renal: Optional[dict[str, Any]] = None
    external: Optional[dict[str, Any]] = None
    findings: list[Finding] = field(default_factory=list)


class Formulary:
    def __init__(self) -> None:
        self.meds: dict[str, list[str]] = load_json("formulary.json")["meds"]
        self._tags = {i: tags_of(i, m[0], m[3]) for i, m in self.meds.items()}

    def get(self, med_id: str) -> Optional[list[str]]:
        return self.meds.get(med_id)

    def tags(self, med_id: str, name: str = "") -> set[str]:
        return set(self._tags.get(med_id) or tags_of(med_id, name))

    def name(self, med_id: str, fallback: str = "") -> str:
        m = self.meds.get(med_id)
        return m[0] if m else (fallback or med_id)

    def mentioned(self, text: str) -> list[tuple[str, str, set[str]]]:
        """Drugs named in free text, as (id, name, tags)."""
        low, out, seen = (text or "").lower(), [], set()
        for i, m in self.meds.items():
            word = re.split(r"[\s/\d]", m[0].lower())[0]
            if len(word) >= 6 and word not in seen and word not in ("calcium", "vitamin", "potassium", "combined", "artificial",
                                                                    "silicone", "polyvalent", "insulin", "rabies", "tetanus"):
                if re.search(rf"(?<![a-z]){re.escape(word)}", low):
                    seen.add(word)
                    out.append((i, m[0], self.tags(i)))
        for w in OTHER_DRUGS:
            if w not in seen and re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", low):
                seen.add(w)
                out.append((w, w.capitalize(), tags_of(w)))
        return out


def _num(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build_rx(ref: str, data: dict[str, Any], formulary: Formulary, extra_current: Iterable[tuple[str, str]] = ()) -> Rx:
    p = data.get("patient") if isinstance(data.get("patient"), dict) else {}
    med_id = str(data.get("medicationId") or "")[:80]
    row = formulary.get(med_id)
    name = (row[0] if row else str(data.get("medication") or med_id))[:80].strip()
    age, gender = _num(p.get("age")), str(p.get("gender") or "")[:10]
    pairs = qa_pairs(p.get("history"))
    allergies = "; ".join([str(p.get("allergies") or "")[:500]] + [a for q, a in pairs if "allerg" in f"{q} {a}".lower()])
    complaint = str(p.get("chiefComplaint") or "")[:500]
    current: dict[str, tuple[str, str, set[str]]] = {}
    for c in data.get("current") if isinstance(data.get("current"), list) else []:
        if isinstance(c, dict):
            cid = str(c.get("medicationId") or c.get("name") or "")[:80]
            if cid:
                current[cid] = (cid, formulary.name(cid, str(c.get("name") or "")[:80]), formulary.tags(cid, str(c.get("name") or "")))
    for cid, cname in extra_current:
        current.setdefault(cid, (cid, cname, formulary.tags(cid, cname)))
    # Medicines the patient says they take. Allergy answers name drugs they must not take.
    for q, a in pairs:
        if "allerg" in f"{q} {a}".lower() or not re.search(
                r"medic|tablet|drug|taking|\btake\b|treat|pills?|illness|history|diabet|pressure|regular|painkill", f"{q} {a}", re.I):
            continue
        for mid, mname, mtags in formulary.mentioned(a):
            m = re.search(re.escape(re.split(r"[\s/\d]", mname.lower())[0]), a.lower())
            stopped = re.search(r"stopp?ed|no longer|used to|not taking|years? (?:ago|back)", a, re.I)
            if m and not stopped and not _negated(a, m.start(), m.end()) and mid not in current and mname not in (v[1] for v in current.values()):
                current[mid] = (mid, mname, mtags)
    topical = bool(row and (row[1] in ("cream",) or row[2] in ("dermatology", "dental-oral", "ophthalmic")))
    return Rx(ref=ref, medication_id=med_id, name=name, dose=str(data.get("dose") or "")[:200],
              duration=str(data.get("duration") or "")[:120], case_id=str(data.get("caseId") or "")[:80],
              osce=bool(data.get("osce")), tags=formulary.tags(med_id, name), topical=topical, age=age, gender=gender,
              allergies=allergies, pairs=pairs, pregnancy=pregnancy_status(gender, age, complaint, pairs),
              current=list(current.values()), default_dose=row[4] if row else "", known=row is not None)


def check_local(rx: Rx) -> list[Finding]:
    """Every fixed check that needs nothing but this hand-off and the formulary."""
    out: list[Finding] = []
    if not rx.name:
        return [_f("clarify", "unknown_drug", "", "no drug was named")]
    if not rx.known:
        out.append(_f("caution", "unknown_drug", "", f"{rx.name} is not in the MedSim formulary"))
    # allergy
    allergic = allergy_tags(rx.allergies)
    covered = {t for a in allergic for t in ALLERGY_COVERS.get(a, (a,))}
    hit = sorted(rx.tags & covered)
    if hit:
        label = next((a for a in ALLERGY_TAGS if a in allergic and (a in hit or set(ALLERGY_COVERS.get(a, (a,))) & set(hit))), hit[0])
        out.append(_f("hard", "allergy", label, f"documented {label} allergy; {rx.name} is in the same class", "Allergy record"))
    else:
        base = re.split(r"[\s/\d(]", rx.name.lower())[0]
        if len(base) >= 5:
            for clause in re.split(r"[.;,\n]+", rx.allergies.lower()):
                m = re.search(rf"(?<![a-z]){re.escape(base)}", clause)
                if m and not _negated(clause, m.start(), m.end()):
                    out.append(_f("hard", "allergy", base, f"documented allergy to {base}", "Allergy record"))
                    break
        if "penicillin" in allergic and "cephalosporin" in rx.tags:
            severe = bool(_SEVERE.search(rx.allergies))
            first_gen = bool(re.search(r"ceph?f?alexin|cefazolin", rx.name.lower()))
            level = "hold" if severe and first_gen else "clarify" if severe or first_gen else "caution"
            out.append(_f(level, "cross", "penicillin", f"penicillin allergy{' with a severe reaction' if severe else ''}: "
                          f"possible cross-reactivity with {rx.name}", "Allergy record"))
    # duplication and interactions
    for cid, cname, ctags in rx.current:
        if cid == rx.medication_id or cname.lower() == rx.name.lower():
            out.append(_f("clarify", "duplicate", cname, f"{cname} is already on the chart"))
            continue
        same = next((g for g in DUPLICATE_GROUPS if g in rx.tags and g in ctags
                     and not ("aspirin" in rx.tags or "aspirin" in ctags)), None)
        if same and not rx.topical:
            out.append(_f("hold", "same_class", cname, f"{cname} is already on the chart from the same group ({same})"))
        if rx.topical:
            continue
        for a, b, level, why in INTERACTIONS:
            fwd = set(a) & ctags and set(b) & rx.tags
            back = set(b) & ctags and set(a) & rx.tags
            if fwd or back:
                out.append(_f(level, "interaction", cname, f"with {cname}: {why}"))
                break
    # pregnancy
    if rx.pregnancy == "yes":
        worst = sorted((PREGNANCY[t] for t in rx.tags if t in PREGNANCY), key=LEVELS.index)
        if worst and (not rx.topical or "retinoid" in rx.tags) and not ("aspirin" in rx.tags and worst[0] != "hard"):
            out.append(_f(worst[0], "pregnancy", "", f"{rx.name} is not recommended in pregnancy"))
    elif rx.pregnancy == "unknown" and any(t in rx.tags for t in PREGNANCY_WARN):
        out.append(_f("caution", "pregnancy_unknown", "", f"pregnancy has not been ruled out before {rx.name}"))
    # sex
    if (rx.gender or "").upper().startswith("F") and rx.tags & {"finasteride"}:
        out.append(_f("hold", "sex", "", f"{rx.name} is not used in women"))
    if (rx.gender or "").upper().startswith("M") and "ocp" in rx.tags:
        out.append(_f("hold", "sex", "", f"{rx.name} is not used in men"))
    # age
    if rx.age is not None and not rx.topical:
        for tag, below, level in MIN_AGE:
            if tag in rx.tags and rx.age < below:
                out.append(_f(level, "age", f"{rx.age:g}", f"{rx.name} is not suitable below {below:g} years"))
        if rx.age >= 65 and rx.tags & {"sedative"}:
            out.append(_f("caution", "age", f"{rx.age:g}", f"{rx.name} raises fall and confusion risk over 65"))
        written = f"{rx.dose}".lower()
        if rx.age < 12 and not re.search(r"mg/kg|child|syrup|\bml\b|drop|suspension|puff", written) and not any(f.code == "age" for f in out):
            out.append(_f("caution", "child_dose", "", "under 12 years: confirm a weight-based dose"))
    # disease (including topical eye drops: timolol in asthma)
    for tag, pattern, level, words in DISEASE:
        if tag in rx.tags and has_fact(rx.pairs, pattern) and not (rx.topical and tag == "nsaid"):
            out.append(_f(level, "disease", words, f"{rx.name} with {words} in the history", "History"))
    # dose
    if not rx.topical:
        out += check_dose(rx)
    return out


def check_dose(rx: Rx) -> list[Finding]:
    d = rx.dose.lower()
    if rx.tags & {"methotrexate", "alendronate"} and "week" not in d and re.search(r"\b(?:od|daily|bd|bid|tds|every day|once a day|twice)\b", d):
        return [_f("hard", "weekly", "", f"{rx.name} is a once-weekly medicine")]
    if not d or d == rx.default_dose.lower():
        return []
    mg = daily_mg(rx.dose, rx.name)
    if mg is None:
        return []
    for word, top in MAX_DAILY_MG.items():
        if word in rx.name.lower() and mg > top * 1.001:
            level = "hard" if mg > 2 * top else "clarify"
            return [_f(level, "dose", f"{top:g} mg", f"{mg:g} mg a day exceeds the usual maximum of {top:g} mg a day")]
    return []


def check_external(rx: Rx, ext: Optional[dict[str, Any]]) -> list[Finding]:
    """RxNorm/RxClass and openFDA. They can add a concern, never remove one."""
    if not ext or not ext.get("ok"):
        return []
    out = []
    conflict = ext.get("allergyConflict")
    if conflict and allergy_tags(rx.allergies):
        label = sorted(allergy_tags(rx.allergies))[0]
        # ATC files diuretics and sulfonylureas under sulfonamides; true cross-reaction with sulfa antibiotics is rare.
        level = "caution" if label == "sulfa" and rx.tags & {"loop", "thiazide", "sulfonylurea"} else "hard"
        out.append(_f(level, "cross" if level == "caution" else "allergy", label, str(conflict)[:200], "RxNorm/RxClass (NIH NLM)"))
    for i in (ext.get("interactions") or [])[:2]:
        out.append(_f("caution", "label", str(i.get("with") or "")[:60], f"label mentions {i.get('with')}: {str(i.get('excerpt') or '')[:160]}",
                      "openFDA drug label"))
    return out


def renal_tags(rx: Rx) -> list[str]:
    if rx.topical:
        return []
    # Low-dose aspirin is an antiplatelet here, not a kidney question.
    return [t for t in RENAL if t in rx.tags and not (t == "nsaid" and "aspirin" in rx.tags)]


def check_renal(rx: Rx, renal: dict[str, Any]) -> list[Finding]:
    src = "Laboratory"
    if not renal.get("available"):
        return [_f("caution", "renal_unknown", "", "no kidney function on record; check creatinine", src)]
    egfr, creat, k = _num(renal.get("egfr")), _num(renal.get("creatinine")), _num(renal.get("potassium"))
    out: list[Finding] = []
    for tag in renal_tags(rx):
        hold, caution, kmax, adjust = RENAL[tag]
        if renal.get("acuteRise") and tag in RENAL_RISE:
            out.append(_f("hold", "renal_rise", f"{creat:g}" if creat is not None else "",
                          f"creatinine is rising ({renal.get('text', '')}): possible acute kidney injury", src))
        elif egfr is not None and egfr < hold:
            out.append(_f("hard", "renal", f"{egfr:g}", f"eGFR {egfr:g}: {rx.name} is contraindicated below {hold}", src))
        elif egfr is not None and egfr < caution:
            if adjust:
                out.append(_f("clarify", "renal_dose", f"{egfr:g}", f"eGFR {egfr:g}: {rx.name} needs a reduced dose", src))
            else:
                out.append(_f("caution", "renal", f"{egfr:g}", f"eGFR {egfr:g}: use {rx.name} with care and monitor", src))
        if kmax is not None and k is not None and k > kmax:
            out.append(_f("hold", "value", f"potassium {k:g}", f"potassium {k:g}: {rx.name} can raise it further", src))
    if not out and egfr is None and creat is None and not renal.get("normal"):
        out.append(_f("caution", "renal_unknown", "", "creatinine is not stated on the stored report", src))
    return out


def decide(findings: list[Finding]) -> tuple[str, str, list[Finding]]:
    """(verdict, severity, the findings that decided it)."""
    for level, verdict, severity in (("hard", "hold", "hard"), ("hold", "hold", "soft"), ("clarify", "clarify", "soft"),
                                     ("caution", "release", "soft")):
        top = [f for f in findings if f.level == level]
        if top:
            return verdict, severity, top
    return "release", "none", []


def suggest(rx: Rx, formulary: Formulary) -> Optional[dict[str, str]]:
    """The first listed alternative that is itself clean for this patient."""
    options: list[str] = []
    for tag in ("penicillin", "cephalosporin", "sulfa", "macrolide", "fluoroquinolone", "tetracycline", "nitrofurantoin", "nsaid",
                "opioid", "acei", "arb", "betablocker_ns", "metformin", "simvastatin", "statin", "ssri", "thiazide", "ksparing",
                "alendronate"):
        if tag in rx.tags:
            options += [o for o in ALTERNATIVES.get(tag, ()) if o not in options and o != rx.medication_id]
    for oid in options:
        row = formulary.get(oid)
        if not row:
            continue
        alt = Rx(**{**rx.__dict__, "medication_id": oid, "name": row[0], "dose": row[4], "tags": formulary.tags(oid),
                    "topical": False, "default_dose": row[4], "known": True, "findings": []})
        fs = check_local(alt)
        if rx.renal:
            fs += check_renal(alt, rx.renal) if renal_tags(alt) else []
        elif renal_tags(alt):
            continue  # would need its own kidney check
        if any(f.level in ("hard", "hold", "clarify") for f in fs) or any(f.code in ("pregnancy_unknown", "age") for f in fs):
            continue
        return {"medicationId": oid, "name": row[0], "dose": re.sub(r"\s*\(.*", "", row[4]).strip() or row[4]}
    return None


def _article(reason: list[str]) -> str:
    s = "; ".join(dict.fromkeys(r for r in reason if r))
    return (s if s.startswith("eGFR") else s[:1].upper() + s[1:])[:420]


_WANTS_RELEASE = re.compile(
    r"\b(?:release|override|give it|give anyway|anyway|allow|approve|unhold|go ahead|proceed|clear it|de do|kodi|kodunga|ivvandi)\b"
    r"|दे दो|छोड़|मंज़ूर|ಕೊಡಿ|ಬಿಡುಗಡೆ|கொடு|ఇవ్వండి|विड|द्या|দিয়ে দিন|ছাড়", re.I)

SYSTEM = (
    "You are Meera, the clinical pharmacist of a teaching hospital in India, answering a doctor at the bedside in a "
    "SYNTHETIC training simulator. <record> holds your own verdicts in this encounter and formulary entries. "
    "Verdicts were computed by fixed safety checks and are final for you: explain them, never soften, reverse or promise to change them. "
    "Only a faculty member can release a held drug."
)


class PharmacistAdapter(DepartmentAdapter):
    role = PHARMACIST
    handles = frozenset({("request", "verify_rx"), ("request", "ask"), ("note", "critical_value")})

    def __init__(self, owner: str = "", lab_wait: float = LAB_WAIT_S, **kw: Any) -> None:
        super().__init__(owner, **kw)
        self.lab_wait = lab_wait
        self._formulary: Optional[Formulary] = None

    @property
    def formulary(self) -> Formulary:
        if self._formulary is None:
            self._formulary = Formulary()
        return self._formulary

    def warm(self) -> None:
        self.formulary.mentioned("")
        from integrations import drugsafety  # noqa: F401

    # room memory: verdicts {medicationId: {...}} of this encounter
    @staticmethod
    def verdicts(room: Room) -> dict[str, dict[str, Any]]:
        return room.data.setdefault("verdicts", {})

    async def restore(self, room: Room, h: Handoff) -> None:
        if h.action == "verify_rx" and h.kind in ("verdict", "recall"):
            d = h.data
            mid = str(d.get("medicationId") or "")
            if mid:
                self.verdicts(room)[mid] = {
                    "ref": h.ref, "verdict": d.get("verdict") or "hold", "name": self.formulary.name(mid, mid),
                    "dose": d.get("dose") or "", "reason": d.get("reason") or "", "at": 0.0,
                    "code": "", "x": "", "suggestion": (d.get("suggestion") or {}).get("name") if isinstance(d.get("suggestion"), dict) else "",
                }
                room.enc, room.lang = h.enc or room.enc, phrases.norm(h.lang)

    # ── requests ─────────────────────────────────────────────────────────────
    async def handle(self, turn: Turn, h: Handoff) -> None:
        if h.action == "verify_rx":
            await self.verify(turn, h)
        elif h.action == "ask":
            await self.answer(turn, h)
        else:
            await self.critical(turn, h)

    async def _external(self, turn: Turn, rx: Rx) -> Optional[dict[str, Any]]:
        try:
            from integrations import drugsafety

            # Only a real allergy statement goes out, and the drug names; nothing about the patient.
            allergies = ", ".join(sorted(allergy_tags(rx.allergies)))
            return await asyncio.wait_for(drugsafety.check_drug(rx.name, allergies, [c[1] for c in rx.current]), DB_CAP_S)
        except Exception as e:  # noqa: BLE001
            log.info("drug databases unavailable: %s", type(e).__name__)
            return None

    async def verify(self, turn: Turn, h: Handoff) -> None:
        room = turn.room
        recent = [(m, v["name"]) for m, v in self.verdicts(room).items()
                  if v["verdict"] == "release" and time.monotonic() - v["at"] < 60 and v["ref"] != h.ref and v["at"]]
        rx = build_rx(h.ref, h.data, self.formulary, [(m, n) for m, n in recent if m != str(h.data.get("medicationId") or "")])
        room.data["osce"] = rx.osce
        turn.tool("check_formulary", f"Checking {rx.name or 'the order'} against the formulary", medicationId=rx.medication_id)
        ext_task = asyncio.ensure_future(self._external(turn, rx)) if rx.name else None
        try:
            rx.findings = check_local(rx)
            held = any(f.level in ("hard", "hold") for f in rx.findings)
            turn.tool_done("Allergy class conflict found" if any(f.code == "allergy" for f in rx.findings)
                           else "Allergies, interactions, age and dose checked")
            asked_lab = False
            needs = renal_tags(rx)
            ask_doctor = rx.pregnancy == "unknown" and not held and any(t in rx.tags for t in PREGNANCY_ASK)
            if needs and not held and not ask_doctor:
                asked_lab = await self._ask_lab(turn, rx)
            if ext_task is not None:
                turn.tool("drug_databases", "Looking up RxNorm and the FDA label", drug=rx.name)
                done, _ = await asyncio.wait({ext_task}, timeout=DB_CAP_HELD_S if held else DB_CAP_S)
                rx.external = ext_task.result() if done else None
                ok = bool(rx.external and rx.external.get("ok"))
                turn.tool_done("Public drug databases answered" if ok else "Public drug databases unavailable, using the formulary", ok)
                rx.findings += check_external(rx, rx.external)
        finally:
            if ext_task is not None and not ext_task.done():
                ext_task.cancel()
        if asked_lab:
            return  # resume() or on_wait_timeout() gives the verdict
        held = any(f.level in ("hard", "hold") for f in rx.findings)
        if ask_doctor and not held:
            q = f"Could the patient be pregnant? {rx.name} is unsafe in pregnancy."
            spoken = phrases.say("rx_q_pregnancy", turn.lang, d=rx.name)
            turn.thought("Pregnancy status is not documented, asking the doctor")
            if await turn.ask_department(NURSE, q, Handoff(
                    kind="query", action="safety_question", ref=rx.ref, enc=turn.enc, lang=turn.lang, spoken=spoken,
                    data={"question": q, "about": rx.ref}),
                    requester=turn.sender_id, state={"rx": rx}, timeout=QUESTION_WAIT_S, target_id=turn.sender_id):
                return
        if needs and not held and not asked_lab:
            rx.findings.append(_f("caution", "lab_silent", "", "the laboratory could not be reached for kidney function", "Laboratory"))
        await self.give_verdict(turn, rx, turn.sender_id)

    async def _ask_lab(self, turn: Turn, rx: Rx) -> bool:
        turn.thought("Dose depends on kidney function, asking the laboratory")
        return await turn.ask_department(
            LAB, "Please send the kidney function on record for this case.",
            Handoff(kind="query", action="renal_function", ref=rx.ref, enc=turn.enc, lang=turn.lang, data={"caseId": rx.case_id}),
            requester=turn.sender_id, state={"rx": rx}, timeout=self.lab_wait)

    async def resume(self, turn: Turn, p: Pending, h: Handoff) -> None:
        rx: Rx = p.state["rx"]
        if h.action == "renal_function":
            rx.renal = h.data
            turn.tool_done("Kidney function received from the laboratory", bool(h.data.get("available")))
            rx.findings += check_renal(rx, h.data)
            await self.give_verdict(turn, rx, p.requester)
            return
        answer = str(h.data.get("answer") or "")[:500]
        if p.state.get("clarify", "pregnancy_unknown") != "pregnancy_unknown":
            await self._clarified(turn, rx, p, answer)
            return
        rx.findings = [f for f in rx.findings if not (f.level == "clarify" and f.code == "pregnancy_unknown")]
        said = yes_no(answer)
        rx.pregnancy = said if said in ("yes", "no") else "unknown"
        if said == "yes":
            rx.findings = check_local(rx) + check_external(rx, rx.external)
        elif said == "unclear" and p.state.get("tries", 0) >= 2:
            rx.findings.append(_f("hold", "pregnancy_unknown", "", f"pregnancy has not been ruled out before {rx.name}", "Doctor's answer"))
        elif said == "unclear":
            rx.findings.append(_f("clarify", "pregnancy_unknown", "", f"pregnancy has not been ruled out before {rx.name}", "Doctor's answer"))
        if renal_tags(rx) and not any(f.level in ("hard", "hold", "clarify") for f in rx.findings):
            turn.sender_id = p.requester
            if await self._ask_lab(turn, rx):
                return
            rx.findings.append(_f("caution", "lab_silent", "", "the laboratory could not be reached for kidney function", "Laboratory"))
        await self.give_verdict(turn, rx, p.requester, tries=p.state.get("tries", 0))

    async def _clarified(self, turn: Turn, rx: Rx, p: Pending, answer: str) -> None:
        """The doctor answered a 'please clarify'. Confirming is enough for a judgement call, never for
        a dose: the order on the chart still carries the old one, so a new dose needs a new order."""
        decision, code = go_ahead(answer, confirm=True), p.state["clarify"]
        new: Optional[str] = "hold"
        if code not in ("dose", "renal_dose"):
            if decision == "go":
                new = "caution"
            elif decision == "unclear" and p.state.get("tries", 0) < 2:
                new = None
        elif decision == "unclear" and not re.search(r"\d", answer) and p.state.get("tries", 0) < 2:
            new = None
        if new:
            for f in rx.findings:
                if f.level == "clarify":
                    f.level = new
        if new == "caution":
            rx.findings.append(_f("caution", code, next((f.x for f in rx.findings if f.code == code), ""),
                                  "confirmed by the doctor after the pharmacist asked", "Doctor's answer"))
            if renal_tags(rx) and rx.renal is None and decide(rx.findings)[0] == "release":
                turn.sender_id = p.requester
                if await self._ask_lab(turn, rx):
                    return
        await self.give_verdict(turn, rx, p.requester, tries=p.state.get("tries", 0))

    async def on_wait_timeout(self, turn: Turn, p: Pending) -> None:
        rx: Rx = p.state["rx"]
        if p.state.get("clarify"):
            return  # the verdict is already 'clarify'; the drug stays off the prescription
        if p.action == "renal_function":
            turn.thought("No answer from the laboratory, deciding without it")
            rx.findings.append(_f("caution", "lab_silent", "", "the laboratory has not answered; check creatinine", "Laboratory"))
        else:
            rx.findings.append(_f("clarify", "pregnancy_unknown", "", "no answer on pregnancy", "Doctor's answer"))
        await self.give_verdict(turn, rx, p.requester)

    async def late_answer(self, turn: Turn, h: Handoff) -> str:
        """The laboratory answered after the wait: a released drug may have to come back."""
        if h.action == "renal_function":
            for v in self.verdicts(turn.room).values():
                rx = v.get("rx")
                if v["ref"] == h.ref and v["verdict"] == "release" and rx is not None:
                    rx.renal = h.data
                    bad = [f for f in check_renal(rx, h.data) if f.level in ("hard", "hold")]
                    if bad:
                        await self.recall(turn, v, bad[0])
                        return "late_recall"
        return await super().late_answer(turn, h)

    async def give_verdict(self, turn: Turn, rx: Rx, to: str, tries: int = 0) -> None:
        verdict, severity, top = decide(rx.findings)
        evidence = [{"source": f.source, "detail": f.detail[:220]} for f in rx.findings[:6]]
        if rx.renal and rx.renal.get("text") and not any(e["source"] == "Laboratory" for e in evidence):
            evidence.append({"source": "Laboratory", "detail": str(rx.renal["text"])[:220]})
        if rx.external and rx.external.get("ok") and not any("RxNorm" in e["source"] or "openFDA" in e["source"] for e in evidence):
            classes = ", ".join((rx.external.get("classes") or [])[:3])
            evidence.append({"source": "RxNorm/RxClass (NIH NLM)", "detail": f"{rx.name}: {classes or 'found'}"[:220]})
        reason = _article([f.detail for f in top[:3]]) or "No allergy, interaction, dose or kidney concern found."
        data: dict[str, Any] = {"verdict": verdict, "medicationId": rx.medication_id, "dose": rx.dose, "duration": rx.duration,
                                "severity": severity, "reason": reason, "evidence": evidence}
        why = phrases.say(f"why_{top[0].code}", turn.lang, x=top[0].x) if top else ""
        option = suggest(rx, self.formulary) if verdict == "hold" and not rx.osce else None
        if verdict == "release":
            spoken = phrases.say("rx_release_caution", turn.lang, d=rx.name, w=why) if top else phrases.say("rx_release", turn.lang, d=rx.name)
            text = f"{rx.name} is released." + (f" Caution: {reason}" if top else "")
        elif verdict == "hold":
            spoken = phrases.say("rx_hold", turn.lang, d=rx.name, w=why)
            text = f"HOLD {rx.name}. {reason}."
            if option:
                data["suggestion"] = option
                # Two short sentences: the opening "please stop" gives way to the alternative.
                spoken = re.split(r"(?<=[.।])\s+", spoken, maxsplit=1)[-1]
                spoken = f"{spoken} {phrases.say('rx_option', turn.lang, a=option['name'])}"
                text += f" Alternative: {option['name']}, {option['dose']}."
        else:
            spoken = phrases.say("rx_clarify", turn.lang, d=rx.name or "", w=why)
            text = f"Please clarify {rx.name or 'the order'}. {reason}."
        self.verdicts(turn.room)[rx.medication_id or rx.name] = {
            "ref": rx.ref, "verdict": verdict, "name": rx.name, "dose": rx.dose, "reason": reason, "at": time.monotonic(),
            "code": top[0].code if top else "", "x": top[0].x if top else "",
            "suggestion": option["name"] if option else "", "rx": rx,
        }
        turn.thought(f"Verdict: {verdict}")
        text = text.replace("..", ".")
        if verdict == "clarify":
            data["question"] = text
            # The doctor's answer comes back as answer/safety_question under the same ref.
            self.file_pending(Pending(room_id=turn.room_id, ref=rx.ref, action="safety_question", expect=NURSE, requester=to,
                                      lang=turn.lang, enc=turn.enc, tools=turn.tools,
                                      state={"rx": rx, "clarify": top[0].code, "tries": tries + 1}), QUESTION_WAIT_S)
        await turn.reply(text, "verdict", "verify_rx", rx.ref, spoken=spoken, data=data, to=to)

    # ── critical results ─────────────────────────────────────────────────────
    async def critical(self, turn: Turn, h: Handoff) -> None:
        released = [v for v in self.verdicts(turn.room).values() if v["verdict"] == "release"]
        turn.tool("recheck_released", "Re-checking released drugs against the critical result", released=len(released))
        hits: list[tuple[dict[str, Any], Finding]] = []
        for v in released:
            f = recall_finding(next((i for i, x in self.verdicts(turn.room).items() if x is v), ""), v["name"], h.data.get("results"), self.formulary)
            if f:
                hits.append((v, f))
        turn.tool_done(f"{len(hits)} released drug(s) affected")
        for v, f in hits:
            await self.recall(turn, v, f)
        if not hits:
            await turn.no_reply("no released drug is affected")

    async def recall(self, turn: Turn, v: dict[str, Any], f: Finding) -> None:
        room = turn.room
        to = room.nurse_id or await turn.participant(NURSE)
        if not to:
            await turn.no_reply("the nurse is not in the room")
            return
        lang = room.lang or turn.lang
        med_id = next((i for i, x in self.verdicts(room).items() if x is v), "")
        data: dict[str, Any] = {"verdict": "hold", "medicationId": med_id, "dose": v["dose"], "duration": "", "severity": "hard",
                                "reason": _article([f.detail]), "evidence": [{"source": f.source, "detail": f.detail[:220]}],
                                "originalRef": v["ref"]}
        rx: Optional[Rx] = v.get("rx")
        if rx is not None:
            data["duration"] = rx.duration
        spoken = phrases.say("rx_recall", lang, d=v["name"], w=phrases.say(f"why_{f.code}", lang, x=f.x))
        ref = new_ref("rx")
        v.update(verdict="hold", reason=data["reason"], code=f.code, x=f.x, ref=ref, suggestion="")
        await turn.reply(f"RECALL {v['name']}. {data['reason']}.", "recall", "verify_rx", ref, spoken=spoken, data=data, to=to, lang=lang)

    # ── questions ────────────────────────────────────────────────────────────
    def _record(self, room: Room, question: str) -> dict[str, Any]:
        osce = bool(room.data.get("osce"))
        rows = []
        for v in self.verdicts(room).values():
            row = {"drug": v["name"], "verdict": v["verdict"], "dose": v["dose"], "reason": v["reason"]}
            if v.get("suggestion") and not osce:
                row["alternative"] = v["suggestion"]
            rows.append(row)
        info = []
        for mid, name, _ in self.formulary.mentioned(question)[:3]:
            m = self.formulary.get(mid)
            if m:
                info.append({"drug": name, "class": m[3], "usualDose": m[4], "duration": m[5]})
        return {"verdicts": rows[:8], "formulary": info}

    def _fixed_answer(self, room: Room, question: str, lang: str) -> str:
        """The standing verdict on a held drug the question is about, else ''."""
        held = [v for v in self.verdicts(room).values() if v["verdict"] == "hold"]
        if not held:
            return ""
        low = question.lower()
        named = [v for v in held if re.split(r"[\s/\d]", v["name"].lower())[0] in low]
        pick = named[0] if named else (held[-1] if _WANTS_RELEASE.search(question) else None)
        if pick is None:
            return ""
        why = phrases.say(f"why_{pick['code']}", lang, x=pick["x"]) if pick.get("code") else pick["reason"].rstrip(".")
        out = phrases.say("rx_hold_stands", lang, d=pick["name"], w=why)
        if pick.get("suggestion") and not room.data.get("osce"):
            out += " " + phrases.say("rx_option", lang, a=pick["suggestion"])
        return out

    async def _answer_text(self, room: Room, question: str, lang: str) -> str:
        fixed = self._fixed_answer(room, question, lang)
        if fixed:
            return fixed
        record = self._record(room, question)
        system = SYSTEM + (" This is an exam: never name an alternative drug, a diagnosis or what to prescribe." if room.data.get("osce") else "")
        out = await llm_answer(system, record, question, lang, female=True)
        if out:
            return out
        last = list(self.verdicts(room).values())
        if last:
            v = last[-1]
            key = {"release": "rx_release_caution" if v.get("code") else "rx_release", "hold": "rx_hold_stands", "clarify": "rx_clarify"}[v["verdict"]]
            why = phrases.say(f"why_{v['code']}", lang, x=v["x"]) if v.get("code") else v["reason"].rstrip(".")
            return phrases.say(key, lang, d=v["name"], w=why)
        return phrases.say("rx_ask_none", lang)

    async def answer(self, turn: Turn, h: Handoff) -> None:
        q = str(h.data.get("question") or "")[:800]
        ctx = h.data.get("context") if isinstance(h.data.get("context"), dict) else {}
        if h.data.get("osce") or ctx.get("osce"):
            turn.room.data["osce"] = True
        text = two_sentences(await self._answer_text(turn.room, q, turn.lang))
        await turn.reply(text, "answer", "ask", h.ref, spoken=text, data={"text": text})

    async def on_human(self, turn: Turn, text: str) -> None:
        if not text:
            await turn.no_reply("empty message")
            return
        lang = text_lang(text)
        held = [v for v in self.verdicts(turn.room).values() if v["verdict"] == "hold"]
        out = await self._answer_text(turn.room, text, lang)
        if held and _WANTS_RELEASE.search(text):
            out += " To release it, please reply to @Nurse Asha with your approval; I will not release it myself."
        await turn.send(clean_text(out, 600) if "@Nurse" not in out else out, None, turn.sender_id)


def recall_finding(med_id: str, name: str, results: Any, formulary: Formulary) -> Optional[Finding]:
    """Whether these critical results make a released drug unsafe."""
    tags = formulary.tags(med_id, name)
    for r in results if isinstance(results, list) else []:
        if not isinstance(r, dict):
            continue
        values = analytes.parse(str(r.get("result") or ""), str(r.get("testId") or ""))
        if analytes.acute_rise(values) and tags & set(RENAL_RISE) and not ("aspirin" in tags):
            return _f("hard", "renal_rise", f"{values['creat']:g}",
                      f"creatinine has risen to {values['creat']:g} from {values['creatBase']:g}: possible acute kidney injury", "Laboratory")
        for analyte, bad, groups, label in RECALL:
            x = values.get(analyte)
            if x is not None and bad(x) and tags & set(groups):
                return _f("hard", "value", f"{label} {x:g}", f"{label} {x:g} is critical with {name}", "Laboratory")
    return None
