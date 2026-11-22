"""Free text as the teacher may see it: no quotation from a consultation, no titled name, no age.
Standard library only: used by the API process and by the workers."""

from __future__ import annotations

import re

_TITLED = re.compile(r"\b(?:mr|mrs|ms|miss|master|baby|dr|smt|shri|sri)\.?\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?", re.IGNORECASE)
_QUOTED = re.compile("[\"“‘][^\"“”’]{3,}[\"”’]")
_AGE = re.compile(r"\b(?:an?\s+)?\d{1,3}[- ]?(?:year|yr)s?[- ]?old\b|\b\d{1,3}\s?[MF]\b")


def for_teacher(line: str) -> str:
    out = _AGE.sub(" ", _TITLED.sub("the patient", _QUOTED.sub(" ", line or "")))
    return re.sub(r"\s*,(?:\s*,)+", ",", re.sub(r"\s+", " ", out)).replace(" ,", ",").strip(" ,.;:")
