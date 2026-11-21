"""Real-database drug safety check: RxNorm/RxClass (NIH NLM) + openFDA drug label.

The RxNav /REST/interaction API was discontinued in Jan 2024, so interactions
come from the FDA label text instead. check_drug never raises.
"""
from __future__ import annotations

import asyncio
import re
import time
from urllib.parse import quote

import httpx

RX = "https://rxnav.nlm.nih.gov/REST"
FDA = "https://api.fda.gov/drug/label.json"
TTL = 6 * 3600
_cache: dict[str, tuple[float, dict]] = {}
_STEMS = {"penicillin": "penicillin", "sulfa": "sulfonamide", "sulfonamide": "sulfonamide",
          "nsaid": "anti-inflammatory", "anti-inflammatory": "anti-inflammatory"}


def _client_factory() -> httpx.AsyncClient:
    """Tests patch this to inject httpx.MockTransport."""
    return httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0))


def normalise(name: str) -> str:
    """'Amoxicillin 500mg tablet' -> 'amoxicillin'."""
    s = re.sub(r"\b\d[\d.,/]*\s*(mg|mcg|g|ml|iu|units?|%)\b.*", "", name.lower())
    s = re.sub(r"\b(tablets?|capsules?|syrup|injection|cream|ointment|oral)\b", "", s)
    return re.sub(r"\s+", " ", s).strip(" ,-/")


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z][a-z-]+", text.lower()) if len(t) > 2}


def _stem(t: str) -> str:
    return _STEMS.get(t, _STEMS.get(t.rstrip("s"), t.rstrip("s")))


_STOPWORDS = {"drug", "drugs", "allergy", "allergies", "allergic", "known", "medicine", "medicines",
              "reaction", "reactions", "any", "to", "the"}
_NEGATED_START = re.compile(r"^\W*(?:no|none|nil|nkda|nkfda|not|denies|denied)\b", re.IGNORECASE)
_NEGATED_ANY = re.compile(r"\b(?:no known|not allergic|denies|denied)\b", re.IGNORECASE)


def strip_negated(allergies: str) -> str:
    """Drop clauses that deny an allergy ('No known drug allergies', 'denies any', 'nil')."""
    keep = []
    for clause in re.split(r"[.;,\n]+", allergies or ""):
        c = clause.strip()
        if c and not (_NEGATED_START.search(c) or _NEGATED_ANY.search(c)):
            keep.append(c)
    return ", ".join(keep)


def is_negated_allergy(allergies: str) -> bool:
    """True when the allergy text is empty or only says there is no allergy."""
    return not _tokens(strip_negated(allergies)) - _STOPWORDS


def _allergy_conflict(drug: str, classes: list[str], allergies: str) -> str | None:
    if is_negated_allergy(allergies):
        return None
    toks = _tokens(strip_negated(allergies)) - _STOPWORDS
    if not toks:
        return None
    for t in toks:
        if t in drug or drug in t:
            return f"Patient has a documented allergy mentioning {t}; drug is {drug.title()}"
    stems = {_stem(t) for t in toks}
    for c in classes:
        for s in stems:
            if len(s) > 3 and s in c.lower():
                return f"{drug.title()} is in the {c} class; patient allergy: {allergies.strip()}"
    return None


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.;])\s+", re.sub(r"\s+", " ", text)) if s.strip()]


def _interactions(label: dict, meds: list[str]) -> list[dict]:
    text = " ".join(label.get("drug_interactions", []) + label.get("contraindications", []))
    sents, out = _sentences(text), []
    for med in meds:
        m = normalise(med)
        hit = next((s for s in sents if m and m in s.lower()), None)
        if hit:
            out.append({"with": med, "excerpt": hit[:220]})
        if len(out) == 3:
            break
    return out


async def _rx(c: httpx.AsyncClient, name: str) -> tuple[str | None, list[str]]:
    q = quote(name)
    r = await c.get(f"{RX}/rxcui.json?name={q}")
    r.raise_for_status()
    ids = r.json().get("idGroup", {}).get("rxnormId") or []
    if not ids:
        r = await c.get(f"{RX}/approximateTerm.json?term={q}&maxEntries=1")
        r.raise_for_status()
        cands = r.json().get("approximateGroup", {}).get("candidate") or []
        ids = [cands[0]["rxcui"]] if cands else []
    r = await c.get(f"{RX}/rxclass/class/byDrugName.json?drugName={q}&relaSource=ATC")
    classes: list[str] = []
    if r.status_code == 200 and r.content:
        for i in r.json().get("rxclassDrugInfoList", {}).get("rxclassDrugInfo", []):
            n = i["rxclassMinConceptItem"]["className"]
            if n not in classes:
                classes.append(n)
    return (ids[0] if ids else None), classes


async def _fda(c: httpx.AsyncClient, name: str) -> dict:
    r = await c.get(FDA, params={"search": f'openfda.generic_name:"{name}"', "limit": 1})
    if r.status_code == 404:  # openFDA uses 404 for "no matches"
        return {}
    r.raise_for_status()
    res = r.json().get("results") or []
    return res[0] if res else {}


async def _lookup(name: str) -> dict:
    async with _client_factory() as c:
        (rxcui, classes), label = await asyncio.gather(_rx(c, name), _fda(c, name))
    epc = [x.replace(" [EPC]", "") for x in label.get("openfda", {}).get("pharm_class_epc", [])]
    classes += [x for x in epc if x not in classes]
    boxed = re.sub(r"\s+", " ", " ".join(label.get("boxed_warning", [])))
    return {"rxcui": rxcui, "classes": classes, "label": label, "boxed": boxed[:220] or None}


async def check_drug(drug_name: str, allergies_text: str, current_meds: list[str]) -> dict:
    try:
        name = normalise(drug_name)
        if not name:
            return {"ok": False, "error": "empty drug name"}
        hit = _cache.get(name)
        if not hit or time.time() - hit[0] > TTL:
            hit = (time.time(), await asyncio.wait_for(_lookup(name), timeout=6.0))
            _cache[name] = hit
        d = hit[1]
        if not d["rxcui"] and not d["label"]:
            return {"ok": False, "error": f"{name} not found in RxNorm or openFDA"}
        return {
            "ok": True, "drug": name, "rxcui": d["rxcui"], "classes": d["classes"],
            "allergyConflict": _allergy_conflict(name, d["classes"], allergies_text or ""),
            "interactions": _interactions(d["label"], current_meds or []),
            "boxedWarning": d["boxed"],
            "sources": [
                {"name": "RxNorm/RxClass (NIH NLM)", "url": f"{RX}/rxcui.json?name={quote(name)}"},
                {"name": "openFDA drug label", "url": f'{FDA}?search=openfda.generic_name:"{quote(name)}"&limit=1'},
            ],
        }
    except Exception as e:  # never raise; caller falls back to the local catalogue
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}
