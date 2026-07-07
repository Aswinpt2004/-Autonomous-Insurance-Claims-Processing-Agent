import json
import logging
import os
import time
from typing import Any, List, Optional

from google import genai
from google.genai import types
from google.genai.errors import ServerError, APIError
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

MODEL_NAME = "gemini-2.5-flash"


class ExtractedFieldString(BaseModel):
    value: Optional[str] = Field(default=None)
    confidence: float
    source: Optional[str] = Field(default=None)


class ExtractedFieldNumber(BaseModel):
    value: Optional[float] = Field(default=None)
    confidence: float
    source: Optional[str] = Field(default=None)


class RiskSignal(BaseModel):
    signal: str
    severity: str
    evidence: str
    source: Optional[str] = Field(default=None)


class ExtractedFields(BaseModel):
    policyNumber: ExtractedFieldString
    policyholderName: ExtractedFieldString
    policyEffectiveDates: ExtractedFieldString
    incidentDate: ExtractedFieldString
    incidentTime: ExtractedFieldString
    incidentLocation: ExtractedFieldString
    incidentDescription: ExtractedFieldString
    claimant: ExtractedFieldString
    thirdParties: ExtractedFieldString
    contactDetails: ExtractedFieldString
    assetType: ExtractedFieldString
    assetId: ExtractedFieldString
    estimatedDamage: ExtractedFieldNumber
    claimType: ExtractedFieldString
    attachments: ExtractedFieldString
    initialEstimate: ExtractedFieldNumber


class ExtractionResult(BaseModel):
    extractedFields: ExtractedFields
    riskSignals: List[RiskSignal]


SYSTEM_INSTRUCTION = """\
You are a claims-intake extraction engine for a P&C insurer. \
You read First Notice of Loss (FNOL) documents and extract structured data ONLY.

Rules:
1. Extract fields exactly as written in the source. Never invent or infer a value not present.
2. If a field is missing or illegible, return null — do not guess.
3. For every field, return an object with value, confidence (0.0–1.0), and source page.
4. In "riskSignals", flag semantic inconsistencies between fields (e.g. incident date outside \
policy dates, damage severity mismatched with estimate). Only include a signal if there is \
concrete textual evidence; state that basis in "evidence".
5. Output valid JSON matching the schema. No prose, no markdown fences, nothing outside the JSON.\
"""

USER_PROMPT_TEMPLATE = """\
Document text follows. Extract all fields per the schema.

--- DOCUMENT START ---
{document_text}
--- DOCUMENT END ---"""


def run_extraction_agent(
    document_text: str,
    needs_vision: bool,
    pdf_bytes: bytes | None = None,
) -> dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY", "").strip().strip("'").strip('"')
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set. Check your .env file.")

    client = genai.Client(api_key=api_key)

    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        response_mime_type="application/json",
        response_schema=ExtractionResult,
        max_output_tokens=8192,
        temperature=0.1,
    )

    if needs_vision and pdf_bytes:
        logger.info("Vision path: inline PDF bytes.")
        contents: list[Any] = [
            types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
            USER_PROMPT_TEMPLATE.format(document_text="[See attached PDF document]"),
        ]
    else:
        contents = [USER_PROMPT_TEMPLATE.format(document_text=document_text)]

    response = None
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=MODEL_NAME, contents=contents, config=config
            )
            break
        except (ServerError, APIError) as exc:
            if attempt == 2:
                raise
            delay = 1.5 * (2.0 ** attempt)
            logger.warning("Gemini error, retrying in %.1fs: %s", delay, exc)
            time.sleep(delay)

    if response is None:
        raise RuntimeError("No response from Gemini API.")

    if response.usage_metadata:
        u = response.usage_metadata
        logger.info(
            "Tokens — prompt: %s | candidates: %s | total: %s",
            getattr(u, "prompt_token_count", "?"),
            getattr(u, "candidates_token_count", "?"),
            getattr(u, "total_token_count", "?"),
        )

    response_text = response.text or ""
    if not response_text:
        raise RuntimeError("Gemini API returned an empty response.")

    try:
        result = json.loads(response_text)
    except json.JSONDecodeError as exc:
        logger.error("Non-JSON response: %s", response_text[:500])
        raise RuntimeError(f"Gemini returned malformed JSON: {exc}") from exc

    if "extractedFields" not in result:
        raise RuntimeError(f"Missing 'extractedFields' in response. Got: {list(result.keys())}")

    logger.info("Extraction done. Risk signals: %d", len(result.get("riskSignals", [])))
    return result
