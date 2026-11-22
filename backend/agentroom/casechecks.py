"""Checks a department makes on a newly authored case before a person approves it.

Fixed tables only, no model. A finding is {"level": "hard"|"note", "detail": str}:
hard means the case is wrong as written, note means a person should look.
Training simulator tables, not a clinical reference.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional

from . import analytes

# Outside these nobody has a sample like this: a typing or unit mistake.
POSSIBLE: dict[str, tuple[float, float]] = {
    "k": (1.2, 10), "na": (95, 190), "ca": (3, 20), "hb": (1.5, 26), "plt": (1, 3000), "wbc": (0.1, 700), "anc": (0, 200),
    "creat": (0.1, 30), "ph": (6.6, 7.9), "glucoseMin": (5, 1800), "glucoseMax": (5, 1800), "inr": (0.5, 20), "lactate": (0.1, 35),
    "bicarb": (1, 60), "pco2": (8, 150), "po2": (15, 700), "egfr": (1, 200),
}
# Clearly outside the adult reference range (with a margin, so borderline values do not count).
CLEARLY_ABNORMAL: dict[str, tuple[Optional[float], Optional[float]]] = {
    "k": (3.3, 5.5), "na": (132, 149), "ca": (8.0, 11.0), "plt": (130, 480), "wbc": (3.2, 12.0), "creat": (None, 1.5),
    "inr": (None, 1.5), "ph": (7.32, 7.48), "lactate": (None, 2.5), "troponin": (None, 52), "egfr": (55, None),
}
NAMES = {
    "k": "potassium", "na": "sodium", "ca": "calcium", "hb": "haemoglobin", "plt": "platelets", "wbc": "white cells", "anc": "neutrophils",
    "creat": "creatinine", "ph": "pH", "glucoseMin": "glucose", "glucoseMax": "glucose", "inr": "INR", "lactate": "lactate",
    "bicarb": "bicarbonate", "pco2": "pCO2", "po2": "pO2", "egfr": "eGFR", "troponin": "troponin", "ck": "CK", "bili": "bilirubin",
    "lithium": "lithium", "valproate": "valproate",
}
FEMALE_ONLY = frozenset({"urine-hcg", "beta-hcg-q", "pap-smear"})
MALE_ONLY = frozenset({"psa"})

# Stated diagnosis -> tests that can show it. One of them has to be on the case.
TESTABLE: tuple[tuple[str, tuple[str, ...]], ...] = (
    (r"anaem|anem|thalass|sickle|leuk|pancytop|thrombocytop", ("cbc", "peripheral-smear", "iron", "ferritin", "b12")),
    (r"diabet|hypoglyc|hyperglyc|ketoacid|\bDKA\b", ("glucose", "hba1c", "bmp", "abg", "urine")),
    (r"myocardial infarct|\bMI\b|STEMI|NSTEMI|angina|acute coronary|arrhythm|fibrillation|heart block|pericarditis|tachycardia|long QT",
     ("ecg", "troponin", "echo", "cath")),
    (r"heart failure|cardiomyopathy|valv|stenosis of (?:aort|mitr)|mitral|aortic", ("echo", "bnp", "cxr", "ecg")),
    (r"pneumonia|tubercul|\bTB\b|pneumothorax|pleural|bronchiect|lung (?:cancer|abscess)", ("cxr", "ct-chest", "sputum-afb", "pocus", "cbc")),
    (r"asthma|COPD|chronic obstructive|bronchitis", ("peak-flow", "spirometry", "cxr", "abg")),
    (r"pulmonary embol|deep vein|\bDVT\b", ("dimer", "ct-angio", "us-msk", "pocus", "ecg")),
    (r"hypothyroid|hyperthyroid|thyroid|graves|thyrotox|myxoed", ("tsh", "free-t4", "thyroid-ab")),
    (r"kidney|renal|nephr|uraem|uremi", ("bmp", "urine", "kub", "us-abdomen")),
    (r"urinary tract|\bUTI\b|cystitis|pyeloneph", ("urine", "urine-cx")),
    (r"ureteric|ureteral|renal colic|stone|calcul", ("kub", "ct-abdomen", "us-abdomen", "urine")),
    (r"hepatit|cirrho|jaundice|liver|cholangitis|biliary", ("lft", "hep-b", "hep-c", "us-abdomen", "coag")),
    (r"cholecyst|gallstone|appendic", ("us-abdomen", "ct-abdomen", "cbc", "lft")),
    (r"pancreat", ("lipase", "ct-abdomen", "us-abdomen")),
    (r"dengue|malaria|typhoid|enteric fever|leptospir|scrub typhus|chikungunya", ("cbc", "tropical-serology", "peripheral-smear", "blood-cx")),
    (r"sepsis|septic|bacter", ("blood-cx", "lactate", "cbc", "crp", "procal", "wound-cx")),
    (r"mening|encephal", ("csf", "ct-head", "mri-brain", "blood-cx")),
    (r"stroke|infarct of|subarach|intracerebral|haematoma|hematoma|brain tumou?r", ("ct-head", "mri-brain", "ct-angio")),
    (r"epilep|seizure", ("eeg", "mri-brain", "ct-head")),
    (r"fracture|disloc", ("xr-extrem", "xr-spine", "xr-pelvis", "us-hip")),
    (r"rheumatoid|lupus|\bSLE\b|arthritis|gout|spondyl", ("rf", "anti-ccp", "ana", "dsdna", "esr", "crp", "xr-extrem", "xr-spine", "xr-pelvis")),
    (r"ectopic|pregnan|miscarr|abort", ("urine-hcg", "beta-hcg-q", "us-pelvis")),
    (r"HIV|AIDS", ("hiv",)),
    (r"syphilis", ("rpr",)),
    (r"hypokal|hyperkal|hyponat|hypernat|addison|adrenal", ("bmp", "cortisol", "ecg")),
    (r"glaucoma|retin|macul", ("fundoscopy", "oct", "visual-field")),
    (r"osteopor", ("dexa", "vit-d")),
    (r"peptic|duodenal ulcer|gastric ulcer|h\.? ?pylori|gastritis", ("h-pylori", "cbc", "fobt")),
    (r"colitis|crohn|\bIBD\b", ("calpro", "stool-cx", "crp", "fobt")),
)


def _finding(level: str, detail: str) -> dict[str, str]:
    return {"level": level, "detail": detail[:220]}


def review_results(data: dict[str, Any], performed: Iterable[str] = ()) -> list[dict[str, str]]:
    """The laboratory's review of one case: {age, gender, diagnosis, results, otherTests}."""
    try:
        age: Optional[float] = float(data.get("age"))
    except (TypeError, ValueError):
        age = None
    gender = str(data.get("gender") or "").upper()[:1]
    rows = [r for r in data.get("results") or [] if isinstance(r, dict)][:20] if isinstance(data.get("results"), list) else []
    known = set(performed)
    out: list[dict[str, str]] = []
    ids: list[str] = []
    for r in rows:
        tid, text, abnormal = str(r.get("testId") or "")[:60], str(r.get("result") or "")[:800], bool(r.get("abnormal"))
        name = str(r.get("name") or tid)[:60]
        ids.append(tid)
        if known and tid not in known:
            continue
        if (gender == "M" and tid in FEMALE_ONLY) or (gender == "F" and tid in MALE_ONLY):
            out.append(_finding("hard", f"{name} does not belong to a {'male' if gender == 'M' else 'female'} patient"))
        values = analytes.parse(text, tid)
        for key, x in values.items():
            lo_hi = POSSIBLE.get(key)
            if lo_hi and not lo_hi[0] <= x <= lo_hi[1]:
                out.append(_finding("hard", f"{name}: {NAMES.get(key, key)} {x:g} is not possible"))
        if not abnormal:
            crit = analytes.critical_reasons(tid, text, True, age)
            if crit:
                out.append(_finding("hard", f"{name} is critical ({', '.join(crit[:2])}) but is marked normal"))
                continue
            if age is not None and age >= 16:
                for key, (lo, hi) in CLEARLY_ABNORMAL.items():
                    x = values.get(key)
                    if x is not None and ((lo is not None and x < lo) or (hi is not None and x > hi)):
                        out.append(_finding("note", f"{name}: {NAMES.get(key, key)} {x:g} is outside the usual range but is marked normal"))
                        break
    others = [str(t)[:60] for t in data.get("otherTests") or []][:30] if isinstance(data.get("otherTests"), list) else []
    if not rows and not others:
        out.append(_finding("hard", "the case has no results"))
        return out
    diagnosis = str(data.get("diagnosis") or "")[:160]
    wanted = {t for pattern, tests in TESTABLE if re.search(pattern, diagnosis, re.I) for t in tests}
    if wanted and not wanted & {*ids, *others}:
        out.append(_finding("note", f"no test on the case can show {diagnosis.lower()}"))
    if not any(bool(r.get("abnormal")) for r in rows) and not others:
        out.append(_finding("note", "every result is normal, nothing supports the stated diagnosis"))
    return out[:12]


