"""Who is the doctor talking to? One routing authority for every spoken or typed turn.

The browser (POST /voice/route) and the patient LLM proxy (in process) call the
same function, so the patient stays silent exactly when somebody else answers.

  route_rules(utterance, lang=, context=)   sync, deterministic, sub-millisecond
  await route(utterance, lang=, context=)   rules first, LLM only when they are unsure

Doctors mix English, Hindi, Kannada, Tamil, Telugu, Marathi and Bengali in one
sentence, in native or Roman script, through speech-to-text that drops
punctuation. The rules therefore work on whole tokens (never substrings, so
Marathi "चकरा" is not "करा") of a normalised text, never on a raw regex.

Default on doubt: the patient. backend/tests/fixtures/intent_cases.json is the
shared truth table (the TypeScript offline fallback is tested against it too).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import unicodedata
from collections import OrderedDict, deque
from dataclasses import dataclass, replace
from functools import lru_cache
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

import lang as langmod

log = logging.getLogger("medsim.intent")
router = APIRouter()

TARGETS = ("patient", "nurse", "pharmacist", "lab", "radiology", "faculty", "coach", "exam", "observer")
ACTIONS = ("order", "question", "stop", "hint", "invite", "answer", "override", "none")
STAFF_ROLES = ("nurse", "pharmacist", "lab", "radiology", "faculty")

LLM_CAP_S = 2.0        # POST /voice/route
PROXY_LLM_CAP_S = 1.2  # patient turn inside the LLM proxy
LLM_MIN_CONFIDENCE = 0.6
MAX_WORDS = 60


@dataclass(frozen=True)
class Route:
    target: str = "patient"
    action: str = "none"
    confidence: float = 0.9
    via: str = "rule"  # rule | llm | context
    text: str = ""
    silent: bool = False     # the patient says nothing to this turn
    ambiguous: bool = False  # rules are unsure: ask the LLM

    def to_dict(self) -> dict[str, Any]:
        return {"target": self.target, "action": self.action, "confidence": round(self.confidence, 2),
                "via": self.via, "text": self.text, "silent": self.silent}


# ---------------------------------------------------------------- normalising

_ABBR = ("cbc", "fbc", "ecg", "ekg", "lft", "kft", "rft", "tsh", "crp", "esr", "mri", "abg", "usg", "cxr", "iv", "bp",
         "ct", "ors", "inr", "bnp", "psa", "hiv", "eeg", "emg")
_SPACED_ABBR = re.compile(r"\b(?:" + "|".join(r"\s".join(a) for a in _ABBR) + r")\b")
_DOTTED = re.compile(r"\b(?:[a-z]\.){1,4}[a-z]\b\.?")


def _fold(s: str) -> str:
    """Lower case, no nukta, no joiners, chandrabindu as anusvara, NFC."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = re.sub("[़়​-‍﻿]", "", s).replace("ँ", "ं")
    return unicodedata.normalize("NFC", s)


def normalise(text: str) -> str:
    """Padded text whose tokens are words or the marks ? . ,"""
    s = _fold(text)
    s = re.sub("['’‘ʼ`]", "", s)
    s = _DOTTED.sub(lambda m: m.group(0).replace(".", ""), s)
    s = re.sub(r"(?<=\d)[.,](?=\d)", "", s)
    s = re.sub("[?？؟]", " ? ", s)
    s = re.sub("[.!।॥…]+", " . ", s)
    s = re.sub(r"[,;:–—]+| - ", " , ", s)
    s = re.sub(r"[^\w\s?.,ऀ-෿]|_", " ", s)
    s = re.sub(r"\bx\s?rays?\b", "xray", s)
    s = re.sub(r"\bfollow ?ups?\b", "followup", s)
    s = re.sub(r"\bultra sound\b", "ultrasound", s)
    s = re.sub(r"(\d)(mg|ml|mcg|g)\b", r"\1 \2", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = _SPACED_ABBR.sub(lambda m: m.group(0).replace(" ", ""), s)
    return f" {s} "


def plain(p: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r" [?.,](?= )", " ", p.replace(" ", "  "))) if p.strip() else " "


def _pattern(term: str) -> str:
    """'karwa do' / 'देख*' -> a regex over normalised tokens."""
    out = []
    for w in term.split():
        head, tail = w.startswith("*"), w.endswith("*")
        core = plain(normalise(w.strip("*"))).strip() if w.strip("*") else ""
        if tail:
            core = core.rstrip("\u094d\u09cd\u0bcd\u0c4d\u0ccd")  # a case ending replaces the final virama
        core = re.escape(core)
        out.append((r"\S*" if head else "") + core + (r"\S*" if tail else ""))
    return " ".join(out)


def T(*terms: str) -> re.Pattern[str]:
    """Whole-token matcher for phrases separated by ; or given as arguments."""
    words = [w.strip() for t in terms for w in t.split(";") if w.strip()]
    words.sort(key=len, reverse=True)
    return re.compile(r"(?<= )(?:" + "|".join(dict.fromkeys(_pattern(w) for w in words)) + r")(?= )")


def has(rx: re.Pattern[str], s: str) -> bool:
    return bool(rx.search(s))


# ---------------------------------------------------------------- lexicons

_FILLERS = (
    "ok;okay;so;and;right;alright;all right;hello;hi;hey;um;umm;uh;uhh;hmm;hm;mm;well;accha;achha;acha;achcha;haan;han;"
    "theek hai;thik hai;theek;fine;yes;yeah;yep;no;sorry;excuse me;please;kindly;now;then;listen;good;great;thank you;"
    "thanks;one second;one minute;just a second;just a minute;ek second;ek minute;wait;actually;also;but;arre;arey;arrey;"
    "suno;suniye;sunno;zara;jara;to;toh;aur;chalo;chaliye;bas;sari;aayitu;ayyo;sare;sarey;bara;thik ache;shunun;hold on;"
    "perfect;sure;got it;let me see;i see;"
    "अच्छा;ठीक है;ठीक;हां;हाँ;अरे;सुनिए;सुनो;जरा;तो;और;चलो;चलिए;बस;ओके;एक मिनट;एक सेकंड;जी;प्लीज;धन्यवाद;शुक्रिया;"
    "ಸರಿ;ಆಯ್ತು;ಓಕೆ;ಹಾಂ;ಹೌದು;ಸ್ವಲ್ಪ;ಒಂದು ನಿಮಿಷ;ಪ್ಲೀಸ್;ಮತ್ತೆ;ಹಾಗಾದ್ರೆ;"
    "சரி;ஓகே;ஆமா;கொஞ்சம்;ஒரு நிமிஷம்;ப்ளீஸ்;அப்புறம்;"
    "సరే;ఓకే;అవును;కొంచెం;ఒక నిమిషం;ఒక్క నిమిషం;ప్లీజ్;"
    "ठीक आहे;बरं;बरे;हो;ऐका;एक मिनिट;कृपया;"
    "আচ্ছা;ঠিক আছে;হ্যাঁ;শুনুন;একটু;ওকে;এক মিনিট;প্লিজ"
)
_LEAD = re.compile(r"^ (?:(?:" + "|".join(sorted((_pattern(w.strip()) for w in _FILLERS.split(";") if w.strip()),
                                                key=len, reverse=True)) + r") )*")

# Titles per role. "strong" titles are only used for staff, "weak" ones are also
# how doctors address patients or name a relative.
_ROLE_TITLES: dict[str, dict[str, str]] = {
    "nurse": {
        "strong": "nurse;nurses;staff nurse;charge nurse;nars;nurse ji;nurse madam;nurse sister;sister nurse;"
                  "नर्स;स्टाफ नर्स;ನರ್ಸ್;ನರ್ಸ;ನರ್ಸಮ್ಮ;நர்ஸ்;நர்ஸம்மா;నర్స్;నర్సు;নার্স",
        "weak": "sister;sistar;sister ji;didi;deedi;akka;tai;staff;madam;maam;mam;madam ji;"
                "सिस्टर;दीदी;दिदी;ताई;मैडम;मैम;मॅडम;ಸಿಸ್ಟರ್;ಅಕ್ಕ;ಅಕ್ಕಾ;ಮೇಡಂ;ಮೇಡಮ್;சிஸ்டர்;அக்கா;மேடம்;సిస్టర్;అక్క;మేడం;সিস্টার;দিদি;বোন;ম্যাডাম",
        "name": "asha;aasha;ashaa;आशा;ಆಶಾ;ಆಶ;ஆஷா;ஆஶா;ஆசா;ఆశా;ఆశ;আশা",
    },
    "pharmacist": {
        "strong": "pharmacist;farmacist;फार्मासिस्ट;ಫಾರ್ಮಸಿಸ್ಟ್;ಫಾರ್ಮಾಸಿಸ್ಟ್;பார்மசிஸ்ட்;ஃபார்மசிஸ்ட்;மருந்தாளர்;ఫార్మసిస్ట్;ఫార్మాసిస్ట్;ফার্মাসিস্ট",
        "weak": "pharmacy;farmacy;फार्मेसी;फार्मसी;ಫಾರ್ಮಸಿ;ಫಾರ್ಮೆಸಿ;பார்மசி;ஃபார்மசி;ఫార్మసీ;ఫార్మసి;ফার্মেসি;ফার্মেসী;ফার্মাসি",
        "name": "meera;mira;meeraa;मीरा;मिरा;ಮೀರಾ;ಮೀರ;மீரா;మీరా;మీర;মীরা;মিরা",
    },
    "lab": {
        "strong": "lab officer;lab technician;lab tech;laboratory;lab team;लैब टेक्नीशियन;लैब टेक्निशियन;ಲ್ಯಾಬ್ ಟೆಕ್ನಿಷಿಯನ್;லேப் டெக்னீஷியன்;ల్యాబ్ టెక్నీషియన్;ল্যাব টেকনিশিয়ান",
        "weak": "lab;लैब;लॅब;ಲ್ಯಾಬ್;லேப்;லாப்;ల్యాబ్;లాబ్;ল্যাব",
        "name": "dev;देव;ದೇವ್;தேவ்;దేవ్;দেব",
    },
    "radiology": {
        "strong": "radiologist;xray department;radiology department;imaging department;रेडियोलॉजिस्ट;रेडिओलॉजिस्ट;रॅडिओलॉजिस्ट;ರೇಡಿಯಾಲಜಿಸ್ಟ್;ரேடியாலஜிஸ்ட்;రేడియాలజిస్ట్;রেডিওলজিস্ট;রেডিয়োলজিস্ট;রাডিয়োলজিস্ট;রাডিওলজিস্ট",
        "weak": "radiology;imaging;रेडियोलॉजी;रेडिओलॉजी;रॅडिओलॉजी;ರೇಡಿಯಾಲಜಿ;ரேடியாலஜி;రేడియాలజీ;রেডিওলজি;রেডিয়োলজি;রাডিয়োলজি;রাডিওলজি",
        "name": "vikram;विक्रम;ವಿಕ್ರಮ್;விக்ரம்;విక్రమ్;বিক্রম",
    },
    "faculty": {
        "strong": "faculty;professor;prof;hod;फैकल्टी;फॅकल्टी;प्रोफेसर;प्राध्यापक;ಫ್ಯಾಕಲ್ಟಿ;ಪ್ರೊಫೆಸರ್;பேராசிரியர்;புரொபசர்;ப்ரொபசர்;ஃபேகல்டி;ஃபேக்கல்டி;ప్రొఫెసర్;ఫ్యాకల్టీ;অধ্যাপক;প্রফেসর;ফ্যাকাল্টি",
        "weak": "consultant;attending;कंसल्टेंट",
        "name": "",
    },
}
# With a faculty member in the room these address them, not the patient.
_FAC_AWAIT = T("sir;maam;madam;mam;sir ji;सर;सर जी;मैडम;मैम;मॅडम;ಸರ್;ಸಾರ್;ಮೇಡಂ;சார்;சர்;மேடம்;సార్;సర్;మేడం;স্যার;ম্যাডাম")
_HONORIFIC = "ji;madam;maam;mam;sir;please;garu;avare;amma;bhai;anna;asha;aasha;meera;mira;dev;vikram;rao;जी;मैडम;सर;साहब;ಅವರೇ;ಮೇಡಂ;ಸರ್;மேடம்;சார்;గారు;మేడం;మహోదయ;দিদি;স্যার;please please"

_VOC: dict[str, dict[str, re.Pattern[str]]] = {
    r: {k: T(v) for k, v in d.items() if v} for r, d in _ROLE_TITLES.items()
}
_PREFIX = r"(?:(?:dr|doctor|डॉक्टर|ಡಾಕ್ಟರ್) )?"


def _alts(terms: str) -> str:
    return "|".join(sorted((_pattern(w.strip()) for w in terms.split(";") if w.strip()), key=len, reverse=True))


_HON = _alts(_HONORIFIC)

# A title followed by these is talked ABOUT, not talked TO ("nurse will give you", "नर्स ने बताया").
_MENTION_NEXT = T("will;is;was;has;had;said;says;told;gave;can;would;does;did;and;or;who;in;at;came;comes;took;of;"
                  "ne;ko;se;ka;ki;ke;wali;wale;aayi;aayegi;ayegi;hai;tha;thi;"
                  "ने;को;से;का;की;के;है;थी;था;वाली;वाले;आएगी;आएंगी;ला;चा;ची;चे;आहे;নে;কে;থেকে;আছে;"
                  "ಬರ್ತಾರೆ;ಕೊಡ್ತಾರೆ;ಅವರು;ಅವರ;ಬಂದು;வந்து;அவங்க;வந்தாங்க;వచ్చి;வருவாங்க;తీసుకుంటారు;ఇస్తారు;দেবে;দেবেন")
_BEFORE_MENTION = T("a;an;the;your;my;our;his;her;their;any;some;this;that;is;as;to;by;from;with;of;at;in;for;no;another;"
                    "she;he;i;am;was;youre;be;been;become;or;did;does;has;have;had;will;want;wants;mera;meri;aapki;aapke;apki;"
                    "ek;koi;kisi;एक;कोई;किसी;आपकी;आपके;मेरी;मेरे;तुमची;तुमच्या;ಯಾರು;ಯಾವ;ನಿಮ್ಮ;ஒரு;உங்க;உங்கள்;మీ;ఒక;একজন;আপনার")
_COMPOUND_NEXT = T("report;reports;test;tests;result;results;work;value;values;slip;card;coat;number;bill;counter;store;shop;"
                   "se;mein;me;par;pe;mathun;madhun;मधून;मध्ये;कडून;से;में;मे;पर;की;का;के;রিপোর্ট;পরীক্ষা;ರಿಪೋರ್ಟ್;ರಿಪೋರ್ಟು;ரிப்போர்ட்;రిపోర్ట్;रिपोर्ट;टेस्ट;ಟೆಸ್ಟ್")
# "आशा है आप ठीक हैं", "আশা করি": hope, not Asha.
_HOPE = T("asha hai;asha karta;asha karti;asha karte;asha hain;asha kari;asha ache;asha aahe;asha karto;asha korchi;"
          "आशा है;आशा हैं;आशा करता;आशा करती;आशा करते;आशा आहे;आशा करतो;आशा करते;आशा थी;आशा रखिए;"
          "আশা করি;আশা করছি;আশা আছে;আশা কর*;ಆಶಾ ಇದೆ;ఆశ ఉంది;ఆశ ఉన్న*;ஆசை")

# -------- tests and drugs

