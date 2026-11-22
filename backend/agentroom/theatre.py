"""Theatre Sister Leela's side room: one per operation theatre drill.

The drill itself runs in the browser (src/ot/engine.ts) and stays deterministic. What
comes from other people is asked here: the laboratory's cross-match before packed cells
run, the pharmacist's word on the recorded allergy, and a human consultant when the
student calls for help. Answers reach the browser as the side room's state, which it
feeds to the engine as events; a drill never waits longer than its own fallback.

Side room kind "theatre" (owner: theatre). Actions: blood, sample, unconfirmed, allergy, help.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

import lang as langmod

from . import bedside, client as band_client, siderooms
from .hub import Hub
from .protocol import FACULTY, LAB, PHARMACIST, THEATRE, Handoff
from .siderooms import Kind, Reply, SideRoom

log = logging.getLogger("medsim.room.theatre")

KIND = "theatre"
XM_TIMEOUT_S = 30.0       # the browser has moved on after 12 s; a later answer is still recorded
SAMPLE_TIMEOUT_S = 90.0
RX_TIMEOUT_S = 20.0
SCENARIOS = re.compile(r"ot-[a-z0-9-]{2,30}")

# Leela's own lines. {name} person, {text} their words.
T: dict[str, dict[str, str]] = {
    "asked": {
        "en": "I have asked the lab for blood. Waiting for the cross-match.",
        "hi": "मैंने लैब से खून माँगा है। क्रॉस मैच का इंतज़ार है।",
        "kn": "ಲ್ಯಾಬ್‌ನಿಂದ ರಕ್ತ ಕೇಳಿದ್ದೇನೆ. ಕ್ರಾಸ್ ಮ್ಯಾಚ್‌ಗಾಗಿ ಕಾಯುತ್ತಿದ್ದೇನೆ.",
        "ta": "லேபிடம் இரத்தம் கேட்டிருக்கிறேன். கிராஸ் மேட்சுக்காகக் காத்திருக்கிறேன்.",
        "te": "ల్యాబ్‌ను రక్తం అడిగాను. క్రాస్ మ్యాచ్ కోసం ఎదురు చూస్తున్నాను.",
        "mr": "मी लॅबकडे रक्त मागितले आहे. क्रॉस मॅचची वाट पाहतेय.",
        "bn": "ল্যাবের কাছে রক্ত চেয়েছি। ক্রস ম্যাচের অপেক্ষায় আছি।",
    },
    "sample_sent": {
        "en": "The labelled sample is on its way to the lab.",
        "hi": "लेबल लगा सैंपल लैब भेज दिया है।",
        "kn": "ಲೇಬಲ್ ಇರುವ ಸ್ಯಾಂಪಲ್ ಲ್ಯಾಬ್‌ಗೆ ಕಳುಹಿಸಿದ್ದೇನೆ.",
        "ta": "லேபிள் ஒட்டிய மாதிரியை லேபுக்கு அனுப்பிவிட்டேன்.",
        "te": "లేబుల్ ఉన్న శాంపిల్ ల్యాబ్‌కు పంపాను.",
        "mr": "लेबल लावलेला नमुना लॅबला पाठवला आहे.",
        "bn": "লেবেল লাগানো নমুনা ল্যাবে পাঠিয়ে দিয়েছি।",
    },
    "unconfirmed": {
        "en": "The lab has not answered in time. This blood is issued without cross-match confirmation.",
        "hi": "लैब का जवाब समय पर नहीं आया। यह खून क्रॉस मैच की पुष्टि के बिना चढ़ाया जा रहा है।",
        "kn": "ಲ್ಯಾಬ್ ಸಮಯಕ್ಕೆ ಉತ್ತರಿಸಿಲ್ಲ. ಈ ರಕ್ತ ಕ್ರಾಸ್ ಮ್ಯಾಚ್ ದೃಢೀಕರಣವಿಲ್ಲದೆ ಕೊಡಲಾಗುತ್ತಿದೆ.",
        "ta": "லேப் சரியான நேரத்தில் பதில் தரவில்லை. இந்த இரத்தம் கிராஸ் மேட்ச் உறுதி இல்லாமல் ஏற்றப்படுகிறது.",
        "te": "ల్యాబ్ సమయానికి జవాబు ఇవ్వలేదు. ఈ రక్తం క్రాస్ మ్యాచ్ నిర్ధారణ లేకుండా ఎక్కిస్తున్నాం.",
        "mr": "लॅबचे उत्तर वेळेत आले नाही. हे रक्त क्रॉस मॅचच्या खात्रीशिवाय दिले जात आहे.",
        "bn": "ল্যাব সময়ে উত্তর দেয়নি। এই রক্ত ক্রস ম্যাচ নিশ্চিত না করেই দেওয়া হচ্ছে।",
    },
    "help_called": {
        "en": "I have called {name} and told them the situation.",
        "hi": "मैंने {name} को बुलाया है और स्थिति बता दी है।",
        "kn": "{name} ಅವರನ್ನು ಕರೆದು ಪರಿಸ್ಥಿತಿ ತಿಳಿಸಿದ್ದೇನೆ.",
        "ta": "{name} அவர்களை அழைத்து நிலைமையைச் சொல்லிவிட்டேன்.",
        "te": "{name} గారిని పిలిచి పరిస్థితి చెప్పాను.",
        "mr": "मी {name} यांना बोलावून परिस्थिती सांगितली आहे.",
        "bn": "আমি {name} কে ডেকে পরিস্থিতি জানিয়েছি।",
    },
    "help_none": {
        "en": "I could not reach the consultant. Carry on with the team here.",
        "hi": "कंसल्टेंट से बात नहीं हो पाई। यहाँ की टीम के साथ आगे बढ़िए।",
        "kn": "ಕನ್ಸಲ್ಟೆಂಟ್ ಸಿಗಲಿಲ್ಲ. ಇಲ್ಲಿನ ತಂಡದೊಂದಿಗೆ ಮುಂದುವರಿಸಿ.",
        "ta": "கன்சல்டன்டைத் தொடர்பு கொள்ள முடியவில்லை. இங்குள்ள குழுவுடன் தொடருங்கள்.",
        "te": "కన్సల్టెంట్ దొరకలేదు. ఇక్కడి బృందంతో కొనసాగించండి.",
        "mr": "कन्सल्टंटशी संपर्क झाला नाही. इथल्या टीमसोबत पुढे चला.",
        "bn": "কনসালট্যান্টকে পাওয়া গেল না। এখানকার দলের সঙ্গেই এগিয়ে চলুন।",
    },
    "reply": {
        "en": "{name} says: {text}",
        "hi": "{name} कह रहे हैं: {text}",
        "kn": "{name} ಹೇಳುತ್ತಿದ್ದಾರೆ: {text}",
        "ta": "{name} சொல்கிறார்: {text}",
        "te": "{name} చెబుతున్నారు: {text}",
        "mr": "{name} सांगत आहेत: {text}",
        "bn": "{name} বলছেন: {text}",
    },
    "reply_plain": {
        "en": "{name} has answered in the theatre room. Please read it.",
        "hi": "{name} ने थिएटर रूम में जवाब दिया है। कृपया पढ़ लीजिए।",
        "kn": "{name} ಥಿಯೇಟರ್ ರೂಮ್‌ನಲ್ಲಿ ಉತ್ತರಿಸಿದ್ದಾರೆ. ದಯವಿಟ್ಟು ಓದಿ.",
        "ta": "{name} தியேட்டர் அறையில் பதில் அளித்துள்ளார். தயவுசெய்து படியுங்கள்.",
        "te": "{name} థియేటర్ రూమ్‌లో జవాబు ఇచ్చారు. దయచేసి చదవండి.",
        "mr": "{name} यांनी थिएटर रूममध्ये उत्तर दिले आहे. कृपया वाचा.",
        "bn": "{name} থিয়েটার রুমে উত্তর দিয়েছেন। দয়া করে পড়ে নিন।",
    },
    "rx_silent": {
        "en": "Pharmacy has not answered. The allergy check is not confirmed.",
        "hi": "फार्मेसी का जवाब नहीं आया। एलर्जी की जाँच पक्की नहीं हुई है।",
        "kn": "ಫಾರ್ಮಸಿ ಉತ್ತರಿಸಿಲ್ಲ. ಅಲರ್ಜಿ ಪರಿಶೀಲನೆ ದೃಢವಾಗಿಲ್ಲ.",
        "ta": "ஃபார்மசி பதில் தரவில்லை. ஒவ்வாமை சரிபார்ப்பு உறுதியாகவில்லை.",
        "te": "ఫార్మసీ జవాబు ఇవ్వలేదు. అలర్జీ పరిశీలన నిర్ధారణ కాలేదు.",
        "mr": "फार्मसीचे उत्तर आले नाही. ॲलर्जी तपासणी पक्की झालेली नाही.",
        "bn": "ফার্মেসি উত্তর দেয়নি। অ্যালার্জি যাচাই নিশ্চিত হয়নি।",
    },
}


def line(key: str, lang: Optional[str], **kw: str) -> str:
    return re.sub(r"\s+", " ", T[key][langmod.norm_lang(lang)].format(**{"name": "", "text": "", **kw})).strip()


def _int(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _clip(v: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def check(ref_id: str, context: dict[str, Any]) -> dict[str, Any]:
    scenario = str(context.get("scenarioId") or "")
    if not SCENARIOS.fullmatch(scenario):
        raise ValueError("unknown operation")
    return {"scenarioId": scenario}


# ── blood ──────────────────────────────────────────────────────────────────


async def blood(side: SideRoom, data: dict[str, Any]) -> dict[str, Any]:
    """Packed cells: ask the laboratory, and report what it releases. `n` is the browser's request number."""
    n, units, emergency = _int(data.get("n"), 1, 99, 1), _int(data.get("units"), 1, 4, 1), data.get("emergency") is True
    ref = side.ref("xm")
    side.update(blood={"n": n, "ref": ref, "status": "waiting", "emergency": emergency, "units": [], "group": "", "text": ""})
    if not emergency:
        side.speak(line("asked", side.lang), priority="ack", ref=ref)
    side.hub.spawn(_blood(side, n, ref, units, emergency), "theatre blood")
    return {"ref": ref}


