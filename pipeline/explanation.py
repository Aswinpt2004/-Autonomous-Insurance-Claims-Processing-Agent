import logging
from typing import Any

logger = logging.getLogger(__name__)

_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}


def build_reasoning(
    route: str,
    missing_fields: list[str],
    low_confidence_fields: list[dict[str, Any]],
    risk_signals: list[dict[str, Any]],
    consistency_issues: list[str],
    fields: dict[str, Any],
    escalation_score: int,
) -> str:
    parts: list[str] = []

    if missing_fields:
        parts.append(f"Missing mandatory field(s): {', '.join(repr(f) for f in missing_fields)}.")

    for lc in low_confidence_fields:
        pct = round(lc["confidence"] * 100)
        source = f" ({lc['source']})" if lc.get("source") else ""
        tier = "critical" if lc.get("is_critical") else "standard"
        parts.append(
            f"Field '{lc['field']}' extracted as '{lc['value']}' with {pct}% confidence"
            f"{source} — below {round(lc['threshold']*100)}% {tier}-field threshold."
        )

    for issue in consistency_issues:
        parts.append(f"Consistency: {issue}")

    if risk_signals:
        sorted_signals = sorted(risk_signals, key=lambda s: _SEVERITY_RANK.get(s.get("severity", "low"), 0), reverse=True)
        top = sorted_signals[0]
        source = f" ({top['source']})" if top.get("source") else ""
        parts.append(f"Risk [{top['severity'].upper()}]{source}: {top['signal']} — {top['evidence']}")
        if len(sorted_signals) > 1:
            parts.append(f"Plus {len(sorted_signals)-1} additional risk signal(s).")

    claim_type = (fields.get("claimType", {}).get("value") or "").strip()
    if claim_type.lower() == "injury":
        parts.append("Claim type 'Injury' — routed to Specialist Queue per regulatory requirements.")

    damage = fields.get("estimatedDamage", {}).get("value")
    if damage is not None:
        try:
            parts.append(f"Estimated damage: ₹{float(damage):,.0f}.")
        except (TypeError, ValueError):
            parts.append(f"Estimated damage: {damage}.")

    parts.append(f"Escalation score: {escalation_score}. Final route: {route}.")

    return " ".join(parts)