_TESTS = (
    "cbc;fbc;bmp;cmp;lft;lfts;kft;kfts;rft;rfts;tsh;hba1c;a1c;ecg;ekg;xray;cxr;usg;ct;mri;echo;echocardiogram;bloods;rbs;fbs;ppbs;"
    "urinalysis;urine test;urine routine;urine culture;blood culture;blood cultures;culture;swab;troponin;trop;lipid profile;lipid panel;lipids;crp;esr;"
    "electrolytes;potassium;sodium;haemoglobin;hemoglobin;platelets;platelet count;magnesium;uric acid;glucose;abg;ultrasound;ultrasonography;scan;sonography;blood test;blood tests;blood work;bloodwork;sugar test;blood sugar;random sugar;fasting sugar;sugar checked;"
    "glucose test;bedside glucose;glucometer;creatinine;urea;bilirubin;ferritin;d dimer;dimer;bnp;inr;coagulation;lipase;amylase;procalcitonin;psa;"
    "biopsy;mammogram;eeg;emg;dexa;endoscopy;spirometry;peak flow;pft;audiometry;fundoscopy;lumbar puncture;serology;dengue test;malaria test;"
    "pregnancy test;stool test;stool culture;sputum;pap smear;pap;hiv test;hepatitis panel;vitamin d level;thyroid test;thyroid profile;thyroid function;lactate;"
    "liver function;kidney function;renal function;hemogram;haemogram;labs;investigations;investigation;smear;xray chest;chest xray;orthopantomogram;opg;"
    "khoon ki jaanch;khoon ki janch;khoon test;peshab ki jaanch;peshab test;jaanch;janch;rakta pariksha;rakta pariksha;ratha parisodhanai;raktha pariksha;rakto porikkha;"
    "ईसीजी;इसीजी;एक्स रे;एक्सरे;सीबीसी;ब्लड टेस्ट;खून की जांच;खून टेस्ट;खून की टेस्ट;शुगर टेस्ट;शुगर की जांच;यूरिन टेस्ट;पेशाब की जांच;सीटी;सीटी स्कैन;स्कैन;स्कॅन;एमआरआई;एमआरआय;"
    "अल्ट्रासाउंड;सोनोग्राफी;इको;ट्रोपोनिन;एलएफटी;केएफटी;थायराइड टेस्ट;टेस्ट;जांच;रक्त तपासणी;रक्ताची तपासणी;रक्त चाचणी;लघवी तपासणी;लघवीची तपासणी;तपासणी;चाचणी;कल्चर;"
    "ಇಸಿಜಿ*;ಈಸಿಜಿ*;ಎಕ್ಸ್ ರೇ;ಎಕ್ಸರೇ;ಎಕ್ಸ್ರೇ;ಸಿಬಿಸಿ*;ಬ್ಲಡ್ ಟೆಸ್ಟ್;ರಕ್ತ ಪರೀಕ್ಷೆ;ರಕ್ತದ ಪರೀಕ್ಷೆ;ಶುಗರ್ ಟೆಸ್ಟ್;ಯೂರಿನ್ ಟೆಸ್ಟ್;ಮೂತ್ರ ಪರೀಕ್ಷೆ;ಸಿಟಿ ಸ್ಕ್ಯಾನ್;ಸ್ಕ್ಯಾನ್*;ಎಂಆರ್ಐ;ಅಲ್ಟ್ರಾಸೌಂಡ್;ಟೆಸ್ಟ್;"
    "ஈசிஜி*;இசிஜி*;எக்ஸ்ரே*;எக்ஸ் ரே;சிபிசி*;ரத்த பரிசோதனை;இரத்த பரிசோதனை;ரத்தப் பரிசோதனை;இரத்தப் பரிசோதனை;ரத்த டெஸ்ட்;பிளட் டெஸ்ட்;ப்ளட் டெஸ்ட்;சுகர் டெஸ்ட்;ஸ்கேன்*;சிடி ஸ்கேன்;எம்ஆர்ஐ;யூரின் டெஸ்ட்;டெஸ்ட்;"
    "ఈసీజీ*;ఇసిజి*;ఎక్స్ రే;ఎక్స్రే;సీబీసీ*;బ్లడ్ టెస్ట్;రక్త పరీక్ష;షుగర్ టెస్ట్;స్కాన్;స్కానింగ్;సీటీ స్కాన్;ఎంఆర్ఐ;యూరిన్ టెస్ట్;టెస్ట్;"
    "ইসিজি*;এক্স রে*;এক্সরে*;সিবিসি*;ব্লাড টেস্ট*;রক্ত পরীক্ষা*;রক্তের পরীক্ষা*;রক্তের সুগার;সুগার টেস্ট*;স্ক্যান;সিটি স্ক্যান;এমআরআই;আল্ট্রাসাউন্ড;ইউরিন টেস্ট;টেস্ট"
)
_DRUGS = (
    "amoxicillin;clavulanate;azithromycin;ciprofloxacin;cefuroxime;doxycycline;penicillin;metronidazole;nitrofurantoin;trimethoprim;sulfamethoxazole;"
    "clotrimazole;acyclovir;amlodipine;ramipril;losartan;metoprolol;bisoprolol;hydrochlorothiazide;indapamide;spironolactone;metformin;gliclazide;"
    "empagliflozin;insulin;paracetamol;acetaminophen;ibuprofen;naproxen;diclofenac;tramadol;colchicine;allopurinol;pantoprazole;esomeprazole;omeprazole;"
    "famotidine;ranitidine;loperamide;ondansetron;metoclopramide;lactulose;mesalazine;cetirizine;levocetirizine;desloratadine;fexofenadine;salbutamol;"
    "budesonide;formoterol;tiotropium;montelukast;fluticasone;levothyroxine;thyroxine;methimazole;carbimazole;propylthiouracil;atorvastatin;rosuvastatin;"
    "simvastatin;ezetimibe;aspirin;clopidogrel;apixaban;warfarin;heparin;nitroglycerin;nitroglycerine;furosemide;sertraline;escitalopram;fluoxetine;"
    "mirtazapine;lorazepam;diazepam;midazolam;quetiapine;methylphenidate;zolpidem;propranolol;topiramate;sumatriptan;amitriptyline;gabapentin;"
    "carbamazepine;levodopa;donepezil;prednisone;prednisolone;hydrocortisone;mometasone;adapalene;tacrolimus;permethrin;ketoconazole;timolol;latanoprost;"
    "tamsulosin;finasteride;sildenafil;methotrexate;hydroxychloroquine;alendronate;thiamine;tranexamic;morphine;codeine;fentanyl;haloperidol;dexamethasone;"
    "baclofen;hyoscine;nystatin;ceftriaxone;cefixime;cefalexin;chlorhexidine;adrenaline;epinephrine;atropine;pralidoxime;dextrose;enoxaparin;dantrolene;"
    "vancomycin;gentamicin;meropenem;piperacillin;clarithromycin;levofloxacin;ketorolac"
)
_DRUG_SLANG = (
    "crocin;dolo;pcm;amoxy;amoxyclav;augmentin;azithro;cipro;pan 40;pantop;omez;ondem;emeset;metro;lasix;deriphyllin;asthalin;duolin;"
    "combiflam;brufen;voveran;tramadol;septran;bactrim;ors;rantac;avil;hydrocort;dexa;dexona;ringer;ringer lactate;normal saline;"
    "paracetamole;para;tetanus shot;tt injection;asv;anti venom;antivenom;vaccine;"
    "मॉर्फिन;मार्फिन;ट्रामाडोल;पैन्टोप;क्रोसिन;डोलो;एस्पिरिन;आइबुप्रोफेन;इंसुलिन;ओआरएस;ಕ್ರೋಸಿನ್;ಡೋಲೋ;ಆಸ್ಪಿರಿನ್;ಇನ್ಸುಲಿನ್;ಓಆರ್ಎಸ್;டோலோ;க்ரோசின்;ஆஸ்பிரின்;இன்சுலின்;ఆస్పిరిన్;డోలో;క్రోసిన్;ఇన్సులిన్;অ্যাসপিরিন;ক্রোসিন;ডোলো;ইনসুলিন"
)
# Only staff do these.
_PROC = (
    "आईवी;इन्ट्रावेनस;injection;injections;drip;saline;iv;iv fluids;iv line;fluids;oxygen;nebuliser;nebulizer;nebulisation;nebulization;neb;nebs;cannula;catheter;"
    "antibiotic;antibiotics;painkiller;painkillers;analgesic;antacid;antacids;steroid;steroids;antihistamine;antiemetic;laxative;jab;dressing;bandage;stitches;referral;"
    "inhaler;insulin;suture;sutures;pain relief;hydration;"
    "इंजेक्शन;सुई;ड्रिप;सलाइन;सलाईन;ऑक्सीजन;ऑक्सिजन;एंटीबायोटिक;ग्लूकोज;पट्टी;ಇಂಜೆಕ್ಷನ್*;ಡ್ರಿಪ್;ಸಲೈನ್;ಆಕ್ಸಿಜನ್;ಆಂಟಿಬಯೋಟಿಕ್;"
    "ஊசி;டிரிப்;ட்ரிப்;சலைன்;ஆக்சிஜன்;இன்ஜெக்ஷன்;ఇంజెక్షన్*;డ్రిప్;సెలైన్;ఆక్సిజన్;ইনজেকশন*;স্যালাইন*;ড্রিপ*;অক্সিজেন*;"
    "injekshan;sui"
)
# Ordinary words for medicine: they need a clear order around them.
_GENERIC = (
    "tablet;tablets;tab;tabs;capsule;capsules;medicine;medicines;medication;medications;syrup;ointment;cream;dose;mg;milligram;milligrams;ml;sugar;blood;urine;sample;samples;"
    "dawa;dawai;dava;davai;goli;goliyan;dawaiyan;marundhu;mathirai;mandu;matra;aushadh;oushadha;maatre;matre;oshudh;"
    "दवा;दवाई;दवाइयां;दवाएं;गोली;गोलियां;शुगर;ब्लड;खून;औषध;औषधे;गोळी;गोळ्या;रक्त;ಔಷಧ*;ಮಾತ್ರೆ*;ಬ್ಲಡ್;ಶುಗರ್;ರಕ್ತ;மாத்திரை*;மருந்து*;ரத்தம்;సుగర్;మాత్ర*;మందు*;బ్లడ్;షుగర్;రక్తం;ওষুধ*;ট্যাবলেট*;রক্ত*;সুগার"
)

TEST_RX = T(_TESTS)
DRUG_RX = T(_DRUGS, _DRUG_SLANG)
PROC_RX = T(_PROC)
GENERIC_RX = T(_GENERIC)

_LATIN_CLASS = {"k": "k", "g": "k", "q": "k", "c": "k", "t": "t", "d": "t", "p": "p", "b": "p", "f": "p", "v": "p", "w": "p",
                "s": "s", "z": "s", "j": "s", "m": "n", "n": "n", "r": "r", "l": "l"}
_INDIC_CLASS = "kkkkn" "ssssn" "ttttn" "ttttnn" "ppppn" "-" "rr" "lll" "p" "sss" "-"  # U+xx15 .. U+xx39


def skeleton(word: str) -> str:
    """Consonant classes of a word in any script, so a drug matches its spelling
    in Devanagari or Tamil, or a misspelt transcript ("amoxycillin")."""
    out: list[str] = []
    w = word.replace("ph", "f").replace("ch", "s").replace("th", "t").replace("sh", "s").replace("x", "ks")
    for i, ch in enumerate(w):
        cp = ord(ch)
        if ch == "c" and i + 1 < len(w) and w[i + 1] in "eiy":
            c = "s"
        elif ch == "g" and i + 1 < len(w) and w[i + 1] in "eiy":
            c = "s"
        elif ch in _LATIN_CLASS:
            c = _LATIN_CLASS[ch]
        elif 0x0900 <= cp <= 0x0CFF and 0x15 <= (cp & 0x7F) <= 0x39:
            c = _INDIC_CLASS[(cp & 0x7F) - 0x15]
        elif 0x0900 <= cp <= 0x0CFF and (cp & 0x7F) == 0x02:
            c = "n"
        else:
            c = "-"
        if c != "-" and (not out or out[-1] != c):
            out.append(c)
    return "".join(out)


_DRUG_SKEL = {s for w in _DRUGS.split(";") if len(s := skeleton(w.strip())) >= 5}


@lru_cache(maxsize=4096)
def _drug_token(tok: str) -> bool:
    if len(tok) < 6:
        return False
    s = skeleton(tok)
    if len(s) < 5:
        return False
    if tok.isascii():
        return s in _DRUG_SKEL
    return any(s.startswith(d) for d in _DRUG_SKEL)  # case endings ("ಪ್ಯಾರಸಿಟಮಾಲನ್ನು")


def _drug(t: str) -> bool:
    return has(DRUG_RX, t) or any(_drug_token(x) for x in t.split())


# -------- symptoms, history talk, questions, second person

SYMPTOM_RX = T(
    "pain;pains;fever;cough;cold;vomiting;nausea;dizzy;dizziness;giddy;giddiness;headache;ache;itching;itchy;rash;swelling;breathless;breathlessness;"
    "tired;weak;weakness;fatigue;bleeding;burning;numbness;tingling;cramps;diarrhoea;diarrhea;constipation;illness;illnesses;sick;hurt;hurts;hurting;tired;"
    "chills;sweating;palpitations;seizure;fits;faint;fainted;sleepy;drowsy;thirsty;hungry;"
    "dard;bukhar;khansi;ulti;chakkar;sujan;kamzori;thakan;jalan;khujli;"
    "दर्द;बुखार;खांसी;उल्टी;चक्कर;सूजन;कमजोरी;थकान;जलन;खुजली;दुखता;दुखती;ताप;खोकला;दुखणे;दुखतं;दुखतंय;ಜ್ವರ;ನೋವು;ಕೆಮ್ಮು;ವಾಂತಿ;ತಲೆಸುತ್ತು;"
    "காய்ச்சல்;வலி;இருமல்;வாந்தி;தலைசுத்தல்;జ్వరం;నొప్పి;దగ్గు;వాంతి;వాంతులు;জ্বর;ব্যথা;কাশি;বমি;মাথা ঘোরা"
)
HISTORY_RX = T(
    "how long;since when;how many days;how many times;any illness;any illnesses;at home;in your family;in the family;ever had;ever been;where does it;does it;"
    "any allergy;any allergies;any pain;any fever;any medicines;any tablets;any medication;any problem;any problems;any other;smoke;smoking;alcohol;drink;drinking;"
    "periods;pregnant;appetite;before this;in the past;how are you;how is your;what happened;what brings;tell me about;tell me;hurt;hurts;"
    "kab se;kitne din;kitne dino;kya hua;kahan dard;ghar mein;ghar me;pehle kabhi;batao;bataiye;takleef;taklif;"
    "कब से;कितने दिन;क्या हुआ;कहां दर्द;घर में;पहले कभी;बताओ;बताइए;तकलीफ;कधीपासून;किती दिवस;काय झालं;काय होतंय;घरी कोणाला;सांगा;त्रास;"
    "ಎಷ್ಟು ದಿನ*;ಯಾವಾಗಿಂದ;ಏನಾಯ್ತು;ಎಲ್ಲಿ ನೋವು;ಮನೆಯಲ್ಲಿ;ಮನೇಲಿ;ಹೇಳಿ;ತೊಂದರೆ;எத்தனை நாள*;எப்போ இருந்து;எப்பவிருந்து;என்ன ஆச்சு;எங்க வலி*;வீட்டுல;வீட்டில்;சொல்லுங்க;"
    "ఎన్ని రోజుల*;ఎప్పటి నుంచి;ఎప్పటినుంచి;ఏమైంది;ఎక్కడ నొప్పి;ఇంట్లో;చెప్పండి;কত দিন*;কতদিন*;কবে থেকে;কী হয়েছে;কি হয়েছে;কোথায় ব্যথা;বাড়িতে;বলুন;"
    "eshtu dina*;yavagind*;enaytu;heli;ethana naal*;eppolerndhu;enna achu;sollunga;enni roju*;eppati nunchi;emaindi;cheppandi;kadhi pasun;kiti divas;sanga;koto din*;kobe theke;ki hoyeche;bolun"
)
YOU_RX = T(
    "you;your;yours;yourself;youre;youve;youd;youll;ur;aap;aapko;aapka;aapki;aapke;aapne;aapse;apko;apka;apki;apke;tum;tumko;tumhe;tumhara;tumhari;tumhe;"
    "neevu;nimma;nimge;nimage;nimagey;neenga;ninga;unga;ungalukku;ungaluku;meeru;meeku;miku;mee;meru;tumhi;tumhala;tumcha;tumchi;tumche;tumcya;apni;apnar;apnake;tumi;tomar;"
    "आप;आपको;आपका;आपकी;आपके;आपने;आपसे;तुम;तुम्हें;तुम्हारा;तुम्हारी;तुम्ही;तुम्हाला;तुमचा;तुमची;तुमचे;तुमच्या;तुम्हास;"
    "ನೀವು;ನಿಮ್ಮ*;ನಿಮಗೆ;ನಿಮ್ಗೆ;நீங்க;நீங்கள்;உங்க*;మీరు;మీకు;మీ;మీది;আপনি;আপনার;আপনাকে;তুমি;তোমার;তোমাকে;"
    # second person verb endings ("have you had it done?")
    "*ದೀರಾ;*ತೀರಾ;*ங்களா;*றீங்க;*ారా;*చ్చారా;*চ্ছেন;*য়েছেন;*েছেন;*neengala;*ingala;*unnara;*dira;*theera"
)
# "can you get an ECG", "I want you to order ...": a request to staff, not talk about "you".
_POLITE_YOU = T("can someone;could someone;can somebody;could somebody;can anyone;could anyone;can you please;could you please;would you please;will you please;can you;could you;would you;will you;i want you to;i need you to;"
                "thank you;if you can;would you mind;i would like you to;id like you to;please can you;you can go ahead and")
QUESTION_RX = T(
    "how;what;whats;when;where;wheres;why;which;who;whose;do;does;did;is;are;was;were;have;has;had;any;am;"
    "kya;kab;kahan;kidhar;kitna;kitne;kitni;kaise;kaisa;kaisi;kyun;kyon;kaun;kaunsa;konsi;kis;kisko;"
    "yavaga;yaavaga;eshtu;yestu;enu;yenu;elli;yelli;hege;yake;yaake;ideya;idya;idyaa;"
    "eppo;eppodhu;evlo;evvalavu;enna;enga;epdi;eppadi;yen;irukka;iruka;irukkaa;"
    "eppudu;enni;entha;enta;em;emi;ekkada;enduku;ela;unda;undha;undaa;"
    "kadhi;kiti;kuthe;kasa;kashi;kase;kon;konti;kay;kaay;"
    "kobe;kokhon;koto;kothay;keno;kemon;ki;kon;"
    "क्या;कब;कहां;किधर;कितना;कितने;कितनी;कैसे;कैसा;कैसी;क्यों;कौन;कौनसी;किस;"
    "काय;कधी;किती;कुठे;कसा;कशी;कसे;कोण;कोणती;कोणता;का;"
    "ಯಾವಾಗ;ಎಷ್ಟು;ಏನು;ಏನ್;ಎಲ್ಲಿ;ಹೇಗೆ;ಯಾಕೆ;ಯಾವ;ಯಾರು;ಇದೆಯಾ;ಇದ್ಯಾ;ಇದೆಯೇ;ಆಗ್ತಿದೆಯಾ;ಯಾವಾಗಿಂದ;ಬರುತ್ತಾ;ಬರ್ತಿದೆಯಾ;"
    "எப்போ;எப்போது;எவ்வளவு;என்ன;எங்க;எங்கே;எப்படி;ஏன்;யார்;எத்தனை;இருக்கா;இருக்குதா;வருதா;சாப்பிடுறீங்களா;"
    "ఎప్పుడు;ఎన్ని;ఎంత;ఏమి;ఏం;ఏమిటి;ఎక్కడ;ఎందుకు;ఎలా;ఎవరు;ఉందా;ఉన్నాయా;వస్తుందా;"
    "কী;কি;কবে;কখন;কত;কোথায়;কেন;কেমন;কে;কোন;কতদিন;আছে কি"
)
_Q_START = re.compile(
    r"^ (?:do (?=(?:you|they|we|i|the|your|he|she|it|any|these|those|his|her) )|(?:does|did|have|has|had|are|is|were|was|when|how|what|whats|where|why|any|which|who|will|would|can|could|kya|क्या) )")
