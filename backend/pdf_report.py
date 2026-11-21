"""One-page A4 consultation report card as a PDF, with no third-party dependency.

A tiny PDF 1.4 writer: two standard fonts (Helvetica, Helvetica-Bold, WinAnsi), filled
rectangles and text lines. Text outside Latin-1 (for example Devanagari) cannot be shown by
the standard fonts, so it is replaced with '?'; the report card is English by design.
"""

from __future__ import annotations

from typing import Any, Optional

PAGE_W, PAGE_H = 595.28, 841.89  # A4 in points
MARGIN = 48

# Helvetica advance widths (1/1000 em) for ASCII 32..126, from the standard AFM.
_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
      556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
      1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
      667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
      333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
      556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]

INK = (0.12, 0.13, 0.2)
MUTED = (0.42, 0.44, 0.5)
NIGHT = (0.1, 0.12, 0.22)
PAPER = (0.97, 0.95, 0.9)
TRACK = (0.88, 0.87, 0.84)
GOOD = (0.2, 0.6, 0.38)
MID = (0.85, 0.62, 0.15)
BAD = (0.8, 0.27, 0.25)


def _ascii(text: Any) -> str:
    s = str(text or "")
    for a, b in (("—", "-"), ("–", "-"), ("‘", "'"), ("’", "'"), ("“", '"'),
                 ("”", '"'), ("•", "-"), ("…", "..."), (" ", " ")):
        s = s.replace(a, b)
    s = " ".join(s.split())
    return s.encode("latin-1", "replace").decode("latin-1")


def text_width(text: str, size: float, bold: bool = False) -> float:
    w = sum(_W[ord(ch) - 32] if 32 <= ord(ch) <= 126 else 556 for ch in text)
    return w * size / 1000 * (1.06 if bold else 1.0)


def wrap(text: str, size: float, width: float, bold: bool = False) -> list[str]:
    words, lines, cur = _ascii(text).split(" "), [], ""
    for w in words:
        if not w:
            continue
        trial = f"{cur} {w}".strip()
        if text_width(trial, size, bold) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class _Canvas:
    def __init__(self) -> None:
        self.ops: list[str] = []

    def rect(self, x: float, y: float, w: float, h: float, rgb: tuple[float, float, float]) -> None:
        self.ops.append(f"{rgb[0]:.3f} {rgb[1]:.3f} {rgb[2]:.3f} rg {x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")

    def text(self, x: float, y: float, s: str, size: float = 10, bold: bool = False,
             rgb: tuple[float, float, float] = INK) -> None:
        font = "F2" if bold else "F1"
        self.ops.append(f"BT {rgb[0]:.3f} {rgb[1]:.3f} {rgb[2]:.3f} rg /{font} {size:.1f} Tf "
                        f"{x:.2f} {y:.2f} Td ({_esc(_ascii(s))}) Tj ET")

    def stream(self) -> bytes:
        return "\n".join(self.ops).encode("latin-1", "replace")


def _assemble(content: bytes, title: str) -> bytes:
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
         "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>").encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        f"<< /Title ({_esc(_ascii(title))}) /Producer (MedSim) >>".encode("latin-1", "replace"),
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R /Info {len(objs)} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


def _tone(pct: float) -> tuple[float, float, float]:
    return GOOD if pct >= 70 else MID if pct >= 50 else BAD


def build_report_pdf(
    student: str,
    university: str,
    case_title: str,
    specialty: str,
    complaint: str,
    score: Optional[float],
    verdict: str,
    domains: list[tuple[str, float]],
    strengths: list[str],
    improvements: list[str],
    narrative: str = "",
    diagnosis_line: str = "",
    date_text: str = "",
) -> bytes:
    """domains: (label, percent 0..100). Returns the PDF bytes."""
    cv = _Canvas()
    cv.rect(0, 0, PAGE_W, PAGE_H, PAPER)
    # Header band
    cv.rect(0, PAGE_H - 92, PAGE_W, 92, NIGHT)
    cv.text(MARGIN, PAGE_H - 50, "MedSim", 28, True, (1, 1, 1))
    cv.text(MARGIN, PAGE_H - 72, "Consultation report card", 12, False, (0.82, 0.85, 0.95))
    if date_text:
        cv.text(PAGE_W - MARGIN - text_width(_ascii(date_text), 10), PAGE_H - 72, date_text, 10, False, (0.82, 0.85, 0.95))
    y = PAGE_H - 126
    width = PAGE_W - 2 * MARGIN

    def label_value(lbl: str, val: str) -> None:
        nonlocal y
        cv.text(MARGIN, y, lbl.upper(), 8, True, MUTED)
        for line in wrap(val, 11, width - 90)[:2]:
            cv.text(MARGIN + 90, y, line, 11)
            y -= 15
        y -= 3

    label_value("Student", student + (f", {university}" if university else ""))
    label_value("Case", case_title + (f" ({specialty})" if specialty else ""))
    if complaint:
        label_value("Complaint", complaint)
    if diagnosis_line:
        label_value("Diagnosis", diagnosis_line)

    # Score panel
    y -= 6
    cv.rect(MARGIN, y - 62, width, 70, (1, 1, 1))
    pct = max(0.0, min(100.0, float(score))) if score is not None else None
    cv.text(MARGIN + 16, y - 36, f"{round(pct)}/100" if pct is not None else "-", 30, True, _tone(pct or 0))
    cv.text(MARGIN + 150, y - 26, "OVERALL", 8, True, MUTED)
    cv.text(MARGIN + 150, y - 44, verdict or "", 16, True)
    y -= 92

    # Domain bars
    if domains:
        cv.text(MARGIN, y, "DOMAIN SCORES", 9, True, MUTED)
        y -= 18
        for lbl, p in domains[:6]:
            p = max(0.0, min(100.0, float(p)))
            cv.text(MARGIN, y, (wrap(lbl, 10, 190) or [""])[0], 10)
            cv.text(MARGIN + width - 30, y, f"{round(p)}%", 10, True)
            cv.rect(MARGIN + 200, y - 1, width - 240, 9, TRACK)
            cv.rect(MARGIN + 200, y - 1, (width - 240) * p / 100, 9, _tone(p))
            y -= 20
        y -= 8

    footer_top = 70

    def bullets(title: str, items: list[str], rgb: tuple[float, float, float]) -> None:
        nonlocal y
        if not items or y < footer_top + 40:
            return
        cv.text(MARGIN, y, title.upper(), 9, True, MUTED)
        y -= 16
        for item in items[:5]:
            lines = wrap(item, 10, width - 16)[:3]
            if y - 13 * len(lines) < footer_top + 10:
                break
            cv.rect(MARGIN, y + 1, 5, 5, rgb)
            for line in lines:
                cv.text(MARGIN + 14, y, line, 10)
                y -= 13
            y -= 4
        y -= 8

    bullets("What went well", strengths, GOOD)
    bullets("What to work on", improvements, BAD)
    if narrative and y > footer_top + 50:
        cv.text(MARGIN, y, "ATTENDING'S NOTE", 9, True, MUTED)
        y -= 16
        for line in wrap(narrative, 10, width):
            if y < footer_top + 12:
                break
            cv.text(MARGIN, y, line, 10, False, INK)
            y -= 13

    # Footer
    cv.rect(0, 0, PAGE_W, 50, NIGHT)
    cv.text(MARGIN, 28, "SIMULATION", 14, True, (1, 0.85, 0.4))
    cv.text(MARGIN + 110, 29, "Training exercise with a synthetic patient. Not medical advice.", 9, False, (0.82, 0.85, 0.95))
    return _assemble(cv.stream(), f"MedSim report card: {student}")
