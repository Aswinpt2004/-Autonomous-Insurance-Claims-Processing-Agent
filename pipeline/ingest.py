import re
import os
import logging

logger = logging.getLogger(__name__)

BOILERPLATE_PATTERNS = [
    r"Applicable in [A-Z][a-z]+(?:\s+and\s+[A-Z][a-z]+)?:.*?(?=Applicable in [A-Z]|\Z)",
    r"©\s?\d{4}\s+ACORD CORPORATION\.?\s+All rights reserved\.",
    r"ACORD\s+\d+\s+\(\d{4}/\d{2}\)",
    r"ACORDs? provided by.*?(?=\n|\Z)",
    r"-{10,}.*?FRAUD NOTICE.*?-{10,}",
    r"\n{3,}",
]

VISION_TEXT_THRESHOLD = 40


def extract_text_and_flag_vision(file_bytes: bytes, filename: str) -> tuple[str, bool, object | None]:
    ext = os.path.splitext(filename)[1].lower()
    if ext in (".txt", ".text"):
        return _process_text_bytes(file_bytes)
    if ext == ".pdf":
        return _process_pdf_bytes(file_bytes)
    logger.warning("Unknown extension '%s', trying plain-text.", ext)
    return _process_text_bytes(file_bytes)


def _process_text_bytes(file_bytes: bytes) -> tuple[str, bool, None]:
    raw = file_bytes.decode("utf-8", errors="replace")
    text = _strip_boilerplate(f"[PAGE 1]\n{raw}")
    logger.info("Plain-text ingestion done. Chars: %d", len(text))
    return text, False, None


def _process_pdf_bytes(file_bytes: bytes) -> tuple[str, bool, object]:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required. Run: pip install pymupdf") from exc

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages_text = []
    needs_vision = False

    for i, page in enumerate(doc, start=1):
        text = page.get_text()
        if len(text.strip()) < VISION_TEXT_THRESHOLD:
            needs_vision = True
            pages_text.append(f"[PAGE {i}]\n[GRAPHICAL/SCANNED PAGE — vision required]")
        else:
            pages_text.append(f"[PAGE {i}]\n{text}")

    full_text = _strip_boilerplate("\n".join(pages_text))
    logger.info("PDF ingestion done. Pages: %d | vision: %s | chars: %d", len(doc), needs_vision, len(full_text))
    return full_text, needs_vision, doc


def _strip_boilerplate(text: str) -> str:
    for pattern in BOILERPLATE_PATTERNS:
        text = re.sub(pattern, "\n", text, flags=re.DOTALL | re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()