_WE_Q = re.compile(r"^ (?:should|shall|can|could|do|would|may) (?:we|i) ")
_THIRD = T("she;he;her;him;his;the patient;this patient;patient;patients;result;results;report;reports;value;values;ready;back;potassium;creatinine;"
           "usko;uska;uski;unko;inko;iska;iski;mareez;marij;rogi;उसको;उसे;इनको;उनको;मरीज;रोगी;रुग्ण;रुग्णाला;patient*;पेशंट*;पेशेंट*;ಪೇಷಂಟ್*;ಪೇಶೆಂಟ್*;பேஷண்ட்*;பேஷன்ட்*;పేషెంట్*;পেশেন্ট*;ರೋಗಿ*;ಇವರಿಗೆ;ಅವರಿಗೆ;நோயாளி*;அவங்களுக்கு;இவங்களுக்கு;రోగి*;ఈయనకి;ఆమెకి;রোগী*;ওনাকে;ওকে")

# What a colleague is asked, never a patient.
_COLLEAGUE = T("your impression;your opinion;your advice;your view;your recommendation;you think;you suggest;you recommend;do you advise;your verdict;your report;your department;"
               "you see;you hold;you held;you stop;you stopped;you reject;you rejected;you approve;you approved;you verify;you verified;you send;you sent;you run;you ran;you report;you reported;you read;"
               "you dispense;you release;you released;you change;you changed;you block;you blocked;you receive;you received;is there any;is there a;is there an;are there any;"
               "aapki rai;aap kya sochte;aapko kya lagta;आपकी राय;आपको क्या लगता;ನಿಮ್ಮ ಅಭಿಪ್ರಾಯ;உங்க கருத்து;మీ అభిప్రాయం;तुमचं मत;আপনার মত")
# "nurse told you ..." in Indian word order: staff title first, then "to you".
_YOU_DATIVE = T("aapko;apko;tumhe;nimge;nimage;ungalukku;ungaluku;meeku;tumhala;apnake;aapse;आपको;आपसे;तुम्हें;ನಿಮಗೆ;ನಿಮ್ಗೆ;உங்களுக்கு;உங்கள்ட்ட;మీకు;तुम्हाला;আপনাকে;তোমাকে")

# What departments talk about. With a department's first name this is never the patient.
_DEPT_TOPIC = T("dose;doses;dosing;stock;interaction;interactions;dispense;prescription;expiry;expired;generic;brand;renal dosing;vial;vials;label;sample;samples;specimen;result;results;report;reports;value;values;"
                "culture;creatinine;potassium;troponin;hemolysed;hemolyzed;recount;xray;scan;ct;mri;ultrasound;film;films;image;images;contrast;finding;findings;impression;lesion;effusion;infiltrate;infiltrates;lung fields;"
                "drug;drugs;antibiotic;insulin;injection;syrup;tablet;tablets;medicine;ointment;alternative;substitute;"
                "डोज;स्टॉक;सैंपल;रिपोर्ट;रिजल्ट;कॉन्ट्रास्ट;फिल्म;दवा;इंटरैक्शन;डोस;ಡೋಸ್;ಸ್ಟಾಕ್;ಸ್ಯಾಂಪಲ್;ರಿಪೋರ್ಟ್;ಕಾಂಟ್ರಾಸ್ಟ್;ಔಷಧ*;டோஸ்;ஸ்டாக்;சாம்பிள்;ரிப்போர்ட்*;மருந்து*;டோஸு;డోస్;స్టాక్;శాంపిల్;రిపోర్ట్*;మందు*;"
                "ডোজ*;স্টক*;স্যাম্পল*;রিপোর্ট*;রেজাল্ট*;ওষুধ*;কন্ট্রাস্ট*;প্রেসক্রিপশন*;সিরাম*;জেনেরিক*;সিরাপ*;এক্সপায়ারি;ইনসুলিন*;অ্যান্টিবায়োটিক*")

# -------- order verbs

_HEAD = (r"(?:(?:please|kindly|just|lets|let us|someone|somebody|can someone|could someone|can somebody|could somebody|can anyone|could anyone|can you|could you|would you|will you|can we|could we|shall we|should we|should i|we should|we need to|"
         r"we have to|we will|we shall|well|we must|we are going to|were going to|we can|i want to|i would like to|id like to|i want you to|i need you to|i need to|"
         r"go ahead and|go ahead|ill|i will|i am going to|im going to|i think|i guess|i feel|maybe|perhaps|now|first|then|also|immediately|quickly|"
         r"urgently|meanwhile|next step is to|next step|next|is to|to|and|plan is to|the plan is to|plan) )*")
_VERB = (r"(?P<verb>order|get|send off|send|run|do|give|start|put|prescribe|arrange|repeat|add|draw|book|schedule|refer|administer|push|set up|collect|"
         r"inject|increase|decrease|reduce|change|switch|dispense|request|organise|organize|hook|fetch|check|connect|insert|apply|write|log|"
         r"take (?:a |an |some |her |his |the )?(?:blood|bloods|sample|samples|swab|culture|ecg|xray)|ordering|prescribing|starting|giving)")
_ORDER_HEAD = re.compile(r"^ (?P<chain>" + _HEAD + r")" + _VERB + r" ")
_WANT = re.compile(r"^ " + _HEAD + r"(?P<verb>i want|i need|id like|i would like|we need|well need|we will need|we want|"
                   r"(?:she|he|they|this patient|the patient|patient) (?:needs?|should (?:have|get|be given|be started on)|requires?|will need|must get)|needs) ")
_SELF = re.compile(r" (?:ill|i will|i am going to|im going to|well|we will|we are going to|were going to|we shall) ")
_FREE_VERBS = {"order", "prescribe", "book", "schedule", "refer", "administer", "ordering", "prescribing", "log"}
_WEAK_VERBS = {"do", "get", "check", "run", "put", "write", "apply", "change", "add", "fetch", "take"}
_FREE_OBJ = T("followup;appointment;appointments;review;consult;consultation;referral;logbook;case;tests;test;investigations;medicines;medicine;admission;bed;"
              "cardiology;cardio;neurology;surgery;ent;orthopaedics;ortho;dermatology;physiotherapy;dietician;visit;call;that;it;something;same")
_ORDER_PHRASE = T("log this case;log the case;add this case to;add the case to;sort out the pain;sort the pain;sort out her pain;sort out his pain;something for the pain;something for the fever;"
                  "something for the acidity;something for the vomiting;something for the nausea;something for the cough;something for her pain;something for his pain;"
                  "something for the allergy;something for sleep;something for her fever;something for his fever;book a followup;schedule a followup;book followup;"
                  "followup book;followup schedule;send for;case close;close the case")
# Said to the patient whatever the clinical word ("come back with the report", "take it at home").
_TO_PATIENT = T("come back;come again;with the report;at home;ghar pe;ghar par;ghar pr;from the pharmacy;from pharmacy;from the chemist;from a chemist;downstairs;upstairs;first floor;"
                "give me;show me;tell me;bring me;if he has;if she has;if it;after food;before food;before bed;every night;every morning;when he;when she;dont worry;"
                "next week and;go to;take it;take this;take the;take one;take two;take these;swallow;apply it;"
                "घर पर;मुझे बताओ;मुझे बताइए;खाने के बाद;खाने से पहले;घरी;जेवणानंतर;ಮನೆಯಲ್ಲಿ;ಮನೇಲಿ;ಊಟ ಆದ್ಮೇಲೆ;வீட்டுல;சாப்பாட்டுக்கு அப்புறம்;ఇంట్లో;భోజనం తర్వాత;বাড়িতে;খাওয়ার পর")

_NATIVE_ORDER = T(
    # Hindi / Hinglish
    "kara do;karado;karwa do;karwado;karva do;kara dijiye;karwa dijiye;karva dijiye;kara dena;karwa dena;karao;karwao;karvao;karaiye;karwaiye;kar do;kardo;kar dijiye;kardijiye;kar dena;karo;kariye;kijiye;"
    "de do;dedo;de dijiye;dedijiye;dijiye;de dena;dena;dila do;laga do;lagado;lagao;lagaiye;laga dijiye;lagwa do;chadha do;chadhao;chadha dijiye;bhej do;bhejo;bhejiye;bhej dijiye;"
    "mangwa do;mangwao;manga lo;mangao;likh do;likho;shuru karo;shuru kar do;chalu karo;chalu kar do;nikal lo;nikalo;nikaal lo;le lo;lelo;"
    "करा दो;करवा दो;करा दीजिए;करवा दीजिए;करवाओ;कराओ;करवाइए;कराइए;करवा दीजिये;कर दो;कर दीजिए;कर दीजिये;करो;करें;करिए;कीजिए;कीजिये;करवा देना;"
    "दे दो;दे दीजिए;दे दीजिये;दीजिए;दीजिये;दे देना;देना;दिला दो;लगा दो;लगाओ;लगाइए;लगा दीजिए;लगवा दो;चढ़ा दो;चढ़ाओ;चढ़ा दीजिए;भेज दो;भेजो;भेजिए;भेज दीजिए;मंगवा दो;मंगवाओ;मंगवाइए;मंगा लो;"
    "लिख दो;लिखो;शुरू करो;शुरू कर दो;चालू करो;निकाल लो;निकालो;"
    # Marathi
    "kara;karun ghya;karun dya;dya;deun taka;lava;pathva;kadha;suru kara;karva;karvun ghya;करा;करून द्या;करून घ्या;करवा;करवून घ्या;द्या;देऊन टाका;लावा;पाठवा;काढा;काढून घ्या;सुरू करा;मागवा;लावून ठेवा;काढून आणा;देऊन ठेवा;नोंद करा;"
    # Kannada
    "maadi;madi;maadisi;madisi;maadsi;madsi;kodi;kodri;koditheera;haaki;haki;kalsi;kaluhisi;kalisi;tarisi;shuru maadi;"
    "ಮಾಡಿ;ಮಾಡಿಸಿ;ಮಾಡ್ಸಿ;ಮಾಡ್ರಿ;ಮಾಡಿಸ್ರಿ;ಕೊಡಿ;ಕೊಡ್ರಿ;ಕೊಟ್ಬಿಡಿ;ಹಾಕಿ;ಹಾಕ್ರಿ;ಕಳುಹಿಸಿ;ಕಳಿಸಿ;ಕಳ್ಸಿ;ತರಿಸಿ;ಶುರು ಮಾಡಿ;ಪ್ರಾರಂಭಿಸಿ;ತೆಗೀರಿ;ತೆಗೆಯಿರಿ;"
    # Tamil
    "kodunga;kudunga;pannunga;pannidunga;podunga;edunga;anuppunga;eduthudunga;start pannunga;"
    "கொடுங்க;குடுங்க;கொடுங்கள்;பண்ணுங்க;பண்ணுங்கள்;பண்ணிடுங்க;போடுங்க;போடுங்கள்;எடுங்க;எடுங்கள்;எடுத்துடுங்க;அனுப்புங்க;அனுப்புங்கள்;ஆரம்பிங்க;ஏத்துங்க;எடுத்துட்டு வாங்க;எடுத்துட்டு வந்து;"
    # Telugu
    "ivvandi;cheyandi;cheyyandi;cheyinchandi;cheyinchu;pettandi;pampandi;teeyandi;tiyandi;rayandi;"
    "ఇవ్వండి;చేయండి;చెయ్యండి;చేయించండి;పెట్టండి;పంపండి;పంపించండి;తీయండి;తియ్యండి;తీయించండి;వేయండి;ఎక్కించండి;మొదలుపెట్టండి;"
    # Bengali
    "din;dao;diye din;korun;koran;kore din;koriye din;pathan;pathiye din;lagan;shuru korun;"
    "দাও;দিয়ে দিন;দিয়ে দাও;করুন;করান;করাও;করে দিন;করিয়ে দিন;পাঠান;পাঠিয়ে দিন;পাঠাও;লাগান;লাগিয়ে দিন;শুরু করুন;চালু করুন;আনান;করো;করে নাও;করিয়ে নাও;করায় নাও;লাগাও;মাপো;শুরু করো;করে ফেলুন;নিয়ে নিন"
)
_NATIVE_NEED = T(
    "chahiye;karna hai;karwana hai;karana hai;dena hai;lagana hai;bhejna hai;karna padega;चाहिए;करना है;करवाना है;कराना है;देना है;लगाना है;भेजना है;"
    "pahije;karaycha aahe;karaychi aahe;पाहिजे;करायचा आहे;करायची आहे;करायचं आहे;द्यायचं आहे;"
    "maadbeku;madbeku;maadabeku;kodbeku;beku;ಮಾಡಬೇಕು;ಮಾಡ್ಬೇಕು;ಮಾಡಿಸಬೇಕು;ಮಾಡಿಸ್ಬೇಕು;ಕೊಡಬೇಕು;ಕೊಡ್ಬೇಕು;ಬೇಕು;"
    "edukkanum;pannanum;kodukkanum;venum;எடுக்கணும்;பண்ணணும்;பண்ணனும்;கொடுக்கணும்;வேணும்;தேவை;"
    "cheyali;cheyyali;ivvali;teeyali;kavali;చేయాలి;చెయ్యాలి;ఇవ్వాలి;తీయాలి;కావాలి;చేయించాలి;"
    "korte hobe;dite hobe;lagbe;dorkar;*তে হবে;রক্তের সুগার মাপ*;করতে হবে;করাতে হবে;দিতে হবে;লাগবে;দরকার"
)
# "let me see", "show", "take (for yourself)", "tell": said to the patient.
_NATIVE_PATIENT_VERB = T(
    "kara lena;karwa lena;le lena;kharid lena;le aana;lijiye;le lijiye;kha lo;khao;khaiye;khana;peena;pijiye;kara lijiye;karwa lijiye;karwa lo;kara lo;batao;bataiye;dikhao;dikhaiye;dikha do;bolo;boliye;baithiye;let jaiye;aaiye;"
    "करा लेना;करवा लेना;ले लेना;ले आना;खरीद*;लीजिए;ले लीजिए;खा लो;खाओ;खाइए;पीजिए;करा लीजिए;करवा लीजिए;करवा लो;बताओ;बताइए;दिखाओ;दिखाइए;दिखा दो;दिखा दीजिए;बोलिए;बैठिए;लेट जाइए;आइए;घेत;घ्या;खा;सांगा;दाखवा;बसा;"
    "tagolli;tegedukolli;heli;helu;torsi;ತಗೊಳ್ಳಿ;ತಗೋಳಿ;ತೆಗೆದುಕೊಳ್ಳಿ;ಹೇಳಿ;ತೋರಿಸಿ;ಮಾಡಿಸಿಕೊಳ್ಳಿ;ಮಾಡಿಸ್ಕೊಳ್ಳಿ;ಕೂತ್ಕೊಳ್ಳಿ;"
    "sapdunga;saapidunga;sollunga;kaattunga;eduthukonga;eduthukkonga;சாப்பிடுங்க;சொல்லுங்க;காட்டுங்க;எடுத்துக்கோங்க;எடுத்துக்கங்க;உக்காருங்க;வாங்கி;வாங்கிக்கோங்க;வெயிட் பண்ணுங்க;"
    "teesukondi;vesukondi;cheppandi;chupinchandi;cheyinchukondi;తీసుకోండి;వేసుకోండి;చెప్పండి;చూపించండి;చేయించుకోండి;కూర్చోండి;"
    "nin;khan;bolun;dekhan;koriye nin;নিন;খান;খাবেন;বলুন;দেখান;করিয়ে নিন;করিয়ে নেবেন;বসুন"
)
# "they are coming to take blood": talk about staff, not to them.
_THIRD_VERB = T("*ತಾರೆ;*ದ್ದಾರೆ;*டாங்க;*றாங்க;*டுவாங்க;*ருவாங்க;*ப்பாங்க;*స్తారు;*తారు;*డారు;aayegi;ayegi;karegi;degi;legi;dengi;आएगी;आएंगी;करेगी;देगी;लेगी;देंगी;येईल;येतील;देईल;করবে;আসবে;দেবে;নেবে;আসবেন")
_REPORT = T("report;reports;रिपोर्ट;रिपोर्टें;ரிப்போர்ட்*;ರಿಪೋರ್ಟ್*;రిపోర్ట్*;রিপোর্ট*")
_DONT_WORRY = T("dont worry;worry mat;chinta mat;tension mat;ghabraiye mat;daro mat;चिंता मत;टेंशन मत;घबराइए मत;डरो मत;काळजी करू नका;काळजी नको;घाबरू नका;चिंता करू नका;ಚಿಂತೆ ಮಾಡಬೇಡಿ;ಚಿಂತೆ ಬೇಡ;ಹೆದರಬೇಡಿ;ಟೆನ್ಷನ್ ಬೇಡ;"
                "கவலைப்படாதீங்க;கவலை வேண்டாம்;பயப்படாதீங்க;పడకండి;కంగారు పడకండి;చింతించకండి;భయపడకండి;চিন্তা করবেন না;ভয় পাবেন না;চিন্তা নেই")
