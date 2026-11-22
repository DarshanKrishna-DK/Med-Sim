"""Matching a spoken film report against finding keywords. Pure: shared by the marks
(radiology.py) and by Radiologist Vikram's own process (agentroom/radiology.py)."""

from __future__ import annotations

import re
from typing import Any, Iterable

_NEG = {"no", "not", "without", "absent", "nil", "negative", "none", "nor", "rule", "exclude"}
_CLAUSE = "|"
# Filler words dropped from both the text and the keywords ("angles are clear" == "angles clear").
_STOP = {"is", "are", "the", "a", "an", "seen", "there"}


def norm(text: Any) -> str:
    """Lower-case words; clause punctuation becomes a '|' token so negation never
    leaks across a comma or full stop ("no effusion, consolidation right base")."""
    t = str(text or "").lower()
    t = t.replace("’", "'")
    t = re.sub(r"[,.;:!?\n]+|\bbut\b|\bhowever\b", f" {_CLAUSE} ", t)
    t = re.sub(r"[^a-z0-9'|ऀ-෿]+", " ", t)
    return " ".join(w for w in t.split() if w not in _STOP)


def keyword_hit(text_n: str, keyword: str) -> bool:
    """True if `keyword` occurs in normalised text and is not negated just before it.
    Keywords that are themselves negative ("no midline shift") skip the negation check."""
    kw = norm(keyword)
    if not kw:
        return False
    kw_is_negative = bool(set(kw.split()) & _NEG)
    for m in re.finditer(r"(?:^|\s)" + re.escape(kw) + r"(?=\s|$)", text_n):
        if kw_is_negative:
            return True
        before = text_n[: m.start()].split(_CLAUSE)[-1].split()[-3:]
        if not (set(before) & _NEG):
            return True
    return False


def any_hit(text_n: str, keywords: Iterable[str]) -> bool:
    return any(keyword_hit(text_n, k) for k in keywords)
