"""Drug and allergy words as Indian doctors and patients really say them.

Everything the nurse's safety checks compare goes through here: native scripts
(hi, kn, ta, te, mr, bn), common Indian brands, short stems ("amoxy") and
negated allergies ("No allergy to penicillin", "कोई एलर्जी नहीं"). Pure, no I/O.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Iterable, Optional

# ── normalising ────────────────────────────────────────────────────────────

# Latin, accented Latin and the Indic blocks (letters, vowel signs, digits). \w is
# not usable: Python does not count Indic vowel signs as word characters.
_DROP = re.compile("[^0-9a-zà-ɏऀ-ॣ०-෿]+")
# Nukta (written or not), zero-width joiners.
_MARKS = re.compile("[़়‌‍]")
_INDIC = re.compile("[ऀ-෿]")


def norm(text: str) -> str:
    t = _MARKS.sub("", unicodedata.normalize("NFD", text or ""))
    t = unicodedata.normalize("NFC", t).lower()
    return re.sub(r"\s+", " ", _DROP.sub(" ", t)).strip()


# ── aliases: canonical English -> every other way it is said ───────────────

# Native spellings of the main allergens and drugs, common misspellings and
# romanised forms. Native words match as substrings (case endings are glued on),
# Latin words match as whole words (or as a prefix when long enough).
SPOKEN: dict[str, list[str]] = {
    "penicillin": ["पेनिसिलिन", "पेनिसिलीन", "पेन्सिलिन", "पेनिसिल्लिन", "ಪೆನಿಸಿಲಿನ್", "ಪೆನ್ಸಿಲಿನ್", "பென்சிலின்",
                   "பெனிசிலின்", "பென்சிலீன்", "పెన్సిలిన్", "పెనిసిలిన్", "পেনিসিলিন", "পেনিসিলিন",
                   "pencillin", "penicilin", "pencilin", "penisilin", "pensilin", "pencilline"],
    "amoxicillin": ["अमोक्सिसिलिन", "एमोक्सिसिलिन", "अमॉक्सिसिलिन", "अमोक्सी", "ಅಮಾಕ್ಸಿಸಿಲಿನ್", "ಅಮೋಕ್ಸಿಸಿಲಿನ್",
                    "அமோக்ஸிசிலின்", "அமாக்சிசிலின்", "అమోక్సిసిలిన్", "অ্যামোক্সিসিলিন", "অ্যামক্সিসিলিন",
                    "amoxycillin", "amoxycilin", "amoxicilin", "amoxy", "amoxi", "amox"],
    "sulfa": ["सल्फा", "ಸಲ್ಫಾ", "சல்பா", "சல்ஃபா", "సల్ఫా", "সালফা", "sulpha", "sulfonamide", "sulphonamide",
              "sulphur drug", "sulfur drug"],
    "aspirin": ["एस्पिरिन", "ऐस्पिरिन", "ॲस्पिरिन", "ಆಸ್ಪಿರಿನ್", "ಆಸ್ಪ್ರಿನ್", "ஆஸ்பிரின்", "ఆస్పిరిన్",
                "অ্যাসপিরিন", "asprin", "aspirine"],
    "ibuprofen": ["आइबुप्रोफेन", "इबुप्रोफेन", "ಐಬುಪ್ರೊಫೇನ್", "ಇಬುಪ್ರೊಫೇನ್", "இபுப்ரோஃபென்", "ஐபுப்ரோஃபென்",
                  "ఐబుప్రోఫెన్", "ఇబుప్రోఫెన్", "আইবুপ্রোফেন", "ibuprofin"],
    "diclofenac": ["डाइक्लोफेनाक", "डिक्लोफेनाक", "ಡೈಕ್ಲೋಫೆನಾಕ್", "டைக்ளோஃபெனாக்", "డైక్లోఫెనాక్", "ডাইক্লোফেনাক",
                   "diclo", "diclofenec"],
    "paracetamol": ["पैरासिटामोल", "पेरासिटामोल", "पॅरासिटामॉल", "ಪ್ಯಾರಸಿಟಮಾಲ್", "ಪ್ಯಾರಾಸಿಟಮಾಲ್", "பாராசிட்டமால்",
                    "பாரசிட்டமால்", "పారాసిటమాల్", "প্যারাসিটামল", "paracetmol", "paracitamol", "acetaminophen",
                    "para", "pcm"],
    "nsaid": ["पेनकिलर", "दर्द की गोली", "ಪೇನ್ ಕಿಲ್ಲರ್", "ನೋವಿನ ಮಾತ್ರೆ", "பெயின் கில்லர்", "வலி மாத்திரை",
              "పెయిన్ కిల్లర్", "నొప్పి మాత్ర", "পেইনকিলার", "ব্যথার ওষুধ",
              "painkiller", "pain killer", "nsaids", "anti inflammatory"],
    "cephalosporin": ["सेफलोस्पोरिन", "ಸೆಫಲೋಸ್ಪೊರಿನ್", "செஃபலோஸ்போரின்", "సెఫలోస్పోరిన్", "সেফালোস্পোরিন",
                      "cephalosporins"],
    "azithromycin": ["एजिथ्रोमाइसिन", "अजिथ्रोमायसिन", "ಅಜಿತ್ರೋಮೈಸಿನ್", "அசித்ரோமைசின்", "అజిత్రోమైసిన్",
                     "অ্যাজিথ্রোমাইসিন", "azithro", "azithromicin"],
    "ciprofloxacin": ["सिप्रोफ्लोक्सासिन", "ಸಿಪ್ರೊಫ್ಲೋಕ್ಸಾಸಿನ್", "சிப்ரோஃப்ளாக்சசின்", "సిప్రోఫ్లోక్సాసిన్",
                      "সিপ্রোফ্লক্সাসিন", "cipro"],
    "metronidazole": ["मेट्रोनिडाजोल", "ಮೆಟ್ರೊನಿಡಜೋಲ್", "மெட்ரோனிடசோல்", "మెట్రోనిడజోల్", "মেট্রোনিডাজল",
                      "metro", "metronidazol"],
    "doxycycline": ["डॉक्सीसाइक्लिन", "ಡಾಕ್ಸಿಸೈಕ್ಲಿನ್", "டாக்ஸிசைக்ளின்", "డాక్సీసైక్లిన్", "ডক্সিসাইক্লিন", "doxy"],
    "codeine": ["कोडीन", "ಕೊಡೀನ್", "கோடீன்", "కోడీన్", "কোডিন"],
    "morphine": ["मॉर्फिन", "ಮಾರ್ಫಿನ್", "மார்ஃபின்", "మార్ఫిన్", "মরফিন"],
    "tramadol": ["ट्रामाडोल", "ಟ್ರಮಡಾಲ್", "ட்ராமடால்", "ట్రమడాల్", "ট্রামাডল"],
    "warfarin": ["वारफेरिन", "ವಾರ್ಫರಿನ್", "வார்ஃபரின்", "వార్ఫరిన్", "ওয়ারফারিন"],
    "metformin": ["मेटफॉर्मिन", "ಮೆಟ್ಫಾರ್ಮಿನ್", "மெட்ஃபார்மின்", "మెట్ఫార్మిన్", "মেটফরমিন"],
    "pantoprazole": ["पैंटोप्राजोल", "ಪ್ಯಾಂಟೊಪ್ರಜೋಲ್", "பான்டோபிரசோல்", "పాంటోప్రజోల్", "প্যান্টোপ্রাজল", "panto"],
    "insulin": ["इंसुलिन", "इन्सुलिन", "ಇನ್ಸುಲಿನ್", "இன்சுலின்", "ఇన్సులిన్", "ইনসুলিন"],
    "contrast": ["कॉन्ट्रास्ट", "ಕಾಂಟ್ರಾಸ್ಟ್", "கான்ட்ராஸ்ட்", "కాంట్రాస్ట్", "কনট্রাস্ট", "iodine contrast"],
    "salbutamol": ["सालबुटामोल", "ಸಾಲ್ಬುಟಮಾಲ್", "சால்புடமால்", "సాల్బుటమాల్", "সালবিউটামল", "salbu", "albuterol"],
    "cetirizine": ["सेटिरिजिन", "ಸೆಟಿರಿಜಿನ್", "செடிரிசின்", "సెటిరిజిన్", "সেটিরিজিন"],
}

# Short stems and Indian brands. A value is the words the catalog drug must carry.
BRANDS: dict[str, tuple[str, ...]] = {
    "crocin": ("paracetamol",), "dolo": ("paracetamol",), "calpol": ("paracetamol",), "tylenol": ("paracetamol",),
    "pacimol": ("paracetamol",), "metacin": ("paracetamol",), "combiflam": ("ibuprofen",), "brufen": ("ibuprofen",),
    "ibugesic": ("ibuprofen",), "voveran": ("diclofenac",), "voltaren": ("diclofenac",), "naprosyn": ("naproxen",),
    "ecosprin": ("aspirin",), "disprin": ("aspirin",), "loprin": ("aspirin",), "ultracet": ("tramadol",),
    "augmentin": ("clavulan",), "moxikind": ("clavulan",), "clavam": ("clavulan",), "coamoxiclav": ("clavulan",),
    "co amoxiclav": ("clavulan",), "amoxyclav": ("clavulan",), "amoxiclav": ("clavulan",),
    "mox": ("amoxicillin",), "novamox": ("amoxicillin",), "azithral": ("azithromycin",), "azee": ("azithromycin",),
    "azimax": ("azithromycin",), "zithromax": ("azithromycin",), "ciplox": ("ciprofloxacin",),
    "cifran": ("ciprofloxacin",), "levoflox": ("levofloxacin",), "ceftum": ("cefuroxime",), "zinnat": ("cefuroxime",),
    "taxim o": ("cefixime",), "zifi": ("cefixime",), "monocef": ("ceftriaxone",), "doxt": ("doxycycline",),
    "flagyl": ("metronidazole",), "metrogyl": ("metronidazole",),
    "septran": ("sulfamethoxazole", "cotrimoxazole"), "bactrim": ("sulfamethoxazole", "cotrimoxazole"),
    "cotrimoxazole": ("sulfamethoxazole",), "co trimoxazole": ("sulfamethoxazole",), "niftran": ("nitrofurantoin",),
    "pan 40": ("pantoprazole",), "pan d": ("pantoprazole",), "pan": ("pantoprazole",), "pantocid": ("pantoprazole",),
    "pantop": ("pantoprazole",), "nexpro": ("esomeprazole",), "nexium": ("esomeprazole",), "omez": ("omeprazole",),
    "famocid": ("famotidine",), "perinorm": ("metoclopramide",), "emeset": ("ondansetron",),
    "zofran": ("ondansetron",), "duphalac": ("lactulose",), "imodium": ("loperamide",), "cetzine": ("cetirizine",),
    "okacet": ("cetirizine",), "zyrtec": ("cetirizine",), "levocet": ("levocetirizine",),
    "allegra": ("fexofenadine",), "asthalin": ("salbutamol",), "ventolin": ("salbutamol",),
    "budecort": ("budesonide",), "foracort": ("formoterol",), "montair": ("montelukast",), "montek": ("montelukast",),
    "tiova": ("tiotropium",), "thyronorm": ("levothyroxine",), "eltroxin": ("levothyroxine",),
    "atorva": ("atorvastatin",), "lipitor": ("atorvastatin",), "rosuvas": ("rosuvastatin",),
    "deplatt": ("clopidogrel",), "clopilet": ("clopidogrel",), "plavix": ("clopidogrel",), "clopi": ("clopidogrel",),
    "eliquis": ("apixaban",), "sorbitrate": ("nitroglycerin", "isosorbide"), "gtn": ("nitroglycerin",),
    "lasix": ("furosemide",), "frusemide": ("furosemide",), "amlong": ("amlodipine",), "amlokind": ("amlodipine",),
    "stamlo": ("amlodipine",), "amlo": ("amlodipine",), "telma": ("telmisartan",), "losar": ("losartan",),
    "cardace": ("ramipril",), "metolar": ("metoprolol",), "concor": ("bisoprolol",), "aldactone": ("spironolactone",),
    "glycomet": ("metformin",), "diamicron": ("gliclazide",), "jardiance": ("empagliflozin",),
    "lantus": ("glargine",), "basalog": ("glargine",), "novorapid": ("insulin aspart",), "nexito": ("escitalopram",),
    "ativan": ("lorazepam",), "wysolone": ("predniso",), "prednisolone": ("predniso",), "omnacortil": ("predniso",),
    "tegretol": ("carbamazepine",), "gabantin": ("gabapentin",), "zyloric": ("allopurinol",), "folvite": ("folic",),
    "shelcal": ("calcium",), "trapic": ("tranexamic",), "pause 500": ("tranexamic",), "urimax": ("tamsulosin",),
    "candid": ("clotrimazole",), "acivir": ("acyclovir",), "zovirax": ("acyclovir",), "hcq": ("hydroxychloroquine",),
    "mtx": ("methotrexate",), "levo": ("levofloxacin",), "ibu": ("ibuprofen",), "pred": ("predniso",),
}

# Canonical words that are a class or a property, not one drug.
_CLASSES = {"nsaid", "sulfa", "cephalosporin", "contrast"}


def _has(text: str, variant: str) -> bool:
    """`text` is normalised. Native words match inside, Latin words as words."""
    v = norm(variant)
    if not v:
        return False
    if _INDIC.search(v):
        return v.rstrip("\u094d\u09cd\u0bcd\u0c4d\u0ccd") in text  # a case ending replaces the final virama
    tail = r"[a-z]{0,3}" if len(v) >= 6 else ""
    return re.search(rf"(?<![0-9a-z]){re.escape(v)}{tail}(?![a-z])", text) is not None


# ── phonetic skeleton: any catalog drug written in a native script ─────────

# Consonants of the shared Indic block layout from offset 0x15 (ka kha ga gha nga ca ...).
_ROW = ["k", "k", "k", "k", "n", "s", "s", "s", "s", "n", "t", "t", "t", "t", "n", "t", "t", "t", "t", "n",
        "n", "p", "f", "p", "p", "m", "", "r", "r", "l", "l", "l", "v", "s", "s", "s", ""]
_LETTERS: dict[str, str] = {
    chr(base + 0x15 + i): c for base in (0x0900, 0x0980, 0x0B80, 0x0C00, 0x0C80) for i, c in enumerate(_ROW)
}
# Anusvara stands for a nasal before another consonant.
_LETTERS.update({chr(base + 0x02): "n" for base in (0x0900, 0x0980, 0x0C00, 0x0C80)})
_DOUBLE = re.compile(r"(.)\1+")


def _skeleton_native(word: str) -> str:
    return _DOUBLE.sub(r"\1", "".join(_LETTERS.get(ch, "") for ch in word))


def _skeleton_latin(word: str) -> str:
    w = norm(word).replace(" ", "")
    for a, b in (("ph", "f"), ("th", "t"), ("sh", "s"), ("ch", "s"), ("ck", "k"), ("x", "ks"), ("qu", "k"), ("q", "k")):
        w = w.replace(a, b)
    w = re.sub(r"c(?=[eiy])", "s", w).replace("c", "k")
    w = w.translate(str.maketrans({"z": "s", "j": "s", "w": "v", "b": "p", "d": "t", "g": "k"}))
    return _DOUBLE.sub(r"\1", re.sub(r"[^kstpfmnlrv]", "", w))


def _native_hit(text: str, stem: str) -> bool:
    sk = _skeleton_latin(stem)
    if len(sk) < 4:
        return False
    for w in text.split():
        if not _INDIC.search(w):
            continue
        got = _skeleton_native(w)
        # Tamil and loose spellings write p for f; compare both ways.
        if got.startswith(sk) or got.replace("f", "p").startswith(sk.replace("f", "p")):
            return True
    return False


# ── public: which drugs does this text mention? ────────────────────────────


def canonical_terms(text: str) -> list[str]:
    """English names of every known drug or allergen the text mentions."""
    t = norm(text)
    out: list[str] = []
    if not t:
        return out
    for name, variants in SPOKEN.items():
        if _has(t, name) or any(_has(t, v) for v in variants):
            out.append(name)
    for brand, names in BRANDS.items():
        if _has(t, brand):
            out.extend(n for n in names if n not in out)
    return out


def expand(text: str) -> str:
    """Normalised text with the English name of every aliased drug appended."""
    t = norm(text)
    extra = [c for c in canonical_terms(t) if c not in t]
    return f"{t} {' '.join(extra)}".strip() if extra else t


_GENERIC = {"tablet", "cream", "drops", "spray", "inhaler", "syrup", "ointment", "shampoo", "nasal", "oral",
            "sublingual", "combined", "topical", "vaginal", "patch", "acid", "sodium", "basal", "bolus", "artificial",
            "transdermal", "succinate", "axetil", "sulfate", "vitamin", "tears"}


def stems_of(med_id: str, name: str) -> set[str]:
    """Base words that identify a catalog drug ('azithromycin-500' -> {'azithromycin'})."""
    return {w for w in norm(f"{name} {med_id}").split()
            if len(w) >= 4 and not re.search(r"\d", w) and w not in _GENERIC}


def mentions_drug(text: str, med_id: str, name: str) -> bool:
    """True when the text names this catalog drug: English, stem, brand or native script."""
    t = norm(text)
    if not t:
        return False
    full = norm(f"{name} {med_id}")
    for s in stems_of(med_id, name):
        if s in t or _native_hit(t, s):
            return True
    for canon, variants in SPOKEN.items():
        if canon not in _CLASSES and canon in full and any(_has(t, v) for v in variants):
            return True
    return any(_has(t, brand) and any(n in full for n in names) for brand, names in BRANDS.items())


# ── negated allergies ──────────────────────────────────────────────────────

_ALLERGY_WORD = re.compile(
    "allerg|sensitiv|intoleran|reaction|एलर्जी|अलर्जी|ऍलर्जी|ॲलर्जी|एलर्जि|ಅಲರ್ಜಿ|அலர்ஜி|ஒவ்வாமை|అలర్జీ|అలెర్జీ|ఎలర్జీ"
    "|এলার্জি|অ্যালার্জি|অ্যলার্জি",
    re.IGNORECASE)
_NEG_EN = re.compile(
    r"\b(?:no|nil|none|not|never|without|denies|denied|deny|don'?t|doesn'?t|isn'?t|hasn'?t|haven'?t|nkda|nkfda|nka)\b",
    re.IGNORECASE)
_NEG_WORD = re.compile(
    "नहीं|नही|नहि|नाही|ಇಲ್ಲ|இல்லை|இல்ல|கிடையாது|లేదు|లేవు|కాదు|নেই|নাই"
    r"|\b(?:nahi|nahin|naahi|illa|ille|illai|kidaiyathu|ledu|levu|kaadu|nei)\b", re.IGNORECASE)
_BARE_NEG = re.compile(
    r"^\W*(?:no|nope|nah|nil|none|never|nkda|nkfda|nka|n/?a|none known|nil known|not any|not that i know(?: of)?|nothing"
    r"|(?:जी )?नहीं|नही|कोई नहीं|नाही|ಇಲ್ಲ|இல்லை|இல்ல|లేదు|না|নেই|nahi|nahin|illa|illai|ledu|nei)\W*$", re.IGNORECASE)
_EXCEPT = re.compile(
    r"\b(?:except(?:ing| for)?|other than|apart from|besides|but|however|although|only)\b"
    "|लेकिन|मगर|सिवाय|ಆದರೆ|ಬಿಟ್ಟು|ஆனால்|தவிர|కానీ|తప్ప|কিন্তু|ছাড়া", re.IGNORECASE)
_REACTED = re.compile(
    r"\b(?:rash|hives|swell\w*|anaphyla\w*|itch\w*|breathless\w*|came out|react(?:ed|s)|wheez\w*|avoid|can'?t take)\b",
    re.IGNORECASE)
_AFFIRM = re.compile(
    r"^\W*(?:yes|yeah|yep|yup|haan?|ji haan?|houdu|haudu|aamaa?|avunu|hoy|hyan?)\b|^\W*(?:हाँ|हां|जी हाँ|होय|ಹೌದು|ஆமா|అవును|হ্যাঁ|হ্যা)",
    re.IGNORECASE)


# "Allergies: none", "penicillin allergy - no"
_NEG_AFTER = re.compile(r"allerg\w*\W*(?:is|are)?\W*(?:no|none|nil|denied|negative)\W*$", re.IGNORECASE)
# "allergy hai", "एलर्जी है", "ಅಲರ್ಜಿ ಇದೆ": stated as present, whatever else is negated later.
_HAS_ALLERGY = re.compile(
    r"(?:एलर्जी|अलर्जी|ऍलर्जी|ॲलर्जी|ಅಲರ್ಜಿ|அலர்ஜி|ஒவ்வாமை|అలర్జీ|అలెర్జీ|ఎలర్జీ|এলার্জি|অ্যালার্জি)\s*"
    r"(?:है|हैं|थी|हुई|आहे|ಇದೆ|ಉಂಟು|இருக்கு|உள்ளது|உண்டு|ఉంది|আছে)"
    r"|allergy\s+(?:hai|hain|thi|hui|aahe|ahe|ide|irukku|undu|undi|ache|aache)\b", re.IGNORECASE)
_OTHER_VERB = re.compile(
    r"\b(?:because|since|as|so|after|due|take|taking|took|give|given|gave|tolerate|knew|know|realis\w*|realiz\w*|told|use|using)\b",
    re.IGNORECASE)


def _clauses(text: str) -> list[tuple[str, bool]]:
    """(clause, starts after an 'except/but') pairs."""
    out: list[tuple[str, bool]] = []
    for sentence in re.split("[.;\n।!?]+", text or ""):
        pos, exc = 0, False
        for m in _EXCEPT.finditer(sentence):
            out.append((sentence[pos:m.start()], exc))
            pos, exc = m.end(), True
        out.append((sentence[pos:], exc))
    return [(c.strip(), e) for c, e in out if c.strip()]


def _negated(clause: str) -> bool:
    if _BARE_NEG.match(clause):
        return True
    if not _ALLERGY_WORD.search(clause):
        # "No penicillin", or a story with "not" in it: without an allergy word, keep it (safer).
        return bool(re.search(r"\b(?:nkda|nkfda|nka)\b", clause, re.IGNORECASE))
    if re.search(r"\bnot (?:sure|certain)\b|\bmay ?be\b|\bpossibl[ey]\b", clause, re.IGNORECASE):
        return False
    if _NEG_AFTER.search(clause) or (_NEG_WORD.search(clause) and not _HAS_ALLERGY.search(clause)):
        return True
    # English: the negation must belong to the allergy ("no known allergy"), not to
    # something else in the sentence ("I don't take it because I'm allergic").
    for m in _ALLERGY_WORD.finditer(clause):
        negs = list(_NEG_EN.finditer(clause, 0, m.start()))
        if negs:
            between = clause[negs[-1].end():m.start()]
            if len(between.split()) <= 6 and not _OTHER_VERB.search(between):
                return True
    return False


def positive_allergies(text: str) -> str:
    """The parts of an allergy note that really state an allergy ('' when none)."""
    keep: list[str] = []
    for clause, after_except in _clauses(text):
        negated_list = False  # "denies allergy to sulfa, penicillin or aspirin"
        for p in re.split(r"[,/]|\band\b(?=[^,]*\b(?:no|not|nil|denies)\b)", clause):
            p = p.strip()
            if not p:
                continue
            # After "except" the clause names a real allergy, unless it carries its own negation.
            if _negated(p):
                negated_list = bool(re.search(r"\b(?:to|of|with)\s+\S", p, re.IGNORECASE))
                continue
            bare = len(p.split()) <= 3 and not _REACTED.search(p) and not _ALLERGY_WORD.search(p)
            if negated_list and bare and not after_except:
                continue
            negated_list = False
            keep.append(p)
    return ", ".join(keep)


def allergy_note(documented: Optional[str], qa: Iterable[tuple[str, str]]) -> str:
    """One positive allergy text from the chart field and the allergy questions asked."""
    parts = [positive_allergies(documented or "")]
    for q, a in qa:
        if not (_ALLERGY_WORD.search(q or "") or _ALLERGY_WORD.search(a or "")):
            continue
        text = positive_allergies(a or "")
        # "Are you allergic to penicillin?" "Yes."
        if _AFFIRM.match((a or "").strip()) and not canonical_terms(a or "") and canonical_terms(q or ""):
            text = f"{text}, {q}".strip(", ")
        parts.append(text)
    return ", ".join(p for p in parts if p)