_NATIVE_FUTURE = T("dunga;dungi;deta hoon;deti hoon;denge;likh raha hoon;likh deta hoon;likh rahi hoon;karenge;दूंगा;दूंगी;देता हूं;देती हूं;देंगे;लिख रहा हूं;लिख देता हूं;लिख रही हूं;"
                   "ಕೊಡ್ತೀನಿ;ಕೊಡುತ್ತೇನೆ;ಬರೀತೀನಿ;தரேன்;கொடுக்கறேன்;எழுதறேன்;ఇస్తాను;రాస్తాను;देतो;देते;लिहितो;দেব;দিচ্ছি;লিখে দিচ্ছি")
_BN_DIN_DAY = T("কত দিন;এক দিন;দু দিন;দুই দিন;তিন দিন;চার দিন;পাঁচ দিন;ছয় দিন;সাত দিন;দশ দিন;কয়েক দিন;কিছু দিন;প্রতি দিন;সারা দিন;আগের দিন;দিন ধরে;দিন আগে;দিন থেকে;কয় দিন;দিন হল;দিন হলো;দিন যাবৎ;সেই দিন;বেশি দিন;দিন রাত;"
                "koto din;ek din;dui din;tin din;char din;panch din;sat din;koyek din;din dhore;din age;din theke;protidin;koy din;"
                "teen din;do din;char din;paanch din;kitne din;kuch din;das din;pichle din;din se;din mein;din me;din pehle")

# -------- stop

_STOP_EN = re.compile(
    r" (?:(?:cancel|scrap|abort|undo|withdraw|discontinue|withhold|stop|hold|pause|forget)"
    r"(?! (?:taking|smoking|drinking|eating|worrying|breathing|crying|your|you|on|using|it there|a minute|a second|still|my)\b)"
    r"|(?:dont|do not|never mind|no need to|dont you) (?:give|start|order|send|dispense|run|administer|inject|proceed|do)(?! (?:worry))) ")
_STOP_OBJ = T("that;it;this;the order;that order;this order;order;orders;last order;the last one;everything;all orders;all of it;the request;those")
_NATIVE_STOP = T(
    "rok do;roko;rokiye;ruko;ruk jao;band karo;band kar do;bandh karo;cancel karo;cancel kar do;cancel kardo;cancel kar dijiye;cancel karna;mat do;mat dena;mat karo;mat dijiye;mat lagao;mat bhejo;mat karna;nahi dena;rehne do;radd karo;radd kar do;"
    "रोको;रोक दो;रोकिए;रोक दीजिए;बंद करो;बंद कर दो;बंद कीजिए;कैंसल करो;कैंसिल करो;कैंसल कर दो;कैंसिल कर दो;कैंसल;कैंसिल;रद्द करो;रद्द कर दो;रद्द कीजिए;मत दो;मत देना;मत करो;मत दीजिए;मत लगाओ;मत भेजो;मत करना;नहीं देना;रहने दो;रहने दीजिए;"
    "thambva;thamba;radd kara;band kara;cancel kara;deu naka;karu naka;naka deu;थांबवा;रद्द करा;बंद करा;कॅन्सल करा;देऊ नका;करू नका;नको;नका देऊ;"
    "nillisi;cancel maadi;cancel madi;raddu maadi;kodbedi;kodabedi;kodbeda;maadbedi;madbedi;beda;ನಿಲ್ಲಿಸಿ;ರದ್ದು ಮಾಡಿ;ಕ್ಯಾನ್ಸಲ್ ಮಾಡಿ;ಕೊಡಬೇಡಿ;ಕೊಡ್ಬೇಡಿ;ಮಾಡಬೇಡಿ;ಮಾಡ್ಬೇಡಿ;ಬೇಡ;ಹಾಕಬೇಡಿ;"
    "niruthunga;cancel pannunga;kudukathinga;kodukkadhinga;kudukka vendam;vendam;vena;நிறுத்துங்க;கேன்சல் பண்ணுங்க;ரத்து பண்ணுங்க;கொடுக்காதீங்க;குடுக்காதீங்க;வேண்டாம்;வேணாம்;பண்ணாதீங்க;"
    "aapandi;cancel cheyandi;cancel cheyyandi;raddu cheyandi;ivvakandi;ivvoddu;vaddu;ఆపండి;క్యాన్సిల్ చేయండి;రద్దు చేయండి;ఇవ్వకండి;ఇవ్వొద్దు;వద్దు;చేయకండి;చేయొద్దు;"
    "bondho korun;cancel korun;batil korun;deben na;diben na;thaman;dio na;বন্ধ করুন;বাতিল করুন;ক্যানসেল করুন;ক্যান্সেল করুন;দেবেন না;দিও না;থামান;করবেন না;লাগবে না"
)
_NATIVE_CANCEL = T("cancel karo;cancel kar do;cancel kardo;cancel maadi;cancel madi;cancel pannunga;cancel cheyandi;cancel korun;cancel kara;cancel kar dijiye;radd karo;"
                   "कैंसल करो;कैंसिल करो;कैंसल कर दो;कैंसिल कर दो;रद्द करो;रद्द कर दो;रद्द करा;कॅन्सल करा;ರದ್ದು ಮಾಡಿ;ಕ್ಯಾನ್ಸಲ್ ಮಾಡಿ;கேன்சல் பண்ணுங்க;ரத்து பண்ணுங்க;క్యాన్సిల్ చేయండి;రద్దు చేయండి;বাতিল করুন;ক্যানসেল করুন")

# -------- hint, override, faculty, observer

_HINT = T(
    "how am i doing;howm i doing;am i on the right track;am i on track;am i on the track;am i doing this right;am i doing it right;am i doing right;am i doing okay;am i doing ok;am i doing well;"
    "any hint;any hints;any tips;give me a hint;give me a clue;give me a tip;give me some hint;need a hint;need a clue;want a hint;hint please;a hint please;a small hint;what am i missing;am i missing something;am i missing anything;did i miss anything;did i miss something;"
    "im stuck;i am stuck;suggest something;suggest me something;guide me;"
    "what should i do next;what do i do next;what can i do next;what should i do now;what do i do now;"
    "kya main sahi;main sahi ja raha;main sahi kar raha;main sahi kar rahi;mujhe hint;koi hint;hint do;hint dijiye;hint de do;hint dedo;ab kya karun;ab kya karu;ab kya karoon;aage kya karun;aage kya karu;main kaisa kar raha;main kaisi kar rahi;"
    "kya main theek kar raha;क्या मैं सही;मैं सही कर रहा;मैं सही कर रही;कोई हिंट;हिंट दो;हिंट दीजिए;मुझे हिंट;अब क्या करूं;आगे क्या करूं;मैं कैसा कर रहा;मैं कैसी कर रही;संकेत दो;"
    "पुढे काय करू;आता काय करू;हिंट द्या;मी बरोबर करतोय;मी बरोबर करतेय;मी बरोबर करत आहे;mi barobar kartoy;pudhe kay karu;hint dya;"
    "ಸುಳಿವು ಕೊಡಿ;ಹಿಂಟ್ ಕೊಡಿ;ಮುಂದೆ ಏನು ಮಾಡಲಿ;ಮುಂದೆ ಏನ್ ಮಾಡ್ಲಿ;ಈಗ ಏನು ಮಾಡಲಿ;ನಾನು ಸರಿಯಾಗಿ ಮಾಡ್ತಿದ್ದೀನಾ;ನಾನು ಹೇಗೆ ಮಾಡ್ತಿದ್ದೀನಿ;hint kodi;munde enu maadali;naanu sariyagi maadtidina;"
    "ஹிண்ட் கொடுங்க;குறிப்பு கொடுங்க;அடுத்து என்ன பண்ணணும்;அடுத்து என்ன பண்ணனும்;அடுத்து என்ன செய்யணும்;நான் சரியா பண்றேனா;நான் எப்படி பண்றேன்;hint kodunga;hint kudunga;adutha enna pannanum;aduthu enna pannanum;naan seriya panrena;"
    "హింట్ ఇవ్వండి;సూచన ఇవ్వండి;తర్వాత ఏం చేయాలి;ఇప్పుడు ఏం చేయాలి;నేను సరిగ్గా చేస్తున్నానా;నేను ఎలా చేస్తున్నాను;hint ivvandi;tarvata em cheyali;nenu sarigga chestunnana;"
    "হিন্ট দিন;একটা হিন্ট;এরপর কী করব;এরপর কি করব;এখন কী করব;আমি কি ঠিক করছি;আমি কি ঠিক পথে;আমি কেমন করছি;hint din;erpor ki korbo;ami ki thik korchi"
)
# These only count when nothing else follows ("any ideas?" but not "any ideas what causes it?").
_HINT_WHOLE = re.compile(r"^ (?:(?:nurse|sister|asha|aasha) )?(?:can you |could you |please )?(?:any (?:ideas?|suggestions?|advice|help|clues?)|help me(?: out)?|i need (?:some )?help|whats next|what next|"
                         r"what is next|what now|next step|whats the next step|what is the next step|on track|am i right|hint|hints|help|advice|any ideas? for me|what else)"
                         r"(?: (?:please|now|here|then|asha|aasha|nurse|sister|with this(?: case)?|with the case|on this case|for this case))* $")

_OVERRIDE = T(
    "give it anyway;give anyway;start it anyway;go ahead anyway;anyway give it;give the drug anyway;give it regardless;override;overrule;over ride;release the hold;lift the hold;"
    "release the drug;release it anyway;i still want to give;i still want it;still give it;prescribe it anyway;dispense it anyway;faculty approval;faculty permission;"
    "let the faculty decide;let faculty decide;escalate to faculty;escalate it to faculty;escalate this to faculty;escalate to the professor;escalate to the faculty;"
    "ask faculty to approve;ask the faculty to approve;ask faculty to release;ask the faculty to release;ask the professor to approve;ask professor to approve;ask the professor to release;"
    "ask faculty to allow;ask the faculty to allow;ask faculty for approval;ask faculty for permission;ask the faculty for permission;ask the professor for permission;ask faculty to sign off;ask faculty to clear it;"
    "phir bhi de do;fir bhi de do;phir bhi dedo;fir bhi dedo;phir bhi dena;phir bhi start karo;phir bhi chalu karo;phir bhi give;फिर भी दे दो;फिर भी दीजिए;फिर भी दे दीजिए;फिर भी शुरू करो;फिर भी चालू करो;"
    "tari pan dya;tarihi dya;तरीही द्या;तरी पण द्या;तरीपण द्या;aadru kodi;aadaru kodi;ಆದ್ರೂ ಕೊಡಿ;ಆದರೂ ಕೊಡಿ;irundhalum kodunga;irunthalum kudunga;இருந்தாலும் கொடுங்க;பரவாயில்ல கொடுங்க;"
    "ayina ivvandi;ayina sare ivvandi;అయినా ఇవ్వండి;అయినా సరే ఇవ్వండి;tobuo din;tabuo din;তবুও দিন;তাও দিন;faculty se permission;faculty se approval;फैकल्टी से परमिशन;faculty permission le lo;hold hatao;hold hata do"
)
_FAC_WORDS = _alts(_ROLE_TITLES["faculty"]["strong"] + ";" + _ROLE_TITLES["faculty"]["weak"])
_FAC_ANY = re.compile(r"(?<= )(?:" + "|".join(_pattern(w.strip() + "*") if not w.strip().isascii() else _pattern(w.strip())
                                             for w in (_ROLE_TITLES["faculty"]["strong"] + ";" + _ROLE_TITLES["faculty"]["weak"]).split(";")) + r")(?= )")
_INVITE_EN = r"(?:call|invite|get|bring|page|add|loop in|fetch|summon|ring|phone|need|want|ask|bring in|call in|send for)"
_FAC_INVITE = re.compile(r" " + _INVITE_EN + r" (?:in )?(?:(?:the|our|my|a|senior|duty|on call) )*(?:" + _FAC_WORDS + r")(?: (?:sir|maam|madam|in|here|now|please|over|also|too|to (?:join|come|see|the room|this room|have a look|help)|"
                         r"for help|on the line|on call|into the room|join|urgently|right away|immediately))* ")
# "senior", "consultant" and "attending" need a place to come to ("get the consultant to join us").
_SENIOR_INVITE = re.compile(r" " + _INVITE_EN + r" (?:in )?(?:(?:the|our|a|an|duty|on call) )*(?:senior(?: doctor| consultant| resident| faculty)?|consultant|attending|chief|boss)(?: (?:doctor|on call|on duty|sir|madam))? "
                            r"(?:to (?:join|come|see|step in|have a look|look|help|weigh in)|in|here|over|on the line|on call|now|please|right away|immediately|into the room)\b")
_SENIOR_NATIVE = T("senior;senior doctor;consultant;attending;सीनियर*;कंसल्टेंट*;वरिष्ठ*;ಸೀನಿಯರ್*;ಕನ್ಸಲ್ಟೆಂಟ್*;சீனியர்*;கன்சல்டன்ட்*;సీనియర్*;కన్సల్టెంట్*;সিনিয়র*;কনসালট্যান্ট*")
_FAC_WANTED = re.compile(r" (?:" + _FAC_WORDS + r")(?: sir| madam)? (?:(?:is|are) (?:needed|required|wanted) |(?:needs?|must|should|has|have) (?:to )?(?:be here|come|see|look|review|check|examine|join|be called|be informed) )"
                         r"| (?:have|wait for|want) (?:the |our )?(?:" + _FAC_WORDS + r") (?:come|to come|to arrive|to join|arrive|step in|look|see|inside|here) ")
_FAC_INVITE_NATIVE = T("vara sollunga;varasollunga;vara sollu;rammanandi;rammani cheppandi;aste bolun;aste bolo;yayla sanga;bolavun ghya;बुलाना;बुलाना पड़ेगा;बुलाना है;अंदर बुला*;आने को बोलो;आने को कहो;aane ko bolo;bulana padega;bulana hai;வர சொல்லுங்க;கால் பண்ணி;வரச் சொல்லுங்க;கால் பண்ணுங்க;కాల్ చేయండి;ఫోన్ చేయండి;తీసుకురండి;లోపలికి పంపించండి;కాల్ చేయించండి;రమ్మనండి;"
                       "নিয়ে আসুন;আসতে বলুন;এখানে আসতে;ডাকা দরকার;ಕರೆತನ್ನಿ;ಕರ್ಕೊಂಡು ಬನ್ನಿ;ಬರಲು ಹೇಳಿ;ಬರೋಕೆ ಹೇಳಿ;karetanni;barokke heli;barakke heli;yayla sanga;यायला सांगा;बोलवायला;bulao;bulaiye;bula lo;bula do;bulalo;bulwao;call karo;call kar do;invite karo;invite kar do;add karo;join karao;jodo;बुलाओ;बुलाइए;बुला लो;बुला दो;बुलवाओ;कॉल करो;इनवाइट करो;"
                       "bolva;bolava;bolvun ghya;बोलवा;बोलावा;बोलवून घ्या;kareyiri;karisi;kareesi;kariri;invite maadi;call maadi;ಕರೆಯಿರಿ;ಕರೀರಿ;ಕರೆಸಿ;ಕರೆಯಿರಿ;ಇನ್ವೈಟ್ ಮಾಡಿ;"
                       "koopidunga;kupidunga;invite pannunga;call pannunga;கூப்பிடுங்க;அழைங்க;அழையுங்கள்;இன்வைட் பண்ணுங்க;pilavandi;pilipinchandi;invite cheyandi;call cheyandi;పిలవండి;పిలిపించండి;ఇన్వైట్ చేయండి;"
                       "dakun;daken;deke din;invite korun;call korun;ডাকুন;ডেকে দিন;ডাকো;ইনভাইট করুন")
_SIR_INVITE = T("call sir;invite sir;get sir;bring sir in;call maam in;sir ko bulao;sir ko bulaiye;sir ko call karo;सर को बुलाओ;सर को बुलाइए;सर को बुला दो;सरांना बोलवा;ಸರ್ ಅನ್ನು ಕರೆಯಿರಿ;ಸರ್ ಕರೆಯಿರಿ;சாரை கூப்பிடுங்க;సార్ ని పిలవండి;స్যারকে ডাকুন;স্যার কে ডাকুন;স্যারকে ডাকুন")

_OBS_PURPOSE = (r"(?:to )?(?:come |please )*(?:and )?(?:observe|watch|join|sit in|listen|listen in|see (?:this|it|me|how)|have a look|dial in|hop on)\b|as (?:an )?observer|on (?:the )?(?:line|call)|in (?:for|on) this|"
                r"for (?:this|the) (?:session|consultation|consult|case)|into (?:the )?(?:session|call|consultation)|in here to (?:observe|watch)")
_NOT_A_NAME = set((
    "you your me us him her them the a an my our someone somebody back it this that lab security code ambulance doctor surgeon surgery radiology radiologist pharmacy pharmacist nurse sister asha aasha "
    "faculty professor prof consultant attending imaging laboratory patient i we she he they what who how where when why meera mira vikram dev husband wife mother father son daughter "
    "family anyone everyone people more some any no not to for in on up out off all both everything something nothing pain chest dizzy fever cough water food rest help "
    "test tests blood report reports result results child baby parents staff team oxygen drip and or with if is are was were do does did have has had get got "
    "breakfast lunch dinner tv sure ready started going there here one two three them these those time times new next old same").split())
