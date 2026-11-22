"""Reading laboratory numbers out of stored report text, and the fixed limits that go with them.

Everything here is a lookup or an inequality: the same text always gives the same
answer, and no model is involved. Shared by the laboratory (critical flags, renal
function) and the pharmacy (which released drugs a critical value affects).
Training simulator limits, not a clinical reference.
"""

from __future__ import annotations

import re
from typing import Any, Optional

_NUM = r"(\d[\d,]*(?:\.\d+)?)"
# Reference ranges, so "4.0 (3.5-5.0)" yields 4.0 and nothing else. A parenthesis
# that gives a trend ("up from 0.9", "baseline 1.0") or an eGFR is kept.
_REF_PAREN = re.compile(r"\((?:\s*ref[^)]*|\s*[<>]?\s*\d[\d.,]*\s*[-–]\s*\d[^)]*)\)", re.I)
_REF_LINE = re.compile(r"^\s*(?:reference|predicted)\b.*$", re.I | re.M)
_SUPERS = str.maketrans("⁺⁻₂₃", "+-23")  # superscript + -, subscript 2 3


def _plain(text: str) -> str:
    return _REF_LINE.sub("", _REF_PAREN.sub(" ", (text or "").translate(_SUPERS)))


def _f(raw: str) -> float:
    return float(raw.replace(",", ""))


def _find(text: str, pattern: str) -> Optional[float]:
    m = re.search(pattern, text, re.I)
    return _f(m.group(1)) if m else None


def _count(text: str, label: str, limit: float) -> Optional[float]:
    """Cell counts in K/uL whatever they were written in (18,000; 2.4 lakh; 245 K)."""
    m = re.search(rf"(?:{label})\s*:?\s*{_NUM}\s*(lakh)?", text, re.I)
    if not m:
        return None
    value = _f(m.group(1))
    if m.group(2):
        return value * 100
    return value / 1000 if value >= limit else value


_CREAT = r"\b(?:Cr|creat(?:inine)?)\b"