async def _blood(side: SideRoom, n: int, ref: str, units: int, emergency: bool) -> None:
    what = f"{units} unit{'s' if units > 1 else ''} of packed red cells"
    text = (f"EMERGENCY: O negative, {what}, going up now without cross-match. Please record it." if emergency
            else f"Please group, screen and cross-match {what} for the patient on the table.")
    r = await side.request(LAB, "crossmatch", text, {"caseId": side.context.get("scenarioId", ""), "product": "packed red cells",
                                                     "units": units, "emergency": emergency},
                           ref=ref, timeout=XM_TIMEOUT_S, label=("Emergency O negative" if emergency else f"Cross-match, {what}"),
                           why="Adding the laboratory: blood is needed in theatre")
    if r.ok and r.kind == "query":
        side.memory["sampleRef"] = ref
        _set_blood(side, ref, "sample", r)
        r = await side.wait(ref, SAMPLE_TIMEOUT_S)
        if r.ok:
            side.set_delegation(ref, "done", r.text)
    settle_blood(side, ref, r)


def settle_blood(side: SideRoom, ref: str, r: Reply) -> None:
    status = str(r.data.get("status") or "") if r.ok and r.kind == "result" else ""
    if status not in ("released", "emergency", "incompatible", "unavailable"):
        status = "no_reply"
    if status == "released" and r.data.get("compatible") is not True:
        status = "unavailable"  # "released" without a compatible cross-match is not a release
    _set_blood(side, ref, status, r)