_OBS_NAME = r"(?P<name>[a-z][a-z]+(?: (?!to\b|as\b|for\b|in\b|into\b|on\b|please\b|now\b|too\b|and\b|join\b|observe\b|watch\b|also\b|over\b)[a-z][a-z]+)?)"
_OBS_LEAD = r"^ (?:(?:nurse|sister|asha|aasha|please|can someone|could someone|can somebody|could somebody|someone|somebody|can you|could you|would you|will you|i want|id like|i would like|lets|let us) )*"
_OBS_INVITE = re.compile(_OBS_LEAD + r"(?:invite|loop in) (?:my (?:teacher|senior|friend|classmate|batchmate|mentor) )?" + _OBS_NAME + r"(?: (?:as|to|for|into|in|please|now|too|also)\b.*)? $")
_OBS_PURPOSED = re.compile(_OBS_LEAD + r"(?:(?:ask|call|ring|phone|get|have|bring|add|want) )?(?:(?:my|our) (?:teacher|senior|friend|classmate|batchmate|mentor) )?" + _OBS_NAME + r" (?:please )?(?:" + _OBS_PURPOSE + r")")
_OBS_NAME_FIRST = re.compile(r"^ " + _OBS_NAME + r" (?:should|can|could|must|needs? to|has to|will) (?:please )?(?:come and )?(?:observe|watch|join|sit in|listen|see this|see me)\b(?!.*\b(?:you|your)\b)")
_OBS_RELATION = re.compile(_OBS_LEAD + r"(?:call|ring|phone|invite|ask|get|add|bring|loop in) (?:my|our) (?:teacher|senior|friend|classmate|batchmate|mentor|sir|madam|professor)(?: (?:in|now|please|too))?(?: (?:" + _OBS_PURPOSE + r").*)? $")
_OBS_NATIVE = T("observe karne ke liye bulao;observe karne bulao;dekhne ke liye bulao;ko observe karne;ko invite karo;ko invite kar do;ko observer banao;observer add karo;ko join karao;को इनवाइट करो;को ऑब्जर्व करने;"
                "ला इनवाइट करा;invite kara;avarannu invite maadi;ge invite maadi;invite maadi observe;ಇನ್ವೈಟ್ ಮಾಡಿ;ஐ இன்வைட் பண்ணுங்க;invite pannunga;invite cheyandi;ke invite korun;কে ইনভাইট করুন")

# -------- examination

_EXAM_PART_EN = T(
    "vitals;vital signs;blood pressure;bp;pulse;heart rate;temperature;temp;sats;saturation;spo2;oxygen level;heart;cardiac;apex beat;apex;precordium;heart sounds;murmur;jvp;"
    "pelvic;uterus;breast;breasts;lung;lungs;chest;breath sounds;air entry;breathing;abdomen;abdominal;tummy;belly;stomach;liver;spleen;eye;eyes;pupil;pupils;vision;fundus;"
    "throat;tonsils;ear;ears;nose;mouth;tongue;sinuses;skin;rash;lesion;lesions;spots;mole;reflex;reflexes;nervous system;cranial nerves;power;sensation;coordination;gait;tone;"
    "joint;joints;knee;knees;back;spine;hip;hips;shoulder;shoulders;ankle;ankles;wrist;elbow;neck;leg;legs;arm;arms;growth;milestones;fontanelle;hydration;pallor;icterus;jaundice;"
    "cyanosis;clubbing;lymph nodes;oedema;edema;hands;nails;hand;foot;feet;swelling;wound;pet;chhati;chaati;seena;dil;gala;gale;kaan;naak;aankh;aankhen;nabz;nadi;kamar;ghutna;ghutne"
)
_EXAM_VERB_EN = re.compile(
    r" (?:examine|examining|examination|exam|auscultate|auscultation|palpate|palpation|percuss|inspect|listen(?:ing)? (?:to|in|at|over)|(?:have|take) a (?:quick )?(?:listen|look|feel)|quick (?:look|listen|check|feel)|"
    r"feel(?:ing)? (?:for|the|your|his|her|their)|press(?:ing)? (?:on|your|the|gently)|check(?:ing)?|look(?:ing)? (?:at|in|into|over)|let me (?:feel|hear|see|look|check|listen|examine|press|test)|"
    r"test (?:your|the|his|her)|shine a|(?:take|measure|record|note)(?: (?:a|an|the|your|his|her|their))*(?= (?:bp|blood pressure|pulse|temperature|temp|sats|vitals?|vital signs|spo2)\b)) ")
_EXAM_GENERAL = re.compile(r" (?:general|systemic|full|physical|complete) exam(?:ination)? ")
_EXAM_HING = T("dekho;dekhna;dekhta;dekhti;dekhte;dekhenge;dekhunga;dekhungi;dekhiye;dekh lo;dekh lu;dekh loon;dekhne do;sunta;sunti;sunna;sunne do;sunenge;sununga;sunungi;check karo;check kar lo;check kariye;check karta;check karti;"
               "check karte;check kar do;check karenge;chek karo;lena;lo;le lo;naapo;napo;naap lo;naapna;napna;dabao;dabana;daba kar;dabake;dabaunga;jaanch karo;jaanch karte;jaanch karta;janch karte;janch karo")
_EXAM_NATIVE_PART = T(
    "नब्ज;नाड़ी;बीपी;ब्लड प्रेशर;तापमान;दिल;हृदय;धड़कन;छाती;फेफड़े;फेफड़ों;सांस;पेट;लिवर;जिगर;तिल्ली;आंख;आंखें;आंखों;पुतली;गला;गले;कान;नाक;मुंह;जीभ;त्वचा;चमड़ी;दाने;रिफ्लेक्स;घुटना;घुटने;कमर;पीठ;कंधा;कंधे;"
    "नाडी;पोट;पोटाची;पोटाचा;छातीची;डोळे;डोळ्यांची;घसा;घशाची;त्वचेची;गुडघा;"
    "ನಾಡಿ;ಬಿಪಿ;ರಕ್ತದೊತ್ತಡ;ತಾಪಮಾನ;ಹೃದಯ*;ಎದೆ*;ಶ್ವಾಸಕೋಶ*;ಹೊಟ್ಟೆ*;ಲಿವರ್;ಕಣ್ಣು;ಕಣ್ಣಿನ;ಕಣ್ಣನ್ನು;ಗಂಟಲು;ಕಿವಿ;ಮೂಗು;ಬಾಯಿ;ನಾಲಿಗೆ;ಚರ್ಮ;ಮಂಡಿ;ಬೆನ್ನು;ಭುಜ;"
    "நாடி;பிபி;நெஞ்சு;நெஞ்சை;நெஞ்ச;மார்பு;இதயம்;இதயத்தை;வயிறு;வயித்த;வயிற்றை;கண்;கண்ணை;தொண்டை;தொண்டையை;காது;மூக்கு;நாக்கு;தோல்;முட்டி;முதுகு;"
    "నాడి;బీపీ;ఛాతీ;ఛాతి;గుండె;పొట్ట;కడుపు;కళ్ళు;కళ్లు;గొంతు;చెవి;ముక్కు;నాలుక;చర్మం;మోకాలు;వీపు;"
    "নাড়ি;বিপি;প্রেসার;প্রেশার;ব্লাড প্রেসার;বুক;বুকটা;পেট;পেটটা;হৃদয়;চোখ;গলা;কান;নাক;জিভ;ত্বক;হাঁটু;পিঠ;bp;pulse"
)
_EXAM_NATIVE_VERB = T(
    "जांच;जांच करता;देखता;देखती;देखते;देखूं;देखूंगा;देखूंगी;देखने दीजिए;देखने दो;देख लूं;देख लेता;देख लेती;देखो;देख लो;सुनता;सुनती;सुनूं;सुनूंगा;सुनूंगी;सुनने दीजिए;सुनने दो;दबाकर;दबा कर;दबाता;दबाऊंगा;चेक करो;चेक कर लो;चेक करता;चेक करती;चेक करते;चेक करूं;चेक करूंगा;चेक करने दीजिए;"
    "चेक कीजिए;चेक करिए;नापो;नाप लो;नापिए;परीक्षण;टटोल*;मुआयना;एग्जाम;तपासतो;तपासते;तपासू;तपासा;तपासून;तपासणी;बघतो;बघते;बघू;बघा;चेक करतो;चेक करते;चेक करा;मोजा;ऐकतो;ऐकते;"
    "ಪರೀಕ್ಷೆ;ಪರೀಕ್ಷಿಸ*;ಪರೀಕ್ಷೆ ಮಾಡ*;ಚೆಕ್ ಮಾಡ*;ನೋಡ್ತೀನಿ;ನೋಡ್ತೇನೆ;ನೋಡುತ್ತೇನೆ;ನೋಡಲಾ;ನೋಡೋಣ;ನೋಡಿ;ನೋಡ್ಬೇಕು;ಕೇಳಿಸಿಕೊ*;ಆಲಿಸ*;ಒತ್ತ*;ತಪಾಸಣೆ;"
    "பரிசோதி*;பரிசோதனை பண்ண*;செக் பண்ண*;பார்க்கிறேன்;பாக்குறேன்;பார்க்கறேன்;பாக்கறேன்;பார்க்கணும்;பாக்கணும்;பாருங்க;கேட்கிறேன்;கேக்குறேன்;அழுத்தி;"
    "పరీక్షిస్తాను;పరీక్ష చేస్తాను;పరీక్షించండి;చెక్ చేస్తాను;చెక్ చేయండి;చూస్తాను;చూడండి;చూడాలి;వింటాను;నొక్కి;"
    "পরীক্ষা করি;পরীক্ষা করব;পরীক্ষা করছি;পরীক্ষা করুন;চেক করি;চেক করব;চেক করুন;দেখছি;দেখব;দেখি;দেখুন;মাপুন;মেপে নিন;শুনছি;শুনব;টিপে;"
    "nodtini;nodteeni;nodi;check maadi;check madi;check maadtini;pakkuren;paakren;paarunga;check pannunga;chustanu;chudandi;check cheyandi;tapasto;tapasa;bagha;mapun;dekhun;dekhchi"
)
_EXAM_BLOCK = T(
    "xray;cxr;ecg;ekg;echo;echocardiogram;ultrasound;usg;scan;ct;mri;cbc;fbc;blood test;blood sugar;blood work;bloods;lab;labs;urine;culture;swab;troponin;report;reports;result;results;tablet;tablets;mg;prescribe;order;sugar;"
    "एक्स रे;एक्सरे;अल्ट्रासाउंड;ईसीजी;रिपोर्ट;खून;टेस्ट;रक्त;ಎಕ್ಸ್ ರೇ;ಸ್ಕ್ಯಾನ್;ರಿಪೋರ್ಟ್;ರಕ್ತ;ಟೆಸ್ಟ್;ஸ்கேன்;எக்ஸ்ரே;டெஸ்ட்;ரத்த;ఎక్స్ రే;స్కాన్;టెస్ట్;రక్త;স্ক্যান;এক্স রে*;টেস্ট;রক্ত;with the;with pharmacy;with pharmacist;with lab;with radiology")
_EXAM_HISTORY = re.compile(r"^ (?:do|does|did|have|has|had|is|are|was|were|when|how|where|why|any|which|what) (?:.* )?(?:you|your|she|he|her|his|it|they) ")
_FEEL_Q = T("can you feel;do you feel;you feel;are you feeling;feel dizzy;feel tired;feel weak;feel any;how do you feel")
_HOME = T("at home;ghar pe;ghar par;ghar mein;घर पर;घर में;घरी;ಮನೆಯಲ್ಲಿ;ಮನೇಲಿ;வீட்டுல;வீட்டில்;ఇంట్లో;বাড়িতে")

# -------- delegation and department questions

_ASK = re.compile(r" (?P<verb>ask|tell|inform|request|message|get|call|check with|page|let|have|bring|add|invite|loop in|ring|phone|update|alert|consult|talk to|speak to|send (?:it|this|that|the sample|the samples|the blood|blood|samples?) to|connect me to|put me through to) "
                  r"(?:(?:the|our|a|that|this|duty|on call|doctor|dr) )*(?P<title>[^ ]+(?: (?:nurse|officer|technician|tech|department))?) ")
_PATIENT_ABOUT_STAFF = re.compile(r" (?:did|have|has|is|was|were|are|does|do|will|would|should|if|when|may|might|before|after) ")
_GO_TO = T("go to;from the;from;at the;to the counter;show this;show it;show the;buy;collect it from;nearby;near your;outside;downstairs;take this;take it")
_REPLY_DEPT_Q = re.compile(r" (?:what (?:does|did|do|has|is)|whats|has|is|are|when will|did|any (?:news|word|update) from|how long will) (?:the |our )?")
_RESULT_Q = re.compile(r"^ (?:(?:is|are|has|have|did) (?:the |her |his |those |my )?(?:\w+ ){0,3}?(?:results?|reports?|cbc|ecg|xray|scan|ct|mri|lft|troponin|bloods?|labs?|creatinine|potassium|ultrasound) (?:\w+ ){0,2}?(?:back|ready|come|in|done|available|out|normal|abnormal|yet|arrived|uploaded)"
                       r"|any (?:results?|reports?) (?:yet|back)|what (?:is|was|are|were) (?:the |her |his )(?:\w+ )?(?:results?|reports?|cbc|ecg|creatinine|potassium|troponin|hb|haemoglobin|hemoglobin|egfr)|whats (?:the |her |his )(?:\w+ )?(?:results?|reports?|cbc|ecg|creatinine|potassium|troponin|hb|hemoglobin|egfr)) ")
_NATIVE_TELL = T("ko bolo;ko bol do;ko boliye;ko kaho;ko keh do;ko bata do;ko batao;se kaho;se bolo;ko pucho;se pucho;se poocho;se puchho;se puchiye;को बोलो;को बोल दो;को बोलिए;को कहो;को कह दो;को बता दो;से कहो;से बोलो;से पूछो;से पूछिए;को बताओ;"
                 "ला सांगा;ना सांगा;ला विचारा;ge heli;gey heli;*ge heli;hatra keli;ge keli;*ge keli;*ಗೆ ಹೇಳಿ;ಹತ್ರ ಕೇಳಿ;*ಗೆ ಕೇಳಿ;ಹತ್ರ ಹೇಳಿ;kitta sollunga;kitta kelunga;*கிட்ட சொல்லுங்க;*கிட்ட கேளுங்க;ki cheppandi;*ki cheppandi;ni adagandi;*ni adagandi;*కి చెప్పండి;*ని అడగండి;*తో చెప్పండి;ke bolun;*ke bolun;ke jigges korun;*কে বলুন;*কে বলো;*কে জিজ্ঞেস করুন;*ला सांगा;*ना सांगा;*ला विचारा;*ना विचारा")
_ASK_VERB_NATIVE = T("pucho;poocho;puchho;puchiye;पूछो;पूछिए;विचारा;keli;kelunga;adagandi;jigges korun;ಕೇಳಿ;கேளுங்க;అడగండి;জিজ্ঞেস করুন;জিজ্ঞাসা করুন")

_YESNO = T("yes;yeah;yep;no;nope;not;none;sure;okay;ok;go ahead;correct;right;agreed;agree;negative;positive;normal;dont know;not sure;unknown;confirm;confirmed;approved;fine;"
           "haan;han;nahi;nahin;na;theek hai;thik hai;sahi;pata nahi;ji;kar do;de do;हां;नहीं;ठीक है;पता नहीं;जी;हाँ;हो;नाही;माहित नाही;ಹೌದು;ಇಲ್ಲ;ಸರಿ;ಗೊತ್ತಿಲ್ಲ;houdu;illa;gottilla;"
           "ஆமா;ஆமாம்;இல்ல;இல்லை;சரி;தெரியல;aama;illa;theriyala;అవును;లేదు;కాదు;సరే;తెలియదు;avunu;ledu;kaadu;হ্যাঁ;না;ঠিক আছে;জানি না;hya;jani na")
_REASON = T("because;since it;the reason;i think;in my opinion;my diagnosis;the patient;this patient;she has;he has;she is;he is;her;his;risk;benefit;allergy;reaction;mild;severe;creatinine;only a rash;contraindicated;"
            "kyunki;क्योंकि;मरीज;कारण;ಯಾಕಂದ್ರೆ;ಯಾಕೆಂದರೆ;ರೋಗಿ*;ஏன்னா;நோயாளி*;ఎందుకంటే;రోగి*;কারণ;রোগী*;रुग्ण*")


# ---------------------------------------------------------------- context


def _ctx(context: Any) -> dict[str, Any]:
    c = context if isinstance(context, dict) else {}
    pend = c.get("pendingQuestion")
    role = str((pend or {}).get("role") or "") if isinstance(pend, dict) else ""
    return {
        # relatives named in the case count too: their names are not staff vocatives either
        "patientName": " ".join([str(c.get("patientName") or "")[:80], *(str(n)[:40] for n in (c.get("relatedNames") or [])[:6])]).strip(),
        "pendingRole": role if role in STAFF_ROLES or role == "examiner" else "",
        "awaitingFaculty": bool(c.get("awaitingFaculty")),
        "observers": tuple(sorted(_fold(str(n)).strip() for n in (c.get("observerNames") or []) if str(n).strip())[:40]),
    }


_NAME_SETS = {r: {_fold(n.strip()) for n in d["name"].split(";") if n.strip()} for r, d in _ROLE_TITLES.items()}


def _patient_shares_name(role: str, patient_name: str) -> bool:
    toks = set(plain(normalise(patient_name)).split())
    return bool(toks & _NAME_SETS[role])


# ---------------------------------------------------------------- features of one clause


def _clinical(t: str) -> bool:
    return has(TEST_RX, t) or has(PROC_RX, t) or _drug(t)


def _strip_polite(t: str) -> str:
    return _POLITE_YOU.sub("", t).replace("  ", " ")


def _has_you(t: str) -> bool:
    return has(YOU_RX, " " + _strip_polite(t).strip() + " ")


def _is_question(p: str, t: str) -> bool:
    body = _LEAD.sub(" ", t)
    if _WE_Q.match(body):
        return False
    if " ? " in p:
        return not has(_POLITE_YOU, t) or has(T_QWORD, t)
    return bool(_Q_START.match(body)) and not re.match(r"^ (?:can|could|would|will) you ", body) or has(T_QWORD, t)