def parse(text: str, test_id: str = "") -> dict[str, float]:
    """The analytes this report states, in conventional units. Absent ones are left out."""
    t = _plain(text)
    out: dict[str, Optional[float]] = {
        "k": _find(t, rf"(?:\bK\+?|\bpotassium)\s+(?:of\s+)?{_NUM}"),
        "na": _find(t, rf"(?:\bNa\+?|\bsodium)\s+(?:of\s+)?{_NUM}"),
        "ca": _find(t, rf"(?:\bCa|\bcalcium)\s+{_NUM}"),
        "inr": _find(t, rf"\bINR\s+(?:of\s+)?{_NUM}"),
        "hb": _find(t, rf"\b(?:Hgb|Hb|ha?emoglobin)\s+{_NUM}"),
        "plt": _count(t, r"\bplt|\bplatelets?", 1000),
        "wbc": _count(t, r"\bWBC|\bTLC", 400),
        "anc": _count(t, r"\bANC|absolute neutrophil count", 30),
        "ph": _find(t, r"\bpH\s+([67]\.\d+)") if test_id != "urine" else None,
        "po2": _find(t, rf"\bpO2\s+{_NUM}"),
        "pco2": _find(t, rf"\bpCO2\s+{_NUM}"),
        "bicarb": _find(t, rf"(?:\bbicarb(?:onate)?|\bHCO3-?)\s+{_NUM}"),
        "lactate": _find(t, rf"\blactate\s+{_NUM}"),
        "ck": _find(t, rf"\b(?:CK|creatine kinase)\s*:?\s+{_NUM}"),
        "egfr": _find(t, rf"(?:eGFR|creatinine clearance)\s*(?:about\s+|of\s+|[<>]=?\s*)?{_NUM}"),
        "creat": _find(t, rf"{_CREAT}\s*(?:of\s+|:\s*)?{_NUM}"),
    }
    # "Sodium 137 on arrival, falling to 119": the later value is the one that matters.
    moved = r"\b(?:falling|fell|rising|rose|up|down)\b(?:\s+from\s+[\d.]+)?\s+to\s+"
    for name, label in (("na", r"(?:\bNa\+?|\bsodium)"), ("k", r"(?:\bK\+?|\bpotassium)"), ("creat", _CREAT)):
        later = _find(t, rf"{label}[^.;]{{0,60}}?{moved}{_NUM}")
        if later is not None:
            out[name] = later
    base = _find(t, rf"{_CREAT}\s+(?:rose|up|risen)\s+from\s+{_NUM}")
    if base is None:
        base = _find(t, rf"{_CREAT}[^;(]{{0,20}}\((?:up from|baseline|previous(?:ly)?)\s+{_NUM}")
    out["creatBase"] = base
    if test_id == "glucose" or re.search(r"\b(?:glucose|CBG)\b", t, re.I):
        vals = [_f(v) for v in re.findall(rf"(?:glucose|CBG|fasting|random|value|OGTT)\D{{0,12}}?{_NUM}\b(?!:)", t, re.I)]
        if test_id == "glucose":
            vals += [_f(v) for v in re.findall(rf"{_NUM}\s*mg/dL", t, re.I)]
        vals = [v for v in vals if 10 <= v <= 2000]
        if vals:
            out["glucoseMin"], out["glucoseMax"] = min(vals), max(vals)
    if test_id == "lactate":
        out["lactate"] = _find(t, rf"{_NUM}\s*mmol")
    if test_id == "troponin":
        out["troponin"] = _find(t, rf"{_NUM}\s*ng/L")
    if test_id == "lithium":
        out["lithium"] = _find(t, rf"{_NUM}\s*(?:mmol|mEq)")
    if test_id == "valproate":
        out["valproate"] = _find(t, rf"{_NUM}\s*(?:mcg|ug|mg)")
    if test_id == "tsb":
        out["bili"] = _find(t, rf"(?:bilirubin|total)\s*:?\s*{_NUM}")
    return {k: v for k, v in out.items() if v is not None}


def acute_rise(values: dict[str, float]) -> bool:
    """Creatinine at least 1.5 times its baseline: acute kidney injury until shown otherwise."""
    base, now = values.get("creatBase"), values.get("creat")
    return bool(base and now and now >= 1.5 * base)


# analyte -> (critical when <= this, critical when >= this)
CRITICAL_LIMITS: dict[str, tuple[Optional[float], Optional[float]]] = {
    "k": (2.5, 6.0), "na": (120, 160), "ca": (6.5, 13.0), "glucoseMin": (53, None), "glucoseMax": (None, 400),
    "hb": (6.9, None), "plt": (20, None), "wbc": (1.0, 100), "anc": (0.5, None), "inr": (None, 5.0),
    "ph": (7.20, 7.60), "po2": (55, None), "pco2": (None, 70), "bicarb": (10, None), "lactate": (None, 4.0),
    "creat": (None, 4.0), "ck": (None, 5000), "troponin": (None, 52), "lithium": (None, 1.5),
    "valproate": (None, 120), "bili": (None, 18),
}

_NEG_BEFORE = re.compile(r"\b(?:no|not|without|absent|negative for|nil|never|ruled out|excluded|denies)\b[^.;]{0,40}$", re.I)


def positive(text: str, pattern: str) -> bool:
    """True when `pattern` occurs and is not denied earlier in the same clause."""
    for m in re.finditer(pattern, text or "", re.I):
        sentence = re.split(r"[.;:\n]", text[: m.start()])[-1]
        tail = re.split(r"[.;:\n]", text[m.end():])[0]
        # "No A, B or C" denies all three; in "no fracture, small effusion" the comma ends the denial.
        listed = bool(re.match(r"[\w\s-]*(?:,[\w\s-]+)*\bor\b", tail))
        clause = sentence if listed else re.split(r",(?! or\b)", sentence)[-1]
        if not _NEG_BEFORE.search(clause):
            return True
    return False