def _set_blood(side: SideRoom, ref: str, status: str, r: Reply) -> None:
    b = dict(side.state.get("blood") or {})
    if b.get("ref") != ref:
        return  # a newer request has taken over
    units = [{"unit": _clip(u.get("unit"), 20), "group": _clip(u.get("group"), 20)} for u in r.data.get("units") or [] if isinstance(u, dict)][:4] \
        if isinstance(r.data.get("units"), list) else []
    b.update(status=status, units=units, group=_clip(r.data.get("group"), 20), text=_clip(bedside.clean_spoken(r.text, 400), 300))
    side.update(blood=b)
    if r.spoken:
        side.speak(r.spoken, speaker=LAB, priority="urgent" if status in ("sample", "incompatible", "unavailable") else "result", ref=ref)


async def sample(side: SideRoom, data: dict[str, Any]) -> None:
    ref = str(side.memory.get("sampleRef") or "")
    b = side.state.get("blood") or {}
    if not ref or b.get("ref") != ref or b.get("status") != "sample":
        raise ValueError("the laboratory has not asked for a sample")
    side.update(blood={**b, "status": "matching"})
    try:
        await side.post(LAB, "Labelled group and cross-match sample sent to you now.",
                        Handoff("answer", "crossmatch", ref, data={"sample": True}))
    except band_client.BandError:
        side.update(blood=b)
        raise
    side.speak(line("sample_sent", side.lang), priority="ack")


async def unconfirmed(side: SideRoom, data: dict[str, Any]) -> None:
    """The drill's own fallback ran out: the cells went up without the laboratory's word."""
    b = side.state.get("blood") or {}
    if b.get("status") not in ("waiting", "sample", "matching", "no_reply"):
        raise ValueError("no blood request is open")
    side.update(blood={**b, "unconfirmed": True})
    side.speak(line("unconfirmed", side.lang), priority="urgent")
    await side.thought("Packed cells hung WITHOUT cross-match confirmation: the laboratory had not answered in time.")


# ── the sign-in allergy question ───────────────────────────────────────────


