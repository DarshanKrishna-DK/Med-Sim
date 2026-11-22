"""What is the doctor asking the pharmacist about?

Finds every drug a spoken question names (English, brands, native scripts, code-mixed,
small misspellings) and what part each one plays:

  asked      the drug the question is about
  taking     a drug the patient is already on, mentioned as context
  replaced   "instead of X"
  allergy    "allergic to X"

A drug that is only context is never treated as the one being ordered. Pure, no model:
the verdict comes from the pharmacist's fixed checks, and `wording_ok` is what keeps a
model's wording from saying anything those checks did not.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

import drugterms

# Not in the MedSim formulary, but doctors name them: so that "not in our formulary" can be
# said plainly, and so that a drug the patient already takes is recognised.
OUTSIDE: tuple[str, ...] = (
    "warfarin", "acenocoumarol", "digoxin", "lithium", "isosorbide", "omeprazole", "heparin", "rivaroxaban", "dabigatran", "enalapril",
    "lisinopril", "telmisartan", "olmesartan", "valsartan", "valproate", "phenytoin", "levetiracetam", "lamotrigine", "codeine", "diazepam",
    "alprazolam", "clonazepam", "midazolam", "amiodarone", "verapamil", "diltiazem", "tadalafil", "erythromycin", "clarithromycin",
    "gentamicin", "amikacin", "clindamycin", "linezolid", "vancomycin", "meropenem", "imipenem", "piperacillin", "ampicillin",
    "flucloxacillin", "cloxacillin", "cefixime", "cefpodoxime", "cefotaxime", "ceftazidime", "cefepime", "cefazolin", "levofloxacin",
    "ofloxacin", "norfloxacin", "moxifloxacin", "minocycline", "tetracycline", "fosfomycin", "rifampicin", "isoniazid", "ethambutol",
    "pyrazinamide", "fluconazole", "itraconazole", "voriconazole", "ivermectin", "albendazole", "artesunate", "chloroquine",
    "oseltamivir", "remdesivir", "glimepiride", "glipizide", "sitagliptin", "vildagliptin", "dapagliflozin", "pioglitazone",
    "atenolol", "nebivolol", "carvedilol", "torsemide", "chlorthalidone", "nifedipine", "cilnidipine", "ticagrelor", "prasugrel",
    "pravastatin", "fenofibrate", "ketorolac", "mefenamic", "aceclofenac", "etoricoxib", "celecoxib", "indomethacin", "fentanyl",
    "pethidine", "oxycodone", "buprenorphine", "venlafaxine", "duloxetine", "paroxetine", "citalopram", "olanzapine", "risperidone",
    "aripiprazole", "domperidone", "rabeprazole", "ranitidine", "theophylline", "aminophylline", "azathioprine", "cyclosporine",
    "mycophenolate", "sulfasalazine", "leflunomide", "ketamine", "propofol", "adenosine", "dobutamine", "noradrenaline", "oxytocin",
    "misoprostol", "carbimazole", "deflazacort", "methylprednisolone", "prednisolone",
)
# Brands and short forms of those.
OUTSIDE_ALIASES: dict[str, str] = {
    "warf": "warfarin", "acitrom": "acenocoumarol", "nicoumalone": "acenocoumarol", "clinda": "clindamycin", "genta": "gentamicin",
    "dalacin": "clindamycin", "xarelto": "rivaroxaban", "lanoxin": "digoxin", "dilantin": "phenytoin", "eptoin": "phenytoin",
    "telma": "telmisartan", "levo": "levofloxacin", "levoflox": "levofloxacin", "omez": "omeprazole", "taxim": "cefixime",
    "zifi": "cefixime", "rifampin": "rifampicin", "akt": "rifampicin", "diflucan": "fluconazole",
}
# Class words: never one drug.
CLASSES: dict[str, str] = {
    "nsaid": "nsaid", "painkiller": "nsaid", "sulfa": "sulfa", "cephalosporin": "cephalosporin", "penicillins": "penicillin",
    "macrolide": "macrolide", "fluoroquinolone": "fluoroquinolone", "quinolone": "fluoroquinolone", "statin": "statin",
    "benzodiazepine": "benzodiazepine", "steroid": "steroid", "antibiotic": "antibiotic",
}
# Words of a formulary name that do not identify the drug.
_NOT_NAMES = frozenset(
    "injection tablet capsule cream gel ointment shampoo drops spray inhaler syrup solution suspension paste patch oral nasal vaginal "
    "topical sublingual transdermal immediate release combined contraceptive succinate axetil sulfate sodium acid basal bolus artificial "
    "tears low osmolarity vaccine immunoglobulin polyvalent silicone scar vitamin folic eye mouthwash toothpaste desensitising "
    "intralesional units antivenom dispersible nitrate potassium calcium snake tetanus diphtheria rabies hydrochloride".split())
_ALIASES: dict[str, tuple[str, ...]] = {
    "combined-ocp": ("ocp", "contraceptive", "ocps"), "hctz-25": ("hctz",), "calcium-vitd": ("shelcal",),
    "folic-acid-5": ("folic",), "vitamin-b12-im": ("cobalamin", "b12"), "tranexamic-acid-500": ("tranexamic", "txa"),
    "tmp-smx-ds": ("cotrimoxazole", "trimethoprim", "sulfamethoxazole", "co-trimoxazole"), "ferrous-sulfate-325": ("ferrous",),
}
# A word that ends like a drug name but is in no list: named, and plainly not ours.
_SOUNDS_LIKE_A_DRUG = re.compile(
    r"[a-z]{3,}(?:mycin|micin|cillin|cycline|floxacin|azole|[aeiou]pril|sartan|[ao]lol|vastatin|dipine|oxetine|prazole|gliptin|gliflozin|xaban|"
    r"triptan|setron|profen|fenac|coxib|zepam|zolam|lukast|tinib|penem|thiazide|semide|dronate|mab)")


@dataclass
class Drug:
    key: str                # ingredient, lower case English
    med_id: str             # "" when it is not in the formulary
    name: str               # as it is said aloud
    role: str = "asked"
    at: int = 0
    cls: bool = False       # a class word, not one drug


@dataclass
class Parsed:
    text: str
    drugs: list[Drug] = field(default_factory=list)

    def by(self, role: str) -> list[Drug]:
        return [d for d in self.drugs if d.role == role]


_INDIC = re.compile("[ऀ-෿]")
_CLAUSE = re.compile(r"[.?!;:,।\n]+|\b(?:because|since|lekin|magar|kyunki|but|however|although|aanaal|aadre|kaani|pan to|kintu)\b", re.I)
_VIRAMA = "्্்్್"
_LINK = {"and", "aur", "or", "ya", "mattu", "athava", "matrum", "allathu", "mariyu", "leda", "ani", "kiva", "ar", "ba", "plus",
         "और", "या", "ಮತ್ತು", "ಅಥವಾ", "மற்றும்", "அல்லது", "మరియు", "లేదా", "आणि", "किंवा", "এবং", "আর", "বা", "अथवा"}

# The words right before an English mention, and right after a postposed (Indian) one.
_ADV = r"(?:(?:the|his|her|their|a|an|some|regular|daily|long|term|low|high|dose|old|also|already|currently)\s+){0,3}$"
_BEFORE_TAKING = re.compile(
    r"\b(?:takes|taking|uses|using|on regular|(?:is|are|was|been|already|also|currently|still|stays?|patient|pt|he|she|s|me|who) on|"
    r"with|alongside|plus|has been having|gets)\s+" + _ADV)
_NOT_TAKING = re.compile(r"\b(?:put|start|starting|switch|begin|keep|place)\s+(?:\w+\s+){0,2}on\s+" + _ADV)
_BEFORE_REPLACED = re.compile(r"\b(?:instead of|in place of|rather than|other than|apart from|replac(?:e|ing)|stop(?:ping)?|(?:switch|change)(?:ing)?(?: from)?)\s+" + _ADV)
_BEFORE_ALLERGY = re.compile(r"\b(?:allerg\w*|reaction|reacted|rash|sensitiv\w*|anaphyla\w*)\s+(?:to|with|from|after|on)\s+" + _ADV)
_ALLERGY = (r"allerg\w*|एलर्जी|अलर्जी|ऍलर्जी|ॲलर्जी|ಅಲರ್ಜಿ\S*|ஒவ்வாமை\S*|அலர்ஜி\S*|అలర్జీ\S*|అలెర్జీ\S*|অ্যালার্জি\S*|এলার্জি\S*")
_AFTER_ALLERGY = re.compile(rf"^(?:\S+\s+){{0,2}}?(?:{_ALLERGY})")
_AFTER_REPLACED = re.compile(
    r"^(?:(?:ki|ke|ka|kee|er|cha|chya|ge|kku)\s+)?(?:jagah|jaga|jagha|badle|badal\w*|bajay\w*|badul\w*|bodol\w*|pathil\w*|aivaji)"
    r"|^(?:(?:की|के|का|च्या|এর)\s+)?(?:जगह|बदले|बजाय|ऐवजी|বদলে|পরিবর্তে)|^ಬದಲ|^பதில|^బదులు")
_AFTER_TAKING = re.compile(
    r"^(?:(?:bhi|already|pehle|se|goli|tablet|regular|roz|daily|kooda|kuda|also|the|पहले|से|भी|रोज|गोली|ಕೂಡ|ಸಹ|ಮಾತ್ರೆ|மாத்திரை|కూడా|मात्रा|गोळी|ওষুধ|ও)\s+){0,3}"
    r"(?:le (?:raha|rahi|rahe|rha|rhi|rhe)|l[ei]t[aei]\b|kha (?:raha|rahi|rahe|rha)|khat[aei]\b|chal (?:raha|rahi|rha|rahe)|chalu|(?:pe|par) hai|"
    r"ke sa+th|ke saath|jote\w*|jothe\w*|tag[ao]?[nt]\w*ta\w*|tagolt\w*|tegedukolut\w*|sapid\w*r\w*|saapid\w*r\w*|edu[kt]+\w*r\w*ar\w*|udan|teesukunt\w*|"
    r"vaadut\w*|to ?paatu|thopatu|ghet\w*|sobat|barobar|khachh\w*|nichh\w*|er sathe|"
    r"ले रह|लेता|लेती|लेते|खा रह|खाता|खाती|चल रह|चालू|पर है|के साथ|घेत|सोबत|बरोबर|"
    r"ತೆಗೆದುಕೊಳ್ಳುತ್|ತಗೊಳ್ತ|ತಗೋತ|ತೆಗೆದುಕೊಂಡಿದ್|ಸೇವಿಸುತ್|ಜೊತೆ|ಜತೆ|"
    r"சாப்பிடுகிற|சாப்பிடுற|சாப்பிட்டு வ|எடுத்துக்கொள்கிற|எடுத்துக்கிற|எடுக்கிற|உடன்|"
    r"తీసుకుంట|తీసుకుంటు|వాడుతు|వేసుకుంట|తో పాటు|తోపాటు|తో\b|"
    r"খাচ্|নিচ্|খান\b|খায\b|এর সঙ্গে|এর সাথে|সঙ্গে|সাথে|চলছে)")
_GLUED_TAKING = re.compile(r"(?:உடன்|டன்|తో|తోపాటు|ಜೊತೆ|সঙ্গে)$")
_GLUED_REPLACED = re.compile(r"(?:ಬದಲು|ಬದಲಿಗೆ|బదులు)$")
# "Is it a fact about the drug, or may I give it?"
_INFO = re.compile(
    r"\b(?:class|dose|dosage|how (?:much|many|long|often)|how (?:is|do|does|to)|what (?:is|are)|which (?:group|class)|duration|side effects?|when to take|before food|"
    r"after food|kitn[aeiy]|kab|kaise|kya hota|eshtu|evvalavu|evlo|entha|kiti|koto)\b|खुराक|कितन|डोस|ಎಷ್ಟು|ಪ್ರಮಾಣ|எவ்வளவு|அளவு|ఎంత|మోతాదు|किती|কত|মাত্রা", re.I)
_PERMISSION = re.compile(
    r"\b(?:can|could|may|should|shall|safe|ok|okay|fine|allowed|suitable|instead|switch|give|use|start|prescribe|avoid|problem|interact\w*|issue|"
    r"de sakt\w*|de du|dena|chalega|chalegi|theek|thik|sahi|kodbah\w*|kod\w*ah?u?d\w*|kodla\w*|kodab\w*|kudukkal\w*|koduk+al\w*|ivvoch\w*|ivvach\w*|ivvavach\w*|"
    r"deu shak\w*|deta ye\w*|dewa jab\w*|dite par\w*)\b"
    r"|दे सक|दूँ|दूं|देना|चलेग|ठीक|सही|सुरक्षित|ಕೊಡಬಹುದ|ಕೊಡಲಾ|ಸುರಕ್ಷಿತ|கொடுக்கலாம|கொடுக்கல|பாதுகாப|ఇవ్వవచ్చ|ఇవ్వొచ్చ|ఇవ్వచ్చ|సురక్షిత|देऊ शक|देता य|चालेल|দেওয|দেয|দিতে পার|নিরাপদ", re.I)


class Index:
    """Every way a drug can be written, looked up one spoken token at a time."""

    def __init__(self, meds: dict[str, list[str]]) -> None:
        self.meds = meds
        self.latin: dict[str, str] = {}              # word -> key
        self.native: list[tuple[str, str]] = []      # native stem -> key
        self.skeleton: dict[str, str] = {}           # consonant skeleton -> key
        self.med: dict[str, str] = {}                # key -> medicine id ("" = not in the formulary)
        self.said: dict[str, str] = {}
        for mid, row in meds.items():
            topical = row[1] == "cream" or row[2] in ("dermatology", "dental-oral", "ophthalmic")
            base = re.sub(r"\(.*?\)", " ", row[0])
            words = [w.lower() for w in re.findall(r"[A-Za-z]{5,}", base) if w.lower() not in _NOT_NAMES]
            words += _ALIASES.get(mid, ())
            label = re.sub(r"\s*\d.*$", "", base).strip() or row[0]
            combo = "/" in base
            for i, w in enumerate(words):
                if w in self.med and (topical or combo and i == 0 or self.med[w]):
                    continue  # the plain tablet owns the name; Augmentin is found by its own words
                if combo and i == 0 and any(w in re.sub(r"\W", " ", m[0].lower()).split() for o, m in meds.items() if o != mid):
                    continue
                self._add(w, mid, label)
        for w in OUTSIDE:
            if w not in self.med:
                self._add(w, "", w.capitalize())
        for a, w in OUTSIDE_ALIASES.items():
            self.latin.setdefault(a, w)
        for word, cls in CLASSES.items():
            self.latin[word] = f"class:{cls}"
        for canon, variants in drugterms.SPOKEN.items():
            key = f"class:{canon}" if canon in ("nsaid", "sulfa", "cephalosporin") else canon if canon in self.med else self._find(canon)
            if canon == "penicillin":
                key = "class:penicillin"
            if not key:
                continue
            for v in variants:
                n = drugterms.norm(v)
                if _INDIC.search(n):
                    self.native.append((n.rstrip(_VIRAMA), key))
                elif " " not in n:
                    self.latin.setdefault(n, key)
        for brand, names in drugterms.BRANDS.items():
            key = next((k for n in names if (k := self._find(n))), "")
            if key and " " not in brand:
                self.latin.setdefault(brand, key)
        self.latin["penicillin"] = "class:penicillin"
        self.phrases = {drugterms.norm(b): k for b, ns in drugterms.BRANDS.items() if " " in b for n in ns if (k := self._find(n))}
        self.phrases.update({"penicillin v": "penicillin v", "pain killer": "class:nsaid", "birth control pill": "ocp", "contraceptive pill": "ocp",
                             "co trimoxazole": self._find("sulfamethoxazole"), "folic acid": "folic", "tranexamic acid": "tranexamic"})
        pen = next((m for m, r in meds.items() if r[0].lower().startswith("penicillin v")), "")
        self.med["penicillin v"], self.said["penicillin v"] = pen, "Penicillin V"

    def _add(self, word: str, mid: str, label: str) -> None:
        self.latin[word] = word
        self.med[word], self.said[word] = mid, label
        sk = drugterms._skeleton_latin(word)
        if len(sk) >= 4:
            self.skeleton.setdefault(sk, word)

    def _find(self, part: str) -> str:
        """The key whose word starts with `part` ('predniso' -> 'prednisone')."""
        if part in self.med:
            return part
        hits = [k for k in self.med if k.startswith(part)] or [k for k in self.med if part in k]
        hits.sort(key=lambda k: (not self.med[k], len(k)))
        return hits[0] if hits else ""

    def drug(self, key: str, at: int) -> Drug:
        if key.startswith("class:"):
            return Drug(key, "", key[6:], at=at, cls=True)
        return Drug(key, self.med.get(key, ""), self.said.get(key, key.capitalize()), at=at)

    def token(self, t: str) -> str:
        """The drug one token names, or ''."""
        if not t:
            return ""
        if _INDIC.search(t):
            for stem, key in self.native:
                if stem in t:
                    return key
            sk = drugterms._skeleton_native(t)
            if len(sk) >= 5:
                best = ""
                for k, word in self.skeleton.items():
                    a, b = sk.replace("f", "p"), k.replace("f", "p")
                    if len(k) >= 5 and a.startswith(b) and len(a) - len(b) <= 3 and len(k) > len(drugterms._skeleton_latin(best) if best else ""):
                        best = word
                return best
            return ""
        if t in self.latin:
            return self.latin[t]
        if len(t) >= 8:
            for cut in (1, 2, 3):  # plural and case endings: "doxycyclines", "warfarinnu"
                if t[:-cut] in self.latin and len(t) - cut >= 6:
                    return self.latin[t[:-cut]]
        if len(t) >= 7:
            sk = drugterms._skeleton_latin(t)
            word = self.skeleton.get(sk, "") if len(sk) >= 5 else ""
            if word and word[0] == t[0] and abs(len(word) - len(t)) <= 2:
                return word
            if _SOUNDS_LIKE_A_DRUG.fullmatch(t):
                return t
        return ""


def parse(text: str, index: Index) -> Parsed:
    out = Parsed(text or "")
    pos = 0
    for raw in _CLAUSE.split(text or ""):
        if not raw:
            continue
        tokens = drugterms.norm(raw).split()[:60]
        here: list[Drug] = []
        spans: list[tuple[int, int]] = []
        i = 0
        while i < len(tokens):
            key, width = "", 1
            for n in (3, 2):
                if i + n <= len(tokens) and (k := index.phrases.get(" ".join(tokens[i:i + n]))):
                    key, width = k, n
                    break
            key = key or index.token(tokens[i])
            if key:
                here.append(index.drug(key, pos + i))
                spans.append((i, i + width))
            i += width
        for j, d in enumerate(here):
            a, b = spans[j]
            start = spans[j - 1][1] if j else 0
            end = spans[j + 1][0] if j + 1 < len(here) else len(tokens)
            before = " ".join(tokens[start:a][-6:]) + (" " if a > start else "")
            after = " ".join(tokens[b:end][:7])
            last = tokens[b - 1]
            if _BEFORE_ALLERGY.search(before) or _AFTER_ALLERGY.search(after):
                d.role = "allergy"
            elif _BEFORE_REPLACED.search(before) or _AFTER_REPLACED.search(after) or _GLUED_REPLACED.search(last):
                d.role = "replaced"
            elif (_BEFORE_TAKING.search(before) and not _NOT_TAKING.search(before)) or _AFTER_TAKING.search(after) \
                    or (_INDIC.search(last) and _GLUED_TAKING.search(last)):
                d.role = "taking"
        # "on warfarin and digoxin", "warfarin aur digoxin le raha hai": the pair share a role.
        for j in range(len(here) - 1):
            gap = tokens[spans[j][1]:spans[j + 1][0]]
            if gap and all(w in _LINK for w in gap):
                if here[j].role in ("taking", "allergy") and here[j + 1].role == "asked" and _BEFORE_TAKING.search(" ".join(tokens[:spans[j][0]][-6:]) + " "):
                    here[j + 1].role = here[j].role
                elif here[j].role == "asked" and here[j + 1].role in ("taking", "allergy") and _AFTER_TAKING.search(" ".join(tokens[spans[j + 1][1]:][:7])):
                    here[j].role = here[j + 1].role
        out.drugs += here
        pos += len(tokens) + 1
    # One entry per drug: asking about it wins over the other mentions, except that a drug first
    # named as taken and then asked about really is asked about.
    best: dict[str, Drug] = {}
    for d in out.drugs:
        if d.key not in best or (d.role == "asked" and best[d.key].role in ("replaced", "taking")):
            best[d.key] = d
    out.drugs = sorted(best.values(), key=lambda d: d.at)
    asked = out.by("asked")
    # "Can I give doxycycline and warfarin together?": the one we do not stock is what they already take.
    if any(d.med_id for d in asked) and re.search(r"\b(?:together|and|aur|along|ek saath|saath me\w*|mattu|jothe\w*)\b|साथ|और|ಮತ್ತು|ಒಟ್ಟಿಗೆ|சேர்த்து|కలిపి|एकत्र|একসঙ্গে", text or "", re.I) \
            and not re.search(r"\b(?:or|ya|athava)\b|या|ಅಥವಾ|அல்லது|లేదా|किंवा|অথবা", text or "", re.I):
        for d in asked:
            if not d.med_id and not d.cls:
                d.role = "taking"
    return out


def wants_permission(text: str) -> bool:
    """False only for a plain question of fact ("what class is it", "how many days")."""
    return bool(_PERMISSION.search(text or "")) or not _INFO.search(text or "")


# ── keeping a model's wording inside the verdicts ──────────────────────────

_POS = re.compile(
    r"\b(?:can (?:be )?(?:given|give|use|used|start|take)|you can|we can|may (?:be )?give\w*|safe|fine|okay|ok|suitable|recommend\w*|alternative|instead|suggest\w*|"
    r"option|go ahead|released?|prescribe|yes|prefer\w*|de sakt\w*)\b"
    r"|दे सकत|सुरक्षित|ठीक है|विकल्प|हाँ|ಕೊಡಬಹುದು|ಸುರಕ್ಷಿತ|ಪರ್ಯಾಯ|ಹೌದು|கொடுக்கலாம்|பாதுகாப்ப|மாற்று|ஆம்|ఇవ్వవచ్చు|ఇవ్వొచ్చు|సురక్షిత|ప్రత్యామ్నాయ|అవును"
    r"|देता येई|देऊ शक|पर्याय|চলবে|দেওয়া যা|দেওযা যা|দেওয়া যেতে|নিরাপদ|বিকল্প", re.I)
_NEG = re.compile(
    r"\b(?:can ?not|can'?t|don'?t|do not|should ?not|shouldn'?t|must not|never|avoid\w*|unsafe|contra\w*|hold|held|stop\w*|not (?:be )?(?:safe|suitable|recommended|given|advis\w+)|"
    r"no|interact\w*|nahi|mat)\b"
    r"|नहीं|मत|रोक|बचें|ಬೇಡ|ಕೊಡಬೇಡಿ|ಕೂಡದು|ತಡೆ|வேண்டாம்|கூடாது|நிறுத்த|వద్దు|కూడదు|నిలిప|नको|नका|नये|थांब|দেবেন না|যাবে না|উচিত ন|আটক", re.I)


def wording_ok(text: str, verdicts: dict[str, str], index: Index, any_held: bool = False) -> bool:
    """False when a sentence says yes or no about a drug nobody checked, or against its verdict.
    `verdicts`: drug key -> release | hold | clarify."""
    for sentence in re.split(r"(?<=[.!?।])\s+", text or ""):
        pos, neg = bool(_POS.search(sentence)), bool(_NEG.search(sentence))
        if not (pos or neg):
            continue
        named = [d for d in parse(sentence, index).drugs if not d.cls]
        if not named:
            if pos and not neg and any_held:
                return False
            continue
        for d in named:
            verdict = verdicts.get(d.key)
            if verdict is None:
                return False
            if (verdict in ("hold", "clarify") and pos and not neg) or (verdict == "release" and neg and not pos):
                return False
        held = [d for d in named if verdicts.get(d.key) in ("hold", "clarify")]
        if held and len(named) == len(held) and pos and neg and re.search(r"\b(?:but|however|still|although)\b|लेकिन|ಆದರೆ|ஆனால்|కానీ|पण|কিন্তু", sentence, re.I):
            return False
    return True


def keys_for(names: Iterable[str], index: Index) -> list[str]:
    out: list[str] = []
    for n in names:
        out += [d.key for d in parse(n, index).drugs]
    return out


def co_medications(drugs: Iterable[Drug]) -> list[tuple[str, str]]:
    """(id, name) pairs the interaction check understands."""
    return [(d.med_id or d.key, d.name) for d in drugs if not d.cls]


def allergy_text(drugs: Iterable[Drug], question: str) -> str:
    """An allergy stated in the question itself, unless it was denied."""
    named = [d.name for d in drugs]
    stated = any(drugterms.positive_allergies(c) for c in _CLAUSE.split(question or "")
                 if c and re.search(_ALLERGY + r"|\breact\w*|\brash|\bsensitiv", c, re.I))
    return ", ".join(named) if named and stated else ""


_cache: dict[int, Index] = {}


def index_for(meds: dict[str, Any]) -> Index:
    """One index per formulary object (building it takes a few milliseconds)."""
    i: Optional[Index] = _cache.get(id(meds))
    if i is None or i.meds is not meds:
        i = _cache[id(meds)] = Index(meds)
    return i
