"""Write nurse orders to a public HL7 FHIR R4 test server. Never raises to callers."""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

log = logging.getLogger("medsim.fhir")

_IST = timezone(timedelta(hours=5, minutes=30))
_TAG = {"system": "https://medsim.app/tags", "code": "medsim-synthetic"}
_CASE_SYS = "https://medsim.app/case"
_patient_cache: dict[str, str] = {}


def _base() -> str:
    return os.environ.get("FHIR_BASE_URL", "https://hapi.fhir.org/baseR4").rstrip("/")


def _enabled() -> bool:
    return os.environ.get("FHIR_ENABLED", "1").strip() != "0"


def _client_factory() -> httpx.AsyncClient:
    """Indirection so tests can inject a mock transport."""
    return httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=4.0))


async def _post(rtype: str, body: dict, extra_headers: Optional[dict] = None) -> Optional[dict]:
    if not _enabled():
        return None
    headers = {"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"}
    headers.update(extra_headers or {})
    try:
        async with _client_factory() as client:
            resp = await client.post(f"{_base()}/{rtype}", json=body, headers=headers)
        if resp.status_code >= 300:
            log.warning("FHIR %s POST failed: HTTP %s", rtype, resp.status_code)
            return None
        data = resp.json() if resp.content else {}
        rid = data.get("id")
        if not rid:  # some servers return an empty body; fall back to Location
            loc = resp.headers.get("location", "")
            parts = loc.split("/_history")[0].rstrip("/").split("/")
            rid = parts[-1] if parts and parts[-1] else None
        if not rid:
            log.warning("FHIR %s POST returned no id", rtype)
            return None
        return {"ok": True, "resourceType": rtype, "id": rid, "url": f"{_base()}/{rtype}/{rid}"}
    except Exception as e:  # noqa: BLE001 - FHIR must never break the nurse
        log.warning("FHIR %s POST error: %s", rtype, e)
        return None


async def ensure_patient(case_id: str, name: str, age, gender: str) -> Optional[str]:
    if not _enabled():
        return None
    if case_id in _patient_cache:
        return _patient_cache[case_id]
    try:
        birth_year = datetime.now(_IST).year - int(age)
    except (TypeError, ValueError):
        birth_year = None
    g = (gender or "").strip().upper()[:1]
    body: dict = {
        "resourceType": "Patient",
        "meta": {"tag": [_TAG]},
        "identifier": [{"system": _CASE_SYS, "value": case_id}],
        "name": [{"text": name}],
        "gender": {"M": "male", "F": "female"}.get(g, "unknown"),
    }
    if birth_year:
        body["birthDate"] = str(birth_year)
    rec = await _post("Patient", body, {"If-None-Exist": f"identifier={_CASE_SYS}|{case_id}"})
    if not rec:
        return None
    _patient_cache[case_id] = rec["id"]
    return rec["id"]


_ORDER_SYS = "https://medsim.app/order"


def _order_meta() -> dict:
    """Unique id + timestamp per order. HAPI rejects byte-identical resources
    (HAPI-2840), and a repeat order is a real new order anyway."""
    return {
        "identifier": [{"system": _ORDER_SYS, "value": secrets.token_hex(8)}],
        "authoredOn": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


async def record_service_request(patient_id: str, test_name: str, test_id: str = "") -> Optional[dict]:
    body = {
        "resourceType": "ServiceRequest",
        "meta": {"tag": [_TAG]},
        "status": "active",
        "intent": "order",
        "code": {"text": test_name},
        "subject": {"reference": f"Patient/{patient_id}"},
    }
    body.update(_order_meta())
    if test_id:
        body["code"]["coding"] = [{"system": "https://medsim.app/tests", "code": test_id}]
    return await _post("ServiceRequest", body)


async def record_medication_request(patient_id: str, med_name: str, dose: str, duration: str) -> Optional[dict]:
    body = {
        "resourceType": "MedicationRequest",
        "meta": {"tag": [_TAG]},
        "status": "active",
        "intent": "order",
        "medicationCodeableConcept": {"text": med_name},
        "subject": {"reference": f"Patient/{patient_id}"},
        "dosageInstruction": [{"text": f"{dose} for {duration}"}],
    }
    body.update(_order_meta())
    return await _post("MedicationRequest", body)


async def record_appointment(patient_id: str, in_days: int, reason: str) -> Optional[dict]:
    day = datetime.now(_IST) + timedelta(days=int(in_days))
    start = day.replace(hour=10, minute=0, second=0, microsecond=0)
    body = {
        "resourceType": "Appointment",
        "meta": {"tag": [_TAG]},
        "status": "booked",
        "description": reason,
        "start": start.isoformat(timespec="seconds"),
        "end": (start + timedelta(minutes=15)).isoformat(timespec="seconds"),
        "participant": [{"actor": {"reference": f"Patient/{patient_id}"}, "status": "accepted"}],
    }
    meta = _order_meta()
    body["identifier"] = meta["identifier"]
    body["created"] = meta["authoredOn"]
    return await _post("Appointment", body)


async def record_batch(case: dict, tests: list, meds: list, follow_up: Optional[dict] = None) -> list[dict]:
    """Ensure the patient, then post all orders concurrently. Bounded to about 7s."""
    if not _enabled():
        return []

    async def run() -> list[dict]:
        pid = await ensure_patient(case.get("id", ""), case.get("name", "Synthetic Patient"),
                                   case.get("age"), case.get("gender", ""))
        if not pid:
            return []
        jobs = [record_service_request(pid, name, tid) for tid, name in tests]
        jobs += [record_medication_request(pid, m.get("name", ""), m.get("dose", ""), m.get("duration", ""))
                 for m in meds]
        if follow_up:
            jobs.append(record_appointment(pid, follow_up.get("inDays", 7), follow_up.get("reason", "Follow-up")))
        results = await asyncio.gather(*jobs, return_exceptions=True)
        return [r for r in results if isinstance(r, dict) and r.get("ok")]

    try:
        return await asyncio.wait_for(run(), timeout=7.0)
    except Exception as e:  # noqa: BLE001
        log.warning("FHIR batch failed: %s", e)
        return []