# Question words that cannot be anything else (Roman "ki", "do", "is" are too short to trust).
T_QWORD = T(
    "how long;how many;how much;how often;how is;how are;how does;how do;what;whats;when;where;why;which;since when;"
    "kab;kab se;kahan;kitna;kitne;kitni;kaise;kaisa;kaisi;kyun;kyon;kaun;kaunsa;kya;hai kya;"
    "yavaga;yaavaga;eshtu;yestu;enu;yenu;elli;hege;yake;ideya;idya;idyaa;eppo;evlo;enna;enga;epdi;eppadi;irukka;iruka;eppudu;enni;entha;emi;ekkada;enduku;ela;undha;undaa;unda;"
    "kadhi;kiti;kuthe;kashi;konti;kobe;kokhon;koto;kothay;keno;kemon;"
    "क्या;कब;कहां;कितना;कितने;कितनी;कैसे;कैसा;कैसी;क्यों;कौन;कौनसी;किस;काय;कधी;किती;कुठे;कसा;कशी;कसे;कोण;कोणती;कोणता;आहे का;होतं का;"
    "ಯಾವಾಗ;ಯಾವಾಗಿಂದ;ಎಷ್ಟು;ಏನು;ಎಲ್ಲಿ;ಹೇಗೆ;ಯಾಕೆ;ಯಾವ;ಯಾರು;ಇದೆಯಾ;ಇದ್ಯಾ;ಇದೆಯೇ;ಆಗ್ತಿದೆಯಾ;"
    "எப்போ;எப்போது;எவ்வளவு;என்ன;எங்க;எங்கே;எப்படி;ஏன்;யார்;எத்தனை;இருக்கா;இருக்குதா;வருதா;"
    "ఎప్పుడు;ఎన్ని;ఎంత;ఏమి;ఏం;ఏమిటి;ఎక్కడ;ఎందుకు;ఎలా;ఎవరు;ఉందా;ఉన్నాయా;"
    "কী;কবে;কখন;কত;কোথায়;কেন;কেমন;কতদিন;আছে কি;হয় কি;কি"
)


def _patient_question(p: str, t: str) -> bool:
    """History talk or a question to the person in front of the doctor."""
    if _has_you(t):
        return True
    return has(HISTORY_RX, t) or (has(SYMPTOM_RX, t) and _is_question(p, t))


def _clauses(p: str) -> list[str]:
    parts = re.split(r" [?.,](?= )", p)
    return [f" {' '.join(x.split())} " for x in parts if x.strip()]


_CONJ = re.compile(r" (?:so|and then|then|but|and also|also) ")


def _clause_order(c: str, vocative: bool) -> Optional[str]:
    """'order', 'self' (the doctor says what they will do) or 'maybe' for one English clause."""
    body = _LEAD.sub(" ", c)
    if _Q_START.match(body) and not _WE_Q.match(body) and not re.match(r"^ (?:can|could|would|will) (?:you|we|someone|somebody|anyone) ", body) and not re.match(r"^ do (?!you|they|the|your|we|i )", body):
        return None
    m = _ORDER_HEAD.match(body)
    if m:
        verb = m.group("verb")
        rest = " " + " ".join(body[m.end():].split()[:6]) + " "
        near = " " + " ".join(body[m.end():].split()[:5]) + " "
        you = _has_you(body)
        self_ = bool(_SELF.search(" " + m.group("chain")))
        sym = SYMPTOM_RX.search(near)
        clin = TEST_RX.search(near) or DRUG_RX.search(near) or PROC_RX.search(near)
        hit = bool(clin) or any(_drug_token(x) for x in near.split())
        if sym and clin and sym.start() < clin.start():
            hit = False
        if not hit and has(GENERIC_RX, near) and (verb not in _WEAK_VERBS or has(_THIRD, near)) and not sym:
            hit = True
        if not hit and verb in _FREE_VERBS and has(_FREE_OBJ, rest):
            hit = True
        if not hit and verb in ("start", "give", "send", "book", "repeat", "put") and has(T("him;her;them;the patient;this patient"), near) and not has(SYMPTOM_RX, near) and vocative:
            hit = True
        if not hit and vocative and verb in ("get", "give", "send", "start", "do", "arrange", "bring", "fetch", "put", "check", "add", "order"):
            hit = not you
        if not hit and has(_FREE_OBJ, near) and verb in ("get", "arrange", "request") and has(T("followup;referral;consult;admission;appointment"), near):
            hit = True
        if hit:
            if has(_TO_PATIENT, body) and not vocative:
                return None
            if you and not vocative:
                return "maybe" if clin and verb in ("get", "order", "do", "run", "start", "repeat", "take") and has(T("get you;do you;start you;run"), body) else None
            return "self" if self_ and not vocative else "order"
    m = _WANT.match(body)
    if m and not _has_you(body):
        near = " " + " ".join(body[m.end():].split()[:7]) + " "
        if (_clinical(near) or has(T("tablets;tablet;medicine;sugar"), near)) and not re.match(r"^ to (?:know|ask|understand|see|hear|talk|explain|tell)", near):
            return "order"
    if has(_ORDER_PHRASE, body) and not _has_you(body) and not _is_question(c, c):
        return "order"
    m = re.search(r" (?:is|are|will be) (?:needed|required|indicated|to be (?:done|sent|given|started)) ", body)
    if m and _clinical(body[: m.start() + 1]) and not _has_you(body) and not _is_question(c, c):
        return "order"
    return None


_NP_FILL = set(("and or plus also a an the with please stat urgent urgently now test tests panel chest head brain abdomen pelvis spine knee routine repeat for him her "
                "patient one two three four five six seven eight ten hundred thousand fifty point half mg ml mcg gram grams units tablet tablets tab capsule od bd tds qid sos hs "
                "once twice thrice times daily hourly day days a week weeks iv im oral orally orally stat contrast plain non non-contrast of level levels profile function lead twelve "
                "ek aur bhi jaldi turant do ondu mattu oru oka mariyu ani ekta aar ar ebong abhi "
                "एक और भी जल्दी तुरंत आणि ಒಂದು ಮತ್ತು ஒரு மற்றும் ఒక మరియు একটা আর এবং").split())


def _noun_phrase_order(p: str, t: str) -> bool:
    """'CBC and LFT', 'chest x-ray please', 'paracetamol 650 TDS': nothing but clinical words."""
    body = _LEAD.sub(" ", t)
    toks = body.split()
    if not toks or len(toks) > 12 or " ? " in p:
        return False
    left = " " + " ".join(TEST_RX.sub("", DRUG_RX.sub("", PROC_RX.sub("", body.replace(" ", "  ")))).split()) + " "
    rest = [x for x in left.split() if not _drug_token(x)]
    if any(x not in _NP_FILL and not x.isdigit() for x in rest):
        return False
    if has(TEST_RX, body) and not (len(toks) == 1 and not toks[0].isascii()):
        return True
    return (_drug(body) or has(PROC_RX, body)) and len(toks) >= 2


def _dose_order(t: str) -> bool:
    return (_drug(t) and has(T("tds;bd;od;qid;sos;hs;twice a day;thrice a day;once a day;three times a day;two times a day;twice daily;once daily;times a day;for five days;for three days;for seven days;stat"), t)
            and not _has_you(t) and not re.search(r" (?:take|taking|took|taken|takes) ", t))


def _native_order(p: str, t: str, vocative: bool) -> Optional[str]:
    """Order verbs of the six Indian languages, in either script."""
    body = t
    if _NATIVE_FUTURE.search(body) and not vocative:
        return None
    verb = _NATIVE_ORDER.search(body)
    v_ok = False
    if verb:
        v_ok = verb.group(0) != "din" or not has(_BN_DIN_DAY, body)
        if verb.group(0) == "din" and not body.rstrip().endswith(" din"):
            v_ok = False
    if not v_ok and body.rstrip().endswith(" দিন") and not has(_BN_DIN_DAY, body):
        v_ok = True
    if not v_ok and re.search(r" (?:दो|do) $", body):
        prev = body.split()[-2:-1]
        pv = f" {prev[0]} " if prev else " "
        v_ok = _clinical(pv) or (has(GENERIC_RX, pv) and vocative)
    need = not v_ok and has(_NATIVE_NEED, body)
    if not v_ok and not need:
        return None
    strong = _clinical(body)
    if vocative:
        return "order"
    if has(_TO_PATIENT, body) or has(_HOME, body) or has(_THIRD_VERB, body) or has(_REPORT, body):
        return None
    if need and has(T("ya;या;ಅಥವಾ;அல்லது;లేదా;किंवा;না কি;নাকি"), body):
        return None
    if _is_question(p, t) and not has(_POLITE_YOU, t):
        return None
    if has(_NATIVE_PATIENT_VERB, body):
        return None
    if has(YOU_RX, body):
        return "maybe" if strong and v_ok else None
    if strong:
        return "order"
    if v_ok and has(GENERIC_RX, body) and not has(SYMPTOM_RX, body):
        return "order"
    return None


def _order(p: str, t: str, vocative: bool = False) -> Optional[str]:
    """order | self | maybe | None for a whole utterance."""
    body = _LEAD.sub(" ", t)
    if not vocative and has(T("tell me;talk to me;explain to me"), t):
        return None
    best: Optional[str] = None
    clauses = _clauses(p)
    if len(clauses) != 1 or " ? " not in p:
        if not (_is_question(p, t) and len(clauses) == 1):
            clauses = [x for c in clauses for x in ([c] + [f" {s.strip()} " for s in _CONJ.split(c)[1:] if s.strip()])]
    for c in clauses:
        r = _clause_order(c, vocative)
        if r == "order":
            return "order"
        best = best or r
    # An unpunctuated lead-in ("chest pain and sweating order an ecg").
    m = re.search(r" (?:please|lets|can you|could you|kindly) (?=(?:order|get|send|run|do|give|start|arrange|repeat|check|prescribe) )", t)
    if not best and m and m.start() > 0 and not _is_question(p, t):
        best = _clause_order(t[m.start():], vocative)
    n = _native_order(p, t, vocative)
    if n == "order":
        return "order"
    best = best or n
    if best:
        return best
    if _noun_phrase_order(p, t) or (_dose_order(t) and not _is_question(p, t)):
        return "order"
    if vocative and (_clinical(body) or has(GENERIC_RX, body)) and not _is_question(p, t):
        return "order"
    return None


T_WHY = T("why;kyun;kyon;yaake;yake;yen;enduku;keno;क्यों;का थांबवल*;ಯಾಕೆ;ஏன்;ఎందుకు;কেন")


def _stop(p: str, t: str, vocative: bool = False) -> bool:
    body = _LEAD.sub(" ", t)
    if vocative and (re.match(r"^ (?:why|when|did|have|has|was|were|who|how|what) ", body) or has(T_WHY, t)):
        return False  # "why did you hold it"
    if has(_NATIVE_CANCEL, t) and not has(YOU_RX, t):
        return True
    m = _STOP_EN.search(t)
    if m and (vocative or not _is_question(p, t)):
        rest = " " + " ".join(t[m.end() - 1:].split()[:6]) + " "
        verb = m.group(0).split()[0]
        if not re.match(r" (?:taking|smoking|drinking|eating|using) ", rest) and not (_has_you(t) and not vocative):
            if _clinical(rest) or (has(T("drip;infusion;order;orders"), rest)):
                return not has(_HOME, t)
            first = rest.strip()
            if has(_STOP_OBJ, rest) and (verb in ("cancel", "scrap", "undo", "withdraw", "abort") or vocative or re.match(r"(?:that|this|the) order|all orders", first)):
                return True
            if verb in ("dont", "do", "no") and re.match(r"(?:it|that|this)\b", first) and m.group(0).split()[-1] not in ("do",):
                return True
            if vocative and (verb in ("stop", "cancel", "hold", "dont", "do")) and not first:
                return True
    if has(_NATIVE_STOP, t) and not has(_DONT_WORRY, t):
        if vocative:
            return True
        return _clinical(t) and not _has_you(t) and not _is_question(p, t) and not has(SYMPTOM_RX, t) and not has(_NATIVE_PATIENT_VERB, t) and not has(_REPORT, t)
    return False


def _exam(p: str, t: str, vocative: bool = False) -> bool:
    if has(_EXAM_BLOCK, t) or has(_HOME, t) or has(_FEEL_Q, t) or has(_THIRD_VERB, t):
        return False
    body = _LEAD.sub(" ", t)
    if _EXAM_HISTORY.match(body) and not re.match(r"^ (?:can|could|may) i ", body):
        return False
    if _EXAM_GENERAL.search(t):
        return not (has(T("had;have you;did you"), t))
    m = _EXAM_VERB_EN.search(t)
    if m and has(_EXAM_PART_EN, " " + t[m.end() - 1:].strip() + " ") and not re.search(r" (?:you (?:check|look|examine)|if you|when you|you should|you can|you need|youll) ", t):
        return True
    if vocative and has(T("take;record;measure;check"), t) and has(T("vitals;vital signs;bp;blood pressure;pulse;temperature;temp;sats;spo2"), t):
        return True
    q = _is_question(p, t)
    if not q and has(_EXAM_HING, t) and has(_EXAM_PART_EN, t) and not has(SYMPTOM_RX, t):
        return not has(T("dawa;goli;medicine;tablet"), t)
    if not q and has(_EXAM_NATIVE_VERB, t) and (has(_EXAM_NATIVE_PART, t) or has(_EXAM_PART_EN, t)) and not (has(SYMPTOM_RX, t)):
        return True
    return False


def _hint(p: str, t: str) -> bool:
    body = _LEAD.sub(" ", t)
    if _HINT_WHOLE.match(body) or _HINT_WHOLE.match(t):
        return True
    if not has(_HINT, t) or _has_you(t):
        return False
    if _order(p, t) == "order":
        return False
    return not _patient_question_strict(t)


def _patient_question_strict(t: str) -> bool:
    return has(T("help me understand;tell me about;you feel;your pain;your symptoms;your problem;do you have;have you;where does it;when it started;when did"), t)


# ---------------------------------------------------------------- vocatives


@dataclass(frozen=True)
class _Voc:
    role: str
    strength: str  # strong | name | weak
    title: str
    rest: str      # normalised text (with marks) after/before the vocative
    comma: bool
    where: str     # lead | mid | tail
    before: str = ""


def _title_at(words: list[str], i: int, names_off: set[str]) -> Optional[tuple[str, str, str, int]]:
    """(role, strength, title, n tokens) for a staff title starting at words[i]."""
    if i < len(words) - 1 and words[i] in ("dr", "doctor", "डॉक्टर"):
        hit = _title_at(words, i + 1, names_off)
        return (*hit[:3], hit[3] + 1) if hit and hit[1] == "name" else None
    for n in (3, 2, 1):
        if i + n > len(words):
            continue
        phrase = f" {' '.join(words[i:i + n])} "
        for role, kinds in _VOC.items():
            for strength in ("strong", "weak", "name"):
                rx = kinds.get(strength)
                if rx is None or (strength == "name" and role in names_off):
                    continue
                m = rx.search(phrase)
                if m and m.group(0) == phrase.strip():
                    return role, strength, phrase.strip(), n
    return None


_HON_RX = re.compile(r"^(?:" + _HON + r")$")


def _skip_honorific(words: list[str], i: int, role: str) -> int:
    while i < len(words) and _HON_RX.match(words[i]):
        i += 1
    return i


_AUX = frozenset("is are was were does did do has have had can could should would will may shall".split())
_SUBJECT = frozenset("it this that these those she he they there we i you any her his".split())
_STATE = frozenset("been yet ready okay ok safe done back right correct enough high low fine normal finished available sent lifted cleared".split())
_DET = frozenset("the a an her his this that these those any our my".split())


def _asked_next(words: list[str], i: int) -> bool:
    """words[i:] opens a question ("is ibuprofen safe", "did the sample reach", "can you"),
    so the name before it is being spoken to. "Meera is my sister" is not one."""
    if i + 1 >= len(words) or words[i] not in _AUX:
        return False
    nxt = words[i + 1]
    if nxt in _SUBJECT or _clinical(f" {nxt} ") or has(_DEPT_TOPIC, f" {nxt} "):
        return True
    if nxt not in _DET:
        return False
    if words[i] in ("did", "does", "do", "should", "can", "could", "would", "may", "shall"):
        return True
    near = f" {' '.join(words[i + 2:i + 5])} "
    return _clinical(near) or has(_DEPT_TOPIC, near) or bool(_STATE.intersection(words[i + 2:]))


