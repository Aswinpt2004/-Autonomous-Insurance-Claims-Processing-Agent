import logging
from typing import Any

logger = logging.getLogger(__name__)

SCORE_FASTTRACK_MAX = 10
SCORE_INVESTIGATION_MIN = 31
DAMAGE_FASTTRACK_MAX = 25_000

SCORE_MISSING_FIELD = 15
SCORE_LOW_CONF_CRITICAL = 15
SCORE_LOW_CONF_STANDARD = 5
SCORE_RISK_SIGNAL = {"low": 5, "medium": 15, "high": 30}
SCORE_INJURY_CLAIM = 20
SCORE_CONSISTENCY_ISSUE = 10

from .validation_agent import CRITICAL_FIELDS


def escalation_score(
    missing_fields: list[str],
    low_confidence_fields: list[dict[str, Any]],
    risk_signals: list[dict[str, Any]],
    consistency_issues: list[str],
    fields: dict[str, Any],
) -> int:
    score = SCORE_MISSING_FIELD * len(missing_fields)

    for lc in low_confidence_fields:
        score += SCORE_LOW_CONF_CRITICAL if lc["field"] in CRITICAL_FIELDS else SCORE_LOW_CONF_STANDARD

    for signal in risk_signals:
        score += SCORE_RISK_SIGNAL.get(signal.get("severity", "low"), 0)

    score += SCORE_CONSISTENCY_ISSUE * len(consistency_issues)

    if (fields.get("claimType", {}).get("value") or "").strip().lower() == "injury":
        score += SCORE_INJURY_CLAIM

    logger.info("Escalation score: %d", score)
    return score


def base_route(
    fields: dict[str, Any],
    missing_fields: list[str],
    low_confidence_fields: list[dict[str, Any]],
    risk_signals: list[dict[str, Any]],
    consistency_issues: list[str],
    score: int | None = None,
) -> str:
    if score is None:
        score = escalation_score(missing_fields, low_confidence_fields, risk_signals, consistency_issues, fields)

    critical_low_conf = [lc for lc in low_confidence_fields if lc["field"] in CRITICAL_FIELDS]
    if missing_fields or critical_low_conf:
        return "Manual Review"

    if (fields.get("claimType", {}).get("value") or "").strip().lower() == "injury":
        return "Specialist Queue"

    if score >= SCORE_INVESTIGATION_MIN:
        return "Investigation Flag"

    try:
        damage = float(fields.get("estimatedDamage", {}).get("value") or 0)
    except (TypeError, ValueError):
        damage = 0

    if score <= SCORE_FASTTRACK_MAX and damage < DAMAGE_FASTTRACK_MAX:
        return "Fast-track"

    return "Manual Review"
