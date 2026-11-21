"""Server-side copy of the frontend catalogues a generated case may reference:
specialties (src/game/clinic.ts), tests (src/data/tests.ts) and treatments
(src/data/treatments.ts). Stored in backend/data/case_catalog.json so the
backend needs no TypeScript at runtime.

Regenerate after editing those TS files:
    backend/.venv/Scripts/python.exe backend/catalog.py --write
backend/tests/test_case_author.py fails when the JSON drifts from the TS.
"""
from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

_BACKEND = Path(__file__).resolve().parent
_ROOT = _BACKEND.parent
CATALOG_FILE = _BACKEND / "data" / "case_catalog.json"

# Virtual or special buckets a Telegram-authored outpatient case should not land in.
EXCLUDED_SPECIALTIES = {"all-specialties", "communication-skills"}

_ENTRY = re.compile(r"\{\s*id:\s*'([^']+)',\s*name:\s*'((?:[^'\\]|\\.)*)'")


def _labels(clinic_ts: str) -> dict[str, str]:
    block = clinic_ts.split("CLINIC_LABELS", 1)[1].split("};", 1)[0]
    out: dict[str, str] = {}
    for m in re.finditer(r"^\s*'?([a-z0-9-]+)'?\s*:\s*'((?:[^'\\]|\\.)*)'", block, re.M):
        out[m.group(1)] = m.group(2).replace("\\'", "'")
    return out


def parse_sources(root: Path = _ROOT) -> dict[str, Any]:
    """Build the catalogue straight from the TypeScript sources."""
    clinic = (root / "src" / "game" / "clinic.ts").read_text(encoding="utf-8")
    order_block = clinic.split("CLINIC_IDS: ClinicId[] = [", 1)[1].split("];", 1)[0]
    order = re.findall(r"'([a-z0-9-]+)'", order_block)
    labels = _labels(clinic)
    specialties = [{"id": i, "label": labels[i]} for i in order if i not in EXCLUDED_SPECIALTIES]

    def entries(rel: str, array: str) -> list[dict[str, str]]:
        src = (root / rel).read_text(encoding="utf-8")
        block = src.split(f"export const {array}", 1)[1].split("];", 1)[0]
        return [{"id": m.group(1), "name": m.group(2).replace("\\'", "'")} for m in _ENTRY.finditer(block)]

    return {
        "specialties": specialties,
        "tests": entries("src/data/tests.ts", "TESTS"),
        "treatments": entries("src/data/treatments.ts", "TREATMENTS"),
    }


@lru_cache(maxsize=1)
def load() -> dict[str, Any]:
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def specialties() -> list[dict[str, str]]:
    return load()["specialties"]


def specialty_label(sid: str) -> str:
    return next((s["label"] for s in specialties() if s["id"] == sid), sid)


def test_ids() -> set[str]:
    return {t["id"] for t in load()["tests"]}


def treatment_ids() -> set[str]:
    return {t["id"] for t in load()["treatments"]}


def write() -> Path:
    CATALOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CATALOG_FILE.write_text(json.dumps(parse_sources(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    load.cache_clear()
    return CATALOG_FILE


if __name__ == "__main__":
    if "--write" in sys.argv:
        p = write()
        c = load()
        print(f"wrote {p}: {len(c['specialties'])} specialties, {len(c['tests'])} tests, {len(c['treatments'])} treatments")
    else:
        print(json.dumps(parse_sources(), indent=1, ensure_ascii=False))