def _find_vocative(p: str, names_off: set[str]) -> Optional[_Voc]:
    """Staff title the doctor addresses: at the start, after a clause break, or at the end."""
    words = p.split()
    plain_words = [w for w in words if w not in "?.,"]
    if not plain_words:
        return None
    lead = _LEAD.match(plain(p))
    skip = len(lead.group(0).split()) if lead else 0
    # index of the first non-filler word in `words`
    idx, seen = 0, 0
    while idx < len(words) and (words[idx] in "?.," or seen < skip):
        if words[idx] not in "?.,":
            seen += 1
        idx += 1
    starts = [(idx, "lead")] + [(k + 1, "mid") for k, w in enumerate(words) if w in ("?", ".", ",") and k + 1 > idx]
    starts += [(k, "mid-bare") for k in range(idx + 1, len(words)) if words[k] not in "?.," and words[k - 1] not in "?.,"]
    for k, where in starts:
        j = k
        while where == "mid" and j < len(words) and (words[j] in "?.," or _is_filler(words[j])):
            j += 1
        hit = _title_at(words, j, names_off)
        if not hit:
            continue
        role, strength, title, n = hit
        end = _skip_honorific(words, j + n, role)
        nxt = words[end] if end < len(words) else ""
        comma = nxt == ","
        raw_next = f" {nxt} "
        asked = _asked_next(words, end)
        if nxt and nxt not in "?.," and not asked and (has(_MENTION_NEXT, raw_next) or (has(_COMPOUND_NEXT, raw_next) and strength == "weak" and role in ("lab", "pharmacist", "radiology"))):
            continue
        if has(_HOPE, f" {' '.join(words[j:j + 2])} ") and strength == "name":
            continue
        rest = " " + " ".join(words[end:]).lstrip(", ") + " "
        before = " " + " ".join(words[:j]) + " "
        if where == "mid-bare":
            prev = f" {words[j - 1]} "
            if has(_BEFORE_MENTION, prev) or strength == "weak" and title in ("staff", "imaging"):
                continue
            rt = plain(rest)
            if not rest.strip():
                continue  # tail case below
            if strength == "name" and role != "nurse" and has(_DEPT_TOPIC, plain(p)):
                return _Voc(role, strength, title, before + rest, False, "mid", "")
            if not (re.match(r"^ (?:please|can you|could you|kindly|order|get|send|run|give|start|arrange|check|do|repeat|stop|cancel|hold|take|prescribe|put|draw|call) ", rt)
                    or _noun_phrase_order(rest, rt) or (_native_order(rest, rt, False) and strength != "weak")):
                continue
            return _Voc(role, strength, title, rest, False, "mid", before)
        return _Voc(role, strength, title, rest, comma, where, before)
    # tail: "send a CBC please nurse", "how am I doing Asha"
    last = len(words)
    while last and words[last - 1] in "?.,":
        last -= 1
    while last and _HON_RX.match(words[last - 1]) and words[last - 1] not in ("asha", "aasha", "meera", "mira", "dev", "vikram"):
        last -= 1
    for n in (2, 1):
        j = last - n
        if j <= 0:
            continue
        hit = _title_at(words[:last], j, names_off)
        if not hit or hit[3] != n:
            continue
        role, strength, title, _ = hit
        prev = words[j - 1]
        if prev != "," and has(_BEFORE_MENTION, f" {prev} "):
            return None
        rest = " " + " ".join(words[:j]).rstrip(", ") + (" ? " if "?" in words[last:] else " ")
        return _Voc(role, strength, title, rest, prev == ",", "tail", "")
    return None


_FILLER_SET = {_pattern(w.strip()) for w in _FILLERS.split(";") if w.strip() and " " not in w.strip()}


def _is_filler(w: str) -> bool:
    return re.escape(w) in _FILLER_SET


# ---------------------------------------------------------------- the rules


def _r(target: str, action: str, text: str, conf: float = 0.9, via: str = "rule", silent: Optional[bool] = None, ambiguous: bool = False) -> Route:
    return Route(target, action, conf, via, text, (target != "patient") if silent is None else silent, ambiguous)


def _staff_action(role: str, p: str, t: str) -> str:
    if _stop(p, t, True):
        return "stop"
    if role != "nurse" and (_WE_Q.match(_LEAD.sub(" ", t)) or " ? " in p):
        return "question"
    o = _order(p, t, True)
    q = _is_question(p, t)
    if q and o != "order":
        return "question"
    if o:
        body = _LEAD.sub(" ", t)
        if q and _Q_START.match(body) and not re.match(r"^ (?:can|could|would|will) (?:you|we) ", body) and not _native_order(p, t, True):
            return "question"
        return "order"
    if q or " ? " in p or _Q_START.match(_LEAD.sub(" ", t)):
        return "question"
    return "none"


def _observer(p: str, t: str, names: tuple[str, ...]) -> bool:
    body = _LEAD.sub(" ", t)
    if _is_question(p, t) and not re.match(r"^ (?:can|could|would|will) (?:you|someone|somebody|anyone|we) ", body):
        return False
    if _OBS_RELATION.match(body) or _OBS_RELATION.match(t):
        return True
    for rx in (_OBS_INVITE, _OBS_PURPOSED, _OBS_NAME_FIRST):
        for s in (body, t):
            m = rx.match(s)
            if m:
                first = m.group("name").split()
                if not any(w in _NOT_A_NAME for w in first) and not _clinical(f" {m.group('name')} ") and not has(SYMPTOM_RX, f" {m.group('name')} ") and not _is_filler(first[0]):
                    if rx is not _OBS_PURPOSED or re.search(r" (?:ask|call|ring|phone|get|have|bring|add|want) ", s[: m.start("name") + 1]):
                        return True
    if has(_OBS_NATIVE, t) and not has(_FAC_ANY, t) and not _clinical(t) and not has(YOU_RX, t) and not _mention(t):
        return len(t.split()) <= 12
    if names:
        m = re.match(_OBS_LEAD + r"(?:call|ring|phone|get|add|bring) " + _OBS_NAME + r"(?: (?:now|please|in|too))? $", body)
        if m and any(m.group("name") == n or m.group("name").split()[0] == n.split()[0] for n in names):
            return True
    return False


def _mention(t: str) -> Optional[str]:
    """First staff role named anywhere (native titles may carry case endings)."""
    for role in ("nurse", "pharmacist", "lab", "radiology", "faculty"):
        for kind in ("strong", "weak"):
            rx = _MENTION_RX[role].get(kind)
            if rx and has(rx, t):
                return role
    return None


_MENTION_RX: dict[str, dict[str, re.Pattern[str]]] = {
    r: {k: T(";".join(w.strip() if w.strip().isascii() else w.strip() + "*" for w in d[k].split(";") if w.strip()
                      and not (r == "nurse" and k == "weak" and w.strip() not in ("sister", "सिस्टर", "ಸಿಸ್ಟರ್", "சிஸ்டர்", "సిస్టర్", "সিস্টার"))))
        for k in ("strong", "weak") if d[k]}
    for r, d in _ROLE_TITLES.items()
}


def _delegation(p: str, t: str, names_off: set[str]) -> Optional[tuple[str, str]]:
    """'ask the pharmacist if ...', 'nurse ko bolo ...' -> (role, action)."""
    body = _LEAD.sub(" ", t)
    if _Q_START.match(body) and not re.match(r"^ (?:can|could|would|will) (?:you|we) ", body):
        if not re.match(r"^ (?:should|shall) we ", body):
            return None
    for m in _ASK.finditer(t):
        words = t[m.start("title"):].split()
        hit = _title_at(words, 0, names_off)
        if not hit or hit[1] == "weak" and hit[0] == "nurse" and hit[2] not in ("sister", "staff"):
            continue
        role, _s, _title, n = hit
        after = " " + " ".join(words[n:]) + " "
        pre = t[: m.start() + 1]
        if re.match(r" (?:results?|reports?|tests?|values?|slip|coat) ", after):
            continue
        if re.search(r" (?:you (?:can|should|may|could|need|must|have)|if you|your|you want|please go|go and|did you|have you) ", pre + " "):
            continue
        if re.search(r" (?:if you|your|where it hurts|how you|what you|when you|you need|you want|you feel) ", after) and role == "nurse":
            continue
        verb = m.group("verb")
        if verb in ("get", "have") and role in ("lab", "pharmacist", "radiology", "nurse") and not re.match(r" (?:to |in |on |here|run|check|send|do|verify|look)", after):
            continue
        if verb.startswith("send"):
            return ("nurse", "order")
        if re.match(r" (?:to join|join|in here|in |on the line|on the call|on call|here|into|to come|to the room|now |please $|$)", after) and verb in ("call", "get", "bring", "add", "invite", "loop in", "page", "ring", "phone", "ask", "have"):
            return (role, "invite") if not (verb == "ask" and not after.strip()) else (role, "question")
        if _stop(after, after, True):
            return (role, "stop")
        if re.match(r" (?:to )?(?:hold|stop|cancel|withhold) ", after):
            return (role, "stop")
        if re.match(r" (?:if|whether|what|why|how|when|about|which|is|are|for (?:\w+ ){0,3}?(?:opinion|advice|dose|creatinine|results?|reports?|values?|levels?)\b)", after):
            return (role, "question")
        if verb in ("check with", "consult", "talk to", "speak to", "connect me to", "put me through to"):
            return (role, "question")
        if re.match(r" (?:to|and|that|run|send|do|for|we|please|the|it|order|give|get|check|verify|about)", after) or _order(after, after, True):
            return (role, "order")
        if verb in ("ask", "inform", "tell", "message", "request", "update", "alert"):
            return (role, "question")
        if verb in ("call", "page", "invite", "ring", "phone"):
            return (role, "invite")
    if has(_NATIVE_TELL, t) or has(_ASK_VERB_NATIVE, t):
        role = _mention(t)
        if not role:
            for r, rx in ((r, _VOC[r].get("name")) for r in _VOC):
                if rx and r not in names_off and has(rx, t):
                    role = r
                    break
        if role and not has(YOU_RX, t):
            if has(_ASK_VERB_NATIVE, t) and not _native_order(p, _ASK_VERB_NATIVE.sub("", t), False):
                return role, "question"
            return role, "order"
    return None


def _needs_llm(p: str, t: str, names_off: set[str]) -> bool:
    """Unclear turns worth a short LLM call. Ordinary history talk must not match."""
    if len(t.split()) > MAX_WORDS:
        return False
    q = _patient_question(p, t) or _is_question(p, t)
    if q or has(_THIRD_VERB, t) or has(_HOME, t):
        return False
    if _clinical(t) and not has(_REPORT, t) and len(t.split()) <= 14 and not has(SYMPTOM_RX, t) and not has(_TO_PATIENT, t) and not has(_NATIVE_PATIENT_VERB, t) and not _NATIVE_FUTURE.search(t):
        # "the ECG is normal" is news for the patient, not an order
        return not re.search(r" (?:is|are|was|were|shows|showed|looks|came|hai|है|ಇದೆ|இருக்கு|ఉంది|आहे|আছে) ", t)
    if len(t.split()) <= 14 and not re.search(r" (?:will|is|was|has|said|told|gave|from|at|near) ", t):
        words = t.split()
        for i, w in enumerate(words):
            hit = _title_at(words, i, names_off)  # exact title only: "ফার্মেসিতে" (at the pharmacy) is a place
            if hit and (hit[1] == "strong" or hit[0] != "nurse") and not (i and has(_BEFORE_MENTION, f" {words[i - 1]} ")) and not (
                    i + 1 < len(words) and has(_COMPOUND_NEXT, f" {words[i + 1]} ")):
                return True
    return False


def _rules(utterance: str, lang: str, patient_name: str, pending: str, awaiting: bool, observers: tuple[str, ...]) -> Route:
    text = re.sub(r"\s+", " ", utterance or "").strip()
    p = normalise(text)
    t = plain(p)
    if not t.strip():
        return _r("patient", "none", text, 1.0)
    if len(t.split()) > 220:
        return _r("patient", "none", text, 0.6)
    names_off = {r for r in STAFF_ROLES if _patient_shares_name(r, patient_name)} if patient_name else set()
    you = _has_you(t)
    q = _is_question(p, t)

    # 1. override a pharmacy hold
    if has(_OVERRIDE, t) and not (you and q) and not re.search(r" (?:you|your) (?:can|may|should|still|take|go) ", t):
        return _r("faculty", "override", text, 0.92)

    # 2. faculty invite
    if not (q and not re.match(r"^ (?:can|could|would|will|should|shall|may) (?:you|we|i|someone|somebody|anyone|anybody) ", _LEAD.sub(" ", t))):
        if _SENIOR_INVITE.search(t) and not re.search(r" (?:my|observe|watch) ", t) and (not you or has(_POLITE_YOU, t)):
            return _r("faculty", "invite", text, 0.88)
        if not _OBS_RELATION.match(_LEAD.sub(" ", t)) or re.search(r" (?:the|our) (?:faculty|professor)", t):
            if _FAC_INVITE.search(t) and not re.search(r" (?:ask|tell) .* (?:if|whether|what|why|how|about|which) ", t) and not re.search(r" (?:observe|watch) ", t):
                if not re.search(r" (?:need|want) (?:a |the )?(?:consultant|attending) ", t) and (not you or has(_POLITE_YOU, t)):
                    return _r("faculty", "invite", text, 0.92)
        if has(_FAC_ANY, t) and has(_FAC_INVITE_NATIVE, t) and not has(YOU_RX, t):
            return _r("faculty", "invite", text, 0.92)
        if _FAC_WANTED.search(t) and (not you or has(_POLITE_YOU, t)):
            return _r("faculty", "invite", text, 0.8)
        if has(_SENIOR_NATIVE, t) and has(_FAC_INVITE_NATIVE, t) and not has(YOU_RX, t) and not re.search(r" (?:my|mere|मेरे) ", t):
            return _r("faculty", "invite", text, 0.85)
        if has(_SIR_INVITE, t) and not re.search(r" (?:observe|watch) ", t):
            return _r("faculty", "invite", text, 0.75)

    # 3. observer invite ("Darshan should watch this")
    if _observer(p, t, observers):
        return _r("observer", "invite", text, 0.9)

    # 4. spoken to a staff member
    voc = _find_vocative(p, names_off)
    if awaiting and not voc:
        voc_fac = _await_vocative(p, t)
        if voc_fac and not _patient_question_history(p, t):
            return _r("faculty", "answer", text, 0.85, "context")
    if awaiting and voc and voc.role == "nurse" and voc.strength == "weak" and has(_FAC_AWAIT, f" {voc.title} "):
        rt = plain(voc.rest)
        if _order(voc.rest, rt, False) != "order" and not _patient_question_history(voc.rest, rt):
            return _r("faculty", "answer", text, 0.85, "context")
    if voc:
        hit = _vocative_route(voc, p, t, text, pending, awaiting, names_off)
        if hit:
            return hit

    # 5. the reply a department or the faculty member is waiting for
    hit = _context_reply(p, t, text, pending, awaiting)
    if hit:
        return hit

    # 6. hint, staff asked through somebody, exam, stop, order
    if _hint(p, t):
        return _r("coach", "hint", text, 0.9)
    d = _delegation(p, t, names_off)
    if d and not (d[0] == "faculty" and d[1] == "invite" and you):
        return _r(d[0], d[1], text, 0.85)
    if _stop(p, t):
        return _r("nurse", "stop", text, 0.88)
    if _exam(p, t):
        # Said to the patient ("let me listen to your chest"): they may answer.
        return _r("exam", "order", text, 0.88, silent=False)
    o = _order(p, t)
    if o == "order":
        other = [c for c in _clauses(p) if _has_you(c)]
        return _r("nurse", "order", text, 0.86, silent=not (other and _is_question(p, " " + " ".join(other) + " ")))
    if o == "self":
        # "We'll do an ECG now": the nurse starts it, the patient may say okay.
        return _r("nurse", "order", text, 0.7, silent=False)
    if o == "maybe":
        return _r("patient", "none", text, 0.5, ambiguous=True)
    body = _LEAD.sub(" ", t)
    if _RESULT_Q.match(body) and not you:
        return _r("nurse", "question", text, 0.75)
    role = _mention(t)
    if role in ("lab", "pharmacist", "radiology", "faculty") and q and not you and re.search(
            r" (?:what (?:does|did|do|has) (?:the )?|whats (?:the )?|has (?:the )?|is (?:the )?|any (?:news|word|update) from (?:the )?|did (?:the )?)", t) and re.search(
            r" (?:say|said|saying|think|send|sent|replied|reply|confirm|confirmed|finish|finished|done|ready|news|word|update|verify|verified|approve|approved) ", t):
        return _r(role, "question", text, 0.75)
    return _r("patient", "none", text, 0.9 if not _needs_llm(p, t, names_off) else 0.55, ambiguous=_needs_llm(p, t, names_off))


def _patient_question_history(p: str, t: str) -> bool:
    return (has(YOU_RX, t) and _is_question(p, t)) or has(HISTORY_RX, t) and _is_question(p, t)


def _await_vocative(p: str, t: str) -> bool:
    words = _LEAD.sub(" ", t).split()
    allw = t.split()
    return bool(words and (has(_FAC_AWAIT, f" {words[0]} ") or has(_FAC_AWAIT, f" {allw[-1]} ")) or
                allw and has(_FAC_AWAIT, f" {allw[0]} "))


# "have it done / check and tell me": reported speech to staff, not "tell me" to a patient.
_SAY_DO = T("*க்க சொல்லுங்க;பண்ண சொல்லுங்க;கொடுக்க சொல்லுங்க;எடுக்க சொல்லுங்க;करके बताओ;करके बताइए;करून सांगा;*ला सांगा;ಮಾಡಿ ಹೇಳಿ;చేసి చెప్పండి;করে বলুন;karke batao;karke bataiye")


