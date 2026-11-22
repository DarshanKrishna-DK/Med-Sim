"""The blood bank's rules: ABO and Rh compatibility of red cells, antibody-negative
selection, and which units to issue. Pure and deterministic, no model involved.

Only the laboratory reads data/bloodbank.json. Training simulator rules, not a
transfusion protocol.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from .base import load_json

# Recipient ABO group -> donor red cell groups that may be given, best match first.
RED_CELLS: dict[str, tuple[str, ...]] = {
    "O": ("O",),
    "A": ("A", "O"),
    "B": ("B", "O"),
    "AB": ("AB", "A", "B", "O"),
}
MAX_UNITS = 4

_GROUP = re.compile(r"^\s*(AB|A|B|O)\s*(\+|-|pos(?:itive)?|neg(?:ative)?)?\s*(?:rh\s*(?:d\s*)?)?(\+|-|pos(?:itive)?|neg(?:ative)?)?\s*$", re.I)


def parse_group(text: Any) -> Optional[tuple[str, str]]:
    """('B', '-') from "B neg", "B-", "b rh negative". None when it is not a full group."""
    m = _GROUP.match(str(text or "").replace("−", "-"))
    rh = (m.group(2) or m.group(3) or "") if m else ""
    if not m or not rh:
        return None
    return m.group(1).upper(), "+" if rh[0] in "+pP" else "-"


def label(abo: str, rh: str) -> str:
    return f"{abo} {'positive' if rh == '+' else 'negative'}"


def compatible(recipient: tuple[str, str], donor: tuple[str, str]) -> bool:
    """Red cells: the donor's ABO antigens must all be the recipient's own, and a Rh negative
    recipient gets Rh negative cells only."""
    return donor[0] in RED_CELLS.get(recipient[0], ()) and (donor[1] == "-" or recipient[1] == "+")


@dataclass(frozen=True)
class Patient:
    abo: str
    rh: str
    sample: str                   # 'valid': a group and screen sample is held; 'none': there is not
    antibodies: tuple[str, ...]

    @property
    def group(self) -> tuple[str, str]:
        return self.abo, self.rh


class BloodBank:
    def __init__(self, data: Optional[dict[str, Any]] = None) -> None:
        d = data if data is not None else load_json("bloodbank.json")
        self._patients = {
            k: Patient(p["abo"], p["rh"], p.get("sample", "none"), tuple(p.get("antibodies") or ()))
            for k, p in d["patients"].items()
        }
        self.stock: list[dict[str, Any]] = list(d["stock"])

    def patient(self, case_id: str) -> Optional[Patient]:
        return self._patients.get(case_id)

    def choose(self, p: Patient, count: int, used: Iterable[str] = ()) -> list[dict[str, Any]]:
        """Units to cross-match: compatible, negative for the patient's antibodies, the patient's own
        group first, and Rh negative cells kept for Rh negative patients where possible."""
        gone = set(used)
        order = RED_CELLS.get(p.abo, ())
        fit = [u for u in self.stock
               if u["unit"] not in gone and compatible(p.group, (u["abo"], u["rh"])) and set(p.antibodies) <= set(u.get("neg") or ())]
        fit.sort(key=lambda u: (order.index(u["abo"]), u["rh"] != p.rh, u["unit"]))
        return fit[: max(1, min(MAX_UNITS, count))]

    def emergency(self, count: int, used: Iterable[str] = ()) -> list[dict[str, Any]]:
        """O Rh negative, uncrossmatched."""
        gone = set(used)
        return [u for u in self.stock if (u["abo"], u["rh"]) == ("O", "-") and u["unit"] not in gone][: max(1, min(MAX_UNITS, count))]