# testId -> text that makes an abnormal report critical whatever its numbers say
CRITICAL_TEXT: dict[str, str] = {
    "blood-cx": r"isolated|identified|growth of|gram[- ](?:positive|negative)|positive for",
    "csf": r"gram[- ](?:positive|negative)|turbid|purulent",
    "wbct20": r"(?:not clotted|unclotted|incoagulable)",
    "coag": r"unrecordable|incoagulable|fibrinogen under",
    "cholinesterase": r"markedly low|severely low",
    "peripheral-smear": r"\bblasts\b|schistocytes",
    "ecg": r"STEMI|ventricular (?:tachycardia|fibrillation)|complete heart block|third[- ]degree|new LBBB|"
           r"peaked T|sine wave|torsade|QTc\s*5\d\d|acute ST[- ]elevation",
    "abg": r"severe (?:acidosis|hypoxa?emia)",
    "cbc": r"\bblasts\b",
}


def critical_reasons(test_id: str, text: str, abnormal: bool, age: Optional[float] = None) -> list[str]:
    """Why this result has to be telephoned through; empty when it does not."""
    if not abnormal:
        return []
    v = parse(text, test_id)
    out = []
    for name, (low, high) in CRITICAL_LIMITS.items():
        x = v.get(name)
        if x is None or (name == "bili" and (age is None or age >= 1)):
            continue
        if (low is not None and x <= low) or (high is not None and x >= high):
            out.append(f"{name} {x:g}")
    if acute_rise(v):
        out.append(f"creatinine {v['creat']:g} from {v['creatBase']:g}")
    pat = CRITICAL_TEXT.get(test_id)
    if pat and (positive(text, pat) or (test_id == "wbct20" and re.search(pat, text, re.I))):
        out.append("critical finding")
    return out


def egfr_ckd_epi(creat: float, age: float, gender: str) -> Optional[int]:
    """CKD-EPI 2021 for adults. Children need a height, which the record does not hold."""
    if age < 18 or creat <= 0:
        return None
    female = (gender or "").upper().startswith("F")
    k, a = (0.7, -0.241) if female else (0.9, -0.302)
    e = 142 * min(creat / k, 1) ** a * max(creat / k, 1) ** -1.200 * 0.9938 ** age
    return round(e * (1.012 if female else 1))


_NORMAL_RENAL = re.compile(
    r"renal function(?:, [^.]*)? (?:all )?normal|normal renal function|\bCr all within normal|"
    r"otherwise normal|(?:^|[.]\s*)normal\.?\s*$", re.I)


def renal_summary(text: str, age: Optional[float], gender: str) -> dict[str, Any]:
    """The renal_function answer for one stored chemistry report."""
    v = parse(text, "bmp")
    creat, egfr = v.get("creat"), v.get("egfr")
    estimated = False
    if egfr is None and creat is not None and age is not None:
        egfr = egfr_ckd_epi(creat, age, gender)
        estimated = egfr is not None
    stated_normal = bool(_NORMAL_RENAL.search((text or "").strip()))
    if creat is None and egfr is None and "k" not in v and not stated_normal:
        return {"available": False, "text": "The stored chemistry report does not state renal function."}
    parts = []
    out: dict[str, Any] = {"available": True}
    if creat is not None:
        out["creatinine"] = creat
        parts.append(f"creatinine {creat:g} mg/dL")
    if egfr is not None:
        out["egfr"] = int(egfr)
        parts.append(f"eGFR {int(egfr)} mL/min" + (" (CKD-EPI 2021)" if estimated else ""))
    if "k" in v:
        out["potassium"] = v["k"]
        parts.append(f"potassium {v['k']:g}")
    if acute_rise(v):
        out["acuteRise"] = True
        parts.append(f"risen from {v['creatBase']:g}")
    if creat is None and egfr is None:
        out["normal"] = stated_normal
        parts.append("renal function reported as normal" if stated_normal else "creatinine not stated")
    s = ", ".join(parts)
    out["text"] = s[0].upper() + s[1:] + "."
    return out