def _vocative_route(voc: _Voc, p: str, t: str, text: str, pending: str, awaiting: bool, names_off: set[str]) -> Optional[Route]:
    rp, rt = voc.rest, plain(voc.rest)
    body = _LEAD.sub(" ", rt)
    # "How long have you had this? Nurse, send a CBC": the patient still answers.
    silent = not (voc.where == "mid" and voc.before and has(YOU_RX, voc.before) and _is_question(voc.before, plain(voc.before)))
    pq = _patient_question(rp, rt)
    order = _order(rp, rt, True) == "order"
    strict_order = _order(rp, rt, False) == "order"
    stop = _stop(rp, rt, True)
    deleg = _delegation(rp, rt, names_off)

    if voc.role == "faculty":
        if pq and has(HISTORY_RX, rt):
            return None
        if not rt.strip():
            return _r("faculty", "question", text, 0.7)
        act = "question" if _is_question(rp, rt) or " ? " in rp or re.match(r"^ (?:can|could|should|may|shall) (?:i|we) ", body) else "answer" if awaiting else "question"
        return _r("faculty", act, text, 0.9, "context" if awaiting and act == "answer" else "rule", silent)

    if voc.role != "nurse":
        called = voc.strength == "name" and voc.where == "lead"
        topic = voc.strength in ("name", "strong") and (has(_DEPT_TOPIC, rt) or _clinical(rt)) and not (has(HISTORY_RX, rt) and _has_you(rt))
        if called and not topic and not has(_COLLEAGUE, rt) and (has(SYMPTOM_RX, rt) or has(HISTORY_RX, rt) and _has_you(rt)):
            return None  # talk about the body: somebody in the room shares the name
        topic = topic or called
        if topic and not voc.comma and voc.where == "lead" and has(T("se;से;থেকে;from"), " ".join(["", *rt.split()[:1], ""])):
            topic = False
        if pq and not (topic or has(_THIRD, rt) or has(_COLLEAGUE, rt) or (voc.comma and not _has_you(rt) and not has(SYMPTOM_RX, rt)) or strict_order or _clinical(rt) and not has(HISTORY_RX, rt)) and voc.strength != "strong":
            return None
        if voc.strength == "weak" and not voc.comma and not (order or stop or _is_question(rp, rt) or has(T("please;check;verify;confirm;tell"), rt)):
            return None
        if voc.where == "tail" and not (strict_order or stop or voc.comma or topic or _is_question(rp, rt) and not _has_you(rt)):
            return None
        if voc.strength == "weak" and has(HISTORY_RX, rt) and not has(_THIRD, rt) and not (voc.comma and not _has_you(rt)):
            return None
        if voc.role == pending and not _is_question(rp, rt) and not stop:
            return _r(voc.role, "answer", text, 0.9, "context", silent)
        act = _staff_action(voc.role, rp, rt)
        if act == "none" and has(T("please;verify;confirm;check"), rt):
            act = "order"
        return _r(voc.role, act, text, 0.88, "rule", silent)

    # nurse
    if _hint(rp, rt):
        return _r("coach", "hint", text, 0.92, "rule", silent)
    weak = voc.strength == "weak"
    if voc.where == "tail":
        if not (strict_order or stop or deleg or _exam(rp, rt, True) or voc.comma or _native_order(rp, rt, False)
                or (not weak and (order or _is_question(rp, rt)) and not _has_you(rt) and not has(HISTORY_RX, rt))):
            return None
    if weak:
        sister = voc.title.startswith(("sister", "sistar", "सिस्टर", "ಸಿಸ್ಟರ್", "சிஸ்டர்", "సిస్టర్", "সিস্টার"))
        ok_order = strict_order or stop or deleg or (_order(rp, rt, True) == "order" and _clinical(rt) and not pq)
        if has(_TO_PATIENT, rt) and not sister:
            ok_order = False
        if voc.title in ("staff",) and not (ok_order or voc.comma):
            return None
        if has(_NATIVE_PATIENT_VERB, rt) and not (strict_order or deleg):
            ok_order = False
        ex = _exam(rp, rt, True) and not _has_you(rt) and (sister or not re.search(r" (?:let me|main|मैं|ನಾನು|நான்|నేను|मी|আমি) ", rt))
        third = has(_THIRD, rt) and not _has_you(rt) and (sister or not has(HISTORY_RX, rt))
        if sister and not _is_question(rp, rt) and not has(_NATIVE_PATIENT_VERB, _SAY_DO.sub("", rt)) and (
                _order(rp, rt, True) == "order" and _clinical(rt) or (_clinical(rt) or has(GENERIC_RX, rt)) and not _has_you(rt)):
            ok_order = True
        if not (ok_order or ex or third):
            if pq or has(HISTORY_RX, rt) or has(SYMPTOM_RX, rt):
                return _r("patient", "question", text, 0.85)
            if not sister:
                return _r("patient", "none", text, 0.6, ambiguous=_clinical(rt) and not has(_NATIVE_PATIENT_VERB, rt))
            if not rt.strip():
                return _r("nurse", "none", text, 0.65)
            return _r("nurse", _staff_action("nurse", rp, rt), text, 0.65, "rule", silent)
    else:
        if voc.where == "lead" and not voc.comma and (has(_YOU_DATIVE, rt) or has(_THIRD_VERB, rt)) and not strict_order and not stop:
            return _r("patient", "none", text, 0.7)
        if pq and voc.strength == "name" and voc.where == "lead" and has(T("where does it;your pain;how do you feel"), rt) and not order:
            return _r("patient", "question", text, 0.6)
    if stop:
        return _r("nurse", "stop", text, 0.92, "rule", silent)
    if deleg and deleg[0] != "nurse":
        if deleg[1] in ("question", "invite"):
            return _r(deleg[0], deleg[1], text, 0.88, "rule", silent)
        return _r("nurse", "order", text, 0.88, "rule", silent)
    if _exam(rp, rt, True) and not _clinical(rt):
        return _r("exam", "order", text, 0.9, "rule", silent)
    act = _staff_action("nurse", rp, rt)
    return _r("nurse", act, text, 0.92 if act != "none" else 0.8, "rule", silent)


_TELL = T("tell me;batao;bataiye;bata dijiye;बताओ;बताइए;सांगा;ಹೇಳಿ;சொல்லுங்க;చెప్పండి;বলুন;heli;sollunga;cheppandi;bolun;sanga;let me ask;let me check")


def _context_reply(p: str, t: str, text: str, pending: str, awaiting: bool) -> Optional[Route]:
    if not pending and not awaiting:
        return None
    words = t.split()
    q = _is_question(p, t)
    you = _has_you(t)
    history = has(_TELL, t)
    body = _LEAD.sub(" ", t)
    if pending:
        explicit_new = bool(re.match(r"^ (?:please |can you |could you |lets )*(?:order|get|run|send|do|arrange|repeat) ", body)) and has(TEST_RX, t) and not has(_YESNO, f" {words[0]} ")
        if not q and not history and not explicit_new and len(words) <= 25 and not has(_NATIVE_PATIENT_VERB, t):
            if _stop(p, t) and has(T("cancel;कैंसल;कैंसिल;रद्द"), t):
                return _r("nurse", "stop", text, 0.85)
            if not you or (has(_YESNO, f" {words[0]} ") and len(words) <= 8 and not re.search(r" your? ", t)):
                role = "faculty" if pending == "examiner" else pending
                return _r(role, "answer", text, 0.85, "context")
    if awaiting and not pending:
        if not q and not you and not history and len(words) <= 40 and not _stop(p, t) and _order(p, t) is None and not _exam(p, t) and not _hint(p, t):
            if has(_REASON, t) and len(words) >= 3 and not has(_NATIVE_PATIENT_VERB, t):
                return _r("faculty", "answer", text, 0.75, "context")
    return None


@lru_cache(maxsize=2048)
def _rules_cached(utterance: str, lang: str, patient_name: str, pending: str, awaiting: bool, observers: tuple[str, ...]) -> Route:
    return _rules(utterance, lang, patient_name, pending, awaiting, observers)


def route_rules(utterance: str, *, lang: Optional[str] = None, context: Optional[dict[str, Any]] = None) -> Route:
    """Deterministic route. `ambiguous` is True when only a model can tell."""
    c = _ctx(context)
    return _rules_cached((utterance or "")[:1500], langmod.norm_lang(lang), c["patientName"], c["pendingRole"], c["awaitingFaculty"], c["observers"])


# ---------------------------------------------------------------- LLM fallback

_LLM_SYSTEM = (
    "You route one utterance of a doctor in an Indian outpatient room. The patient (or a parent) sits in front of the doctor. "
    "Staff in earshot: nurse Asha (called nurse, sister, Asha, didi, akka), pharmacist Meera, lab officer Dev, radiologist Vikram, "
    "and sometimes a faculty professor. The utterance comes from noisy speech-to-text and may mix English, Hindi, Kannada, Tamil, "
    "Telugu, Marathi and Bengali in any script.\n"
    "target: patient | nurse | pharmacist | lab | radiology | faculty | coach | exam | observer\n"
    "action: order | question | stop | hint | invite | answer | override | none\n"
    "Rules, in this order:\n"
    "1. Any instruction to do a test, scan, injection, drip or to give or start a drug is nurse/order. Nurse Asha passes it on; lab, "
    "radiology and pharmacist are targets ONLY when the doctor calls them by name or title and speaks to them.\n"
    "2. Suggesting a test or drug for the patient in front of them (\"let's get you an ECG\", \"maybe amoxicillin for him\") is nurse/order.\n"
    "3. Everything said TO the patient is patient/none: history questions, results and news, advice, how to take medicine, what the nurse, "
    "lab or pharmacy said or will do, where to go, come fasting, buy it from the pharmacy.\n"
    "4. Physical examination by the doctor is exam/order. 'How am I doing' is coach/hint. Bringing a person in to watch is observer/invite. "
    "Calling the professor or a senior into the room is faculty/invite.\n"
    "5. Not sure: patient/none. A single word is patient/none.\n"
    'Reply with JSON only: {"target": "...", "action": "...", "confidence": 0.0 to 1.0}'
)


def _names_role(text: str, role: str) -> bool:
    t = plain(normalise(text))
    return any(has(rx, t) for rx in _VOC[role].values())


async def _llm_route(text: str, rule: Route, c: dict[str, Any]) -> Optional[Route]:
    from llm_provider import chat, strip_think

    user = json.dumps({"utterance": text[:400], "patientName": c["patientName"], "departmentAwaitingReply": c["pendingRole"] or None,
                       "facultyAwaitingReply": c["awaitingFaculty"]}, ensure_ascii=False)
    try:
        msg, _ = await chat([{"role": "system", "content": _LLM_SYSTEM}, {"role": "user", "content": user}],
                            json_mode=True, max_tokens=60, temperature=0.0)
        m = re.search(r"\{.*\}", strip_think(str((msg or {}).get("content") or "")), re.DOTALL)
        data = json.loads(m.group(0)) if m else None
        target, action = str(data["target"]).lower(), str(data.get("action") or "none").lower()
        conf = float(data.get("confidence") or 0.0)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001 - no provider, HTTP error, bad JSON: the rule decision stands
        log.info("intent LLM unavailable: %s", type(e).__name__)
        return None
    if target not in TARGETS or conf < LLM_MIN_CONFIDENCE:
        return replace(rule, ambiguous=False)
    if action not in ACTIONS:
        action = "none"
    if target in ("pharmacist", "lab", "radiology") and not _names_role(text, target):
        target = "nurse" if action in ("order", "stop") else "patient"  # nobody called them
    if target not in ("patient", "nurse") and action == "none":
        return replace(rule, ambiguous=False)
    return Route(target, "none" if target == "patient" else action, min(conf, 0.95), "llm", text,
                 target not in ("patient", "exam"))


# key -> (stored at, Route); decided turns, shared by /voice/route and the proxy.
_decided: "OrderedDict[tuple, tuple[float, Route]]" = OrderedDict()
_inflight: dict[tuple, tuple[asyncio.AbstractEventLoop, asyncio.Future]] = {}
_DECIDED_MAX = 512
_DECIDED_TTL_S = 900.0
_bg: set[asyncio.Task] = set()


def _remember(key: tuple, r: Route) -> None:
    _decided[key] = (time.monotonic(), r)
    _decided.move_to_end(key)
    while len(_decided) > _DECIDED_MAX:
        _decided.popitem(last=False)


def _settle(key: tuple, fut: asyncio.Future, r: Route) -> None:
    """First answer (model or first caller's time-out) wins for every caller."""
    if not fut.done():
        fut.set_result(r)
        _remember(key, r)
    if _inflight.get(key, (None, None))[1] is fut:
        _inflight.pop(key, None)


async def route(utterance: str, *, lang: Optional[str] = None, context: Optional[dict[str, Any]] = None,
                llm_cap_s: float = LLM_CAP_S) -> Route:
    """Rules first; an ambiguous turn gets one capped LLM call shared by all callers."""
    rule = route_rules(utterance, lang=lang, context=context)
    if not rule.ambiguous or llm_cap_s <= 0:
        return rule
    c = _ctx(context)
    key = (plain(normalise(utterance)).strip(), c["patientName"], c["pendingRole"], c["awaitingFaculty"])
    hit = _decided.get(key)
    if hit and time.monotonic() - hit[0] < _DECIDED_TTL_S:
        return replace(hit[1], text=rule.text)
    loop = asyncio.get_running_loop()
    default = replace(rule, ambiguous=False)
    cur = _inflight.get(key)
    if cur and cur[0] is loop and not cur[1].done():
        fut = cur[1]
    else:
        fut = loop.create_future()
        _inflight[key] = (loop, fut)

        async def work() -> None:
            r: Optional[Route] = None
            try:
                r = await asyncio.wait_for(_llm_route(rule.text, rule, c), timeout=LLM_CAP_S + 1.0)
            except (asyncio.TimeoutError, TimeoutError):
                r = None
            finally:
                _settle(key, fut, r or default)

        task = loop.create_task(work())
        _bg.add(task)
        task.add_done_callback(_bg.discard)
    try:
        return await asyncio.wait_for(asyncio.shield(fut), timeout=llm_cap_s)
    except (asyncio.TimeoutError, TimeoutError):
        # The patient has already answered by now, so nobody else may take this turn later.
        _settle(key, fut, default)
        return fut.result() if fut.done() else default


# ---------------------------------------------------------------- per-session state

_SESSION_TTL_S = 4 * 3600
_STATE_TTL_S = 600.0
# channel -> {caseId, encounterId, patientName, at, ctx, ctxAt, silenced}
_sessions: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


def bind_session(channel: str, *, case_id: str = "", encounter_id: str = "", patient_name: str = "") -> None:
    """Called by /voice/start: what the proxy knows about a patient channel."""
    if not channel:
        return
    _sessions[channel] = {"caseId": case_id, "encounterId": encounter_id, "patientName": patient_name,
                          "at": time.monotonic(), "ctx": {}, "ctxAt": 0.0, "silenced": deque(maxlen=64)}
    while len(_sessions) > 400:
        _sessions.popitem(last=False)


def _session_for(channel: str = "", encounter_id: str = "", case_id: str = "") -> Optional[dict[str, Any]]:
    if channel and channel in _sessions:
        return _sessions[channel]
    now = time.monotonic()
    live = [s for s in _sessions.values() if now - s["at"] < _SESSION_TTL_S]
    if encounter_id:
        hits = [s for s in live if s["encounterId"] == encounter_id]
        if hits:
            return hits[-1]
    if case_id:
        hits = [s for s in live if s["caseId"] == case_id and (not s["encounterId"] or not encounter_id)]
        if len(hits) == 1:  # two people on the same case must not share state
            if encounter_id:
                hits[0]["encounterId"] = encounter_id
            return hits[0]
    return None


def note_context(context: dict[str, Any], *, channel: str = "", encounter_id: str = "", case_id: str = "") -> bool:
    """Store pendingQuestion / awaitingFaculty for a session (browser or room hub)."""
    s = _session_for(channel, encounter_id, case_id)
    if s is None:
        return False
    s["ctx"] = {k: context.get(k) for k in ("pendingQuestion", "awaitingFaculty", "observerNames", "relatedNames") if k in context}
    if context.get("patientName"):
        s["patientName"] = str(context["patientName"])[:80]
    s["ctxAt"] = time.monotonic()
    return True


def session_context(channel: str) -> dict[str, Any]:
    """Context of a patient channel for an in-process caller (the LLM proxy)."""
    s = _sessions.get(channel)
    if not s:
        return {}
    ctx = dict(s["ctx"]) if time.monotonic() - s["ctxAt"] < _STATE_TTL_S else {}
    if s["patientName"]:
        ctx["patientName"] = s["patientName"]
    return ctx


def mark_silenced(channel: str, utterance: str) -> None:
    s = _sessions.get(channel)
    if s is not None:
        s["silenced"].append(plain(normalise(utterance)).strip())


def was_silenced(channel: str, utterance: str) -> bool:
    s = _sessions.get(channel)
    return bool(s) and plain(normalise(utterance)).strip() in s["silenced"]


_PERSONA_NAME = re.compile(r"\byou are (?:a human patient named |the \w+ of )?([^\W\d_][^,\n.]{0,60}), an? \d{1,3}[- ]year", re.IGNORECASE)
_PERSONA_SHORT = re.compile(r"\byou are (?:the \w+ of )?([A-Z][a-z]+(?: [A-Z][a-z]+)?)(?=[,.]| and )")


def persona_name(system_prompt: str) -> str:
    """Patient (or child) name in a persona prompt of src/voice/patientPersona.ts."""
    head = (system_prompt or "")[:600]
    m = _PERSONA_NAME.search(head) or _PERSONA_SHORT.search(head)
    return m.group(1).strip() if m else ""


def reset() -> None:
    """Tests only."""
    _rules_cached.cache_clear()
    _decided.clear()
    _inflight.clear()
    _sessions.clear()


# ---------------------------------------------------------------- endpoint


class RouteContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    patientName: str = ""
    gender: str = ""
    caseId: str = ""
    channel: str = ""
    pendingQuestion: Optional[dict[str, Any]] = None
    awaitingFaculty: bool = False
    relatedNames: list[str] = Field(default_factory=list)
    observerNames: list[str] = Field(default_factory=list)


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    utterance: str = ""
    encounterId: Optional[str] = None
    lang: Optional[str] = None
    context: RouteContext = Field(default_factory=RouteContext)


class RouteResponse(BaseModel):
    target: str
    action: str
    confidence: float
    via: str
    text: str
    silent: bool = False


@router.post("/voice/route", response_model=RouteResponse)
async def voice_route(req: RouteRequest) -> RouteResponse:
    """Route one doctor turn. An empty utterance only syncs the context, so the
    proxy already knows about a pending question before the doctor speaks."""
    ctx = req.context.model_dump()
    note_context(ctx, channel=req.context.channel, encounter_id=req.encounterId or "", case_id=req.context.caseId)
    r = await route(req.utterance, lang=req.lang, context=ctx)
    return RouteResponse(**r.to_dict())