async def allergy(side: SideRoom, data: dict[str, Any]) -> dict[str, Any]:
    if (side.state.get("rx") or {}).get("status") == "waiting":
        raise ValueError("already asked")
    drugs = [{"id": _clip(d.get("id"), 40), "name": _clip(d.get("name"), 60)} for d in data.get("drugs") or [] if isinstance(d, dict)][:12] \
        if isinstance(data.get("drugs"), list) else []
    body = {"caseId": side.context.get("scenarioId", ""), "allergies": _clip(data.get("allergies"), 200) or "not recorded",
            "drug": _clip(data.get("drug"), 60), "dose": _clip(data.get("dose"), 40), "drugs": drugs,
            "patient": {"age": _int(data.get("age"), 0, 120, 40), "gender": _clip(data.get("gender"), 1)}}
    side.update(rx={"status": "waiting", "drug": body["drug"], "text": ""})
    side.hub.spawn(_allergy(side, body), "theatre allergy")
    return {}


async def _allergy(side: SideRoom, body: dict[str, Any]) -> None:
    r = await side.request(PHARMACIST, "theatre_allergy",
                           f"Sign-in. Recorded allergy: {body['allergies']}. Is {body['drug'] or 'the antibiotic'} {body['dose']} safe, and what must we avoid?",
                           body, timeout=RX_TIMEOUT_S, label=f"Allergy check, {body['drug'] or 'theatre drugs'}",
                           why="Adding pharmacy: the sign-in allergy question")
    settle_allergy(side, r)


def settle_allergy(side: SideRoom, r: Reply) -> None:
    rx = dict(side.state.get("rx") or {})
    verdict = str(r.data.get("verdict") or "") if r.ok and r.kind == "verdict" else ""
    if verdict not in ("release", "hold", "clarify"):
        side.update(rx={**rx, "status": "no_reply", "text": ""})
        side.speak(line("rx_silent", side.lang), priority="result")
        return
    avoid = [_clip(a, 30) for a in r.data.get("avoid") or []][:4] if isinstance(r.data.get("avoid"), list) else []
    side.update(rx={**rx, "status": verdict, "avoid": avoid, "text": _clip(bedside.clean_spoken(r.data.get("reason") or r.text, 400), 300)})
    if r.spoken:
        side.speak(r.spoken, speaker=PHARMACIST, priority="urgent" if verdict == "hold" else "result")


# ── calling for help ───────────────────────────────────────────────────────


async def help_(side: SideRoom, data: dict[str, Any]) -> dict[str, Any]:
    sbar = _clip(bedside.clean_spoken(data.get("sbar"), 420), 420)
    if not sbar:
        raise ValueError("say what the problem is")
    side.update(help={"status": "calling", "name": "", "text": "", "at": ""})
    try:
        person = await side.invite_human(f"HELP in theatre. {sbar} Reply here and mention Theatre Sister Leela; she speaks for you in theatre.")
    except band_client.BandError as e:
        log.warning("consultant not reached: %s", e)
        side.update(help={"status": "unreachable", "name": "", "text": "", "at": ""})
        side.speak(line("help_none", side.lang), priority="urgent")
        return {}
    name = Hub._called(person["name"])
    side.update(help={"status": "called", "name": name, "text": "", "at": ""})
    side.speak(line("help_called", side.lang, name=name), priority="ack")
    return {"name": name}


async def listen(side: SideRoom, r: Reply) -> None:
    """Whatever no request was waiting for: the consultant's words, and answers that came late."""
    if r.role == FACULTY:
        text = bedside.clean_spoken(r.text, 400)
        if not text:
            return
        name = Hub._called(r.name)
        n = int((side.state.get("help") or {}).get("n") or 0) + 1
        side.update(help={"status": "replied", "name": name, "text": text, "n": n})
        said = await side.in_lang(text)
        side.speak(line("reply", side.lang, name=name, text=said) if said else line("reply_plain", side.lang, name=name), priority="urgent")
        return
    if r.handoff is None or r.kind not in ("result", "verdict"):
        return
    if r.role == LAB and r.handoff.action == "crossmatch" and r.ref in side.enc.refs and side.enc.refs[r.ref].target_id == r.sender_id:
        side.set_delegation(r.ref, "done", r.text)
        settle_blood(side, r.ref, r)
    elif r.role == PHARMACIST and r.handoff.action == "theatre_allergy" and r.ref in side.enc.refs and side.enc.refs[r.ref].target_id == r.sender_id:
        side.set_delegation(r.ref, "done", r.text)
        settle_allergy(side, r)


siderooms.register(Kind(
    KIND, owner=THEATRE, title="Theatre drill", check=check, listener=listen,
    actions={"blood": blood, "sample": sample, "unconfirmed": unconfirmed, "allergy": allergy, "help": help_},
))
