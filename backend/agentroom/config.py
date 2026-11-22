"""BAND settings, read from the environment at call time (never logged)."""

from __future__ import annotations

import os

from .protocol import NURSE, ROLES

DEFAULT_REST_URL = "https://app.band.ai"


def api_key(role: str) -> str:
    info = ROLES.get(role)
    return (os.environ.get(info.key_env) or "").strip() if info else ""


def enabled() -> bool:
    """The room exists only when Asha has her own BAND identity."""
    return bool(api_key(NURSE))


def disabled_reason() -> str | None:
    return None if enabled() else f"{ROLES[NURSE].key_env} is not set"


def rest_url() -> str:
    return (os.environ.get("BAND_REST_URL") or DEFAULT_REST_URL).strip().rstrip("/")


def ws_url() -> str | None:
    return (os.environ.get("BAND_WS_URL") or "").strip() or None


def workers_mode() -> str:
    """spawn (default) | external | off"""
    v = (os.environ.get("BAND_WORKERS") or "spawn").strip().lower()
    return v if v in ("spawn", "external", "off") else "spawn"


def room_url(room_id: str) -> str:
    return f"{rest_url()}/rooms/{room_id}"
