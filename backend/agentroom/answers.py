"""What a doctor's spoken answer to a safety question means, in any of the session languages.

Fixed rules only. A hedged, mixed or empty answer is always 'unclear', and nothing
unsafe happens on 'unclear'.
"""

from __future__ import annotations

import re

PREGNANT = re.compile(r"\bpregnan|\btrimester\b|\bgestation|\bprimigravida\b|\bantenatal\b|\bweeks of amenorrh|गर्भ|ಗರ್ಭಿಣಿ|கர்ப்ப|గర్భ|গর্ভ", re.I)

PREGNANT_YES = re.compile(r"\b(?:yes|yeah|yep|she is|positive|haa?n|haudu|howdu|aama|avunu)\b|^\W*ho\b|\bweeks? pregnant|हाँ|हां|ಹೌದು|ஆமா|ஆம்|అవును|^\W*हो\b|হ্যাঁ", re.I)
PREGNANT_NO = re.compile(
    r"\b(?:no|not|nope|negative|never|cannot be|can't be|ruled out|menopaus\w*|hysterectom\w*|tubectom\w*|sterili[sz]\w*|nahi|nahin|illa|illai|ledu|nahiye)\b"
    r"|नहीं|नही|नाही|ಇಲ್ಲ|இல்லை|లేదు|కాదు|না(?![ঀ-৿])|নয়|নেই|period (?:last week|is on|ongoing|finished)|LMP (?:last week|\d+ days)", re.I)
UNSURE = re.compile(
    r"\b(?:not sure|don'?t know|do not know|maybe|may be|possibly|unsure|can'?t say|perhaps|might|could be|no idea|haven'?t|have not|"
    r"has ?n[o']t|did ?n[o']t|will check|will ask|let me|pata nahi|malum nahi|gottilla|theriyaathu|theriyala|teliyadu|mahit nahi|jani na)\b"
    r"|\b(?:not|never|nothing)\s+(?:\w+\s+)?(?:done|checked|tested|asked|known|confirmed|ruled|excluded|documented|available|recorded|yet)\b"
    r"|\b(?:can'?t|cannot|could not|couldn'?t)\s+(?:be\s+)?(?:ruled?|exclude)|\bno (?:test|upt|report|record|information|answer)\b"
    r"|पता नहीं|मालूम नहीं|शायद|नहीं (?:किया|हुआ|हुई|पूछा|देखा|कराया)|(?:टेस्ट|जाँच|जांच)[^.\u0964]{0,25}नहीं"
    r"|ಗೊತ್ತಿಲ್ಲ|ಬಹುಶಃ|ಇರಬಹುದು|(?:ಟೆಸ್ಟ್|ಪರೀಕ್ಷೆ)[^.]{0,25}ಇಲ್ಲ"
    r"|தெரியாது|தெரியல|ஒருவேளை|இருக்கலாம்|(?:டெஸ்ட்|பரிசோதனை)[^.]{0,25}இல்லை|செய்யவில்லை|கேட்கவில்லை"
    r"|తెలియదు|బహుశా|ఉండవచ్చు|చేయలేదు|అడగలేదు|(?:టెస్ట్|పరీక్ష)[^.]{0,25}లేదు"
    r"|माहित नाही|कदाचित|(?:टेस्ट|तपासणी)[^.]{0,25}नाही|(?:केली|केले|केलेली|विचारले) नाही"
    r"|জানি না|হয়তো|করা হয়নি|জিজ্ঞেস করিনি|(?:টেস্ট|পরীক্ষা)[^.\u0964]{0,25}(?:হয়নি|না)", re.I)
_PLAINLY_NOT = re.compile(
    r"\bnot pregnant\b|\bpregnan(?:t|cy) (?:nahi|nahin|illa|ledu|nako)\b|(?:test|upt|hcg) (?:is |was |came )?negative|negative (?:upt|hcg|pregnancy test)", re.I)
CONFIRM = re.compile(
    r"\b(?:confirm(?:ed)?|correct|that'?s right|okay|ok|fine|sure|theek hai|thik hai|sari|sare)\b|ठीक है|सही है|ಸರಿ|சரி|సరే|ठीक आहे|बरोबर|ঠিক আছে", re.I)


def yes_no(text: str) -> str:
    """'yes' | 'no' | 'unclear' for a doctor's answer, in any of the session languages."""
    t = (text or "").strip()
    if not t or UNSURE.search(t) or t.endswith("?"):
        return "unclear"
    if _PLAINLY_NOT.search(t):
        return "no"
    no, yes = PREGNANT_NO.search(t), PREGNANT_YES.search(t)
    if no and not (yes and yes.start() < no.start() and re.match(r"\W*(?:yes|haa?n|हाँ|हां)", t, re.I)):
        return "no"
    if yes or (PREGNANT.search(t) and not no):
        return "yes"
    return "unclear"


# The doctor decides to go ahead, or not.
_GO = re.compile(
    r"\b(?:go ahead|proceed|do it|do the|carry on|continue|benefit|life[- ]?threaten|emergency|urgent|still do|shield|consent|yes|"
    r"haa?n|karo|kar do|kijiye|maadi|madi|pannunga|seiyunga|cheyandi|kara|korun)\b|करें|कीजिए|कर दो|हाँ|हां|ಮಾಡಿ|ಹೌದು|செய்யுங்கள்|செய்யுங்க|ஆமா|ஆம்|"
    r"చేయండి|అవును|करा|करून टाका|করুন|করে দিন|হ্যাঁ", re.I)
_STOP = re.compile(
    r"\b(?:no|not|don'?t|do not|defer|cancel|hold|stop|wait|postpone|avoid|ultrasound instead|mri instead|non[- ]?contrast|without contrast|"
    r"mat|nahi|rehne do|ruko|beda|vendam|vaddu|nako|thamba)\b|मत|नहीं|रुक|टाल|रद्द|ಬೇಡ|ಮುಂದೂಡಿ|ನಿಲ್ಲಿಸಿ|வேண்டாம்|தள்ளி|நிறுத்து|వద్దు|వాయిదా|ఆపండి|"
    r"नको|नका|थांब|पुढे ढकल|না(?![ঀ-৿])|বন্ধ|পিছিয়ে|বাতিল", re.I)


def go_ahead(text: str, confirm: bool = False) -> str:
    """'go' | 'stop' | 'unclear'. A mixed or hedged answer is never 'go'. With `confirm` a plain
    "that is correct" counts, for questions that asked for a confirmation."""
    t = (text or "").strip()
    if not t or UNSURE.search(t) or t.endswith("?"):
        return "unclear"
    stop, go = _STOP.search(t), _GO.search(t) or (CONFIRM.search(t) if confirm else None)
    if go and not stop:
        return "go"
    if stop and not go:
        return "stop"
    if stop and go:
        return "stop" if re.match(r"\W*(?:no|don'?t|do not|defer|cancel|मत|नहीं|ಬೇಡ|வேண்டாம்|వద్దు|नको|না)", t, re.I) else "unclear"
    return "unclear"