# Drugs a patient may name that are not in the formulary groups get no verdict here.
def review_medicines(data: dict[str, Any], formulary: Any) -> list[dict[str, str]]:
    """The pharmacy's review: {age, gender, allergies, medicines, complaint, treatments:[{id,name}]}."""
    from . import pharmacist as ph

    allergies = str(data.get("allergies") or "")[:500]
    medicines = str(data.get("medicines") or "")[:500]
    none = re.compile(r"^\W*(?:none|no|nil|nkda|nothing)\W*$", re.I)
    taking = [] if none.match(medicines) else formulary.mentioned(medicines)
    out: list[dict[str, str]] = []
    allergic = ph.allergy_tags(allergies)
    for _, name, tags in taking:
        covered = {t for a in allergic for t in ph.ALLERGY_COVERS.get(a, (a,))}
        hit = sorted(tags & covered)
        if hit:
            out.append(_finding("hard", f"the patient takes {name} with a recorded {hit[0]} allergy"))
    treatments = [t for t in data.get("treatments") or [] if isinstance(t, dict)][:20] if isinstance(data.get("treatments"), list) else []
    history = [{"question": "Any allergies?", "answer": allergies}, {"question": "Which medicines do you take?", "answer": medicines}]
    for t in treatments:
        name = str(t.get("name") or "")[:80]
        if not ph.tags_of(str(t.get("id") or ""), name):
            continue  # a referral, counselling, a procedure: not a drug
        rx = ph.build_rx("review", {
            "medicationId": str(t.get("id") or "")[:60], "medication": name, "dose": "", "duration": "", "caseId": "",
            "patient": {"age": data.get("age"), "gender": data.get("gender"), "allergies": allergies,
                        "chiefComplaint": str(data.get("complaint") or "")[:300], "history": history}}, formulary)
        rx.known = True
        for f in ph.check_local(rx):
            if f.level in ("hard", "hold"):
                out.append(_finding("hard", f"accepted treatment {name}: {f.detail}"))
            elif f.level == "clarify" and f.code != "pregnancy_unknown":
                out.append(_finding("note", f"accepted treatment {name}: {f.detail}"))
    seen: set[str] = set()
    uniq = []
    for f in out:
        if f["detail"] not in seen:
            seen.add(f["detail"])
            uniq.append(f)
    return uniq[:12]
