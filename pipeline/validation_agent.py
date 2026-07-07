import logging
from typing import Any
from dateutil import parser as dateutil_parser

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = [
    "policyNumber", "policyholderName", "incidentDate",
    "incidentLocation", "incidentDescription", "claimant",
    "assetType", "claimType", "initialEstimate",
]

CRITICAL_FIELDS = {"policyNumber", "assetId", "claimType"}
CRITICAL_THRESHOLD = 0.85
STANDARD_THRESHOLD = 0.60


def _threshold_for(field: str) -> float:
    return CRITICAL_THRESHOLD if field in CRITICAL_FIELDS else STANDARD_THRESHOLD


def find_missing_fields(fields: dict[str, Any]) -> list[str]:
    missing = []
    for field in REQUIRED_FIELDS:
        value = fields.get(field, {}).get("value")
        if value is None or (isinstance(value, str) and not value.strip()):
            missing.append(field)
    return missing


def find_low_confidence_fields(fields: dict[str, Any]) -> list[dict[str, Any]]:
    flagged = []
    for field in REQUIRED_FIELDS:
        obj = fields.get(field, {})
        value = obj.get("value")
        confidence = obj.get("confidence", 1.0)
        threshold = _threshold_for(field)
        if value is not None and isinstance(confidence, (int, float)) and confidence < threshold:
            flagged.append({
                "field": field,
                "value": value,
                "confidence": confidence,
                "source": obj.get("source"),
                "threshold": threshold,
                "is_critical": field in CRITICAL_FIELDS,
            })
    return flagged


def check_consistency(fields: dict[str, Any]) -> list[str]:
    issues = []

    incident_date = fields.get("incidentDate", {}).get("value")
    policy_dates = fields.get("policyEffectiveDates", {}).get("value")
    estimated_damage = fields.get("estimatedDamage", {}).get("value")
    initial_estimate = fields.get("initialEstimate", {}).get("value")

    if incident_date and policy_dates:
        try:
            if not _date_within_policy_range(incident_date, policy_dates):
                issues.append(
                    f"Incident date '{incident_date}' appears outside policy period '{policy_dates}'."
                )
        except ValueError:
            pass

    if estimated_damage is not None and initial_estimate is not None:
        try:
            est, init = float(estimated_damage), float(initial_estimate)
            if init > 0 and abs(est - init) / init > 0.50:
                issues.append(
                    f"Estimated damage (₹{est:,.0f}) and initial estimate (₹{init:,.0f}) "
                    f"diverge by {abs(est-init)/init:.0%} — exceeds 50% threshold."
                )
        except (TypeError, ValueError):
            pass

    if issues:
        logger.info("Consistency issues: %s", issues)
    return issues


def _parse_date(date_str: str):
    try:
        return dateutil_parser.parse(date_str, dayfirst=False).date()
    except Exception:
        pass
    import datetime
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%B %d, %Y", "%d %B %Y"):
        try:
            return datetime.datetime.strptime(date_str.strip(), fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Cannot parse date: {date_str!r}")


def _date_within_policy_range(incident_date_str: str, policy_dates_str: str) -> bool:
    try:
        incident = _parse_date(incident_date_str)
    except ValueError:
        return True

    for sep in (" - ", " to ", " through ", "–", "—"):
        if sep in policy_dates_str:
            parts = policy_dates_str.split(sep, 1)
            if len(parts) == 2:
                try:
                    return _parse_date(parts[0].strip()) <= incident <= _parse_date(parts[1].strip())
                except ValueError:
                    return True

    return True
