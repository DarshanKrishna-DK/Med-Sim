"""Session language (en / hi / kn): locale mapping, Murf voices, filler phrases and
prompt language blocks shared by the voice, nurse, coach and teacher routes.

Voice data comes from the live Murf voice list (GET /v1/speech/voices?model=FALCON,
2026-11-21): every voice below lists the target locale in `supportedLocales`.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Optional

log = logging.getLogger("medsim.lang")

LANGS = ("en", "hi", "kn")
LOCALES = {"en": "en-IN", "hi": "hi-IN", "kn": "kn-IN"}
LANG_NAMES = {"en": "English", "hi": "Hindi", "kn": "Kannada"}

# Patient voice pools per language. English and Hindi share the en-IN pool
# (all of those voices list hi-IN), so a patient keeps the same voice when the
# language is switched. Kannada needs voices that list kn-IN.
PATIENT_VOICE_POOLS: dict[str, dict[str, list[str]]] = {
    "en": {
        "M": ["en-IN-aarav", "en-IN-nikhil", "en-IN-samar", "en-IN-abhinav", "en-IN-eashwar"],
        "F": ["en-IN-priya", "en-IN-pooja", "en-IN-anusha", "en-IN-isha", "en-IN-arohi", "en-IN-alia"],
    },
    "hi": {
        "M": ["en-IN-aarav", "en-IN-nikhil", "en-IN-samar", "en-IN-abhinav", "en-IN-eashwar"],
        "F": ["en-IN-priya", "en-IN-pooja", "en-IN-anusha", "en-IN-isha", "en-IN-arohi", "en-IN-alia"],
    },
    "kn": {
        "M": ["en-IN-nikhil", "en-IN-samar", "hi-IN-chirag", "hi-IN-pranav"],
        "F": ["en-IN-pooja", "hi-IN-poonam", "hi-IN-neeta", "hi-IN-jaya", "hi-IN-rachna", "kn-IN-harshitha"],
    },
}

# Nurse (female) voice per language; each lists the locale.
NURSE_VOICES = {"en": "en-IN-anisha", "hi": "en-IN-anisha", "kn": "kn-IN-harshitha"}

FILLERS: dict[str, list[str]] = {
    "en": ["Hmm...", "Haan, doctor...", "Umm, let me think...", "Achha...", "One second, doctor...",
           "Hmm, let me see...", "Okay, doctor...", "Umm... yes..."],
    "hi": ["हम्म...", "हाँ डॉक्टर...", "एक मिनट...", "अच्छा...", "हम्म, देखिए...", "जी डॉक्टर...",
           "एक सेकंड डॉक्टर...", "हाँ... जी..."],
    "kn": ["ಹ್ಮ್...", "ಹೌದು ಡಾಕ್ಟರ್...", "ಒಂದು ನಿಮಿಷ...", "ಅಚ್ಛಾ...", "ಹ್ಮ್, ನೋಡಿ...", "ಸರಿ ಡಾಕ್ಟರ್...",
           "ಒಂದು ಸೆಕೆಂಡ್ ಡಾಕ್ಟರ್...", "ಹೌದು... ಹೌದು..."],
}

FAILURE_MESSAGES = {
    "en": "Sorry doctor, I didn't catch that. Could you say it again?",
    "hi": "माफ़ कीजिए डॉक्टर, मैं सुन नहीं पाया। क्या आप दोबारा बोल सकते हैं?",
    "kn": "ಕ್ಷಮಿಸಿ ಡಾಕ್ಟರ್, ನನಗೆ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಇನ್ನೊಮ್ಮೆ ಹೇಳಿ.",
}


def norm_lang(value: Optional[str]) -> str:
    """'hi', 'hi-IN', 'HI' -> 'hi'. Anything unknown -> 'en'."""
    v = (value or "").strip().lower()[:2]
    return v if v in LANGS else "en"


def locale_for(lang: Optional[str]) -> str:
    return LOCALES[norm_lang(lang)]


def pick_patient_voice(lang: Optional[str], gender: str, case_id: Optional[str]) -> str:
    pool = PATIENT_VOICE_POOLS[norm_lang(lang)]["F" if gender == "F" else "M"]
    if not case_id:
        return pool[0]
    # Stable across runs (unlike hash(), which is salted per process).
    return pool[int(hashlib.sha1(case_id.encode()).hexdigest(), 16) % len(pool)]


def nurse_voice(lang: Optional[str]) -> str:
    return NURSE_VOICES[norm_lang(lang)]


def fillers(lang: Optional[str]) -> list[str]:
    return list(FILLERS[norm_lang(lang)])


def failure_message(lang: Optional[str]) -> str:
    return FAILURE_MESSAGES[norm_lang(lang)]


# ── prompt language blocks ─────────────────────────────────────────────────

_HI_RULES = (
    "LANGUAGE: Speak natural, everyday spoken Hindi, written in Devanagari script only (never Roman letters "
    "for Hindi words). Common English medical loanwords are natural in Hindi speech and allowed, for example "
    "BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. "
    "Keep sentences short and conversational, the way a person in India really talks to a doctor. "
    "Address the doctor respectfully as \"आप\". If the doctor switches to English or Kannada, reply in the "
    "language the doctor last spoke."
)
_KN_RULES = (
    "LANGUAGE: Speak natural, everyday spoken Kannada, written in Kannada script only (never Roman letters "
    "for Kannada words). Common English medical loanwords are natural in spoken Kannada and allowed, for "
    "example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. "
    "Keep sentences short and conversational, the way a person in Karnataka really talks to a doctor. "
    "Address the doctor respectfully as \"ನೀವು\". If the doctor switches to English or Hindi, reply in the "
    "language the doctor last spoke."
)

_ROLE_TAIL = {
    "patient": (
        "Your very first line and every reply must follow this language rule, even though the instructions "
        "above are written in English. No translations and no English duplicate of the same sentence."
    ),
    "nurse": (
        "Write only the final spoken confirmation in this language (max 30 words). Tool arguments, ids and "
        "plan text stay exactly as specified, in English."
    ),
    "coach": (
        "Write the free-text fields title, short, explanation and suggestion in this language. Keep the JSON "
        "keys and the severity values (info, warning, danger) in English."
    ),
    "teacher": (
        "Speak the whole lesson in this language. Medical terms may stay in English where doctors in India "
        "normally say them in English."
    ),
}


def language_block(lang: Optional[str], *, female: bool = False, role: str = "patient") -> str:
    """Prompt text that makes a persona speak the session language. Empty for English.
    Prompts stay English; only the output language changes."""
    lg = norm_lang(lang)
    if lg == "en":
        return ""
    out = [_HI_RULES if lg == "hi" else _KN_RULES, _ROLE_TAIL.get(role, _ROLE_TAIL["patient"])]
    if lg == "hi":
        out.append(
            "You are a woman: use feminine Hindi verb forms for yourself (\"मैं आई थी\", \"मैं कर रही हूँ\")."
            if female
            else "You are a man: use masculine Hindi verb forms for yourself (\"मैं आया था\", \"मैं कर रहा हूँ\")."
        )
    return "\n".join(out)


def with_language(system: str, lang: Optional[str], *, female: bool = False, role: str = "patient") -> str:
    block = language_block(lang, female=female, role=role)
    return f"{system}\n\n{block}" if block else system


# ── greeting translation ───────────────────────────────────────────────────

_greeting_cache: dict[tuple[str, str], str] = {}


def has_script(text: str, lang: str) -> bool:
    lo, hi = (0x0900, 0x097F) if lang == "hi" else (0x0C80, 0x0CFF)
    return any(lo <= ord(ch) <= hi for ch in text)


async def translate_line(text: str, lang: Optional[str]) -> str:
    """Translate a short opening line to hi/kn with one cheap LLM call (cached).
    On any failure returns the original text so the call never blocks."""
    lg = norm_lang(lang)
    if lg == "en" or not text.strip():
        return text
    key = (lg, text)
    if key in _greeting_cache:
        return _greeting_cache[key]

    from llm_provider import chat, strip_think

    sys_msg = (
        f"Translate the user's line into natural spoken {LANG_NAMES[lg]}, in {LANG_NAMES[lg]} script, as an "
        "Indian patient would say it to a doctor. Keep common English medical loanwords (BP, sugar, ECG, test) "
        "as they are. Reply with the translated line only: no quotes, no notes, no transliteration."
    )
    try:
        msg, _ = await asyncio.wait_for(
            chat(
                [{"role": "system", "content": sys_msg}, {"role": "user", "content": text}],
                max_tokens=300,
                temperature=0.2,
            ),
            timeout=8.0,
        )
        out = strip_think(msg.get("content") or "").strip().strip('"').strip()
    except Exception as e:  # noqa: BLE001
        log.warning("greeting translation failed (%s); using original", type(e).__name__)
        return text
    if not out or not has_script(out, lg):
        return text
    _greeting_cache[key] = out
    if len(_greeting_cache) > 256:
        _greeting_cache.pop(next(iter(_greeting_cache)))
    return out
